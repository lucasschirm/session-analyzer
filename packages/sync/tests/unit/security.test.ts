import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildObjectKey,
  buildSessionManifest,
  createWatcherMatcher,
  DEFAULT_SANITIZATION_POLICY,
  discover,
  getArtifactRecord,
  getWatchedRelativePath,
  hashCandidate,
  isPathWatched,
  loadConfig,
  mapS3Error,
  processDelta,
  recordArtifactUploaded,
  redactSecrets,
  S3StorageAdapter,
  StateStore,
  type StorageAdapter,
  StorageError,
  sanitizeJson,
  sanitizeJsonl,
  sanitizeMcpConfig,
  TelemetryLogger,
  TranscriptWatcher,
} from '../../src/index.js';

const TEST_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const TEST_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const TEST_SESSION_TOKEN = 'FwoGZXIvYXdzEBYaDL...';

function sha256(input: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function containsNone(haystack: string, needles: string[]): boolean {
  return !needles.some((needle) => haystack.includes(needle));
}

class InMemoryStorageAdapter implements StorageAdapter {
  readonly calls: Array<{
    projectId: string;
    sessionId: string;
    scope: string;
    relativePath: string;
    content: string;
    key: string;
  }> = [];

  async putObject(input: {
    projectId: string;
    sessionId: string;
    scope: string;
    relativePath: string;
    body: Uint8Array;
    contentSha256?: string;
  }) {
    const key = `${input.projectId}/${input.sessionId}/${input.scope}/${input.relativePath}`;
    this.calls.push({
      projectId: input.projectId,
      sessionId: input.sessionId,
      scope: input.scope,
      relativePath: input.relativePath,
      content: Buffer.from(input.body).toString('utf8'),
      key,
    });
    return {
      key,
      sha256: input.contentSha256 ?? '0'.repeat(64),
    };
  }
}

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SAL_PROJECT_ID: 'proj-1',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ID: TEST_ACCESS_KEY,
    SAL_STORAGE_SECRET: TEST_SECRET_KEY,
    SAL_STORAGE_SESSION_TOKEN: TEST_SESSION_TOKEN,
    SAL_CAPTURE_TRANSCRIPTS: 'true',
    SAL_MAX_TRANSCRIPT_BYTES: '1000000',
    SAL_HOOK_UPLOAD_TIMEOUT: '5000',
    ...overrides,
  };
}

