import type { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/analytics/analytics-card';
import type { AnalyticsCard } from '../../src/components/analytics/analytics-card';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('analytics-card', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the title and caption', async () => {
    const el = document.createElement('analytics-card') as AnalyticsCard;
    el.cardTitle = 'Sessions';
    el.caption = 'n=42 · last 30d';
    await mount(el);
    expect(shadow(el).querySelector('.title')?.textContent).toBe('Sessions');
    expect(shadow(el).querySelector('.caption')?.textContent).toBe('n=42 · last 30d');
  });

  it('renders no header when title and caption are empty', async () => {
    const el = document.createElement('analytics-card') as AnalyticsCard;
    await mount(el);
    expect(shadow(el).querySelector('.header')).toBeNull();
  });

  it('applies the inset variant class', async () => {
    const el = document.createElement('analytics-card') as AnalyticsCard;
    el.variant = 'inset';
    await mount(el);
    expect(shadow(el).querySelector('.analytics-card.inset')).not.toBeNull();
  });

  it('applies the dashed variant class', async () => {
    const el = document.createElement('analytics-card') as AnalyticsCard;
    el.variant = 'dashed';
    await mount(el);
    expect(shadow(el).querySelector('.analytics-card.dashed')).not.toBeNull();
  });

  it('renders as a div when not clickable', async () => {
    const el = document.createElement('analytics-card') as AnalyticsCard;
    await mount(el);
    expect(shadow(el).querySelector('button')).toBeNull();
    expect(shadow(el).querySelector('div.analytics-card')).not.toBeNull();
  });

  it('renders as a button and dispatches card-click when clickable', async () => {
    const el = document.createElement('analytics-card') as AnalyticsCard;
    el.clickable = true;
    el.cardTitle = 'Sessions';
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('card-click', listener);
    shadow(el)
      .querySelector('button')
      ?.dispatchEvent(new Event('click', { bubbles: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({ label: 'Sessions' });
  });

  it('renders slotted body content', async () => {
    const el = document.createElement('analytics-card') as AnalyticsCard;
    const child = document.createElement('span');
    child.textContent = 'body content';
    el.appendChild(child);
    await mount(el);
    expect(shadow(el).querySelector('slot')).not.toBeNull();
    expect(el.textContent).toContain('body content');
  });
});
