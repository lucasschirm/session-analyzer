import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN_IMPORT_PREFIXES = ['@sqlite.org/sqlite-wasm', 'node:'];
const FORBIDDEN_IDENTIFIERS = [
  { name: 'lit', pattern: '\\blit\\b' },
  { name: 'opfs', pattern: '\\bopfs\\b' },
  { name: 'DOM', pattern: '\\bDOM\\b' },
  { name: 'worker', pattern: '\\bworker\\b' },
  { name: 'fetch', pattern: '\\bfetch\\b' },
  { name: 'HTTP', pattern: '\\bHTTP\\b' },
  { name: 'http', pattern: '\\bhttp\\b' },
  { name: 'https', pattern: '\\bhttps\\b' },
];

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') {
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
  let normalized = content.replace(/\/\*[\s\S]*?\*\//g, '');
  normalized = normalized.replace(/\/\/.*$/gm, '');
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
  for (const { name, pattern } of FORBIDDEN_IDENTIFIERS) {
    const regex = new RegExp(pattern, 'i');
    const match = normalized.match(regex);
    if (match) {
      violations.push(`forbidden identifier "${match[0]}" (${name}) in ${filePath}`);
    }
  }

  return violations;
}

describe('forbidden import guard', () => {
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
