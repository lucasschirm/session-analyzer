import type {
  AtifTranscript,
  DevinJsonlParseResult,
  DevinMessageLine,
  DevinModelRecord,
  DevinPromptLine,
  DevinSessionLine,
  DevinToolCallLine,
  ParseDevinModelsResult,
} from '@lucasschirm/sal-devin-session-parser';
import {
  parseAtifTranscript,
  parseDevinJsonlText,
  parseDevinModelsJson,
  parseSchemaDescriptor,
} from '@lucasschirm/sal-devin-session-parser';
import type { Artifact, Issue, UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';

export interface DevinParsedBundle {
  readonly rootTranscriptText?: string;
  readonly parsedJsonl: DevinJsonlParseResult;
  readonly atif?: AtifTranscript;
  readonly models: readonly DevinModelRecord[];
  readonly modelsRaw?: string;
  readonly schemaDescriptor?: ReturnType<typeof parseSchemaDescriptor>;
  readonly planContent?: string;
  readonly sessionLine?: DevinSessionLine;
  readonly orderedMessages: readonly DevinMessageLine[];
  readonly toolCalls: readonly DevinToolCallLine[];
  readonly prompts: readonly DevinPromptLine[];
  readonly warnings: readonly Issue[];
}

function toText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return undefined;
  if (content instanceof Uint8Array) {
    return decodeUtf8(content);
  }
  if (content instanceof ArrayBuffer) {
    return decodeUtf8(new Uint8Array(content));
  }
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

function findRootTranscript(
  artifacts: readonly Artifact<unknown>[],
): Artifact<unknown> | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'transcript.jsonl') return a;
  }
  return undefined;
}

function findAtifTranscript(
  artifacts: readonly Artifact<unknown>[],
): Artifact<unknown> | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'native/atif-transcript.json') return a;
  }
  return undefined;
}

function findModels(
  artifacts: readonly Artifact<unknown>[],
): { parsed: ParseDevinModelsResult; text?: string } | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'native/models.json') {
      const text = toText(a.content);
      if (!text) return undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        return { parsed: parseDevinModelsJson(parsed), text };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function findModelsRaw(artifacts: readonly Artifact<unknown>[]): string | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'native/models-list.raw.json') return toText(a.content);
  }
  return undefined;
}

function findSchemaDescriptor(
  artifacts: readonly Artifact<unknown>[],
): ReturnType<typeof parseSchemaDescriptor> | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'native/schema-descriptor.json') {
      const text = toText(a.content);
      if (!text) return undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        return parseSchemaDescriptor(parsed) ?? undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function findPlan(artifacts: readonly Artifact<unknown>[]): string | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (/^plans\/plan-[^/]+\.md$/.test(normalized)) return toText(a.content);
  }
  return undefined;
}

function sessionLine(lines: DevinJsonlParseResult['lines']): DevinSessionLine | undefined {
  for (const line of lines) {
    if (line.type === 'session') return line;
  }
  return undefined;
}

function messageLines(lines: DevinJsonlParseResult['lines']): DevinMessageLine[] {
  const result: DevinMessageLine[] = [];
  for (const line of lines) {
    if (line.type === 'message') result.push(line);
  }
  return result;
}

function toolCallLines(lines: DevinJsonlParseResult['lines']): DevinToolCallLine[] {
  const result: DevinToolCallLine[] = [];
  for (const line of lines) {
    if (line.type === 'tool_call') result.push(line);
  }
  return result;
}

function promptLines(lines: DevinJsonlParseResult['lines']): DevinPromptLine[] {
  const result: DevinPromptLine[] = [];
  for (const line of lines) {
    if (line.type === 'prompt') result.push(line);
  }
  return result;
}

function mainChainIdNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function buildMessageTree(messages: readonly DevinMessageLine[]): Map<number, DevinMessageLine[]> {
  const children = new Map<number, DevinMessageLine[]>();
  for (const message of messages) {
    const parent = message.parentNodeId ?? -1;
    const list = children.get(parent) ?? [];
    list.push(message);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.nodeId - b.nodeId);
  }
  return children;
}

function findRootIds(messages: readonly DevinMessageLine[]): number[] {
  const all = new Set(messages.map((m) => m.nodeId));
  const roots: number[] = [];
  for (const message of messages) {
    if (message.parentNodeId === null || !all.has(message.parentNodeId)) {
      roots.push(message.nodeId);
    }
  }
  return roots.sort((a, b) => a - b);
}

