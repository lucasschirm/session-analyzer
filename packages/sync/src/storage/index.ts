/**
 * storage/ module barrel.
 *
 * Exports the S3StorageAdapter implementation and retry policy.
 *
 * The storage contract and deterministic object key builder are re-exported by
 * the package index from `@lucasschirm/sal-sync-core`.
 */

export * from './retry.js';
export * from './s3-adapter.js';
