import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ManifestArtifact, SyncManifest, SyncRun } from '@lucasschirm/sal-sync-core';
import type { Page, Request, Route } from '@playwright/test';

export const S3_ENDPOINT = 'http://fake-s3.test';
export const S3_BUCKET = 'sal-bucket';
export const S3_BASE_PATH = `/${S3_BUCKET}/`;

export interface FixtureFile {
  scope: 'session' | 'workspace' | 'global' | 'runtime';
  relativePath: string;
  content: Buffer;
  /** Optional artifact hash override. When omitted, the actual SHA-256 of content is used. */
  sha256?: string;
}

export interface FixtureSession {
  sessionId: string;
  manifest: SyncManifest;
  files: FixtureFile[];
  legacy: boolean;
}

export interface FixtureProject {
  projectId: string;
  name: string;
  description: string;
  projectManifest: Record<string, unknown>;
  sessions: FixtureSession[];
}

export interface S3RequestLog {
  method: string;
  key: string;
  status: number;
  timestamp: number;
}

interface S3ListObjectEntry {
  key: string;
  size: number;
  etag?: string;
}

export function sha256Hex(data: Buffer | string): string {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buffer).digest('hex');
}

export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

export function fixtureBuffer(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

export function buildProjectManifest(
  projectId: string,
  name: string,
  description = '',
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId,
    name,
    description,
    createdAt: new Date().toISOString(),
    writtenBy: 'e2e-test',
  };
}

function buildSyncRun(filesDiscovered = 1): SyncRun {
  return {
    trigger: 'session-end',
    filesDiscovered,
    filesChanged: filesDiscovered,
    filesUploaded: filesDiscovered,
    filesFailed: 0,
    filesSkipped: 0,
    bytesDiscovered: 0,
    bytesChanged: 0,
    bytesUploaded: 0,
    discoveryDurationMs: 0,
    sanitizationDurationMs: 0,
    hashDurationMs: 0,
    uploadDurationMs: 0,
    totalDurationMs: 0,
  };
}

function buildManifestArtifact(
  file: FixtureFile,
  projectId: string,
  sessionId: string,
  sha256: string,
): ManifestArtifact {
  return {
    projectId,
    sessionId,
    scope: file.scope,
    relativePath: file.relativePath,
    sha256,
    size: file.content.length,
    status: 'uploaded',
  };
}

export function buildSessionManifest(
  projectId: string,
  sessionId: string,
  files: FixtureFile[],
  transcriptsCaptured = true,
): SyncManifest {
  const mainFile =
    files.find((f) => f.scope === 'session' && f.relativePath === 'transcript.jsonl') ??
    files.find((f) => f.scope === 'session');
  const mainTranscriptRelativePath =
    transcriptsCaptured && mainFile ? mainFile.relativePath : undefined;
  const artifacts = files.map((file) => {
    const sha256 = file.sha256 ?? sha256Hex(file.content);
    return buildManifestArtifact(file, projectId, sessionId, sha256);
  });
  if (!transcriptsCaptured && mainFile) {
    const mainArtifact = artifacts.find(
      (a) => a.scope === 'session' && a.relativePath === mainFile.relativePath,
    );
    if (mainArtifact) {
      mainArtifact.status = 'pending';
    }
  }
  return {
    schemaVersion: 2,
    projectId,
    sessionId,
    harness: 'claude',
    harnessVersion: '1',
    model: 'claude-sonnet-5',
    startedAt: new Date(1000).toISOString(),
    endedAt: new Date(2000).toISOString(),
    durationMs: 1000,
    endReason: 'completed',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    transcriptsCaptured,
    mainTranscriptRelativePath,
    artifacts,
    syncRuns: [buildSyncRun(files.length)],
  };
}

function encodeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildListXml(
  prefixes: string[],
  objects: S3ListObjectEntry[],
  isTruncated = false,
): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>';
  xml += '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">';
  for (const prefix of prefixes) {
    xml += `<CommonPrefixes><Prefix>${encodeXml(prefix)}</Prefix></CommonPrefixes>`;
  }
  for (const object of objects) {
    const etag = object.etag ? `<ETag>${encodeXml(object.etag)}</ETag>` : '';
    xml += `<Contents><Key>${encodeXml(object.key)}</Key>${etag}<Size>${object.size}</Size></Contents>`;
  }
  xml += `<IsTruncated>${isTruncated ? 'true' : 'false'}</IsTruncated>`;
  xml += '</ListBucketResult>';
  return xml;
}

function objectKeyForFile(
  projectId: string,
  sessionId: string,
  file: FixtureFile,
  actualSha256: string,
): string {
  if (file.scope === 'session') {
    return `${projectId}/${sessionId}/session/${file.relativePath}`;
  }
  return `global/cas/${actualSha256}`;
}

