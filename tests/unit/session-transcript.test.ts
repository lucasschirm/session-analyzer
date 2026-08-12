// @vitest-environment jsdom
// jsdom is required because DOMPurify sanitization (used by the transcript
// markdown renderer) does not behave correctly under happy-dom.
import { afterEach, describe, expect, it } from 'vitest';
import type { LitElement } from 'lit';
import '../../src/components/session-transcript';
import type { SessionTranscript } from '../../src/components/session-transcript';
import type { TranscriptMessage } from '../../src/types';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

function message(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    id: 'm1',
    session_id: 's1',
    role: 'user',
    content: 'Hello',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('session-transcript', () => {
  it('shows a placeholder without messages', async () => {
    const transcript = await mount(document.createElement('session-transcript') as SessionTranscript);
    expect(transcript.shadowRoot?.textContent).toContain('No transcript messages');
  });

  it('renders user and assistant bubbles with distinct roles', async () => {
    const transcript = await mount(Object.assign(document.createElement('session-transcript'), {
      messages: [
        message({ id: 'm1', role: 'user', content: 'Add a REST route' }),
        message({ id: 'm2', role: 'assistant', content: 'Done. See `api.controller.ts`.' }),
      ],
    }) as SessionTranscript);
    const root = transcript.shadowRoot as ShadowRoot;

    const bubbles = root.querySelectorAll('.message');
    expect(bubbles.length).toBe(2);
    expect(bubbles[0].classList.contains('user')).toBe(true);
    expect(bubbles[1].classList.contains('assistant')).toBe(true);
    expect(root.textContent).toContain('Add a REST route');
  });

  it('renders markdown inside messages', async () => {
    const transcript = await mount(Object.assign(document.createElement('session-transcript'), {
      messages: [message({ id: 'm1', role: 'assistant', content: '**bold** and `code`' })],
    }) as SessionTranscript);
    const root = transcript.shadowRoot as ShadowRoot;

    expect(root.querySelector('.message strong')?.textContent).toBe('bold');
    expect(root.querySelector('.message code')?.textContent).toBe('code');
  });

  it('sanitizes dangerous markdown before rendering', async () => {
    const malicious =
      'Nice <img src="x" onerror="alert(1)"> <script>alert(2)</script> [link](javascript:alert(3))';
    const transcript = await mount(Object.assign(document.createElement('session-transcript'), {
      messages: [message({ id: 'm1', role: 'assistant', content: malicious })],
    }) as SessionTranscript);
    const html = (transcript.shadowRoot as ShadowRoot).innerHTML;

    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });
});
