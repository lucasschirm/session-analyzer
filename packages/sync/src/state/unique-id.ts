/**
 * Process-unique, collision-resistant suffix for temp/claim file names.
 *
 * Shared by `state.ts`'s `writeFileAtomic` (temp-file-then-rename writes) and
 * `lock.ts`'s stale-lock takeover (rename-aside-then-verify reclaim) — both
 * need a name no other concurrent caller, in this process or another, will
 * independently produce, so a single implementation is the only correct way
 * to keep those two identical requirements from drifting apart.
 */
export function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
