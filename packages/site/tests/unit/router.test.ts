import { afterEach, describe, expect, it } from 'vitest';
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { HashRouter, currentHashPath, navigateTo } from '../../src/router';

@customElement('router-test-host')
class RouterTestHost extends LitElement {
  router = new HashRouter(
    this,
    [
      { path: '/', render: () => html`<div id="route-home">home</div>` },
      {
        path: '/projects/:projectId',
        render: (params) => html`<div id="route-project">${params.projectId}</div>`,
      },
      {
        path: '/sessions/:sessionId/indicator/:indicator',
        render: (params) =>
          html`<div id="route-indicator">${params.sessionId}:${params.indicator}</div>`,
      },
    ],
    { render: () => html`<div id="route-fallback">not found</div>` }
  );

  render() {
    return html`<main>${this.router.outlet()}</main>`;
  }
}

async function mountHost(): Promise<RouterTestHost> {
  const host = document.createElement('router-test-host') as RouterTestHost;
  document.body.appendChild(host);
  await host.updateComplete;
  // goto() is async; let the initial navigation settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.updateComplete;
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
});

describe('currentHashPath', () => {
  it('defaults to / when no hash is present', () => {
    window.location.hash = '';
    expect(currentHashPath()).toBe('/');
  });

  it('normalizes hash values to pathnames', () => {
    window.location.hash = '#/projects/p1';
    expect(currentHashPath()).toBe('/projects/p1');

    window.location.hash = '#';
    expect(currentHashPath()).toBe('/');
  });
});

describe('navigateTo', () => {
  it('writes a leading-slash hash', () => {
    navigateTo('/projects/p9');
    expect(window.location.hash).toBe('#/projects/p9');
  });
});

describe('HashRouter', () => {
  it('renders the home route by default', async () => {
    const host = await mountHost();
    expect(host.shadowRoot?.textContent).toContain('home');
  });

  it('matches parameterized routes and updates on hashchange', async () => {
    const host = await mountHost();

    window.location.hash = '#/projects/abc';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.updateComplete;

    expect(host.shadowRoot?.textContent).toContain('abc');
  });

  it('matches nested parameter routes', async () => {
    window.location.hash = '#/sessions/s1/indicator/files_written';
    const host = await mountHost();

    expect(host.shadowRoot?.textContent).toContain('s1:files_written');
  });

  it('falls back for unknown routes', async () => {
    window.location.hash = '#/definitely/missing';
    const host = await mountHost();

    expect(host.shadowRoot?.textContent).toContain('not found');
  });

  it('intercepts clicks on #/ links', async () => {
    const host = await mountHost();
    const anchor = document.createElement('a');
    anchor.href = '#/projects/xyz';
    document.body.appendChild(anchor);

    anchor.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.updateComplete;

    expect(window.location.hash).toBe('#/projects/xyz');
    expect(host.shadowRoot?.textContent).toContain('xyz');
  });
});
