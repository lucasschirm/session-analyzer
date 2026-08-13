/**
 * Text-normalization primitives shared by every `parseX` function.
 *
 * Deliberately implemented without any DOM/Node globals (no `TextEncoder`,
 * no `Buffer`) — this package's tsconfig sets `types: []` and `lib:
 * ["ES2021"]`, so only plain ECMAScript string APIs are available, and
 * that's a feature: it keeps the package runnable in any JS host.
 */

/** Strips a leading UTF-8 BOM (U+FEFF), if present. */
export function stripBom(text: string): string {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

export interface TextLine {
  /** 1-based, matching the source file's real line numbering — counts
   *  blank lines even though callers typically skip them. */
  lineNumber: number;
  text: string;
}

/**
 * Splits `content` into lines, CRLF-tolerant (`\r\n` splits the same as
 * `\n`; a trailing `\r` never reaches the returned text). Every line,
 * including blank/whitespace-only ones, is included with its 1-based
 * `lineNumber` so numbering stays correct across skipped blank lines —
 * callers decide whether to skip blanks, this function never does.
 */
export function splitLines(content: string): TextLine[] {
  const raw = content.split('\n');
  return raw.map((line, idx) => ({
    lineNumber: idx + 1,
    text: line.endsWith('\r') ? line.slice(0, -1) : line,
  }));
}

export interface SafeJsonParseResult<T> {
  value: T | null;
  error?: string;
}

/** Never throws — wraps `JSON.parse`, returning the parse error message
 *  instead of letting it propagate. */
export function safeJsonParse<T>(text: string): SafeJsonParseResult<T> {
  try {
    return { value: JSON.parse(text) as T };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Number of UTF-8 bytes `text` would occupy, computed by hand (no
 *  `TextEncoder` — see file header) by walking Unicode code points. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i);
    if (code === undefined) break;
    i += code > 0xffff ? 2 : 1;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Caps a retained blob to at most `maxBytes` UTF-8 bytes, truncating on a
 * code-point boundary (never splitting a surrogate pair). Used by other
 * modules to honour `ParseOptions.maxBlobBytes` (e.g.
 * `nested_memory.rawContent`, `invoked_skills.content`, hook stdout,
 * `deferred_tools_delta.addedLines`). When `maxBytes` is omitted or
 * negative, `text` is returned unchanged.
 */
export function clampBlob(text: string, maxBytes?: number): string {
  if (maxBytes === undefined || maxBytes < 0) return text;
  if (utf8ByteLength(text) <= maxBytes) return text;

  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i);
    if (code === undefined) break;
    const charLen = code > 0xffff ? 2 : 1;
    const byteLen = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + byteLen > maxBytes) break;
    bytes += byteLen;
    i += charLen;
  }
  return text.slice(0, i);
}
