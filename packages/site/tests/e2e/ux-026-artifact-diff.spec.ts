import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  openExportDatabase,
  selectArtifactBlobContent,
  selectManifestArtifactsByRelativePath,
} from './helpers/export-verify.js';
import {
  FixtureBucket,
  fixtureBuffer,
  S3_BUCKET,
  S3_ENDPOINT,
  sha256Hex,
} from './sync-fixtures.js';

/**
 * UX-026: Artifact Diff (`#/artifact-diff`) renders real diff content across
 * a version change, resolved through the OPFS-backed blob store
 * (`createOpfsArtifactBlobStore`, issue #399), with structurally distinct
 * empty and error affordances.
 *
 * Per the issue's Test plan: no existing in-app UI links to `#/artifact-diff`
 * with real params (`app-root.ts` only registers the bare route and does a
 * nav-highlight check; `component-ecosystem-view.ts` links diffs via its own
 * `componentHref`, not `buildArtifactDiffHash`). Real `manifest_artifacts.id`
 * values are obtained here by syncing two versions of the same workspace
 * config artifact through a real CAS sync (the only in-browser path that
 * populates `manifest.artifacts` -- manual import's `buildManualManifest`
 * always sets `artifacts: []`, so it cannot produce `artifact_references`
 * rows), downloading the real analytics database export, and reading the
 * real ids back out of it -- never a guessed or hardcoded id.
 *
 * The Component Ecosystem inline lifecycle-diff panel
 * (`component-ecosystem-view.ts:523-539`'s `loadDiff()`) is spot-checked
 * here too (not a new suite): it hits the identical
 * `ArtifactVersionView.getDiff` -> `ArtifactDiffRepository.
 * getCanonicalizedArtifact()` path as `#/artifact-diff`, reached via
 * `#/artifacts/<id>?leftVersion=...&rightVersion=...` with the same two real
 * ids -- `loadDiff()` only requires `filters.leftVersion`/`rightVersion` to
 * be set, independent of whether `componentId` resolves to a real component.
 * That same navigation also carries real-browser regression coverage for a
 * routing bug this cutover found and fixed along the way: `componentId`
 * (`@property`) was missing its `attribute: 'component-id'` override, so
 * every `#/artifacts/:componentId` deep link (reachable from Portfolio,
 * Project Behavior, and this same Component Ecosystem panel) silently fell
 * back to the generic "Artifact Ecosystem" heading instead of the
 * component-specific one -- only unit-tested at the jsdom level until now.
 */

const PASSKEY = 'e2e-passkey-artifact-diff';
const SETTINGS_PATH = '.claude/settings.json';
const LEFT_MODEL = 'claude-3-5-sonnet-before';
const RIGHT_MODEL = 'claude-3-5-sonnet-after';
const LEFT_CONTENT = Buffer.from(JSON.stringify({ model: LEFT_MODEL }, null, 2));
const RIGHT_CONTENT = Buffer.from(JSON.stringify({ model: RIGHT_MODEL }, null, 2));

// ---------------------------------------------------------------------------
// Sync-flow helpers. Mirrors sync.spec.ts's own local, unexported helpers --
// each browser E2E spec in this repo is self-contained by convention (see
// this skill's Step 5: fixtures/flows are deliberately duplicated per spec
// file rather than sharing private test-only helpers across files).
// ---------------------------------------------------------------------------

function progressBar(page: Page): Locator {
  return page.locator('app-root').locator('sync-progress-bar').getByRole('status');
}

async function openConnectModal(page: Page): Promise<void> {
  await page.goto('/#/settings/data-sources');
  await expect(
    page.locator('connect-modal').getByRole('heading', { name: 'Connections' }),
  ).toBeVisible({ timeout: 10000 });
}

async function fillConnectionForm(page: Page): Promise<void> {
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: '+ New connection' }).click();
  await panel.getByLabel('Connection name').fill('E2E Artifact Diff');
  await panel.getByLabel('Region').fill('us-east-1');
  await panel.getByLabel('Bucket').fill(S3_BUCKET);
  await panel.getByLabel('Endpoint (optional)').fill(S3_ENDPOINT);
  await panel.getByLabel('Access key ID').fill('AKIA');
  await panel.getByLabel('Secret access key').fill('secret');
  await panel.getByLabel('Save to local storage').check();
}

