/**
 * Shared OPFS file I/O used by the SQLite executor adapters to read back a
 * `VACUUM INTO` temp file directly, instead of `sqlite3_js_db_export`'s
 * whole-database contiguous-allocation serialize (see database.ts /
 * wasm-sqlite-executor.ts `exportOptimized`). All paths here are
 * root-relative OPFS filenames (e.g. '/sal-analytics.sqlite3.vacuum-tmp') —
 * these two helpers only ever operate on files living directly under the
 * OPFS root, and are not suitable for a nested directory as-is.
 *
 * As of the OPFS-backed `ArtifactBlobStore` (`opfs-artifact-blob-store.ts`),
 * this app *does* nest files in an OPFS subdirectory (`/artifact-blobs/`).
 * That store owns its own directory-scoped read/write/remove primitives
 * rather than reusing the root-relative helpers below.
 */

function stripLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

/** Reads a root-level OPFS file's bytes. Throws if the file does not exist. */
export async function readOpfsFileBytes(path: string): Promise<Uint8Array> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(stripLeadingSlash(path));
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Removes a root-level OPFS file if it exists; never throws. */
export async function removeOpfsFileIfExists(path: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(stripLeadingSlash(path)).catch(() => undefined);
}
