import type {
  ArtifactReference,
  ArtifactRetentionClass,
  CaseSensitivity,
  InsertArtifactBlobInput,
  SqliteExecutor,
  SqliteTransaction,
} from '@lucasschirm/sal-db-core';
import {
  ArtifactBlobStore,
  ArtifactReferenceStore,
  ManifestArtifactStore,
  RetentionPolicyStore,
} from '@lucasschirm/sal-db-core';
import type { ArtifactDiff, DiffLine, MetadataChange, SideBySideDiff } from './analytics.js';
import type { ArtifactContent, ContentHasher } from './ports.js';

// TextEncoder/TextDecoder are stable globals in Node and browsers but are not
// part of the ES2021 lib used by this package. These local declarations keep
// the module runtime-agnostic.
interface TextEncoder {
  encode(input: string): Uint8Array;
}
declare const TextEncoder: { new (): TextEncoder };

interface TextDecoder {
  decode(input?: Uint8Array): string;
}
declare const TextDecoder: { new (): TextDecoder };

export interface CanonicalizationRuleSet {
  readonly lineEnding?: boolean;
  readonly unicode?: boolean;
  readonly jsonKeyOrder?: boolean;
  readonly generatedField?: boolean;
  readonly comment?: boolean;
  readonly pathCase?: boolean;
  readonly redaction?: boolean;
  readonly behaviorFields?: readonly string[];
  readonly generatedFields?: readonly string[];
  readonly redactionPatterns?: readonly string[];
}

export const DEFAULT_CANONICALIZATION_RULES: CanonicalizationRuleSet = {
  lineEnding: true,
  unicode: true,
  jsonKeyOrder: true,
  generatedField: true,
  comment: true,
  pathCase: true,
  redaction: false,
  behaviorFields: [],
  generatedFields: ['id', 'uuid', 'timestamp', 'createdAt', 'updatedAt', 'generatedAt', 'etag'],
  redactionPatterns: [],
};

const DEFAULT_BEHAVIOR_FIELDS: readonly string[] = [
  'scope',
  'globs',
  'permissions',
  'allowed',
  'model',
  'schema',
  'tools',
  'enabled',
  'disabled',
  'name',
  'description',
  'instructions',
  'prompt',
  'rules',
  'mcpServers',
  'mcp_servers',
  'command',
  'args',
  'env',
  'url',
  'include',
  'exclude',
];

export interface ComponentCanonicalizationInput {
  readonly componentId?: string;
  readonly kind: string;
  readonly sourcePointer: string;
  readonly behaviorFields?: readonly string[];
}

export interface ArtifactCanonicalizationInput {
  readonly harness: string;
  readonly kind: string;
  readonly content: ArtifactContent | null;
  readonly relativePath: string;
  readonly caseSensitivity?: CaseSensitivity;
  readonly classifierVersion: string;
  readonly canonicalizerVersion: string;
  readonly rules?: CanonicalizationRuleSet;
  readonly components?: readonly ComponentCanonicalizationInput[];
  readonly sensitiveSource?: {
    readonly scheme: string;
    readonly keyDomainId: string;
    readonly content: ArtifactContent;
  } | null;
}

export interface ComponentCanonicalizationResult {
  readonly componentId?: string;
  readonly kind: string;
  readonly sourcePointer: string;
  readonly rawSha256: string;
  readonly normalizedSha256: string;
  readonly behaviorSha256: string;
  readonly behaviorSummary: Record<string, unknown>;
  readonly isPurged?: boolean;
}

export interface CanonicalizedArtifact {
  readonly harness: string;
  readonly kind: string;
  readonly relativePath: string;
  readonly caseSensitivity: CaseSensitivity;
  readonly classifierVersion: string;
  readonly canonicalizerVersion: string;
  readonly canonicalizationVersion: string;
  readonly rulesApplied: string;
  readonly rawSha256: string;
  readonly normalizedSha256: string;
  readonly behaviorSha256: string;
  readonly behaviorSummary: Record<string, unknown>;
  readonly sensitiveDigest: string | null;
  readonly sensitiveDigestScheme: string | null;
  readonly keyDomainId: string | null;
  readonly redactionChangeMarker: boolean;
  readonly isPurged: boolean;
  readonly components: readonly ComponentCanonicalizationResult[];
  readonly content: ArtifactContent | null;
  readonly normalizedText: string;
  readonly behaviorText: string;
}

export interface ArtifactVersionDiff extends ArtifactDiff {
  readonly contentAvailable: boolean;
  readonly concurrentChanges: readonly string[];
  readonly observationalCohorts: readonly {
    readonly sessionId: string;
    readonly left: boolean;
    readonly right: boolean;
  }[];
  readonly componentDiffs: readonly ComponentDiff[];
}

export interface ComponentDiff {
  readonly componentId?: string;
  readonly kind: string;
  readonly sourcePointer: string;
  readonly rawSha256: string;
  readonly left: ComponentCanonicalizationResult;
  readonly right: ComponentCanonicalizationResult;
  readonly unifiedDiff?: string;
  readonly sideBySideDiff?: SideBySideDiff;
  readonly metadataChanges: readonly MetadataChange[];
}

