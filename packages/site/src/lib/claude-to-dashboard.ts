/**
 * Transforms a native `ClaudeCodeSession` (parsed by
 * `@lucasschirm/sal-claude-session-parser`'s `parseSessionTranscript`) into
 * this app's `DashboardSession` shape.
 *
 * This is the direct successor to the old inline `parseClaudeCode` that used
 * to live in `session-parser.worker.ts`: same field mapping, same
 * `SessionBuilder` accumulation, same tool_use/tool_result pairing - just
 * reading from the package's already-parsed, typed `ClaudeCodeEntry[]`
 * instead of re-parsing raw JSONL lines itself. Behaviour is designed to
 * match byte-for-byte on every existing fixture (see
 * `tests/unit/lib/claude-to-dashboard.test.ts`), with one deliberate,
 * untested-either-way deviation documented below (`resolveTimestampMs`'s
 * deterministic `0` fallback in place of the old code's `Date.now()`).
 */

import type { ClaudeCodeEntry, ClaudeCodeSession } from '@lucasschirm/sal-claude-session-parser';
import type { ParsedSession, ParseError as SiteParseError, ToolExecution } from '../types';
import { SessionBuilder } from '../workers/session-builder';

/**
 * Normalizes a `tool_result` block's `content` into a plain string.
 * Commonly a plain string; occasionally an array of content blocks (e.g.
 * `{ type: 'text', text: '...' }`), in which case text blocks are joined -
 * any other shape is JSON-stringified as a fallback.
 */
function normalizeToolResultContent(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = content
      .map((block) =>
        block &&
        typeof block === 'object' &&
        typeof (block as Record<string, unknown>).text === 'string'
          ? ((block as Record<string, unknown>).text as string)
          : undefined,
      )
      .filter((text): text is string => text !== undefined);
    if (textParts.length === content.length) return textParts.join('\n');
    return JSON.stringify(content);
  }
  return JSON.stringify(content);
}

/**
 * `native.entries` only ever contains entries the package successfully
 * parsed into a typed shape - lines that failed to parse as JSON never
 * become an entry at all, they land in `native.parseErrors` instead (see
 * below). Every base-entry-derived member of the union structurally mirrors
 * the raw JSONL field names 1:1 (spec §1's stated design goal), so casting
 * to a loose record here and reading fields by name is equivalent to how
 * the original inline parser walked raw JSON - not a loss of type safety in
 * practice, since the shapes are guaranteed by the package's own parser.
 */
function asRecord(entry: ClaudeCodeEntry): Record<string, unknown> {
  return entry as unknown as Record<string, unknown>;
}

/**
 * Prefers the package's own pre-parsed `timestampMs` (present on
 * assistant/user/system/attachment entries). A few uuid-less bookkeeping
 * entries (`PrLinkEntry`, `QueueOperationEntry`, `FileHistoryDeltaEntry`)
 * carry only a raw ISO `timestamp` string with no `timestampMs` - parsed
 * here the same way the old inline parser's `toTimestamp` helper did.
 * Returns 0 (rather than the old code's non-deterministic `Date.now()`
 * fallback) when no usable timestamp exists at all - a deliberate,
 * deterministic improvement for an edge case no existing fixture exercises
 * either way.
 */
