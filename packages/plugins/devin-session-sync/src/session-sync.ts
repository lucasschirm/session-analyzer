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
 * the extractor's watermark mechanism. This is required by `watcher.ts`'s
 * `computeSessionWatermarkSignature`, which needs the full current
 * high-water state of every session's tables on every poll to detect which
 * sessions changed (see that file's doc comment) — making the SQL read
 * incremental would make quiet sessions look falsely "changed" (or mask
 * real changes) whenever they fall outside a given poll's incremental
 * window.
 *
 * What *is* incremental (#286) is how `materializeSessionTranscript`
 * decides what to **write**: it derives prior watermarks from the existing
 * transcript file's own tail (`deriveWatermarksFromExistingLines`) and
 * appends only genuinely-new rows, instead of rewriting the whole file
 * every pass. No separate watermark state is persisted anywhere — the
 * transcript file's own content is the only durable state this relies on,
 * self-healing across process restarts/crashes and automatically absorbing
 * every pre-existing transcript written by the old full-rewrite code with
 * no migration step.
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
  FileLock,
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
import { filterChangedToolCallStates } from './extractor/tool-call-watermark.js';
import type {
  DevinExtractedTables,
  DevinSchemaDescriptor,
  DevinWatermarks,
} from './extractor/types.js';
import { EMPTY_WATERMARKS } from './extractor/types.js';
import { deriveWatermarksFromExistingLines } from './extractor/watermark-derivation.js';
import { buildDevinModelCandidates, type CaptureDevinModelsOptions } from './models/capture.js';

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
  /** Optional overrides for the Devin models-list capture (e.g. test fixtures). */
  models?: Partial<CaptureDevinModelsOptions>;
}

export interface DevinSessionSyncOutcome {
  sessionId: string;
  uploaded: number;
  skipped: number;
  failed: number;
  /**
   * Failures in the actual session artifact pipeline (discovery, upload,
   * manifest record/upload). Non-empty `errors` (or `failed > 0`) is what
   * `hasSyncFailure()` below gates on — this is reserved for problems that
   * mean "this session's real data failed to sync".
   */
  errors: string[];
  /**
   * Best-effort side-capture problems (currently: the Devin models-list
   * capture, DS-F4/#153) that must stay visible to the user per
   * `.agents/rules/sync-progress-observability.md` but never alone flip the
   * sync's success/failure determination — session sync success is gated on
   * whether the real session artifacts uploaded, not on this side-channel.
   */
  warnings: string[];
}

/**
 * The single, shared success/failure gate for a `DevinSessionSyncOutcome`:
 * `failed > 0` (real artifact-pipeline failures) OR `errors` non-empty
 * (e.g. a manifest-upload failure, which can occur with `failed === 0`).
 * `warnings` never participates — see `DevinSessionSyncOutcome.warnings`'s
 * doc comment. Exported so `watcher.ts` shares this exact predicate rather
 * than hand-maintaining a second copy — the divergence risk of two copies
 * is exactly what caused #339 (the watcher's copy had silently drifted to
 * `failed > 0` alone).
 */
export function hasSyncFailure(outcome: DevinSessionSyncOutcome): boolean {
  return outcome.failed > 0 || outcome.errors.length > 0;
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
  if (outcome.errors.length > 0) parts.push(`${outcome.errors.length} error(s)`);
  if (outcome.warnings.length > 0) parts.push(`${outcome.warnings.length} warning(s)`);
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

/** Reads an existing transcript file's content, or `undefined` if it does
 * not exist yet (a brand-new session's first sync). Any other read error
 * (e.g. a permissions problem) is not swallowed — only absence is expected
 * and handled here. */
async function readExistingTranscript(transcriptPath: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(transcriptPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Filters one session's freshly-read `sessionTables` down to rows genuinely
 * newer than what the transcript file's own tail already shows.
 *
 * `messageNodes`/`promptHistory` are genuinely insert-only (#298 Phase 1),
 * so a simple `row_id`/`id` watermark comparison is sound, mirroring
 * `reader.ts`'s own `WHERE row_id > ?` / `WHERE id > ?`. `toolCallStates`
 * cannot use that same comparison — #298 found Devin rewrites a session's
 * entire `tool_call_state` row set (including untouched rows) under a new
 * rowid on every persist, so a rowid-based filter here would incorrectly
 * treat an already-written, unchanged row as new and duplicate it. The
 * content-hash comparison (`filterChangedToolCallStates`, the same function
 * `reader.ts` itself uses) is reused instead, fed by the hashes this
 * pass's `deriveWatermarksFromExistingLines` reconstructed from the file.
 *
 * `sessions` is deliberately never filtered here — unchanged, intentional
 * "last-write-wins" replay semantics (`jsonl-writer.ts`'s `appendSessionLines`
 * doc comment): a `session` line is re-appended every pass the session is
 * touched, regardless of whether its content-hash changed. Applying the
 * file-derived `sessionsContentHashes` to skip re-appending here would be a
 * behavior change this issue's Out-of-scope section explicitly rules out,
 * not a correctness fix — so it is not applied, even though the hash is
 * available.
 */
function filterNewRows(
  sessionTables: DevinExtractedTables,
  prior: DevinWatermarks,
): DevinExtractedTables {
  return {
    sessions: sessionTables.sessions,
    messageNodes: sessionTables.messageNodes.filter(
      (m) => m.row_id > (prior.messageNodesRowId ?? -1),
    ),
    promptHistory: sessionTables.promptHistory.filter((p) => p.id > (prior.promptHistoryId ?? -1)),
    toolCallStates: filterChangedToolCallStates(
      sessionTables.toolCallStates,
      prior.toolCallStateHashes,
    ),
  };
}

/**
 * Extracts one session's genuinely-new rows and appends them as
 * `devin-session-jsonl/v1` text to `<dataDir>/devin/transcripts/<sessionId>.jsonl`,
 * returning the path. The generic discovery pipeline
 * (`discover()`/`runSessionDiscovery`) requires an existing on-disk file at
 * `transcriptPath` — Devin has no such file natively, so this plugin
 * creates/grows one on every sync pass.
 *
 * Append-only (#286): prior watermarks are derived from the existing
 * file's own tail (`deriveWatermarksFromExistingLines`), never from a
 * separately persisted record — see that function's doc comment for why.
 * `fsp.appendFile` creates the file if absent, so a brand-new session needs
 * no special-casing versus an incremental resync of an existing one.
 *
 * Subagent synthetic-line regression fix: real message/tool_call/prompt
 * lines are still built from `newTables` (genuinely-new rows only, #286's
 * append-only behavior, unchanged). Subagent synthetic prompt/result lines
 * are derived separately, from the session's FULL current
 * `messageNodes`/`toolCallStates` (`sessionTables`, before the new-rows
 * filter) via `buildDevinJsonl`'s opt-in `subagentContext` — so a tagged
 * node written in an earlier pass always correlates with its completion
 * notification arriving in a later pass, regardless of which pass carried
 * which half. Cross-pass duplication is prevented by
 * `excludeNodeIds: derived.messageNodeIds` (the file-derived set of
 * `node_id`s already written), since `buildSubagentSyntheticNodes` is
 * deterministic — a previously-emitted pair always re-derives to the same
 * ids and is skipped, never re-appended.
 *
 * Concurrency (found in review): `runDevinSessionSync` is invoked
 * independently from three separate processes for the same session —
 * `cli/sync-command.ts` (manual sync), `hook-common.ts` (session-start/
 * session-end/hook events), and `watcher.ts`'s poll loop. Unlike the old
 * full-rewrite (idempotent under a race — last writer wins, no duplication),
 * append-only writing is NOT self-correcting under a race: two concurrent
 * passes reading the same prior-watermark state would each independently
 * append the same "new" rows, permanently duplicating lines. Guarded with
 * the same per-resource `FileLock` pattern `models/capture.ts` already
 * uses for its own cache file, keyed to the transcript path itself so
 * concurrent syncs of *different* sessions never contend.
 */
export async function materializeSessionTranscript(
  tables: DevinExtractedTables,
  sessionId: string,
  dataDir: string,
): Promise<string> {
  const transcriptPath = path.join(dataDir, 'devin', 'transcripts', `${sessionId}.jsonl`);
  const lock = new FileLock(`${transcriptPath}.lock`);
  return lock.withLock(() => appendNewSessionRows(tables, sessionId, transcriptPath));
}

/** The locked critical section of `materializeSessionTranscript`: read the
 * existing file's tail, derive prior state from it, filter+append. Never
 * called outside a held `FileLock` — see caller. */
async function appendNewSessionRows(
  tables: DevinExtractedTables,
  sessionId: string,
  transcriptPath: string,
): Promise<string> {
  const sessionTables = filterTablesForSession(tables, sessionId);
  const existing = await readExistingTranscript(transcriptPath);
  const derived = existing
    ? deriveWatermarksFromExistingLines(existing)
    : { watermarks: EMPTY_WATERMARKS, lineCount: 0, messageNodeIds: new Set<number>() };
  const newTables = filterNewRows(sessionTables, derived.watermarks);
  const { text } = buildDevinJsonl(newTables, {
    orderOffset: derived.lineCount,
    priorWatermarks: derived.watermarks,
    subagentContext: {
      messageNodes: sessionTables.messageNodes,
      toolCallStates: sessionTables.toolCallStates,
      excludeNodeIds: derived.messageNodeIds,
    },
  });
  await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fsp.appendFile(transcriptPath, text, 'utf8');
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
 * `native/models.json` / `native/models-list.raw.json` are runtime-scoped
 * artifacts populated by `models/capture.ts` (DS-F4, #153) and merged into
 * the candidate list by `buildAllCandidateResults`.
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
  modelCandidates: CandidateResult[],
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
  return [...fileBased, ...plans, ...(atif ? [atif] : []), schema, ...modelCandidates];
}

async function resolveModelCandidates(
  options: DevinSessionSyncOptions,
  profile: HarnessProfile,
): Promise<{ candidates: CandidateResult[]; error?: string }> {
  const result = await buildDevinModelCandidates({
    dataDir: options.dataDir,
    projectId: options.config.projectId,
    sessionId: options.sessionId,
    devinCliVersion: options.models?.devinCliVersion ?? profile.harnessVersion,
    resolveVersion: options.models?.resolveVersion,
    runModelsList: options.models?.runModelsList,
    ttlMs: options.models?.ttlMs,
    now: options.models?.now,
  });
  if (result.error) {
    // Non-fatal: emitted as 'progress', never 'failure' — a models-capture
    // problem must never look like a terminal sync failure in CLI/hook
    // output (a real 'failure' terminal event is reserved for when the
    // actual session artifacts fail to sync). Still fully visible: the
    // message is prefixed 'warning:' and the error is recorded in
    // `outcome.warnings` by the caller.
    emitProgress(options, 'progress', `warning: devin models capture failed: ${result.error}`);
  }
  return { candidates: result.candidates, error: result.error };
}

/**
 * Key used to read/write this session's `SessionData` record in `StateStore`.
 *
 * `StateStore.getSession`/`setSession` (packages/sync/src/state/state.ts) key
 * session records by whatever string is passed in — a single field, with no
 * projectId. That store's data directory (`~/.sal-sync` by default, see
 * `getDataDir` in packages/sync/src/cli/common.ts) is process-wide, not
 * project-scoped, and the same `StateStore` class is also used by
 * claude-session-sync's own hook/CLI entry points elsewhere in the engine
 * (`packages/sync/src/cli/*.ts`, the transcript watcher). This composes the
 * key on the Devin side only, rather than changing `StateStore`'s shared
 * signature — several of those other call sites (e.g. `sal-sync status
 * --session-id`) don't reliably have a `projectId` available, so widening the
 * shared signature would be riskier than fixing identity at the one call site
 * that has the bug.
 *
 * Composing `(projectId, sessionId)` into the key (mirroring
 * `artifactStateKey`'s multi-field JSON encoding in the same state.ts file)
 * means a session id whose associated project changes between sync runs
 * resolves to a *distinct* stored record per project, instead of reusing a
 * stale record from a different project's run.
 *
 * DS-B23 (#275): before this fix, running the plugin against project A, then
 * correcting `SAL_PROJECT_ID` to project B for the same local Devin session,
 * reused the project-A `SessionData` (keyed by `sessionId` alone) and
 * produced a manifest whose top-level `projectId` (from that stale session
 * record) disagreed with every `artifacts[].projectId` entry (built fresh
 * from the current `config.projectId`) — a single manifest object with two
 * different `projectId` values depending which field you read.
 */
export function devinSessionStateKey(projectId: string, sessionId: string): string {
  return JSON.stringify([projectId, sessionId]);
}

async function resolveSessionData(
  options: DevinSessionSyncOptions,
  stateStore: StateStore,
  profile: HarnessProfile,
): Promise<SessionData> {
  const stateKey = devinSessionStateKey(options.config.projectId, options.sessionId);
  const existing = await stateStore.getSession(stateKey);
  if (existing) return existing;
  const session: SessionData = {
    sessionId: options.sessionId,
    projectId: options.config.projectId,
    harness: profile.harness,
    harnessVersion: profile.harnessVersion,
    startedAt: new Date().toISOString(),
  };
  await stateStore.setSession(stateKey, session);
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
    warnings: [],
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

  const { candidates: modelCandidates, error: modelsError } = await resolveModelCandidates(
    options,
    profile,
  );

  const candidateResults = await buildAllCandidateResults(
    options,
    discovery,
    homeDir,
    dataRoot,
    modelCandidates,
  );

  emitProgress(options, 'progress', `uploading ${candidateResults.length} artifact(s)`);
  const outcome = await uploadSessionArtifacts(options, candidateResults, profile);
  if (modelsError && !outcome.warnings.includes(modelsError)) {
    outcome.warnings.push(modelsError);
  }

  // Session sync success is gated on whether the real session artifacts
  // (transcript, evidence, tool calls, manifest, etc.) uploaded — the
  // models-list capture is a best-effort side-capture (DS-F4/#153) and must
  // never alone flip the whole sync to failed. Its failure is still fully
  // visible: it already emitted its own 'failure' progress event above and
  // is recorded in `outcome.warnings` (never silently dropped).
  emitProgress(options, hasSyncFailure(outcome) ? 'failure' : 'success', summarizeOutcome(outcome));
  return outcome;
}
