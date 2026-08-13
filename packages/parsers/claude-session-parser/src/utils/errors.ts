import type { ParseError } from '../types/common.js';

export interface MakeParseErrorOptions {
  line?: number;
  uuid?: string;
  rawSnippet?: string;
}

/** Builds a `ParseError` in the shared shape (`{ line?, uuid?, code,
 *  message, rawSnippet? }`). Every `parseX` function uses this instead of
 *  throwing on malformed input. */
export function makeParseError(code: string, message: string, opts?: MakeParseErrorOptions): ParseError {
  const error: ParseError = { code, message };
  if (opts?.line !== undefined) error.line = opts.line;
  if (opts?.uuid !== undefined) error.uuid = opts.uuid;
  if (opts?.rawSnippet !== undefined) error.rawSnippet = opts.rawSnippet;
  return error;
}
