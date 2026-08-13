/**
 * `deriveSupportingRecords` — spec §2 "Supporting records": permission-mode
 * changes, hook firings, compaction boundaries, and PR links. None of these
 * four output shapes is an `AvailabilityEvent<A>` (they have no `action`
 * field), so — unlike `deriveRuleTimeline` — this module does not build
 * through `eventFrom`; it pulls `lineNumber`/`timestampMs`/`uuid` off
 * entries directly via the other `context.ts` helpers instead.
 */

import type {
  AttachmentEntry,
  ClaudeCodeEntry,
  CompactMetadata,
  HookAdditionalContextAttachment,
  HookNonBlockingErrorAttachment,
  HookSuccessAttachment,
  HookSystemMessageAttachment,
  PermissionModeEntry,
  PrLinkEntry,
  SystemEntry,
  UserEntry,
} from '../../types/session.js';
import type { CompactionRecord, HookEventRecord, PermissionModeChange, PrLinkRecord } from '../../types/timeline.js';
import { clampBlob } from '../../utils/text.js';
import { entryLineNumber, entryTimestampMs, entryUuid } from './context.js';
import type { TimelineDeriveOptions } from './context.js';

/** Builds a `HookEventRecord`, omitting optional fields entirely rather
 *  than setting them to `undefined`. `entryUuid`/`timestampMs` are typed as
 *  required on `HookEventRecord`; every hook attachment lives on an
 *  `AttachmentEntry`, which always carries both (`ClaudeCodeEntryBase`
 *  declares them non-optional), so the `?? ''` / `?? 0` fallbacks below are
 *  defensive only and never actually trigger against real data. */
function makeHookRecord(
  entry: ClaudeCodeEntry,
  outcome: HookEventRecord['outcome'],
  fields: {
    hookName: string;
    hookEvent: string;
    command?: string;
    exitCode?: number;
    durationMs?: number;
    stdout?: string;
    stderr?: string;
    injectedContext?: string[];
  },
  maxBlobBytes: number | undefined,
): HookEventRecord {
  const record: HookEventRecord = {
    hookName: fields.hookName,
    hookEvent: fields.hookEvent,
    outcome,
    entryUuid: entryUuid(entry) ?? '',
    timestampMs: entryTimestampMs(entry) ?? 0,
  };
  if (fields.command !== undefined) record.command = fields.command;
  if (fields.exitCode !== undefined) record.exitCode = fields.exitCode;
  if (fields.durationMs !== undefined) record.durationMs = fields.durationMs;
  if (fields.stdout !== undefined) record.stdout = clampBlob(fields.stdout, maxBlobBytes);
  if (fields.stderr !== undefined) record.stderr = clampBlob(fields.stderr, maxBlobBytes);
  if (fields.injectedContext !== undefined) record.injectedContext = fields.injectedContext;
  return record;
}

/** Defends against a missing/partial `compactMetadata`: numeric fields
 *  fall back to `0` and `trigger` falls back to `''` (still a valid value
 *  under `CompactMetadata['trigger']`'s `(string & {})` catch-all) rather
 *  than guessing a real trigger value we have no evidence for. */
function buildCompactionRecord(entry: SystemEntry): CompactionRecord {
  const raw = entry.compactMetadata;
  const metadata: CompactMetadata = {
    trigger: raw?.trigger ?? '',
    preTokens: typeof raw?.preTokens === 'number' ? raw.preTokens : 0,
    postTokens: typeof raw?.postTokens === 'number' ? raw.postTokens : 0,
    cumulativeDroppedTokens: typeof raw?.cumulativeDroppedTokens === 'number' ? raw.cumulativeDroppedTokens : 0,
    durationMs: typeof raw?.durationMs === 'number' ? raw.durationMs : 0,
  };
  if (raw?.preservedSegment) metadata.preservedSegment = raw.preservedSegment;
  if (raw?.preservedMessages) metadata.preservedMessages = raw.preservedMessages;
  return {
    entryUuid: entryUuid(entry) ?? '',
    timestampMs: entryTimestampMs(entry) ?? 0,
    metadata,
  };
}

