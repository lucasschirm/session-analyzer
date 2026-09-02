import type { SessionEvidenceSummary } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { cardSurfaceStyles } from '../../components/analytics/card-surface-styles';
import type { MetricCardView } from '../portfolio/portfolio-chart-helpers';
import { outcomeBadgeView } from './session-evidence-chart-helpers';

/**
 * Session Evidence header: breadcrumb + header card (issue #172). Renders
 * the first-user-message excerpt as the page title, chips (harness, mode,
 * outcome), and the precomputed fact columns (Started/Duration/Turns/
 * Tokens/Cost/...) already produced by `summaryToMetricCards`. Purely
 * presentational — no metric derivation happens here
 * (`.agents/rules/no-canonical-metrics-in-lit.md`).
 */
@customElement('session-evidence-header')
export class SessionEvidenceHeader extends LitElement {
  static styles = [
    cardSurfaceStyles,
    css`
    :host {
      display: block;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--rd-ink-muted, #9aa4b2);
      margin-bottom: 12px;
    }

    .breadcrumb a {
      color: var(--rd-ink-muted, #9aa4b2);
      text-decoration: none;
    }

    .breadcrumb a:hover {
      color: var(--rd-accent, #4f8cff);
      text-decoration: underline;
    }

    .breadcrumb .crumb-session {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--rd-ink-primary, #e6e9ef);
    }

    .session-evidence-header {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.35;
      font-weight: 600;
      color: var(--rd-ink-primary, #e6e9ef);
      word-break: break-word;
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--rd-border-2, #232936);
      background: var(--rd-surface-inset, #12151c);
      color: var(--rd-ink-secondary, #c9d4e3);
    }

    .outcome-badge {
      font-weight: 600;
    }

    .outcome-badge.good {
      color: var(--rd-status-good, #3ecf8e);
      border-color: var(--rd-status-good, #3ecf8e);
    }

    .outcome-badge.warning {
      color: var(--rd-status-warning, #fab219);
      border-color: var(--rd-status-warning, #fab219);
    }

    .outcome-badge.critical {
      color: var(--rd-status-critical, #d03b3b);
      border-color: var(--rd-status-critical, #d03b3b);
    }

    .outcome-badge.unknown {
      color: var(--rd-ink-faint, #7d8794);
    }

    .fact-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 12px;
      border-top: 1px solid var(--rd-border-2, #232936);
      padding-top: 14px;
    }

    .fact {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .fact-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      color: var(--rd-ink-muted, #9aa4b2);
    }

    .fact-value {
      font-size: 16px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--rd-ink-primary, #e6e9ef);
    }

    .fact-sub {
      font-size: 11px;
      color: var(--rd-ink-faint, #7d8794);
    }

    .fact-link {
      color: var(--rd-accent, #4f8cff);
      text-decoration: none;
      cursor: pointer;
    }

    .fact-link:hover {
      text-decoration: underline;
    }
    `,
  ];

  @property({ type: Object, attribute: false }) summary: SessionEvidenceSummary | null = null;

  @property({ type: String }) sessionId = '';

  @property({ type: String }) titleExcerpt: string | null = null;

  @property({ type: Array, attribute: false }) facts: MetricCardView[] = [];

  @property({ type: String }) projectHref: string | undefined = undefined;

  @property({ type: Number }) subAgentCount: number | null = null;

  @property({ type: String }) subAgentHref = '';

  private renderBreadcrumb() {
    return html`
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <a href="#/">Portfolio</a>
        <span aria-hidden="true">/</span>
        ${
          this.projectHref
            ? html`<a href=${this.projectHref}>Project</a><span aria-hidden="true">/</span>`
            : ''
        }
        <span class="crumb-session">${this.sessionId}</span>
      </nav>
    `;
  }

  private renderOutcomeChip() {
    const view = outcomeBadgeView(this.summary?.outcome);
    if (!view) return '';
    return html`
      <span class="chip outcome-badge ${view.tone}" title="Session outcome: ${view.label}">
        <span aria-hidden="true">${view.icon}</span>${view.label}
      </span>
    `;
  }

  private renderChips() {
    const harness = this.summary?.harness;
    const mode = this.summary?.mode;
    return html`
      <div class="chips">
        ${harness ? html`<span class="chip">${harness}</span>` : ''}
        ${mode ? html`<span class="chip">Mode: ${mode}</span>` : ''}
        ${this.renderOutcomeChip()}
      </div>
    `;
  }

  private renderFacts() {
    return html`
      <div class="fact-grid">
        ${repeat(
          this.facts,
          (fact) => fact.metricId,
          (fact) => html`
            <div class="fact">
              <span class="fact-label">${fact.label}</span>
              <span class="fact-value">
                ${
                  fact.href
                    ? html`<a class="fact-link" href=${fact.href}>${fact.value}</a>`
                    : fact.value
                }
              </span>
              <span class="fact-sub">${fact.sub}</span>
            </div>
          `,
        )}
        ${
          this.subAgentCount !== null
            ? html`
              <div class="fact">
                <span class="fact-label">Sub agents</span>
                <span class="fact-value">
                  ${
                    this.subAgentCount > 0
                      ? html`<a class="fact-link" href=${this.subAgentHref}>${this.subAgentCount}</a>`
                      : this.subAgentCount
                  }
                </span>
              </div>
            `
            : ''
        }
      </div>
    `;
  }

  render() {
    const title = this.titleExcerpt || `Session ${this.sessionId}`;
    return html`
      ${this.renderBreadcrumb()}
      <div class="card-surface session-evidence-header">
        <div class="title-row">
          <h1>${title}</h1>
        </div>
        ${this.renderChips()}
        ${this.renderFacts()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-evidence-header': SessionEvidenceHeader;
  }
}
