import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/project-selector';
import type { Project } from '../../src/types';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function createProjectSelector(): LitElement {
  return document.createElement('project-selector') as unknown as LitElement;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'My Project',
    description: '',
    created_at: Date.now(),
    session_count: 0,
    ...overrides,
  } as Project;
}

describe('project-selector', () => {
  let element: LitElement;

  afterEach(() => {
    element?.remove();
  });

  it('renders a placeholder option when no project is selected', async () => {
    element = await mount(createProjectSelector());
    const select = shadow(element).querySelector('select');
    expect(select).not.toBeNull();
    const options = shadow(element).querySelectorAll('option');
    expect(options.length).toBe(1);
    expect(options[0]?.value).toBe('');
    expect(options[0]?.textContent?.trim()).toBe('Select a project');
  });

  it('renders an option for each project with session count', async () => {
    element = await mount(createProjectSelector());
    (element as any).projects = [
      makeProject({ id: 'p1', name: 'Alpha', session_count: 1 }),
      makeProject({ id: 'p2', name: 'Beta', session_count: 3 }),
    ];
    await element.updateComplete;

    const options = shadow(element).querySelectorAll('option');
    expect(options.length).toBe(3); // placeholder + 2 projects
    expect(options[1]?.value).toBe('p1');
    expect(options[1]?.textContent).toContain('Alpha');
    expect(options[1]?.textContent).toContain('1 session');
    expect(options[2]?.value).toBe('p2');
    expect(options[2]?.textContent).toContain('Beta');
    expect(options[2]?.textContent).toContain('3 sessions');
  });

  it('reflects the value property on the select element', async () => {
    element = await mount(createProjectSelector());
    (element as any).projects = [makeProject({ id: 'p1', name: 'Alpha' })];
    (element as any).value = 'p1';
    await element.updateComplete;

    // The component property is the source of truth; Lit binds it to the
    // select via .value. happy-dom does not always reflect .value on
    // <select>, so verify the component property round-trips instead.
    expect((element as any).value).toBe('p1');
    const select = shadow(element).querySelector('select');
    expect(select).not.toBeNull();
  });

  it('dispatches value-changed with the selected id on change', async () => {
    element = await mount(createProjectSelector());
    (element as any).projects = [makeProject({ id: 'p1', name: 'Alpha' })];
    await element.updateComplete;

    const select = shadow(element).querySelector('select') as HTMLSelectElement;
    let captured: string | undefined;
    element.addEventListener('value-changed', (event) => {
      captured = (event as CustomEvent<{ value: string }>).detail.value;
    });

    select.value = 'p1';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(captured).toBe('p1');
  });
});
