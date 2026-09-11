import { describe, expect, it } from 'vitest';
import { fingerprintsEqual } from '../../src/sync/manifest-fingerprint';

describe('fingerprintsEqual (D1)', () => {
  it('both etags present and equal → true', () => {
    expect(fingerprintsEqual({ etag: 'abc' }, { etag: 'abc' })).toBe(true);
  });

  it('both etags present and different → false', () => {
    expect(fingerprintsEqual({ etag: 'abc' }, { etag: 'def' })).toBe(false);
  });

  it('etag absent on one side, lastModified present and equal → true', () => {
    expect(
      fingerprintsEqual(
        { lastModified: '2026-01-01T00:00:00Z' },
        { etag: undefined, lastModified: '2026-01-01T00:00:00Z' },
      ),
    ).toBe(true);
  });

  it('etag absent on both sides, lastModified present and equal → true', () => {
    expect(
      fingerprintsEqual(
        { lastModified: '2026-01-01T00:00:00Z' },
        { lastModified: '2026-01-01T00:00:00Z' },
      ),
    ).toBe(true);
  });

  it('etag absent on both sides, lastModified present and different → false', () => {
    expect(
      fingerprintsEqual(
        { lastModified: '2026-01-01T00:00:00Z' },
        { lastModified: '2026-01-02T00:00:00Z' },
      ),
    ).toBe(false);
  });

  it('both etag and lastModified absent on one side → false', () => {
    expect(fingerprintsEqual({}, { etag: 'abc' })).toBe(false);
  });

  it('both etag and lastModified absent on both sides → false', () => {
    expect(fingerprintsEqual({}, {})).toBe(false);
  });

  it('a fingerprint is undefined → false', () => {
    expect(fingerprintsEqual(undefined, { etag: 'abc' })).toBe(false);
  });

  it('both fingerprints undefined → false', () => {
    expect(fingerprintsEqual(undefined, undefined)).toBe(false);
  });

  it('etag present on one side only (other absent) → falls through to lastModified, both absent → false', () => {
    expect(fingerprintsEqual({ etag: 'abc' }, { lastModified: '2026-01-01T00:00:00Z' })).toBe(
      false,
    );
  });
});
