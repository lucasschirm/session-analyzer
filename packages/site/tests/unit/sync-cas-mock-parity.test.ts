import { createHash } from 'node:crypto';
import {
  buildObjectKey,
  type GetObjectInput,
  type GetObjectResult,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  type SyncManifest,
} from '@lucasschirm/sal-sync-core';
import { describe, expect, it } from 'vitest';
import {
  buildSessionManifest,
  FixtureBucket,
  type FixtureFile,
  sha256Hex as fixtureSha256Hex,
} from '../e2e/sync-fixtures.js';

/**
 * SYNC-005 — Browser CAS `FixtureBucket` ↔ plugin `StorageAdapter` mock parity.
 *
 * This test runs the same one-project/one-session/one-transcript scenario through
 * the browser-side `FixtureBucket` (used by `packages/site/tests/e2e/sync.spec.ts`)
 * and a minimal plugin-side `StorageAdapter` mock (modeled on the
 * `RecordingStorageAdapter` / `InMemoryStorageAdapter` patterns in
 * `packages/plugins/claude-session-sync/tests/e2e/plugin.test.ts` and
 * `packages/sync/tests/e2e/lifecycle.test.ts`). It asserts that the resulting
 * object keys, SHA-256 content-addressing, manifest schema, and artifact status
 * match on both sides.
 *
 * ## Notes — deliberately layer-specific fields
 *
 * - Project manifests (`<projectId>/manifest.json`) are written by the browser
 *   UI (`FixtureBucket.addProject`) but are not part of the plugin-side
 *   `sessionEnd` storage contract, so they are not compared.
 * - HTTP/transport bookkeeping is intentionally different:
 *   `FixtureBucket` keeps an S3 request log, CORS headers, and Playwright-route
 *   state; the plugin mock keeps a `PutObjectInput[]` call trace and a simple
 *   in-memory object map. These are implementation details, not contract fields.
 * - `FixtureBucket` stores raw (already-decoded) object keys in its in-memory
 *   map and decodes incoming request paths; `buildObjectKey` percent-encodes
 *   segments so the wire key is encoded. The scenario uses URL-safe identifiers
 *   so the encoded and raw strings are identical, and the percent-encoding is
 *   treated as a client transport detail rather than a contract mismatch.
 * - Timestamps and `pluginVersion` are fixture-controlled here because both sides
 *   use `buildSessionManifest`. Real plugin manifest generation may use
 *   `DEFAULT_PLUGIN_VERSION` ('unknown') and wall-clock timestamps; that is a
 *   fixture-vs-generator difference, not a mock drift, and is outside the scope
 *   of this storage-contract parity test.
 */

interface StoredObject {
  body: Uint8Array;
  sha256: string;
  contentType?: string;
}

interface ParityState {
  manifest: unknown;
  manifestKey: string;
  sessionKey: string;
  workspaceKey: string;
  sessionContent: Uint8Array;
  workspaceContent: Uint8Array;
}

function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function makeFixtureFiles(): FixtureFile[] {
  return [
    {
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: Buffer.from('{"type":"message","role":"user","content":"hello"}\n'),
    },
    {
      scope: 'workspace',
      relativePath: 'CLAUDE.md',
      content: Buffer.from('# Project guide\napiKey=secret\n'),
    },
  ];
}

function makeManifest(files: FixtureFile[], projectId: string, sessionId: string): SyncManifest {
  return buildSessionManifest(projectId, sessionId, files, true);
}

class PluginMockStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  readonly objects = new Map<string, StoredObject>();

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const sha256 = input.contentSha256 ?? sha256Hex(input.body);
    const key = buildObjectKey({ ...input, contentSha256: sha256 });
    this.calls.push(input);
    this.objects.set(key, { body: input.body, sha256, contentType: input.contentType });
    return { key, sha256, etag: `"${sha256}"` };
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult | undefined> {
    const key = buildObjectKey({ ...input, contentSha256: input.contentSha256 });
    const existing = this.objects.get(key);
    if (!existing) return undefined;
    return { body: existing.body, etag: `"${existing.sha256}"`, contentType: existing.contentType };
  }
}

function browserObjectStore(bucket: FixtureBucket): Map<string, Buffer> {
  return (bucket as unknown as { objectStore: Map<string, Buffer> }).objectStore;
}

