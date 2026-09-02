import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rampStep, rampTokens, tokens } from '../../src/styles/tokens';

const testDir = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = resolve(testDir, '../../index.html');

/** Extracts every `--rd-<name>: #hex;` declaration from index.html's `:root` block. */
function readIndexHtmlRedesignTokens(): Record<string, string> {
  const html = readFileSync(indexHtmlPath, 'utf-8');
  const declarations = html.matchAll(/--rd-([a-z0-9-]+):\s*(#[0-9a-f]{3,8});/gi);

  const out: Record<string, string> = {};
  for (const [, cssName, hex] of declarations) {
    out[cssName] = hex.toLowerCase();
  }
  return out;
}

/** `--rd-accent-on-container` -> `accentOnContainer`, matching tokens.ts naming. */
function cssNameToCamelCase(cssName: string): string {
  return cssName.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** index.html's --rd-* declarations, keyed by the same camelCase name tokens.ts uses. */
function readIndexHtmlTokensByCamelCaseName(): Record<string, string> {
  const cssTokens = readIndexHtmlRedesignTokens();
  const out: Record<string, string> = {};
  for (const [cssName, hex] of Object.entries(cssTokens)) {
    out[cssNameToCamelCase(cssName)] = hex;
  }
  return out;
}

describe('tokens module completeness', () => {
  it('has a matching camelCase entry for every --rd-* custom property in index.html', () => {
    const cssTokensByName = readIndexHtmlTokensByCamelCaseName();
    expect(Object.keys(cssTokensByName).length).toBeGreaterThan(0);

    for (const [name, hex] of Object.entries(cssTokensByName)) {
      expect(tokens, `missing tokens.ts entry for --rd-* name "${name}"`).toHaveProperty(name, hex);
    }
  });

  it('has no tokens.ts entries that are absent, renamed, or mismatched relative to index.html', () => {
    const cssTokensByName = readIndexHtmlTokensByCamelCaseName();

    // Name-keyed comparison (not just hex-value membership) so a tokens.ts
    // entry that duplicates another token's hex under a name index.html
    // doesn't declare (an "orphan" with a coincidentally shared color) is
    // still caught, rather than passing because *some* --rd-* value matches.
    for (const [name, hex] of Object.entries(tokens)) {
      expect(
        cssTokensByName,
        `tokens.ts entry "${name}" (${hex}) has no matching --rd-* name in index.html`,
      ).toHaveProperty(name, hex);
    }
  });
});

describe('rampStep', () => {
  it('returns the lowest ramp color at fraction 0', () => {
    expect(rampStep(0)).toBe(rampTokens[0]);
  });

  it('returns the highest ramp color at fraction 1', () => {
    expect(rampStep(1)).toBe(rampTokens[rampTokens.length - 1]);
  });

  it('returns a mid-ramp color for a mid fraction', () => {
    const mid = rampStep(0.5);

    expect(rampTokens).toContain(mid);
    expect(mid).not.toBe(rampTokens[0]);
    expect(mid).not.toBe(rampTokens[rampTokens.length - 1]);
  });

  it('clamps fractions above 1 to the highest ramp color', () => {
    expect(rampStep(1.5)).toBe(rampTokens[rampTokens.length - 1]);
    expect(rampStep(Number.POSITIVE_INFINITY)).toBe(rampTokens[rampTokens.length - 1]);
  });

  it('clamps fractions below 0 to the lowest ramp color', () => {
    expect(rampStep(-0.5)).toBe(rampTokens[0]);
    expect(rampStep(Number.NEGATIVE_INFINITY)).toBe(rampTokens[0]);
  });

  it('falls back to the lowest ramp color for non-finite input', () => {
    expect(rampStep(Number.NaN)).toBe(rampTokens[0]);
  });
});