function resolveTimestampMs(event: Record<string, unknown>): number {
  if (typeof event.timestampMs === 'number' && Number.isFinite(event.timestampMs)) {
    return event.timestampMs;
  }
  if (typeof event.timestamp === 'string' && event.timestamp !== '') {
    const parsed = Date.parse(event.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function toDashboardSession(
  native: ClaudeCodeSession,
  projectId: string,
  title = '',
): ParsedSession {
  const builder = new SessionBuilder();
  const pendingToolCalls = new Map<string, ToolExecution>();

  // Root singular fields are already resolved by the package with the exact
  // same semantics the old inline parser implemented by hand: `sessionId`
  // is "first non-empty value seen wins" (spec §1.1), `aiTitle` is "last
  // `ai-title` entry wins".
  builder.externalId = native.sessionId;
  const aiTitle = native.aiTitle;

  for (const entry of native.entries) {
    const event = asRecord(entry);
    const type = entry.type;
    const timestampMs = resolveTimestampMs(event);
    // The old parser fed every line's raw `timestamp` presence into
    // `observeTimestamp`, even entries with an unparseable timestamp value.
    // The package instead exposes a parsed `timestamp: string` that's only
    // non-empty when a real timestamp field was present on the source line
    // (see ClaudeCodeEntryBase/buildBase) - checking that string is the
    // equivalent "was a timestamp present at all" signal here.
    if (typeof event.timestamp === 'string' && event.timestamp !== '') {
      builder.observeTimestamp(timestampMs);
    }
    const uuid = typeof event.uuid === 'string' && event.uuid !== '' ? event.uuid : undefined;
    const parentUuid = typeof event.parentUuid === 'string' ? event.parentUuid : undefined;

    if (type === 'assistant') {
      const message = event.message as Record<string, unknown> | undefined;
      const modelName = typeof message?.model === 'string' ? message.model : builder.model;
      if (modelName) builder.model = modelName;

      const usage = message?.usage as Record<string, unknown> | undefined;
      const input = Number(usage?.input_tokens ?? 0);
      const output = Number(usage?.output_tokens ?? 0);
      const cacheCreation = Number(usage?.cache_creation_input_tokens ?? 0);
      const cacheRead = Number(usage?.cache_read_input_tokens ?? 0);
      if (usage) {
        builder.inputTokens += input;
        builder.outputTokens += output;
        builder.cacheCreationTokens += cacheCreation;
        builder.cacheReadTokens += cacheRead;
        if (modelName) builder.addModelUsage(modelName, input, output, cacheCreation, cacheRead);
      }
      builder.turns++;

      const diagnostics = message?.diagnostics as Record<string, unknown> | null | undefined;
      if (diagnostics) {
        const cacheMissReason = diagnostics.cache_miss_reason as
          | Record<string, unknown>
          | undefined;
        const reasonType =
          cacheMissReason && typeof cacheMissReason.type === 'string'
            ? cacheMissReason.type
            : undefined;
        builder.addEvent(
          'diagnostic',
          reasonType ? `Cache miss: ${reasonType}` : 'Diagnostic recorded',
          timestampMs,
          diagnostics,
        );
      }

      const blocks =
        message && Array.isArray(message.content)
          ? (message.content as Array<Record<string, unknown>>)
          : [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          builder.addTranscriptMessage('assistant', block.text, timestampMs, uuid, parentUuid);
        } else if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const target =
            (input.file_path as string) ??
            (input.path as string) ??
            (input.target as string) ??
            (input.command as string) ??
            (input.pattern as string) ??
            undefined;
          const execution = builder.addTool(
            String(block.name ?? 'unknown'),
            'tool_use',
            target,
            timestampMs,
            true,
            input,
          );
          if (typeof block.id === 'string') pendingToolCalls.set(block.id, execution);
        }
      }

      builder.addEvent('assistant_turn', 'Assistant turn', timestampMs, event);
    } else if (type === 'user') {
      if (event.isMeta === true) continue;

      const message = event.message as Record<string, unknown> | undefined;
      const messageContent = message?.content;

      if (typeof messageContent === 'string' && messageContent) {
        builder.addTranscriptMessage('user', messageContent, timestampMs, uuid, parentUuid);
      } else if (Array.isArray(messageContent)) {
        for (const block of messageContent as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const execution = pendingToolCalls.get(block.tool_use_id);
            if (execution) {
              execution.success = block.is_error !== true;
              execution.result = normalizeToolResultContent(block.content);
              execution.result_uuid = uuid;
              pendingToolCalls.delete(block.tool_use_id);
            }
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            builder.addTranscriptMessage('user', block.text, timestampMs, uuid, parentUuid);
          }
        }
      }
    } else if (type === 'system') {
      const subtype = String(event.subtype ?? 'unknown');
      if (subtype === 'compact_boundary') {
        const metadata = event.compactMetadata as Record<string, unknown> | undefined;
        const tokensSaved =
          Number(metadata?.cumulativeDroppedTokens ?? 0) ||
          Math.max(0, Number(metadata?.preTokens ?? 0) - Number(metadata?.postTokens ?? 0));
        builder.addCompaction(timestampMs, tokensSaved, event);
      } else {
        builder.addEvent(subtype, `System: ${subtype}`, timestampMs, event);
      }
    } else if (type === 'attachment') {
      const attachment = event.attachment as Record<string, unknown> | undefined;
      if (attachment?.type === 'task_reminder' && Array.isArray(attachment.content)) {
        builder.trackTaskReminder(
          attachment.content as Array<Record<string, unknown>>,
          timestampMs,
        );
      }
      builder.addEvent(type, `Claude CLI event: ${type}`, timestampMs, event);
    } else {
      builder.addEvent(type, `Claude CLI event: ${type}`, timestampMs, event);
    }
  }

  // The package validates every line as JSON up front - a malformed line
  // never becomes an entry, it lands here as an `invalid_json` ParseError
  // instead (see parseSessionTranscript). Only that code is surfaced as a
  // site-level ParseError, matching the old inline parser's behaviour
  // exactly: it only ever recorded "Failed to parse JSON line" errors, never
  // ones for individually missing/unparseable per-entry timestamps (which
  // the package tracks separately as `missing_timestamp`/`invalid_timestamp`
  // - a stricter, new-to-this-package concern the old parser never had, so
  // surfacing those here would be a parity regression, not an improvement).
  for (const parseError of native.parseErrors) {
    if (parseError.code !== 'invalid_json') continue;
    const siteError: SiteParseError = {
      line: parseError.line,
      message: 'Failed to parse JSON line',
      raw_data: parseError.rawSnippet,
    };
    builder.addError(siteError);
  }

  return builder.finalize(projectId, 'claude', aiTitle || title);
}
