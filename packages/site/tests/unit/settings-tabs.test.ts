import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/settings-tabs';
import type { SettingsTabs } from '../../src/components/settings-tabs';

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

async function mount(hash: string): Promise<SettingsTabs> {
  window.location.hash = hash;
  const el = document.createElement('settings-tabs') as SettingsTabs;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function activeLabel(root: ShadowRoot): string | null {
  const active = root.querySelector('a.active');
  return active?.textContent?.trim() ?? null;
}

describe('settings-tabs', () => {
  let element: SettingsTabs | null = null;

  afterEach(() => {
    element?.remove();
    element = null;
    window.location.hash = '';
  });

  const cases: Array<[hash: string, expected: string]> = [
    ['#/settings', 'Data Sources'],
    ['#/settings/data-sources', 'Data Sources'],
    ['#/settings/storage', 'Storage'],
  ];

  for (const [hash, expected] of cases) {
    it(`marks ${expected} active for ${hash}`, async () => {
      element = await mount(hash);
      const root = shadow(element);
      expect(activeLabel(root)).toBe(expected);
      const active = root.querySelector('a.active');
      expect(active?.getAttribute('aria-current')).toBe('page');
    });
  }

  it('renders both tabs with the correct hrefs', async () => {
    element = await mount('#/settings/storage');
    const root = shadow(element);
    const links = Array.from(root.querySelectorAll('a'));
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Data Sources', 'Storage']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#/settings/data-sources',
      '#/settings/storage',
    ]);
  });

  it('does not mark aria-current on the inactive tab', async () => {
    element = await mount('#/settings/storage');
    const root = shadow(element);
    const inactive = Array.from(root.querySelectorAll('a')).find(
      (a) => a.textContent?.trim() === 'Data Sources',
    );
    expect(inactive?.hasAttribute('aria-current')).toBe(false);
  });

  it('updates active tab on hashchange', async () => {
    element = await mount('#/settings/data-sources');
    window.location.hash = '#/settings/storage';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await element.updateComplete;
    expect(activeLabel(shadow(element))).toBe('Storage');
  });
});
