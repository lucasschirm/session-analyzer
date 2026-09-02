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

/** Reads the current hash as a leading-slash pathname, defaulting to `/`.
 * Query string and hash fragments are stripped so they do not become part
 * of a route parameter (e.g. the `:sessionId` in `#/sessions/:id?view=x`). */
export function currentHashPath(): string {
  const hash = window.location.hash;
  if (!hash || hash === '#') return '/';
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryIndex = path.indexOf('?');
  const clean = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  return clean.startsWith('/') ? clean : `/${clean}`;
}

/**
 * Legacy URL redirects. The dashboard was restructured so that the Portfolio
 * view moved to `/`, "Components" was renamed to "Artifacts", and project
 * detail pages moved from `/projects/:id/behavior` to `/projects/:id`. Old
 * deep links (and any persisted bookmarks) keep working by rewriting the
 * hash before the router resolves it. The query string is preserved.
 *
 * Returns the canonical path, or `null` when no redirect applies.
 */
export function redirectLegacyPath(path: string): string | null {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  const query = queryIndex >= 0 ? path.slice(queryIndex) : '';

  // /portfolio -> /
  if (pathname === '/portfolio' || pathname === '/portfolio/') return `/${query}`;

  // /components -> /artifacts (+ /components/:id -> /artifacts/:id)
  if (pathname === '/components') return `/artifacts${query}`;
  if (pathname === '/components/') return `/artifacts/${query}`;
  if (pathname.startsWith('/components/')) {
    const rest = pathname.slice('/components/'.length);
    return `/artifacts/${rest}${query}`;
  }

  // /projects/:id/behavior -> /projects/:id
  if (pathname.startsWith('/projects/')) {
    const rest = pathname.slice('/projects/'.length);
    if (rest.endsWith('/behavior')) {
      const id = rest.slice(0, -'/behavior'.length);
      if (id.length > 0) return `/projects/${id}${query}`;
    }
    if (rest.endsWith('/behavior/')) {
      const id = rest.slice(0, -'/behavior/'.length);
      if (id.length > 0) return `/projects/${id}${query}`;
    }
  }

  return null;
}

/** Reads the current hash path, applying any legacy redirect first. */
export function resolvedHashPath(): string {
  const raw = currentHashPath();
  const redirected = redirectLegacyPath(raw);
  if (redirected !== null && redirected !== raw) {
    // Keep the address bar in sync so refresh/bookmarks land on the canonical URL.
    if (window.location.hash !== `#${redirected}`) {
      window.location.hash = redirected;
    }
    return redirected;
  }
  return raw;
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
    void this.goto(resolvedHashPath());
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
    void this.goto(resolvedHashPath());
  }

  override hostDisconnected(): void {
    super.hostDisconnected();
    window.removeEventListener('hashchange', this.handleHashChange);
    window.removeEventListener('click', this.handleAnchorClick);
  }
}