async function confirmPasskey(page: Page): Promise<void> {
  const modal = page.getByRole('dialog', { name: 'Passkey' });
  await expect(modal).toBeVisible({ timeout: 10000 });
  const inputs = modal.getByLabel('Passkey');
  await inputs.first().fill(PASSKEY);
  const confirm = modal.getByLabel('Confirm passkey');
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.fill(PASSKEY);
  }
  await modal.getByRole('button', { name: /Create Passkey|Unlock/ }).click();
  await expect(modal).toBeHidden({ timeout: 10000 });
}

async function startSyncFromHome(page: Page, bucket: FixtureBucket): Promise<void> {
  await bucket.installRoute(page);
  await openConnectModal(page);
  await fillConnectionForm(page);
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: 'Sync' }).click();
  await confirmPasskey(page);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });
}

async function waitForSyncIdle(page: Page, timeout = 30000): Promise<void> {
  await expect(progressBar(page)).toBeHidden({ timeout });
}

// ---------------------------------------------------------------------------
// Storage-page download helper (mirrors storage-optimize.spec.ts's `dbRow`/
// `actionButton` pattern) -- used to obtain the real, `VACUUM INTO`-exported
// analytics database so this test can read real ids out of it, rather than
// guessing them.
// ---------------------------------------------------------------------------

function dbRow(page: Page, name: 'Control DB' | 'Analytics DB'): Locator {
  return page.locator('.db-table tbody tr', { hasText: name });
}

async function downloadAnalyticsExport(page: Page): Promise<string> {
  await page.goto('/#/settings/storage');
  await expect(page.getByText('Control Database')).toBeVisible({ timeout: 15000 });

  const analyticsRow = dbRow(page, 'Analytics DB');
  await expect(analyticsRow.locator('.size-error')).toHaveCount(0);
  await analyticsRow.getByRole('button', { name: 'Download' }).click();

  const download = await page.waitForEvent('download', { timeout: 15000 });
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('Analytics DB download did not produce a local file path');
  }
  return downloadPath;
}

interface ArtifactIdPair {
  leftArtifact: string;
  rightArtifact: string;
}

/**
 * Reads the two real `manifest_artifacts.id` values recorded for
 * `SETTINGS_PATH` out of a downloaded analytics database export, matched by
 * content sha256 -- not insertion order. Two sessions synced in the same
 * batch can land in either order (`created_at` is not a reliable
 * left/right discriminator when both rows can share a millisecond), so
 * "left" and "right" here are defined by which seeded content produced them,
 * confirmed independently of the sync engine's actual processing order.
 * Also confirms decision #6's accepted behavior change directly against the
 * export: the newly-ingested bytes for both versions no longer land in SQL
 * `content` now that the OPFS-backed store is wired -- only the
 * `artifact_blobs` metadata row does.
 */
async function findSettingsArtifactIds(downloadPath: string): Promise<ArtifactIdPair> {
  const db = await openExportDatabase(downloadPath);
  try {
    const rows = selectManifestArtifactsByRelativePath(db, SETTINGS_PATH);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.sha256).not.toBe(rows[1]?.sha256);

    for (const row of rows) {
      const content = selectArtifactBlobContent(db, row.sha256);
      expect(content).not.toBeUndefined();
      expect(content).toBeNull();
    }

    const leftSha = sha256Hex(LEFT_CONTENT);
    const rightSha = sha256Hex(RIGHT_CONTENT);
    const leftRow = rows.find((row) => row.sha256 === leftSha);
    const rightRow = rows.find((row) => row.sha256 === rightSha);
    expect(
      leftRow,
      `no manifest_artifacts row matched the seeded "before" content's sha256`,
    ).toBeDefined();
    expect(
      rightRow,
      `no manifest_artifacts row matched the seeded "after" content's sha256`,
    ).toBeDefined();

    return {
      leftArtifact: String(leftRow?.id),
      rightArtifact: String(rightRow?.id),
    };
  } finally {
    db.close();
  }
}

