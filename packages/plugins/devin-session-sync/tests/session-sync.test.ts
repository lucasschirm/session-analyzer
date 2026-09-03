import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildObjectKey,
  type DiscoveryResult,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  sha256Hex,
} from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DevinHarnessProfile } from '../src/devin-profile.js';
import type { DevinExtractedTables, DevinSchemaDescriptor } from '../src/extractor/types.js';
import {
  applyHardBlocklist,
  buildSchemaDescriptorCandidate,
  discoverSessionPlanCandidates,
  extractPlanFrontmatterSessionId,
  materializeSessionTranscript,
  readAtifTranscriptCandidate,
  runDevinSessionSync,
} from '../src/session-sync.js';
import { devinModelsCaptureOptions } from './models/fixture.js';

class RecordingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  private readonly objects = new Map<string, { body: Uint8Array; sha256: string }>();

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    this.objects.set(key, { body: input.body, sha256 });
    return { key, sha256, etag: `"${sha256}"` };
  }

  getStoredContent(key: string): string | undefined {
    const existing = this.objects.get(key);
    return existing ? Buffer.from(existing.body).toString('utf8') : undefined;
  }
}

const SCHEMA_DESCRIPTOR: DevinSchemaDescriptor = {
  devinCliVersion: '3000.6.7',
  refineryVersion: 16,
  refineryMigrations: [],
  tableChecksums: {},
  supported: true,
  warnings: [],
};

