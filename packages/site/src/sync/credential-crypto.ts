/**
 * Passkey-backed credential vault.
 *
 * A global passkey derives an AES-GCM-256 key via PBKDF2 (SHA-256, 310k
 * iterations). The key lives only in a module-level variable and is never
 * persisted. Verification is done by decrypting a stored verifier; wrong
 * passkeys are reported as a boolean failure rather than throwing raw crypto
 * errors. No passkey, derived key, or decrypted secret is ever logged or
 * included in thrown error messages.
 *
 * Optional WebAuthn PRF "keep unlocked" flow:
 * After a successful passkey unlock, the user may register a WebAuthn
 * credential with the `prf` extension. The PRF output wraps the vault key
 * with AES-GCM and is stored in passkey_state along with a 30-day expiry.
 * On a later page load, `navigator.credentials.get()` re-derives the same
 * PRF output and unwraps the vault key without typing the passkey. Feature
 * detection is conservative: `PublicKeyCredential.getClientCapabilities()`
 * is queried when available; otherwise the opt-in is not offered, avoiding
 * a real WebAuthn ceremony on unsupported clients. This code has not been
 * verified against a live authenticator; the PRF API surface is based on the
 * WebAuthn spec, WPT, and Yubico documentation.
 */

import { dbClient } from '../db/db-client';
import type { PasskeyState } from '../types';

const VERIFIER = 'session-analyzer-vault-v1';
const KDF_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const WEBAUTHN_CHALLENGE_BYTES = 32;
const WEBAUTHN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const WEBAUTHN_RP_NAME = 'Session Analyzer';
const AES_KEY_BITS = 256;

let vaultKey: CryptoKey | null = null;

interface PrfExtensionOutput {
  prf?: {
    enabled?: boolean;
    results?: {
      first?: ArrayBuffer;
      second?: ArrayBuffer;
    };
  };
}

interface WebAuthnWrappedKey {
  iv: string;
  ct: string;
  salt: string;
}

interface PublicKeyCredentialConstructor {
  getClientCapabilities?(): Promise<Record<string, boolean | undefined>>;
  new (...args: unknown[]): PublicKeyCredential;
}

function encodeText(input: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(input);
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary);
}

function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(pad);
  return base64ToBytes(base64);
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto is not available');
  }
  return globalThis.crypto;
}

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  return getCrypto().getRandomValues(new Uint8Array(size));
}

function getCredentialsContainer(): CredentialsContainer | undefined {
  const nav = globalThis.navigator as Navigator | undefined;
  return nav?.credentials;
}

function getPublicKeyCredentialConstructor(): PublicKeyCredentialConstructor | undefined {
  if (typeof globalThis.PublicKeyCredential === 'undefined') return undefined;
  return globalThis.PublicKeyCredential as unknown as PublicKeyCredentialConstructor;
}

function getRpId(): string | undefined {
  if (
    typeof globalThis.location !== 'undefined' &&
    typeof globalThis.location.hostname === 'string' &&
    globalThis.location.hostname
  ) {
    return globalThis.location.hostname;
  }
  return undefined;
}

function asArrayBuffer(value: unknown): ArrayBuffer | undefined {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  return undefined;
}

function getPrfOutput(credential: PublicKeyCredential): ArrayBuffer | undefined {
  const results = credential.getClientExtensionResults() as unknown as PrfExtensionOutput;
  return asArrayBuffer(results?.prf?.results?.first);
}

