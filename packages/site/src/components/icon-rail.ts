import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

/** A single rail destination. */
interface RailItem {
  id: string;
  label: string;
  href: string;
  /** Whether `path` (the current hash path) should highlight this item. */
  isActive: (path: string) => boolean;
  icon: TemplateResult;
  /** Bottom-anchored items (e.g. Settings) render after a flex spacer. */
  anchor: 'top' | 'bottom';
}

const iconTrend = html`<path d="M3 15l4-5 3 3 6-8" />`;

const iconFolder = html`<path
  d="M3 6a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z"
/>`;

const iconGrid = html`<rect x="3" y="3" width="6" height="6" rx="1" />
  <rect x="11" y="3" width="6" height="6" rx="1" />
  <rect x="3" y="11" width="6" height="6" rx="1" />
  <rect x="11" y="11" width="6" height="6" rx="1" />`;

const iconGear = html`<circle cx="10" cy="10" r="2.5" />
  <path
    d="M10 3v2M10 15v2M3 10h2M15 10h2M5.5 5.5l1.4 1.4M13.1 13.1l1.4 1.4M14.5 5.5l-1.4 1.4M6.9 13.1l-1.4 1.4"
  />`;

/**
 * Rail destinations, in the order the issue's disposition table lists them.
 * Active-route mapping is intentionally strict: routes with no rail item
 * (the `/agents` family, `/sessions/:id`, `/manual-import`, `/artifact-diff`)
 * must map to no active item rather than the nearest parent.
 */
const RAIL_ITEMS: RailItem[] = [
  {
    id: 'portfolio',
    label: 'Portfolio',
    href: '#/',
    isActive: (path) => path === '/',
    icon: iconTrend,
    anchor: 'top',
  },
  {
    id: 'projects',
    label: 'Projects',
    href: '#/projects',
    isActive: (path) => path === '/projects' || path.startsWith('/projects/'),
    icon: iconFolder,
    anchor: 'top',
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    href: '#/artifacts',
    isActive: (path) => path === '/artifacts' || path.startsWith('/artifacts/'),
    icon: iconGrid,
    anchor: 'top',
  },
  {
    id: 'settings',
    label: 'Settings',
    href: '#/settings/data-sources',
    isActive: (path) => path === '/settings' || path.startsWith('/settings/'),
    icon: iconGear,
    anchor: 'bottom',
  },
];

/**
 * Global 64px icon rail: logo mark + four route-aware destination buttons
 * (Portfolio, Projects, Artifacts, Settings). Replaces `left-nav`. Renders
 * unconditionally as global chrome — on routes with no matching destination
 * (the `/agents` family, session evidence, manual import, artifact diff) no
 * item is marked active, per the issue's disposition table.
 */
@customElement('icon-rail')
export class IconRail extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 64px;
      flex-shrink: 0;
      background: var(--rd-surface-rail, #10131a);
      border-right: 1px solid var(--rd-border-1, #20242e);
    }

    .icon-rail {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      padding: 12px 0;
      gap: 8px;
    }

    .logo-mark {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      background: var(--rd-accent, #4f8cff);
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-decoration: none;
      margin-bottom: 8px;
    }

    nav {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      width: 100%;
    }

    .spacer {
      flex: 1;
    }

    .rail-item {
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      color: var(--rd-ink-muted, #9aa4b2);
      text-decoration: none;
      box-sizing: border-box;
      border: 1.6px solid transparent;
    }

    .rail-item:hover {
      background: var(--rd-surface-card, #171b24);
      color: var(--rd-ink-primary, #e6e9ef);
    }

    .rail-item.active {
      background: var(--rd-accent-container, #1c2b4a);
      border-color: var(--rd-accent, #4f8cff);
      color: var(--rd-accent-on-container, #cfe0ff);
    }

    .rail-item:focus-visible {
      outline: 2px solid var(--rd-accent, #4f8cff);
      outline-offset: 2px;
    }

    .rail-item svg {
      width: 20px;
      height: 20px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
  `;

  /** Current hash path (e.g. `/`, `/projects`, `/settings/storage`). */
  @property({ type: String }) path = '/';

  private renderItem(item: RailItem): TemplateResult {
    const active = item.isActive(this.path);
    return html`
      <a
        href=${item.href}
        class="rail-item ${active ? 'active' : ''}"
        title=${item.label}
        aria-label=${item.label}
        aria-current=${active ? 'page' : nothing}
      >
        <svg viewBox="0 0 20 20">${item.icon}</svg>
      </a>
    `;
  }

  render() {
    const topItems = RAIL_ITEMS.filter((item) => item.anchor === 'top');
    const bottomItems = RAIL_ITEMS.filter((item) => item.anchor === 'bottom');
    return html`
      <div class="icon-rail">
        <a href="#/" class="logo-mark" aria-label="Session Analyzer home">SA</a>
        <nav>
          ${repeat(
            topItems,
            (item) => item.id,
            (item) => this.renderItem(item),
          )}
        </nav>
        <div class="spacer"></div>
        <nav>
          ${repeat(
            bottomItems,
            (item) => item.id,
            (item) => this.renderItem(item),
          )}
        </nav>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'icon-rail': IconRail;
  }
}