function getRequired<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing object: ${key}`);
  return value;
}

function assertGot<T>(result: T | undefined): T {
  if (result === undefined) throw new Error('Expected object to exist');
  return result;
}

function sessionKey(projectId: string, sessionId: string, relativePath: string): string {
  return buildObjectKey({
    projectId,
    sessionId,
    scope: 'session',
    relativePath,
    contentSha256: '',
  });
}

function workspaceKey(hash: string): string {
  return buildObjectKey({
    projectId: '',
    sessionId: '',
    scope: 'workspace',
    relativePath: '',
    contentSha256: hash,
  });
}

async function uploadFiles(
  adapter: PluginMockStorageAdapter,
  projectId: string,
  sessionId: string,
  files: FixtureFile[],
): Promise<void> {
  for (const file of files) {
    const body = new Uint8Array(file.content);
    const fileHash = fixtureSha256Hex(file.content);
    await adapter.putObject({
      projectId,
      sessionId,
      scope: file.scope,
      relativePath: file.relativePath,
      body,
      contentType: file.scope === 'session' ? 'application/octet-stream' : 'text/markdown',
      contentSha256: fileHash,
    });
  }
}

async function uploadManifest(
  adapter: PluginMockStorageAdapter,
  manifest: SyncManifest,
  projectId: string,
  sessionId: string,
): Promise<string> {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestHash = sha256Hex(manifestBytes);
  const result = await adapter.putObject({
    projectId,
    sessionId,
    scope: 'manifest',
    relativePath: 'manifest.json',
    body: manifestBytes,
    contentType: 'application/json',
    contentSha256: manifestHash,
  });
  return result.key;
}

function extractBrowserParity(
  bucket: FixtureBucket,
  projectId: string,
  sessionId: string,
  files: FixtureFile[],
): ParityState {
  const store = browserObjectStore(bucket);
  const manifestKey = `${projectId}/${sessionId}/manifest.json`;
  const sessionRelative = files[0].relativePath;
  const workspaceHash = fixtureSha256Hex(files[1].content);

  const sessionObjectKey = `${projectId}/${sessionId}/${sessionRelative}`;
  const workspaceObjectKey = `global/cas/${workspaceHash}`;

  return {
    manifest: JSON.parse(getRequired(store, manifestKey).toString('utf8')),
    manifestKey,
    sessionKey: sessionObjectKey,
    workspaceKey: workspaceObjectKey,
    sessionContent: new Uint8Array(getRequired(store, sessionObjectKey)),
    workspaceContent: new Uint8Array(getRequired(store, workspaceObjectKey)),
  };
}

async function runPluginScenario(
  projectId: string,
  sessionId: string,
  files: FixtureFile[],
): Promise<ParityState> {
  const manifest = makeManifest(files, projectId, sessionId);
  const adapter = new PluginMockStorageAdapter();

  await uploadFiles(adapter, projectId, sessionId, files);
  const manifestKey = await uploadManifest(adapter, manifest, projectId, sessionId);

  const sessionRelative = files[0].relativePath;
  const sessionHash = fixtureSha256Hex(files[0].content);
  const workspaceHash = fixtureSha256Hex(files[1].content);

  const storedManifest = getRequired(adapter.objects, manifestKey);

  return {
    manifest: JSON.parse(Buffer.from(storedManifest.body).toString('utf8')),
    manifestKey,
    sessionKey: sessionKey(projectId, sessionId, sessionRelative),
    workspaceKey: workspaceKey(workspaceHash),
    sessionContent: assertGot(
      await adapter.getObject({
        projectId,
        sessionId,
        scope: 'session',
        relativePath: sessionRelative,
        contentSha256: sessionHash,
      }),
    ).body,
    workspaceContent: assertGot(
      await adapter.getObject({
        projectId,
        sessionId,
        scope: 'workspace',
        relativePath: files[1].relativePath,
        contentSha256: workspaceHash,
      }),
    ).body,
  };
}

function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function compareParity(browser: ParityState, plugin: ParityState): void {
  expect(plugin.manifestKey).toBe(browser.manifestKey);
  expect(plugin.sessionKey).toBe(browser.sessionKey);
  expect(plugin.workspaceKey).toBe(browser.workspaceKey);
  expect(plugin.manifest).toEqual(browser.manifest);
  expect(textOf(plugin.sessionContent)).toBe(textOf(browser.sessionContent));
  expect(textOf(plugin.workspaceContent)).toBe(textOf(browser.workspaceContent));
}

describe('SYNC-005: browser CAS FixtureBucket ↔ plugin mock transport parity', () => {
  it('produces equivalent manifest and object state for the same session', async () => {
    const projectId = 'parity-proj';
    const sessionId = 'parity-sess';
    const files = makeFixtureFiles();

    const bucket = new FixtureBucket();
    bucket.addProject(projectId, 'Parity Project', 'CAS parity');
    bucket.addSession(projectId, sessionId, { files });

    const browser = extractBrowserParity(bucket, projectId, sessionId, files);
    const plugin = await runPluginScenario(projectId, sessionId, files);

    compareParity(browser, plugin);
  });
});
