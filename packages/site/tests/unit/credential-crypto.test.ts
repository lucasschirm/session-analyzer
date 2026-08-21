import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbClient } from '../../src/db/db-client';
import {
  createPasskey,
  createWebAuthnCredentialAndWrapKey,
  decryptField,
  encryptField,
  forgetPasskey,
  hasDeviceUnlockCredential,
  isUnlocked,
  isWebAuthnPrfSupported,
  lock,
  unlock,
  unlockWithWebAuthnDevice,
} from '../../src/sync/credential-crypto';
import type { PasskeyState } from '../../src/types';

const mockDb = vi.hoisted(() => ({ state: null as PasskeyState | null }));

vi.mock('../../src/db/db-client', () => ({
  dbClient: {
    getPasskeyState: vi.fn(() => Promise.resolve(mockDb.state)),
    savePasskeyState: vi.fn((newState: PasskeyState) => {
      mockDb.state = newState;
      return Promise.resolve(undefined);
    }),
    deleteAllCredentials: vi.fn(() => {
      mockDb.state = null;
      return Promise.resolve(undefined);
    }),
  },
}));

function bytesToBase64url(bytes: Uint8Array<ArrayBuffer>): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makePrfOutput(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

function makeCredential(
  prfOutput: Uint8Array<ArrayBuffer>,
  id: string,
  withCreateResult = true,
): PublicKeyCredential {
  return {
    id,
    rawId: new ArrayBuffer(0),
    getClientExtensionResults: () => ({
      prf: withCreateResult ? { enabled: true, results: { first: prfOutput } } : { enabled: true },
    }),
  } as unknown as PublicKeyCredential;
}

beforeEach(() => {
  lock();
  mockDb.state = null;
  vi.mocked(dbClient.getPasskeyState).mockClear();
  vi.mocked(dbClient.savePasskeyState).mockClear();
  vi.mocked(dbClient.deleteAllCredentials).mockClear();

  const create = vi.fn();
  const get = vi.fn();
  Object.defineProperty(globalThis, 'navigator', {
    value: { credentials: { create, get } },
    configurable: true,
    writable: true,
  });
  function PublicKeyCredentialStub() {
    // stub constructor for tests
  }
  Object.assign(PublicKeyCredentialStub, { getClientCapabilities: vi.fn() });
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: PublicKeyCredentialStub,
    configurable: true,
    writable: true,
  });
});

