import {
  parseAtifTranscript,
  parseDevinJsonlText,
  parseDevinModelsJson,
  parseSchemaDescriptor,
} from '@lucasschirm/sal-devin-session-parser';
import type {
  Artifact,
  ArtifactClassificationResult,
  ArtifactKind,
  ArtifactScope,
  ClassifiedArtifact,
  ComponentSummary,
  ConfigurationSnapshot,
  Issue,
} from '@lucasschirm/sal-transformer-shared';

const DEVIN_KINDS: Readonly<
  Record<string, { kind: ArtifactKind; scope: ArtifactScope; role?: string }>
> = {
  '^transcript\\.jsonl$': { kind: 'transcript', scope: 'session' },
  '^native/atif-transcript\\.json$': { kind: 'transcript', scope: 'session', role: 'native' },
  '^native/schema-descriptor\\.json$': { kind: 'settings', scope: 'runtime', role: 'schema' },
  '^native/models\\.json$': { kind: 'settings', scope: 'runtime', role: 'models' },
  '^native/models-list\\.raw\\.json$': { kind: 'settings', scope: 'runtime', role: 'models-raw' },
  '^plans/plan-[a-f0-9]+\\.md$': { kind: 'transcript', scope: 'session', role: 'plan' },
  '^\\.devin/config\\.json$': { kind: 'settings', scope: 'workspace' },
  '^config\\.json$': { kind: 'settings', scope: 'global' },
};

const ALL_COMPONENT_KINDS: readonly string[] = [
  'tool',
  'skill',
  'agent',
  'subagent',
  'rule',
  'mcp',
  'settings',
  'model',
  'unknown',
];

function toTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return undefined;
  if (content instanceof Uint8Array) return decodeUtf8(content);
  if (content instanceof ArrayBuffer) return decodeUtf8(new Uint8Array(content));
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      result += String.fromCharCode(b1);
    } else if (b1 < 0xc0) {
    } else if (b1 < 0xe0) {
      const b2 = bytes[i++];
      result += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 < 0xf0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      result += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      const codePoint =
        ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      const adjusted = codePoint - 0x10000;
      result += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    }
  }
  return result;
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

function pathRule(
  relativePath: string,
): { kind: ArtifactKind; scope: ArtifactScope; role?: string } | undefined {
  const normalized = normalizeSlashes(relativePath).toLowerCase();
  for (const [pattern, rule] of Object.entries(DEVIN_KINDS)) {
    if (new RegExp(pattern, 'i').test(normalized)) return rule;
  }
  return undefined;
}

function inferMediaType(relativePath: string, fallback: string): string {
  const normalized = normalizeSlashes(relativePath).toLowerCase();
  if (normalized.endsWith('.jsonl')) return 'application/jsonl';
  if (normalized.endsWith('.json')) return 'application/json';
  if (normalized.endsWith('.md')) return 'text/markdown';
  if (fallback && fallback !== 'application/octet-stream') return fallback;
  return 'text/plain';
}

function artifactIdFor(artifact: { relativePath: string; sha256?: string }): string {
  return artifact.sha256 ? `sha256:${artifact.sha256}` : `path:${artifact.relativePath}`;
}

function isDevinJsonlTranscript(text: string): boolean {
  const first = text.split('\n').find((line) => line.trim().length > 0);
  if (!first) return false;
  const parsed = parseDevinJsonlText(first).lines;
  return parsed.length > 0;
}

function isAtifTranscript(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    const result = parseAtifTranscript(parsed);
    return result.ok;
  } catch {
    return false;
  }
}

function isModelsList(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    const result = parseDevinModelsJson(parsed);
    return result.models.length > 0 || result.warnings.length === 0;
  } catch {
    return false;
  }
}

function isSchemaDescriptor(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return parseSchemaDescriptor(parsed) !== null;
  } catch {
    return false;
  }
}

