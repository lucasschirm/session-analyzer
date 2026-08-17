/**
 * Vitest setup: happy-dom (and Node) do not implement the URLPattern API,
 * which @lit-labs/router uses for route matching. A minimal shim covering
 * the pattern features the app uses (`:param` segments, trailing `*`,
 * literal segments) is installed when the native API is missing.
 */

interface PatternGroups {
  [key: string]: string | undefined;
}

function matchPattern(pattern: string, pathname: string): PatternGroups | null {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = pathname.split('/').filter((segment) => segment.length > 0);

  const groups: PatternGroups = {};
  let patternIndex = 0;

  for (; patternIndex < patternSegments.length; patternIndex++) {
    const segment = patternSegments[patternIndex];

    if (segment === '*') {
      groups['0'] = `/${pathSegments.slice(patternIndex).join('/')}`;
      return groups;
    }

    const pathSegment = pathSegments[patternIndex];
    if (pathSegment === undefined) return null;

    if (segment.startsWith(':')) {
      groups[segment.slice(1)] = decodeURIComponent(pathSegment);
    } else if (segment !== pathSegment) {
      return null;
    }
  }

  if (patternIndex !== pathSegments.length) return null;
  return groups;
}

class URLPatternShim {
  private readonly pathname: string;

  constructor(init: { pathname: string }) {
    this.pathname = init.pathname;
  }

  test(input: { pathname: string }): boolean {
    return matchPattern(this.pathname, input.pathname) !== null;
  }

  exec(input: { pathname: string }): { pathname: { groups: PatternGroups } } | null {
    const groups = matchPattern(this.pathname, input.pathname);
    if (!groups) return null;
    return { pathname: { groups } };
  }
}

if (typeof globalThis.URLPattern === 'undefined') {
  (globalThis as Record<string, unknown>).URLPattern = URLPatternShim;
}