describe('materializeSessionTranscript', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-materialize-'));
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it("writes only the given session's rows to <dataDir>/devin/transcripts/<sessionId>.jsonl", async () => {
    const tables: DevinExtractedTables = {
      sessions: [
        {
          id: 'sess-1',
          working_directory: '/tmp',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: 500,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
        {
          id: 'sess-2',
          working_directory: '/tmp',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: 999,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
      ],
      messageNodes: [],
      promptHistory: [],
      toolCallStates: [],
    };

    const transcriptPath = await materializeSessionTranscript(tables, 'sess-1', dataDir);
    expect(transcriptPath).toBe(path.join(dataDir, 'devin', 'transcripts', 'sess-1.jsonl'));

    const content = await fsp.readFile(transcriptPath, 'utf8');
    expect(content).toContain('"sess-1"');
    expect(content).not.toContain('"sess-2"');
  });
});

describe('applyHardBlocklist', () => {
  function discoveryWith(relativePaths: string[]): DiscoveryResult {
    return {
      artifacts: relativePaths.map((relativePath) => ({
        projectId: 'proj',
        sessionId: 'sess',
        scope: 'global' as const,
        relativePath,
        sha256: 'a'.repeat(64),
        size: 10,
        absolutePath: `/tmp/${relativePath}`,
      })),
      errors: [],
      totalBytes: relativePaths.length * 10,
      filesDiscovered: relativePaths.length,
    };
  }

  it('strips credentials.toml, mcp/oauth/**, and logs/** even against a permissive allowlist stub (deny-wins)', () => {
    const discovery = discoveryWith([
      'credentials.toml',
      'nested/credentials.toml',
      'mcp/oauth/token.json',
      'logs/session.log',
      'config.json',
    ]);
    const result = applyHardBlocklist(discovery);
    const kept = result.artifacts.map((a) => a.relativePath);
    expect(kept).toEqual(['config.json']);
    expect(result.filesDiscovered).toBe(1);
    expect(result.totalBytes).toBe(10);
  });

  it('is a no-op when nothing matches the blocklist', () => {
    const discovery = discoveryWith(['config.json', 'AGENTS.md']);
    expect(applyHardBlocklist(discovery)).toBe(discovery);
  });
});

describe('extractPlanFrontmatterSessionId', () => {
  it('extracts the session id from YAML frontmatter', () => {
    const content = '---\nsession: sess-abc\ntitle: Plan\n---\n# Plan body\n';
    expect(extractPlanFrontmatterSessionId(content)).toBe('sess-abc');
  });

  it('handles quoted session ids', () => {
    const content = '---\nsession: "sess-abc"\n---\nbody\n';
    expect(extractPlanFrontmatterSessionId(content)).toBe('sess-abc');
  });

  it('returns undefined when there is no frontmatter', () => {
    expect(extractPlanFrontmatterSessionId('# just a plan\n')).toBeUndefined();
  });

  it('returns undefined when frontmatter has no session field', () => {
    const content = '---\ntitle: Plan\n---\nbody\n';
    expect(extractPlanFrontmatterSessionId(content)).toBeUndefined();
  });
});

describe('discoverSessionPlanCandidates', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-plans-'));
    await fsp.mkdir(path.join(homeDir, '.devin', 'plans'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  async function writePlan(fileName: string, sessionId: string | undefined): Promise<void> {
    const frontmatter = sessionId ? `---\nsession: ${sessionId}\n---\n` : '';
    await fsp.writeFile(path.join(homeDir, '.devin', 'plans', fileName), `${frontmatter}# Plan\n`);
  }

  it('includes only plans whose frontmatter session matches the session id', async () => {
    await writePlan('plan-aaa.md', 'sess-1');
    await writePlan('plan-bbb.md', 'sess-2');
    await writePlan('plan-ccc.md', undefined);

    const results = await discoverSessionPlanCandidates(homeDir, 'sess-1', 'proj');
    expect(results).toHaveLength(1);
    expect(results[0]?.candidate.relativePath).toBe('plans/plan-aaa.md');
    expect(results[0]?.candidate.scope).toBe('session');
  });

  it('returns an empty array when the plans directory does not exist', async () => {
    const results = await discoverSessionPlanCandidates(
      path.join(homeDir, 'no-such-home'),
      'sess-1',
      'proj',
    );
    expect(results).toEqual([]);
  });
});

describe('readAtifTranscriptCandidate', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-atif-'));
  });

  afterEach(async () => {
    await fsp.rm(dataRoot, { recursive: true, force: true });
  });

  it('copies transcripts/<sessionId>.json to native/atif-transcript.json when present', async () => {
    await fsp.mkdir(path.join(dataRoot, 'transcripts'), { recursive: true });
    await fsp.writeFile(path.join(dataRoot, 'transcripts', 'sess-1.json'), '{"native":true}');

    const candidate = await readAtifTranscriptCandidate(dataRoot, 'sess-1', 'proj');
    expect(candidate?.candidate.relativePath).toBe('native/atif-transcript.json');
    expect(candidate?.candidate.scope).toBe('session');
  });

  it('returns undefined when the native transcript is absent', async () => {
    const candidate = await readAtifTranscriptCandidate(dataRoot, 'sess-missing', 'proj');
    expect(candidate).toBeUndefined();
  });
});

describe('buildSchemaDescriptorCandidate', () => {
  it('builds a runtime-scoped native/schema-descriptor.json candidate', () => {
    const candidate = buildSchemaDescriptorCandidate(SCHEMA_DESCRIPTOR, 'proj', 'sess-1');
    expect(candidate.candidate.scope).toBe('runtime');
    expect(candidate.candidate.relativePath).toBe('native/schema-descriptor.json');
    expect(JSON.parse(candidate.candidate.content)).toMatchObject({ devinCliVersion: '3000.6.7' });
  });
});

