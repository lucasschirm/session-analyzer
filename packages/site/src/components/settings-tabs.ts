import { css, html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { currentHashPath } from '../router';

interface SettingsTab {
  id: string;
  label: string;
  href: string;
  isActive: (path: string) => boolean;
}

const TABS: SettingsTab[] = [
  {
    id: 'data-sources',
    label: 'Data Sources',
    href: '#/settings/data-sources',
    // Bare /settings is an alias for the Data Sources page.
    isActive: (path) => path === '/settings' || path.startsWith('/settings/data-sources'),
  },
  {
    id: 'storage',
    label: 'Storage',
    href: '#/settings/storage',
    isActive: (path) => path.startsWith('/settings/storage'),
  },
];

/**
 * Horizontal tab bar for the `/settings/*` pages, re-homing the sub-nav that
 * used to live in `left-nav`'s `renderSettingsNav()`. Self-manages active
 * state off `window.location.hash` so each settings page only has to render
 * `<settings-tabs></settings-tabs>` above its content.
 */
@customElement('settings-tabs')
export class SettingsTabs extends LitElement {
  static styles = css`
    :host {
      display: block;
      margin-bottom: 20px;
    }

    nav {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--rd-border-1, #20242e);
    }

    a {
      display: inline-block;
      padding: 10px 4px;
      margin-right: 20px;
      color: var(--rd-ink-muted, #9aa4b2);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      border-bottom: 2px solid transparent;
      transform: translateY(1px);
    }

    a:hover {
      color: var(--rd-ink-primary, #e6e9ef);
    }

    a.active {
      color: var(--rd-ink-primary, #e6e9ef);
      border-bottom-color: var(--rd-accent, #4f8cff);
    }

    a:focus-visible {
      outline: 2px solid var(--rd-accent, #4f8cff);
      outline-offset: 2px;
    }
  `;

  @state() private path = currentHashPath();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.handleHashChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.handleHashChange);
  }

  private handleHashChange = (): void => {
    this.path = currentHashPath();
  };

  render() {
    return html`
      <nav>
        ${repeat(
          TABS,
          (tab) => tab.id,
          (tab) => this.renderTab(tab),
        )}
      </nav>
    `;
  }

  private renderTab(tab: SettingsTab) {
    const active = tab.isActive(this.path);
    return html`
      <a
        href=${tab.href}
        class=${active ? 'active' : ''}
        aria-current=${active ? 'page' : nothing}
      >
        ${tab.label}
      </a>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-tabs': SettingsTabs;
  }
}
