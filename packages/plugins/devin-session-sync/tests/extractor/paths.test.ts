import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDevinDataRoot, resolveDevinPaths } from '../../src/extractor/paths.js';

const HOME = '/home/tester';
const CWD = '/home/tester/project';

describe('resolveDevinDataRoot', () => {
  it('resolves $XDG_DATA_HOME/devin/cli when the env var is set', () => {
    const root = resolveDevinDataRoot({ xdgDataHome: '/custom/xdg-data', home: HOME, cwd: CWD });
    expect(root).toBe(join('/custom/xdg-data', 'devin', 'cli'));
  });

  it('falls back to ~/.local/share/devin/cli when unset', () => {
    const root = resolveDevinDataRoot({ home: HOME, cwd: CWD });
    expect(root).toBe(join(HOME, '.local', 'share', 'devin', 'cli'));
  });

  it('falls back when the env var is set but empty', () => {
    const root = resolveDevinDataRoot({ xdgDataHome: '', home: HOME, cwd: CWD });
    expect(root).toBe(join(HOME, '.local', 'share', 'devin', 'cli'));
  });

  it('falls back when the env var is set but whitespace-only', () => {
    const root = resolveDevinDataRoot({ xdgDataHome: '   ', home: HOME, cwd: CWD });
    expect(root).toBe(join(HOME, '.local', 'share', 'devin', 'cli'));
  });
});

describe('resolveDevinPaths', () => {
  it('derives sessionsDbPath from the resolved data root', () => {
    const resolved = resolveDevinPaths({ home: HOME, cwd: CWD }, () => false);
    expect(resolved.sessionsDbPath).toBe(join(resolved.dataRoot, 'sessions.db'));
  });

  it('probes optional locations without requiring them to exist', () => {
    const resolved = resolveDevinPaths({ home: HOME, cwd: CWD }, () => false);
    const labels = resolved.probes.map((p) => p.label).sort();
    expect(labels).toEqual(
      [
        'home-codeium',
        'home-devin',
        'home-devin-shared',
        'home-windsurf',
        'project-devin',
        'project-windsurf',
      ].sort(),
    );
    expect(resolved.probes.every((p) => p.exists === false)).toBe(true);
  });

  it('reports exists:true for probed paths the injected fs check finds', () => {
    const existing = new Set([join(HOME, '.devin'), join(CWD, '.windsurf')]);
    const resolved = resolveDevinPaths({ home: HOME, cwd: CWD }, (p) => existing.has(p));
    const byLabel = new Map(resolved.probes.map((p) => [p.label, p.exists]));
    expect(byLabel.get('home-devin')).toBe(true);
    expect(byLabel.get('project-windsurf')).toBe(true);
    expect(byLabel.get('home-codeium')).toBe(false);
  });

  it('never requires optional paths to exist — resolution succeeds regardless', () => {
    expect(() => resolveDevinPaths({ home: HOME, cwd: CWD }, () => false)).not.toThrow();
  });
});
