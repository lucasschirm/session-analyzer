import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiscoveryResult } from '../../src/discovery/index.js';
import {
  buildCandidates,
  normalizeTranscriptDelta,
  normalizeTranscriptPaths,
} from '../../src/index.js';

const ROOT = '/Users/lucascaixeta/Documents/luschi/session-analyzer';
const HOME = '/Users/lucascaixeta';

describe('normalizeTranscriptPaths', () => {
  it('strips the project root from subpaths', () => {
    expect(normalizeTranscriptPaths(`${ROOT}/.gitignore`, ROOT)).toBe('/.gitignore');
    expect(normalizeTranscriptPaths(`${ROOT}/src/lib/main.ts`, ROOT)).toBe('/src/lib/main.ts');
  });

  it('rewrites the bare root (e.g. end of a JSON string) to "/"', () => {
    const line = JSON.stringify({ type: 'entry', cwd: ROOT });
    const expected = JSON.stringify({ type: 'entry', cwd: '/' });
    expect(normalizeTranscriptPaths(line, ROOT)).toBe(expected);
  });

  it('does not rewrite sibling directories that share the prefix', () => {
    expect(normalizeTranscriptPaths(`${ROOT}-v2/file.ts`, ROOT)).toBe(`${ROOT}-v2/file.ts`);
    expect(normalizeTranscriptPaths(`${ROOT}.backup/x`, ROOT)).toBe(`${ROOT}.backup/x`);
  });

  it('rewrites paths embedded mid-sentence and multiple hits per line', () => {
    const content = `read ${ROOT}/a.ts then ${ROOT}/b.ts\n"cwd":"${ROOT}"`;
    expect(normalizeTranscriptPaths(content, ROOT)).toBe('read /a.ts then /b.ts\n"cwd":"/"');
  });

  it('shortens out-of-project home paths best-effort', () => {
    expect(normalizeTranscriptPaths(`${HOME}/notes.txt`, ROOT, HOME)).toBe('~/notes.txt');
    // Exact home dir itself
    expect(normalizeTranscriptPaths(`"h":"${HOME}"`, ROOT, HOME)).toBe('"h":"~"');
    // Sibling of home is untouched
    expect(normalizeTranscriptPaths('/Users/lucascaixeta2/x', ROOT, HOME)).toBe(
      '/Users/lucascaixeta2/x',
    );
  });

  it('applies the project-root pass before the home fallback', () => {
    // Project path must become "/..." not "~/luschi/..."
    expect(normalizeTranscriptPaths(`${ROOT}/.gitignore`, ROOT, HOME)).toBe('/.gitignore');
  });

  it('handles trailing slashes in the root prefix', () => {
    expect(normalizeTranscriptPaths(`${ROOT}/file.ts`, `${ROOT}/`)).toBe('/file.ts');
  });

  it('is a no-op for missing, relative, or root-level prefixes', () => {
    const content = `${ROOT}/file.ts`;
    expect(normalizeTranscriptPaths(content, undefined)).toBe(content);
    expect(normalizeTranscriptPaths(content, '')).toBe(content);
    expect(normalizeTranscriptPaths(content, '/')).toBe(content);
    expect(normalizeTranscriptPaths(content, 'relative/path')).toBe(content);
  });

  it('returns unchanged content when no matches exist', () => {
    const content = '{"path":"/tmp/other.json","text":"nothing here"}';
    expect(normalizeTranscriptPaths(content, ROOT, HOME)).toBe(content);
  });

  it('never rewrites malformed lines incorrectly', () => {
    const content = `{"partial": true\n${ROOT}/broken.jsonl`;
    expect(normalizeTranscriptPaths(content, ROOT)).toBe('{"partial": true\n/broken.jsonl');
  });
});

describe('buildCandidates transcript normalization', () => {
  const ROOT = '/Users/dev/work/project';

  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeArtifact(name: string, content: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-candidates-'));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function discoveryFor(absolutePath: string, relativePath: string): DiscoveryResult {
    return {
      artifacts: [
        {
          projectId: 'proj',
          sessionId: 'sess',
          scope: 'session',
          relativePath,
          sha256: '0'.repeat(64),
          size: 0,
          absolutePath,
        },
      ],
      errors: [],
      totalBytes: 0,
      filesDiscovered: 1,
    };
  }

  it('normalizes transcript artifacts and hashes the normalized content', async () => {
    const absolutePath = writeArtifact('transcript.jsonl', `{"file_path":"${ROOT}/a.ts"}\n`);
    const results = await buildCandidates(
      discoveryFor(absolutePath, 'transcript.jsonl'),
      {} as never,
      {
        projectRoot: ROOT,
      },
    );
    expect(results[0]?.candidate.content).toBe('{"file_path":"/a.ts"}\n');
  });

  it('leaves non-transcript artifacts untouched', async () => {
    const absolutePath = writeArtifact('meta.txt', `path ${ROOT}/a.ts`);
    const results = await buildCandidates(discoveryFor(absolutePath, 'meta.txt'), {} as never, {
      projectRoot: ROOT,
    });
    expect(results[0]?.candidate.content).toBe(`path ${ROOT}/a.ts`);
  });

  it('keeps transcripts verbatim without a project root', async () => {
    const content = `{"file_path":"${ROOT}/a.ts"}\n`;
    const absolutePath = writeArtifact('transcript.jsonl', content);
    const results = await buildCandidates(
      discoveryFor(absolutePath, 'transcript.jsonl'),
      {} as never,
    );
    expect(results[0]?.candidate.content).toBe(content);
  });
});

describe('normalizeTranscriptDelta', () => {
  const ROOT = '/Users/dev/work/project';

  it('normalizes complete lines in a delta', () => {
    const delta = `{"file_path":"${ROOT}/a.ts"}\n`;
    expect(normalizeTranscriptDelta(delta, ROOT)).toBe('{"file_path":"/a.ts"}\n');
  });

  it('leaves a trailing partial line untouched so a split prefix cannot be corrupted', () => {
    // The writer was mid-line: the root string ends the fragment but its
    // continuation ("-v2/x") has not been appended yet.
    const delta = `{"line":1}\n{"path":"${ROOT}`;
    expect(normalizeTranscriptDelta(delta, ROOT)).toBe(delta);
  });

  it('returns content without newlines unchanged', () => {
    const fragment = `{"path":"${ROOT}/a.ts"}`;
    expect(normalizeTranscriptDelta(fragment, ROOT)).toBe(fragment);
  });

  it('is a no-op without a project root', () => {
    const delta = `{"p":"${ROOT}/x"}\n`;
    expect(normalizeTranscriptDelta(delta, undefined)).toBe(delta);
  });
});
