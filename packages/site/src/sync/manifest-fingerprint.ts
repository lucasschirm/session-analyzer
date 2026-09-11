/**
 * D1 manifest fingerprint equality (single owner — see
 * `.agents/rules/workspace-rules.md` no-duplicate-logic and issue #407's
 * "Artifact ownership" section). No other file in `packages/site/src` may
 * re-implement this comparison.
 */

import type { ManifestFingerprint } from '../types';

/**
 * Compares two D1 manifest fingerprints for equality.
 *
 * Two fingerprints are equal iff both have an `etag` and the strings are
 * identical (raw-text comparison, no unescaping/normalisation); when either
 * `etag` is absent, they are equal iff both have a `lastModified` and the
 * strings are identical; otherwise they are not equal. An absent field is
 * never treated as equal to an empty string or to a present value
 * (missing-is-never-zero).
 */
export function fingerprintsEqual(
  a: ManifestFingerprint | undefined,
  b: ManifestFingerprint | undefined,
): boolean {
  if (a?.etag !== undefined && b?.etag !== undefined) {
    return a.etag === b.etag;
  }
  if (a?.lastModified !== undefined && b?.lastModified !== undefined) {
    return a.lastModified === b.lastModified;
  }
  return false;
}
