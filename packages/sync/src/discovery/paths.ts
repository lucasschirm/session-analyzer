import type { Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { DiscoveryError } from './contract.js';

export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

const CASE_INSENSITIVE_PLATFORMS = new Set(['win32', 'darwin']);

export function isCaseInsensitive(platform = process.platform): boolean {
  return CASE_INSENSITIVE_PLATFORMS.has(platform);
}

export function getHomeDir(): string {
  return os.homedir();
}

export function getDefaultClaudeConfigDir(
  _platform = process.platform,
  homeDir = getHomeDir(),
): string {
  // Claude Code's default config directory is ~/.claude on all supported platforms.
  // This is the fallback, not the only possible root (CLAUDE_CONFIG_DIR can override).
  return path.join(homeDir, '.claude');
}

export function resolveClaudeConfigDir(
  env = process.env as Record<string, string | undefined>,
  platform = process.platform,
  homeDir = getHomeDir(),
): string {
  const override = env[CLAUDE_CONFIG_DIR_ENV];
  if (override?.trim()) {
    return path.resolve(override.trim());
  }
  return getDefaultClaudeConfigDir(platform, homeDir);
}

export function resolveInputPath(input: string, root: string): string {
  const resolvedRoot = path.resolve(root);
  if (path.isAbsolute(input)) {
    return path.normalize(input);
  }
  return path.resolve(resolvedRoot, input);
}

export function isPathWithinRoot(
  absolute: string,
  root: string,
  platform = process.platform,
): boolean {
  const norm = path.normalize(absolute);
  const normRoot = path.normalize(path.resolve(root));

  const parsed = path.parse(norm);
  const parsedRoot = path.parse(normRoot);
  if (parsed.root && parsedRoot.root) {
    const drive = parsed.root.replace(/\\$/, '').toLowerCase();
    const rootDrive = parsedRoot.root.replace(/\\$/, '').toLowerCase();
    if (drive !== rootDrive) {
      return false;
    }
  }

  if (isCaseInsensitive(platform)) {
    const lower = norm.toLowerCase();
    const lowerRoot = normRoot.toLowerCase();
    if (lower === lowerRoot) {
      return true;
    }
    const prefix = lowerRoot.endsWith(path.sep) ? lowerRoot : `${lowerRoot}${path.sep}`;
    return lower.startsWith(prefix);
  }

  const rel = path.relative(normRoot, norm);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function getRelativePath(
  absolute: string,
  root: string,
  platform = process.platform,
): string {
  if (!isPathWithinRoot(absolute, root, platform)) {
    throw new Error(`Path ${absolute} is outside root ${root}`);
  }

  const norm = path.normalize(absolute);
  const normRoot = path.normalize(path.resolve(root));

  if (norm === normRoot) {
    return '';
  }

  if (isCaseInsensitive(platform)) {
    let rel = norm.slice(normRoot.length);
    if (rel.startsWith(path.sep)) {
      rel = rel.slice(path.sep.length);
    }
    return rel;
  }

  return path.relative(normRoot, norm);
}

export interface LstatResult {
  stat?: Stats;
  error?: DiscoveryError;
}

export async function lstatDiscovery(filePath: string): Promise<LstatResult> {
  try {
    return { stat: await fsp.lstat(filePath) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { stat: undefined };
    }
    return {
      error: {
        code: 'SYNC_DISCOVERY_ERROR',
        path: filePath,
        message: `Failed to stat ${filePath}: ${(err as Error).message}`,
      },
    };
  }
}

export function isSymlink(stat: Stats): boolean {
  return stat.isSymbolicLink();
}

export async function validatePath(
  absolutePath: string,
  root: string,
): Promise<{ stat?: Stats; relativePath?: string; error?: DiscoveryError }> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(absolutePath);

  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return {
      error: {
        code: 'SYNC_DISCOVERY_ERROR',
        path: resolvedPath,
        message: `Path is outside the allowed boundary ${resolvedRoot}`,
      },
    };
  }

  const rootParts = resolvedRoot.split(path.sep).filter(Boolean);
  const pathParts = resolvedPath.split(path.sep).filter(Boolean);

  let current = resolvedRoot;
  for (let index = rootParts.length; index < pathParts.length - 1; index += 1) {
    current = path.join(current, pathParts[index] as string);
    const lstat = await lstatDiscovery(current);
    if (lstat.error) {
      return { error: lstat.error };
    }
    if (lstat.stat === undefined) {
      return { stat: undefined };
    }
    if (isSymlink(lstat.stat)) {
      return {
        error: {
          code: 'SYNC_DISCOVERY_ERROR',
          path: current,
          message: 'Symbolic links are not followed',
        },
      };
    }
  }

  const finalLstat = await lstatDiscovery(resolvedPath);
  if (finalLstat.error) {
    return { error: finalLstat.error };
  }
  if (finalLstat.stat === undefined) {
    return { stat: undefined };
  }
  if (isSymlink(finalLstat.stat)) {
    return {
      error: {
        code: 'SYNC_DISCOVERY_ERROR',
        path: resolvedPath,
        message: 'Symbolic links are not followed',
      },
    };
  }

  return {
    stat: finalLstat.stat,
    relativePath: getRelativePath(resolvedPath, resolvedRoot),
  };
}
