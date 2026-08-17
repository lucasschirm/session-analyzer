import { describe, expect, it, vi } from 'vitest';

import type { ArtifactCandidate, ArtifactIdentity, SessionData, SyncRun } from '../../src/index.js';
import {
  buildS3ObjectKey,
  buildSessionManifest,
  createEmptySyncState,
  getArtifactRecord,
  getPendingArtifacts,
  getTriggerScope,
  hashCandidate,
  processDelta,
  recordArtifactUploaded,
  sha256Hex,
} from '../../src/index.js';

function makeCandidate(overrides: Partial<ArtifactCandidate> = {}): ArtifactCandidate {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    scope: 'workspace',
    relativePath: 'CLAUDE.md',
    content: 'hello',
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: 'sess-1',
    projectId: 'proj-1',
    harness: 'claude',
    harnessVersion: 'unknown',
    ...overrides,
  };
}

describe('sha256Hex', () => {
  it('produces identical digests for identical input', () => {
    const a = sha256Hex('identical sanitized content');
    const b = sha256Hex('identical sanitized content');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('produces different digests when sanitized content changes', () => {
    const a = sha256Hex('content-a');
    const b = sha256Hex('content-b');
    expect(a).not.toBe(b);
  });
});

describe('buildS3ObjectKey', () => {
  it('derives deterministic object keys from artifact identity', () => {
    const key = buildS3ObjectKey({
      projectId: 'my-project',
      sessionId: 'my-session',
      scope: 'workspace',
      relativePath: '.claude/settings.json',
    });
    expect(key).toBe('my-project/my-session/workspace/.claude/settings.json');
  });
});

describe('selectSanitizer', () => {
  it('redacts JSON secrets before hashing', () => {
    const candidate = makeCandidate({
      relativePath: '.claude/settings.json',
      content: JSON.stringify({ project: 'x', apiKey: 'super-secret' }),
    });
    const result = hashCandidate(candidate);
    expect(result.sanitized).toContain('apiKey');
    expect(result.sanitized).toContain('[REDACTED]');
    expect(result.sanitized).not.toContain('super-secret');
  });

  it('redacts MCP server env maps', () => {
    const candidate = makeCandidate({
      relativePath: '.mcp.json',
      content: JSON.stringify({ mcpServers: { example: { env: { KEY: 'value' } } } }),
    });
    const result = hashCandidate(candidate);
    expect(result.sanitized).toContain('[REDACTED]');
    expect(result.sanitized).not.toContain('value');
  });

  it('redacts credentials in markdown text', () => {
    const candidate = makeCandidate({
      relativePath: 'CLAUDE.md',
      content: 'Deploy to https://user:pass@example.com',
    });
    const result = hashCandidate(candidate);
    expect(result.sanitized).toContain('[CREDENTIALS]');
    expect(result.sanitized).not.toContain('user:pass');
  });

  it('leaves session transcripts raw', () => {
    const line = JSON.stringify({ apiKey: 'secret' });
    const candidate = makeCandidate({
      relativePath: 'transcript.jsonl',
      scope: 'session',
      content: `${line}\n${JSON.stringify({ ok: true })}`,
    });
    const result = hashCandidate(candidate);
    expect(result.sanitized).toBe(`${line}\n${JSON.stringify({ ok: true })}`);
    expect(result.sanitized).toContain('secret');
  });
});

describe('hashCandidate', () => {
  it('hashes sanitized content, not the original unsanitized content', () => {
    const redactSecret = (content: string) =>
      content.replace(/secret:\s*\w+/g, 'secret: [REDACTED]');
    const a = makeCandidate({ content: 'secret: abc', sanitizer: redactSecret });
    const b = makeCandidate({ content: 'secret: xyz', sanitizer: redactSecret });
    const resultA = hashCandidate(a);
    const resultB = hashCandidate(b);
    expect(resultA.artifact.sha256).toBe(resultB.artifact.sha256);
    expect(resultA.sanitized).toBe('secret: [REDACTED]');
  });

  it('produces different hashes when sanitized output changes', () => {
    const redact = (content: string) => content.replace(/token:\s*\w+/g, 'token: [REDACTED]');
    const a = makeCandidate({ content: 'token: abc', sanitizer: redact });
    const b = makeCandidate({ content: 'token: abc-extra', sanitizer: redact });
    const resultA = hashCandidate(a);
    const resultB = hashCandidate(b);
    expect(resultA.artifact.sha256).not.toBe(resultB.artifact.sha256);
  });
});

describe('getTriggerScope', () => {
  it('maps every trigger to its scope', () => {
    expect(getTriggerScope('session-start')).toBe('bulk');
    expect(getTriggerScope('file-changed')).toBe('watcher-delta');
    expect(getTriggerScope('pre-compact')).toBe('hash-filtered');
    expect(getTriggerScope('post-compact')).toBe('hash-filtered');
    expect(getTriggerScope('stop')).toBe('hash-filtered');
    expect(getTriggerScope('stop-failure')).toBe('hash-filtered');
    expect(getTriggerScope('subagent-stop')).toBe('hash-filtered');
    expect(getTriggerScope('manual')).toBe('hash-filtered');
    expect(getTriggerScope('session-end')).toBe('session-end-final');
  });
});

describe('processDelta', () => {
  it('uploads changed artifacts and advances lastUploadedHash', async () => {
    const state = createEmptySyncState();
    const uploader = vi.fn().mockResolvedValue(undefined);
    const candidate = makeCandidate({ content: 'hello' });

    const result = await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader,
    });

    expect(uploader).toHaveBeenCalledTimes(1);
    expect(result.filesUploaded).toBe(1);
    expect(result.bytesUploaded).toBeGreaterThan(0);
    const record = getArtifactRecord(state, result.uploaded[0]);
    expect(record?.lastUploadedHash).toBe(result.uploaded[0].sha256);
    expect(record?.status).toBe('uploaded');
  });

  it('skips unchanged artifacts and does not re-upload them', async () => {
    const state = createEmptySyncState();
    const uploader = vi.fn().mockResolvedValue(undefined);
    const candidate = makeCandidate({ content: 'hello' });

    await processDelta({
      state,
      trigger: 'session-start',
      candidates: [candidate],
      uploader,
    });

    uploader.mockClear();
    const result = await processDelta({
      state,
      trigger: 'post-compact',
      candidates: [candidate],
      uploader,
    });

    expect(uploader).not.toHaveBeenCalled();
    expect(result.filesSkipped).toBe(1);
    expect(result.filesUploaded).toBe(0);
    expect(result.filesChanged).toBe(0);
  });

  it('leaves lastUploadedHash un-advanced when an upload fails', async () => {
    const state = createEmptySyncState();
    const uploader = vi.fn().mockRejectedValue(new Error('upload failed'));
    const candidate = makeCandidate({ content: 'hello' });

    const result = await processDelta({
      state,
      trigger: 'stop',
      candidates: [candidate],
      uploader,
    });

    expect(result.filesFailed).toBe(1);
    expect(result.filesUploaded).toBe(0);
    expect(result.errors).toContain('SYNC_STORAGE_ERROR');
    const record = getArtifactRecord(state, result.failed[0]);
    expect(record?.lastUploadedHash).toBeUndefined();
    expect(record?.status).toBe('failed');
    expect(record?.attemptCount).toBe(1);
  });

  it('re-detects a previously failed artifact on the next trigger', async () => {
    const state = createEmptySyncState();
    const failing = vi.fn().mockRejectedValue(new Error('upload failed'));
    const succeeding = vi.fn().mockResolvedValue(undefined);
    const candidate = makeCandidate({ content: 'hello' });

    await processDelta({
      state,
      trigger: 'stop',
      candidates: [candidate],
      uploader: failing,
    });

    const result = await processDelta({
      state,
      trigger: 'post-compact',
      candidates: [candidate],
      uploader: succeeding,
    });

    expect(result.filesUploaded).toBe(1);
    const record = getArtifactRecord(state, result.uploaded[0]);
    expect(record?.lastUploadedHash).toBe(result.uploaded[0].sha256);
    expect(record?.status).toBe('uploaded');
  });

  it('file-changed only processes the watched target', async () => {
    const state = createEmptySyncState();
    const uploader = vi.fn().mockResolvedValue(undefined);
    const a = makeCandidate({ relativePath: 'a.md', content: 'a' });
    const b = makeCandidate({ relativePath: 'b.md', content: 'b' });

    const result = await processDelta({
      state,
      trigger: 'file-changed',
      candidates: [a, b],
      uploader,
      targetRelativePath: 'a.md',
    });

    expect(uploader).toHaveBeenCalledTimes(1);
    expect(result.filesDiscovered).toBe(1);
    expect(result.filesUploaded).toBe(1);
    expect(result.uploaded[0].relativePath).toBe('a.md');
  });

  it('hash-filtered uploads only pending artifacts', async () => {
    const state = createEmptySyncState();
    const artifact = makeCandidate({ relativePath: 'a.md', content: 'a' });
    recordArtifactUploaded(state, {
      ...artifact,
      sha256: hashCandidate(artifact).artifact.sha256,
    });

    const uploader = vi.fn().mockResolvedValue(undefined);
    const changed = makeCandidate({ relativePath: 'b.md', content: 'b' });

    const result = await processDelta({
      state,
      trigger: 'pre-compact',
      candidates: [artifact, changed],
      uploader,
    });

    expect(uploader).toHaveBeenCalledTimes(1);
    expect(result.filesDiscovered).toBe(2);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesUploaded).toBe(1);
    expect(result.uploaded[0].relativePath).toBe('b.md');
  });

  it('tracks per-trigger discovery and change metrics', async () => {
    const state = createEmptySyncState();
    const uploader = vi.fn().mockResolvedValue(undefined);
    const a = makeCandidate({ relativePath: 'a.md', content: 'aa' });
    const b = makeCandidate({ relativePath: 'b.md', content: 'bb' });
    recordArtifactUploaded(state, {
      ...a,
      sha256: hashCandidate(a).artifact.sha256,
    });

    const result = await processDelta({
      state,
      trigger: 'stop',
      candidates: [a, b],
      uploader,
    });

    expect(result.filesDiscovered).toBe(2);
    expect(result.filesChanged).toBe(1);
    expect(result.filesUnchanged).toBe(1);
    expect(result.filesUploaded).toBe(1);
    expect(result.bytesDiscovered).toBeGreaterThan(0);
    expect(result.bytesChanged).toBe(result.bytesUploaded);
  });

  it('uploads a manifest on session-end and records it in the result', async () => {
    const state = createEmptySyncState();
    const uploader = vi.fn().mockResolvedValue(undefined);
    const session = makeSession();
    const candidate = makeCandidate({ content: 'line' });

    const result = await processDelta({
      state,
      trigger: 'session-end',
      candidates: [candidate],
      uploader,
      session,
    });

    expect(result.manifest).toBeDefined();
    expect(result.manifest?.projectId).toBe(session.projectId);
    expect(result.manifest?.sessionId).toBe(session.sessionId);
    expect(result.manifest?.artifacts).toHaveLength(1);
    expect(result.manifest?.syncRuns).toHaveLength(1);
    expect(uploader).toHaveBeenCalledTimes(2);

    const manifestCall = uploader.mock.calls.find(
      (call) => call[0].relativePath === 'manifest.json',
    );
    expect(manifestCall).toBeDefined();
  });

  it('does not advance lastUploadedHash for the manifest when manifest upload fails', async () => {
    const state = createEmptySyncState();
    const uploader = vi.fn().mockResolvedValue(undefined);
    uploader.mockImplementation(async (artifact: ArtifactIdentity) => {
      if (artifact.relativePath === 'manifest.json') {
        throw new Error('manifest upload failed');
      }
    });
    const session = makeSession();
    const candidate = makeCandidate({ content: 'line' });

    const result = await processDelta({
      state,
      trigger: 'session-end',
      candidates: [candidate],
      uploader,
      session,
    });

    expect(result.filesUploaded).toBe(1);
    expect(result.filesFailed).toBe(1);
    expect(result.manifest).toBeDefined();
    const record = getArtifactRecord(state, {
      projectId: session.projectId,
      sessionId: session.sessionId,
      scope: 'runtime',
      relativePath: 'manifest.json',
      sha256: '',
    });
    expect(record?.lastUploadedHash).toBeUndefined();
  });

  it('only allows one writer to advance lastUploadedHash at a time through state', async () => {
    const state = createEmptySyncState();
    const uploader = vi.fn().mockResolvedValue(undefined);
    const a = makeCandidate({ relativePath: 'a.md', content: 'a' });
    const b = makeCandidate({ relativePath: 'b.md', content: 'b' });

    await processDelta({
      state,
      trigger: 'session-start',
      candidates: [a, b],
      uploader,
    });

    const records = getPendingArtifacts(state, [
      hashCandidate(a).artifact,
      hashCandidate(b).artifact,
    ]);
    expect(records).toHaveLength(0);

    for (const path of ['a.md', 'b.md']) {
      const artifact = { ...a, relativePath: path, sha256: '' };
      const record = getArtifactRecord(state, artifact);
      expect(record?.lastUploadedHash).toBeDefined();
      expect(record?.status).toBe('uploaded');
    }
  });
});

describe('buildSessionManifest', () => {
  it('records the SHA-256 digest for each artifact', () => {
    const session = makeSession();
    const run: SyncRun = {
      trigger: 'session-end',
      filesDiscovered: 1,
      filesChanged: 1,
      filesUploaded: 1,
      filesFailed: 0,
      filesSkipped: 0,
      bytesDiscovered: 100,
      bytesChanged: 100,
      bytesUploaded: 100,
      errors: [],
      discoveryDurationMs: 0,
      sanitizationDurationMs: 0,
      hashDurationMs: 0,
      uploadDurationMs: 0,
      totalDurationMs: 0,
    };
    const artifacts = [
      {
        projectId: session.projectId,
        sessionId: session.sessionId,
        scope: 'workspace' as const,
        relativePath: 'settings.json',
        sha256: 'abc123',
        size: 100,
        status: 'uploaded' as const,
      },
    ];
    const manifest = buildSessionManifest(session, run, artifacts);
    expect(manifest.artifacts[0].sha256).toBe('abc123');
    expect(manifest.projectId).toBe(session.projectId);
  });
});
