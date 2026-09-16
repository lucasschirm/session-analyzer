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

  it('labels the Tool / Skill / Agent domain of a classified message', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: { ...sampleMessage, invocationKind: 'skill' },
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    const badge = root.querySelector('.kind-badge');
    expect(badge?.textContent?.trim()).toBe('skill message');
    expect(badge?.getAttribute('data-kind')).toBe('skill');
  });

  it('renders no domain badge for a message the transformer left unclassified', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    expect(root.querySelector('.kind-badge')).toBeNull();
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

  it('wraps focus back to the close button when Tab is pressed on the last control', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);
    const closeBtn = root.querySelector('.close-button') as HTMLButtonElement;
    const focusables = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[];
    const last = focusables[focusables.length - 1] as HTMLButtonElement;

    last.focus();
    expect(root.activeElement).toBe(last);

    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    const prevSpy = vi.spyOn(event, 'preventDefault');
    window.dispatchEvent(event);

    expect(prevSpy).toHaveBeenCalled();
    expect(root.activeElement).toBe(closeBtn);
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

  it('renders Compacted Tokens stat card when compactedTokens is present', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: {
        ...sampleMessage,
        compactedTokens: 38000,
      },
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    expect(root.textContent).toContain('Compacted Tokens');
    expect(root.textContent).toContain('38,000');
  });

  it('renders Compacted Tokens stat card when removedTokens fallback is present', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: {
        ...sampleMessage,
        removedTokens: 25000,
      },
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    expect(root.textContent).toContain('Compacted Tokens');
    expect(root.textContent).toContain('25,000');
  });

  it('does not render Compacted Tokens stat card when neither is present', async () => {
    const drawer = Object.assign(document.createElement('session-context-drawer'), {
      message: sampleMessage,
    }) as SessionContextDrawer;
    await mount(drawer);
    const root = shadow(drawer);

    expect(root.textContent).not.toContain('Compacted Tokens');
  });

  describe('parsed / raw content toggle', () => {
    function toggleButtons(root: ShadowRoot): HTMLButtonElement[] {
      return Array.from(root.querySelectorAll('.view-toggle button')) as HTMLButtonElement[];
    }

    function parsedButton(root: ShadowRoot): HTMLButtonElement {
      return toggleButtons(root).find(
        (b) => b.textContent?.trim() === 'Parsed',
      ) as HTMLButtonElement;
    }

    function rawButton(root: ShadowRoot): HTMLButtonElement {
      return toggleButtons(root).find((b) => b.textContent?.trim() === 'Raw') as HTMLButtonElement;
    }

    async function drawerWith(message: ContextTimingPoint | null = sampleMessage) {
      const drawer = Object.assign(document.createElement('session-context-drawer'), {
        message,
      }) as SessionContextDrawer;
      await mount(drawer);
      return { drawer, root: shadow(drawer) };
    }

    it('is on parsed by default and renders the markdown body', async () => {
      const { root } = await drawerWith();

      expect(parsedButton(root).getAttribute('aria-pressed')).toBe('true');
      expect(rawButton(root).getAttribute('aria-pressed')).toBe('false');
      expect(root.querySelector('.content-box strong')?.textContent).toBe('fix');
      expect(root.querySelector('pre.raw-json')).toBeNull();
    });

    it('shows the message record as formatted JSON when raw is clicked', async () => {
      const drawer = Object.assign(document.createElement('session-context-drawer'), {
        message: sampleMessage,
      }) as SessionContextDrawer;
      await mount(drawer);
      const root = shadow(drawer);

      rawButton(root).click();
      await drawer.updateComplete;

      const pre = root.querySelector('pre.raw-json');
      expect(pre).not.toBeNull();
      expect(pre?.textContent).toBe(JSON.stringify(sampleMessage, null, 2));
      // Formatted, not minified: the JSON is indented and multi-line.
      expect(pre?.textContent).toContain('\n  "messageId": "msg-42",');
      expect(parsedButton(root).getAttribute('aria-pressed')).toBe('false');
      expect(rawButton(root).getAttribute('aria-pressed')).toBe('true');
      // The parsed markdown is gone, not merely hidden behind the JSON.
      expect(root.querySelector('.content-box strong')).toBeNull();
    });

    it('switches back to the parsed view', async () => {
      const drawer = Object.assign(document.createElement('session-context-drawer'), {
        message: sampleMessage,
      }) as SessionContextDrawer;
      await mount(drawer);
      const root = shadow(drawer);

      rawButton(root).click();
      await drawer.updateComplete;
      parsedButton(root).click();
      await drawer.updateComplete;

      expect(root.querySelector('pre.raw-json')).toBeNull();
      expect(root.querySelector('.content-box strong')?.textContent).toBe('fix');
    });

    it('keeps the JSON view available for a message with no content', async () => {
      const drawer = Object.assign(document.createElement('session-context-drawer'), {
        message: { ...sampleMessage, content: undefined },
      }) as SessionContextDrawer;
      await mount(drawer);
      const root = shadow(drawer);

      expect(root.querySelector('.content-box')?.textContent).toContain(
        'No content recorded for this message.',
      );

      rawButton(root).click();
      await drawer.updateComplete;

      expect(root.querySelector('pre.raw-json')?.textContent).toContain('"contextTokens": 1200');
      expect(root.textContent).not.toContain('No content recorded');
    });

    it('resets to parsed when a different message is selected', async () => {
      const drawer = Object.assign(document.createElement('session-context-drawer'), {
        message: sampleMessage,
      }) as SessionContextDrawer;
      await mount(drawer);
      const root = shadow(drawer);

      rawButton(root).click();
      await drawer.updateComplete;
      expect(root.querySelector('pre.raw-json')).not.toBeNull();

      drawer.message = { ...sampleMessage, messageId: 'msg-43', content: 'Next **message**' };
      await drawer.updateComplete;

      expect(root.querySelector('pre.raw-json')).toBeNull();
      expect(parsedButton(root).getAttribute('aria-pressed')).toBe('true');
      expect(root.querySelector('.content-box strong')?.textContent).toBe('message');
    });

    it('exposes the toggle as a labelled group for assistive technology', async () => {
      const { root } = await drawerWith();
      const group = root.querySelector('.view-toggle');
      expect(group?.getAttribute('role')).toBe('group');
      expect(group?.getAttribute('aria-label')).toBe('Message content format');
    });
  });
});
