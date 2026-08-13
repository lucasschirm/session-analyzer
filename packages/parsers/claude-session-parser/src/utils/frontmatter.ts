/**
 * Hand-rolled YAML **subset** reader for `---`-delimited frontmatter blocks.
 * No YAML library (zero runtime dependencies is a hard package constraint).
 *
 * Supports, because real `~/.claude` files use all of these (validated
 * against real `SKILL.md`/agent/rule files on this machine): `---`
 * delimited blocks, `key: value` scalars, single/double-quoted scalars,
 * `\n`-escaped strings inside double quotes, folded `>` and literal `|`
 * blocks, block lists (`- item`), inline lists (`[a, b]`), one level of
 * nested maps, and booleans/numbers. Never throws: missing or malformed
 * frontmatter returns `{ frontmatter: {}, body: <original> }`.
 *
 * Deliberately NOT a general YAML parser — arbitrary depth nesting,
 * anchors/aliases, multi-document streams, and full YAML 1.1/1.2 scalar
 * resolution rules are out of scope. Extend narrowly if a real file needs
 * more, rather than growing this into a general parser.
 */

import type { RuleFrontmatter } from '../types/timeline.js';

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return { frontmatter: {}, body: markdown ?? '' };
  }

  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: markdown };
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { frontmatter: {}, body: markdown };
  }

  const yamlLines = lines.slice(1, closeIdx);
  const bodyLines = lines.slice(closeIdx + 1);
  const body = bodyLines.join('\n').replace(/^\n+/, '');

  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = parseYamlMap(yamlLines, 0, yamlLines.length, -1).obj;
  } catch {
    // Never throw — malformed frontmatter degrades to an empty object
    // rather than aborting the whole parse.
    frontmatter = {};
  }

  return { frontmatter, body };
}

/**
 * Normalizes a rule's glob scoping into `string[]`, regardless of which
 * real-world form it was authored in: a `globs:` key or a `paths:` key
 * (real files use both), each of which may be a bare scalar, a
 * comma-separated scalar, a quoted scalar, or a YAML list (block or
 * inline).
 */
export function normalizeGlobs(fm: RuleFrontmatter | Record<string, unknown> | null | undefined): string[] {
  if (!fm || typeof fm !== 'object') return [];
  const record = fm as Record<string, unknown>;
  const raw = record.globs ?? record.paths;
  return normalizeGlobValue(raw);
}

function normalizeGlobValue(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => normalizeGlobValue(item));
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => stripSurroundingQuotes(s.trim()))
      .filter((s) => s.length > 0);
  }
  const s = String(raw).trim();
  return s.length > 0 ? [s] : [];
}

function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Internal recursive-descent helpers
// ---------------------------------------------------------------------------

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

interface KeyLine {
  indent: number;
  key: string;
  rest: string;
}

/** Finds the first top-level `:` in `s` that separates a key from its
 *  value — i.e. one followed by whitespace or end-of-line and not inside a
 *  quoted span. Colons inside values (URLs, quoted sub-values) are never
 *  mistaken for the key separator because scanning stops at the first
 *  match. */
function findKeyColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble) {
      const next = s[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

function matchKeyLine(line: string): KeyLine | null {
  const indent = indentOf(line);
  const trimmed = line.slice(indent);
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const colonIdx = findKeyColon(trimmed);
  if (colonIdx === -1) return null;
  const key = unquoteScalarString(trimmed.slice(0, colonIdx).trim());
  if (key === '') return null;
  const rest = trimmed.slice(colonIdx + 1).trim();
  return { indent, key, rest };
}

function parseYamlMap(
  lines: string[],
  start: number,
  end: number,
  parentIndent: number,
): { obj: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {};
  let i = start;
  let blockIndent: number | null = null;

  while (i < end) {
    const raw = lines[i];
    if (raw.trim() === '') {
      i++;
      continue;
    }
    const indent = indentOf(raw);
    if (indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = indent;
    if (indent !== blockIndent) break; // inconsistent indentation — stop defensively

    const parsed = matchKeyLine(raw);
    if (!parsed) {
      i++;
      continue;
    }
    const { key, rest } = parsed;
    i++;

    if (rest === '') {
      let j = i;
      while (j < end && lines[j].trim() === '') j++;
      const lookaheadIndent = j < end ? indentOf(lines[j]) : -1;
      const lookaheadTrimmed = j < end ? lines[j].slice(lookaheadIndent) : '';
      if (j < end && lookaheadIndent > indent && (lookaheadTrimmed === '-' || lookaheadTrimmed.startsWith('- '))) {
        const list = parseYamlList(lines, j, end, indent);
        obj[key] = list.items;
        i = list.next;
      } else if (j < end && lookaheadIndent > indent && matchKeyLine(lines[j])) {
        const nested = parseYamlMap(lines, j, end, indent);
        obj[key] = nested.obj;
        i = nested.next;
      } else {
        obj[key] = null;
      }
    } else if (rest.startsWith('>')) {
      const block = parseBlockScalar(lines, i, end, indent, 'folded');
      obj[key] = block.text;
      i = block.next;
    } else if (rest.startsWith('|')) {
      const block = parseBlockScalar(lines, i, end, indent, 'literal');
      obj[key] = block.text;
      i = block.next;
    } else if (rest.startsWith('[')) {
      obj[key] = parseInlineList(rest);
    } else {
      obj[key] = parseScalar(rest);
    }
  }

  return { obj, next: i };
}

function parseYamlList(
  lines: string[],
  start: number,
  end: number,
  parentIndent: number,
): { items: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = start;
  let itemIndent: number | null = null;

  while (i < end) {
    const raw = lines[i];
    if (raw.trim() === '') {
      i++;
      continue;
    }
    const indent = indentOf(raw);
    if (indent <= parentIndent) break;
    const trimmed = raw.slice(indent);
    if (!(trimmed === '-' || trimmed.startsWith('- '))) break;
    if (itemIndent === null) itemIndent = indent;
    if (indent !== itemIndent) break;

    const itemText = trimmed === '-' ? '' : trimmed.slice(2).trim();
    items.push(itemText === '' ? null : parseScalar(itemText));
    i++;
  }

  return { items, next: i };
}

function parseBlockScalar(
  lines: string[],
  keyLineIdx: number,
  end: number,
  keyIndent: number,
  mode: 'folded' | 'literal',
): { text: string; next: number } {
  const collected: string[] = [];
  let i = keyLineIdx;
  let blockIndent: number | null = null;

  while (i < end) {
    const raw = lines[i];
    if (raw.trim() === '') {
      collected.push('');
      i++;
      continue;
    }
    const indent = indentOf(raw);
    if (blockIndent === null) {
      if (indent <= keyIndent) break;
      blockIndent = indent;
    }
    if (indent < blockIndent) break;
    collected.push(raw.slice(blockIndent));
    i++;
  }

  while (collected.length && collected[collected.length - 1] === '') collected.pop();

  const text = mode === 'folded' ? foldLines(collected) : collected.join('\n');
  return { text, next: i };
}

/** YAML folding: blank lines inside a `>` block become paragraph breaks;
 *  otherwise consecutive lines join with a single space. */
function foldLines(lines: string[]): string {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line === '') {
      if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
    } else {
      paragraphs[paragraphs.length - 1].push(line);
    }
  }
  return paragraphs
    .filter((p) => p.length > 0)
    .map((p) => p.join(' '))
    .join('\n\n')
    .trim();
}

function parseInlineList(rest: string): unknown[] {
  let inner = rest.trim();
  if (inner.startsWith('[')) inner = inner.slice(1);
  const closeIdx = inner.lastIndexOf(']');
  if (closeIdx !== -1) inner = inner.slice(0, closeIdx);
  if (inner.trim() === '') return [];
  return splitTopLevelCommas(inner).map((p) => parseScalar(p.trim()));
}

function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (const c of s) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === ',' && !inSingle && !inDouble) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '') return null;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function unquoteScalarString(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function unescapeDoubleQuoted(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      switch (next) {
        case 'n':
          out += '\n';
          i++;
          break;
        case 't':
          out += '\t';
          i++;
          break;
        case 'r':
          out += '\r';
          i++;
          break;
        case '"':
          out += '"';
          i++;
          break;
        case '\\':
          out += '\\';
          i++;
          break;
        default:
          out += next;
          i++;
          break;
      }
    } else {
      out += c;
    }
  }
  return out;
}