function prKey(prNumber: number, prRepository: string): string {
  return `${prRepository.toLowerCase()}#${prNumber}`;
}

/** Extracts `"<owner>/<repo>"` out of a PR URL shaped like
 *  `".../<owner>/<repo>/pull/<n>"` (GitHub and GitHub-Enterprise-style
 *  hosts). Used only for the `gitOperation.pr` fallback source below, which
 *  — confirmed against real data — carries no repository field of its own
 *  (unlike `PrLinkEntry.prRepository`). Returns `undefined` for URLs that
 *  don't match this shape rather than guessing. */
function repoFromPrUrl(url: string): string | undefined {
  const match = url.match(/\/([^/]+\/[^/]+)\/pull\/\d+/);
  return match ? match[1] : undefined;
}

export function deriveSupportingRecords(
  entries: ClaudeCodeEntry[],
  options?: TimelineDeriveOptions,
): {
  permissionModes: PermissionModeChange[];
  hooks: HookEventRecord[];
  compactions: CompactionRecord[];
  prLinks: PrLinkRecord[];
} {
  const maxBlobBytes = options?.maxBlobBytes;
  const permissionModes: PermissionModeChange[] = [];
  const hooks: HookEventRecord[] = [];
  const compactions: CompactionRecord[] = [];
  const prLinks: PrLinkRecord[] = [];
  const seenPrKeys = new Set<string>();

  // `PermissionModeEntry`/`ModeEntry` and friends are uuid-less bookkeeping
  // entries (no `uuid`/`timestamp` at all — see spec §1.2) — `lineNumber`
  // is their only stable identity, which is why `PermissionModeChange`
  // keys on it rather than `entryUuid`.
  let lastMode: string | undefined;
  const recordModeChange = (mode: string, entry: ClaudeCodeEntry): void => {
    // Real transcripts restate the current mode on nearly every
    // `permission-mode` entry and on every `UserEntry.permissionMode`
    // (confirmed: a single real session repeats "auto" 200+ times with no
    // actual transition) — only a change in value is a "change" worth
    // recording, so consecutive repeats of the same mode collapse into one
    // record.
    if (mode === lastMode) return;
    lastMode = mode;
    const change: PermissionModeChange = { mode, lineNumber: entryLineNumber(entry) };
    const timestampMs = entryTimestampMs(entry);
    if (timestampMs !== undefined) change.timestampMs = timestampMs;
    permissionModes.push(change);
  };

  for (const entry of entries) {
    if (entry.type === 'permission-mode') {
      recordModeChange((entry as PermissionModeEntry).permissionMode, entry);
      continue;
    }

    if (entry.type === 'user') {
      const user = entry as UserEntry;
      if (user.permissionMode) recordModeChange(user.permissionMode, entry);

      // Second real PR-link source: `ToolUseResult.gitOperation.pr` on a
      // Bash tool result. Deduped against `pr-link` entries (and against
      // itself) by PR number + repository, since both sources can describe
      // the same real PR.
      const pr = user.toolUseResult?.gitOperation?.pr;
      if (pr && typeof pr.number === 'number' && typeof pr.url === 'string') {
        const repository = repoFromPrUrl(pr.url);
        if (repository !== undefined) {
          const key = prKey(pr.number, repository);
          if (!seenPrKeys.has(key)) {
            seenPrKeys.add(key);
            prLinks.push({
              prNumber: pr.number,
              prUrl: pr.url,
              prRepository: repository,
              timestampMs: entryTimestampMs(entry) ?? 0,
            });
          }
        }
      }
      continue;
    }

    if (entry.type === 'pr-link') {
      const pr = entry as PrLinkEntry;
      const key = prKey(pr.prNumber, pr.prRepository);
      if (!seenPrKeys.has(key)) {
        seenPrKeys.add(key);
        const parsedTimestamp = Date.parse(pr.timestamp);
        prLinks.push({
          prNumber: pr.prNumber,
          prUrl: pr.prUrl,
          prRepository: pr.prRepository,
          timestampMs: entryTimestampMs(entry) ?? (Number.isNaN(parsedTimestamp) ? 0 : parsedTimestamp),
        });
      }
      continue;
    }

    if (entry.type === 'system') {
      const sys = entry as SystemEntry;
      if (sys.subtype === 'compact_boundary') {
        compactions.push(buildCompactionRecord(sys));
      }
      // `stop_hook_summary` is intentionally NOT turned into
      // `HookEventRecord`s: its `hookInfos[]` only ever carries
      // `{command, durationMs}` (confirmed against real data — no
      // `exitCode`, no `stdout`/`stderr`, no per-hook outcome), so it
      // can't populate this type's required `outcome` field with real
      // evidence. The same hook firings it summarizes are already captured
      // individually via the `hook_success`/`hook_non_blocking_error`/
      // `hook_system_message`/`hook_additional_context` attachments
      // elsewhere in the transcript — modeling `stop_hook_summary` too
      // would only produce duplicate, less-detailed records.
      continue;
    }

    if (entry.type === 'attachment') {
      const attachment = (entry as AttachmentEntry).attachment;
      switch (attachment.type) {
        case 'plan_mode':
          recordModeChange('plan', entry);
          break;
        case 'auto_mode':
          recordModeChange('auto', entry);
          break;
        // `plan_mode_exit`/`auto_mode_exit` carry no destination mode of
        // their own. Confirmed against real data: every real occurrence is
        // immediately followed by an explicit `mode`/`permission-mode`
        // entry that DOES carry the destination mode — that transition is
        // already captured by the 'permission-mode'/'user' branches above,
        // so the exit attachments are intentionally not a mode source here.
        case 'hook_success': {
          const a = attachment as HookSuccessAttachment;
          hooks.push(
            makeHookRecord(
              entry,
              'success',
              {
                hookName: a.hookName,
                hookEvent: a.hookEvent,
                command: a.command,
                exitCode: a.exitCode,
                durationMs: a.durationMs,
                stdout: a.stdout,
                stderr: a.stderr,
              },
              maxBlobBytes,
            ),
          );
          break;
        }
        case 'hook_non_blocking_error': {
          const a = attachment as HookNonBlockingErrorAttachment;
          hooks.push(
            makeHookRecord(
              entry,
              'non_blocking_error',
              {
                hookName: a.hookName ?? '',
                hookEvent: a.hookEvent ?? '',
                command: a.command,
                exitCode: a.exitCode,
                durationMs: a.durationMs,
                stdout: a.stdout,
                stderr: a.stderr,
              },
              maxBlobBytes,
            ),
          );
          break;
        }
        case 'hook_system_message': {
          // `hook_system_message.content` is a UI-facing tip/notice text
          // (e.g. "Tip: Run /ultrareview…"), not context injected into the
          // model — closer to hook-produced output than to
          // `hook_additional_context`'s prompt-context injections, so it's
          // carried on `stdout` rather than `injectedContext`. Documented
          // here since the spec doesn't pin this down explicitly.
          const a = attachment as HookSystemMessageAttachment;
          hooks.push(
            makeHookRecord(
              entry,
              'system_message',
              {
                hookName: a.hookName ?? '',
                hookEvent: a.hookEvent ?? '',
                stdout: a.content,
              },
              maxBlobBytes,
            ),
          );
          break;
        }
        case 'hook_additional_context': {
          const a = attachment as HookAdditionalContextAttachment;
          hooks.push(
            makeHookRecord(
              entry,
              'additional_context',
              {
                hookName: a.hookName,
                hookEvent: a.hookEvent,
                injectedContext: (a.content ?? []).map((c) => clampBlob(c, maxBlobBytes)),
              },
              maxBlobBytes,
            ),
          );
          break;
        }
        default:
          break;
      }
    }
  }

  return { permissionModes, hooks, compactions, prLinks };
}
