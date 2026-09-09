import { describe, expect, it } from 'vitest';
import { classifyDevinArtifacts, toTextContent } from '../../src/classification.js';
import { DevinTransformer } from '../../src/index.js';
import { parseDevinBundle } from '../../src/parse-bundle.js';
import { buildSessionSpine } from '../../src/session-spine.js';

describe('Branch coverage: classification', () => {
  it('handles non-string artifact contents', () => {
    const buffer = new TextEncoder().encode('{"type":"session","id":"s1"}');
    const arrayBuffer = new TextEncoder().encode('hi').buffer;
    const result = classifyDevinArtifacts({
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: buffer,
          mediaType: 'application/jsonl',
        } as unknown as { relativePath: string; content: unknown; mediaType: string },
        {
          relativePath: 'native/schema-descriptor.json',
          content: arrayBuffer,
          mediaType: 'application/json',
        } as unknown as { relativePath: string; content: unknown; mediaType: string },
        {
          relativePath: 'native/models.json',
          content: [{ modelUid: 'x', label: 'X', familyUid: 'f', costTier: 'Standard' }],
          mediaType: 'application/json',
        } as unknown as { relativePath: string; content: unknown; mediaType: string },
        {
          relativePath: 'unknown.bin',
          content: 123,
          mediaType: 'application/octet-stream',
        } as unknown as { relativePath: string; content: unknown; mediaType: string },
      ],
    });
    expect(result.artifacts[0]?.kind).toBe('transcript');
    expect(result.artifacts[1]?.kind).toBe('settings');
    expect(result.artifacts[2]?.kind).toBe('settings');
    expect(result.artifacts[3]?.kind).toBe('unclassified');
  });

  it('decodes a multi-byte UTF-8 code point', () => {
    const encoded = new TextEncoder().encode('é 😀');
    const result = classifyDevinArtifacts({
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: encoded,
          mediaType: 'application/jsonl',
        } as unknown as { relativePath: string; content: unknown; mediaType: string },
      ],
    });
    expect(result.artifacts[0]?.kind).toBe('transcript');
    expect(result.artifacts[0]?.confidence).toBe('inferred');
  });

  it('classifies global config and raw models', () => {
    const result = classifyDevinArtifacts({
      artifacts: [
        { relativePath: 'config.json', content: '{}', mediaType: 'application/json' },
        {
          relativePath: 'native/models-list.raw.json',
          content: 'raw content',
          mediaType: 'application/json',
        },
        { relativePath: 'plans/plan-12345.md', content: '', mediaType: 'text/markdown' },
      ],
    });
    expect(result.artifacts[0]?.scope).toBe('global');
    expect(result.artifacts[1]?.kind).toBe('settings');
    expect(result.artifacts[2]?.confidence).toBe('inferred');
  });

  it('infers when schema validation fails', () => {
    const result = classifyDevinArtifacts({
      artifacts: [
        { relativePath: 'transcript.jsonl', content: 'not-json', mediaType: 'application/jsonl' },
        {
          relativePath: 'native/atif-transcript.json',
          content: 'not-json',
          mediaType: 'application/json',
        },
        {
          relativePath: 'native/schema-descriptor.json',
          content: '{"refineryVersion":16}',
          mediaType: 'application/json',
        },
        { relativePath: 'native/models.json', content: '[{}]', mediaType: 'application/json' },
      ],
    });
    for (const a of result.artifacts) {
      expect(a.confidence).toBe('inferred');
    }
  });
});

