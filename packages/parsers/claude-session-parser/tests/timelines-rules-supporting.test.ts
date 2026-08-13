import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { deriveRuleTimeline } from '../src/session/timelines/rules.js';
import { deriveSupportingRecords } from '../src/session/timelines/supporting.js';
import { parseFrontmatter } from '../src/utils/frontmatter.js';
import type {
  AttachmentEntry,
  ClaudeAttachment,
  CompactFileReferenceAttachment,
  CompactMetadata,
  HookAdditionalContextAttachment,
  HookNonBlockingErrorAttachment,
  HookSuccessAttachment,
  HookSystemMessageAttachment,
  NestedMemoryAttachment,
  PermissionModeEntry,
  PlanModeAttachment,
  PlanModeExitAttachment,
  PrLinkEntry,
  SystemEntry,
  UserEntry,
} from '../src/types/session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Entry-construction helpers. `parseSessionTranscript` (T2) is still a stub
// on this branch, so — per the task brief — `ClaudeCodeEntry[]` arrays are
// built directly here rather than parsed from JSONL text.
// ---------------------------------------------------------------------------

interface BaseOverrides {
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
}

function base(lineNumber: number, overrides: BaseOverrides = {}) {
  const timestamp = overrides.timestamp ?? '2026-08-01T00:00:00.000Z';
  return {
    uuid: overrides.uuid ?? `uuid-${lineNumber}`,
    parentUuid: null,
    timestamp,
    timestampMs: Date.parse(timestamp),
    isSidechain: false,
    sessionId: overrides.sessionId ?? 'session-1',
    lineNumber,
  };
}

function attachmentEntry(lineNumber: number, attachment: ClaudeAttachment, overrides: BaseOverrides = {}): AttachmentEntry {
  return {
    ...base(lineNumber, overrides),
    type: 'attachment',
    attachment,
  };
}

describe('deriveRuleTimeline', () => {
  const rawContent = readFixture('t5-nested-memory-rule.md');
  const { body: injectedBody } = parseFrontmatter(rawContent);

  const nestedMemoryAttachment: NestedMemoryAttachment = {
    type: 'nested_memory',
    path: '/Users/dev/project/.claude/rules/widget-catalog-sync.md',
    content: {
      path: '/Users/dev/project/.claude/rules/widget-catalog-sync.md',
      type: 'Project',
      content: injectedBody,
      globs: ['packages/renderer/src/widgets/**'],
      contentDiffersFromDisk: true,
      rawContent,
    },
  };

  it('records a nested_memory injection with frontmatter + globs as "injected"', () => {
    const entry = attachmentEntry(10, nestedMemoryAttachment, { uuid: 'entry-nm-1', timestamp: '2026-08-01T00:00:10.000Z' });

    const [record] = deriveRuleTimeline([entry]);

    expect(record.injectionStatus).toBe('injected');
    expect(record.origin).toBe('nested_memory');
    expect(record.scope).toBe('Project');
    expect(record.title).toBe('Widget Catalog Sync');
    expect(record.globs).toEqual(['packages/renderer/src/widgets/**']);
    expect(record.injectedContent).toBe(injectedBody);
    expect(record.rawContent).toBe(rawContent);
    expect(record.contentDiffersFromDisk).toBe(true);
    expect(record.frontmatter?.description).toContain('regenerate the widget catalog');
    expect(record.availability).toHaveLength(1);
    expect(record.availability[0]).toMatchObject({ action: 'injected', lineNumber: 10, entryUuid: 'entry-nm-1' });
  });

  it('prefers frontmatter-derived globs (normalizeGlobs) when content.globs is absent, and falls back to the basename title when there is no heading', () => {
    const attachment: NestedMemoryAttachment = {
      type: 'nested_memory',
      path: '/Users/dev/project/CLAUDE.md',
      content: {
        path: '/Users/dev/project/CLAUDE.md',
        type: 'User',
        content: 'Body without a heading.',
        contentDiffersFromDisk: false,
        rawContent: '---\nglobs: "*.ts, *.tsx"\n---\n\nBody without a heading.',
      },
    };
    const entry = attachmentEntry(1, attachment);

    const [record] = deriveRuleTimeline([entry]);

    expect(record.globs).toEqual(['*.ts', '*.tsx']);
    expect(record.scope).toBe('User');
    expect(record.title).toBe('CLAUDE.md');
  });

  it('maps an unrecognized content.type to scope "Unknown"', () => {
    const attachment: NestedMemoryAttachment = {
      type: 'nested_memory',
      path: '/Users/dev/project/.claude/rules/odd.md',
      content: {
        path: '/Users/dev/project/.claude/rules/odd.md',
        type: 'SomethingNew',
        content: 'body',
        contentDiffersFromDisk: false,
        rawContent: 'body',
      },
    };
    const [record] = deriveRuleTimeline([attachmentEntry(1, attachment)]);
    expect(record.scope).toBe('Unknown');
  });

  it('records a compact_file_reference as "unknown" (never "available"), with no injectedContent', () => {
    const attachment: CompactFileReferenceAttachment = {
      type: 'compact_file_reference',
      filename: '/Users/dev/project/.claude/rules/workspace-rules.md',
      displayPath: '.claude/rules/workspace-rules.md',
    };
    const entry = attachmentEntry(20, attachment, { uuid: 'entry-cfr-1' });

    const [record] = deriveRuleTimeline([entry]);

    expect(record.injectionStatus).toBe('unknown');
    expect(record.injectionStatus).not.toBe('available');
    expect(record.origin).toBe('compact_file_reference');
    expect(record.displayPath).toBe('.claude/rules/workspace-rules.md');
    expect(record.injectedContent).toBeUndefined();
    expect(record.availability).toHaveLength(1);
    expect(record.availability[0]).toMatchObject({ action: 'referenced', lineNumber: 20, entryUuid: 'entry-cfr-1' });
  });

  it('merges repeated nested_memory sightings of the same path into one record with a growing availability array', () => {
    const first = attachmentEntry(1, nestedMemoryAttachment, { uuid: 'nm-1' });
    const second = attachmentEntry(50, nestedMemoryAttachment, { uuid: 'nm-2' });

    const records = deriveRuleTimeline([first, second]);

    expect(records).toHaveLength(1);
    expect(records[0].availability).toHaveLength(2);
    expect(records[0].availability.map((a) => a.entryUuid)).toEqual(['nm-1', 'nm-2']);
  });

  it('never regresses injectionStatus from "injected" back to "unknown" when a later compact_file_reference sighting reuses the same path', () => {
    const path = '/Users/dev/project/.claude/rules/widget-catalog-sync.md';
    const nm = attachmentEntry(1, nestedMemoryAttachment, { uuid: 'nm-1' });
    const cfr = attachmentEntry(2, { type: 'compact_file_reference', filename: path, displayPath: '.claude/rules/widget-catalog-sync.md' }, { uuid: 'cfr-1' });

    const records = deriveRuleTimeline([nm, cfr]);

    expect(records).toHaveLength(1);
    expect(records[0].injectionStatus).toBe('injected');
    expect(records[0].origin).toBe('nested_memory');
    expect(records[0].availability.map((a) => a.action)).toEqual(['injected', 'referenced']);
  });

  it('returns an empty array for empty input without throwing', () => {
    expect(() => deriveRuleTimeline([])).not.toThrow();
    expect(deriveRuleTimeline([])).toEqual([]);
  });
});

