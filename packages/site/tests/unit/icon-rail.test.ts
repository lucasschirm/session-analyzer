import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/icon-rail';
import type { IconRail } from '../../src/components/icon-rail';

async function mount(path: string): Promise<IconRail> {
  const el = document.createElement('icon-rail') as IconRail;
  el.path = path;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function activeLabel(root: ShadowRoot): string | null {
  const active = root.querySelector('a.rail-item.active');
  return active?.getAttribute('aria-label') ?? null;
}

describe('icon-rail', () => {
  let element: IconRail | null = null;

  afterEach(() => {
    element?.remove();
    element = null;
  });

  it('renders exactly one link per destination with the expected hrefs and labels', async () => {
    element = await mount('/');
    const root = shadow(element);
    const links = Array.from(root.querySelectorAll('a.rail-item'));
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([
      'Portfolio',
      'Projects',
      'Artifacts',
      'Settings',
    ]);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#/',
      '#/projects',
      '#/artifacts',
      '#/settings/data-sources',
    ]);
    for (const link of links) {
      expect(link.getAttribute('title')).toBe(link.getAttribute('aria-label'));
    }
  });

  it('renders the logo mark linking home', async () => {
    element = await mount('/');
    const root = shadow(element);
    const logo = root.querySelector('.logo-mark');
    expect(logo?.getAttribute('href')).toBe('#/');
  });

  // Active-route mapping table (issue #165 test plan): every route prefix
  // maps to the expected active rail item; routes with no rail item map to
  // no active item at all, not the nearest parent.
  const cases: Array<[path: string, expected: string | null]> = [
    ['/', 'Portfolio'],
    ['/projects', 'Projects'],
    ['/projects/my-project', 'Projects'],
    ['/artifacts', 'Artifacts'],
    ['/artifacts/some-component', 'Artifacts'],
    ['/settings', 'Settings'],
    ['/settings/data-sources', 'Settings'],
    ['/settings/storage', 'Settings'],
    ['/agents', null],
    ['/skills', null],
    ['/tools', null],
    ['/mcp', null],
    ['/sessions/s1', null],
    ['/manual-import', null],
    ['/artifact-diff', null],
  ];

  for (const [path, expected] of cases) {
    it(`maps ${path} -> ${expected ?? 'no active item'}`, async () => {
      element = await mount(path);
      expect(activeLabel(shadow(element))).toBe(expected);
    });
  }

  it('sets aria-current="page" only on the active item', async () => {
    element = await mount('/projects/foo');
    const root = shadow(element);
    const links = Array.from(root.querySelectorAll('a.rail-item'));
    const withCurrent = links.filter((a) => a.hasAttribute('aria-current'));
    expect(withCurrent).toHaveLength(1);
    expect(withCurrent[0]?.getAttribute('aria-label')).toBe('Projects');
    expect(withCurrent[0]?.getAttribute('aria-current')).toBe('page');
    for (const link of links) {
      if (link === withCurrent[0]) continue;
      expect(link.hasAttribute('aria-current')).toBe(false);
    }
  });

  it('has no active item and no aria-current on routes with no rail destination', async () => {
    element = await mount('/manual-import');
    const root = shadow(element);
    expect(root.querySelector('a.rail-item.active')).toBeNull();
    expect(root.querySelector('a.rail-item[aria-current]')).toBeNull();
  });
});