describe('Branch coverage: parse bundle', () => {
  it('handles missing, malformed, or non-text content for optional artifacts', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content:
            '{"type":"session","id":"s1","ts":1,"order":1}\n{"type":"message","session_id":"s1","node_id":1,"parent_node_id":null,"chat_message":"{}","order":2}',
          mediaType: 'application/jsonl',
        },
        {
          relativePath: 'native/schema-descriptor.json',
          content: 'not-json',
          mediaType: 'application/json',
        },
        { relativePath: 'native/models.json', content: '{}', mediaType: 'application/json' },
        {
          relativePath: 'native/models-list.raw.json',
          content: null as unknown as string,
          mediaType: 'application/json',
        },
        { relativePath: 'plans/plan-aaa.md', content: '', mediaType: 'text/markdown' },
        {
          relativePath: 'native/atif-transcript.json',
          content: 'not-json',
          mediaType: 'application/json',
        },
      ],
      sourceFingerprint: 'fp-branch',
    } as const;
    const parsed = parseDevinBundle(bundle);
    expect(parsed.rootTranscriptText).toBeDefined();
    expect(parsed.schemaDescriptor).toBeUndefined();
    expect(parsed.models).toHaveLength(0);
    expect(parsed.modelsRaw).toBeUndefined();
    expect(parsed.planContent).toBe('');
    expect(parsed.atif).toBeUndefined();
  });

  it('uses numeric main_chain_id and orders messages', () => {
    const jsonl = [
      '{"type":"session","id":"s1","ts":1,"order":1,"main_chain_id":"2"}',
      '{"type":"message","session_id":"s1","node_id":1,"parent_node_id":null,"chat_message":"{}","order":2}',
      '{"type":"message","session_id":"s1","node_id":2,"parent_node_id":1,"chat_message":"{}","order":3}',
    ].join('\n');
    const bundle = {
      artifacts: [
        { relativePath: 'transcript.jsonl', content: jsonl, mediaType: 'application/jsonl' },
      ],
      sourceFingerprint: 'fp-chain',
    };
    const parsed = parseDevinBundle(bundle);
    expect(parsed.orderedMessages.map((m) => m.nodeId)).toEqual([1, 2]);
  });

  it('decodes a UTF-8 root transcript and object/numeric artifact contents', () => {
    const sessionJson = new TextEncoder().encode('{"type":"session","id":"s1","ts":1,"order":1}\n');
    const bundle = {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: sessionJson,
          mediaType: 'application/jsonl',
        } as unknown as { relativePath: string; content: unknown; mediaType: string },
        { relativePath: 'native/models.json', content: 'not-json', mediaType: 'application/json' },
        {
          relativePath: 'native/models-list.raw.json',
          content: { a: 1 },
          mediaType: 'application/json',
        } as unknown as { relativePath: string; content: unknown; mediaType: string },
        { relativePath: 'native/extra.txt', content: 123, mediaType: 'text/plain' } as unknown as {
          relativePath: string;
          content: unknown;
          mediaType: string;
        },
      ],
      sourceFingerprint: 'fp-text',
    };
    const parsed = parseDevinBundle(bundle);
    expect(parsed.rootTranscriptText).toBe('{"type":"session","id":"s1","ts":1,"order":1}\n');
    expect(parsed.models).toHaveLength(0);
    expect(parsed.modelsRaw).toBe('{"a":1}');
  });

  it('picks the highest leaf when no main_chain_id is given', () => {
    const jsonl = [
      '{"type":"session","id":"s1","ts":1,"order":1}',
      '{"type":"message","session_id":"s1","node_id":1,"parent_node_id":null,"chat_message":"{}","order":2}',
      '{"type":"message","session_id":"s1","node_id":2,"parent_node_id":1,"chat_message":"{}","order":3}',
      '{"type":"message","session_id":"s1","node_id":3,"parent_node_id":1,"chat_message":"{}","order":4}',
    ].join('\n');
    const bundle = {
      artifacts: [
        { relativePath: 'transcript.jsonl', content: jsonl, mediaType: 'application/jsonl' },
      ],
      sourceFingerprint: 'fp-leaf',
    };
    const parsed = parseDevinBundle(bundle);
    expect(parsed.orderedMessages.map((m) => m.nodeId)).toEqual([1, 2, 3]);
  });

  it('returns no root when the bundle has no recognized root artifact', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'native/schema-descriptor.json',
          content: '{"refineryVersion":16,"supported":true}',
          mediaType: 'application/json',
        },
      ],
      sourceFingerprint: 'fp-noroot',
    };
    const parsed = parseDevinBundle(bundle);
    expect(parsed.rootTranscriptText).toBeUndefined();
    expect(parsed.orderedMessages).toHaveLength(0);
  });
});

describe('Branch coverage: session spine', () => {
  it('builds a session record from context source identity', () => {
    const session = { id: 's1', metadata: null } as unknown as Parameters<
      typeof buildSessionSpine
    >[1];
    const result = buildSessionSpine(
      's1',
      session,
      [],
      [{ timestamp: '2026-08-01T12:00:00.000Z' }],
      'artifact-1',
    );
    expect(result.records[0]?.recordType).toBe('session');
  });

  it('handles messages with object chat_message and missing ids', () => {
    const session = { id: 's1', metadata: null } as unknown as Parameters<
      typeof buildSessionSpine
    >[1];
    const messages = [
      {
        type: 'message',
        nodeId: 1,
        parentNodeId: null,
        chatMessage: { role: 'user', message_id: 'm1', content: 'hi' },
        role: 'user',
        rawRole: 'user',
        rawContent: 'hi',
      },
      {
        type: 'message',
        nodeId: 2,
        parentNodeId: 1,
        chatMessage: { content: { key: 'value' } },
        role: 'assistant',
        rawRole: 'assistant',
        rawContent: '',
      },
    ] as unknown as Parameters<typeof buildSessionSpine>[2];
    const result = buildSessionSpine('s1', session, messages, [], 'artifact-1');
    expect(result.records.filter((r) => r.recordType === 'message').length).toBe(2);
    const messageRecords = result.records.filter((r) => r.recordType === 'message');
    const payload = messageRecords[1]?.payload as { content?: unknown };
    expect(payload?.content).toBeUndefined();
  });
});

describe('Branch coverage: transformer detection', () => {
  it('detects non-string artifact content as unrecognized', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: new Uint8Array([1, 2, 3]),
          mediaType: 'application/jsonl',
        } as unknown as { relativePath: string; content: unknown; mediaType: string },
      ],
      sourceFingerprint: 'fp-bin',
    };
    const result = DevinTransformer.detect(bundle);
    expect(result.kind).toBe('unmatched');
  });

  it('detects an invalid ATIF artifact as unrecognised', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'native/atif-transcript.json',
          content: '{bad json',
          mediaType: 'application/json',
        },
      ],
      sourceFingerprint: 'fp-bad-atif',
    };
    const result = DevinTransformer.detect(bundle);
    expect(result.kind).toBe('unmatched');
  });
});

describe('Branch coverage: toTextContent export', () => {
  it('coerces values to text or undefined', () => {
    expect(toTextContent('hello')).toBe('hello');
    expect(toTextContent(null)).toBeUndefined();
    expect(toTextContent(undefined)).toBeUndefined();
    expect(toTextContent({ a: 1 })).toBe('{"a":1}');
    expect(toTextContent(42)).toBe('42');
    const buf = new ArrayBuffer(3);
    expect(typeof toTextContent(buf)).toBe('string');
  });
});
