/**
 * Passkey-backed credential vault.
 *
 * A global passkey derives an AES-GCM-256 key via PBKDF2 (SHA-256, 310k
 * iterations). The key lives only in a module-level variable and is never
 * persisted. Verification is done by decrypting a stored verifier; wrong
 * passkeys are reported as a boolean failure rather than throwing raw crypto
 * errors. No passkey, derived key, or decrypted secret is ever logged or
 * included in thrown error messages.
 */

import { dbClient } from '../db/db-client';
import type { PasskeyState } from '../types';

const VERIFIER = 'session-analyzer-vault-v1';
const KDF_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

let vaultKey: CryptoKey | null = null;

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

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto is not available');
  }
  return globalThis.crypto;
}

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  return getCrypto().getRandomValues(new Uint8Array(size));
}

async function deriveKey(passkey: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const crypto = getCrypto();
  const material = await crypto.subtle.importKey('raw', encodeText(passkey), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptWithKey(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  plaintext: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const crypto = getCrypto();
  const buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encodeText(plaintext));
  return new Uint8Array(buffer);
}

async function decryptWithKey(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const crypto = getCrypto();
  const buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(buffer);
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

globalThis.addEventListener('beforeunload', () => {
  lock();
});