export interface ArtifactDiffContext {
  readonly leftSessions?: readonly string[];
  readonly rightSessions?: readonly string[];
  readonly concurrentChanges?: readonly string[];
}

type DiffOp =
  | {
      readonly type: 'equal';
      readonly oldIndex: number;
      readonly newIndex: number;
      readonly text: string;
    }
  | { readonly type: 'insert'; readonly newIndex: number; readonly text: string }
  | { readonly type: 'delete'; readonly oldIndex: number; readonly text: string }
  | {
      readonly type: 'replace';
      readonly oldIndex: number;
      readonly newIndex: number;
      readonly deleteText: string;
      readonly insertText: string;
    };

function asString(content: ArtifactContent | null | undefined): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return new TextDecoder().decode(content);
}

function asBytes(content: ArtifactContent): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content;
}

function mergeRules(rules?: CanonicalizationRuleSet | null): CanonicalizationRuleSet {
  const base = { ...DEFAULT_CANONICALIZATION_RULES };
  if (!rules) return base;
  return {
    ...base,
    ...rules,
    generatedFields: rules.generatedFields ?? DEFAULT_CANONICALIZATION_RULES.generatedFields,
    redactionPatterns: rules.redactionPatterns ?? DEFAULT_CANONICALIZATION_RULES.redactionPatterns,
  };
}

function stableStringify(value: unknown, space?: number): string {
  if (value === undefined) return 'null';
  return (
    JSON.stringify(
      value,
      (_key: string, val: unknown) => {
        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(val).sort()) {
            sorted[k] = (val as Record<string, unknown>)[k];
          }
          return sorted;
        }
        return val;
      },
      space,
    ) ?? 'null'
  );
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function removeComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const nextTwo = text.slice(i, i + 2);
    if (c === '"' || c === "'" || c === '`') {
      const end = findStringEnd(text, i, c);
      out.push(text.slice(i, end));
      i = end;
      continue;
    }
    if (nextTwo === '//') {
      const eol = text.indexOf('\n', i);
      if (eol === -1) break;
      out.push('\n');
      i = eol;
      continue;
    }
    if (nextTwo === '/*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (nextTwo === '<!' && text.slice(i, i + 4) === '<!--') {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

function findStringEnd(text: string, start: number, quote: string): number {
  let escaped = false;
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (escaped) {
      escaped = false;
    } else if (c === '\\') {
      escaped = true;
    } else if (c === quote) {
      return i + 1;
    }
    i++;
  }
  return text.length;
}

function removeGeneratedFields(value: unknown, fields: readonly string[]): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => removeGeneratedFields(v, fields));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!fields.includes(k)) {
      result[k] = removeGeneratedFields(v, fields);
    }
  }
  return result;
}

function sortJsonKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = sortJsonKeys((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

function canonicalizeJson(text: string, rules: CanonicalizationRuleSet): string {
  const cleaned = rules.comment ? removeComments(text) : text;
  const parsed = safeJsonParse(cleaned);
  if (parsed === null) return cleaned;
  let value = rules.generatedField
    ? removeGeneratedFields(parsed, rules.generatedFields ?? [])
    : parsed;
  value = rules.jsonKeyOrder ? sortJsonKeys(value) : value;
  return stableStringify(value, 2);
}

function canonicalizeText(text: string, rules: CanonicalizationRuleSet): string {
  let result = text;
  if (rules.lineEnding) {
    result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
  if (rules.unicode) {
    result = result.normalize('NFC');
  }
  if (rules.comment) {
    result = removeComments(result);
  }
  if (rules.jsonKeyOrder || rules.generatedField) {
    result = canonicalizeJson(result, rules);
  }
  if (rules.redaction && rules.redactionPatterns && rules.redactionPatterns.length > 0) {
    for (const pattern of rules.redactionPatterns) {
      result = result.replace(new RegExp(pattern, 'g'), '[REDACTED]');
    }
  }
  return result;
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return value;
  const parts = pointer.split('/').slice(1).map(decodePointerPart);
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function decodePointerPart(part: string): string {
  return part.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parseSourcePointer(pointer: string): {
  jsonPointer?: string;
  range?: { start: number; end: number };
} {
  if (pointer.startsWith('/')) {
    return { jsonPointer: pointer };
  }
  const parsed = safeJsonParse(pointer);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const jsonPointer = typeof obj.jsonPointer === 'string' ? obj.jsonPointer : undefined;
    const path = typeof obj.path === 'string' ? obj.path : undefined;
    const range =
      obj.range && typeof obj.range === 'object' && !Array.isArray(obj.range)
        ? (obj.range as { start: number; end: number })
        : undefined;
    return { jsonPointer: jsonPointer ?? path, range };
  }
  return {};
}

function extractBySourcePointer(
  content: ArtifactContent | null,
  pointer: string,
): ArtifactContent | null {
  if (content === null || content === undefined) return null;
  const parsed = parseSourcePointer(pointer);
  if (parsed.range !== undefined) {
    const text = asString(content);
    return text.slice(parsed.range.start, parsed.range.end);
  }
  if (parsed.jsonPointer !== undefined) {
    const text = asString(content);
    const value = safeJsonParse(text);
    if (value === null) return null;
    const extracted = resolveJsonPointer(value, parsed.jsonPointer);
    if (extracted === undefined) return null;
    return stableStringify(extracted, 2);
  }
  return null;
}

function resolveBehaviorFields(kind: string, requested?: readonly string[]): readonly string[] {
  if (requested !== undefined && requested.length > 0) return requested;
  if (kind === 'mcp' || kind === 'mcp_server') {
    return ['command', 'args', 'env', 'url', 'tools', 'disabled', 'enabled'];
  }
  if (kind === 'settings' || kind === 'setting') {
    return ['model', 'permissions', 'allowed', 'enabled', 'disabled', 'scope', 'globs'];
  }
  if (kind === 'skill') {
    return ['name', 'description', 'globs', 'scope', 'model', 'tools', 'permissions'];
  }
  if (kind === 'agent') {
    return ['name', 'description', 'model', 'tools', 'instructions', 'permissions', 'scope'];
  }
  if (kind === 'rule') {
    return ['rules', 'globs', 'scope', 'description', 'model'];
  }
  return DEFAULT_BEHAVIOR_FIELDS;
}

function extractBehaviorSummary(
  value: unknown,
  kind: string,
  requested?: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {};
  const obj = value as Record<string, unknown>;
  const fields = resolveBehaviorFields(kind, requested);
  const summary: Record<string, unknown> = {};
  for (const field of fields) {
    // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is not in the configured lib.
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      summary[field] = obj[field];
    }
  }
  return summary;
}

function computeLcs(left: readonly string[], right: readonly string[]): DiffOp[] {
  const m = left.length;
  const n = right.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (left[i - 1] === right[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && left[i - 1] === right[j - 1]) {
      ops.unshift({ type: 'equal', oldIndex: i - 1, newIndex: j - 1, text: left[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'insert', newIndex: j - 1, text: right[j - 1] });
      j--;
    } else {
      ops.unshift({ type: 'delete', oldIndex: i - 1, text: left[i - 1] });
      i--;
    }
  }
  return ops;
}

function mergeReplaceOps(ops: readonly DiffOp[]): DiffOp[] {
  const merged: DiffOp[] = [];
  for (let i = 0; i < ops.length; i++) {
    const current = ops[i];
    const next = ops[i + 1];
    if (current.type === 'delete' && i + 1 < ops.length && next && next.type === 'insert') {
      merged.push({
        type: 'replace',
        oldIndex: current.oldIndex,
        newIndex: next.newIndex,
        deleteText: current.text,
        insertText: next.text,
      });
      i++;
    } else {
      merged.push(current);
    }
  }
  return merged;
}

export class ArtifactCanonicalizer {
  constructor(private readonly hasher: ContentHasher) {}

  async canonicalize(input: ArtifactCanonicalizationInput): Promise<CanonicalizedArtifact> {
    const rules = mergeRules(input.rules);
    const caseSensitivity = input.caseSensitivity ?? 'unknown';
    const relativePath =
      rules.pathCase && caseSensitivity !== 'sensitive'
        ? input.relativePath.toLowerCase()
        : input.relativePath;
    const isPurged = input.content === null;

    let rawSha256 = '';
    let normalizedText = '';
    let normalizedSha256 = '';
    let behaviorSummary: Record<string, unknown> = {};
    let behaviorText = '';
    let behaviorSha256 = '';

    if (!isPurged && input.content !== undefined) {
      const bytes = asBytes(input.content);
      rawSha256 = await this.hasher.hash(bytes);
      normalizedText = canonicalizeText(asString(input.content), rules);
      normalizedSha256 = await this.hasher.hash(normalizedText);
      const parsed = safeJsonParse(normalizedText);
      behaviorSummary = extractBehaviorSummary(
        parsed ?? input.content,
        input.kind,
        rules.behaviorFields,
      );
      behaviorText = stableStringify(behaviorSummary, 2);
      behaviorSha256 = await this.hasher.hash(behaviorText);
    }

    const rulesApplied = stableStringify(rules, 0);
    const ruleKey = await this.hasher.hash(rulesApplied);
    const canonicalizationVersion = `${input.harness}:${input.kind}:${input.canonicalizerVersion}:${ruleKey}`;

    let sensitiveDigest: string | null = null;
    let sensitiveDigestScheme: string | null = null;
    let keyDomainId: string | null = null;
    let redactionChangeMarker = false;
    if (input.sensitiveSource) {
      sensitiveDigest = await this.computeSensitiveDigest(
        input.sensitiveSource.scheme,
        input.sensitiveSource.keyDomainId,
        input.sensitiveSource.content,
      );
      sensitiveDigestScheme = input.sensitiveSource.scheme;
      keyDomainId = input.sensitiveSource.keyDomainId;
      redactionChangeMarker = true;
    }

    const components: ComponentCanonicalizationResult[] = [];
    if (input.components && input.components.length > 0 && !isPurged && input.content !== null) {
      for (const component of input.components) {
        const componentContent = extractBySourcePointer(input.content, component.sourcePointer);
        const componentPurged = componentContent === null || componentContent === undefined;
        let compRawSha = '';
        let compNormText = '';
        let compNormSha = '';
        let compBehaviorSummary: Record<string, unknown> = {};
        let compBehaviorText = '';
        let compBehaviorSha = '';
        if (!componentPurged && componentContent !== null && componentContent !== undefined) {
          const compRawBytes = asBytes(componentContent);
          compRawSha = await this.hasher.hash(compRawBytes);
          compNormText = canonicalizeText(asString(componentContent), rules);
          compNormSha = await this.hasher.hash(compNormText);
          const compParsed = safeJsonParse(compNormText);
          compBehaviorSummary = extractBehaviorSummary(
            compParsed ?? safeJsonParse(asString(componentContent)),
            component.kind,
            component.behaviorFields,
          );
          compBehaviorText = stableStringify(compBehaviorSummary, 2);
          compBehaviorSha = await this.hasher.hash(compBehaviorText);
        }
        components.push({
          componentId: component.componentId,
          kind: component.kind,
          sourcePointer: component.sourcePointer,
          rawSha256: compRawSha,
          normalizedSha256: compNormSha,
          behaviorSha256: compBehaviorSha,
          behaviorSummary: compBehaviorSummary,
          isPurged: componentPurged,
        });
      }
    }

    return {
      harness: input.harness,
      kind: input.kind,
      relativePath,
      caseSensitivity,
      classifierVersion: input.classifierVersion,
      canonicalizerVersion: input.canonicalizerVersion,
      canonicalizationVersion,
      rulesApplied,
      rawSha256,
      normalizedSha256,
      behaviorSha256,
      behaviorSummary,
      sensitiveDigest,
      sensitiveDigestScheme,
      keyDomainId,
      redactionChangeMarker,
      isPurged,
      components,
      content: input.content,
      normalizedText,
      behaviorText,
    };
  }

  async computeSensitiveDigest(
    scheme: string,
    keyDomainId: string,
    content: ArtifactContent,
  ): Promise<string> {
    const contentHash = await this.hasher.hash(content);
    return this.hasher.hash(`${scheme}:${keyDomainId}:${contentHash}`);
  }

  async rekeySensitiveDigest(
    scheme: string,
    digest: string,
    oldKeyDomainId: string,
    newKeyDomainId: string,
    content: ArtifactContent,
  ): Promise<string> {
    const recomputed = await this.computeSensitiveDigest(scheme, oldKeyDomainId, content);
    if (recomputed !== digest) {
      throw new Error('Sensitive digest does not match the provided old key domain');
    }
    return this.computeSensitiveDigest(scheme, newKeyDomainId, content);
  }
}

export class ArtifactDiffEngine {
  constructor(readonly _hasher: ContentHasher) {}

  async computeDiff(
    left: CanonicalizedArtifact,
    right: CanonicalizedArtifact,
    context?: ArtifactDiffContext,
  ): Promise<ArtifactVersionDiff> {
    const contentAvailable = !left.isPurged && !right.isPurged;
    const leftLines = left.isPurged ? [] : left.normalizedText.split('\n');
    const rightLines = right.isPurged ? [] : right.normalizedText.split('\n');
    const unifiedDiff = contentAvailable
      ? this.computeUnifiedDiff(leftLines, rightLines)
      : undefined;
    const sideBySideDiff = contentAvailable
      ? this.computeSideBySideDiff(leftLines, rightLines)
      : undefined;
    const metadataChanges = this.computeMetadataChanges(left, right);
    const sessionExposure = this.buildSessionExposure(context);
    const componentDiffs = this.computeComponentDiffs(left, right);

    return {
      artifactId: left.relativePath,
      leftVersion: left.canonicalizationVersion,
      rightVersion: right.canonicalizationVersion,
      unifiedDiff,
      sideBySideDiff,
      metadataChanges,
      sessionExposure,
      contentAvailable,
      concurrentChanges: context?.concurrentChanges ?? [],
      observationalCohorts: this.buildCohorts(context),
      componentDiffs,
    };
  }

  computeUnifiedDiff(leftLines: readonly string[], rightLines: readonly string[]): string {
    const ops = mergeReplaceOps(computeLcs(leftLines, rightLines));
    const lines: string[] = [];
    let _oldLine = 0;
    let _newLine = 0;
    for (const op of ops) {
      if (op.type === 'equal') {
        _oldLine++;
        _newLine++;
        lines.push(` ${op.text}`);
      } else if (op.type === 'delete') {
        _oldLine++;
        lines.push(`-${op.text}`);
      } else if (op.type === 'insert') {
        _newLine++;
        lines.push(`+${op.text}`);
      } else if (op.type === 'replace') {
        _oldLine++;
        lines.push(`-${op.deleteText}`);
        _newLine++;
        lines.push(`+${op.insertText}`);
      }
    }
    const header = `--- left\n+++ right\n@@ -1,${leftLines.length} +1,${rightLines.length} @@\n`;
    return header + lines.join('\n');
  }

  computeSideBySideDiff(
    leftLines: readonly string[],
    rightLines: readonly string[],
  ): SideBySideDiff {
    const ops = mergeReplaceOps(computeLcs(leftLines, rightLines));
    const left: DiffLine[] = [];
    const right: DiffLine[] = [];
    let oldLine = 0;
    let newLine = 0;
    for (const op of ops) {
      if (op.type === 'equal') {
        oldLine++;
        newLine++;
        left.push({ lineNumber: oldLine, text: op.text, changeType: 'unchanged' });
        right.push({ lineNumber: newLine, text: op.text, changeType: 'unchanged' });
      } else if (op.type === 'delete') {
        oldLine++;
        left.push({ lineNumber: oldLine, text: op.text, changeType: 'removed' });
        right.push({ lineNumber: 0, text: '', changeType: 'unchanged' });
      } else if (op.type === 'insert') {
        newLine++;
        left.push({ lineNumber: 0, text: '', changeType: 'unchanged' });
        right.push({ lineNumber: newLine, text: op.text, changeType: 'added' });
      } else if (op.type === 'replace') {
        oldLine++;
        newLine++;
        left.push({ lineNumber: oldLine, text: op.deleteText, changeType: 'removed' });
        right.push({ lineNumber: newLine, text: op.insertText, changeType: 'added' });
      }
    }
    return { left, right };
  }

  private buildSessionExposure(context?: ArtifactDiffContext): Record<string, number> {
    const exposure: Record<string, number> = {};
    for (const sessionId of context?.leftSessions ?? []) {
      exposure[sessionId] = (exposure[sessionId] ?? 0) + 1;
    }
    for (const sessionId of context?.rightSessions ?? []) {
      exposure[sessionId] = (exposure[sessionId] ?? 0) + 1;
    }
    return exposure;
  }

  private buildCohorts(context?: ArtifactDiffContext) {
    const map = new Map<string, { left: boolean; right: boolean }>();
    for (const sessionId of context?.leftSessions ?? []) {
      const current = map.get(sessionId) ?? { left: false, right: false };
      current.left = true;
      map.set(sessionId, current);
    }
    for (const sessionId of context?.rightSessions ?? []) {
      const current = map.get(sessionId) ?? { left: false, right: false };
      current.right = true;
      map.set(sessionId, current);
    }
    return Array.from(map.entries()).map(([sessionId, flags]) => ({ sessionId, ...flags }));
  }

  private computeComponentDiffs(
    left: CanonicalizedArtifact,
    right: CanonicalizedArtifact,
  ): ComponentDiff[] {
    const leftMap = new Map<string, ComponentCanonicalizationResult>();
    const rightMap = new Map<string, ComponentCanonicalizationResult>();
    for (const c of left.components) leftMap.set(c.sourcePointer, c);
    for (const c of right.components) rightMap.set(c.sourcePointer, c);
    const pointers = new Set([...leftMap.keys(), ...rightMap.keys()]);
    const diffs: ComponentDiff[] = [];
    for (const pointer of pointers) {
      const leftComponent = leftMap.get(pointer) ?? this.purgedComponent(pointer);
      const rightComponent = rightMap.get(pointer) ?? this.purgedComponent(pointer);
      const shouldDiff =
        !left.isPurged && !right.isPurged && !leftComponent.isPurged && !rightComponent.isPurged;
      const unifiedDiff = shouldDiff
        ? this.computeUnifiedDiff(
            this.componentLines(left, leftComponent),
            this.componentLines(right, rightComponent),
          )
        : undefined;
      const sideBySideDiff = shouldDiff
        ? this.computeSideBySideDiff(
            this.componentLines(left, leftComponent),
            this.componentLines(right, rightComponent),
          )
        : undefined;
      const metadataChanges: MetadataChange[] = [];
      this.addIfChanged(metadataChanges, 'kind', leftComponent.kind, rightComponent.kind);
      this.addIfChanged(
        metadataChanges,
        'normalizedSha256',
        leftComponent.normalizedSha256,
        rightComponent.normalizedSha256,
      );
      this.addIfChanged(
        metadataChanges,
        'behaviorSha256',
        leftComponent.behaviorSha256,
        rightComponent.behaviorSha256,
      );
      for (const key of new Set([
        ...Object.keys(leftComponent.behaviorSummary),
        ...Object.keys(rightComponent.behaviorSummary),
      ])) {
        this.addIfChanged(
          metadataChanges,
          `behavior.${key}`,
          leftComponent.behaviorSummary[key],
          rightComponent.behaviorSummary[key],
        );
      }
      diffs.push({
        componentId: leftComponent.componentId ?? rightComponent.componentId,
        kind: leftComponent.kind || rightComponent.kind,
        sourcePointer: pointer,
        rawSha256: leftComponent.rawSha256 || rightComponent.rawSha256,
        left: leftComponent,
        right: rightComponent,
        unifiedDiff,
        sideBySideDiff,
        metadataChanges,
      });
    }
    return diffs;
  }

  private componentLines(
    artifact: CanonicalizedArtifact,
    component: ComponentCanonicalizationResult,
  ): string[] {
    if (artifact.isPurged || component.isPurged || artifact.content === null) return [];
    const extracted = extractBySourcePointer(artifact.content, component.sourcePointer);
    if (extracted === null) return [];
    const parsedRules = safeJsonParse(artifact.rulesApplied ?? '');
    const rules = mergeRules(parsedRules as CanonicalizationRuleSet | undefined | null);
    return canonicalizeText(asString(extracted), rules).split('\n');
  }

  private purgedComponent(sourcePointer: string): ComponentCanonicalizationResult {
    return {
      kind: 'unknown',
      sourcePointer,
      rawSha256: '',
      normalizedSha256: '',
      behaviorSha256: '',
      behaviorSummary: {},
      isPurged: true,
    };
  }

  private computeMetadataChanges(
    left: CanonicalizedArtifact,
    right: CanonicalizedArtifact,
  ): MetadataChange[] {
    const changes: MetadataChange[] = [];
    this.addIfChanged(changes, 'harness', left.harness, right.harness);
    this.addIfChanged(changes, 'kind', left.kind, right.kind);
    this.addIfChanged(
      changes,
      'classifierVersion',
      left.classifierVersion,
      right.classifierVersion,
    );
    this.addIfChanged(
      changes,
      'canonicalizerVersion',
      left.canonicalizerVersion,
      right.canonicalizerVersion,
    );
    this.addIfChanged(
      changes,
      'canonicalizationVersion',
      left.canonicalizationVersion,
      right.canonicalizationVersion,
    );
    this.addIfChanged(changes, 'caseSensitivity', left.caseSensitivity, right.caseSensitivity);
    this.addIfChanged(changes, 'rulesApplied', left.rulesApplied, right.rulesApplied);
    this.addIfChanged(changes, 'relativePath', left.relativePath, right.relativePath);
    this.addIfChanged(changes, 'rawSha256', left.rawSha256, right.rawSha256);
    this.addIfChanged(changes, 'normalizedSha256', left.normalizedSha256, right.normalizedSha256);
    this.addIfChanged(changes, 'behaviorSha256', left.behaviorSha256, right.behaviorSha256);
    this.addIfChanged(changes, 'sensitiveDigest', left.sensitiveDigest, right.sensitiveDigest);
    this.addIfChanged(
      changes,
      'redactionChangeMarker',
      left.redactionChangeMarker,
      right.redactionChangeMarker,
    );
    this.addIfChanged(changes, 'isPurged', left.isPurged, right.isPurged);
    for (const key of new Set([
      ...Object.keys(left.behaviorSummary),
      ...Object.keys(right.behaviorSummary),
    ])) {
      this.addIfChanged(
        changes,
        `behavior.${key}`,
        left.behaviorSummary[key],
        right.behaviorSummary[key],
      );
    }
    return changes;
  }

  private addIfChanged(
    changes: MetadataChange[],
    field: string,
    leftValue: unknown,
    rightValue: unknown,
  ): void {
    const leftString = leftValue === undefined ? null : stableStringify(leftValue, 0);
    const rightString = rightValue === undefined ? null : stableStringify(rightValue, 0);
    if (leftString !== rightString) {
      changes.push({ field, oldValue: leftString, newValue: rightString });
    }
  }
}

export interface ArtifactDiffRecordContext {
  readonly sourceManifestId: string;
  readonly manifestArtifactId: string;
  readonly blobSha256?: string | null;
  readonly observingSessionId?: string | null;
  readonly componentId?: string | null;
  readonly componentVersion?: string | null;
  readonly retentionClass?: ArtifactRetentionClass;
}

export interface CanPurgeScope {
  readonly portfolioId?: string;
  readonly environmentId?: string;
  readonly projectId?: string;
}

export class ArtifactDiffRepository {
  private readonly canonicalizer: ArtifactCanonicalizer;
  private readonly diffEngine: ArtifactDiffEngine;

  constructor(hasher: ContentHasher) {
    this.canonicalizer = new ArtifactCanonicalizer(hasher);
    this.diffEngine = new ArtifactDiffEngine(hasher);
  }

  async record(
    queryable: SqliteExecutor | SqliteTransaction,
    portfolioId: string,
    context: ArtifactDiffRecordContext,
    input: ArtifactCanonicalizationInput,
  ): Promise<readonly string[]> {
    const canonicalized = await this.canonicalizer.canonicalize(input);
    const retentionClass = context.retentionClass ?? 'retained';
    const blobSha256 = (context.blobSha256 ?? canonicalized.rawSha256) || null;

    if (canonicalized.content !== null && blobSha256) {
      const existing = await ArtifactBlobStore.getBySha256(queryable, blobSha256);
      if (!existing) {
        const insert: InsertArtifactBlobInput = {
          sha256: blobSha256,
          mediaType: null,
          retentionClass,
          content: asBytes(canonicalized.content),
          size: asBytes(canonicalized.content).length,
          redactionScheme: canonicalized.sensitiveDigestScheme,
          keyDomainId: canonicalized.keyDomainId,
          sensitiveDigest: canonicalized.sensitiveDigest,
          redactionChangeMarker: canonicalized.redactionChangeMarker,
          isRedacted: canonicalized.sensitiveDigest !== null,
        };
        await ArtifactBlobStore.insert(queryable, insert);
      }
    }

    const referenceId = await ArtifactReferenceStore.insert(queryable, portfolioId, {
      sourceManifestId: context.sourceManifestId,
      manifestArtifactId: context.manifestArtifactId,
      blobSha256,
      observingSessionId: context.observingSessionId,
      componentKind: input.kind,
      componentId: context.componentId,
      componentVersion: context.componentVersion,
      sourcePointer: '',
      rawSha256: canonicalized.rawSha256,
      normalizedSha256: canonicalized.normalizedSha256,
      behaviorSha256: canonicalized.behaviorSha256,
      canonicalizationVersion: canonicalized.canonicalizationVersion,
      classifierVersion: canonicalized.classifierVersion,
      rulesApplied: canonicalized.rulesApplied,
      caseSensitivity: canonicalized.caseSensitivity,
      relationship: 'contains',
    });

    const ids: string[] = [referenceId];
    for (const component of canonicalized.components) {
      const componentReferenceId = await ArtifactReferenceStore.insert(queryable, portfolioId, {
        sourceManifestId: context.sourceManifestId,
        manifestArtifactId: context.manifestArtifactId,
        blobSha256,
        observingSessionId: context.observingSessionId,
        componentKind: component.kind,
        componentId: component.componentId ?? `${component.kind}:${component.sourcePointer}`,
        componentVersion: context.componentVersion,
        sourcePointer: component.sourcePointer,
        rawSha256: component.rawSha256,
        normalizedSha256: component.normalizedSha256,
        behaviorSha256: component.behaviorSha256,
        canonicalizationVersion: canonicalized.canonicalizationVersion,
        classifierVersion: canonicalized.classifierVersion,
        rulesApplied: canonicalized.rulesApplied,
        caseSensitivity: canonicalized.caseSensitivity,
        relationship: 'canonicalized',
      });
      ids.push(componentReferenceId);
    }

    return ids;
  }

  async getCanonicalizedArtifact(
    queryable: SqliteExecutor | SqliteTransaction,
    portfolioId: string,
    referenceId: string,
  ): Promise<CanonicalizedArtifact | undefined> {
    const reference = await ArtifactReferenceStore.getById(queryable, portfolioId, referenceId);
    if (!reference) return undefined;
    const artifact = await ManifestArtifactStore.getById(
      queryable,
      portfolioId,
      reference.manifestArtifactId,
    );
    if (!artifact) return undefined;
    const blob = reference.blobSha256
      ? await ArtifactBlobStore.getBySha256(queryable, reference.blobSha256)
      : undefined;
    const content = blob?.content ?? null;
    const rules =
      (safeJsonParse(reference.rulesApplied ?? '') as CanonicalizationRuleSet) ?? undefined;

    let canonicalizerVersion = '';
    let kind = reference.componentKind ?? 'unknown';
    let harness = artifact.harness;
    if (reference.canonicalizationVersion) {
      const parts = reference.canonicalizationVersion.split(':');
      if (parts.length >= 4) {
        harness = parts[0];
        kind = parts[1];
        canonicalizerVersion = parts[2];
      }
    }

    const componentRefs = await this.listComponentReferences(
      queryable,
      portfolioId,
      reference.manifestArtifactId,
    );
    const components: ComponentCanonicalizationInput[] = componentRefs
      .filter((r) => r.id !== reference.id && r.relationship === 'canonicalized')
      .map((r) => ({
        componentId: r.componentId ?? undefined,
        kind: r.componentKind ?? 'unknown',
        sourcePointer: r.sourcePointer ?? '',
      }));

    const canonicalized = await this.canonicalizer.canonicalize({
      harness,
      kind,
      content,
      relativePath: artifact.relativePath,
      caseSensitivity: reference.caseSensitivity ?? 'unknown',
      classifierVersion: reference.classifierVersion ?? '',
      canonicalizerVersion,
      rules,
      components,
    });

    const reconstructedComponents: ComponentCanonicalizationResult[] =
      content === null
        ? componentRefs
            .filter((r) => r.id !== reference.id && r.relationship === 'canonicalized')
            .map((r) => ({
              componentId: r.componentId ?? undefined,
              kind: r.componentKind ?? 'unknown',
              sourcePointer: r.sourcePointer ?? '',
              rawSha256: r.rawSha256 ?? '',
              normalizedSha256: r.normalizedSha256 ?? '',
              behaviorSha256: r.behaviorSha256 ?? '',
              behaviorSummary: {},
              isPurged: true,
            }))
        : [];

    return {
      ...canonicalized,
      components:
        content === null && reconstructedComponents.length > 0
          ? reconstructedComponents
          : canonicalized.components,
      sensitiveDigest: blob?.sensitiveDigest ?? null,
      sensitiveDigestScheme: blob?.redactionScheme ?? null,
      keyDomainId: blob?.keyDomainId ?? null,
      redactionChangeMarker: (blob?.redactionChangeMarker ?? 0) > 0,
    };
  }

  async getDiff(
    queryable: SqliteExecutor | SqliteTransaction,
    portfolioId: string,
    leftReferenceId: string,
    rightReferenceId: string,
  ): Promise<ArtifactVersionDiff | undefined> {
    const left = await this.getCanonicalizedArtifact(queryable, portfolioId, leftReferenceId);
    const right = await this.getCanonicalizedArtifact(queryable, portfolioId, rightReferenceId);
    if (!left || !right) return undefined;

    const leftBlobs = left.isPurged
      ? new Set<string>()
      : new Set([left.rawSha256].filter((s): s is string => s.length > 0));
    const rightBlobs = right.isPurged
      ? new Set<string>()
      : new Set([right.rawSha256].filter((s): s is string => s.length > 0));

    const leftSessions = await this.sessionIdsForBlobs(queryable, portfolioId, leftBlobs);
    const rightSessions = await this.sessionIdsForBlobs(queryable, portfolioId, rightBlobs);
    const concurrent = await this.concurrentChanges(queryable, portfolioId, left, right);

    return this.diffEngine.computeDiff(left, right, {
      leftSessions,
      rightSessions,
      concurrentChanges: concurrent,
    });
  }

  async canPurge(
    queryable: SqliteExecutor | SqliteTransaction,
    portfolioId: string,
    blobSha256: string,
    scope: CanPurgeScope,
    retentionClass: ArtifactRetentionClass,
    mediaType?: string | null,
  ): Promise<{ canPurge: boolean; reason: string }> {
    const policy = await RetentionPolicyStore.resolvePolicy(queryable, {
      retentionClass,
      portfolioId: scope.portfolioId,
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      mediaType,
    });
    if (!policy) {
      return { canPurge: false, reason: 'no explicit retention policy for this artifact class' };
    }

    const { rows: refRows } = await queryable.exec(
      `SELECT COUNT(*) AS c FROM artifact_references r
       JOIN manifest_artifacts a ON a.id = r.manifest_artifact_id
       JOIN source_manifests sm ON sm.id = a.source_manifest_id
       JOIN ingestion_sources src ON src.id = sm.ingestion_source_id
       WHERE r.blob_sha256 = ? AND src.portfolio_id = ?`,
      [blobSha256, portfolioId],
    );
    const referenceCount = Number(refRows[0]?.c ?? 0);

    if (!policy.allowAutoPurge && referenceCount > 0) {
      return { canPurge: false, reason: 'retention policy prohibits auto-purge while referenced' };
    }
    if (referenceCount > 0 && referenceCount < policy.keepMinimum) {
      return { canPurge: false, reason: `keep-minimum of ${policy.keepMinimum} not met` };
    }

    const { rows: lifeRows } = await queryable.exec(
      `SELECT 1 FROM component_lifecycle_events cle
       JOIN artifact_references r ON r.component_version = cle.after_version_id OR r.component_version = cle.before_version_id
       JOIN manifest_artifacts a ON a.id = r.manifest_artifact_id
       JOIN source_manifests sm ON sm.id = a.source_manifest_id
       JOIN ingestion_sources src ON src.id = sm.ingestion_source_id
       WHERE r.blob_sha256 = ? AND src.portfolio_id = ?
       LIMIT 1`,
      [blobSha256, portfolioId],
    );
    if (lifeRows.length > 0) {
      return { canPurge: false, reason: 'blob is referenced by a lifecycle comparison' };
    }

    return { canPurge: true, reason: '' };
  }

  private async listComponentReferences(
    queryable: SqliteExecutor | SqliteTransaction,
    portfolioId: string,
    manifestArtifactId: string,
  ): Promise<readonly ArtifactReference[]> {
    return ArtifactReferenceStore.listByManifestArtifact(
      queryable,
      portfolioId,
      manifestArtifactId,
    );
  }

  private async sessionIdsForBlobs(
    queryable: SqliteExecutor | SqliteTransaction,
    portfolioId: string,
    blobs: Set<string>,
  ): Promise<string[]> {
    if (blobs.size === 0) return [];
    const placeholders = Array.from(blobs)
      .map(() => '?')
      .join(',');
    const { rows } = await queryable.exec(
      `SELECT DISTINCT r.observing_session_id
       FROM artifact_references r
       JOIN manifest_artifacts a ON a.id = r.manifest_artifact_id
       JOIN source_manifests sm ON sm.id = a.source_manifest_id
       JOIN ingestion_sources src ON src.id = sm.ingestion_source_id
       WHERE r.blob_sha256 IN (${placeholders})
         AND r.observing_session_id IS NOT NULL
         AND src.portfolio_id = ?`,
      [...blobs, portfolioId],
    );
    return rows
      .map((row) => (row as { observing_session_id: string | null }).observing_session_id)
      .filter((id): id is string => id !== null && id !== undefined);
  }

  private async concurrentChanges(
    queryable: SqliteExecutor | SqliteTransaction,
    _portfolioId: string,
    _left: CanonicalizedArtifact,
    _right: CanonicalizedArtifact,
  ): Promise<string[]> {
    const { rows } = await queryable.exec(
      `SELECT id, concurrent_event_group_id FROM component_lifecycle_events
       WHERE concurrent_event_group_id IS NOT NULL
       LIMIT 1`,
    );
    const groupIds = new Set<string>();
    for (const row of rows) {
      const groupId = (row as { concurrent_event_group_id: string | null })
        .concurrent_event_group_id;
      if (groupId) groupIds.add(groupId);
    }
    if (groupIds.size === 0) return [];
    const placeholders = Array.from(groupIds)
      .map(() => '?')
      .join(',');
    const { rows: eventRows } = await queryable.exec(
      `SELECT id FROM component_lifecycle_events WHERE concurrent_event_group_id IN (${placeholders})`,
      [...groupIds],
    );
    return eventRows.map((row) => (row as { id: string }).id);
  }
}
