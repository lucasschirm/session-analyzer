import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeCodeSession } from '@lucasschirm/sal-claude-session-parser';
import { mcpServerNameToNamespace, parseSession } from '@lucasschirm/sal-claude-session-parser';
import type {
  ComponentSummary,
  NormalizedEvidenceRecord,
} from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import {
  type ClaudeCodeEvidenceContext,
  type CommandExecutionRecordPayload,
  type FileOperationRecordPayload,
  normalizeCommandExecutions,
  normalizeComponentEvidenceLinks,
  normalizeFileOperations,
  normalizeNormalizedEvents,
  normalizeTasks,
  normalizeValidations,
  type TaskRecordPayload,
  type ValidationRecordPayload,
} from '../../src/plugin/claude-code-tasks.js';

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = path.resolve(
  __filename,
  '../../../../../parsers/claude-session-parser/tests/fixtures',
);

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

function parseFixture(name: string): ClaudeCodeSession {
  return parseSession(loadFixture(name)).toSession();
}

function context(overrides?: Partial<ClaudeCodeEvidenceContext>): ClaudeCodeEvidenceContext {
  return {
    analysisReleaseId: 'test-release',
    parserId: 'sal-claude-session-parser',
    parserVersion: '0.1.0',
    sourceFingerprint: 'test-fingerprint',
    artifactId: 'test-artifact',
    sessionId: 'test-session',
    rootSessionId: 'test-session',
    ...overrides,
  };
}

function recordIds(records: readonly NormalizedEvidenceRecord[]): string[] {
  return records.map((r) => r.recordId).sort();
}

function payloadsByRecordType(
  records: readonly NormalizedEvidenceRecord[],
  recordType: string,
): unknown[] {
  return records.filter((r) => r.recordType === recordType).map((r) => r.payload);
}

function firstPayloadByRecordType(
  records: readonly NormalizedEvidenceRecord[],
  recordType: string,
): unknown | undefined {
  return payloadsByRecordType(records, recordType)[0];
}

