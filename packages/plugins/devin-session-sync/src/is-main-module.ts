import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when this module was invoked directly as the entry script (not
 * imported for testing). Resolves process.argv[1] through symlinks first,
 * since global npm installs run bin scripts via a symlink while
 * import.meta.url always reflects the real, resolved file path.
 */
export function isMainModule(moduleUrl: string): boolean {
  if (!moduleUrl.startsWith('file:') || !process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}
