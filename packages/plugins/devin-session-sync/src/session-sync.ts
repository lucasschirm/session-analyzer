/**
 * Core per-session sync pipeline shared by every entry point in this plugin
 * (`hook.ts`, `session-start.ts`, `session-end.ts`, `cli/sync-command.ts`,
 * `watcher.ts`). Centralizing this logic (rather than delegating to the
 * generic engine's `capture`/`sessionStart`/`sessionEnd` the way
 * `claude-session-sync` does) is necessary because Devin's session content
 * does not exist as an on-disk transcript file the way Claude's does — it
 * must be extracted from `sessions.db` and materialized before the generic
 * discovery pipeline (which reads an existing file at `transcript_path`) can
 * run, and because Devin's manifest artifact set includes types (session
 * plans, the native ATIF transcript copy, the schema descriptor) the generic
 * `discover()` allowlist mechanism cannot express (see `devin-profile.ts`'s
 * doc comments on why `~/.devin/plans/**` is handled here instead of via
 * `captureAllowlist.global`).
 *
 * Scoping decision: every sync pass reads `sessions.db` in full (via
 * `devin-snapshot.ts`'s `EMPTY_WATERMARKS` read), not incrementally against
 * the extractor's watermark mechanism. This is simpler and always correct —
 * content-hash dedup in `processDelta` means a full re-extraction that
 * produces byte-identical output is skipped, not re-uploaded — at the cost
 * of re-reading the whole database on every sync rather than only new rows.
 * Wiring true incremental extraction (persisting `DevinWatermarks` per
 * session in `StateStore`) is a documented follow-up, not required by this
 * issue's acceptance criteria.
 */
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  type ArtifactScope,
  buildCandidates,
  buildManifestArtifactsFromResults,
  buildUploader,
  type CandidateResult,
  type DiscoveryResult,
  discover,
  type HarnessProfile,
  hashCandidate,
  processDelta,
  recordAndUploadManifest,
  resolveStorageError,
  type SessionData,
  StateStore,
  type StorageAdapter,
  type SyncConfig,
  type SyncTrigger,
} from '@lucasschirm/sal-sync';

import { DEVIN_HARD_BLOCKLIST_PATTERNS, DevinHarnessProfile } from './devin-profile.js';
import { buildDevinJsonl } from './extractor/jsonl-writer.js';
import { resolveDevinPaths } from './extractor/paths.js';
import type { DevinExtractedTables, DevinSchemaDescriptor } from './extractor/types.js';

export interface DevinSyncProgressEvent {
  type: 'progress' | 'success' | 'failure';
  timestamp: string;
  sessionId: string;
  message: string;
}

export interface DevinSessionSyncOptions {
  tables: DevinExtractedTables;
  schemaDescriptor: DevinSchemaDescriptor;
  sessionId: string;
  /** The session's `working_directory`, used as the workspace discovery root. */
  cwd: string;
  config: SyncConfig;
  dataDir: string;
  storageAdapter: StorageAdapter;
  trigger: SyncTrigger;
  profile?: HarnessProfile;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** Devin CLI's own XDG data root (holds `transcripts/<id>.json`); resolved automatically if omitted. */
  dataRoot?: string;
  onProgress?: (event: DevinSyncProgressEvent) => void;
}

