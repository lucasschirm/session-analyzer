/**
 * Hash-based router built on `Routes` from @lit-labs/router.
 *
 * GitHub Pages cannot rewrite arbitrary URL paths on refresh, so this app uses
 * `#/path` style URLs. This subclass maps `window.location.hash` onto the
 * pathname-based matching provided by @lit-labs/router and intercepts clicks
 * on same-page `#/...` links.
 */

import type { BaseRouteConfig, RouteConfig } from '@lit-labs/router';
import { Routes } from '@lit-labs/router';
import type { ReactiveControllerHost } from 'lit';

/** Reads the current hash as a leading-slash pathname, defaulting to `/`. */
export function currentHashPath(): string {
  const hash = window.location.hash;
  if (!hash || hash === '#') return '/';
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  return path.startsWith('/') ? path : `/${path}`;
}

/** Programmatic navigation helper: `navigateTo('/projects/1')`. */
export function navigateTo(path: string): void {
  const target = path.startsWith('/') ? path : `/${path}`;
  if (window.location.hash !== `#${target}`) {
    window.location.hash = target;
  }
}

export class HashRouter extends Routes {
  constructor(
    host: ReactiveControllerHost & HTMLElement,
    routes: RouteConfig[],
    fallback?: BaseRouteConfig,
  ) {
    super(host, routes, fallback ? { fallback } : undefined);
  }

  private readonly handleHashChange = (): void => {
    void this.goto(currentHashPath());
  };

  private readonly handleAnchorClick = (event: MouseEvent): void => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.defaultPrevented
    ) {
      return;
    }

    const anchor = event
      .composedPath()
      .find((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
    if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
    if (anchor.getAttribute('rel') === 'external') return;

    const href = anchor.getAttribute('href');
    if (!href?.startsWith('#/')) return;

    event.preventDefault();
    navigateTo(href.slice(1));
  };

  override hostConnected(): void {
    super.hostConnected();
    window.addEventListener('hashchange', this.handleHashChange);
    window.addEventListener('click', this.handleAnchorClick);
    void this.goto(currentHashPath());
  }

  override hostDisconnected(): void {
    super.hostDisconnected();
    window.removeEventListener('hashchange', this.handleHashChange);
    window.removeEventListener('click', this.handleAnchorClick);
  }
}
