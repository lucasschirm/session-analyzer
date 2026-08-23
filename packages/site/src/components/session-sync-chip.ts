import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import type { SessionSyncStatus } from '../types';

/**
 * Compact status chip for a synced session.
 *
 * Renders one of five states: `pending`, `processing`, `failed`, `in_sync`, or
 * `transcript_unavailable`. The failed state is clickable and emits
 * `chip-click` so a parent can open the error modal.
 */
@customElement('session-sync-chip')
export class SessionSyncChip extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid transparent;
      white-space: nowrap;
    }

    .chip.clickable {
      cursor: pointer;
    }

    .chip.pending {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      border-color: var(--md-sys-color-outline, #2a303c);
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .chip.processing {
      color: var(--md-sys-color-primary, #4f8cff);
      border-color: var(--md-sys-color-primary, #4f8cff);
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .chip.in_sync {
      color: var(--md-sys-color-success, #3ecf8e);
      border-color: var(--md-sys-color-success, #3ecf8e);
      background: rgba(62, 207, 142, 0.1);
    }

    .chip.failed {
      color: var(--md-sys-color-error, #ff6b6b);
      border-color: var(--md-sys-color-error, #ff6b6b);
      background: var(--md-sys-color-error-container, #5c2626);
    }

    .chip.transcript_unavailable {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      border-color: var(--md-sys-color-outline, #2a303c);
      background: var(--md-sys-color-surface-container, #1f242e);
    }

    .icon {
      width: 14px;
      text-align: center;
    }

    .processing .icon {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;

  @property({ type: String }) status: SessionSyncStatus | '' = '';

  @property({ type: String }) details = '';

  private get displayStatus(): SessionSyncStatus | 'unknown' {
    if (
      this.status === 'pending' ||
      this.status === 'processing' ||
      this.status === 'in_sync' ||
      this.status === 'failed' ||
      this.status === 'transcript_unavailable'
    ) {
      return this.status;
    }
    return 'unknown';
  }

  private get label(): string {
    switch (this.displayStatus) {
      case 'pending':
        return 'pending';
      case 'processing':
        return 'processing';
      case 'in_sync':
        return 'in sync';
      case 'failed':
        return 'failed';
      case 'transcript_unavailable':
        return 'no transcript';
      default:
        return this.status;
    }
  }

  private get icon(): string {
    switch (this.displayStatus) {
      case 'pending':
        return '🕒';
      case 'processing':
        return '⠋';
      case 'in_sync':
        return '✓';
      case 'failed':
        return '⚠';
      case 'transcript_unavailable':
        return '—';
      default:
        return '';
    }
  }

  private get isClickable(): boolean {
    return this.status === 'failed';
  }

  private get titleText(): string {
    if (this.displayStatus === 'transcript_unavailable') {
      return 'No uploaded transcript exists for this remote session.';
    }
    if (this.details) return this.details;
    if (this.status) return `Sync status: ${this.label}`;
    return '';
  }

  private handleClick(event: Event): void {
    if (!this.isClickable) return;
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent('chip-click', { bubbles: true, composed: true }));
  }

  render(): TemplateResult {
    if (!this.status) return html``;

    const statusClass = this.displayStatus === 'unknown' ? 'pending' : this.displayStatus;
    const chipClasses = {
      chip: true,
      [statusClass]: true,
      clickable: this.isClickable,
    };
    return html`
      <span
        class=${classMap(chipClasses)}
        title=${this.titleText}
        @click=${this.handleClick}
      >
        <span class="icon">${this.icon}</span>
        <span>${this.label}</span>
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-sync-chip': SessionSyncChip;
  }
}
