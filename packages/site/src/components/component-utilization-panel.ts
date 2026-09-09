import type {
  ComponentDomain,
  ComponentUtilizationItemDto,
  DomainUtilizationSummaryDto,
  ScopeUtilizationReportDto,
  SessionDomainUtilizationDto,
} from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

const DOMAIN_LABELS: Record<ComponentDomain, string> = {
  tool: 'Tools',
  skill: 'Skills',
  agent: 'Agents',
};

const DOMAIN_ICONS: Record<ComponentDomain, string> = {
  tool: '🔧',
  skill: '⚡',
  agent: '🤖',
};

const TIER_LABELS: Record<ComponentUtilizationItemDto['tier'], string> = {
  unused: 'Unused (0%)',
  lt10: '< 10%',
  lt25: '10% – 25%',
  lt50: '25% – 50%',
  gte50: '≥ 50%',
  insufficient_sample: 'Low sample',
};

const TIER_CLASSES: Record<ComponentUtilizationItemDto['tier'], string> = {
  unused: 'badge-unused',
  lt10: 'badge-critical',
  lt25: 'badge-warning',
  lt50: 'badge-moderate',
  gte50: 'badge-good',
  insufficient_sample: 'badge-insufficient',
};

@customElement('component-utilization-panel')
export class ComponentUtilizationPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      margin-bottom: 24px;
    }

    .panel {
      background: var(--md-sys-color-surface-container, #1f242e);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 12px;
      padding: 20px;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }

    .panel-title {
      font-size: 18px;
      font-weight: 600;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .panel-meta {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
    }

    .table-container {
      overflow-x: auto;
      margin-bottom: 16px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    th {
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: var(--md-sys-color-surface, #171a21);
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .domain-cell {
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      color: var(--md-sys-color-primary, #4f8cff);
    }

    .domain-cell:hover {
      text-decoration: underline;
    }

    .metric-value {
      font-weight: 500;
    }

    .metric-zero {
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      opacity: 0.6;
    }

    .metric-highlight {
      color: #ffaa44;
      font-weight: 600;
    }

    .metric-unused {
      color: #ff6666;
      font-weight: 600;
    }

    .domain-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--md-sys-color-outline, #2a303c);
      padding-bottom: 8px;
    }

    .domain-tab {
      background: transparent;
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .domain-tab:hover {
      background: var(--md-sys-color-surface-container-hover, #262d3a);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .domain-tab.active {
      background: var(--md-sys-color-primary, #4f8cff);
      color: #ffffff;
      border-color: var(--md-sys-color-primary, #4f8cff);
    }

    .details-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--md-sys-color-outline, #2a303c);
    }

    .component-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }

    .component-card {
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      border-radius: 8px;
      padding: 10px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .component-name {
      font-family: monospace;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
      white-space: nowrap;
    }

    .badge-unused {
      background: rgba(255, 102, 102, 0.2);
      color: #ff8888;
      border: 1px solid rgba(255, 102, 102, 0.4);
    }

    .badge-critical {
      background: rgba(255, 170, 68, 0.2);
      color: #ffbb66;
      border: 1px solid rgba(255, 170, 68, 0.4);
    }

    .badge-warning {
      background: rgba(255, 215, 0, 0.2);
      color: #ffd700;
      border: 1px solid rgba(255, 215, 0, 0.4);
    }

    .badge-moderate {
      background: rgba(100, 180, 255, 0.2);
      color: #88c8ff;
      border: 1px solid rgba(100, 180, 255, 0.4);
    }

    .badge-good {
      background: rgba(92, 219, 149, 0.2);
      color: #5cdb95;
      border: 1px solid rgba(92, 219, 149, 0.4);
    }

    .badge-insufficient {
      background: rgba(150, 150, 150, 0.2);
      color: #aaaaaa;
      border: 1px solid rgba(150, 150, 150, 0.4);
    }

    .pill-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .pill {
      font-family: monospace;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 4px;
      background: var(--md-sys-color-surface, #171a21);
      border: 1px solid var(--md-sys-color-outline, #2a303c);
      color: var(--md-sys-color-on-surface, #e6e9ef);
    }

    .pill.used {
      border-color: rgba(92, 219, 149, 0.4);
      color: #5cdb95;
    }

    .pill.unused {
      border-color: rgba(255, 102, 102, 0.4);
      color: #ff8888;
    }

    .empty-note {
      font-size: 12px;
      color: var(--md-sys-color-on-surface-variant, #9aa4b2);
      font-style: italic;
    }
  `;

  @property({ type: Object }) report: ScopeUtilizationReportDto | null = null;
  @property({ type: String }) heading: string = 'Component Utilization';
  @state() private selectedDomain: ComponentDomain = 'tool';

  private renderAggregateMatrix(report: ScopeUtilizationReportDto) {
    const domains: ComponentDomain[] = ['tool', 'skill', 'agent'];
    const minSample = report.domains.tool?.minSampleSizeConfig ?? 5;
    const sampleSessions = report.domains.tool?.sampleSessions ?? 0;

    return html`
      <div class="panel">
        <div class="panel-header">
          <h3 class="panel-title">${this.heading}</h3>
          <span class="panel-meta">
            ${sampleSessions} sessions evaluated • min sample size: ${minSample} sessions
          </span>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Domain</th>
                <th>Total Available</th>
                <th>Total Used</th>
                <th>Total Unused (0%)</th>
                <th>&lt; 10%</th>
                <th>10% – 25%</th>
                <th>25% – 50%</th>
                <th>≥ 50%</th>
                <th>Low Sample (&lt;${minSample})</th>
              </tr>
            </thead>
            <tbody>
              ${domains.map((dom) => {
                const summary = report.domains[dom];
                const tiers = summary?.tiers;
                if (!tiers) return html``;
                return html`
                  <tr>
                    <td>
                      <span
                        class="domain-cell"
                        @click=${() => {
                          this.selectedDomain = dom;
                        }}
                      >
                        ${DOMAIN_ICONS[dom]} ${DOMAIN_LABELS[dom]}
                      </span>
                    </td>
                    <td class="metric-value">${tiers.totalAvailable}</td>
                    <td class="metric-value ${tiers.totalUsed > 0 ? '' : 'metric-zero'}">${tiers.totalUsed}</td>
                    <td class="metric-value ${tiers.totalUnused > 0 ? 'metric-unused' : 'metric-zero'}">${tiers.totalUnused}</td>
                    <td class="metric-value ${tiers.usedLt10Pct > 0 ? 'metric-highlight' : 'metric-zero'}">${tiers.usedLt10Pct}</td>
                    <td class="metric-value ${tiers.usedLt25Pct > 0 ? 'metric-highlight' : 'metric-zero'}">${tiers.usedLt25Pct}</td>
                    <td class="metric-value ${tiers.usedLt50Pct > 0 ? '' : 'metric-zero'}">${tiers.usedLt50Pct}</td>
                    <td class="metric-value ${tiers.usedGte50Pct > 0 ? '' : 'metric-zero'}">${tiers.usedGte50Pct}</td>
                    <td class="metric-value ${tiers.insufficientSample > 0 ? '' : 'metric-zero'}">${tiers.insufficientSample}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>

        <div class="details-section">
          <div class="domain-tabs">
            ${domains.map(
              (dom) => html`
                <button
                  class="domain-tab ${this.selectedDomain === dom ? 'active' : ''}"
                  @click=${() => {
                    this.selectedDomain = dom;
                  }}
                >
                  ${DOMAIN_ICONS[dom]} ${DOMAIN_LABELS[dom]}
                  (${report.domains[dom]?.tiers.totalAvailable ?? 0})
                </button>
              `,
            )}
          </div>

          ${this.renderDomainComponents(report.domains[this.selectedDomain])}
        </div>
      </div>
    `;
  }

  private renderDomainComponents(summary?: DomainUtilizationSummaryDto) {
    if (!summary?.components || summary.components.length === 0) {
      return html`<div class="empty-note">No components offered in this domain.</div>`;
    }

    return html`
      <div class="component-list">
        ${summary.components.map(
          (c) => html`
            <div class="component-card">
              <span class="component-name" title=${c.displayName}>${c.displayName}</span>
              <span class="badge ${TIER_CLASSES[c.tier]}">
                ${TIER_LABELS[c.tier]} (${c.usedSessions}/${c.offeredSessions})
              </span>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderSessionBinary(report: ScopeUtilizationReportDto) {
    const sessionDomains = report.sessionDomains;
    if (!sessionDomains) {
      return html`<div class="panel"><div class="empty-note">No session utilization data available.</div></div>`;
    }

    const domains: ComponentDomain[] = ['tool', 'skill', 'agent'];

    return html`
      <div class="panel">
        <div class="panel-header">
          <h3 class="panel-title">${this.heading}</h3>
          <span class="panel-meta">Binary observation for session ${report.scopeId}</span>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Domain</th>
                <th>Available</th>
                <th>Used</th>
                <th>Unused</th>
              </tr>
            </thead>
            <tbody>
              ${domains.map((dom) => {
                const sd = sessionDomains[dom];
                return html`
                  <tr>
                    <td>
                      <span class="domain-cell">${DOMAIN_ICONS[dom]} ${DOMAIN_LABELS[dom]}</span>
                    </td>
                    <td class="metric-value">${sd.availableCount}</td>
                    <td class="metric-value ${sd.usedCount > 0 ? '' : 'metric-zero'}">${sd.usedCount}</td>
                    <td class="metric-value ${sd.unusedCount > 0 ? 'metric-unused' : 'metric-zero'}">${sd.unusedCount}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>

        <div class="details-section">
          <div class="domain-tabs">
            ${domains.map(
              (dom) => html`
                <button
                  class="domain-tab ${this.selectedDomain === dom ? 'active' : ''}"
                  @click=${() => {
                    this.selectedDomain = dom;
                  }}
                >
                  ${DOMAIN_ICONS[dom]} ${DOMAIN_LABELS[dom]}
                  (${sessionDomains[this.selectedDomain]?.availableCount ?? 0})
                </button>
              `,
            )}
          </div>

          ${this.renderSessionDomainDetails(sessionDomains[this.selectedDomain])}
        </div>
      </div>
    `;
  }

  private renderSessionDomainDetails(sd?: SessionDomainUtilizationDto) {
    if (!sd || sd.availableCount === 0) {
      return html`<div class="empty-note">No components offered in this domain for this session.</div>`;
    }

    return html`
      <div>
        ${
          sd.usedComponents.length > 0
            ? html`
            <div style="margin-bottom: 12px;">
              <strong style="font-size: 12px; color: #5cdb95;">Used in this session (${sd.usedCount})</strong>
              <div class="pill-list">
                ${sd.usedComponents.map((name) => html`<span class="pill used">${name}</span>`)}
              </div>
            </div>
          `
            : ''
        }
        ${
          sd.unusedComponents.length > 0
            ? html`
            <div>
              <strong style="font-size: 12px; color: #ff8888;">Unused in this session (${sd.unusedCount})</strong>
              <div class="pill-list">
                ${sd.unusedComponents.map((name) => html`<span class="pill unused">${name}</span>`)}
              </div>
            </div>
          `
            : ''
        }
      </div>
    `;
  }

  render() {
    if (!this.report) {
      return html``;
    }

    if (this.report.scopeType === 'session') {
      return this.renderSessionBinary(this.report);
    }

    return this.renderAggregateMatrix(this.report);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'component-utilization-panel': ComponentUtilizationPanel;
  }
}