export class FixtureBucket {
  readonly projects: FixtureProject[] = [];
  readonly requests: S3RequestLog[] = [];
  readonly putManifests: Map<string, Record<string, unknown>> = new Map();
  readonly putObjects: Map<string, Buffer> = new Map();
  readonly globalChildren: Set<string> = new Set();

  private readonly objectStore: Map<string, Buffer> = new Map();
  private readonly delays: Map<string, number> = new Map();

  addProject(projectId: string, name: string, description = ''): void {
    const projectManifest = buildProjectManifest(projectId, name, description);
    this.objectStore.set(
      `${projectId}/manifest.json`,
      Buffer.from(JSON.stringify(projectManifest)),
    );
    this.projects.push({
      projectId,
      name,
      description,
      projectManifest,
      sessions: [],
    });
  }

  addSession(
    projectId: string,
    sessionId: string,
    options: {
      files: FixtureFile[];
      legacy?: boolean;
      transcriptsCaptured?: boolean;
    },
  ): FixtureSession {
    const legacy = options.legacy ?? false;
    const transcriptsCaptured = options.transcriptsCaptured ?? true;
    const manifest = buildSessionManifest(projectId, sessionId, options.files, transcriptsCaptured);
    if (legacy) {
      for (const file of options.files) {
        if (file.scope === 'session' && file.sha256 === undefined) {
          file.sha256 = 'legacy-hash-not-valid';
        }
      }
    }
    const session: FixtureSession = { sessionId, manifest, files: options.files, legacy };
    const project = this.projects.find((p) => p.projectId === projectId);
    if (project) project.sessions.push(session);
    this.objectStore.set(
      `${projectId}/${sessionId}/manifest.json`,
      Buffer.from(JSON.stringify(manifest)),
    );
    for (const file of options.files) {
      const actualSha256 = sha256Hex(file.content);
      const key = objectKeyForFile(projectId, sessionId, file, actualSha256);
      this.objectStore.set(key, file.content);
      if (file.scope !== 'session') {
        this.globalChildren.add('cas');
      }
    }
    return session;
  }

  addGlobalChild(child: string): void {
    this.globalChildren.add(child);
  }

  /**
   * Add session objects under `global/<sessionId>/`, simulating a pre-validation
   * upload that used the reserved `global` namespace. This should trigger a
   * conflict warning but never be treated as a project.
   */
  addGlobalSession(sessionId: string, files: FixtureFile[]): void {
    for (const file of files) {
      const key = `global/${sessionId}/${file.scope}/${file.relativePath}`;
      this.objectStore.set(key, file.content);
      if (file.scope !== 'session') {
        this.globalChildren.add('cas');
      }
    }
  }

  /**
   * Add a session under a project folder without writing a project manifest.
   * The folder should be discoverable but skipped until the user creates it.
   */
  addRawSession(projectId: string, sessionId: string, files: FixtureFile[]): void {
    const manifest = buildSessionManifest(projectId, sessionId, files, true);
    this.objectStore.set(
      `${projectId}/${sessionId}/manifest.json`,
      Buffer.from(JSON.stringify(manifest)),
    );
    for (const file of files) {
      const actualSha256 = sha256Hex(file.content);
      const key = objectKeyForFile(projectId, sessionId, file, actualSha256);
      this.objectStore.set(key, file.content);
      if (file.scope !== 'session') {
        this.globalChildren.add('cas');
      }
    }
  }

  setProjectManifest(projectId: string, content: Buffer): void {
    this.objectStore.set(`${projectId}/manifest.json`, content);
  }

