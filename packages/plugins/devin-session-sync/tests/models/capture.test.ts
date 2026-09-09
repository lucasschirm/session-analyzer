import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDevinModelCandidates, captureDevinModels } from '../../src/models/capture.js';

const MIDDLE_DOT = '\u00b7';

function modelsFixture(): string {
  const summary = `$0.7 / 1M Input ${MIDDLE_DOT} $0.13 / 1M Cached input ${MIDDLE_DOT} $2.2 / 1M Output`;
  return JSON.stringify({
    families: [
      {
        family_label: 'Claude',
        family_uid: 'claude-family',
        slug: 'claude',
        aliases: [],
        variants: [
          {
            model_uid: 'claude-sonnet-4-20250514',
            label: 'Claude Sonnet 4',
            max_context_tokens: 200000,
            max_output_tokens: 8192,
            cost_tier: 'Paid',
            cost_summary: summary,
            is_new: false,
            is_beta: false,
          },
        ],
      },
    ],
  });
}

async function tempDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'devin-models-capture-'));
}

describe('captureDevinModels', () => {
  it('calls runModelsList for a fresh cache and returns the raw output', async () => {
    const dataDir = await tempDataDir();
    try {
      let calls = 0;
      const runModelsList = async () => {
        calls += 1;
        return modelsFixture();
      };

      const result = await captureDevinModels({
        dataDir,
        devinCliVersion: 'v1',
        runModelsList,
      });

      expect(result.raw).toBe(modelsFixture());
      expect(result.devinCliVersion).toBe('v1');
      expect(result.error).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reuses the cache for the same version inside the TTL window', async () => {
    const dataDir = await tempDataDir();
    try {
      let calls = 0;
      const runModelsList = async () => {
        calls += 1;
        return modelsFixture();
      };

      await captureDevinModels({ dataDir, devinCliVersion: 'v1', runModelsList, ttlMs: 60_000 });
      const result = await captureDevinModels({
        dataDir,
        devinCliVersion: 'v1',
        runModelsList,
        ttlMs: 60_000,
      });

      expect(result.raw).toBe(modelsFixture());
      expect(calls).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('re-captures when the TTL expires', async () => {
    const dataDir = await tempDataDir();
    try {
      let calls = 0;
      const runModelsList = async () => {
        calls += 1;
        return modelsFixture();
      };
      let now = 0;
      const nowFn = () => now;

      await captureDevinModels({
        dataDir,
        devinCliVersion: 'v1',
        runModelsList,
        ttlMs: 1,
        now: nowFn,
      });
      now = 2;
      const result = await captureDevinModels({
        dataDir,
        devinCliVersion: 'v1',
        runModelsList,
        ttlMs: 1,
        now: nowFn,
      });

      expect(result.raw).toBe(modelsFixture());
      expect(calls).toBe(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('re-captures when the devin CLI version changes, even inside TTL', async () => {
    const dataDir = await tempDataDir();
    try {
      let calls = 0;
      const runModelsList = async () => {
        calls += 1;
        return modelsFixture();
      };

      const v1 = await captureDevinModels({
        dataDir,
        devinCliVersion: 'v1',
        runModelsList,
        ttlMs: 60_000,
      });
      expect(v1.devinCliVersion).toBe('v1');

      const v2 = await captureDevinModels({
        dataDir,
        devinCliVersion: 'v2',
        runModelsList,
        ttlMs: 60_000,
      });
      expect(v2.devinCliVersion).toBe('v2');
      expect(calls).toBe(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns the capturedAt timestamp from the injected clock', async () => {
    const dataDir = await tempDataDir();
    try {
      const result = await captureDevinModels({
        dataDir,
        devinCliVersion: 'v1',
        runModelsList: async () => modelsFixture(),
        now: () => 12345,
      });
      expect(result.capturedAt).toBe(12345);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('surfaces runModelsList errors in the result, not a throw', async () => {
    const dataDir = await tempDataDir();
    try {
      const result = await captureDevinModels({
        dataDir,
        devinCliVersion: 'v1',
        runModelsList: async () => {
          throw new Error('devin cli unavailable');
        },
      });
      expect(result.error).toBe('devin cli unavailable');
      expect(result.raw).toBe('');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('buildDevinModelCandidates', () => {
  it('produces runtime candidates for the raw and parsed models artifacts', async () => {
    const dataDir = await tempDataDir();
    try {
      const result = await buildDevinModelCandidates({
        dataDir,
        projectId: 'session-analyzer',
        sessionId: 'sess-123',
        devinCliVersion: 'v1',
        runModelsList: async () => modelsFixture(),
      });

      expect(result.error).toBeUndefined();
      const [raw, parsed] = result.candidates;
      expect(raw.candidate.relativePath).toBe('native/models-list.raw.json');
      expect(raw.candidate.scope).toBe('runtime');
      expect(raw.candidate.projectId).toBe('session-analyzer');
      expect(raw.candidate.sessionId).toBe('sess-123');
      expect(raw.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(raw.size).toBeGreaterThan(0);

      expect(parsed.candidate.relativePath).toBe('native/models.json');
      expect(parsed.candidate.scope).toBe('runtime');
      expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.size).toBeGreaterThan(0);

      const parsedContent = JSON.parse(parsed.candidate.content);
      expect(parsedContent).toHaveLength(1);
      expect(parsedContent[0].modelUid).toBe('claude-sonnet-4-20250514');
      expect(parsedContent[0].pricing).toEqual({
        inputPerMTok: 0.7,
        cachedInputPerMTok: 0.13,
        outputPerMTok: 2.2,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('carries the parsed pricing-unavailable reason into the models.json content', async () => {
    const dataDir = await tempDataDir();
    try {
      const summary = `$0.7 / 1M Input ${MIDDLE_DOT} $2.2 / 1M Output`;
      const fixture = JSON.stringify({
        families: [
          {
            family_uid: 'claude-family',
            variants: [
              {
                model_uid: 'claude-sonnet',
                label: 'Claude Sonnet',
                cost_tier: 'Paid',
                cost_summary: summary,
                is_new: false,
                is_beta: false,
              },
            ],
          },
        ],
      });

      const result = await buildDevinModelCandidates({
        dataDir,
        projectId: 'session-analyzer',
        sessionId: 'sess-456',
        devinCliVersion: 'v1',
        runModelsList: async () => fixture,
      });

      const parsed = result.candidates[1];
      const content = JSON.parse(parsed.candidate.content);
      expect(content[0].pricing).toBeUndefined();
      expect(content[0].pricingUnavailableReason).toBe('unparsed-format');
      expect(content[0].costSummaryRaw).toBe(summary);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
