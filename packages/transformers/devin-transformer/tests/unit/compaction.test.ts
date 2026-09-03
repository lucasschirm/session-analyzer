import type { UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import {
  compactionBoundaryBundle,
  defaultContext,
  linearBundle,
} from '../conformance/fixtures/index.js';

function rawLine(type: string, rest: Record<string, unknown>): string {
  return JSON.stringify({ type, ...rest });
}

/** Minimal bundle where the compaction's output node has no `created_at`
 * (unlike `compactionBoundaryBundle`), forcing the timestamp fallback to the
 * anchor node's own `created_at` instead of the output node's. */
function bundleWithOutputNodeMissingCreatedAt(): UnknownArtifactBundle {
  const sessionId = 'edge-case';
  const transcript = [
    rawLine('session', {
      ts: 100,
      order: 1,
      id: sessionId,
      working_directory: '/w',
      backend_type: 'devin',
      model: 'devin-default',
      agent_mode: 'auto',
      created_at: 100,
      last_activity_at: 200,
      title: 'edge case',
      main_chain_id: '2',
      metadata: null,
    }),
    rawLine('message', {
      ts: null,
      order: 2,
      row_id: 1,
      session_id: sessionId,
      node_id: 1,
      parent_node_id: null,
      chat_message: JSON.stringify({ message_id: 'm1', role: 'user', content: 'hi' }),
      created_at: 500,
      metadata: JSON.stringify({
        summarized_from: null,
        num_tokens_preceding: 10,
        is_system_prefix: null,
      }),
    }),
    rawLine('message', {
      ts: null,
      order: 3,
      row_id: 2,
      session_id: sessionId,
      node_id: 2,
      parent_node_id: 1,
      chat_message: JSON.stringify({ message_id: 'm2', role: 'assistant', content: 'summary' }),
      created_at: null,
      metadata: JSON.stringify({
        summarized_from: 1,
        num_tokens_preceding: null,
        is_system_prefix: null,
      }),
    }),
  ].join('\n');
  return {
    artifacts: [
      { relativePath: 'transcript.jsonl', content: transcript, mediaType: 'application/jsonl' },
    ],
    sourceIdentity: {
      sourceId: 'test-source',
      environmentId: 'test-env',
      projectId: 'test-proj',
      sessionId: 'test-sess',
    },
    sourceFingerprint: 'fp-test',
  };
}

function compactionRecords(result: ReturnType<typeof DevinTransformer.transform>) {
  return result.evidence.filter(
    (r) =>
      r.recordType === 'normalized_event' &&
      (r.payload as { category?: string }).category === 'compaction',
  );
}

describe('DevinTransformer — compaction evidence (DS-B27 / #287)', () => {
  it('produces exactly one compaction record for the shadow-collar node 45-63 shape', () => {
    const result = DevinTransformer.transform(compactionBoundaryBundle, defaultContext);
    const records = compactionRecords(result);
    expect(records).toHaveLength(1);
  });

  it('derives trigger: manual from the correlated /compact prompt row', () => {
    const result = DevinTransformer.transform(compactionBoundaryBundle, defaultContext);
    const [record] = compactionRecords(result);
    expect((record.payload as { trigger?: string }).trigger).toBe('manual');
  });

  it('populates preTokens from the anchor node num_tokens_preceding', () => {
    const result = DevinTransformer.transform(compactionBoundaryBundle, defaultContext);
    const [record] = compactionRecords(result);
    expect((record.payload as { preTokens?: number }).preTokens).toBe(17033);
  });

  it('recovers prunedNodeIds via the parent_node_id walk, excluding sibling node 56', () => {
    const result = DevinTransformer.transform(compactionBoundaryBundle, defaultContext);
    const [record] = compactionRecords(result);
    const payload = record.payload as { prunedNodeIds?: number[] };
    expect(payload.prunedNodeIds).toEqual([50, 51, 52, 53, 54, 55, 57]);
    expect(payload.prunedNodeIds).not.toContain(56);
  });

  it('references the anchor node_id/row_id as the source event, never the chat message uuid', () => {
    const result = DevinTransformer.transform(compactionBoundaryBundle, defaultContext);
    const [record] = compactionRecords(result);
    const payload = record.payload as { anchorNodeId?: number; anchorRowId?: number };
    expect(payload.anchorNodeId).toBe(57);
    expect(typeof payload.anchorRowId).toBe('number');
    expect(record.sourceEventId).toContain('node-57');
    expect(record.provenance.sourceEventId).toContain('node-57');
  });

  it('never fabricates postTokens/cumulativeDroppedTokens/compactionDurationMs as 0 - they are absent', () => {
    const result = DevinTransformer.transform(compactionBoundaryBundle, defaultContext);
    const [record] = compactionRecords(result);
    const payload = record.payload as Record<string, unknown>;
    expect('postTokens' in payload).toBe(false);
    expect('cumulativeDroppedTokens' in payload).toBe(false);
    expect('compactionDurationMs' in payload).toBe(false);
    expect(payload.postTokens).toBeUndefined();
    expect(payload.cumulativeDroppedTokens).toBeUndefined();
    expect(payload.compactionDurationMs).toBeUndefined();
  });

  it('resolves provenance through the manifest-backed artifact grain (path/hash)', () => {
    const result = DevinTransformer.transform(compactionBoundaryBundle, defaultContext);
    const [record] = compactionRecords(result);
    expect(record.provenance.artifactId).toBeTruthy();
    expect(record.provenance.path).toBeTruthy();
    expect(record.provenance.sourceField).toBe('metadata.summarized_from');
  });

  it('emits no compaction records for a session with no compaction boundary', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(compactionRecords(result)).toEqual([]);
  });

  it('falls back to the anchor node createdAt when the output node has no created_at', () => {
    const result = DevinTransformer.transform(
      bundleWithOutputNodeMissingCreatedAt(),
      defaultContext,
    );
    const [record] = compactionRecords(result);
    expect((record.payload as { timestampMs: number }).timestampMs).toBe(500_000);
  });

  it('derives trigger as missing (not "auto") when no correlated /compact prompt row exists', () => {
    // Re-parse a variant transcript without the /compact prompt line by
    // stripping it from the bundle's transcript.jsonl artifact.
    const artifacts = compactionBoundaryBundle.artifacts.map((a) => {
      if (a.relativePath !== 'transcript.jsonl' || typeof a.content !== 'string') return a;
      const withoutPrompt = a.content
        .split('\n')
        .filter((line) => !line.includes('"type":"prompt"'))
        .join('\n');
      return { ...a, content: withoutPrompt };
    });
    const result = DevinTransformer.transform(
      { ...compactionBoundaryBundle, artifacts },
      defaultContext,
    );
    const [record] = compactionRecords(result);
    const payload = record.payload as Record<string, unknown>;
    expect('trigger' in payload).toBe(false);
    expect(payload.trigger).toBeUndefined();
    expect(payload.trigger).not.toBe('auto');
  });
});