function credentialIdToBytes(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> {
  if (credential.rawId && credential.rawId.byteLength > 0) {
    return new Uint8Array(credential.rawId);
  }
  return base64urlToBytes(credential.id);
}

async function deriveKeyMaterial(
  passkey: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const crypto = getCrypto();
  const material = await crypto.subtle.importKey('raw', encodeText(passkey), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const buffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    AES_KEY_BITS,
  );
  return new Uint8Array(buffer);
}

async function importAesKey(material: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const crypto = getCrypto();
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function deriveKey(passkey: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await deriveKeyMaterial(passkey, salt);
  try {
    return await importAesKey(material);
  } finally {
    material.fill(0);
  }
}

async function encryptWithKey(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  plaintext: string | Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const data = typeof plaintext === 'string' ? encodeText(plaintext) : plaintext;
  const crypto = getCrypto();
  const buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return new Uint8Array(buffer);
}

async function decryptBytes(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const crypto = getCrypto();
  const buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(buffer);
}

async function decryptWithKey(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const bytes = await decryptBytes(key, iv, ciphertext);
  return new TextDecoder().decode(bytes);
}

function buildWebAuthnCreateOptions(salt: Uint8Array<ArrayBuffer>): CredentialCreationOptions {
  const publicKey = {
    rp: { name: WEBAUTHN_RP_NAME, id: getRpId() },
    user: {
      id: randomBytes(16),
      name: 'vault-user',
      displayName: 'Vault Unlock',
    },
    challenge: randomBytes(WEBAUTHN_CHALLENGE_BYTES),
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      userVerification: 'required',
    },
    attestation: 'none',
    extensions: { prf: { eval: { first: salt } } },
  } as unknown as PublicKeyCredentialCreationOptions;
  return { publicKey } as CredentialCreationOptions;
}

function buildWebAuthnGetOptions(
  credentialId: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
): CredentialRequestOptions {
  const publicKey = {
    challenge: randomBytes(WEBAUTHN_CHALLENGE_BYTES),
    rpId: getRpId(),
    allowCredentials: [{ id: credentialId, type: 'public-key' }],
    userVerification: 'required',
    extensions: { prf: { eval: { first: salt } } },
  } as unknown as PublicKeyCredentialRequestOptions;
  return { publicKey } as CredentialRequestOptions;
}

async function importPrfKey(output: ArrayBuffer): Promise<CryptoKey | null> {
  if (output.byteLength !== 32) return null;
  const crypto = getCrypto();
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(output),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function wrapKeyWithPrf(
  prfKey: CryptoKey,
  material: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
): Promise<WebAuthnWrappedKey> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await encryptWithKey(prfKey, iv, material);
  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ciphertext),
    salt: bytesToBase64(salt),
  };
}

async function unwrapKeyWithPrf(
  prfKey: CryptoKey,
  wrapped: WebAuthnWrappedKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = base64ToBytes(wrapped.iv);
  const ct = base64ToBytes(wrapped.ct);
  return decryptBytes(prfKey, iv, ct);
}

function serializeWrappedKey(wrapped: WebAuthnWrappedKey): string {
  return bytesToBase64(encodeText(JSON.stringify(wrapped)));
}

function parseWrappedKey(input: string): WebAuthnWrappedKey | null {
  try {
    const decoded = new TextDecoder().decode(base64ToBytes(input));
    const parsed: unknown = JSON.parse(decoded);
    const record =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    if (
      record &&
      typeof record.iv === 'string' &&
      typeof record.ct === 'string' &&
      typeof record.salt === 'string'
    ) {
      return parsed as WebAuthnWrappedKey;
    }
  } catch {
    // malformed wrapped key
  }
  return null;
}

async function createPrfCredential(
  credentials: CredentialsContainer,
  salt: Uint8Array<ArrayBuffer>,
): Promise<PublicKeyCredential | null> {
  const credential = await credentials.create(buildWebAuthnCreateOptions(salt));
  if (!credential) return null;
  const publicKeyCredential = credential as PublicKeyCredential;
  if (getPrfOutput(publicKeyCredential)) return publicKeyCredential;
  const getOptions = buildWebAuthnGetOptions(credentialIdToBytes(publicKeyCredential), salt);
  const assertion = await credentials.get(getOptions);
  if (!assertion) return null;
  const publicKeyAssertion = assertion as PublicKeyCredential;
  return getPrfOutput(publicKeyAssertion) ? publicKeyAssertion : null;
}

async function wrapAndStoreVaultKey(
  state: PasskeyState,
  passkey: string,
  prfCredential: PublicKeyCredential,
  salt: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const prfOutput = getPrfOutput(prfCredential);
  if (!prfOutput) return false;
  const prfKey = await importPrfKey(prfOutput);
  if (!prfKey) return false;
  const material = await deriveKeyMaterial(passkey, base64ToBytes(state.kdf_salt));
  try {
    const wrapped = await wrapKeyWithPrf(prfKey, material, salt);
    const updated: PasskeyState = {
      ...state,
      webauthn_credential_id: prfCredential.id,
      webauthn_wrapped_key: serializeWrappedKey(wrapped),
      webauthn_expires_at: Date.now() + WEBAUTHN_EXPIRY_MS,
    };
    await dbClient.savePasskeyState(updated);
    return true;
  } finally {
    material.fill(0);
  }
}