describe('claude-code-tasks normalization', () => {
  describe('normalizeFileOperations', () => {
    it('produces write/read records with privacy-safe paths and category metadata', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      const records = normalizeFileOperations(session, ctx);

      expect(records.length).toBeGreaterThanOrEqual(1);
      const writeRecord = records.find(
        (r) =>
          r.recordType === 'file_operation' &&
          (r.payload as FileOperationRecordPayload).toolName === 'Write',
      );
      expect(writeRecord).toBeDefined();
      const write = writeRecord?.payload as FileOperationRecordPayload;
      expect(write.operationType).toBe('write');
      expect(write.normalizedPath).toBe('<cwd>/src/telemetry/ingest.ts');
      expect(write.pathCategory).toBe('source');
      expect(write.extension).toBe('ts');
      expect(write.hasContent).toBe(true);
      expect(write.content).toBeUndefined();
      expect(write.contentLength).toBeGreaterThan(0);
      expect(write.success).toBe(true);
    });

    it('omits raw content by default and includes it when includeRawContent is true', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const without = normalizeFileOperations(session, context());
      const withRaw = normalizeFileOperations(session, context({ includeRawContent: true }));

      const withoutPayload = firstPayloadByRecordType(without, 'file_operation') as
        | FileOperationRecordPayload
        | undefined;
      const withPayload = withRaw.find((r) => r.recordId === withoutPayload?.operationId)
        ?.payload as FileOperationRecordPayload | undefined;
      expect(withPayload?.content).toBeDefined();
    });

    it('is deterministic across repeated calls', () => {
      const session = parseFixture('t2-happy-path.jsonl');
      const ctx = context();
      const a = recordIds(normalizeFileOperations(session, ctx));
      const b = recordIds(normalizeFileOperations(session, ctx));
      expect(a).toEqual(b);
    });

    it('returns an empty array for a session with no file tool calls', () => {
      const session = parseFixture('c1-attachment-zoo.jsonl');
      expect(normalizeFileOperations(session, context())).toEqual([]);
    });
  });

  describe('normalizeCommandExecutions', () => {
    it('classifies Bash and hook commands with sanitized commands and status', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      const records = normalizeCommandExecutions(session, ctx);

      const testCmd = records.find((r) =>
        (r.payload as CommandExecutionRecordPayload).command.includes('pnpm test'),
      );
      expect(testCmd).toBeDefined();
      const testPayload = testCmd?.payload as CommandExecutionRecordPayload;
      expect(testPayload.category).toBe('test');
      expect(testPayload.status).toBe('failure');
      expect(testPayload.stdoutSummary).toContain('failed');

      const gitCmd = records.find((r) =>
        (r.payload as CommandExecutionRecordPayload).command.startsWith('gh '),
      );
      expect(gitCmd).toBeDefined();
      const gitPayload = gitCmd?.payload as CommandExecutionRecordPayload;
      expect(gitPayload.category).toBe('git');
      expect(gitPayload.status).toBe('success');
      expect(gitPayload.gitPrNumber).toBe(7);
      expect(gitPayload.gitPrRepository).toBe('demo-org/orbit-tracker');

      const hookCmd = records.find(
        (r) => (r.payload as CommandExecutionRecordPayload).hookName === 'lint-check',
      );
      expect(hookCmd).toBeDefined();
      const hookPayload = hookCmd?.payload as CommandExecutionRecordPayload;
      expect(hookPayload.category).toBe('lint');
      expect(hookPayload.status).toBe('success');
      expect(hookPayload.exitCode).toBe(0);
    });

    it('is deterministic across repeated calls', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      expect(recordIds(normalizeCommandExecutions(session, ctx))).toEqual(
        recordIds(normalizeCommandExecutions(session, ctx)),
      );
    });
  });

  describe('normalizeValidations', () => {
    it('emits validation records for test/lint commands and hooks', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const records = normalizeValidations(session, context());

      expect(
        records.some((r) => (r.payload as ValidationRecordPayload).validationType === 'test'),
      ).toBe(true);
      expect(
        records.some((r) => (r.payload as ValidationRecordPayload).validationType === 'lint'),
      ).toBe(true);

      const testValidation = records.find(
        (r) =>
          r.recordType === 'validation' &&
          (r.payload as ValidationRecordPayload).command?.includes('test'),
      );
      expect(testValidation).toBeDefined();
      const testPayload = testValidation?.payload as ValidationRecordPayload;
      expect(testPayload.resultStatus).toBe('failure');

      const lintValidation = records.find(
        (r) =>
          r.recordType === 'validation' &&
          (r.payload as ValidationRecordPayload).command?.includes('lint'),
      );
      expect(lintValidation).toBeDefined();
      const lintPayload = lintValidation?.payload as ValidationRecordPayload;
      expect(lintPayload.resultStatus).toBe('success');
    });

    it('does not emit validations for ordinary git/shell commands', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const records = normalizeValidations(session, context());
      const gitValidation = records.find(
        (r) =>
          r.recordType === 'validation' &&
          (r.payload as ValidationRecordPayload).command?.startsWith('gh '),
      );
      expect(gitValidation).toBeUndefined();
    });

    it('is deterministic', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      expect(recordIds(normalizeValidations(session, ctx))).toEqual(
        recordIds(normalizeValidations(session, ctx)),
      );
    });
  });

  describe('normalizeTasks', () => {
    it('derives task records from task_reminder snapshots', () => {
      const session = parseFixture('c1-attachment-zoo.jsonl');
      const records = normalizeTasks(session, context());

      const taskRecords = records.filter((r) => r.recordType === 'task');
      const eventRecords = records.filter((r) => r.recordType === 'task_event');
      expect(taskRecords.length).toBeGreaterThan(0);
      expect(eventRecords.length).toBeGreaterThanOrEqual(taskRecords.length);

      const task = taskRecords[0]?.payload as TaskRecordPayload;
      expect(task.subject).toBe('Update the changelog');
      expect(task.finality).toBe('open');
    });

    it('is deterministic', () => {
      const session = parseFixture('c1-attachment-zoo.jsonl');
      const ctx = context();
      expect(recordIds(normalizeTasks(session, ctx))).toEqual(
        recordIds(normalizeTasks(session, ctx)),
      );
    });

    it('returns an empty array when no task evidence exists', () => {
      const session = parseFixture('t2-happy-path.jsonl');
      expect(normalizeTasks(session, context())).toEqual([]);
    });
  });

  describe('normalizeNormalizedEvents', () => {
    it('emits low-volume native evidence with versioned payloads', () => {
      const session = parseFixture('t2-happy-path.jsonl');
      const records = normalizeNormalizedEvents(session, context());

      const categories = new Set(
        records.map((r) => (r.payload as { category?: string }).category).filter(Boolean),
      );

      expect(records.length).toBeGreaterThan(0);
      expect(categories.has('compaction')).toBe(true);
      expect(categories.has('pr_link')).toBe(true);
      expect(categories.has('permission_mode')).toBe(true);
      expect(categories.has('queue_operation')).toBe(true);
      expect(categories.has('relocated')).toBe(true);
      expect(categories.has('worktree_state')).toBe(true);
      expect(categories.has('file_history')).toBe(true);
      expect(categories.has('bridge_session')).toBe(true);
      expect(categories.has('summary')).toBe(true);
      expect(categories.has('ai_title')).toBe(true);
      expect(categories.has('agent_name')).toBe(true);
      expect(categories.has('last_prompt')).toBe(true);
      expect(categories.has('mode')).toBe(true);
      expect(categories.has('attachment')).toBe(true);
    });

    it('emits unknown events for unrecognized entry types', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const records = normalizeNormalizedEvents(session, context());
      expect(records.some((r) => (r.payload as { category?: string }).category === 'unknown')).toBe(
        true,
      );
    });

    it('does not duplicate hook or task attachments already handled by dedicated functions', () => {
      const session = parseFixture('c1-attachment-zoo.jsonl');
      const records = normalizeNormalizedEvents(session, context());
      const attachmentPayloads = records.filter(
        (r) =>
          r.recordType === 'normalized_event' &&
          (r.payload as { category?: string }).category === 'attachment',
      );
      const attachmentTypes = attachmentPayloads.map(
        (r) => (r.payload as { attachmentType?: string }).attachmentType,
      );
      expect(attachmentTypes).not.toContain('task_reminder');
      expect(attachmentTypes).not.toContain('hook_success');
      expect(attachmentTypes).not.toContain('hook_non_blocking_error');
    });

    it('is deterministic', () => {
      const session = parseFixture('t2-happy-path.jsonl');
      const ctx = context();
      expect(recordIds(normalizeNormalizedEvents(session, ctx))).toEqual(
        recordIds(normalizeNormalizedEvents(session, ctx)),
      );
    });
  });

  describe('normalizeComponentEvidenceLinks', () => {
    function buildComponents(): ComponentSummary[] {
      return [
        {
          componentId: 'skill-csv-wrangler',
          kind: 'skill',
          identity: {
            canonicalId: 'skill-csv-wrangler',
            nativeId: 'csv-wrangler',
            displayName: 'csv-wrangler',
          },
          sourceArtifactIds: [],
        },
        {
          componentId: 'skill-example-doc-summary',
          kind: 'skill',
          identity: {
            canonicalId: 'skill-example-doc-summary',
            nativeId: 'example:doc-summary',
            displayName: 'doc-summary',
            provider: 'example',
          },
          sourceArtifactIds: [],
        },
        {
          componentId: 'agent-docs-drafter',
          kind: 'agent',
          identity: {
            canonicalId: 'agent-docs-drafter',
            nativeId: 'docs-drafter',
            displayName: 'docs-drafter',
          },
          sourceArtifactIds: [],
        },
        {
          componentId: 'mcp-zephyr-tools',
          kind: 'mcp',
          identity: {
            canonicalId: 'mcp-zephyr-tools',
            nativeId: 'zephyr:tools',
            displayName: 'zephyr:tools',
            provider: mcpServerNameToNamespace('zephyr:tools'),
          },
          sourceArtifactIds: [],
        },
        {
          componentId: 'rule-style',
          kind: 'rule',
          identity: {
            canonicalId: 'rule-style',
            nativeId: 'style.md',
            displayName: 'style.md',
          },
          sourcePointer: { path: '.claude/rules/style.md' },
          sourceArtifactIds: [],
        },
      ];
    }

    function manualInvocation(sourceEventId: string, parentId?: string): NormalizedEvidenceRecord {
      return {
        recordId: `manual-${sourceEventId}`,
        recordType: 'invocation',
        sessionId: 'test-session',
        parentId,
        sourceEventId,
        sourceField: 'manual',
        provenance: {
          releaseId: 'r',
          parserId: 'p',
          parserVersion: 'v',
          sourceFingerprint: 'f',
          sourceEventId,
          sourceField: 'manual',
        },
        payload: {},
      } as unknown as NormalizedEvidenceRecord;
    }

    it('links rule components to file operations via glob match', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      const evidence = normalizeFileOperations(session, ctx);
      const records = normalizeComponentEvidenceLinks(session, buildComponents(), evidence, ctx);

      const componentIds = records.map((r) => (r.payload as { componentId?: string }).componentId);
      expect(records.length).toBeGreaterThan(0);
      expect(componentIds).toContain('rule-style');
    });

    it('links skill components to file operations via assistant attribution', () => {
      const session = parseFixture('t2-happy-path.jsonl');
      const ctx = context();
      const evidence = normalizeFileOperations(session, ctx);
      const records = normalizeComponentEvidenceLinks(session, buildComponents(), evidence, ctx);

      const byGrain = new Map<string, string[]>();
      for (const r of records) {
        const grainType = (r.payload as { grainType?: string }).grainType;
        const componentId = (r.payload as { componentId?: string }).componentId;
        if (grainType && componentId) {
          const list = byGrain.get(grainType) ?? [];
          list.push(componentId);
          byGrain.set(grainType, list);
        }
      }

      expect(byGrain.get('file')?.includes('skill-example-doc-summary')).toBe(true);
    });

    it('links mcp and agent components from direct tool use evidence', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      const evidence = [
        manualInvocation('toolu_zephyr_1', 'a-zephyr-1'),
        manualInvocation('toolu_agent_1', 'a-agent-1'),
      ];
      const records = normalizeComponentEvidenceLinks(session, buildComponents(), evidence, ctx);

      const byGrain = new Map<string, string[]>();
      for (const r of records) {
        const grainType = (r.payload as { grainType?: string }).grainType;
        const componentId = (r.payload as { componentId?: string }).componentId;
        if (grainType && componentId) {
          const list = byGrain.get(grainType) ?? [];
          list.push(componentId);
          byGrain.set(grainType, list);
        }
      }

      expect(byGrain.get('invocation')?.includes('mcp-zephyr-tools')).toBe(true);
      expect(byGrain.get('invocation')?.includes('agent-docs-drafter')).toBe(true);
    });

    it('returns an empty array when no components are supplied', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      const evidence = normalizeFileOperations(session, ctx);
      expect(normalizeComponentEvidenceLinks(session, [], evidence, ctx)).toEqual([]);
    });

    it('returns an empty array when no evidence is supplied', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      expect(normalizeComponentEvidenceLinks(session, buildComponents(), [], context())).toEqual(
        [],
      );
    });

    it('is deterministic', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      const evidence = normalizeCommandExecutions(session, ctx);
      const components = buildComponents();
      const a = recordIds(normalizeComponentEvidenceLinks(session, components, evidence, ctx));
      const b = recordIds(normalizeComponentEvidenceLinks(session, components, evidence, ctx));
      expect(a).toEqual(b);
    });
  });

  describe('privacy and determinism invariants', () => {
    it('normalizes absolute home and cwd prefixes in paths', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const records = normalizeFileOperations(session, context());
      for (const r of records) {
        const payload = r.payload as FileOperationRecordPayload;
        expect(payload.normalizedPath).not.toContain('/home/testuser/projects/orbit-tracker');
        expect(payload.normalizedPath).not.toContain('/Users/testuser');
      }
    });

    it('produces the same record ids for the same session and context', () => {
      const session = parseFixture('e2e-main-session.jsonl');
      const ctx = context();
      const allA = [
        ...normalizeTasks(session, ctx),
        ...normalizeFileOperations(session, ctx),
        ...normalizeCommandExecutions(session, ctx),
        ...normalizeValidations(session, ctx),
        ...normalizeNormalizedEvents(session, ctx),
      ];
      const allB = [
        ...normalizeTasks(session, ctx),
        ...normalizeFileOperations(session, ctx),
        ...normalizeCommandExecutions(session, ctx),
        ...normalizeValidations(session, ctx),
        ...normalizeNormalizedEvents(session, ctx),
      ];
      expect(recordIds(allA)).toEqual(recordIds(allB));
    });
  });
});