export interface DevinSessionSyncOutcome {
  sessionId: string;
  uploaded: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function emitProgress(
  options: DevinSessionSyncOptions,
  type: DevinSyncProgressEvent['type'],
  message: string,
): void {
  options.onProgress?.({
    type,
    timestamp: new Date().toISOString(),
    sessionId: options.sessionId,
    message,
  });
}

function summarizeOutcome(outcome: DevinSessionSyncOutcome): string {
  const parts: string[] = [];
  if (outcome.uploaded > 0) parts.push(`${outcome.uploaded} uploaded`);
  if (outcome.skipped > 0) parts.push(`${outcome.skipped} skipped`);
  if (outcome.failed > 0) parts.push(`${outcome.failed} failed`);
  return `session ${outcome.sessionId}: ${parts.length > 0 ? parts.join(', ') : 'no changes'}`;
}

// ---------------------------------------------------------------------------
// Transcript materialization
// ---------------------------------------------------------------------------

function filterTablesForSession(
  tables: DevinExtractedTables,
  sessionId: string,
): DevinExtractedTables {
  return {
    sessions: tables.sessions.filter((s) => s.id === sessionId),
    messageNodes: tables.messageNodes.filter((m) => m.session_id === sessionId),
    promptHistory: tables.promptHistory.filter((p) => p.session_id === sessionId),
    toolCallStates: tables.toolCallStates.filter((t) => t.session_id === sessionId),
  };
}

/**
 * Extracts one session's rows and writes them as `devin-session-jsonl/v1`
 * text to `<dataDir>/devin/transcripts/<sessionId>.jsonl`, returning the
 * path. The generic discovery pipeline (`discover()`/`runSessionDiscovery`)
 * requires an existing on-disk file at `transcriptPath` — Devin has no such
 * file natively, so this plugin creates one on every sync pass.
 */
export async function materializeSessionTranscript(
  tables: DevinExtractedTables,
  sessionId: string,
  dataDir: string,
): Promise<string> {
  const sessionTables = filterTablesForSession(tables, sessionId);
  const { text } = buildDevinJsonl(sessionTables);
  const transcriptPath = path.join(dataDir, 'devin', 'transcripts', `${sessionId}.jsonl`);
  await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fsp.writeFile(transcriptPath, text, 'utf8');
  return transcriptPath;
}

// ---------------------------------------------------------------------------
// Hard blocklist (defense-in-depth, independent of the capture allowlist)
// ---------------------------------------------------------------------------

function matchesHardBlocklist(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return DEVIN_HARD_BLOCKLIST_PATTERNS.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return normalized === pattern || normalized.endsWith(`/${pattern}`);
  });
}

/**
 * Actively strips any discovered artifact matching
 * {@link DEVIN_HARD_BLOCKLIST_PATTERNS} (`credentials.toml`, `mcp/oauth/**`,
 * `logs/**`) — enforced independent of the capture allowlist per Part A2 and
 * `.agents/rules/manifest-backed-classification.md`, so a future allowlist
 * broadening (e.g. a wider `**` glob) can never regress this.
 */
export function applyHardBlocklist(discovery: DiscoveryResult): DiscoveryResult {
  const blocked = discovery.artifacts.filter((a) => matchesHardBlocklist(a.relativePath));
  if (blocked.length === 0) return discovery;
  const blockedBytes = blocked.reduce((sum, a) => sum + a.size, 0);
  const kept = discovery.artifacts.filter((a) => !matchesHardBlocklist(a.relativePath));
  return {
    artifacts: kept,
    errors: discovery.errors,
    totalBytes: discovery.totalBytes - blockedBytes,
    filesDiscovered: kept.length,
  };
}

// ---------------------------------------------------------------------------
// Extra (non-discover()-based) session/runtime artifacts
// ---------------------------------------------------------------------------

function buildExtraCandidateResult(
  projectId: string,
  sessionId: string,
  scope: ArtifactScope,
  relativePath: string,
  content: string,
): CandidateResult {
  const hashed = hashCandidate({ projectId, sessionId, scope, relativePath, content });
  return {
    candidate: {
      projectId,
      sessionId,
      scope,
      relativePath,
      content: hashed.sanitized,
      sanitizer: (c) => c,
    },
    size: hashed.size,
    sha256: hashed.artifact.sha256,
  };
}

