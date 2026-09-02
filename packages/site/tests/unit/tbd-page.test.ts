import { describe, expect, it } from 'vitest';
import '../../src/pages/tbd-page';
import type { TbdPage } from '../../src/pages/tbd-page';

function mount(label = 'Agents'): TbdPage {
  const el = document.createElement('tbd-page') as TbdPage;
  el.label = label;
  document.body.appendChild(el);
  return el;
}

describe('tbd-page', () => {
  it('renders the label as a heading', async () => {
    const el = mount('Agents');
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('h1')?.textContent).toBe('Agents');
  });

  it('renders a non-silent empty state', async () => {
    const el = mount('Skills');
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    const empty = root.querySelector('.empty-state');
    expect(empty).not.toBeNull();
    expect(empty?.getAttribute('role')).toBe('status');
    expect(root.textContent).toContain('Not available yet');
    expect(root.textContent).toContain('skills');
  });

  it('renders an empty-state for each label', async () => {
    for (const label of ['Agents', 'Skills', 'Tools', 'MCP']) {
      const el = mount(label);
      await el.updateComplete;
      const root = el.shadowRoot as ShadowRoot;
      expect(root.querySelector('h1')?.textContent).toBe(label);
      expect(root.querySelector('.empty-state')).not.toBeNull();
    }
  });
});
