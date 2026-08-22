import type { ManifestArtifact } from '@lucasschirm/sal-sync-core';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { DbClient } from '../../src/db/db-client';
import {
  createFileProcessingBridge,
  type DownloadedFile,
} from '../../src/sync/file-processing-bridge';
import type {
  DashboardSession,
  ModelTokenUsage,
  ParsedSession,
  SyncManifest,
  ToolExecution,
} from '../../src/types';
import type { ParseFileOptions, parseInWorker } from '../../src/workers/parser-client';

function makeDashboardSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 'session-1',
    project_id: 'project-1',
    source: 'claude',
    title: 'test.jsonl',
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_060_000,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_tokens: 20,
    cache_read_tokens: 10,
    total_tokens: 180,
    models: [] as ModelTokenUsage[],
    context_compactions: 0,
    total_turns: 1,
    files_read: 0,
    files_written: 0,
    agent_invocations: 0,
    tool_executions: [] as ToolExecution[],
    events: [],
    messages: [],
    tasks: [],
    subagents: [],
    ...overrides,
  };
}

function makeParsedSession(session: DashboardSession): ParsedSession {
  return { session, parseErrors: [] };
}

function makeSyncManifest(overrides: Partial<SyncManifest> = {}): SyncManifest {
  return {
    sessionId: 'remote-sess',
    schemaVersion: 1,
    artifacts: [] as unknown[],
    syncRuns: [] as unknown[],
    ...overrides,
  };
}

function makeArtifact(relativePath: string): ManifestArtifact {
  return {
    projectId: 'remote-proj',
    sessionId: 'remote-sess',
    scope: 'session',
    relativePath,
    sha256: 'sha',
    size: 100,
    status: 'uploaded',
  };
}

function makeDownloadedFile(path: string, text: string): DownloadedFile {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    hash: 'sha',
    size: bytes.length,
    content: bytes.buffer as ArrayBuffer,
  };
}

interface MockCalls {
  getSession: ReturnType<typeof vi.fn>;
  getSessionSyncManifest: ReturnType<typeof vi.fn>;
  upsertSessionByExternalId: ReturnType<typeof vi.fn>;
  replaceSession: ReturnType<typeof vi.fn>;
  updateSessionManifest: ReturnType<typeof vi.fn>;
  setSessionSyncStatus: ReturnType<typeof vi.fn>;
  upsertSessionFile: ReturnType<typeof vi.fn>;
}

function makeDbClient(calls: MockCalls, manifest: SyncManifest | null = null): DbClient {
  calls.getSession.mockResolvedValue(makeDashboardSession());
  calls.getSessionSyncManifest.mockResolvedValue(manifest);
  calls.upsertSessionByExternalId.mockResolvedValue('session-1');
  calls.replaceSession.mockResolvedValue(undefined);
  calls.updateSessionManifest.mockResolvedValue(undefined);
  calls.setSessionSyncStatus.mockResolvedValue(undefined);
  calls.upsertSessionFile.mockResolvedValue(undefined);

  return {
    getSession: calls.getSession,
    getSessionSyncManifest: calls.getSessionSyncManifest,
    upsertSessionByExternalId: calls.upsertSessionByExternalId,
    replaceSession: calls.replaceSession,
    updateSessionManifest: calls.updateSessionManifest,
    setSessionSyncStatus: calls.setSessionSyncStatus,
    upsertSessionFile: calls.upsertSessionFile,
  } as unknown as DbClient;
}