function artifactDiffHash(ids: ArtifactIdPair): string {
  const params = new URLSearchParams({
    leftArtifact: ids.leftArtifact,
    rightArtifact: ids.rightArtifact,
  });
  return `/#/artifact-diff?${params.toString()}`;
}

async function syncTwoSettingsVersions(page: Page): Promise<ArtifactIdPair> {
  const bucket = new FixtureBucket();
  bucket.addProject('artifact-diff-proj', 'Artifact Diff Project', 'e2e fixture');
  bucket.addSession('artifact-diff-proj', 'session-before', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
      { scope: 'workspace', relativePath: SETTINGS_PATH, content: LEFT_CONTENT },
    ],
  });
  bucket.addSession('artifact-diff-proj', 'session-after', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
      { scope: 'workspace', relativePath: SETTINGS_PATH, content: RIGHT_CONTENT },
    ],
  });

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  const downloadPath = await downloadAnalyticsExport(page);
  return findSettingsArtifactIds(downloadPath);
}

// ---------------------------------------------------------------------------
// Forced worker-query-failure helper for the error affordance, same
// technique as ux-002-empty-error.spec.ts's FAKE_ANALYTICS_WORKER: every
// `type: 'query'` RPC (the generic dispatch every `AnalyticsDataSource`
// method -- including `artifact.getMetadata`/`artifact.getDiff` -- routes
// through, per analytics-client.ts's `query()`) fails.
// ---------------------------------------------------------------------------

const FAKE_FAILING_ANALYTICS_WORKER = `
  self.onmessage = (event) => {
    const request = event.data;
    const id = request.id ?? 0;

    switch (request.type) {
      case 'init':
      case 'getBackend':
        self.postMessage({
          id,
          ok: true,
          backend: {
            backendName: 'wasm-memory',
            durability: 'ephemeral',
            journalMode: 'delete',
            storage: 'memory',
            fallbackReason: undefined,
          },
          storage: 'memory',
          fallbackReason: undefined,
        });
        break;

      case 'query':
        self.postMessage({
          id,
          ok: false,
          error: 'Simulated worker query failure',
        });
        break;

      default:
        self.postMessage({ id, ok: true });
    }
  };
`;

async function installFakeFailingAnalyticsWorker(page: Page): Promise<void> {
  await page.addInitScript((workerScript: string) => {
    const OriginalWorker = window.Worker;

    class PatchedWorker extends OriginalWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        const href =
          typeof scriptURL === 'string'
            ? new URL(scriptURL, window.location.href).href
            : scriptURL.href;

        if (href.includes('analytics-worker')) {
          const blob = new Blob([workerScript], { type: 'application/javascript' });
          super(URL.createObjectURL(blob), { type: 'module' });
        } else {
          super(scriptURL, options);
        }
      }
    }

    window.Worker = PatchedWorker as unknown as typeof Worker;
  }, FAKE_FAILING_ANALYTICS_WORKER);
}

