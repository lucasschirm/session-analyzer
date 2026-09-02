import type { SessionTree } from '@lucasschirm/sal-db';
import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { navigateTo } from '../../router';
import { sessionTreeToRows } from './session-evidence-chart-helpers';

/**
 * Renders a root/child session tree with generation-aware navigation links.
 */
@customElement('session-evidence-tree')
export class SessionEvidenceTree extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .tree-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .tree-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid var(--rd-border-2, #232936);
      border-radius: 8px;
      background: var(--rd-surface-card, #171b24);
      font-size: 13px;
    }

    .tree-row.root {
      background: var(--rd-surface-inset, #12151c);
    }

    .tree-indent {
      width: 18px;
      height: 1px;
      flex-shrink: 0;
    }

    .tree-badge {
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--rd-border-2, #232936);
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
    }

    .tree-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-word;
    }

    a {
      color: var(--rd-accent, #4f8cff);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .tree-empty {
      color: var(--rd-ink-muted, #9aa4b2);
      font-size: 13px;
    }
  `;

  @property({ type: Object }) tree: SessionTree | null = null;

  private navigate(sessionId: string, generationToken: string): void {
    navigateTo(`/sessions/${sessionId}?generation=${encodeURIComponent(generationToken)}`);
  }

  render() {
    const rows = sessionTreeToRows(this.tree);
    if (rows.length === 0) {
      return html`<p class="tree-empty">No session tree data available.</p>`;
    }

    return html`
      <ul class="tree-list" role="tree" aria-label="Session tree">
        ${rows.map(
          (row) => html`
            <li
              class="tree-row ${row.isRoot ? 'root' : ''}"
              role="treeitem"
              style="margin-left: ${row.depth * 24}px"
            >
              <span class="tree-badge">${row.isRoot ? 'Root' : 'Child'}</span>
              <span class="tree-id">${row.sessionId}</span>
              <a
                href=${row.href}
                @click=${(e: Event) => {
                  e.preventDefault();
                  const url = new URL(row.href, window.location.href);
                  const generation = url.searchParams.get('generation') ?? 'unknown';
                  this.navigate(row.sessionId, generation);
                }}
              >
                View
              </a>
            </li>
          `,
        )}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-evidence-tree': SessionEvidenceTree;
  }
}
