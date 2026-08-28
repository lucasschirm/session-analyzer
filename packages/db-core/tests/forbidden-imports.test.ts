import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The forbidden list is explicit and case-insensitive for identifiers.
// `node:` and `@sqlite.org/sqlite-wasm` are matched as import sources.
const FORBIDDEN_IMPORT_PREFIXES = ['@sqlite.org/sqlite-wasm', 'node:'];
const FORBIDDEN_IDENTIFIERS = ['opfs', 'DOM', 'worker', 'lit', 'fetch'];

const ROOT = path.normalize(decodeURI(new URL('..', import.meta.url).pathname));

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.turbo') {
        continue;
      }
      yield* walkFiles(full);
    } else if (
      entry.isFile() &&
      (full.endsWith('.ts') || full.endsWith('.js') || full.endsWith('.d.ts'))
    ) {
      yield full;
    }
  }
}

function extractImportPaths(content: string): string[] {
  const paths: string[] = [];
  const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"`]([^'"`]+)['"`]/g;
  const dynamicRegex = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

  for (const match of content.matchAll(importRegex)) {
    paths.push(match[1]);
  }
  for (const match of content.matchAll(dynamicRegex)) {
    paths.push(match[1]);
  }

  return paths;
}

function stripCommentsAndStrings(content: string): string {
  // Remove block comments.
  let normalized = content.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments.
  normalized = normalized.replace(/\/\/.*$/gm, '');
  // Remove single-quoted, double-quoted, and template string literals.
  normalized = normalized.replace(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g, '');
  return normalized;
}

function findForbidden(content: string, filePath: string): string[] {
  const violations: string[] = [];

  for (const importPath of extractImportPaths(content)) {
    for (const prefix of FORBIDDEN_IMPORT_PREFIXES) {
      if (importPath.includes(prefix)) {
        violations.push(`forbidden import source "${importPath}" in ${filePath}`);
      }
    }
  }

  const normalized = stripCommentsAndStrings(content);
  const identifierPattern = new RegExp(
    `\\b(?:${FORBIDDEN_IDENTIFIERS.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'i',
  );

  if (identifierPattern.test(normalized)) {
    const matched = normalized.match(identifierPattern)?.[0];
    violations.push(`forbidden identifier "${matched}" in ${filePath}`);
  }

  return violations;
}

describe('forbidden-import guard', () => {
  it('has no forbidden imports or identifiers in src/', async () => {
    const srcDir = path.join(ROOT, 'src');
    const violations: string[] = [];

    for await (const file of walkFiles(srcDir)) {
      const content = await readFile(file, 'utf8');
      violations.push(...findForbidden(content, file));
    }

    expect(violations).toEqual([]);
  });

  it('has no forbidden imports or identifiers in built dist/ if present', async () => {
    const distDir = path.join(ROOT, 'dist');
    const info = await stat(distDir).catch(() => null);

    if (!info?.isDirectory()) {
      return;
    }

    const violations: string[] = [];

    for await (const file of walkFiles(distDir)) {
      const content = await readFile(file, 'utf8');
      violations.push(...findForbidden(content, file));
    }

    expect(violations).toEqual([]);
  });
});