async function getWebAuthnCredentialIdAndWrappedKey(): Promise<{
  credentialId: Uint8Array<ArrayBuffer>;
  wrapped: WebAuthnWrappedKey;
  salt: Uint8Array<ArrayBuffer>;
} | null> {
  const state = await dbClient.getPasskeyState();
  if (!state || !(await isWebAuthnDeviceUnlockActive(state))) return null;
  const credentialId = base64urlToBytes(state.webauthn_credential_id ?? '');
  if (credentialId.length === 0) return null;
  const wrapped = parseWrappedKey(state.webauthn_wrapped_key ?? '');
  if (!wrapped) return null;
  return { credentialId, wrapped, salt: base64ToBytes(wrapped.salt) };
}

/**
 * Creates a new global passkey: generates salt, derives key, encrypts the
 * verifier, and stores the resulting state. Throws if a passkey already
 * exists. Unlocks the vault on success.
 */
export async function createPasskey(passkey: string): Promise<void> {
  const existing = await dbClient.getPasskeyState();
  if (existing) {
    throw new Error('A passkey is already configured.');
  }

  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(passkey, salt);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await encryptWithKey(key, iv, VERIFIER);

  const state: PasskeyState = {
    id: 1,
    kdf_salt: bytesToBase64(salt),
    verifier_iv: bytesToBase64(iv),
    verifier_ct: bytesToBase64(ciphertext),
    created_at: Date.now(),
  };

  await dbClient.savePasskeyState(state);
  vaultKey = key;
}

/**
 * Attempts to unlock the vault with the given passkey. Returns `true` on
 * success, `false` on a wrong passkey or missing state. All crypto failures
 * are captured and reported as `false` without leaking details.
 */
export async function unlock(passkey: string): Promise<boolean> {
  const state = await dbClient.getPasskeyState();
  if (!state) {
    return false;
  }

  try {
    const salt = base64ToBytes(state.kdf_salt);
    const key = await deriveKey(passkey, salt);
    const iv = base64ToBytes(state.verifier_iv);
    const ciphertext = base64ToBytes(state.verifier_ct);
    const plaintext = await decryptWithKey(key, iv, ciphertext);

    if (plaintext !== VERIFIER) {
      vaultKey = null;
      return false;
    }

    vaultKey = key;
    return true;
  } catch {
    vaultKey = null;
    return false;
  }
}

/** Returns whether the vault is currently unlocked. */
export function isUnlocked(): boolean {
  return vaultKey !== null;
}

/** Clears the derived key from memory. */
export function lock(): void {
  vaultKey = null;
}

/**
 * Forgets the passkey: wipes all saved S3 credentials and the passkey state.
 * Connection records themselves are preserved. Locks the vault.
 */
export async function forgetPasskey(): Promise<void> {
  await dbClient.deleteAllCredentials();
  vaultKey = null;
}

/**
 * Encrypts a single secret field using a random 12-byte IV. Requires the
 * vault to be unlocked. Returns the IV and ciphertext as base64.
 */
export async function encryptField(plaintext: string): Promise<{ iv: string; ct: string }> {
  if (!vaultKey) {
    throw new Error('Vault is locked.');
  }

  const iv = randomBytes(IV_BYTES);
  const ciphertext = await encryptWithKey(vaultKey, iv, plaintext);
  return { iv: bytesToBase64(iv), ct: bytesToBase64(ciphertext) };
}

/**
 * Decrypts a single secret field. Requires the vault to be unlocked.
 */
export async function decryptField(iv: string, ct: string): Promise<string> {
  if (!vaultKey) {
    throw new Error('Vault is locked.');
  }

  try {
    return await decryptWithKey(vaultKey, base64ToBytes(iv), base64ToBytes(ct));
  } catch {
    throw new Error('Could not decrypt field.');
  }
}

/**
 * Returns whether the client advertises support for the WebAuthn `prf`
 * extension. `PublicKeyCredential.getClientCapabilities()` is the standard
 * pre-flight check (reports `extension:prf`). Clients without it are treated
 * as unsupported so the UI does not offer the opt-in.
 */