describe('FileProcessingBridge', () => {
  let dbClient: DbClient;
  let parse: Mock<
    (payload: string | ArrayBuffer, options: ParseFileOptions) => Promise<ParsedSession>
  >;
  let onFileDownloaded: (sessionId: string, file: DownloadedFile) => Promise<void>;
  let onSyncComplete: (sessionId: string) => Promise<void>;
  let calls: MockCalls;

  beforeEach(() => {
    calls = {
      getSession: vi.fn(),
      getSessionSyncManifest: vi.fn(),
      upsertSessionByExternalId: vi.fn(),
      replaceSession: vi.fn(),
      updateSessionManifest: vi.fn(),
      setSessionSyncStatus: vi.fn(),
      upsertSessionFile: vi.fn(),
    };
    parse = vi.fn() as Mock<
      (payload: string | ArrayBuffer, options: ParseFileOptions) => Promise<ParsedSession>
    >;
  });

  function createBridge(manifest: SyncManifest | null = null) {
    dbClient = makeDbClient(calls, manifest);
    const bridge = createFileProcessingBridge(dbClient, parse as unknown as typeof parseInWorker);
    onFileDownloaded = bridge.onFileDownloaded;
    onSyncComplete = bridge.onSyncComplete;
  }

  it('parses the main transcript and upserts the session, reapplying sync columns', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    parse.mockResolvedValue(makeParsedSession(main));
    createBridge(makeSyncManifest());

    const file = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', file);

    expect(parse).toHaveBeenCalledWith(file.content, {
      projectId: 'project-1',
      title: 'remote-sess',
    });
    expect(calls.upsertSessionByExternalId).toHaveBeenCalledWith(main);
    expect(calls.updateSessionManifest).toHaveBeenCalledWith('session-1', expect.anything());
    expect(calls.setSessionSyncStatus).toHaveBeenCalledWith('session-1', 'processing');
  });

  it('uses the file path as title when no sync manifest is present', async () => {
    const main = makeDashboardSession();
    parse.mockResolvedValue(makeParsedSession(main));
    createBridge(null);

    const file = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', file);

    expect(parse).toHaveBeenCalledWith(file.content, {
      projectId: 'project-1',
      title: 'session/transcript.jsonl',
    });
  });

  it('merges a subagent jsonl-only group into the parent session', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 40,
      output_tokens: 20,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 60,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(makeSyncManifest({ artifacts: [makeArtifact('subagents/agent-1.jsonl')] }));

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const file = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    await onFileDownloaded('session-1', file);

    expect(parse).toHaveBeenCalledWith(file.content, { projectId: 'project-1' });
    expect(calls.replaceSession).toHaveBeenCalledTimes(1);

    const replaced = calls.replaceSession.mock.calls[0][0] as DashboardSession;
    expect(replaced.subagents).toHaveLength(1);
    expect(replaced.subagents[0].agent_id).toBe('1');
    expect(replaced.total_tokens).toBe(240);

    expect(calls.updateSessionManifest).toHaveBeenCalledWith('session-1', expect.anything());
    expect(calls.setSessionSyncStatus).toHaveBeenCalledWith('session-1', 'processing');
  });

  it('groups sidecar-first then jsonl into a single merge', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(
      makeSyncManifest({
        artifacts: [
          makeArtifact('subagents/agent-1.jsonl'),
          makeArtifact('subagents/agent-1.meta.json'),
        ],
      }),
    );

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const sidecar = makeDownloadedFile(
      'session/subagents/agent-1.meta.json',
      '{"agentType":"Research"}',
    );
    const sidecarPromise = onFileDownloaded('session-1', sidecar);

    await Promise.resolve();
    expect(calls.replaceSession).not.toHaveBeenCalled();

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    const jsonlPromise = onFileDownloaded('session-1', jsonl);

    await Promise.all([sidecarPromise, jsonlPromise]);

    expect(parse).toHaveBeenCalledTimes(2);
    expect(calls.replaceSession).toHaveBeenCalledTimes(1);
    const replaced = calls.replaceSession.mock.calls[0][0] as DashboardSession;
    expect(replaced.subagents[0].agent_type).toBe('Research');
  });

  it('groups jsonl-first then sidecar into a single merge', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(
      makeSyncManifest({
        artifacts: [
          makeArtifact('subagents/agent-1.jsonl'),
          makeArtifact('subagents/agent-1.meta.json'),
        ],
      }),
    );

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    const jsonlPromise = onFileDownloaded('session-1', jsonl);

    await Promise.resolve();
    expect(calls.replaceSession).not.toHaveBeenCalled();

    const sidecar = makeDownloadedFile(
      'session/subagents/agent-1.meta.json',
      '{"agentType":"Coder"}',
    );
    const sidecarPromise = onFileDownloaded('session-1', sidecar);

    await Promise.all([jsonlPromise, sidecarPromise]);

    expect(calls.replaceSession).toHaveBeenCalledTimes(1);
    const replaced = calls.replaceSession.mock.calls[0][0] as DashboardSession;
    expect(replaced.subagents[0].agent_type).toBe('Coder');
  });

  it('merges multiple agents with separate replaceSession calls', async () => {
    parse.mockImplementation(async (_, options) => {
      if (options.title) return makeParsedSession(makeDashboardSession());
      return makeParsedSession(
        makeDashboardSession({
          id: 'sub-1',
          title: 'agent-1.jsonl',
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 15,
        }),
      );
    });
    createBridge(makeSyncManifest({ artifacts: [makeArtifact('subagents/agent-1.jsonl')] }));

    const main = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', main);

    const sub1 = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent-1');
    const sub2 = makeDownloadedFile('session/subagents/agent-2.jsonl', 'subagent-2');
    await Promise.all([onFileDownloaded('session-1', sub1), onFileDownloaded('session-1', sub2)]);

    expect(calls.replaceSession).toHaveBeenCalledTimes(2);
    expect(calls.updateSessionManifest).toHaveBeenCalledTimes(3);
  });

  it('does not dispatch sidecar buffers to the transcript parser', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(makeSyncManifest({ artifacts: [makeArtifact('subagents/agent-1.meta.json')] }));

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const sidecar = makeDownloadedFile('session/subagents/agent-1.meta.json', '{}');
    const promise = onFileDownloaded('session-1', sidecar);

    await Promise.resolve();
    expect(parse).toHaveBeenCalledTimes(1);

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    await onFileDownloaded('session-1', jsonl);
    await promise;

    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('waits for the main transcript before merging a subagent that arrives first', async () => {
    let resolveUpsert: (value: string) => void = () => undefined;
    calls.upsertSessionByExternalId.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveUpsert = resolve;
      }),
    );
    parse.mockImplementation(async (_, options) => {
      if (options.title) return makeParsedSession(makeDashboardSession());
      return makeParsedSession(
        makeDashboardSession({
          id: 'sub-1',
          title: 'agent-1.jsonl',
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 15,
        }),
      );
    });
    createBridge(makeSyncManifest({ artifacts: [makeArtifact('subagents/agent-1.jsonl')] }));

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    const jsonlPromise = onFileDownloaded('session-1', jsonl);

    await Promise.resolve();
    expect(calls.replaceSession).not.toHaveBeenCalled();

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    const mainPromise = onFileDownloaded('session-1', mainFile);
    await Promise.resolve();
    resolveUpsert('session-1');

    await mainPromise;
    await jsonlPromise;
    expect(calls.replaceSession).toHaveBeenCalledTimes(1);
  });

  it('force-completes a subagent group when an expected sidecar is unchanged and never downloaded', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(
      makeSyncManifest({
        artifacts: [
          makeArtifact('subagents/agent-1.jsonl'),
          makeArtifact('subagents/agent-1.meta.json'),
        ],
      }),
    );

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    const jsonlPromise = onFileDownloaded('session-1', jsonl);

    await Promise.resolve();
    expect(calls.replaceSession).not.toHaveBeenCalled();

    await onSyncComplete('session-1');
    await jsonlPromise;

    expect(calls.replaceSession).toHaveBeenCalledTimes(1);
    const replaced = calls.replaceSession.mock.calls[0][0] as DashboardSession;
    expect(replaced.subagents).toHaveLength(1);
    expect(replaced.subagents[0].agent_id).toBe('1');
    expect(replaced.subagents[0].agent_type).toBeUndefined();
  });

  it('rejects the subagent download promise when a forced merge fails', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(
      makeSyncManifest({
        artifacts: [
          makeArtifact('subagents/agent-1.jsonl'),
          makeArtifact('subagents/agent-1.meta.json'),
        ],
      }),
    );
    calls.replaceSession.mockRejectedValue(new Error('replace failed'));

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    const jsonlPromise = onFileDownloaded('session-1', jsonl);

    await Promise.resolve();
    expect(calls.replaceSession).not.toHaveBeenCalled();

    await onSyncComplete('session-1');
    await expect(jsonlPromise).rejects.toThrow('replace failed');
    expect(calls.replaceSession).toHaveBeenCalledTimes(1);
  });

  it('continues merging the next subagent group when the first merge fails', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent1 = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    const subagent2 = makeDashboardSession({
      id: 'sub-2',
      project_id: 'project-1',
      title: 'agent-2.jsonl',
      input_tokens: 20,
      output_tokens: 10,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 30,
    });
    parse.mockImplementation(async (payload, options) => {
      if (options.title) return makeParsedSession(main);
      const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
      return text === 'subagent-2' ? makeParsedSession(subagent2) : makeParsedSession(subagent1);
    });
    createBridge(
      makeSyncManifest({
        artifacts: [
          makeArtifact('subagents/agent-1.jsonl'),
          makeArtifact('subagents/agent-2.jsonl'),
        ],
      }),
    );
    calls.replaceSession.mockRejectedValueOnce(new Error('replace failed'));

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const jsonl1 = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent-1');
    const jsonl2 = makeDownloadedFile('session/subagents/agent-2.jsonl', 'subagent-2');
    const jsonl1Promise = onFileDownloaded('session-1', jsonl1);
    const jsonl2Promise = onFileDownloaded('session-1', jsonl2);

    await expect(jsonl1Promise).rejects.toThrow('replace failed');
    await expect(jsonl2Promise).resolves.toBeUndefined();
    expect(calls.replaceSession).toHaveBeenCalledTimes(2);
  });

  it('updates internal session id tracking to the id returned by upsertSessionByExternalId', async () => {
    const main = makeDashboardSession({
      id: 'session-1',
      external_id: 'remote-sess',
    });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(makeSyncManifest({ artifacts: [makeArtifact('subagents/agent-1.jsonl')] }));
    calls.upsertSessionByExternalId.mockResolvedValue('new-session-id');
    calls.getSession.mockImplementation((id: string) =>
      makeDashboardSession({ id, external_id: 'remote-sess' }),
    );

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    await onFileDownloaded('session-1', jsonl);

    expect(calls.getSession).toHaveBeenCalledWith('new-session-id');
    expect(calls.replaceSession).toHaveBeenCalledTimes(1);
    const replaced = calls.replaceSession.mock.calls[0][0] as DashboardSession;
    expect(replaced.id).toBe('new-session-id');
    expect(calls.updateSessionManifest).toHaveBeenCalledWith('new-session-id', expect.anything());
    expect(calls.setSessionSyncStatus).toHaveBeenCalledWith('new-session-id', 'processing');
  });

  it('upserts session_files records as processed for the main transcript and subagent files', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(
      makeSyncManifest({
        artifacts: [
          makeArtifact('subagents/agent-1.jsonl'),
          makeArtifact('subagents/agent-1.meta.json'),
        ],
      }),
    );

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);
    expect(calls.upsertSessionFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'session/transcript.jsonl',
        scope: 'session',
        status: 'processed',
      }),
    );

    const sidecar = makeDownloadedFile(
      'session/subagents/agent-1.meta.json',
      '{"agentType":"Research"}',
    );
    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    await Promise.all([
      onFileDownloaded('session-1', sidecar),
      onFileDownloaded('session-1', jsonl),
    ]);

    expect(calls.upsertSessionFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'session/subagents/agent-1.jsonl',
        scope: 'session',
        status: 'processed',
      }),
    );
    expect(calls.upsertSessionFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'session/subagents/agent-1.meta.json',
        scope: 'session',
        status: 'processed',
      }),
    );
  });

  it('force-completes a meta-only group when the jsonl sidecar is unchanged and never downloaded', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(
      makeSyncManifest({
        artifacts: [
          makeArtifact('subagents/agent-1.jsonl'),
          makeArtifact('subagents/agent-1.meta.json'),
        ],
      }),
    );

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const sidecar = makeDownloadedFile(
      'session/subagents/agent-1.meta.json',
      '{"agentType":"Research"}',
    );
    const sidecarPromise = onFileDownloaded('session-1', sidecar);

    await Promise.resolve();
    expect(calls.replaceSession).not.toHaveBeenCalled();

    await onSyncComplete('session-1');
    await sidecarPromise;

    expect(calls.replaceSession).not.toHaveBeenCalled();
    expect(calls.upsertSessionFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'session/subagents/agent-1.meta.json',
        scope: 'session',
        status: 'processed',
      }),
    );
  });

  it('completes a subagent group whose parse is still in flight when sync completes', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    let resolveSubagent: (value: ParsedSession) => void = () => undefined;
    const subagentDeferred = new Promise<ParsedSession>((resolve) => {
      resolveSubagent = resolve;
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : subagentDeferred,
    );
    createBridge(makeSyncManifest({ artifacts: [makeArtifact('subagents/agent-1.jsonl')] }));

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await onFileDownloaded('session-1', mainFile);

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    const jsonlPromise = onFileDownloaded('session-1', jsonl);

    await Promise.resolve();
    expect(calls.replaceSession).not.toHaveBeenCalled();

    const syncCompletePromise = onSyncComplete('session-1');
    await Promise.resolve();
    expect(calls.replaceSession).not.toHaveBeenCalled();

    resolveSubagent(makeParsedSession(subagent));
    await syncCompletePromise;
    await jsonlPromise;

    expect(calls.replaceSession).toHaveBeenCalledTimes(1);
    const replaced = calls.replaceSession.mock.calls[0][0] as DashboardSession;
    expect(replaced.subagents).toHaveLength(1);
  });

  it('does not hang on a subagent dispatch after the main transcript opQueue work rejects', async () => {
    const main = makeDashboardSession({ id: 'session-1', external_id: 'remote-sess' });
    const subagent = makeDashboardSession({
      id: 'sub-1',
      project_id: 'project-1',
      title: 'agent-1.jsonl',
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
    });
    parse.mockImplementation(async (_, options) =>
      options.title ? makeParsedSession(main) : makeParsedSession(subagent),
    );
    createBridge(makeSyncManifest({ artifacts: [makeArtifact('subagents/agent-1.jsonl')] }));
    calls.upsertSessionByExternalId.mockRejectedValue(new Error('main upsert failed'));

    const mainFile = makeDownloadedFile('session/transcript.jsonl', 'main');
    await expect(onFileDownloaded('session-1', mainFile)).rejects.toThrow('main upsert failed');

    const jsonl = makeDownloadedFile('session/subagents/agent-1.jsonl', 'subagent');
    const jsonlPromise = onFileDownloaded('session-1', jsonl);

    await expect(jsonlPromise).rejects.toThrow('main upsert failed');
  });
});