function buildMainChain(
  messages: readonly DevinMessageLine[],
  mainChainId: number | undefined,
): { chain: number[]; leaf: number } {
  const byId = new Map(messages.map((m) => [m.nodeId, m]));
  const children = buildMessageTree(messages);
  const roots = findRootIds(messages);

  function pathToLeaf(leaf: number): number[] {
    const path: number[] = [];
    let current: number | undefined = leaf;
    while (current !== undefined && byId.has(current)) {
      path.unshift(current);
      const message = byId.get(current);
      current = message?.parentNodeId ?? undefined;
    }
    return path;
  }

  function defaultLeaf(): number {
    if (mainChainId !== undefined && byId.has(mainChainId)) return mainChainId;
    const allChildren = new Set<number>();
    for (const list of children.values()) {
      for (const child of list) allChildren.add(child.nodeId);
    }
    const leaves = messages.filter((m) => !allChildren.has(m.nodeId));
    if (leaves.length === 0) return roots[0] ?? 0;
    leaves.sort((a, b) => a.nodeId - b.nodeId);
    return leaves[leaves.length - 1].nodeId;
  }

  const leaf = mainChainId !== undefined && byId.has(mainChainId) ? mainChainId : defaultLeaf();
  const chain = pathToLeaf(leaf);
  return { chain, leaf };
}

function orderMessages(
  messages: readonly DevinMessageLine[],
  mainChainId: number | undefined,
): DevinMessageLine[] {
  if (messages.length === 0) return [];
  const byId = new Map(messages.map((m) => [m.nodeId, m]));
  const { chain } = buildMainChain(messages, mainChainId);
  const chainSet = new Set(chain);
  const children = buildMessageTree(messages);
  const ordered: DevinMessageLine[] = [];
  const visited = new Set<number>();

  function visit(nodeId: number, onMainChain: boolean): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const message = byId.get(nodeId);
    if (message) ordered.push(message);
    const childList = children.get(nodeId) ?? [];
    const mainChainChild = onMainChain ? childList.find((c) => chainSet.has(c.nodeId)) : undefined;
    if (mainChainChild) {
      visit(mainChainChild.nodeId, true);
    }
    for (const child of childList) {
      if (child !== mainChainChild) visit(child.nodeId, false);
    }
  }

  for (const rootId of findRootIds(messages)) {
    const onMainChain = chainSet.has(rootId);
    if (onMainChain || !chainSet.has(rootId)) {
      visit(rootId, onMainChain);
    }
  }
  return ordered;
}

function makeIssue(
  code: string,
  message: string,
  severity: 'warning' | 'fatal' | 'recoverable',
  path?: string,
): Issue {
  return { code, severity, message, provenance: path ? { path } : undefined };
}

export function parseDevinBundle(bundle: UnknownArtifactBundle): DevinParsedBundle {
  const warnings: Issue[] = [];
  const rootArtifact = findRootTranscript(bundle.artifacts);
  const rootTranscriptText = rootArtifact ? toText(rootArtifact.content) : undefined;
  const parsedJsonl: DevinJsonlParseResult = rootTranscriptText
    ? parseDevinJsonlText(rootTranscriptText)
    : { lines: [], warnings: [] };

  for (const w of parsedJsonl.warnings) {
    warnings.push(
      makeIssue('jsonl_parse_warning', `${w.reason}: ${w.rawLine}`, 'warning', 'transcript.jsonl'),
    );
  }

  const atifArtifact = findAtifTranscript(bundle.artifacts as readonly Artifact<unknown>[]);
  let atif: AtifTranscript | undefined;
  if (atifArtifact) {
    const text = toText(atifArtifact.content);
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        const result = parseAtifTranscript(parsed);
        if (result.ok) {
          atif = result.transcript;
        } else {
          warnings.push(
            makeIssue('atif_parse_warning', result.reason, 'warning', atifArtifact.relativePath),
          );
        }
      } catch {
        warnings.push(
          makeIssue('atif_parse_warning', 'invalid JSON', 'warning', atifArtifact.relativePath),
        );
      }
    }
  }

  const modelsResult = findModels(bundle.artifacts as readonly Artifact<unknown>[]);
  const models = modelsResult?.parsed.models ?? [];
  const modelsRaw = findModelsRaw(bundle.artifacts as readonly Artifact<unknown>[]);
  const schemaDescriptor = findSchemaDescriptor(bundle.artifacts as readonly Artifact<unknown>[]);
  const planContent = findPlan(bundle.artifacts as readonly Artifact<unknown>[]);

  const session = sessionLine(parsedJsonl.lines);
  const mainChainId = session ? mainChainIdNumber(session.mainChainId) : undefined;
  const orderedMessages = orderMessages(messageLines(parsedJsonl.lines), mainChainId);

  return {
    rootTranscriptText,
    parsedJsonl,
    atif,
    models,
    modelsRaw,
    schemaDescriptor,
    planContent,
    sessionLine: session,
    orderedMessages,
    toolCalls: toolCallLines(parsedJsonl.lines),
    prompts: promptLines(parsedJsonl.lines),
    warnings,
  };
}