function contentConfirmedKind(
  rule: { kind: ArtifactKind; scope: ArtifactScope; role?: string },
  content: string,
): { kind: ArtifactKind; scope: ArtifactScope; role?: string; confirmed: boolean } {
  if (rule.kind === 'transcript' && rule.role === 'native') {
    return { ...rule, confirmed: isAtifTranscript(content) };
  }
  if (rule.kind === 'transcript' && rule.role === 'plan') {
    return { ...rule, confirmed: content.length > 0 };
  }
  if (rule.kind === 'transcript') {
    return { ...rule, confirmed: isDevinJsonlTranscript(content) };
  }
  if (rule.role === 'models' || rule.role === 'models-raw') {
    return { ...rule, confirmed: isModelsList(content) };
  }
  if (rule.role === 'schema') {
    return { ...rule, confirmed: isSchemaDescriptor(content) };
  }
  if (rule.kind === 'settings') {
    return { ...rule, confirmed: true };
  }
  return { ...rule, confirmed: false };
}

function classifyByRule(artifact: Artifact<unknown>): {
  classified: ClassifiedArtifact;
  detectedKind: string;
} {
  const rule = pathRule(artifact.relativePath);
  const content = toTextContent(artifact.content) ?? '';
  if (!rule) {
    return {
      classified: {
        relativePath: artifact.relativePath,
        kind: 'unclassified',
        scope: 'runtime',
        mediaType: inferMediaType(artifact.relativePath, artifact.mediaType),
        sha256: artifact.sha256,
        confidence: 'unclassified',
        reason: 'path does not match any supported Devin artifact pattern',
      },
      detectedKind: 'unknown',
    };
  }
  const confirmed = contentConfirmedKind(rule, content);
  const confidence = confirmed.confirmed ? 'exact' : 'inferred';
  const reason = confirmed.confirmed
    ? undefined
    : 'path matches a Devin pattern but content could not be schema-validated';
  return {
    classified: {
      relativePath: artifact.relativePath,
      kind: confirmed.kind,
      scope: confirmed.scope,
      role: confirmed.role,
      mediaType: inferMediaType(artifact.relativePath, artifact.mediaType),
      sha256: artifact.sha256,
      confidence,
      reason,
    },
    detectedKind: `${confirmed.kind}${confirmed.role ? `:${confirmed.role}` : ''}`,
  };
}

export function completenessFromComponents(
  components: ComponentSummary[],
  unclassifiedCount: number,
): ConfigurationSnapshot['completeness'] {
  const counts = new Map<string, number>();
  for (const c of components) {
    counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  }
  const completeness: Record<string, 'complete' | 'partial' | 'unavailable' | 'unsupported'> = {};
  for (const kind of ALL_COMPONENT_KINDS) {
    if ((counts.get(kind) ?? 0) > 0) {
      completeness[kind] = unclassifiedCount > 0 ? 'partial' : 'complete';
    } else {
      completeness[kind] = 'unavailable';
    }
  }
  return completeness;
}

function makeIssue(
  code: string,
  message: string,
  severity: 'warning' | 'fatal' | 'recoverable',
  path?: string,
): Issue {
  return { code, severity, message, provenance: path ? { path } : undefined };
}

export function classifyDevinArtifacts(
  artifacts: readonly Artifact<unknown>[],
): ArtifactClassificationResult {
  const classifiedArtifacts: ClassifiedArtifact[] = [];
  const warnings: Issue[] = [];
  let unclassifiedCount = 0;

  for (const artifact of artifacts) {
    const { classified, detectedKind } = classifyByRule(artifact);
    classifiedArtifacts.push(classified);
    if (classified.kind === 'unclassified') {
      unclassifiedCount++;
      warnings.push(
        makeIssue(
          'unclassified_artifact',
          `${artifact.relativePath} is unclassified (detected kind: ${detectedKind})`,
          'warning',
          artifact.relativePath,
        ),
      );
    }
  }

  const components: ComponentSummary[] = [];

  return {
    artifacts: classifiedArtifacts,
    components,
    configurationSnapshot: {
      completeness: completenessFromComponents(components, unclassifiedCount),
      components,
    },
    warnings,
  };
}

export { artifactIdFor, toTextContent };
