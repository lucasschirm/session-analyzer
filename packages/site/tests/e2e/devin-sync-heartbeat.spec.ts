import { expect, test } from '@playwright/test';
import { devinTranscriptContent } from './helpers/devin-fixtures.js';
import { assertHeartbeat, syncProgressFilesParser } from './helpers/heartbeat.js';
import {
  attachLoggers,
  progressBar,
  startSyncFromHome,
  transcriptFileKey,
  waitForSyncIdle,
} from './helpers/sync-flow.js';
import { FixtureBucket } from './sync-fixtures.js';

test('SYNC-009: devin sync progress heartbeat advances while a file download is throttled', async ({
  page,
}) => {
  const bucket = new FixtureBucket();
  bucket.addProject('devin-hb-proj', 'Devin Heartbeat Project', '');
  const session = bucket.addSession('devin-hb-proj', 'e2e-devin-hb', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: Buffer.from(devinTranscriptContent()),
      },
    ],
  });

  // Force the manifest to identify as the devin harness so the sync worker
  // treats this as a Devin session to ingest.
  session.manifest.harness = 'devin';
  session.manifest.harnessVersion = '0.1.0';

  // Throttle the transcript download so the progress bar stays at "Files 0/1"
  // long enough to sample at least two distinct values.
  bucket.setDelay(transcriptFileKey('devin-hb-proj', 'e2e-devin-hb'), 5000);
  attachLoggers(page);

  await startSyncFromHome(page, bucket);

  const progress = progressBar(page);
  const result = await assertHeartbeat(progress, {
    parser: syncProgressFilesParser,
    timeoutMs: 10000,
    message: 'SYNC-009 devin sync progress',
  });

  expect(result.distinct.length).toBeGreaterThanOrEqual(2);
  expect(result.series).toEqual([...result.series].sort((a, b) => a - b));

  await waitForSyncIdle(page, 60000);

  // The devin session should appear in the project after sync.
  await page.goto('/#/projects');
  await expect(page.locator('.project-card', { hasText: /1 session/ })).toBeVisible({
    timeout: 10000,
  });
});
