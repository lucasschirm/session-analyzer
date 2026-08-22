import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildObjectKey, encodeKeySegment } from '../../src/index.js';
import {
  type S3ClientConfig,
  S3Error,
  S3FetchClient,
  type S3ListOptions,
} from '../../src/storage/fetch-client.js';

const BASE_CONFIG: S3ClientConfig = {
  accessKeyId: 'akid',
  secretAccessKey: 'secret',
  region: 'us-east-1',
  bucket: 'my-bucket',
  controlPlaneTimeoutMs: 100,
  retryBackoffMs: 10,
};

function s3ErrorXml(code: string, message: string): string {
  return `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

function listXml(prefixes: string[], isTruncated: boolean, nextToken?: string): string {
  const cp = prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('');
  const next = nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : '';
  const trunc = `<IsTruncated>${isTruncated}</IsTruncated>`;
  return `<?xml version="1.0"?><ListBucketResult>${trunc}${next}${cp}</ListBucketResult>`;
}

function objectsXml(
  objects: Array<{ key: string; size: number }>,
  isTruncated: boolean,
  nextToken?: string,
): string {
  const contents = objects
    .map((o) => `<Contents><Key>${o.key}</Key><Size>${o.size}</Size></Contents>`)
    .join('');
  const next = nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : '';
  const trunc = `<IsTruncated>${isTruncated}</IsTruncated>`;
  return `<?xml version="1.0"?><ListBucketResult>${trunc}${next}${contents}</ListBucketResult>`;
}

function createMockFetch(
  calls: Array<(request: Request, index: number) => Response | Promise<Response>>,
): typeof fetch {
  let index = 0;
  return async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(String(input));
    if (request.signal.aborted) {
      return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
    }
    const call = calls[index];
    index++;
    if (!call) return new Response(null, { status: 404 });
    return Promise.resolve(call(request, index - 1));
  };
}

function hangingResponse(request: Request): Promise<Response> {
  return new Promise((_, reject) => {
    if (request.signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    request.signal.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted', 'AbortError')),
      { once: true },
    );
  });
}

function setupClient(config = BASE_CONFIG, mock: typeof fetch): S3FetchClient {
  vi.stubGlobal('fetch', mock);
  return new S3FetchClient(config);
}

function urlOf(request: Request): URL {
  return new URL(request.url);
}

function lastRequest(mock: ReturnType<typeof vi.fn>): Request {
  const calls = mock.mock.calls;
  const last = calls[calls.length - 1];
  const [input] = last ?? [];
  return input instanceof Request ? input : new Request(String(input ?? ''));
}

function resetStubs() {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  resetStubs();
});

describe('S3FetchClient', () => {
  it('uses virtual-hosted URLs by default', async () => {
    const mock = vi.fn(createMockFetch([() => new Response(null, { status: 200 })]));
    const client = setupClient(BASE_CONFIG, mock);
    await client.headBucket();
    const url = urlOf(lastRequest(mock));
    expect(url.hostname).toBe(`${BASE_CONFIG.bucket}.s3.${BASE_CONFIG.region}.amazonaws.com`);
    expect(url.pathname).toBe('/');
    expect(lastRequest(mock).method).toBe('HEAD');
  });

  it('uses path-style URLs when an endpoint is configured', async () => {
    const config = { ...BASE_CONFIG, endpoint: 'https://s3.example.com' };
    const mock = vi.fn(createMockFetch([() => new Response(null, { status: 200 })]));
    const client = setupClient(config, mock);
    await client.headBucket();
    const url = urlOf(lastRequest(mock));
    expect(url.hostname).toBe('s3.example.com');
    expect(url.pathname).toBe(`/${config.bucket}/`);
  });

  it('preserves percent-encoded object keys in the URL path', async () => {
    const key = buildObjectKey({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: 'foo bar/baz:qux/café/a?b&c=d',
    });
    const mock = vi.fn(
      createMockFetch([() => new Response(new Uint8Array([1, 2, 3]), { status: 200 })]),
    );
    const client = setupClient(BASE_CONFIG, mock);
    await client.getObject(key);
    const url = urlOf(lastRequest(mock));
    expect(url.pathname).toContain('foo%20bar');
    expect(url.pathname).toContain('baz%3Aqux');
    expect(url.pathname).toContain('caf%C3%A9');
    expect(url.pathname).toContain('a%3Fb%26c%3Dd');
  });

  it('does not double-encode already-encoded keys', async () => {
    const key = buildObjectKey({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: 'a?b&c=d',
    });
    const mock = vi.fn(createMockFetch([() => new Response(new Uint8Array([1]), { status: 200 })]));
    const client = setupClient(BASE_CONFIG, mock);
    await client.getObject(key);
    const url = urlOf(lastRequest(mock));
    const encodedPath = url.pathname;
    expect(encodedPath).not.toContain('%253F');
    expect(encodedPath).toContain('%3F');
  });

  it('sets content-type to application/json for putObject', async () => {
    const mock = vi.fn(
      createMockFetch([() => new Response(null, { status: 200, headers: { ETag: '"abc"' } })]),
    );
    const client = setupClient(BASE_CONFIG, mock);
    await client.putObject('p/s/manifest.json', new TextEncoder().encode('{}'));
    const request = lastRequest(mock);
    expect(request.method).toBe('PUT');
    expect(request.headers.get('Content-Type')).toBe('application/json');
  });

  it('returns the ETag from putObject', async () => {
    const mock = vi.fn(
      createMockFetch([() => new Response(null, { status: 200, headers: { ETag: '"abc"' } })]),
    );
    const client = setupClient(BASE_CONFIG, mock);
    const result = await client.putObject('p/s/manifest.json', new TextEncoder().encode('{}'));
    expect(result.etag).toBe('"abc"');
  });

  it('parses S3 error XML into S3Error', async () => {
    const xml = s3ErrorXml('NoSuchKey', 'The specified key does not exist.');
    const mock = vi.fn(createMockFetch([() => new Response(xml, { status: 404 })]));
    const client = setupClient(BASE_CONFIG, mock);
    await expect(client.getObject('missing')).rejects.toSatisfy((error: S3Error) => {
      return error instanceof S3Error && error.status === 404 && error.code === 'NoSuchKey';
    });
  });

  it('maps TypeError: Failed to fetch to a CORS error', async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = setupClient(BASE_CONFIG, mock);
    await expect(client.headBucket()).rejects.toSatisfy((error: S3Error) => {
      return error instanceof S3Error && error.kind === 'cors' && error.code === 'CORSBlocked';
    });
  });

  it('maps other network TypeErrors to network errors', async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = setupClient(BASE_CONFIG, mock);
    await expect(client.headBucket()).rejects.toSatisfy((error: S3Error) => {
      return (
        error instanceof S3Error && error.kind === 'network' && error.code === 'NetworkFailure'
      );
    });
  });

  it('retries idempotent operations once on 5xx', async () => {
    const xml = s3ErrorXml('InternalError', 'slow down');
    const mock = vi.fn(
      createMockFetch([
        () => new Response(xml, { status: 500 }),
        () => new Response(null, { status: 200 }),
      ]),
    );
    const client = setupClient(BASE_CONFIG, mock);
    await client.headBucket();
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('does not retry 4xx errors', async () => {
    const xml = s3ErrorXml('AccessDenied', 'nope');
    const mock = vi.fn(createMockFetch([() => new Response(xml, { status: 403 })]));
    const client = setupClient(BASE_CONFIG, mock);
    await expect(client.headBucket()).rejects.toSatisfy((error: S3Error) => {
      return error instanceof S3Error && error.status === 403;
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('aborts control-plane calls after the configured timeout', async () => {
    const mock = vi.fn(createMockFetch([hangingResponse]));
    const client = setupClient(BASE_CONFIG, mock);
    await expect(client.headBucket()).rejects.toSatisfy((error: S3Error) => {
      return error instanceof S3Error && error.code === 'NetworkTimeout';
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('paginates ListObjectsV2 and invokes onPage per page', async () => {
    const calls = [
      () =>
        new Response(listXml(['project-a/', 'global/', 'project%20b/'], true, 'token1'), {
          status: 200,
        }),
      () => new Response(listXml(['project-c/'], false), { status: 200 }),
    ];
    const mock = vi.fn(createMockFetch(calls));
    const client = setupClient(BASE_CONFIG, mock);
    const pages: string[][] = [];
    const options: S3ListOptions = {
      onPage: (page) => {
        pages.push(page.prefixes);
      },
    };
    const result = await client.listProjectFolders(options);
    expect(result).toEqual(['project-a', 'project b', 'project-c']);
    expect(pages).toEqual([['project-a', 'project b'], ['project-c']]);
    const firstUrl = urlOf(mock.mock.calls[0]?.[0] as Request);
    expect(firstUrl.searchParams.get('continuation-token')).toBeNull();
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('listProjectFolders excludes the reserved global prefix', async () => {
    const xml = listXml(['project-a/', 'global/', 'global%2F'], false);
    const mock = vi.fn(createMockFetch([() => new Response(xml, { status: 200 })]));
    const client = setupClient(BASE_CONFIG, mock);
    const result = await client.listProjectFolders();
    expect(result).toEqual(['project-a']);
  });

  it('listSessionFolders encodes the project prefix and decodes session names', async () => {
    const projectId = 'my project?café&test=1';
    const prefix = `${encodeKeySegment(projectId)}/`;
    const xml = listXml([`${prefix}session%3A1/`, `${prefix}session%20two/`], false);
    const mock = vi.fn(createMockFetch([() => new Response(xml, { status: 200 })]));
    const client = setupClient(BASE_CONFIG, mock);
    const result = await client.listSessionFolders(projectId);
    expect(result).toEqual(['session:1', 'session two']);
    const request = lastRequest(mock);
    const url = urlOf(request);
    expect(url.search).toContain(`prefix=${prefix}`);
    expect(url.search).not.toContain('%2520');
    expect(url.search).not.toContain('%253F');
  });

  it('listSessionObjects encodes the session prefix and returns decoded keys and sizes', async () => {
    const projectId = 'my project';
    const sessionId = 'session 1';
    const prefix = `${encodeKeySegment(projectId)}/${encodeKeySegment(sessionId)}/session/`;
    const key1 = `${prefix}transcript.jsonl`;
    const key2 = `${prefix}subagents/agent-1.jsonl`;
    const mock = vi.fn(
      createMockFetch([
        () =>
          new Response(
            objectsXml(
              [
                { key: key1, size: 42 },
                { key: key2, size: 7 },
              ],
              false,
            ),
            { status: 200 },
          ),
      ]),
    );
    const client = setupClient(BASE_CONFIG, mock);
    const result = await client.listSessionObjects(projectId, sessionId);
    expect(result).toEqual([
      { key: key1, size: 42 },
      { key: key2, size: 7 },
    ]);
    const request = lastRequest(mock);
    const url = urlOf(request);
    expect(url.search).toContain(`prefix=${prefix}`);
    expect(url.search).not.toContain('delimiter');
  });

  it('streams large downloads and reports incremental progress', async () => {
    let pullCount = 0;
    const chunkA = new Uint8Array([1, 2, 3]);
    const chunkB = new Uint8Array([4, 5]);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(chunkA);
        } else if (pullCount === 2) {
          controller.enqueue(chunkB);
          controller.close();
        }
      },
    });
    const mock = vi.fn(createMockFetch([() => new Response(stream, { status: 200 })]));
    const client = setupClient(BASE_CONFIG, mock);
    const progress: number[] = [];
    const result = await client.getObject('p/s/session/transcript.jsonl', {
      streaming: true,
      onProgress: (bytes) => progress.push(bytes),
    });
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(progress).toEqual([3, 5]);
  });

  it('aborts streaming downloads on a stall and restarts once', async () => {
    const hanging = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueues */
      },
    });
    const chunk = new Uint8Array([9, 9, 9]);
    const ok = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const mock = vi.fn(
      createMockFetch([
        () => new Response(hanging, { status: 200 }),
        () => new Response(ok, { status: 200 }),
      ]),
    );
    const client = setupClient(BASE_CONFIG, mock);
    const result = await client.getObject('p/s/session/transcript.jsonl', {
      streaming: true,
      stallTimeoutMs: 10,
    });
    expect(new Uint8Array(result)).toEqual(chunk);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
