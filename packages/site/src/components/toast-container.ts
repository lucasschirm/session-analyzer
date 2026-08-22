import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

/**
 * Toast notification types.
 *
 * - `error` — sticky by default (requires manual dismiss), red.
 * - `warning` — auto-dismisses after 8s, amber.
 * - `info` — auto-dismisses after 6s, blue.
 * - `success` — auto-dismisses after 4s, green.
 */
export type ToastType = 'error' | 'warning' | 'info' | 'success';

/** A single toast notification. */
export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  hint?: string;
  link?: string;
  linkLabel?: string;
  createdAt: number;
  autoDismissMs: number;
}

/** Options passed to {@link ToastManager.show}. */
export interface ToastOptions {
  message?: string;
  hint?: string;
  link?: string;
  linkLabel?: string;
  /** Override the auto-dismiss delay; 0 = sticky (never auto-dismiss). */
  autoDismissMs?: number;
}

const DEFAULT_AUTO_DISMISS_MS: Record<ToastType, number> = {
  error: 0,
  warning: 8_000,
  info: 6_000,
  success: 4_000,
};

const MAX_TOASTS = 5;

function generateToastId(): string {
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Singleton toast manager. Components and services call `toastManager.error()`
 * (etc.) to show a notification; the {@link ToastContainer} component
 * subscribes to `change` events and renders the stack.
 */
export class ToastManager extends EventTarget {
  private toasts: Toast[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Returns a snapshot of the current toast stack (newest first). */
  getToasts(): Toast[] {
    return [...this.toasts];
  }

  /** Shows an error toast (sticky by default). Returns the toast id. */
  error(title: string, options: ToastOptions = {}): string {
    return this.show('error', title, options);
  }

  /** Shows a warning toast. Returns the toast id. */
  warning(title: string, options: ToastOptions = {}): string {
    return this.show('warning', title, options);
  }

  /** Shows an info toast. Returns the toast id. */
  info(title: string, options: ToastOptions = {}): string {
    return this.show('info', title, options);
  }

  /** Shows a success toast. Returns the toast id. */
  success(title: string, options: ToastOptions = {}): string {
    return this.show('success', title, options);
  }

  /** Shows a toast of the given type. Returns the toast id. */
  show(type: ToastType, title: string, options: ToastOptions = {}): string {
    const id = generateToastId();
    const autoDismissMs = options.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS[type];
    const toast: Toast = {
      id,
      type,
      title,
      message: options.message,
      hint: options.hint,
      link: options.link,
      linkLabel: options.linkLabel,
      createdAt: Date.now(),
      autoDismissMs,
    };

    this.toasts.unshift(toast);
    if (this.toasts.length > MAX_TOASTS) {
      const removed = this.toasts.splice(MAX_TOASTS);
      for (const r of removed) this.clearTimer(r.id);
    }

    if (autoDismissMs > 0) {
      this.timers.set(
        id,
        setTimeout(() => this.dismiss(id), autoDismissMs),
      );
    }

    this.emitChange();
    return id;
  }

  /** Dismisses a single toast by id. */
  dismiss(id: string): void {
    const index = this.toasts.findIndex((t) => t.id === id);
    if (index === -1) return;
    this.toasts.splice(index, 1);
    this.clearTimer(id);
    this.emitChange();
  }

  /** Dismisses all toasts. */
  clear(): void {
    for (const id of this.timers.keys()) this.clearTimer(id);
    this.timers.clear();
    this.toasts = [];
    this.emitChange();
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private emitChange(): void {
    this.dispatchEvent(new CustomEvent<Toast[]>('change', { detail: this.getToasts() }));
  }
}

/** App-wide singleton. */
export const toastManager = new ToastManager();

/**
 * Fixed-position toast stack. Subscribes to {@link toastManager} and renders
 * the current toasts in the top-right corner. Error toasts include a close
 * button; all toasts can be dismissed by clicking.
 */
@customElement('toast-container')
export class ToastContainer extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .toast-stack {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 420px;
      pointer-events: none;
    }

    .toast {
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      background: var(--md-sys-color-surface-container, #1f242e);
      color: var(--md-sys-color-on-surface, #e6e9ef);
      font-size: 13px;
      line-height: 1.45;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
      animation: toast-in 0.18s ease-out;
    }

    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateX(12px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .toast.error {
      border-color: var(--md-sys-color-error, #ff6b6b);
      background: var(--md-sys-color-error-container, #5c2626);
      color: var(--md-sys-color-on-error-container, #ffb4ab);
    }

    .toast.warning {
      border-color: var(--md-sys-color-tertiary, #e0a800);
      background: rgba(224, 168, 0, 0.12);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .toast.info {
      border-color: var(--md-sys-color-primary, #4f8cff);
      background: rgba(79, 140, 255, 0.12);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .toast.success {
      border-color: var(--md-sys-color-success, #3ecf8e);
      background: rgba(62, 207, 142, 0.12);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .toast-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .toast-title {
      font-weight: 700;
      font-size: 13px;
    }

    .toast-close {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: inherit;
      opacity: 0.6;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 0 2px;
    }

    .toast-close:hover {
      opacity: 1;
    }

    .toast-message {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      opacity: 0.9;
      word-break: break-word;
    }

    .toast-hint {
      font-size: 12px;
      opacity: 0.75;
    }

    .toast-hint strong {
      opacity: 1;
    }

    .toast-link {
      font-size: 12px;
      color: inherit;
      text-decoration: underline;
      opacity: 0.85;
    }

    .toast-link:hover {
      opacity: 1;
    }
  `;

  @state() private toasts: Toast[] = [];

  connectedCallback(): void {
    super.connectedCallback();
    this.toasts = toastManager.getToasts();
    toastManager.addEventListener('change', this.handleChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    toastManager.removeEventListener('change', this.handleChange);
  }

  private handleChange = (event: Event): void => {
    this.toasts = (event as CustomEvent<Toast[]>).detail;
  };

  private handleDismiss(id: string, event: Event): void {
    event.stopPropagation();
    toastManager.dismiss(id);
  }

  private handleToastClick(id: string): void {
    toastManager.dismiss(id);
  }

  private renderToast(toast: Toast): TemplateResult {
    return html`
      <div
        class="toast ${toast.type}"
        role=${toast.type === 'error' ? 'alert' : 'status'}
        aria-live=${toast.type === 'error' ? 'assertive' : 'polite'}
        @click=${() => this.handleToastClick(toast.id)}
      >
        <div class="toast-header">
          <span class="toast-title">${toast.title}</span>
          <button
            class="toast-close"
            title="Dismiss"
            @click=${(e: Event) => this.handleDismiss(toast.id, e)}
          >
            ×
          </button>
        </div>
        ${toast.message ? html`<div class="toast-message">${toast.message}</div>` : ''}
        ${
          toast.hint ? html`<div class="toast-hint"><strong>Hint:</strong> ${toast.hint}</div>` : ''
        }
        ${
          toast.link
            ? html`<a
              class="toast-link"
              href=${toast.link}
              target="_blank"
              rel="noopener"
              @click=${(e: Event) => e.stopPropagation()}
            >
              ${toast.linkLabel ?? 'Learn more'}
            </a>`
            : ''
        }
      </div>
    `;
  }

  render(): TemplateResult {
    if (this.toasts.length === 0) return html``;
    return html`
      <div class="toast-stack">
        ${this.toasts.map((toast) => this.renderToast(toast))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'toast-container': ToastContainer;
  }
}