describe('credential-crypto', () => {
  it('round-trips encrypt and decrypt after creating a passkey', async () => {
    await createPasskey('correcthorsebatterystaple');

    const { iv, ct } = await encryptField('aws-secret-access-key');
    const decrypted = await decryptField(iv, ct);

    expect(decrypted).toBe('aws-secret-access-key');
  });

  it('detects a wrong passkey without throwing raw crypto errors', async () => {
    await createPasskey('correcthorsebatterystaple');
    lock();

    const ok = await unlock('wrong-passkey-attempt');

    expect(ok).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it('verifies and unlocks with the correct passkey', async () => {
    await createPasskey('correcthorsebatterystaple');
    expect(isUnlocked()).toBe(true);

    lock();
    expect(isUnlocked()).toBe(false);

    const ok = await unlock('correcthorsebatterystaple');
    expect(ok).toBe(true);
    expect(isUnlocked()).toBe(true);
  });

  it('wipes state and locks the vault on forgetPasskey', async () => {
    await createPasskey('correcthorsebatterystaple');
    await encryptField('session-token');

    await forgetPasskey();

    expect(isUnlocked()).toBe(false);
    expect(await unlock('correcthorsebatterystaple')).toBe(false);
    await expect(encryptField('x')).rejects.toThrow('Vault is locked.');
    expect(dbClient.deleteAllCredentials).toHaveBeenCalled();
  });

  it('refuses to overwrite an existing passkey', async () => {
    await createPasskey('first-passkey');

    await expect(createPasskey('second-passkey')).rejects.toThrow(
      'A passkey is already configured.',
    );
  });

  it('does not include secret material in thrown error messages', async () => {
    const secretPasskey = 'my-super-secret-passkey-value';
    const secretValue = 'confidential-secret-value';

    await createPasskey(secretPasskey);
    const { iv, ct } = await encryptField(secretValue);

    try {
      await createPasskey('another-secret-passkey');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(secretPasskey);
      expect((err as Error).message).not.toContain('another-secret-passkey');
    }

    lock();
    try {
      await decryptField(iv, ct);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(secretValue);
      expect((err as Error).message).not.toContain(secretPasskey);
    }
  });

  describe('WebAuthn PRF device unlock', () => {
    it('detects PRF support when getClientCapabilities reports extension:prf', async () => {
      const pkc = globalThis.PublicKeyCredential as typeof PublicKeyCredential & {
        getClientCapabilities: ReturnType<typeof vi.fn>;
      };
      pkc.getClientCapabilities.mockResolvedValue({ 'extension:prf': true });

      expect(await isWebAuthnPrfSupported()).toBe(true);
    });

    it('reports unsupported when getClientCapabilities is absent', async () => {
      Object.assign(globalThis, { PublicKeyCredential: undefined });

      expect(await isWebAuthnPrfSupported()).toBe(false);
    });

    it('reports unsupported when extension:prf is false or missing', async () => {
      const pkc = globalThis.PublicKeyCredential as typeof PublicKeyCredential & {
        getClientCapabilities: ReturnType<typeof vi.fn>;
      };
      pkc.getClientCapabilities.mockResolvedValue({ 'extension:appid': true });

      expect(await isWebAuthnPrfSupported()).toBe(false);
    });

    it('wraps and unwraps the vault key via a mocked PRF output', async () => {
      const passkey = 'correcthorsebatterystaple';
      await createPasskey(passkey);
      const { iv, ct } = await encryptField('aws-secret-access-key');

      const prfOutput = makePrfOutput();
      const credentialId = bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
      const credential = makeCredential(prfOutput, credentialId);

      const create = globalThis.navigator.credentials.create as ReturnType<typeof vi.fn>;
      create.mockResolvedValue(credential);

      const wrapped = await createWebAuthnCredentialAndWrapKey(passkey);
      expect(wrapped).toBe(true);
      expect(mockDb.state).not.toBeNull();
      expect(mockDb.state?.webauthn_credential_id).toBe(credentialId);
      expect(mockDb.state?.webauthn_wrapped_key).toBeTruthy();
      expect(mockDb.state?.webauthn_expires_at).toBeGreaterThan(Date.now());

      lock();
      expect(isUnlocked()).toBe(false);

      const get = globalThis.navigator.credentials.get as ReturnType<typeof vi.fn>;
      get.mockResolvedValue({
        id: credentialId,
        getClientExtensionResults: () => ({ prf: { results: { first: prfOutput } } }),
      } as unknown as PublicKeyCredential);

      const ok = await unlockWithWebAuthnDevice();
      expect(ok).toBe(true);
      expect(isUnlocked()).toBe(true);

      const decrypted = await decryptField(iv, ct);
      expect(decrypted).toBe('aws-secret-access-key');
    });

    it('falls back from a create that only enables PRF to a get that provides the output', async () => {
      const passkey = 'correcthorsebatterystaple';
      await createPasskey(passkey);

      const prfOutput = makePrfOutput();
      const credentialId = bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
      const createCredential = makeCredential(prfOutput, credentialId, false);
      const getCredential = {
        id: credentialId,
        getClientExtensionResults: () => ({ prf: { results: { first: prfOutput } } }),
      } as unknown as PublicKeyCredential;

      const create = globalThis.navigator.credentials.create as ReturnType<typeof vi.fn>;
      const get = globalThis.navigator.credentials.get as ReturnType<typeof vi.fn>;
      create.mockResolvedValue(createCredential);
      get.mockResolvedValue(getCredential);

      expect(await createWebAuthnCredentialAndWrapKey(passkey)).toBe(true);
    });

    it('returns false and does not throw when navigator.credentials is missing', async () => {
      const passkey = 'correcthorsebatterystaple';
      await createPasskey(passkey);
      Object.assign(globalThis.navigator, { credentials: undefined });

      await expect(createWebAuthnCredentialAndWrapKey(passkey)).resolves.toBe(false);
    });

    it('returns false when the user cancels the WebAuthn creation', async () => {
      const passkey = 'correcthorsebatterystaple';
      await createPasskey(passkey);
      const create = globalThis.navigator.credentials.create as ReturnType<typeof vi.fn>;
      create.mockResolvedValue(null);

      expect(await createWebAuthnCredentialAndWrapKey(passkey)).toBe(false);
    });

    it('falls back gracefully when the wrapped key blob is malformed', async () => {
      const passkey = 'correcthorsebatterystaple';
      await createPasskey(passkey);
      const prfOutput = makePrfOutput();
      const credentialId = bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
      const credential = makeCredential(prfOutput, credentialId);

      const create = globalThis.navigator.credentials.create as ReturnType<typeof vi.fn>;
      create.mockResolvedValue(credential);

      await createWebAuthnCredentialAndWrapKey(passkey);
      expect(mockDb.state?.webauthn_wrapped_key).toBeTruthy();

      if (mockDb.state) {
        mockDb.state.webauthn_wrapped_key = 'not-valid-base64!!!';
      }

      const get = globalThis.navigator.credentials.get as ReturnType<typeof vi.fn>;
      get.mockResolvedValue({
        id: credentialId,
        getClientExtensionResults: () => ({ prf: { results: { first: prfOutput } } }),
      } as unknown as PublicKeyCredential);

      lock();
      expect(await unlockWithWebAuthnDevice()).toBe(false);
      expect(isUnlocked()).toBe(false);
    });

    it('rejects a PRF output that is not 32 bytes', async () => {
      const passkey = 'correcthorsebatterystaple';
      await createPasskey(passkey);
      const prfOutput = makePrfOutput();
      const credentialId = bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
      const credential = makeCredential(prfOutput, credentialId);

      const create = globalThis.navigator.credentials.create as ReturnType<typeof vi.fn>;
      create.mockResolvedValue(credential);

      await createWebAuthnCredentialAndWrapKey(passkey);

      const shortPrfOutput = crypto.getRandomValues(new Uint8Array(16));
      const get = globalThis.navigator.credentials.get as ReturnType<typeof vi.fn>;
      get.mockResolvedValue({
        id: credentialId,
        getClientExtensionResults: () => ({ prf: { results: { first: shortPrfOutput } } }),
      } as unknown as PublicKeyCredential);

      lock();
      expect(await unlockWithWebAuthnDevice()).toBe(false);
      expect(isUnlocked()).toBe(false);
    });

    it('falls back gracefully when the assertion has no PRF extension result', async () => {
      const passkey = 'correcthorsebatterystaple';
      await createPasskey(passkey);
      const prfOutput = makePrfOutput();
      const credentialId = bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
      const credential = makeCredential(prfOutput, credentialId);

      const create = globalThis.navigator.credentials.create as ReturnType<typeof vi.fn>;
      create.mockResolvedValue(credential);

      await createWebAuthnCredentialAndWrapKey(passkey);

      const get = globalThis.navigator.credentials.get as ReturnType<typeof vi.fn>;
      get.mockResolvedValue({
        id: credentialId,
        getClientExtensionResults: () => ({}),
      } as unknown as PublicKeyCredential);

      lock();
      expect(await unlockWithWebAuthnDevice()).toBe(false);
      expect(isUnlocked()).toBe(false);
    });

    it('silently falls back to the passkey flow and clears expired WebAuthn fields', async () => {
      const passkey = 'correcthorsebatterystaple';
      await createPasskey(passkey);
      const prfOutput = makePrfOutput();
      const credentialId = bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
      const createCredential = makeCredential(prfOutput, credentialId);

      const create = globalThis.navigator.credentials.create as ReturnType<typeof vi.fn>;
      create.mockResolvedValue(createCredential);

      await createWebAuthnCredentialAndWrapKey(passkey);
      expect(mockDb.state?.webauthn_expires_at).toBeGreaterThan(Date.now());

      if (mockDb.state) {
        mockDb.state.webauthn_expires_at = Date.now() - 1;
      }

      expect(await hasDeviceUnlockCredential()).toBe(false);
      expect(mockDb.state?.webauthn_credential_id).toBeUndefined();
      expect(mockDb.state?.webauthn_wrapped_key).toBeUndefined();
      expect(mockDb.state?.webauthn_expires_at).toBeUndefined();
      expect(dbClient.savePasskeyState).toHaveBeenCalled();

      expect(await unlockWithWebAuthnDevice()).toBe(false);
    });

    it('silently falls back to the passkey flow when no device credential is stored', async () => {
      expect(await hasDeviceUnlockCredential()).toBe(false);
      expect(await unlockWithWebAuthnDevice()).toBe(false);
    });
  });
});