/** `session:` frontmatter value from a `~/.devin/plans/*.md` file, or `undefined`. */
export function extractPlanFrontmatterSessionId(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const line = (match[1] ?? '').split(/\r?\n/).find((l) => /^session:\s*/.test(l));
  if (!line) return undefined;
  return line
    .replace(/^session:\s*/, '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

async function readPlanFiles(
  plansDir: string,
): Promise<Array<{ fileName: string; content: string }>> {
  let entries: string[];
  try {
    entries = await fsp.readdir(plansDir);
  } catch {
    return [];
  }
  const files: Array<{ fileName: string; content: string }> = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    try {
      files.push({
        fileName: name,
        content: await fsp.readFile(path.join(plansDir, name), 'utf8'),
      });
    } catch {
      // Unreadable file; skip rather than fail the whole sync.
    }
  }
  return files;
}

/**
 * Session-linked plan capture (Part B2/B3): only `~/.devin/plans/*.md`
 * entries whose frontmatter `session:` matches `sessionId` are included,
 * uploaded as `session`-scoped artifacts at `plans/<fileName>`.
 */
export async function discoverSessionPlanCandidates(
  homeDir: string,
  sessionId: string,
  projectId: string,
): Promise<CandidateResult[]> {
  const files = await readPlanFiles(path.join(homeDir, '.devin', 'plans'));
  const matching = files.filter((f) => extractPlanFrontmatterSessionId(f.content) === sessionId);
  return matching.map((f) =>
    buildExtraCandidateResult(projectId, sessionId, 'session', `plans/${f.fileName}`, f.content),
  );
}

/** Direct copy of Devin's own `transcripts/<sessionId>.json` (Part B3), when present. */
export async function readAtifTranscriptCandidate(
  dataRoot: string,
  sessionId: string,
  projectId: string,
): Promise<CandidateResult | undefined> {
  const filePath = path.join(dataRoot, 'transcripts', `${sessionId}.json`);
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
  return buildExtraCandidateResult(
    projectId,
    sessionId,
    'session',
    'native/atif-transcript.json',
    content,
  );
}

/**
 * `native/schema-descriptor.json` (`runtime` scope): the DS-F2 (#157) schema
 * descriptor, attached to every session synced under the schema it was
 * observed against.
 *
 * `native/models.json` / `native/models-list.raw.json` are reserved runtime
 * manifest slots (Part B3) populated by DS-F4 (#153) — deliberately not
 * emitted here so DS-F4 does not require another manifest-shape revision.
 */
export function buildSchemaDescriptorCandidate(
  descriptor: DevinSchemaDescriptor,
  projectId: string,
  sessionId: string,
): CandidateResult {
  const content = JSON.stringify(descriptor, null, 2);
  return buildExtraCandidateResult(
    projectId,
    sessionId,
    'runtime',
    'native/schema-descriptor.json',
    content,
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function resolveDataRoot(options: DevinSessionSyncOptions, homeDir: string): string {
  if (options.dataRoot) return options.dataRoot;
  const env = options.env ?? process.env;
  return resolveDevinPaths({ xdgDataHome: env.XDG_DATA_HOME, home: homeDir, cwd: options.cwd })
    .dataRoot;
}

async function runDiscovery(
  options: DevinSessionSyncOptions,
  profile: HarnessProfile,
  transcriptPath: string,
): Promise<DiscoveryResult> {
  const discovery = await discover(
    {
      projectId: options.config.projectId,
      sessionId: options.sessionId,
      workspaceRoot: options.cwd,
      transcriptPath,
      captureTranscripts: options.config.captureTranscripts,
      limits: options.config.limits,
      env: options.env,
      homeDir: options.homeDir,
    },
    profile,
  );
  return applyHardBlocklist(discovery);
}

async function buildAllCandidateResults(
  options: DevinSessionSyncOptions,
  discovery: DiscoveryResult,
  homeDir: string,
  dataRoot: string,
): Promise<CandidateResult[]> {
  const projectId = options.config.projectId;
  const fileBased = await buildCandidates(discovery, options.config, { projectRoot: options.cwd });
  const plans = await discoverSessionPlanCandidates(homeDir, options.sessionId, projectId);
  const atif = await readAtifTranscriptCandidate(dataRoot, options.sessionId, projectId);
  const schema = buildSchemaDescriptorCandidate(
    options.schemaDescriptor,
    projectId,
    options.sessionId,
  );
  return [...fileBased, ...plans, ...(atif ? [atif] : []), schema];
}

async function resolveSessionData(
  options: DevinSessionSyncOptions,
  stateStore: StateStore,
  profile: HarnessProfile,
): Promise<SessionData> {
  const existing = await stateStore.getSession(options.sessionId);
  if (existing) return existing;
  const session: SessionData = {
    sessionId: options.sessionId,
    projectId: options.config.projectId,
    harness: profile.harness,
    harnessVersion: profile.harnessVersion,
    startedAt: new Date().toISOString(),
  };
  await stateStore.setSession(options.sessionId, session);
  return session;
}

async function uploadManifestSafely(
  options: DevinSessionSyncOptions,
  session: SessionData,
  deltaResult: Awaited<ReturnType<typeof processDelta>>,
  manifestArtifacts: ReturnType<typeof buildManifestArtifactsFromResults>,
): Promise<string[]> {
  const errors = [...deltaResult.errors];
  try {
    await recordAndUploadManifest({
      dataDir: options.dataDir,
      session,
      run: { ...deltaResult, trigger: options.trigger },
      manifestArtifacts,
      storageAdapter: options.storageAdapter,
      captureTranscripts: options.config.captureTranscripts,
    });
  } catch (err) {
    const code = resolveStorageError(err);
    if (!errors.includes(code)) errors.push(code);
  }
  return errors;
}

async function uploadSessionArtifacts(
  options: DevinSessionSyncOptions,
  candidateResults: CandidateResult[],
  profile: HarnessProfile,
): Promise<DevinSessionSyncOutcome> {
  const stateStore = new StateStore(options.dataDir);
  await stateStore.ensureDirectories();
  const session = await resolveSessionData(options, stateStore, profile);

  const candidates = candidateResults.map((r) => r.candidate);
  const uploader = buildUploader({
    storageAdapter: options.storageAdapter,
    timeoutMs: options.config.timeouts.syncTimeoutMs,
  });

  const deltaResult = await stateStore.withState((state) =>
    processDelta({
      state,
      trigger: options.trigger,
      candidates,
      uploader,
      storageAdapter: options.storageAdapter,
      session,
      transcriptsCaptured: options.config.captureTranscripts,
    }),
  );

  const manifestArtifacts = buildManifestArtifactsFromResults(candidateResults, {
    uploaded: deltaResult.uploaded,
    skipped: deltaResult.skipped,
    failed: deltaResult.failed,
  });
  const errors = await uploadManifestSafely(options, session, deltaResult, manifestArtifacts);

  return {
    sessionId: options.sessionId,
    uploaded: deltaResult.filesUploaded,
    skipped: deltaResult.filesSkipped,
    failed: deltaResult.filesFailed,
    errors,
  };
}

/**
 * Runs the full Devin session sync pipeline: materialize transcript, run
 * discovery (workspace/global config + the materialized transcript), gather
 * extra session/runtime artifacts, upload the delta, and record+upload the
 * manifest. Emits `onProgress` events (advancing progress, then a terminal
 * success/failure) per `.agents/rules/sync-progress-observability.md`.
 */
export async function runDevinSessionSync(
  options: DevinSessionSyncOptions,
): Promise<DevinSessionSyncOutcome> {
  const profile = options.profile ?? DevinHarnessProfile;
  const homeDir = options.homeDir ?? os.homedir();
  const dataRoot = resolveDataRoot(options, homeDir);

  emitProgress(options, 'progress', `extracting transcript for session ${options.sessionId}`);
  const transcriptPath = await materializeSessionTranscript(
    options.tables,
    options.sessionId,
    options.dataDir,
  );

  emitProgress(options, 'progress', `discovering artifacts for session ${options.sessionId}`);
  const discovery = await runDiscovery(options, profile, transcriptPath);
  const candidateResults = await buildAllCandidateResults(options, discovery, homeDir, dataRoot);

  emitProgress(options, 'progress', `uploading ${candidateResults.length} artifact(s)`);
  const outcome = await uploadSessionArtifacts(options, candidateResults, profile);

  const hasFailure = outcome.failed > 0 || outcome.errors.length > 0;
  emitProgress(options, hasFailure ? 'failure' : 'success', summarizeOutcome(outcome));
  return outcome;
}