async function writeFile(filePath: string, content: Buffer | string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

async function appendFile(filePath: string, data: string): Promise<void> {
  const handle = await fsp.open(filePath, 'a');
  try {
    await handle.write(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('secret redaction policy', () => {
  const secretValues = [
    'super-secret-value',
    'bearer-token-abc',
    'https://admin:hunter2@example.com',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
  ];

  it('redacts every JSON_REDACTION_FIELDS value from sanitized output', () => {
    const input: Record<string, unknown> = {};
    for (const field of DEFAULT_SANITIZATION_POLICY.jsonRedactionFields) {
      input[field] = 'super-secret-value';
    }

    const output = sanitizeJson(input) as Record<string, unknown>;
    for (const field of DEFAULT_SANITIZATION_POLICY.jsonRedactionFields) {
      expect(output[field]).toBe('[REDACTED]');
    }
  });

  it('does not leak secret values from any JSON redaction field', () => {
    const input = {
      nested: {
        apiKey: 'super-secret-value',
      },
      server: {
        token: 'bearer-token-abc',
      },
    };

    const output = JSON.stringify(sanitizeJson(input));
    expect(containsNone(output, secretValues)).toBe(true);
  });

  it('redacts secrets in JSONL config artifacts but leaves transcripts raw', () => {
    const configLine = JSON.stringify({ apiKey: 'super-secret-value' });
    const sanitizedConfig = sanitizeJsonl(`${configLine}\n{"ok":true}`);
    expect(sanitizedConfig).not.toContain('super-secret-value');
    expect(sanitizedConfig).toContain('[REDACTED]');

    const transcriptLine = JSON.stringify({ apiKey: 'super-secret-value' });
    const rawTranscript = sanitizeJsonl(`${transcriptLine}\n{"ok":true}`, { isTranscript: true });
    expect(rawTranscript).toContain('super-secret-value');
  });

  it('redacts MCP server env, Authorization headers, and credential-bearing args', () => {
    const input = {
      mcpServers: {
        github: {
          command: 'npx',
          env: { GITHUB_TOKEN: 'super-secret-value' },
          headers: { Authorization: 'Bearer bearer-token-abc' },
          args: ['https://admin:hunter2@example.com'],
        },
      },
    };

    const output = sanitizeMcpConfig(input) as typeof input;
    expect(output.mcpServers.github.env.GITHUB_TOKEN).toBe('[REDACTED]');
    expect(output.mcpServers.github.headers).not.toHaveProperty('Authorization');
    expect(output.mcpServers.github.args[0]).toBe('https://[CREDENTIALS]@example.com');

    const json = JSON.stringify(output);
    expect(containsNone(json, ['super-secret-value', 'bearer-token-abc', 'admin:hunter2'])).toBe(
      true,
    );
  });

  it('redacts credentials in free-form text', () => {
    const input = `Authorization: Bearer bearer-token-abc
See https://admin:hunter2@example.com
${secretValues[3]}`;
    const output = redactSecrets(input);
    expect(containsNone(output, ['bearer-token-abc', 'admin:hunter2', 'MIIEpAIBAAKCAQEA'])).toBe(
      true,
    );
  });
});

describe('sanitized content is hashed and uploaded, transcripts are raw', () => {
  it('hashes sanitized config content, not the raw secret-laden content', () => {
    const raw = JSON.stringify({ apiKey: 'super-secret-value', public: 'ok' });
    const sanitized = JSON.stringify(sanitizeJson(JSON.parse(raw)));

    const candidate = {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      scope: 'workspace' as const,
      relativePath: '.claude/settings.json',
      content: raw,
    };

    const result = hashCandidate(candidate);
    expect(result.sanitized).toBe(sanitized);
    expect(result.artifact.sha256).toBe(sha256(sanitized));
    expect(result.artifact.sha256).not.toBe(sha256(raw));
    expect(result.sanitized).not.toContain('super-secret-value');
  });

  it('uploads session transcripts raw by default', () => {
    const raw = `{"apiKey":"super-secret-value"}\n{"ok":true}`;

    const candidate = {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      scope: 'session' as const,
      relativePath: 'transcript.jsonl',
      content: raw,
    };

    const result = hashCandidate(candidate);
    expect(result.sanitized).toBe(raw);
    expect(result.artifact.sha256).toBe(sha256(raw));
    expect(result.sanitized).toContain('super-secret-value');
  });

  it('uploads sanitized workspace JSONL, not raw', () => {
    const raw = `{"apiKey":"super-secret-value"}\n{"ok":true}`;

    const candidate = {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      scope: 'workspace' as const,
      relativePath: 'events.jsonl',
      content: raw,
    };

    const result = hashCandidate(candidate);
    expect(result.sanitized).not.toContain('super-secret-value');
    expect(result.artifact.sha256).toBe(sha256(result.sanitized));
    expect(result.artifact.sha256).not.toBe(sha256(raw));
  });
});

describe('object key path traversal prevention', () => {
  it('rejects absolute unix paths in object keys', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: '/etc/passwd',
      }),
    ).toThrow(StorageError);
  });

  it('rejects absolute windows paths in object keys', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: 'C:\\Windows\\secret.ini',
      }),
    ).toThrow(StorageError);
  });

  it('rejects parent directory traversal in relative paths', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: 'foo/../../bar',
      }),
    ).toThrow(StorageError);
  });

  it('encodes traversal attempts in path segments as literal key parts', () => {
    const key = buildObjectKey({
      projectId: 'p',
      sessionId: 's',
      scope: 'workspace',
      relativePath: 'foo/..%2F..%2Fbar',
    });
    expect(key).toBe('p/s/workspace/foo/..%252F..%252Fbar');
    expect(key).not.toContain('/../');
  });

  it('rejects empty relative paths', () => {
    expect(() =>
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: '',
      }),
    ).toThrow(StorageError);
  });
});

