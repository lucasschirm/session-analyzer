import { DEFAULT_SANITIZATION_POLICY, type StringRedactionPattern } from './contract.js';
import { SanitizationError } from './redaction.js';

const GLOBAL_FLAGS = 'g';
const CASE_INSENSITIVE_FLAG = 'i';

export interface RedactSecretsOptions {
  patterns?: readonly StringRedactionPattern[];
}

interface CompiledPattern {
  regex: RegExp;
  replacement: string;
}

function compilePattern(pattern: StringRedactionPattern): CompiledPattern {
  let source = pattern.pattern;
  let flags = GLOBAL_FLAGS;

  // The contract uses the .NET/Vim-style inline `(?i)` flag; JavaScript
  // supports case-insensitive matching via the `i` flag instead.
  if (source.startsWith('(?i)')) {
    source = source.slice(4);
    flags += CASE_INSENSITIVE_FLAG;
  }

  // The contract's `credential-url` pattern uses a variable-width lookbehind
  // `(?<=https?://)` that is invalid in JavaScript. Rewrite it to a capturing
  // group so the scheme is preserved by the replacement.
  const credentialLookbehind = '(?<=https?://)';
  if (source.includes(credentialLookbehind)) {
    source = source.replace(credentialLookbehind, '(https?://)');
  }

  let replacement = pattern.replacement;
  if (pattern.name === 'credential-url' && source.includes('(https?://)')) {
    replacement = `$1${replacement}`;
  }

  // The contract pattern `[^@]+` is too broad: it matches a path segment before
  // an @-mention in a URL (e.g. `https://example.com/@user`). Restrict the
  // userinfo to characters that cannot appear in a host/path and require a
  // colon-separated password when present, preserving the original intent.
  if (pattern.name === 'credential-url' && source.includes('[^@]+(?=@)')) {
    source = source.replace('(https?://)[^@]+(?=@)', '(https?://)[^/@\\s]+(?::[^@\\s]+)?(?=@)');
  }

  try {
    const regex = new RegExp(source, flags);
    return { regex, replacement };
  } catch (err) {
    throw new SanitizationError(
      'SYNC_SANITIZATION_ERROR',
      `Invalid string redaction pattern "${pattern.name}": ${String(err)}`,
    );
  }
}

export function redactSecrets(input: string, options?: RedactSecretsOptions): string {
  const patterns = options?.patterns ?? DEFAULT_SANITIZATION_POLICY.stringRedactionPatterns;

  let result = input;
  for (const pattern of patterns) {
    const { regex, replacement } = compilePattern(pattern);
    result = result.replace(regex, replacement);
  }
  return result;
}
