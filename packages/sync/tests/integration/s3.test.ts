import type { Server } from 'node:http';
import http from 'node:http';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildObjectKey,
  S3StorageAdapter,
  type StorageConfig,
  sha256Hex,
} from '../../src/index.js';

// Keep AWS SDK from adding its own retry delays on top of our storage retry.
process.env.AWS_MAX_ATTEMPTS = process.env.AWS_MAX_ATTEMPTS ?? '1';

const TEST_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const TEST_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

interface StoredObject {
  body: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
  etag: string;
}

/**
 * A minimal S3-compatible in-memory server used when no real S3 service is
 * configured. It supports the subset of S3 operations and error modes required
 * for the integration suite.
 */
class MockS3Server {
  private readonly server: Server;
  private readonly objects = new Map<string, StoredObject>();
  private readonly attemptCounts = new Map<string, number>();
  private port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(`http://127.0.0.1:${this.port}`);
        } else {
          reject(new Error('Could not get server address'));
        }
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  getStoredBody(key: string): Buffer | undefined {
    return this.objects.get(key)?.body;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    // Path-style requests look like /bucket/key — drop the leading bucket segment.
    const pathParts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    const _bucket = pathParts.shift();
    const key = pathParts.join('/');

    if (req.method === 'GET' && url.searchParams.has('list-type')) {
      this.handleList(url.searchParams.get('prefix') ?? '', res);
      return;
    }

    if (req.method === 'POST' && url.searchParams.has('delete')) {
      await this.handleDelete(req, res);
      return;
    }

    const testMode = req.headers['x-amz-meta-testmode'] as string | undefined;
    const attemptKey = `${req.method}:${key}`;
    const attempt = (this.attemptCounts.get(attemptKey) ?? 0) + 1;
    this.attemptCounts.set(attemptKey, attempt);

    if (testMode === '403') {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
      );
      return;
    }

    if (testMode === '429') {
      res.writeHead(429, { 'Content-Type': 'application/xml' });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>Too many requests</Message></Error>',
      );
      return;
    }

    if (testMode?.startsWith('500:')) {
      const failUntil = Number(testMode.split(':')[1]);
      if (attempt <= failUntil) {
        res.writeHead(500, { 'Content-Type': 'application/xml' });
        res.end(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>Internal Error</Message></Error>',
        );
        return;
      }
    }

    if (testMode === 'close' && attempt === 1) {
      req.socket.destroy();
      return;
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const sha256 = sha256Hex(body.toString('utf8'));

      const metadata: Record<string, string> = {};
      for (const [header, value] of Object.entries(req.headers)) {
        if (header.startsWith('x-amz-meta-') && value !== undefined) {
          metadata[header.slice('x-amz-meta-'.length)] = Array.isArray(value) ? value[0] : value;
        }
      }

      const contentType = req.headers['content-type'] as string | undefined;
      this.objects.set(key, { body, contentType, metadata, etag: `"${sha256}"` });

      res.writeHead(200, {
        'Content-Type': 'application/xml',
        ETag: `"${sha256}"`,
        'x-amz-meta-sha256': sha256,
      });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><PutObjectOutput><ETag>' +
          sha256 +
          '</ETag></PutObjectOutput>',
      );
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const object = this.objects.get(key);
      if (!object) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>',
        );
        return;
      }

      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': String(object.body.length),
          'Content-Type': object.contentType ?? 'application/octet-stream',
          ETag: object.etag,
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Length': String(object.body.length),
        'Content-Type': object.contentType ?? 'application/octet-stream',
        ETag: object.etag,
      });
      res.end(object.body);
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  }

  private handleList(prefix: string, res: http.ServerResponse): void {
    const contents = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .map(
        (k) =>
          `<Contents><Key>${escapeXml(k)}</Key><Size>${this.objects.get(k)?.body.length ?? 0}</Size></Contents>`,
      )
      .join('');
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
    );
  }

  private async handleDelete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const keys = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => unescapeXml(m[1] ?? ''));

    const deleted: string[] = [];
    for (const key of keys) {
      if (this.objects.has(key)) {
        this.objects.delete(key);
        deleted.push(key);
      }
    }

    const deletedXml = deleted.map((k) => `<Deleted><Key>${escapeXml(k)}</Key></Deleted>`).join('');
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><DeleteResult>${deletedXml}</DeleteResult>`);
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function makeS3Config(endpoint: string, bucket = 'test-bucket'): StorageConfig {
  return {
    type: 's3',
    bucket,
    region: 'us-east-1',
    endpoint,
    accessKeyId: TEST_ACCESS_KEY,
    secretAccessKey: TEST_SECRET_KEY,
  };
}

describe.skipIf(!process.env.SAL_S3_TEST_ENDPOINT)('S3 storage integration', () => {
  let server: MockS3Server;
  let endpoint: string;
  let projectId: string;
  let sessionId: string;

  beforeAll(async () => {
    const configured = process.env.SAL_S3_TEST_ENDPOINT;
    if (!configured) {
      throw new Error('SAL_S3_TEST_ENDPOINT is not configured');
    }

    if (configured === 'mock') {
      server = new MockS3Server();
      endpoint = await server.start();
    } else {
      endpoint = configured;
    }

    projectId = 'proj-s3';
    sessionId = 'sess-s3';
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  function makeInput(
    relativePath: string,
    body: string,
    scope: 'session' | 'workspace' | 'manifest' = 'workspace',
    metadata?: Record<string, string>,
  ) {
    return {
      projectId,
      sessionId,
      scope,
      relativePath,
      body: Buffer.from(body, 'utf8'),
      contentType: relativePath.endsWith('.json') ? 'application/json' : 'text/plain',
      contentSha256: sha256Hex(body),
      metadata,
    };
  }

  it('puts an object successfully', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });
    const body = 'hello s3';
    const result = await adapter.putObject(makeInput('.claude/settings.json', body));

    expect(result.key).toBe(
      buildObjectKey({
        projectId,
        sessionId,
        scope: 'workspace',
        relativePath: '.claude/settings.json',
        contentSha256: sha256Hex(body),
      }),
    );
    expect(result.sha256).toBe(sha256Hex(body));

    if (server) {
      const stored = server.getStoredBody(result.key);
      expect(stored?.toString('utf8')).toBe(body);
    }
  });

  it('retries on 5xx service errors and eventually succeeds', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), {
      retries: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });

    const body = 'retry me';
    const result = await adapter.putObject(
      makeInput('retry.json', body, 'workspace', { testmode: '500:2' }),
    );

    expect(result.sha256).toBe(sha256Hex(body));

    if (server) {
      expect(server.getStoredBody(result.key)?.toString('utf8')).toBe(body);
    }
  });

  it('maps 403 to a non-retryable auth failure', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), {
      retries: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });

    await expect(
      adapter.putObject(makeInput('auth.json', 'denied', 'workspace', { testmode: '403' })),
    ).rejects.toMatchObject({
      code: 'SYNC_AUTH_FAILED',
      retryable: false,
    });
  });

  it('retries on 429 throttling and eventually succeeds', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), {
      retries: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });

    const body = 'throttle me';
    // The server returns 429 for every attempt with this testmode, so the
    // retry policy will exhaust and the adapter will throw. This verifies
    // throttling is treated as retryable.
    await expect(
      adapter.putObject(makeInput('throttle.json', body, 'workspace', { testmode: '429' })),
    ).rejects.toMatchObject({
      code: 'SYNC_STORAGE_ERROR',
      retryable: true,
    });
  });

  it('retries after a dropped/partial connection and eventually succeeds', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), {
      retries: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
    });

    const body = 'complete me';
    const result = await adapter.putObject(
      makeInput('partial.json', body, 'workspace', { testmode: 'close' }),
    );

    expect(result.sha256).toBe(sha256Hex(body));

    if (server) {
      expect(server.getStoredBody(result.key)?.toString('utf8')).toBe(body);
    }
  });

  it('is idempotent for repeated PUTs of the same content', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });
    const body = 'idempotent';
    const input = makeInput('idempotent.json', body);

    const r1 = await adapter.putObject(input);
    const r2 = await adapter.putObject(input);

    expect(r1.key).toBe(r2.key);
    expect(r1.sha256).toBe(r2.sha256);
  });

  it('tolerates concurrent duplicate PUTs of the same object', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });
    const body = 'concurrent';
    const input = makeInput('concurrent.json', body);

    const [r1, r2] = await Promise.all([adapter.putObject(input), adapter.putObject(input)]);

    expect(r1.key).toBe(r2.key);
    expect(r1.sha256).toBe(r2.sha256);

    if (server) {
      expect(server.getStoredBody(r1.key)?.toString('utf8')).toBe(body);
    }
  });

  it('uploads a manifest to the session root key', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });
    const manifest = JSON.stringify({ schemaVersion: 2 });
    const result = await adapter.putObject(makeInput('manifest.json', manifest, 'manifest'));

    expect(result.key).toBe(`${projectId}/${sessionId}/manifest.json`);
    expect(result.sha256).toBe(sha256Hex(manifest));
  });

  it('normalizes object keys with special characters and rejects absolute paths', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });

    // Legacy (session-scoped) keys still carry relativePath in the key itself,
    // unlike workspace/global CAS keys, which are addressed purely by hash —
    // exercise the traversal/normalization behavior against the 'session'
    // scope, the only scope where it still applies.
    const withSpaces = await adapter.putObject(
      makeInput('foo bar/baz.json', 'with spaces', 'session'),
    );
    expect(withSpaces.key).toBe(
      buildObjectKey({
        projectId,
        sessionId,
        scope: 'session',
        relativePath: 'foo bar/baz.json',
      }),
    );

    await expect(
      adapter.putObject(makeInput('/etc/passwd', 'absolute', 'session')),
    ).rejects.toMatchObject({
      code: 'SYNC_STORAGE_ERROR',
      retryable: false,
    });
  });

  it('can GET and HEAD an uploaded object through the S3 client', async () => {
    if (!server) {
      // Only the in-memory mock exposes GET/HEAD verification reliably.
      return;
    }

    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });
    const body = 'round trip';
    const result = await adapter.putObject(makeInput('round-trip.json', body));

    const client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET_KEY },
    });

    const head = await client.send(
      new HeadObjectCommand({ Bucket: 'test-bucket', Key: result.key }),
    );
    expect(head.ContentLength).toBe(Buffer.byteLength(body, 'utf8'));
    expect(head.ETag).toBe(`"${result.sha256}"`);

    const get = await client.send(new GetObjectCommand({ Bucket: 'test-bucket', Key: result.key }));
    const chunks: Buffer[] = [];
    for await (const chunk of get.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(body);
  });

  it('lists and deletes every object under a project prefix, leaving CAS objects untouched', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });
    const removeProjectId = 'proj-remove';
    const removeSessionId = 'sess-remove';

    await adapter.putObject({
      projectId: removeProjectId,
      sessionId: removeSessionId,
      scope: 'session',
      relativePath: 'transcript.jsonl',
      body: Buffer.from('legacy content', 'utf8'),
      contentSha256: sha256Hex('legacy content'),
    });
    const casResult = await adapter.putObject({
      projectId: removeProjectId,
      sessionId: removeSessionId,
      scope: 'workspace',
      relativePath: 'CLAUDE.md',
      body: Buffer.from('shared workspace file', 'utf8'),
      contentSha256: sha256Hex('shared workspace file'),
    });

    const before = await adapter.listObjects({ projectId: removeProjectId });
    expect(before.objects.length).toBe(1);

    const result = await adapter.deleteObjects({ projectId: removeProjectId });
    expect(result.deletedKeys).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const after = await adapter.listObjects({ projectId: removeProjectId });
    expect(after.objects).toHaveLength(0);

    if (server) {
      expect(server.getStoredBody(casResult.key)).toBeDefined();
    }
  });

  it('scopes deleteObjects to a single session when sessionId is given', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });
    const removeProjectId = 'proj-remove-session';

    await adapter.putObject({
      projectId: removeProjectId,
      sessionId: 'sess-a',
      scope: 'session',
      relativePath: 'transcript.jsonl',
      body: Buffer.from('session a', 'utf8'),
      contentSha256: sha256Hex('session a'),
    });
    await adapter.putObject({
      projectId: removeProjectId,
      sessionId: 'sess-b',
      scope: 'session',
      relativePath: 'transcript.jsonl',
      body: Buffer.from('session b', 'utf8'),
      contentSha256: sha256Hex('session b'),
    });

    const result = await adapter.deleteObjects({ projectId: removeProjectId, sessionId: 'sess-a' });
    expect(result.deletedKeys).toHaveLength(1);

    const remaining = await adapter.listObjects({ projectId: removeProjectId });
    expect(remaining.objects).toHaveLength(1);
    expect(remaining.objects[0]?.key).toContain('sess-b');
  });

  it('rejects deleteObjects for projectId "global", the reserved CAS namespace root', async () => {
    const adapter = new S3StorageAdapter(makeS3Config(endpoint), { retries: 0 });

    // A CAS object shared by some other project/session.
    const shared = await adapter.putObject({
      projectId: 'some-other-project',
      sessionId: 'some-other-session',
      scope: 'workspace',
      relativePath: 'CLAUDE.md',
      body: Buffer.from('shared across projects', 'utf8'),
      contentSha256: sha256Hex('shared across projects'),
    });
    expect(shared.key.startsWith('global/cas/')).toBe(true);

    await expect(adapter.deleteObjects({ projectId: 'global' })).rejects.toMatchObject({
      code: 'SYNC_STORAGE_ERROR',
      retryable: false,
    });

    if (server) {
      expect(server.getStoredBody(shared.key)).toBeDefined();
    }
  });
});