describe('discovery boundary enforcement', () => {
  let workspace: string;
  let claudeConfigDir: string;
  let homeDir: string;
  let transcriptDir: string;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-ws-'));
    claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-cfg-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-home-'));
    transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-tx-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(claudeConfigDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('rejects symlinks that point outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-out-'));
    try {
      await writeFile(path.join(outside, 'leaked.md'), 'secret');
      const linkPath = path.join(workspace, 'CLAUDE.md');
      fs.symlinkSync(path.join(outside, 'leaked.md'), linkPath);

      const result = await discover({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        workspaceRoot: workspace,
        claudeConfigDir,
        homeDir,
      });

      const found = result.artifacts.find((a) => a.relativePath === 'CLAUDE.md');
      expect(found).toBeUndefined();
      expect(result.errors.some((e) => e.code === 'SYNC_DISCOVERY_ERROR')).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects symlinks inside the session transcript directory that resolve elsewhere', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-tx-out-'));
    try {
      const outsideFile = path.join(outside, 'leaked.jsonl');
      await writeFile(outsideFile, '{"secret":true}\n');
      const linkPath = path.join(transcriptDir, 'transcript.jsonl');
      fs.symlinkSync(outsideFile, linkPath);

      const result = await discover({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        workspaceRoot: workspace,
        claudeConfigDir,
        homeDir,
        transcriptPath: linkPath,
      });

      expect(result.artifacts.some((a) => a.scope === 'session')).toBe(false);
      expect(result.errors.some((e) => e.code === 'SYNC_DISCOVERY_ERROR')).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects malicious path-traversal patterns discovered in the workspace', async () => {
    const badDir = path.join(workspace, '.claude');
    const normalFile = path.join(badDir, 'settings.json');
    await writeFile(normalFile, '{}');

    const result = await discover({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
      claudeConfigDir,
      homeDir,
    });

    const found = result.artifacts.find((a) => a.relativePath === '.claude/settings.json');
    expect(found).toBeDefined();
    for (const artifact of result.artifacts) {
      expect(artifact.relativePath).not.toContain('/../');
      expect(path.isAbsolute(artifact.relativePath)).toBe(false);
    }
  });

  it('does not expose absolute local paths in artifact relativePath', async () => {
    await writeFile(path.join(workspace, 'CLAUDE.md'), '# ok');

    const result = await discover({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
      claudeConfigDir,
      homeDir,
    });

    for (const artifact of result.artifacts) {
      expect(path.isAbsolute(artifact.relativePath)).toBe(false);
      expect(artifact.relativePath.startsWith('/')).toBe(false);
      expect(artifact.relativePath.startsWith('..')).toBe(false);
    }
  });
});

