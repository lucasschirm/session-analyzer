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

describe('tokens module completeness', () => {
  it('has a matching camelCase entry for every --rd-* custom property in index.html', () => {
    const cssTokens = readIndexHtmlRedesignTokens();
    expect(Object.keys(cssTokens).length).toBeGreaterThan(0);

    for (const [cssName, hex] of Object.entries(cssTokens)) {
      const camel = cssNameToCamelCase(cssName);
      expect(tokens, `missing tokens.ts entry for --rd-${cssName}`).toHaveProperty(camel, hex);
    }
  });

  it('has no tokens.ts entries that are absent from index.html', () => {
    const cssTokens = readIndexHtmlRedesignTokens();
    const cssHexValues = new Set(Object.values(cssTokens));

    for (const [name, hex] of Object.entries(tokens)) {
      expect(
        cssHexValues,
        `tokens.ts entry "${name}" (${hex}) has no matching --rd-* value in index.html`,
      ).toContain(hex);
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
