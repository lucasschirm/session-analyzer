import { expect, type Locator } from '@playwright/test';

export interface ManualImportStateSnapshot {
  /** The internal `phase` value (idle/ready/importing/partial/unsupported/integrity-error/unavailable/conflict). */
  phase: string;
  /** Text content of the status badge. */
  badgeText: string;
  /** Non-common CSS classes on the badge (e.g. 'unsupported', 'unavailable', 'integrity-error'). */
  badgeClass: string;
  /** Full text of the `.state-message` element. */
  message: string;
  /** Text of the `.hint` paragraph, which carries the detailed failure reason. */
  hint: string;
}

/**
 * Query a `manual-import-state` custom element from inside the browser.
 *
 * Mirrors the shadow-piercing, affordance-first pattern used by the chart
 * geometry helpers (`helpers/chart-content.ts`): it reads the rendered badge
 * class/text and the message/hint copy, not brittle full-page text. The phase
 * property is also returned because it is the semantic failure-class token that
 * drives the rendered badge.
 */
export async function queryManualImportState(locator: Locator): Promise<ManualImportStateSnapshot> {
  return locator.first().evaluate<ManualImportStateSnapshot, undefined>((el) => {
    const host = el as unknown as HTMLElement & { phase?: string };
    const root = host.shadowRoot;
    if (!root) {
      return { phase: host.phase ?? '', badgeText: '', badgeClass: '', message: '', hint: '' };
    }

    const badge = root.querySelector('.badge');
    const messageEl = root.querySelector('.state-message');
    const hint = messageEl?.querySelector('.hint');
    const badgeClass =
      Array.from(badge?.classList ?? [])
        .filter((c) => c !== 'badge')
        .join(' ') ?? '';

    return {
      phase: host.phase ?? '',
      badgeText: (badge?.textContent ?? '').trim(),
      badgeClass,
      message: (messageEl?.textContent ?? '').trim(),
      hint: (hint?.textContent ?? '').trim(),
    };
  });
}

export interface ManualImportStateExpectation {
  phase: string;
  badgeText: string;
  hintIncludes?: string;
  hintExcludes?: string | string[];
  messageExcludes?: string | string[];
}

/**
 * Assert that `manual-import-state` is in an expected failure class.
 *
 * Checks the semantic `phase`, the rendered badge text/class, and the
 * presence/absence of specific copy in the `.hint` (and optionally the whole
 * `.state-message`). This keeps assertions on failure *classes*, not on exact
 * full-page strings, matching the error-affordance pattern from
 * `helpers/chart-content.ts`.
 */
export async function expectManualImportState(
  locator: Locator,
  expected: ManualImportStateExpectation,
): Promise<ManualImportStateSnapshot> {
  const state = await queryManualImportState(locator);

  expect(state.phase, `Expected manual-import-state phase to be "${expected.phase}"`).toBe(
    expected.phase,
  );
  expect(state.badgeText, `Expected badge text to be "${expected.badgeText}"`).toBe(
    expected.badgeText,
  );

  if (expected.hintIncludes) {
    expect(state.hint, `Expected hint to include "${expected.hintIncludes}"`).toContain(
      expected.hintIncludes,
    );
  }

  const hintExcludes = Array.isArray(expected.hintExcludes)
    ? expected.hintExcludes
    : expected.hintExcludes
      ? [expected.hintExcludes]
      : [];
  for (const text of hintExcludes) {
    expect(state.hint, `Expected hint not to include "${text}"`).not.toContain(text);
  }

  const messageExcludes = Array.isArray(expected.messageExcludes)
    ? expected.messageExcludes
    : expected.messageExcludes
      ? [expected.messageExcludes]
      : [];
  for (const text of messageExcludes) {
    expect(state.message, `Expected state message not to include "${text}"`).not.toContain(text);
  }

  return state;
}