export async function isWebAuthnPrfSupported(): Promise<boolean> {
  const pkc = getPublicKeyCredentialConstructor();
  if (!pkc || typeof pkc.getClientCapabilities !== 'function') return false;
  const credentials = getCredentialsContainer();
  if (!credentials?.create) return false;

  try {
    const capabilities = await pkc.getClientCapabilities();
    return capabilities?.['extension:prf'] === true;
  } catch {
    return false;
  }
}

/** Returns whether the stored WebAuthn device-unlock credential is active. */
export function hasWebAuthnDeviceUnlock(state: PasskeyState): boolean {
  if (!state.webauthn_credential_id || !state.webauthn_wrapped_key || !state.webauthn_expires_at) {
    return false;
  }
  return state.webauthn_expires_at > Date.now();
}

/**
 * Clears the WebAuthn device-unlock fields from a passkey state row when the
 * credential is no longer usable. This prevents stale or expired data from
 * accumulating indefinitely.
 */
async function clearInactiveWebAuthnCredential(state: PasskeyState): Promise<void> {
  if (!state.webauthn_credential_id && !state.webauthn_wrapped_key && !state.webauthn_expires_at) {
    return;
  }
  const cleared: PasskeyState = {
    ...state,
    webauthn_credential_id: undefined,
    webauthn_wrapped_key: undefined,
    webauthn_expires_at: undefined,
  };
  await dbClient.savePasskeyState(cleared);
}

/**
 * Returns `true` if the state holds an active, non-expired WebAuthn device
 * credential. Otherwise clears any stale WebAuthn fields as a side effect and
 * returns `false`.
 */
async function isWebAuthnDeviceUnlockActive(state: PasskeyState): Promise<boolean> {
  if (hasWebAuthnDeviceUnlock(state)) return true;
  await clearInactiveWebAuthnCredential(state);
  return false;
}

/**
 * Returns whether a non-expired WebAuthn device-unlock credential is stored.
 * Expired or incomplete credentials are cleared through `savePasskeyState` as
 * a side effect of the check.
 */
export async function hasDeviceUnlockCredential(): Promise<boolean> {
  const state = await dbClient.getPasskeyState();
  if (!state) return false;
  return isWebAuthnDeviceUnlockActive(state);
}

/**
 * Creates a WebAuthn PRF credential and wraps the vault key with the PRF
 * output. Stores the wrapped blob, credential id and a 30-day expiry in
 * passkey_state. Returns `true` if the credential was created and the key
 * was wrapped; `false` otherwise.
 */
export async function createWebAuthnCredentialAndWrapKey(passkey: string): Promise<boolean> {
  const state = await dbClient.getPasskeyState();
  if (!state || !isUnlocked()) return false;
  const credentials = getCredentialsContainer();
  if (!credentials?.create) return false;

  try {
    const salt = randomBytes(32);
    const prfCredential = await createPrfCredential(credentials, salt);
    if (!prfCredential) return false;
    return await wrapAndStoreVaultKey(state, passkey, prfCredential, salt);
  } catch {
    return false;
  }
}

/**
 * Unwraps the vault key using a stored WebAuthn PRF credential. Returns
 * `true` on success, `false` on expiry, missing state, or any WebAuthn
 * failure.
 */
export async function unlockWithWebAuthnDevice(): Promise<boolean> {
  const bundle = await getWebAuthnCredentialIdAndWrappedKey();
  if (!bundle) return false;
  const credentials = getCredentialsContainer();
  if (!credentials?.get) return false;

  try {
    const assertion = await credentials.get(
      buildWebAuthnGetOptions(bundle.credentialId, bundle.salt),
    );
    if (!assertion) return false;
    const publicKeyAssertion = assertion as PublicKeyCredential;
    const prfOutput = getPrfOutput(publicKeyAssertion);
    if (!prfOutput) return false;
    const prfKey = await importPrfKey(prfOutput);
    if (!prfKey) return false;
    const material = await unwrapKeyWithPrf(prfKey, bundle.wrapped);
    try {
      vaultKey = await importAesKey(material);
      return true;
    } finally {
      material.fill(0);
    }
  } catch {
    vaultKey = null;
    return false;
  }
}

globalThis.addEventListener('beforeunload', () => {
  lock();
});
