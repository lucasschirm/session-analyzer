import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_FILE = fileURLToPath(import.meta.url);
const SRC_DIR = path.resolve(TEST_FILE, '../../src');

const FORBIDDEN_PATTERNS = [
  { name: '@sqlite.org', pattern: '@sqlite\\.org' },
  { name: 'node:', pattern: 'node:' },
  { name: 'sqlite', pattern: '\\bsqlite\\b' },
  { name: 'opfs', pattern: '\\bopfs\\b' },
  { name: 'DOM', pattern: '\\bDOM\\b' },
  { name: 'worker', pattern: '\\bworker\\b' },
  { name: 'fetch', pattern: '\\bfetch\\b' },
  { name: 'HTTP', pattern: '\\bHTTP\\b' },
];

function stripComments(content: string): string {
  return content.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('forbidden import guard', () => {
  it('src/ contains none of the forbidden runtime tokens outside allowed comments', () => {
    const sourceFiles = collectSourceFiles(SRC_DIR);
    expect(sourceFiles.length).toBeGreaterThan(0);

    const matches: { file: string; token: string; line: number }[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const stripped = stripComments(content);
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { name, pattern } of FORBIDDEN_PATTERNS) {
          const regex = new RegExp(pattern, 'i');
          if (regex.test(line)) {
            matches.push({ file, token: name, line: i + 1 });
          }
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
