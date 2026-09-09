import { execFile as execFileCallback } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type CandidateResult,
  FileLock,
  hashCandidate,
  writeFileAtomic,
} from '@lucasschirm/sal-sync';
import { resolveDevinCliVersion } from '../devin-profile.js';
import { parseDevinModelsList } from './parse.js';

const execFile = promisify(execFileCallback);

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 900_000;

export interface CaptureDevinModelsOptions {
  dataDir: string;
  devinCliVersion?: string;
  resolveVersion?: () => string;
  runModelsList?: () => Promise<string>;
  ttlMs?: number;
  now?: () => number;
}

export interface DevinModelsCaptureResult {
  raw: string;
  devinCliVersion: string;
  capturedAt: number;
  error?: string;
}

export interface BuildDevinModelCandidatesOptions extends CaptureDevinModelsOptions {
  projectId: string;
  sessionId: string;
}

export interface DevinModelCandidatesResult {
  candidates: CandidateResult[];
  devinCliVersion: string;
  error?: string;
}

export async function captureDevinModels(
  options: CaptureDevinModelsOptions,
): Promise<DevinModelsCaptureResult> {
  const dataDir = options.dataDir;
  const cachePath = cacheFilePath(dataDir);
  const lockPath = lockFilePath(dataDir);
  const now = options.now?.() ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const devinCliVersion = options.devinCliVersion ?? resolveVersionOption(options);

  const lock = new FileLock(lockPath);
  try {
    return await lock.withLock(async () => {
      const cache = await readCache(cachePath);
      const cached = cache.entries[devinCliVersion];
      if (cached && now - cached.capturedAt <= ttlMs) {
        return { ...cached };
      }

      try {
        const run = options.runModelsList ?? defaultRunModelsList;
        const raw = await run();
        const entry: CacheEntry = { raw, devinCliVersion, capturedAt: now };
        cache.entries[devinCliVersion] = entry;
        await writeFileAtomic(cachePath, JSON.stringify(cache, null, 2));
        return { ...entry };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { raw: '', devinCliVersion, capturedAt: now, error: message };
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { raw: '', devinCliVersion, capturedAt: now, error: message };
  }
}

export async function buildDevinModelCandidates(
  options: BuildDevinModelCandidatesOptions,
): Promise<DevinModelCandidatesResult> {
  const capture = await captureDevinModels(options);
  if (capture.error) {
    return { candidates: [], devinCliVersion: capture.devinCliVersion, error: capture.error };
  }

  const parsed = parseDevinModelsList(capture.raw);
  const candidates: CandidateResult[] = [
    buildRuntimeCandidate(options, 'native/models-list.raw.json', capture.raw),
    buildRuntimeCandidate(options, 'native/models.json', JSON.stringify(parsed, null, 2)),
  ];

  return { candidates, devinCliVersion: capture.devinCliVersion };
}

interface CacheEntry {
  raw: string;
  devinCliVersion: string;
  capturedAt: number;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

function cacheFilePath(dataDir: string): string {
  return path.join(dataDir, 'devin', 'models-cache.json');
}

function lockFilePath(dataDir: string): string {
  return path.join(dataDir, 'devin', 'models-cache.lock');
}

function resolveVersionOption(options: CaptureDevinModelsOptions): string {
  return options.resolveVersion ? options.resolveVersion() : resolveDevinCliVersion();
}

async function defaultRunModelsList(): Promise<string> {
  const { stdout } = await execFile('devin', ['models', 'list', '--format', 'json'], {
    encoding: 'utf8',
  });
  return stdout;
}

async function readCache(cachePath: string): Promise<CacheFile> {
  try {
    const raw = await fsp.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (isCacheFile(parsed)) return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Corrupt or unreadable cache; start fresh.
    }
  }
  return { version: CACHE_SCHEMA_VERSION, entries: {} };
}

function isCacheFile(value: unknown): value is CacheFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof (value as CacheFile).version === 'number' &&
    'entries' in value &&
    typeof (value as CacheFile).entries === 'object' &&
    (value as CacheFile).entries !== null
  );
}

function buildRuntimeCandidate(
  options: BuildDevinModelCandidatesOptions,
  relativePath: string,
  content: string,
): CandidateResult {
  const hashed = hashCandidate({
    projectId: options.projectId,
    sessionId: options.sessionId,
    scope: 'runtime',
    relativePath,
    content,
    sanitizer: (c) => c,
  });

  return {
    candidate: {
      projectId: options.projectId,
      sessionId: options.sessionId,
      scope: 'runtime',
      relativePath,
      content: hashed.sanitized,
      sanitizer: (c) => c,
    },
    size: hashed.size,
    sha256: hashed.artifact.sha256,
  };
}
