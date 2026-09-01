import { readFileSync } from 'node:fs';

const payload = JSON.parse(readFileSync(0, 'utf8').trim() || '{}');
const command = payload.tool_input?.command || '';

const block = (reason) => {
  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(2);
};

/**
 * Tokenize a shell command respecting single and double quotes.
 * Quoted strings stay as a single token so flags inside them don't match.
 */
function tokenize(cmd) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (const c of cmd) {
    if (quote) {
      if (c === quote) {
        quote = null;
        tokens.push(current);
        current = '';
      } else {
        current += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else if (/\s/.test(c)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += c;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

const tokens = tokenize(command);

// Block disabling Husky for a git command.
const huskyIndex = tokens.findIndex((t) => /^HUSKY\s*=\s*0\b/i.test(t));
const gitIndex = tokens.indexOf('git');
if (huskyIndex !== -1 && gitIndex !== -1 && gitIndex > huskyIndex) {
  block(
    'HUSKY=0 disables Husky hooks; install dependencies and run the hook instead of bypassing it',
  );
}

if (gitIndex !== -1) {
  // Find the git subcommand, skipping options like -c between git and the verb.
  const subcommandIndex = tokens.findIndex((t, i) => i > gitIndex && !t.startsWith('-'));
  const subcommand = subcommandIndex !== -1 ? tokens[subcommandIndex].toLowerCase() : null;

  // Block --no-verify/-n on git commit, and --no-verify on git push (or any command that offers it).
  const noVerifyIndex = tokens.indexOf('--no-verify');
  const shortNoVerifyIndex = tokens.indexOf('-n');
  if (noVerifyIndex !== -1 && noVerifyIndex > gitIndex) {
    block(
      'git --no-verify bypasses pre-commit hooks; install dependencies and run the hook instead',
    );
  }
  if (
    (subcommand === 'commit' || subcommand === 'git-commit') &&
    shortNoVerifyIndex !== -1 &&
    shortNoVerifyIndex > gitIndex
  ) {
    block('git commit -n bypasses pre-commit hooks; install dependencies and run the hook instead');
  }

  // Block overriding the hooks path on any git invocation.
  const hooksPathIndex = tokens.findIndex((t) => /core\.hooksPath/i.test(t));
  if (hooksPathIndex !== -1 && hooksPathIndex > gitIndex) {
    block('overriding core.hooksPath can disable Git hooks; keep the configured hook path');
  }
}

process.exit(0);
