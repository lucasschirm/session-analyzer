import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbClient } from '../../src/db/db-client';
import {
  createPasskey,
  decryptField,
  encryptField,
  forgetPasskey,
  isUnlocked,
  lock,
  unlock,
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

beforeEach(() => {
  lock();
  mockDb.state = null;
  vi.mocked(dbClient.getPasskeyState).mockClear();
  vi.mocked(dbClient.savePasskeyState).mockClear();
  vi.mocked(dbClient.deleteAllCredentials).mockClear();
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
});
