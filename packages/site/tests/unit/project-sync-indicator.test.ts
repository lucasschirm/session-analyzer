import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/project-sync-indicator';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function createIndicator(): LitElement {
  return document.createElement('project-sync-indicator') as unknown as LitElement;
}

describe('project-sync-indicator', () => {
  let element: LitElement;

  afterEach(() => {
    element?.remove();
  });

  it('renders the spinner when active', async () => {
    element = await mount(createIndicator());
    (element as any).active = true;
    await element.updateComplete;

    const indicator = shadow(element).querySelector('.indicator');
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('title')).toBe('Syncing…');
  });

  it('renders nothing when inactive', async () => {
    element = await mount(createIndicator());
    (element as any).active = false;
    await element.updateComplete;

    const indicator = shadow(element).querySelector('.indicator');
    expect(indicator).toBeNull();
  });

  it('defaults to active', async () => {
    element = await mount(createIndicator());
    expect((element as any).active).toBe(true);
  });

  it('dispatches indicator-click on click', async () => {
    element = await mount(createIndicator());
    (element as any).active = true;
    await element.updateComplete;

    let clicked = false;
    element.addEventListener('indicator-click', () => {
      clicked = true;
    });

    const indicator = shadow(element).querySelector('.indicator') as HTMLElement;
    indicator.click();

    expect(clicked).toBe(true);
  });
});
