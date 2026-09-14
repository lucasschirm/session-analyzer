import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/sqlite-explorer-modal';
import type { SqliteExplorerModal } from '../../src/components/sqlite-explorer-modal';
import {
  DEFAULT_SQLITE_EXPLORER_URL,
  HANDOVER_ACK_TYPE,
  HANDOVER_MESSAGE_TYPE,
  HANDOVER_NACK_TYPE,
} from '../../src/components/sqlite-explorer-modal';

describe('sqlite-explorer-modal', () => {
  let modal: SqliteExplorerModal;

  beforeEach(() => {
    vi.spyOn(window, 'fetch').mockResolvedValue(new Response('<!doctype html><html></html>'));
    modal = document.createElement('sqlite-explorer-modal') as SqliteExplorerModal;
    document.body.appendChild(modal);
  });

  afterEach(() => {
    modal.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders nothing when closed', async () => {
    modal.open = false;
    await modal.updateComplete;

    expect(modal.shadowRoot?.querySelector('.explorer-overlay')).toBeNull();
  });

  it('renders header, title, badge, and iframe when open', async () => {
    modal.open = true;
    modal.dbName = 'Control DB';
    modal.filename = '/session-analyzer.sqlite3';
    modal.blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/x-sqlite3' });
    await modal.updateComplete;

    const overlay = modal.shadowRoot?.querySelector('.explorer-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain('SQLite Explorer');
    expect(overlay?.textContent).toContain('Control DB');

    const iframe = modal.shadowRoot?.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('credentialless')).toBe('');
    expect(iframe?.getAttribute('title')).toBe('SQLite Explorer');

    const src = iframe?.getAttribute('src') ?? '';
    expect(src).toContain(DEFAULT_SQLITE_EXPLORER_URL);
    expect(src).toContain('handoverOrigins=');
  });

  it('toggles between fullscreen and partial screen modes', async () => {
    modal.open = true;
    modal.dbName = 'Analytics DB';
    await modal.updateComplete;

    const overlay = modal.shadowRoot?.querySelector('.explorer-overlay');
    expect(overlay?.classList.contains('fullscreen')).toBe(false);

    const toggleBtn = modal.shadowRoot?.querySelector('.toolbar-btn') as HTMLButtonElement;
    expect(toggleBtn.textContent?.trim()).toContain('Fullscreen');

    // Toggle to fullscreen
    toggleBtn.click();
    await modal.updateComplete;

    expect(modal.isFullscreen).toBe(true);
    expect(overlay?.classList.contains('fullscreen')).toBe(true);
    expect(toggleBtn.textContent?.trim()).toContain('Partial screen');

    // Toggle back to partial screen
    toggleBtn.click();
    await modal.updateComplete;

    expect(modal.isFullscreen).toBe(false);
    expect(overlay?.classList.contains('fullscreen')).toBe(false);
    expect(toggleBtn.textContent?.trim()).toContain('Fullscreen');
  });

  it('handles Escape key: exits fullscreen first, then closes modal', async () => {
    modal.open = true;
    modal.isFullscreen = true;
    await modal.updateComplete;

    let closeFired = false;
    modal.addEventListener('modal-close', () => {
      closeFired = true;
    });

    // Press Escape while in fullscreen: should exit fullscreen without closing modal
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await modal.updateComplete;

    expect(modal.isFullscreen).toBe(false);
    expect(closeFired).toBe(false);
    expect(modal.open).toBe(true);

    // Press Escape again while in partial screen: should close modal
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await modal.updateComplete;

    expect(closeFired).toBe(true);
    expect(modal.open).toBe(false);
  });

  it('closes when clicking close button', async () => {
    modal.open = true;
    await modal.updateComplete;

    let closeFired = false;
    modal.addEventListener('modal-close', () => {
      closeFired = true;
    });

    const closeBtn = modal.shadowRoot?.querySelector('.close-btn') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    await modal.updateComplete;

    expect(closeFired).toBe(true);
    expect(modal.open).toBe(false);
  });

  it('closes when clicking the backdrop in partial screen mode', async () => {
    modal.open = true;
    modal.isFullscreen = false;
    await modal.updateComplete;

    let closeFired = false;
    modal.addEventListener('modal-close', () => {
      closeFired = true;
    });

    const overlay = modal.shadowRoot?.querySelector('.explorer-overlay') as HTMLElement;
    overlay.click();
    await modal.updateComplete;

    expect(closeFired).toBe(true);
    expect(modal.open).toBe(false);
  });

  it('executes database handover and handles ACK reply', async () => {
    const postMessageSpy = vi.fn();
    const fakeContentWindow = { postMessage: postMessageSpy } as unknown as Window;

    modal.open = true;
    modal.dbName = 'Control DB';
    modal.filename = '/control.sqlite3';
    modal.blob = new Blob([new Uint8Array([1, 2, 3])]);
    await modal.updateComplete;

    const iframe = modal.shadowRoot?.querySelector('iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: fakeContentWindow,
      configurable: true,
    });

    // Trigger iframe load
    iframe.dispatchEvent(new Event('load'));
    await modal.updateComplete;

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HANDOVER_MESSAGE_TYPE,
        name: 'control.sqlite3',
        blob: modal.blob,
      }),
      new URL(DEFAULT_SQLITE_EXPLORER_URL).origin,
    );
    expect(modal.handoverState).toBe('loading');

    // Simulate ACK reply from explorer
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: new URL(DEFAULT_SQLITE_EXPLORER_URL).origin,
        data: { type: HANDOVER_ACK_TYPE, name: 'control.sqlite3' },
      }),
    );
    await modal.updateComplete;

    expect(modal.handoverState).toBe('ready');
    const statusPill = modal.shadowRoot?.querySelector('.status-pill.ready');
    expect(statusPill).not.toBeNull();
    expect(statusPill?.textContent).toContain('Ready');
  });

  it('handles NACK reply with error message and retry', async () => {
    const postMessageSpy = vi.fn();
    const fakeContentWindow = { postMessage: postMessageSpy } as unknown as Window;

    modal.open = true;
    modal.filename = 'test.db';
    modal.blob = new Blob([new Uint8Array([1])]);
    await modal.updateComplete;

    const iframe = modal.shadowRoot?.querySelector('iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: fakeContentWindow,
      configurable: true,
    });

    iframe.dispatchEvent(new Event('load'));
    await modal.updateComplete;

    // Simulate NACK reply from explorer
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: new URL(DEFAULT_SQLITE_EXPLORER_URL).origin,
        data: { type: HANDOVER_NACK_TYPE, reason: 'Invalid SQLite header' },
      }),
    );
    await modal.updateComplete;

    expect(modal.handoverState).toBe('error');
    expect(modal.errorMessage).toBe('Invalid SQLite header');

    const retryBtn = modal.shadowRoot?.querySelector('.retry-btn') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();

    postMessageSpy.mockClear();
    retryBtn.click();
    await modal.updateComplete;

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(modal.handoverState).toBe('loading');
  });

  it('handles handover timeout', async () => {
    vi.useFakeTimers();
    const postMessageSpy = vi.fn();
    const fakeContentWindow = { postMessage: postMessageSpy } as unknown as Window;

    modal.open = true;
    modal.filename = 'test.db';
    modal.blob = new Blob([new Uint8Array([1])]);
    await modal.updateComplete;

    const iframe = modal.shadowRoot?.querySelector('iframe') as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
      value: fakeContentWindow,
      configurable: true,
    });

    iframe.dispatchEvent(new Event('load'));
    await modal.updateComplete;

    expect(modal.handoverState).toBe('loading');

    // Advance 15 seconds
    vi.advanceTimersByTime(15_000);
    await modal.updateComplete;

    expect(modal.handoverState).toBe('error');
    expect(modal.errorMessage).toContain('timed out');
  });
});