describe('deriveSupportingRecords', () => {
  describe('hooks', () => {
    const hookSuccess: HookSuccessAttachment = {
      type: 'hook_success',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      toolUseID: 'tool-1',
      content: '',
      stdout: '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}',
      stderr: '',
      exitCode: 0,
      command: 'bash session-start.sh',
      durationMs: 120,
    };
    const hookNonBlockingError: HookNonBlockingErrorAttachment = {
      type: 'hook_non_blocking_error',
      hookName: 'Stop',
      hookEvent: 'Stop',
      toolUseID: 'tool-2',
      stdout: '',
      stderr: 'Failed with non-blocking status code: fatal error',
      exitCode: 1,
      command: 'bash stop.sh',
      durationMs: 50,
    };
    const hookSystemMessage: HookSystemMessageAttachment = {
      type: 'hook_system_message',
      content: 'Tip: run /review before pushing.',
      hookName: 'PostToolUse:Bash',
      hookEvent: 'PostToolUse',
      toolUseID: 'tool-3',
    };
    const hookAdditionalContext: HookAdditionalContextAttachment = {
      type: 'hook_additional_context',
      content: ['<EXTREMELY_IMPORTANT>\nExtra example tooling is now enabled.\n</EXTREMELY_IMPORTANT>'],
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      toolUseID: 'tool-4',
    };

    it('produces one HookEventRecord per attachment, with outcome set from which attachment produced it', () => {
      const entries = [
        attachmentEntry(1, hookSuccess, { uuid: 'h1', timestamp: '2026-08-01T00:00:01.000Z' }),
        attachmentEntry(2, hookNonBlockingError, { uuid: 'h2' }),
        attachmentEntry(3, hookSystemMessage, { uuid: 'h3' }),
        attachmentEntry(4, hookAdditionalContext, { uuid: 'h4' }),
      ];

      const { hooks } = deriveSupportingRecords(entries);

      expect(hooks).toHaveLength(4);
      expect(hooks[0]).toMatchObject({
        outcome: 'success',
        hookName: 'SessionStart:startup',
        hookEvent: 'SessionStart',
        command: 'bash session-start.sh',
        exitCode: 0,
        durationMs: 120,
        entryUuid: 'h1',
      });
      expect(hooks[1]).toMatchObject({
        outcome: 'non_blocking_error',
        hookName: 'Stop',
        stderr: 'Failed with non-blocking status code: fatal error',
        exitCode: 1,
        entryUuid: 'h2',
      });
      expect(hooks[2]).toMatchObject({
        outcome: 'system_message',
        hookName: 'PostToolUse:Bash',
        stdout: 'Tip: run /review before pushing.',
        entryUuid: 'h3',
      });
      expect(hooks[3]).toMatchObject({
        outcome: 'additional_context',
        hookName: 'SessionStart:startup',
        entryUuid: 'h4',
      });
      expect(hooks[3].injectedContext).toEqual(['<EXTREMELY_IMPORTANT>\nExtra example tooling is now enabled.\n</EXTREMELY_IMPORTANT>']);
    });

    it('clamps stdout/injectedContext to maxBlobBytes', () => {
      const entries = [attachmentEntry(1, hookSuccess, { uuid: 'h1' }), attachmentEntry(2, hookAdditionalContext, { uuid: 'h4' })];

      const { hooks } = deriveSupportingRecords(entries, { maxBlobBytes: 4 });

      expect(hooks[0].stdout).toBe('{"ho');
      expect(hooks[1].injectedContext?.[0]).toBe('<EXT');
    });

    it('does not turn stop_hook_summary system entries into HookEventRecords', () => {
      const stopHookSummary: SystemEntry = {
        ...base(1, { uuid: 'shs-1' }),
        type: 'system',
        subtype: 'stop_hook_summary',
        hookCount: 1,
        hookInfos: [{ command: 'bash hook.sh' }],
      };

      const { hooks } = deriveSupportingRecords([stopHookSummary]);

      expect(hooks).toEqual([]);
    });
  });

  describe('compactions', () => {
    it('carries full compactMetadata (preservedSegment + preservedMessages) through unchanged', () => {
      const compactMetadata: CompactMetadata = {
        trigger: 'manual',
        preTokens: 500788,
        postTokens: 18858,
        cumulativeDroppedTokens: 481930,
        durationMs: 147420,
        preservedSegment: { headUuid: 'head', anchorUuid: 'anchor', tailUuid: 'tail' },
        preservedMessages: { anchorUuid: 'anchor', uuids: ['head', 'anchor', 'tail'], allUuids: ['head', 'anchor', 'tail'] },
      };
      const entry: SystemEntry = {
        ...base(10, { uuid: 'compact-1', timestamp: '2026-08-01T00:05:00.000Z' }),
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata,
      };

      const { compactions } = deriveSupportingRecords([entry]);

      expect(compactions).toEqual([{ entryUuid: 'compact-1', timestampMs: Date.parse('2026-08-01T00:05:00.000Z'), metadata: compactMetadata }]);
    });

    it('defends against a missing/partial compactMetadata (no real corpus example lacks preservedSegment — synthetic edge case)', () => {
      const partialEntry: SystemEntry = {
        ...base(11, { uuid: 'compact-2' }),
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens: 1000, postTokens: 200, cumulativeDroppedTokens: 800, durationMs: 50 } as CompactMetadata,
      };
      const missingEntry: SystemEntry = {
        ...base(12, { uuid: 'compact-3' }),
        type: 'system',
        subtype: 'compact_boundary',
      };

      const { compactions } = deriveSupportingRecords([partialEntry, missingEntry]);

      expect(compactions[0].metadata.preservedSegment).toBeUndefined();
      expect(compactions[0].metadata.preservedMessages).toBeUndefined();
      expect(compactions[0].metadata.trigger).toBe('auto');
      expect(compactions[1].metadata).toEqual({ trigger: '', preTokens: 0, postTokens: 0, cumulativeDroppedTokens: 0, durationMs: 0 });
    });
  });

  describe('prLinks', () => {
    it('records a pr-link entry', () => {
      const prLink: PrLinkEntry = {
        type: 'pr-link',
        sessionId: 'session-1',
        prNumber: 42,
        prUrl: 'https://github.com/devorg/repo/pull/42',
        prRepository: 'devorg/repo',
        timestamp: '2026-08-01T00:10:00.000Z',
        lineNumber: 30,
      };

      const { prLinks } = deriveSupportingRecords([prLink]);

      expect(prLinks).toEqual([
        { prNumber: 42, prUrl: 'https://github.com/devorg/repo/pull/42', prRepository: 'devorg/repo', timestampMs: Date.parse('2026-08-01T00:10:00.000Z') },
      ]);
    });

    it('dedupes a gitOperation.pr Bash result against a pr-link entry for the same PR number + repo', () => {
      const prLink: PrLinkEntry = {
        type: 'pr-link',
        sessionId: 'session-1',
        prNumber: 42,
        prUrl: 'https://github.com/devorg/repo/pull/42',
        prRepository: 'devorg/repo',
        timestamp: '2026-08-01T00:10:00.000Z',
        lineNumber: 30,
      };
      const bashResult: UserEntry = {
        ...base(31, { uuid: 'u1', timestamp: '2026-08-01T00:11:00.000Z' }),
        type: 'user',
        message: { role: 'user', content: [] },
        toolUseResult: { gitOperation: { pr: { number: 42, url: 'https://github.com/devorg/repo/pull/42', action: 'created' } } },
      };

      const { prLinks } = deriveSupportingRecords([prLink, bashResult]);

      expect(prLinks).toHaveLength(1);
    });

    it('includes a gitOperation.pr Bash result on its own, deriving prRepository from the PR URL', () => {
      const bashResult: UserEntry = {
        ...base(32, { uuid: 'u2', timestamp: '2026-08-01T00:12:00.000Z' }),
        type: 'user',
        message: { role: 'user', content: [] },
        toolUseResult: { gitOperation: { pr: { number: 99, url: 'https://github.com/devorg/other-repo/pull/99', action: 'commented' } } },
      };

      const { prLinks } = deriveSupportingRecords([bashResult]);

      expect(prLinks).toEqual([
        {
          prNumber: 99,
          prUrl: 'https://github.com/devorg/other-repo/pull/99',
          prRepository: 'devorg/other-repo',
          timestampMs: Date.parse('2026-08-01T00:12:00.000Z'),
        },
      ]);
    });
  });

  describe('permissionModes', () => {
    it('records permission-mode changes in chronological order, collapsing consecutive repeats of the same mode', () => {
      const entries: PermissionModeEntry[] = [
        { type: 'permission-mode', permissionMode: 'auto', sessionId: 's', lineNumber: 1 },
        { type: 'permission-mode', permissionMode: 'auto', sessionId: 's', lineNumber: 5 },
        { type: 'permission-mode', permissionMode: 'plan', sessionId: 's', lineNumber: 8 },
        { type: 'permission-mode', permissionMode: 'auto', sessionId: 's', lineNumber: 12 },
      ];

      const { permissionModes } = deriveSupportingRecords(entries);

      expect(permissionModes).toEqual([
        { mode: 'auto', lineNumber: 1 },
        { mode: 'plan', lineNumber: 8 },
        { mode: 'auto', lineNumber: 12 },
      ]);
    });

    it('also picks up UserEntry.permissionMode as a mode source', () => {
      const userEntry: UserEntry = {
        ...base(1, { uuid: 'u1' }),
        type: 'user',
        message: { role: 'user', content: 'hi' },
        permissionMode: 'bypassPermissions',
      };

      const { permissionModes } = deriveSupportingRecords([userEntry]);

      expect(permissionModes).toEqual([{ mode: 'bypassPermissions', lineNumber: 1, timestampMs: userEntry.timestampMs }]);
    });

    it('treats plan_mode/auto_mode attachments as mode sources, but not plan_mode_exit/auto_mode_exit (the real destination mode arrives via the following permission-mode entry)', () => {
      const planMode: PlanModeAttachment = { type: 'plan_mode', reminderType: 'full', isSubAgent: false, planFilePath: '/plan.md', planExists: false };
      const planModeExit: PlanModeExitAttachment = { type: 'plan_mode_exit', planFilePath: '/plan.md', planExists: true };
      const planEntry = attachmentEntry(1, planMode);
      const exitEntry = attachmentEntry(2, planModeExit);
      const followUp: PermissionModeEntry = { type: 'permission-mode', permissionMode: 'auto', sessionId: 's', lineNumber: 3 };

      const { permissionModes } = deriveSupportingRecords([planEntry, exitEntry, followUp]);

      expect(permissionModes).toEqual([
        { mode: 'plan', lineNumber: 1, timestampMs: planEntry.timestampMs },
        { mode: 'auto', lineNumber: 3 },
      ]);
    });
  });

  it('returns four empty arrays for empty input without throwing', () => {
    expect(() => deriveSupportingRecords([])).not.toThrow();
    expect(deriveSupportingRecords([])).toEqual({ permissionModes: [], hooks: [], compactions: [], prLinks: [] });
  });
});
