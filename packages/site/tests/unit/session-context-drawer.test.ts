import type { ContextTimingPoint } from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContextDrawer } from '../../src/pages/session-evidence/session-context-drawer';
import '../../src/pages/session-evidence/session-context-drawer';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleMessage: ContextTimingPoint = {
  turnNumber: 2,
  messageIndex: 2,
  messageId: 'msg-42',
  role: 'assistant',
  model: 'claude-3-7-sonnet',
  timestamp: '2026-08-11T10:00:05.000Z',
  totalTokens: 1500,
  contextTokens: 1200,
  generationTokens: 300,
  inputTokens: 200,
  cacheReadTokens: 600,
  cacheCreationTokens: 400,
  thinkingTokens: 50,
  effort: 'high',
  content: 'Here is the **fix** for the issue:\n\n```ts\nconst a = 1;\n```',
};

describe('session-context-drawer', () => {
  it('renders nothing when message is null', async () => {
    const drawer = await mount(
      document.createElement('session-context-drawer') as SessionContextDrawer,
    );
    expect(shadow(drawer).querySelector('.drawer-panel')).toBeNull();
  });

  it('renders message header, role badge, and token stats when message is provided', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    expect(root.querySelector('.drawer-panel')).not.toBeNull();
    expect(root.textContent).toContain('Message #2');
    expect(root.textContent).toContain('assistant');
    expect(root.textContent).toContain('claude-3-7-sonnet');
    expect(root.textContent).toContain('high');
    expect(root.textContent).toContain('1,200'); // Context tokens
    expect(root.textContent).toContain('300'); // Generation tokens
    expect(root.textContent).toContain('1,500'); // Total tokens
    expect(root.textContent).toContain('200'); // Input tokens
    expect(root.textContent).toContain('600'); // Cache read
    expect(root.textContent).toContain('400'); // Cache creation
    expect(root.textContent).toContain('50'); // Thinking tokens
  });

  it('renders formatted markdown content in message body', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    const contentBox = root.querySelector('.content-box');
    expect(contentBox).not.toBeNull();
    expect(contentBox?.innerHTML).toContain('<strong>fix</strong>');
    expect(contentBox?.querySelector('code')).not.toBeNull();
  });

  it('emits drawer-close on close button click', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    const closeSpy = vi.fn();
    drawer.addEventListener('drawer-close', closeSpy);

    const closeBtn = root.querySelector('.close-button') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('emits drawer-close on backdrop click', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    const closeSpy = vi.fn();
    drawer.addEventListener('drawer-close', closeSpy);

    const backdrop = root.querySelector('.drawer-backdrop') as HTMLElement;
    expect(backdrop).not.toBeNull();
    backdrop.click();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('emits drawer-close on Escape key press', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);

    const closeSpy = vi.fn();
    drawer.addEventListener('drawer-close', closeSpy);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('stops propagation and prevents default on Escape key press', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    const stopSpy = vi.spyOn(event, 'stopPropagation');
    const prevSpy = vi.spyOn(event, 'preventDefault');
    window.dispatchEvent(event);

    expect(stopSpy).toHaveBeenCalled();
    expect(prevSpy).toHaveBeenCalled();
  });

  it('traps focus to close-button when Tab is pressed on the boundary', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);
    const closeBtn = root.querySelector('.close-button') as HTMLButtonElement;

    closeBtn.focus();
    expect(root.activeElement).toBe(closeBtn);

    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    const prevSpy = vi.spyOn(event, 'preventDefault');
    window.dispatchEvent(event);

    expect(prevSpy).toHaveBeenCalled();
  });

  it('traps focus to close-button when Shift+Tab is pressed on the boundary', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);
    const closeBtn = root.querySelector('.close-button') as HTMLButtonElement;

    closeBtn.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    const prevSpy = vi.spyOn(event, 'preventDefault');
    window.dispatchEvent(event);

    expect(prevSpy).toHaveBeenCalled();
  });
});
