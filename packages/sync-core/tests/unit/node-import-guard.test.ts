import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = path.resolve(import.meta.dirname ?? '.', '../../dist');

describe('dist node: import guard', () => {
  it('contains no "node:" substring in any emitted .js file', function () {
    if (!fs.existsSync(DIST)) {
      this.skip();
      return;
    }

    const distFiles: string[] = [];

    function collect(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collect(full);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          distFiles.push(full);
        }
      }
    }

    collect(DIST);
    expect(distFiles.length).toBeGreaterThan(0);

    for (const file of distFiles) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toContain('node:');
    }
  });
});
