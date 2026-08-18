import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Encode a working directory path the way Claude Code encodes it for the
 * `~/.claude/projects/` folder name: every path separator (`/`) is replaced
 * with `-`.
 *
 *   `/Users/foo/bar`  →  `-Users-foo-bar`
 *   `/Users/foo/bar/` →  `-Users-foo-bar`
 */
export function encodeProjectFolder(cwd: string): string {
  const normalized = path.normalize(cwd).replace(/\/+$/, '');
  return normalized.replace(/\//g, '-');
}

/**
 * Decode a Claude Code project folder name back to a working directory path.
 *
 *   `-Users-foo-bar` → `/Users/foo/bar`
 *
 * Note: this is ambiguous if directory names contain `-`, but it matches
 * Claude Code's own encoding.
 */
export function decodeProjectFolder(folder: string): string {
  if (!folder.startsWith('-')) return folder;
  return folder.replace(/-/g, '/');
}

/**
 * Resolve the absolute path to the Claude Code project folder that corresponds
 * to `cwd`, or `undefined` if no such folder exists.
 *
 * @param cwd - the project working directory (defaults to `process.cwd()`)
 * @param claudeConfigDir - the Claude config directory (defaults to `~/.claude`)
 */
export async function resolveClaudeProjectDir(
  cwd: string = process.cwd(),
  claudeConfigDir: string = path.join(os.homedir(), '.claude'),
): Promise<string | undefined> {
  const encoded = encodeProjectFolder(cwd);
  const direct = path.join(claudeConfigDir, 'projects', encoded);

  try {
    const stat = await fsp.stat(direct);
    if (stat.isDirectory()) {
      return direct;
    }
  } catch {
    // Fall through to scan.
  }

  // Fallback: scan ~/.claude/projects/ for a folder whose decoded path matches cwd.
  const projectsDir = path.join(claudeConfigDir, 'projects');
  let entries: string[];
  try {
    entries = await fsp.readdir(projectsDir);
  } catch {
    return undefined;
  }

  const normalizedCwd = path.normalize(cwd).replace(/\/+$/, '');
  for (const entry of entries) {
    const decoded = decodeProjectFolder(entry);
    if (path.normalize(decoded).replace(/\/+$/, '') === normalizedCwd) {
      return path.join(projectsDir, entry);
    }
  }

  return undefined;
}

export interface LocalSession {
  /** The session ID (filename without `.jsonl`). */
  sessionId: string;
  /** Absolute path to the transcript JSONL file. */
  transcriptPath: string;
  /** File size in bytes. */
  size: number;
  /** Last modification time (ms since epoch). */
  mtimeMs: number;
}

/**
 * List all local sessions (`.jsonl` transcript files) in a Claude project
 * directory, sorted by filename.
 */
export async function listLocalSessions(projectDir: string): Promise<LocalSession[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(projectDir);
  } catch {
    return [];
  }

  const sessions: LocalSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = path.join(projectDir, entry);
    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) continue;
      sessions.push({
        sessionId: entry.slice(0, -'.jsonl'.length),
        transcriptPath: fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Skip unreadable files.
    }
  }

  sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return sessions;
}