  setObjectContent(objectKey: string, content: Buffer): void {
    this.objectStore.set(objectKey, content);
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  setDelay(objectKey: string, ms: number): void {
    this.delays.set(objectKey, ms);
  }

  setManifestContent(projectId: string, sessionId: string, content: Buffer): void {
    this.objectStore.set(`${projectId}/${sessionId}/manifest.json`, content);
  }

  hasGlobalFolder(): boolean {
    return this.globalChildren.size > 0;
  }

  getProjectManifestPut(projectId: string): Record<string, unknown> | undefined {
    return this.putManifests.get(`${projectId}/manifest.json`);
  }

  getRequests(filter: { method?: string; key?: string } = {}): S3RequestLog[] {
    return this.requests.filter(
      (r) =>
        (filter.method === undefined || r.method === filter.method) &&
        (filter.key === undefined || r.key.includes(filter.key)),
    );
  }

  countGetRequests(keyPattern: string): number {
    return this.requests.filter(
      (r) => r.method === 'GET' && r.status === 200 && r.key.includes(keyPattern),
    ).length;
  }

  async installRoute(page: Page): Promise<void> {
    await page.route(`${S3_ENDPOINT}/**`, (route, request) => {
      void this.handleRoute(page, route, request);
    });
  }

  private async handleRoute(page: Page, route: Route, request: Request): Promise<void> {
    if (page.isClosed()) {
      await route.abort('aborted');
      return;
    }
    const method = request.method();
    const url = new URL(request.url());

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'HEAD, GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' },
        body: '',
      });
      return;
    }

    if (method === 'HEAD' && this.isBasePath(url)) {
      this.logRequest(method, '', 200);
      await route.fulfill({ status: 200, headers: corsHeaders, body: '' });
      return;
    }

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      await this.handleList(route, url, corsHeaders);
      return;
    }

    const objectKey = this.decodeObjectKey(url);

    if (method === 'GET') {
      await this.handleGet(page, route, objectKey, corsHeaders);
      return;
    }

    if (method === 'PUT') {
      await this.handlePut(route, request, objectKey, corsHeaders);
      return;
    }

    this.logRequest(method, objectKey, 404);
    await route.fulfill({
      status: 404,
      contentType: 'application/xml',
      headers: corsHeaders,
      body: '<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>',
    });
  }

  private isBasePath(url: URL): boolean {
    return url.pathname === S3_BASE_PATH || url.pathname === `/${S3_BUCKET}`;
  }

  private decodeObjectKey(url: URL): string {
    const parts = url.pathname.split('/');
    if (parts.length < 3 || parts[1] !== S3_BUCKET) return '';
    return parts
      .slice(2)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      })
      .join('/');
  }

  private async handleList(
    route: Route,
    url: URL,
    corsHeaders: Record<string, string>,
  ): Promise<void> {
    const prefix = url.searchParams.get('prefix') ?? '';
    const delimiter = url.searchParams.get('delimiter') ?? '';
    const status = 200;
    let body = '';
    if (delimiter) {
      const prefixes = this.listCommonPrefixes(prefix, delimiter);
      body = buildListXml(prefixes, [], false);
    } else {
      const objects = this.listObjectContents(prefix);
      body = buildListXml([], objects, false);
    }
    this.logRequest('GET', `list:${prefix}`, status);
    await route.fulfill({
      status,
      contentType: 'application/xml',
      headers: corsHeaders,
      body,
    });
  }

  private async handleGet(
    page: Page,
    route: Route,
    objectKey: string,
    corsHeaders: Record<string, string>,
  ): Promise<void> {
    const delay = this.delays.get(objectKey);
    if (delay && delay > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
      if (page.isClosed()) return;
    }
    const body = this.objectStore.get(objectKey);
    if (!body) {
      this.logRequest('GET', objectKey, 404);
      await this.tryFulfill(route, {
        status: 404,
        contentType: 'application/xml',
        headers: corsHeaders,
        body: '<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>',
      });
      return;
    }
    this.logRequest('GET', objectKey, 200);
    await this.tryFulfill(route, {
      status: 200,
      contentType: 'application/octet-stream',
      headers: { ...corsHeaders, ETag: `"${sha256Hex(body)}"` },
      body,
    });
  }

  private async tryFulfill(route: Route, options: Parameters<Route['fulfill']>[0]): Promise<void> {
    try {
      await route.fulfill(options);
    } catch {
      // The page may have been closed or the request aborted while we delayed.
    }
  }

  private async handlePut(
    route: Route,
    request: Request,
    objectKey: string,
    corsHeaders: Record<string, string>,
  ): Promise<void> {
    const body = (await request.postDataBuffer()) ?? Buffer.alloc(0);
    this.objectStore.set(objectKey, body);
    this.putObjects.set(objectKey, body);
    if (objectKey.endsWith('/manifest.json')) {
      try {
        this.putManifests.set(
          objectKey,
          JSON.parse(body.toString('utf8')) as Record<string, unknown>,
        );
      } catch {
        // ignore invalid manifest JSON
      }
    }
    this.logRequest('PUT', objectKey, 200);
    await this.tryFulfill(route, {
      status: 200,
      contentType: 'application/xml',
      headers: { ...corsHeaders, ETag: `"${sha256Hex(body)}"` },
      body: '<PutObjectResult></PutObjectResult>',
    });
  }

  private listCommonPrefixes(prefix: string, delimiter: string): string[] {
    const seen = new Set<string>();
    for (const key of this.objectStore.keys()) {
      if (!key.startsWith(prefix)) continue;
      const after = key.slice(prefix.length);
      const index = after.indexOf(delimiter);
      if (index < 0) continue;
      const candidate = `${prefix}${after.slice(0, index + 1)}`;
      seen.add(candidate);
    }
    if (prefix === 'global/') {
      for (const child of this.globalChildren) {
        seen.add(`${prefix}${child}/`);
      }
    }
    return Array.from(seen).sort();
  }

  private listObjectContents(prefix: string): S3ListObjectEntry[] {
    const entries: S3ListObjectEntry[] = [];
    for (const [key, body] of this.objectStore) {
      if (key.startsWith(prefix)) {
        entries.push({ key, size: body.length, etag: `"${key}-etag"` });
      }
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  private logRequest(method: string, key: string, status: number): void {
    this.requests.push({ method, key, status, timestamp: Date.now() });
  }
}
