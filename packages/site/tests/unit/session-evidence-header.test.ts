import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/pages/session-evidence/session-evidence-header';
import type { SessionEvidenceHeader } from '../../src/pages/session-evidence/session-evidence-header';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('session-evidence-header', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the first-user-message excerpt as the title, falling back to the session id', async () => {
    const el = document.createElement('session-evidence-header') as SessionEvidenceHeader;
    el.sessionId = 's1';
    await mount(el);
    expect(shadow(el).querySelector('h1')?.textContent).toBe('Session s1');

    el.titleExcerpt = 'Fix the flaky test';
    await el.updateComplete;
    expect(shadow(el).querySelector('h1')?.textContent).toBe('Fix the flaky test');
  });

  it('renders an outcome badge distinct for clean / interrupted / error / not-classifiable', async () => {
    const el = document.createElement('session-evidence-header') as SessionEvidenceHeader;
    el.sessionId = 's1';
    el.summary = {
      token: {
        analysisReleaseId: 'r',
        generationId: 'g',
        comparabilityGroupId: 'c',
        eligibleN: 1,
        knownN: 1,
        unknownCount: 0,
        coverage: 'complete',
        measurementClass: 'derived',
        confidence: 'high',
        metricVersion: '0.1.0',
        evidenceLinks: [],
      },
      sessionId: 's1',
      rootSessionId: 's1',
      harness: 'claude-code',
      mode: 'plan',
      outcome: 'ended_on_error',
      headlineMetrics: [],
    };
    await mount(el);
    const root = shadow(el);
    expect(root.textContent).toContain('Ended on error');
    expect(root.querySelector('.outcome-badge.critical')).not.toBeNull();
    expect(root.textContent).toContain('claude-code');
    expect(root.textContent).toContain('Mode: plan');
  });

  it('renders a sub agent link when subAgentCount is > 0', async () => {
    const el = document.createElement('session-evidence-header') as SessionEvidenceHeader;
    el.sessionId = 's1';
    el.subAgentCount = 3;
    el.subAgentHref = '#/sessions/s1?view=transcript';
    await mount(el);
    const root = shadow(el);
    const link = root.querySelector('.fact-link[href="#/sessions/s1?view=transcript"]');
    expect(link?.textContent).toBe('3');
  });
});