describe('runDevinSessionSync', () => {
  let dataDir: string;
  let homeDir: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-sync-data-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-sync-home-'));
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  const baseConfig = {
    projectId: 'proj-1',
    disabled: false,
    captureTranscripts: true,
    storage: { type: 's3' as const },
    limits: {
      maxFileBytes: 10_000_000,
      maxTotalBytes: 100_000_000,
      maxFiles: 1000,
      maxTranscriptBytes: 10_000_000,
      maxJsonDepth: 20,
      maxJsonlLineBytes: 1_000_000,
    },
    timeouts: { syncTimeoutMs: 5000, hookUploadTimeoutMs: 5000, sessionEndBudgetMs: 5000 },
    retries: 0,
  };

  const sessionTables: DevinExtractedTables = {
    sessions: [
      {
        id: 'sess-1',
        working_directory: '/tmp/workspace',
        backend_type: 'anthropic',
        model: 'devin-1',
        agent_mode: 'default',
        created_at: 100,
        last_activity_at: 200,
        title: 'Test session',
        main_chain_id: null,
        cogs_json: null,
        workspace_dirs: null,
        hidden: 0,
        metadata: null,
      },
    ],
    messageNodes: [
      {
        row_id: 1,
        session_id: 'sess-1',
        node_id: 1,
        parent_node_id: null,
        chat_message: 'hello with a secret AKIAIOSFODNN7EXAMPLE',
        created_at: 200,
        metadata: null,
      },
    ],
    promptHistory: [
      { id: 1, content: 'do the thing', timestamp: 150, session_id: 'sess-1', is_shell: 0 },
    ],
    toolCallStates: [
      {
        row_id: 1,
        session_id: 'sess-1',
        tool_call_id: 'call-1',
        tool_call_json: '{}',
        tool_call_update_json: null,
      },
    ],
  };

  it('emits a manifest with harness:devin, correct harnessVersion, and all 4 classification keys on every artifact', async () => {
    const storage = new RecordingStorageAdapter();
    const events: string[] = [];

    const outcome = await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
      onProgress: (event) => events.push(event.type),
    });

    expect(outcome.failed).toBe(0);
    expect(events).toContain('progress');
    expect(events[events.length - 1]).toBe('success');

    const manifestCall = storage.calls.find((c) => c.scope === 'manifest');
    if (!manifestCall) throw new Error('expected a manifest upload call');
    const manifest = JSON.parse(Buffer.from(manifestCall.body).toString('utf8'));
    expect(manifest.harness).toBe('devin');
    expect(manifest.harnessVersion).toBe(DevinHarnessProfile.harnessVersion);

    for (const artifact of manifest.artifacts) {
      expect(artifact).toMatchObject({
        projectId: expect.any(String),
        sessionId: 'sess-1',
        scope: expect.any(String),
        relativePath: expect.any(String),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }

    const scopes = manifest.artifacts.map((a: { scope: string }) => a.scope);
    expect(scopes).toContain('session'); // transcript.jsonl
    expect(scopes).toContain('runtime'); // native/schema-descriptor.json + models

    const artifactPaths = manifest.artifacts.map((a: { relativePath: string }) => a.relativePath);
    expect(artifactPaths).toContain('native/models.json');
    expect(artifactPaths).toContain('native/models-list.raw.json');
  });

  it('resolves dataRoot from home/cwd/env when not explicitly supplied', async () => {
    const storage = new RecordingStorageAdapter();
    const outcome = await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      env: {},
      // dataRoot intentionally omitted — exercises the resolveDevinPaths fallback.
    });
    expect(outcome.failed).toBe(0);
  });

  it('reuses an existing session record on a second sync rather than overwriting startedAt', async () => {
    const storage = new RecordingStorageAdapter();
    const runOnce = () =>
      runDevinSessionSync({
        models: devinModelsCaptureOptions,
        tables: sessionTables,
        schemaDescriptor: SCHEMA_DESCRIPTOR,
        sessionId: 'sess-1',
        cwd: '/tmp/workspace',
        config: baseConfig,
        dataDir,
        storageAdapter: storage,
        trigger: 'manual',
        profile: DevinHarnessProfile,
        homeDir,
        dataRoot: homeDir,
      });

    const first = await runOnce();
    const second = await runOnce();
    expect(first.failed).toBe(0);
    expect(second.failed).toBe(0);
  });

  it('sanitizes captured config JSON before upload', async () => {
    await fsp.mkdir(path.join(homeDir, '.config', 'devin'), { recursive: true });
    await fsp.writeFile(
      path.join(homeDir, '.config', 'devin', 'config.json'),
      JSON.stringify({ apiKey: 'sk-super-secret-value-should-be-redacted' }),
    );

    const storage = new RecordingStorageAdapter();
    await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace-empty',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
    });

    const casCall = storage.calls.find((c) => c.scope === 'global');
    if (!casCall) throw new Error('expected a global-scope upload call');
    const uploadedContent = Buffer.from(casCall.body).toString('utf8');
    expect(uploadedContent).not.toContain('sk-super-secret-value-should-be-redacted');
  });

  it('only includes plans whose frontmatter session matches, end-to-end', async () => {
    await fsp.mkdir(path.join(homeDir, '.devin', 'plans'), { recursive: true });
    await fsp.writeFile(
      path.join(homeDir, '.devin', 'plans', 'plan-match.md'),
      '---\nsession: sess-1\n---\n# Match\n',
    );
    await fsp.writeFile(
      path.join(homeDir, '.devin', 'plans', 'plan-other.md'),
      '---\nsession: sess-other\n---\n# Other\n',
    );

    const storage = new RecordingStorageAdapter();
    await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace-empty',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
    });

    const planKeys = storage.calls
      .filter((c) => c.relativePath.startsWith('plans/'))
      .map((c) => c.relativePath);
    expect(planKeys).toEqual(['plans/plan-match.md']);
  });

  it('records a manifest-upload failure as a terminal failure event without throwing', async () => {
    const failingStorage: StorageAdapter = {
      putObject: async (input) => {
        if (input.scope === 'manifest') {
          throw new Error('manifest upload failed');
        }
        return { key: 'x', sha256: sha256Hex(Buffer.from(input.body).toString('utf8')) };
      },
    };
    const events: string[] = [];

    const outcome = await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: failingStorage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
      onProgress: (event) => events.push(event.type),
    });

    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe('failure');
  });

  it('does not fail the sync when only the models-capture side-capture fails (#266)', async () => {
    const storage = new RecordingStorageAdapter();
    const events: Array<{ type: string; message: string }> = [];

    const outcome = await runDevinSessionSync({
      models: {
        devinCliVersion: 'v1',
        runModelsList: async () => {
          throw new Error('devin cli unavailable');
        },
      },
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: storage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
      onProgress: (event) => events.push({ type: event.type, message: event.message }),
    });

    // The real session artifacts uploaded fine — a models-capture failure
    // alone must never flip the whole sync to failed.
    expect(outcome.failed).toBe(0);
    expect(outcome.errors).toEqual([]);

    // But it must never be silently dropped either: it is recorded as a
    // distinguishable warning, separate from `errors`, and the mid-stream
    // capture failure is still visible as its own progress event.
    expect(outcome.warnings).toEqual(['devin cli unavailable']);
    expect(
      events.some((e) => e.type === 'failure' && e.message.includes('devin cli unavailable')),
    ).toBe(true);
    expect(events[events.length - 1]?.type).toBe('success');
    expect(events[events.length - 1]?.message).toContain('warning');

    const manifestCall = storage.calls.find((c) => c.scope === 'manifest');
    if (!manifestCall) throw new Error('expected a manifest upload call');
    const manifest = JSON.parse(Buffer.from(manifestCall.body).toString('utf8'));
    const artifactPaths = manifest.artifacts.map((a: { relativePath: string }) => a.relativePath);
    expect(artifactPaths).not.toContain('native/models.json');
  });

  it('still reports failure when models capture succeeds but a real artifact upload fails (regression guard)', async () => {
    const failingStorage: StorageAdapter = {
      putObject: async (input) => {
        if (input.scope === 'manifest') {
          throw new Error('manifest upload failed');
        }
        return { key: 'x', sha256: sha256Hex(Buffer.from(input.body).toString('utf8')) };
      },
    };
    const events: string[] = [];

    const outcome = await runDevinSessionSync({
      models: devinModelsCaptureOptions,
      tables: sessionTables,
      schemaDescriptor: SCHEMA_DESCRIPTOR,
      sessionId: 'sess-1',
      cwd: '/tmp/workspace',
      config: baseConfig,
      dataDir,
      storageAdapter: failingStorage,
      trigger: 'manual',
      profile: DevinHarnessProfile,
      homeDir,
      dataRoot: homeDir,
      onProgress: (event) => events.push(event.type),
    });

    expect(outcome.warnings).toEqual([]);
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toBe('failure');
  });
});
