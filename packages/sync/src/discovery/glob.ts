import type fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { AllowlistEntry, ArtifactScope } from '@lucasschirm/sal-sync-core';
import type { DiscoveryContext } from './context.js';
import { isPathWithinRoot, isSymlink, lstatDiscovery } from './paths.js';

export interface ExpandedPattern {
  root: string;
  relativePattern: string;
  original: string;
}

const CONFIG_DIR_PATTERN_PREFIX = '{configDir}/';
const HOME_PATTERN_PREFIX = '~/';

/**
 * Expand a global-scope allowlist pattern to a root + relative pattern pair.
 *
 * Two prefix conventions are supported, generic across harnesses:
 *   - `{configDir}/...` resolves against the harness's own config directory
 *     (`HarnessProfile.configDir(env)`, e.g. `~/.claude` for Claude).
 *   - `~/...` resolves against the home directory directly, regardless of
 *     the harness's config directory (e.g. Claude's `~/.claude.json`, which
 *     lives outside its `~/.claude/` config directory).
 */
export function expandAllowlistPattern(
  pattern: string,
  configDir: string,
  homeDir: string,
): ExpandedPattern | undefined {
  if (pattern.startsWith(CONFIG_DIR_PATTERN_PREFIX)) {
    const relative = pattern.slice(CONFIG_DIR_PATTERN_PREFIX.length);
    return { root: configDir, relativePattern: relative, original: pattern };
  }
  if (pattern.startsWith(HOME_PATTERN_PREFIX)) {
    const relative = pattern.slice(HOME_PATTERN_PREFIX.length);
    return { root: homeDir, relativePattern: relative, original: pattern };
  }
  // Workspace / session patterns are relative to their own root.
  return undefined;
}

function globToRegExp(pattern: string): RegExp {
  let regex = '^';
  for (const char of pattern) {
    if (char === '*') {
      regex += '.*';
    } else if (char === '?') {
      regex += '.';
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

interface ParsedPattern {
  baseSegments: string[];
  filePattern?: string;
  recursive: boolean;
}

function parsePattern(relativePattern: string): ParsedPattern | undefined {
  const segments = relativePattern.split('/');
  if (segments.length === 0) {
    return undefined;
  }

  const last = segments[segments.length - 1] as string;
  if (last === '**') {
    return { baseSegments: segments.slice(0, -1), recursive: true };
  }
  if (last.includes('*') || last.includes('?')) {
    return { baseSegments: segments.slice(0, -1), filePattern: last, recursive: false };
  }
  return { baseSegments: segments, recursive: false };
}

export async function discoverFromPattern(
  context: DiscoveryContext,
  expanded: ExpandedPattern,
  scope: ArtifactScope,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const parsed = parsePattern(expanded.relativePattern);
  if (parsed === undefined) {
    return;
  }

  const base = path.resolve(path.join(expanded.root, ...parsed.baseSegments));

  if (!isPathWithinRoot(base, expanded.root)) {
    context.addError({
      code: 'SYNC_DISCOVERY_ERROR',
      path: base,
      message: `Pattern base is outside the allowed boundary ${expanded.root}`,
    });
    return;
  }

  const baseLstat = await lstatDiscovery(base);
  if (baseLstat.error) {
    context.addError(baseLstat.error);
    return;
  }
  if (baseLstat.stat === undefined) {
    // Missing base directory is not an error for an allowlist pattern.
    return;
  }
  if (isSymlink(baseLstat.stat)) {
    context.addError({
      code: 'SYNC_DISCOVERY_ERROR',
      path: base,
      message: 'Symbolic links are not followed',
    });
    return;
  }

  if (parsed.recursive) {
    if (!baseLstat.stat.isDirectory()) {
      return;
    }
    await walkRecursive(context, base, expanded.root, scope, projectId, sessionId);
    return;
  }

  if (parsed.filePattern !== undefined) {
    if (!baseLstat.stat.isDirectory()) {
      return;
    }
    await listGlob(context, base, expanded.root, parsed.filePattern, scope, projectId, sessionId);
    return;
  }

  // Exact file pattern.
  await context.addFile(base, expanded.root, scope, projectId, sessionId);
}

async function listGlob(
  context: DiscoveryContext,
  base: string,
  root: string,
  filePattern: string,
  scope: ArtifactScope,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const regex = globToRegExp(filePattern);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      context.addError({
        code: 'SYNC_DISCOVERY_ERROR',
        path: base,
        message: `Failed to read directory: ${(err as Error).message}`,
      });
    }
    return;
  }

  for (const entry of entries) {
    if (context.stopped) {
      break;
    }
    if (entry.isSymbolicLink()) {
      if (regex.test(entry.name)) {
        context.addError({
          code: 'SYNC_DISCOVERY_ERROR',
          path: path.join(base, entry.name),
          message: 'Symbolic links are not followed',
        });
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!regex.test(entry.name)) {
      continue;
    }
    const result = await context.addFile(
      path.join(base, entry.name),
      root,
      scope,
      projectId,
      sessionId,
    );
    if (result === 'stopped') {
      break;
    }
  }
}

async function walkRecursive(
  context: DiscoveryContext,
  dir: string,
  root: string,
  scope: ArtifactScope,
  projectId: string,
  sessionId: string,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      context.addError({
        code: 'SYNC_DISCOVERY_ERROR',
        path: dir,
        message: `Failed to read directory: ${(err as Error).message}`,
      });
    }
    return;
  }

  for (const entry of entries) {
    if (context.stopped) {
      break;
    }

    const child = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      context.addError({
        code: 'SYNC_DISCOVERY_ERROR',
        path: child,
        message: 'Symbolic links are not followed',
      });
      continue;
    }

    if (entry.isDirectory()) {
      await walkRecursive(context, child, root, scope, projectId, sessionId);
    } else if (entry.isFile()) {
      const result = await context.addFile(child, root, scope, projectId, sessionId);
      if (result === 'stopped') {
        break;
      }
    }
  }
}

export function expandAllowlist(
  entries: readonly AllowlistEntry[],
  configDir: string,
  homeDir: string,
  root?: string,
): ExpandedPattern[] {
  const expanded: ExpandedPattern[] = [];

  for (const entry of entries) {
    if (entry.scope === 'global') {
      const pattern = expandAllowlistPattern(entry.pattern, configDir, homeDir);
      if (pattern) {
        expanded.push(pattern);
      }
    } else if (root !== undefined) {
      expanded.push({ root, relativePattern: entry.pattern, original: entry.pattern });
    }
  }

  return expanded;
}