describe('watcher boundary enforcement', () => {
  let transcriptDir: string;

  beforeEach(() => {
    transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-watcher-'));
  });

  afterEach(() => {
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('matcher rejects paths outside the transcript directory', () => {
    const matcher = createWatcherMatcher(transcriptDir);

    expect(isPathWatched(matcher, path.join(transcriptDir, 'transcript.jsonl'))).toBe(true);
    expect(isPathWatched(matcher, path.join(transcriptDir, 'subagents', 'agent-1.jsonl'))).toBe(
      true,
    );

    const outside = path.join(transcriptDir, '..', 'evil.jsonl');
    expect(isPathWatched(matcher, outside)).toBe(false);
    expect(getWatchedRelativePath(matcher, outside)).toBeUndefined();
  });

  it('matcher rejects symlinks that resolve outside the transcript directory', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-watcher-out-'));
    const outsideFile = path.join(outsideDir, 'leaked.jsonl');
    await fsp.writeFile(outsideFile, '{\n}');

    const linkPath = path.join(transcriptDir, 'link.jsonl');
    fs.symlinkSync(outsideFile, linkPath);

    const matcher = createWatcherMatcher(transcriptDir);
    expect(isPathWatched(matcher, linkPath)).toBe(false);
    expect(getWatchedRelativePath(matcher, linkPath)).toBeUndefined();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('TranscriptWatcher does not upload files outside the transcript directory', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-watcher-data-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-watcher-out2-'));
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await fsp.writeFile(transcriptPath, '');

    const outsideFile = path.join(outsideDir, 'leaked.jsonl');
    await fsp.writeFile(outsideFile, '{"outside":true}\n');
    const linkPath = path.join(transcriptDir, 'link.jsonl');
    fs.symlinkSync(outsideFile, linkPath);

    const storage = new InMemoryStorageAdapter();
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env: baseEnv(),
      storageAdapter: storage,
      debounceMs: 30,
      pollIntervalMs: 50,
      livenessIntervalMs: 100_000,
    });

    const startPromise = watcher.start();
    await sleep(100);

    await appendFile(transcriptPath, '{"inside":true}\n');
    await sleep(200);

    await watcher.stop();
    await startPromise.catch(() => {});

    const sessionCalls = storage.calls.filter((c) => c.scope === 'session');
    expect(sessionCalls.some((c) => c.relativePath === 'transcript.jsonl')).toBe(true);
    expect(sessionCalls.some((c) => c.relativePath === 'link.jsonl')).toBe(false);

    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe('transcript capture policy', () => {
  let workspace: string;
  let claudeConfigDir: string;
  let homeDir: string;
  let transcriptDir: string;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-tx-policy-ws-'));
    claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-tx-policy-cfg-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-tx-policy-home-'));
    transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-tx-policy-tx-'));
    await writeFile(path.join(workspace, 'CLAUDE.md'), '# ok');
    await writeFile(path.join(claudeConfigDir, 'settings.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(claudeConfigDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('discovers and uploads raw transcripts by default', async () => {
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await writeFile(transcriptPath, '{"secret":true}\n');

    const result = await discover({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
      claudeConfigDir,
      homeDir,
      transcriptPath,
    });

    const transcript = result.artifacts.find((a) => a.relativePath === 'transcript.jsonl');
    expect(transcript).toBeDefined();
    expect(transcript?.scope).toBe('session');
  });

  it('excludes transcripts from discovery and upload when capture is disabled', async () => {
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await writeFile(transcriptPath, '{"secret":true}\n');

    const result = await discover({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      workspaceRoot: workspace,
      claudeConfigDir,
      homeDir,
      transcriptPath,
      captureTranscripts: false,
    });

    expect(result.artifacts.some((a) => a.scope === 'session')).toBe(false);
  });

  it('TranscriptWatcher exits immediately and does not spawn when SAL_CAPTURE_TRANSCRIPTS=false', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-tx-optout-'));
    const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await fsp.writeFile(transcriptPath, '');

    const storage = new InMemoryStorageAdapter();
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env: baseEnv({ SAL_CAPTURE_TRANSCRIPTS: 'false' }),
      storageAdapter: storage,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    expect(storage.calls).toHaveLength(0);
    const pidPath = path.join(dataDir, 'watcher', `${encodeURIComponent('sess-1')}.pid`);
    expect(fs.existsSync(pidPath)).toBe(false);

    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('manifest records transcriptsCaptured=false when opted out', () => {
    const session = {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      harness: 'claude',
      harnessVersion: '0.1.0',
    };
    const run = {
      trigger: 'session-end' as const,
      filesDiscovered: 0,
      filesChanged: 0,
      filesUploaded: 0,
      filesFailed: 0,
      filesSkipped: 0,
      bytesDiscovered: 0,
      bytesChanged: 0,
      bytesUploaded: 0,
      errors: [],
      discoveryDurationMs: 0,
      sanitizationDurationMs: 0,
      hashDurationMs: 0,
      uploadDurationMs: 0,
      totalDurationMs: 0,
    };
    const manifest = buildSessionManifest(session, run, [], { transcriptsCaptured: false });
    expect(manifest.transcriptsCaptured).toBe(false);
    expect(manifest.artifacts).toHaveLength(0);
  });
});

describe('storage credential isolation', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-state-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('loadConfig does not hardcode credentials and requires explicit env values', () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.disabled).toBe(true);
  });

  it('loadConfig reflects explicit storage credentials from env but never stores them in sync state', async () => {
    const config = loadConfig(baseEnv());
    expect(config.ok).toBe(true);
    if (!config.ok) throw new Error('expected success');
    expect(config.config.storage.accessKeyId).toBe(TEST_ACCESS_KEY);
    expect(config.config.storage.secretAccessKey).toBe(TEST_SECRET_KEY);

    const store = new StateStore(dataDir);
    await store.withState((state) => {
      recordArtifactUploaded(state, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        scope: 'workspace',
        relativePath: 'CLAUDE.md',
        sha256: 'hash',
      });
    });

    const stateRaw = await fsp.readFile(path.join(dataDir, 'state', 'state.json'), 'utf8');
    expect(containsNone(stateRaw, [TEST_ACCESS_KEY, TEST_SECRET_KEY, TEST_SESSION_TOKEN])).toBe(
      true,
    );

    const sessionData = {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      harness: 'claude',
      harnessVersion: '0.1.0',
    };
    await store.setSession('sess-1', sessionData);
    const sessionRaw = await fsp.readFile(
      path.join(dataDir, 'sessions', encodeURIComponent('sess-1'), 'session.json'),
      'utf8',
    );
    expect(containsNone(sessionRaw, [TEST_ACCESS_KEY, TEST_SECRET_KEY, TEST_SESSION_TOKEN])).toBe(
      true,
    );
  });
});

describe('credential-safe error telemetry', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-tel-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('mapS3Error strips credential-bearing exception messages', () => {
    const awsError = {
      name: 'InvalidAccessKeyId',
      $metadata: { httpStatusCode: 403 },
      message: `The AWS Access Key Id ${TEST_ACCESS_KEY} you provided does not exist in our records. Secret: ${TEST_SECRET_KEY}`,
    };

    const error = mapS3Error(awsError);
    expect(error).toBeInstanceOf(StorageError);
    expect(error.code).toBe('SYNC_AUTH_FAILED');
    expect(String(error)).not.toContain(TEST_ACCESS_KEY);
    expect(String(error)).not.toContain(TEST_SECRET_KEY);
  });

  it('S3StorageAdapter does not leak credentials when an upload fails', async () => {
    const sendSpy = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue({
      name: 'InvalidAccessKeyId',
      $metadata: { httpStatusCode: 403 },
      message: `The AWS Access Key Id ${TEST_ACCESS_KEY} you provided does not exist in our records.`,
    });

    const adapter = new S3StorageAdapter(
      {
        type: 's3',
        bucket: 'my-bucket',
        region: 'us-east-1',
        accessKeyId: TEST_ACCESS_KEY,
        secretAccessKey: TEST_SECRET_KEY,
      },
      { retries: 0 },
    );

    try {
      await adapter.putObject({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: 'file.txt',
        body: new TextEncoder().encode('hello'),
      });
      throw new Error('expected throw');
    } catch (err) {
      const text = String(err);
      expect(text).not.toContain(TEST_ACCESS_KEY);
      expect(text).not.toContain(TEST_SECRET_KEY);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('TelemetryLogger redacts known credential fields before writing', async () => {
    const logger = new TelemetryLogger({ dataDir });

    await logger.log({
      sessionId: 'sess-1',
      command: 'capture',
      trigger: 'manual',
      timestamp: new Date().toISOString(),
      filesDiscovered: 0,
      filesChanged: 0,
      filesUploaded: 0,
      filesFailed: 1,
      filesSkipped: 0,
      bytesDiscovered: 0,
      bytesChanged: 0,
      bytesUploaded: 0,
      errors: ['SYNC_AUTH_FAILED'],
      discoveryDurationMs: 0,
      sanitizationDurationMs: 0,
      hashDurationMs: 0,
      uploadDurationMs: 0,
      totalDurationMs: 0,
      diagnostics: {
        token: `Bearer ${TEST_SESSION_TOKEN}`,
        secret: `https://admin:${TEST_SECRET_KEY}@example.com`,
        safe: 'keep-me',
      },
    });

    const logPath = path.join(dataDir, 'logs', 'telemetry.jsonl');
    const raw = await fsp.readFile(logPath, 'utf8');
    const record = JSON.parse(raw) as Record<string, unknown>;
    const diagnostics = record.diagnostics as Record<string, unknown>;

    expect(diagnostics.token).toBe('[REDACTED]');
    expect(diagnostics.secret).toBe('[REDACTED]');
    expect(diagnostics.safe).toBe('keep-me');
    expect(raw).not.toContain(TEST_ACCESS_KEY);
    expect(raw).not.toContain(TEST_SECRET_KEY);
    expect(raw).not.toContain(TEST_SESSION_TOKEN);
  });
});

describe('concurrent writers cannot corrupt state', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-sec-concurrent-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('StateStore withState serializes concurrent same-process updates', async () => {
    const store = new StateStore(dataDir);
    const artifacts = Array.from({ length: 20 }, (_, i) => ({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      scope: 'workspace' as const,
      relativePath: `file-${i}.json`,
      sha256: `hash-${i}`,
    }));

    await Promise.all(
      artifacts.map((artifact) =>
        store.withState((state) => {
          recordArtifactUploaded(state, artifact);
        }),
      ),
    );

    const state = await store.readState();
    for (const artifact of artifacts) {
      const record = getArtifactRecord(state, artifact);
      expect(record?.status).toBe('uploaded');
      expect(record?.lastUploadedHash).toBe(artifact.sha256);
    }
  });

  it('separate StateStore instances on the same dataDir do not corrupt each other', async () => {
    const storeA = new StateStore(dataDir);
    const storeB = new StateStore(dataDir);

    const a = {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      scope: 'workspace' as const,
      relativePath: 'a.json',
      sha256: 'hash-a',
    };
    const b = {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      scope: 'workspace' as const,
      relativePath: 'b.json',
      sha256: 'hash-b',
    };

    await Promise.all([
      storeA.withState((state) => recordArtifactUploaded(state, a)),
      storeB.withState((state) => recordArtifactUploaded(state, b)),
    ]);

    const state = await storeA.readState();
    expect(getArtifactRecord(state, a)?.status).toBe('uploaded');
    expect(getArtifactRecord(state, b)?.status).toBe('uploaded');
  });

  it('processDelta under withState handles concurrent upload attempts for the same artifact', async () => {
    const store = new StateStore(dataDir);
    const uploader = vi.fn().mockResolvedValue(undefined);
    const candidate = {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      scope: 'workspace' as const,
      relativePath: 'CLAUDE.md',
      content: 'hello',
    };

    await Promise.all([
      store.withState((state) =>
        processDelta({
          state,
          trigger: 'session-start',
          candidates: [candidate],
          uploader,
        }),
      ),
      store.withState((state) =>
        processDelta({
          state,
          trigger: 'post-compact',
          candidates: [candidate],
          uploader,
        }),
      ),
    ]);

    const state = await store.readState();
    const record = getArtifactRecord(state, hashCandidate(candidate).artifact);
    expect(record).toBeDefined();
    expect(record?.lastUploadedHash).toBe(hashCandidate(candidate).artifact.sha256);
    expect(record?.status).not.toBe('failed');
    expect(uploader).toHaveBeenCalledTimes(1);
  });
});