test.describe('UX-026: Artifact Diff real data (OPFS-backed blob store)', () => {
  test('diff content correctness across a version change, resolved through the real OPFS-backed store, with the same content confirmed from Component Ecosystem', async ({
    page,
  }) => {
    const ids = await syncTwoSettingsVersions(page);

    await page.goto(artifactDiffHash(ids));

    // Never-display-raw-ids.md: the primary label is the resolved artifact
    // path, never the raw manifest_artifacts.id / sha256.
    await expect(page.locator('h1')).toHaveText(SETTINGS_PATH);

    // No silent empty states: the real-data case must render neither the
    // error nor the empty/tombstone notices.
    await expect(page.locator('.error[role="alert"]')).toHaveCount(0);
    await expect(page.getByText('Provide two artifact versions to compare.')).toHaveCount(0);
    await expect(page.locator('.tombstone')).toHaveCount(0);

    // Diff content correctness: the actual content change between the two
    // seeded versions is rendered, resolved through the OPFS-backed store's
    // read() fallback (SQL content is NULL per findSettingsArtifactIds's own
    // assertion above).
    const diffPanel = page.locator('.diff-panel').first();
    await expect(diffPanel).toBeVisible({ timeout: 15000 });
    // Scoped with hasText (not a bare `.diff-removed`/`.diff-added` locator):
    // the unified diff's own `--- left`/`+++ right` header lines also start
    // with `-`/`+` and pick up these same classes, so an unscoped locator
    // resolves to more than one element (strict-mode violation).
    await expect(diffPanel.locator('.diff-removed', { hasText: LEFT_MODEL })).toBeVisible();
    await expect(diffPanel.locator('.diff-added', { hasText: RIGHT_MODEL })).toBeVisible();

    // Metadata-changes table reflects the real change too, not just the
    // unified diff.
    const behaviorRow = page.locator('tr.metadata-change', { hasText: 'behavior.model' });
    await expect(behaviorRow).toBeVisible();
    await expect(behaviorRow.locator('.old')).toContainText(LEFT_MODEL);
    await expect(behaviorRow.locator('.new')).toContainText(RIGHT_MODEL);

    // Spot check (not a new suite): Component Ecosystem's own inline
    // lifecycle-diff panel hits the identical getDiff ->
    // getCanonicalizedArtifact() path, reached via a different route/param
    // shape (`leftVersion`/`rightVersion` on `#/artifacts/:id`). A
    // placeholder componentId is fine -- `loadDiff()` only checks
    // `filters.leftVersion`/`rightVersion`.
    const ecosystemParams = new URLSearchParams({
      leftVersion: ids.leftArtifact,
      rightVersion: ids.rightArtifact,
    });
    await page.goto(`/#/artifacts/ux-026-spot-check?${ecosystemParams.toString()}`);

    // Real-browser regression coverage for the routing bug this same
    // cutover surfaced and fixed: `componentId` (`@property({ attribute:
    // 'component-id' })`) was missing that `attribute:` override, so every
    // `#/artifacts/:componentId` deep link silently fell back to the
    // generic "Artifact Ecosystem" summary heading instead of a
    // component-specific one -- unit-tested at the jsdom level, but never
    // through a real attribute-upgrade path until now. Asserts the heading
    // differs from the generic fallback, proving the attribute correctly
    // bound. `ux-026-spot-check` is a placeholder id with no real
    // `component_identities` row (`loadDiff()` only needs
    // `filters.leftVersion`/`rightVersion`), so `getIdentity()` resolves to
    // `undefined` here and the heading falls back to the generic "Artifact"
    // label -- this also doubles as real-browser coverage of that fallback
    // path never leaking the raw id (`never-display-raw-ids.md`), which the
    // resolved-label case (`ux-026-spot-check`'s real counterpart) doesn't
    // exercise.
    await expect(page.locator('h1')).not.toHaveText('Artifact Ecosystem');
    await expect(page.locator('h1')).not.toContainText('ux-026-spot-check');

    const ecosystemDiffPanel = page.locator('.diff-panel').first();
    await expect(ecosystemDiffPanel).toBeVisible({ timeout: 15000 });
    await expect(
      ecosystemDiffPanel.locator('.diff-removed', { hasText: LEFT_MODEL }),
    ).toBeVisible();
    await expect(ecosystemDiffPanel.locator('.diff-added', { hasText: RIGHT_MODEL })).toBeVisible();
    await expect(page.locator('.error[role="alert"]')).toHaveCount(0);
  });

  test('empty affordance renders with no artifact ids, structurally distinct from error', async ({
    page,
  }) => {
    await page.goto('/#/artifact-diff');

    await expect(page.getByText('Provide two artifact versions to compare.')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('.error[role="alert"]')).toHaveCount(0);
    await expect(page.locator('.tombstone')).toHaveCount(0);
  });

  test('error affordance renders on a forced worker query failure, structurally distinct from empty', async ({
    page,
  }) => {
    await installFakeFailingAnalyticsWorker(page);

    await page.goto('/#/artifact-diff?leftArtifact=any-left&rightArtifact=any-right');

    const errorNotice = page.locator('.error[role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 15000 });
    await expect(errorNotice).toContainText('Simulated worker query failure');
    await expect(page.getByText('Provide two artifact versions to compare.')).toHaveCount(0);
    await expect(page.locator('.tombstone')).toHaveCount(0);
  });
});
