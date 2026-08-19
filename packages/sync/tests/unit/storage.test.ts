import { createHash } from 'node:crypto';
import {
  type GetObjectCommand,
  type HeadObjectCommand,
  type ListObjectsV2Command,
  type PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import {
  buildObjectKey,
  calculateRetryDelay,
  type GetObjectInput,
  type GetObjectResult,
  type HeadObjectInput,
  type HeadObjectResult,
  isRetryableError,
  mapS3Error,
  type PutObjectInput,
  type PutObjectResult,
  parseObjectKey,
  S3StorageAdapter,
  type StorageAdapter,
  type StorageConfig,
  StorageError,
  type StorageObjectScope,
  withRetry,
} from '../../src/index.js';

const TEST_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const TEST_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function textBody(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeInput(overrides: Partial<PutObjectInput> = {}): PutObjectInput {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    scope: 'workspace',
    relativePath: '.claude/settings.json',
    body: textBody('hello world'),
    ...overrides,
  };
}

function makeS3Config(overrides: Partial<StorageConfig> = {}): StorageConfig {
  return {
    type: 's3',
    bucket: 'my-bucket',
    region: 'us-east-1',
    accessKeyId: TEST_ACCESS_KEY,
    secretAccessKey: TEST_SECRET_KEY,
    ...overrides,
  };
}

class AwsError extends Error {
  public readonly $metadata?: { httpStatusCode?: number };

  constructor(name: string, message: string, statusCode?: number) {
    super(message);
    this.name = name;
    if (statusCode !== undefined) {
      this.$metadata = { httpStatusCode: statusCode };
    }
  }
}

class InMemoryStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<
    string,
    {
      body: Uint8Array;
      sha256: string;
      etag: string;
      contentType?: string;
      metadata?: Record<string, string>;
    }
  >();

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(input.body);
    const existing = this.objects.get(key);

    if (existing && existing.sha256 === sha256) {
      return { key, etag: existing.etag, sha256 };
    }

    const etag = `"${sha256}"`;
    this.objects.set(key, {
      body: input.body,
      sha256,
      etag,
      contentType: input.contentType,
      metadata: input.metadata,
    });

    return { key, etag, sha256 };
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult | undefined> {
    const key = buildObjectKey(input);
    const existing = this.objects.get(key);
    if (!existing) return undefined;

    return {
      body: existing.body,
      sha256: existing.sha256,
      etag: existing.etag,
      contentType: existing.contentType,
      metadata: existing.metadata,
    };
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult | undefined> {
    const key = buildObjectKey(input);
    const existing = this.objects.get(key);
    if (!existing) return undefined;

    return {
      contentLength: existing.body.length,
      sha256: existing.sha256,
      etag: existing.etag,
      contentType: existing.contentType,
      metadata: existing.metadata,
    };
  }

  listKeys(): string[] {
    return [...this.objects.keys()];
  }
}

describe('buildObjectKey', () => {
  it('places the manifest at the session root', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'manifest',
        relativePath: 'manifest.json',
      }),
    ).toBe('p/s/manifest.json');
  });

  it('builds session artifact keys', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'session',
        relativePath: 'transcript.jsonl',
      }),
    ).toBe('p/s/session/transcript.jsonl');
  });

  it('builds workspace artifact keys', () => {
    expect(buildObjectKey(makeInput({ scope: 'workspace' }))).toBe(
      'proj-1/sess-1/workspace/.claude/settings.json',
    );
  });

  it('builds global artifact keys with tilde paths', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'global',
        relativePath: '~/.claude/settings.json',
      }),
    ).toBe('p/s/global/~/.claude/settings.json');
  });

  it('builds runtime artifact keys', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'runtime',
        relativePath: 'telemetry.json',
      }),
    ).toBe('p/s/runtime/telemetry.json');
  });

  it('encodes project and session identifiers', () => {
    expect(
      buildObjectKey({
        projectId: 'my project',
        sessionId: 'sess:1',
        scope: 'session',
        relativePath: 'file.json',
      }),
    ).toBe('my%20project/sess%3A1/session/file.json');
  });

  it('encodes special characters in path segments', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: 'foo bar/baz:qux',
      }),
    ).toBe('p/s/workspace/foo%20bar/baz%3Aqux');
  });

  it('collapses and normalizes slashes and backslashes', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: 'a\\b//c',
      }),
    ).toBe('p/s/workspace/a/b/c');
  });

  it('strips leading and trailing slashes', () => {
    expect(
      buildObjectKey({
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: './.claude/settings.json/',
      }),
    ).toBe('p/s/workspace/.claude/settings.json');
  });

  it('rejects absolute unix paths', () => {
    expect(() => buildObjectKey(makeInput({ relativePath: '/etc/passwd' }))).toThrow(StorageError);
  });

  it('rejects absolute windows paths', () => {
    expect(() => buildObjectKey(makeInput({ relativePath: 'C:\\Users\\x\\y' }))).toThrow(
      StorageError,
    );
  });

  it('rejects parent directory traversal', () => {
    expect(() => buildObjectKey(makeInput({ relativePath: 'foo/../../bar' }))).toThrow(
      StorageError,
    );
  });

  it('rejects empty relativePath', () => {
    expect(() => buildObjectKey(makeInput({ relativePath: '' }))).toThrow(StorageError);
  });

  it('rejects unsupported scopes', () => {
    expect(() => buildObjectKey(makeInput({ scope: 'unknown' as StorageObjectScope }))).toThrow(
      StorageError,
    );
  });

  it('rejects keys that exceed S3 maximum length', () => {
    const longProjectId = 'a'.repeat(1024);
    expect(() =>
      buildObjectKey({
        projectId: longProjectId,
        sessionId: 's',
        scope: 'workspace',
        relativePath: 'file.txt',
      }),
    ).toThrow(StorageError);
  });

  it('never produces keys containing absolute path markers', () => {
    const scopes: StorageObjectScope[] = ['session', 'workspace', 'global', 'runtime', 'manifest'];
    for (const scope of scopes) {
      const relativePath = scope === 'manifest' ? 'manifest.json' : 'subpath/file.txt';
      const key = buildObjectKey({ projectId: 'p', sessionId: 's', scope, relativePath });
      expect(key.startsWith('/')).toBe(false);
      expect(key.includes('/../')).toBe(false);
      expect(key.includes('//')).toBe(false);
    }
  });
});

describe('isRetryableError', () => {
  it('classifies 5xx service errors as retryable', () => {
    expect(isRetryableError(new AwsError('InternalError', 'internal', 500))).toBe(true);
    expect(isRetryableError(new AwsError('ServiceUnavailable', 'unavailable', 503))).toBe(true);
  });

  it('classifies 429 rate limiting as retryable', () => {
    expect(isRetryableError(new AwsError('SlowDown', 'slow down', 429))).toBe(true);
  });

  it('classifies 408 request timeout as retryable', () => {
    expect(isRetryableError(new AwsError('RequestTimeout', 'timeout', 408))).toBe(true);
  });

  it('classifies 4xx client errors as non-retryable', () => {
    expect(isRetryableError(new AwsError('AccessDenied', 'denied', 403))).toBe(false);
    expect(isRetryableError(new AwsError('NoSuchBucket', 'no bucket', 404))).toBe(false);
    expect(isRetryableError(new AwsError('InvalidArgument', 'bad', 400))).toBe(false);
  });

  it('classifies network errors as retryable', () => {
    expect(isRetryableError(new AwsError('ECONNRESET', 'connection reset'))).toBe(true);
    expect(isRetryableError(new AwsError('ETIMEDOUT', 'timed out'))).toBe(true);
    expect(isRetryableError(new AwsError('TimeoutError', 'timeout'))).toBe(true);
    expect(isRetryableError(new AwsError('ENOTFOUND', 'dns'))).toBe(true);
  });

  it('classifies credential and bucket errors as non-retryable', () => {
    expect(isRetryableError(new AwsError('InvalidAccessKeyId', 'bad key'))).toBe(false);
    expect(isRetryableError(new AwsError('NoSuchBucket', 'no bucket'))).toBe(false);
    expect(isRetryableError(new AwsError('CredentialsProviderError', 'no creds'))).toBe(false);
  });

  it('classifies StorageError by its retryable flag', () => {
    expect(isRetryableError(new StorageError('SYNC_NETWORK_TIMEOUT', 'msg', true))).toBe(true);
    expect(isRetryableError(new StorageError('SYNC_AUTH_FAILED', 'msg', false))).toBe(false);
  });

  it('classifies retryable errors by message when no status or name matches', () => {
    expect(isRetryableError(new AwsError('UnknownError', 'connection reset by peer'))).toBe(true);
    expect(isRetryableError(new AwsError('UnknownError', 'throttled by service'))).toBe(true);
    expect(isRetryableError(new AwsError('UnknownError', 'some non retryable issue'))).toBe(false);
  });
});

describe('calculateRetryDelay', () => {
  it('uses bounded exponential backoff', () => {
    expect(calculateRetryDelay(0, 100, 1000)).toBe(100);
    expect(calculateRetryDelay(1, 100, 1000)).toBe(200);
    expect(calculateRetryDelay(2, 100, 1000)).toBe(400);
    expect(calculateRetryDelay(3, 100, 1000)).toBe(800);
    expect(calculateRetryDelay(10, 100, 1000)).toBe(1000);
  });
});

describe('withRetry', () => {
  const fastOptions = { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 };

  it('succeeds on the first attempt', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(op, isRetryableError, fastOptions);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable errors and succeeds', async () => {
    const op = vi.fn();
    op.mockRejectedValueOnce(new AwsError('InternalError', 'internal', 500));
    op.mockResolvedValueOnce('ok');
    const result = await withRetry(op, isRetryableError, fastOptions);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and rethrows the last error', async () => {
    const err = new AwsError('InternalError', 'internal', 500);
    const op = vi.fn().mockRejectedValue(err);
    await expect(withRetry(op, isRetryableError, { ...fastOptions, maxRetries: 2 })).rejects.toBe(
      err,
    );
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const err = new AwsError('AccessDenied', 'denied', 403);
    const op = vi.fn().mockRejectedValue(err);
    await expect(withRetry(op, isRetryableError, fastOptions)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('InMemoryStorageAdapter', () => {
  it('implements the StorageAdapter contract', async () => {
    const adapter: StorageAdapter = new InMemoryStorageAdapter();
    const input = makeInput({ relativePath: 'file.txt' });
    const result = await adapter.putObject(input);
    expect(result.key).toBe('proj-1/sess-1/workspace/file.txt');
    expect(result.sha256).toBe(sha256Hex(input.body));

    const head = await adapter.headObject?.(input);
    expect(head).toBeDefined();
    expect(head?.etag).toBe(result.etag);

    const get = await adapter.getObject?.(input);
    expect(get).toBeDefined();
    expect(get?.body).toEqual(input.body);
  });

  it('is idempotent for repeated uploads of the same content', async () => {
    const adapter = new InMemoryStorageAdapter();
    const input = makeInput({ relativePath: 'file.txt' });

    const r1 = await adapter.putObject(input);
    const r2 = await adapter.putObject(input);

    expect(r1.key).toBe(r2.key);
    expect(r1.sha256).toBe(r2.sha256);
    expect(r1.etag).toBe(r2.etag);
    expect(adapter.listKeys()).toHaveLength(1);
  });

  it('tolerates concurrent duplicate PUTs of the same object', async () => {
    const adapter = new InMemoryStorageAdapter();
    const input = makeInput({ relativePath: 'file.txt' });

    const [r1, r2] = await Promise.all([adapter.putObject(input), adapter.putObject(input)]);

    expect(r1.key).toBe(r2.key);
    expect(r1.sha256).toBe(r2.sha256);
    expect(adapter.listKeys()).toHaveLength(1);
  });

  it('overwrites when content changes', async () => {
    const adapter = new InMemoryStorageAdapter();
    const input1 = makeInput({ relativePath: 'file.txt' });
    const input2 = makeInput({ relativePath: 'file.txt', body: textBody('changed') });

    const r1 = await adapter.putObject(input1);
    const r2 = await adapter.putObject(input2);

    expect(r1.key).toBe(r2.key);
    expect(r1.sha256).not.toBe(r2.sha256);
    expect(adapter.listKeys()).toHaveLength(1);

    const get = await adapter.getObject(input2);
    expect(get?.body).toEqual(input2.body);
  });
});

describe('mapS3Error', () => {
  it('returns a StorageError unchanged', () => {
    const original = new StorageError('SYNC_CONFIG_MISSING', 'msg', false);
    expect(mapS3Error(original)).toBe(original);
  });

  it('maps 404 to non-retryable SYNC_STORAGE_ERROR', () => {
    const err = mapS3Error(new AwsError('NoSuchBucket', 'no bucket', 404));
    expect(err.code).toBe('SYNC_STORAGE_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('(HTTP 404)');
  });
});

describe('S3StorageAdapter', () => {
  const baseConfig = makeS3Config();
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({ ETag: '"etag"', VersionId: 'v1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a bucket', () => {
    expect(() => new S3StorageAdapter({ type: 's3' })).toThrow(StorageError);
    try {
      new S3StorageAdapter({ type: 's3' });
    } catch (err) {
      expect((err as StorageError).code).toBe('SYNC_CONFIG_MISSING');
      expect((err as StorageError).retryable).toBe(false);
    }
  });

  it('sends a PutObjectCommand with a normalized key and sha256 metadata', async () => {
    const adapter = new S3StorageAdapter(baseConfig);
    const input = makeInput();
    const result = await adapter.putObject(input);

    expect(result.key).toBe('proj-1/sess-1/workspace/.claude/settings.json');
    expect(result.sha256).toBe(sha256Hex(input.body));

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const command = sendSpy.mock.calls[0][0] as PutObjectCommand;
    expect(command.input.Bucket).toBe('my-bucket');
    expect(command.input.Key).toBe('proj-1/sess-1/workspace/.claude/settings.json');
    expect(command.input.Body).toBe(input.body);
    expect(command.input.Metadata).toEqual({
      sha256: sha256Hex(input.body),
    });
  });

  it('sets ContentType when provided', async () => {
    const adapter = new S3StorageAdapter(baseConfig);
    await adapter.putObject(makeInput({ contentType: 'application/json' }));

    const command = sendSpy.mock.calls[0][0] as PutObjectCommand;
    expect(command.input.ContentType).toBe('application/json');
  });

  it('retries retryable 5xx errors and then succeeds', async () => {
    sendSpy
      .mockRejectedValueOnce(new AwsError('InternalError', 'internal', 500))
      .mockResolvedValueOnce({ ETag: '"etag"', VersionId: 'v1' });

    const adapter = new S3StorageAdapter(baseConfig, { retries: 2, baseDelayMs: 0, maxDelayMs: 0 });
    const result = await adapter.putObject(makeInput());

    expect(result.etag).toBe('"etag"');
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', async () => {
    sendSpy.mockRejectedValue(new AwsError('InternalError', 'internal', 500));

    const adapter = new S3StorageAdapter(baseConfig, { retries: 2, baseDelayMs: 0, maxDelayMs: 0 });
    await expect(adapter.putObject(makeInput())).rejects.toBeInstanceOf(StorageError);
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  it('maps 403 errors to SYNC_AUTH_FAILED and non-retryable', async () => {
    const err = new AwsError(
      'InvalidAccessKeyId',
      `The AWS Access Key Id ${TEST_ACCESS_KEY} ... ${TEST_SECRET_KEY}`,
      403,
    );
    sendSpy.mockRejectedValueOnce(err);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    try {
      await adapter.putObject(makeInput());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError);
      const se = e as StorageError;
      expect(se.code).toBe('SYNC_AUTH_FAILED');
      expect(se.retryable).toBe(false);
      expect(se.message).not.toContain(TEST_ACCESS_KEY);
      expect(se.message).not.toContain(TEST_SECRET_KEY);
      expect(String(se)).not.toContain(TEST_ACCESS_KEY);
      expect(String(se)).not.toContain(TEST_SECRET_KEY);
    }
  });

  it('maps 5xx errors to SYNC_STORAGE_ERROR and retryable', async () => {
    sendSpy.mockRejectedValueOnce(new AwsError('InternalError', 'internal', 500));

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    try {
      await adapter.putObject(makeInput());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError);
      const se = e as StorageError;
      expect(se.code).toBe('SYNC_STORAGE_ERROR');
      expect(se.retryable).toBe(true);
    }
  });

  it('maps network timeout errors to SYNC_NETWORK_TIMEOUT and retryable', async () => {
    sendSpy.mockRejectedValueOnce(new AwsError('TimeoutError', 'socket hang up'));

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    try {
      await adapter.putObject(makeInput());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError);
      const se = e as StorageError;
      expect(se.code).toBe('SYNC_NETWORK_TIMEOUT');
      expect(se.retryable).toBe(true);
    }
  });

  it('maps 429 errors to SYNC_STORAGE_ERROR and retryable', async () => {
    sendSpy.mockRejectedValueOnce(new AwsError('SlowDown', 'throttled', 429));

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    try {
      await adapter.putObject(makeInput());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError);
      const se = e as StorageError;
      expect(se.code).toBe('SYNC_STORAGE_ERROR');
      expect(se.retryable).toBe(true);
      expect(se.message).toContain('(HTTP 429)');
    }
  });

  it('maps unknown non-retryable errors to SYNC_STORAGE_ERROR and non-retryable', async () => {
    sendSpy.mockRejectedValueOnce(new Error('some unexpected failure'));

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    try {
      await adapter.putObject(makeInput());
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(StorageError);
      const se = e as StorageError;
      expect(se.code).toBe('SYNC_STORAGE_ERROR');
      expect(se.retryable).toBe(false);
    }
  });

  it('uses provided contentSha256 without recomputing', async () => {
    const providedSha = '0000000000000000000000000000000000000000000000000000000000000000';
    const adapter = new S3StorageAdapter(baseConfig);
    const result = await adapter.putObject(makeInput({ contentSha256: providedSha }));

    expect(result.sha256).toBe(providedSha);
    const command = sendSpy.mock.calls[0][0] as PutObjectCommand;
    expect(command.input.Metadata).toEqual({ sha256: providedSha });
  });

  it('rejects invalid object keys with a non-retryable StorageError', async () => {
    const adapter = new S3StorageAdapter(baseConfig);
    await expect(adapter.putObject(makeInput({ relativePath: '/etc/passwd' }))).rejects.toThrow(
      StorageError,
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('parseObjectKey', () => {
  it('parses a manifest key', () => {
    expect(parseObjectKey('p/s/manifest.json')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'manifest',
      relativePath: 'manifest.json',
    });
  });

  it('parses a session-scoped artifact key', () => {
    expect(parseObjectKey('p/s/session/transcript.jsonl')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'session',
      relativePath: 'transcript.jsonl',
    });
  });

  it('parses a workspace-scoped artifact key with nested path', () => {
    expect(parseObjectKey('p/s/workspace/.claude/settings.json')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'workspace',
      relativePath: '.claude/settings.json',
    });
  });

  it('parses a global-scoped artifact key', () => {
    expect(parseObjectKey('p/s/global/~/.claude/settings.json')).toEqual({
      projectId: 'p',
      sessionId: 's',
      scope: 'global',
      relativePath: '~/.claude/settings.json',
    });
  });

  it('decodes percent-encoded segments', () => {
    expect(parseObjectKey('my%20project/sess%3A1/session/file.json')).toEqual({
      projectId: 'my project',
      sessionId: 'sess:1',
      scope: 'session',
      relativePath: 'file.json',
    });
  });

  it('returns undefined for keys with too few segments', () => {
    expect(parseObjectKey('p')).toBeUndefined();
    expect(parseObjectKey('p/s')).toBeUndefined();
  });

  it('returns undefined for keys with an unknown scope', () => {
    expect(parseObjectKey('p/s/unknown/file.json')).toBeUndefined();
  });

  it('returns undefined for empty keys', () => {
    expect(parseObjectKey('')).toBeUndefined();
  });

  it('round-trips with buildObjectKey', () => {
    const inputs: Array<{
      projectId: string;
      sessionId: string;
      scope: StorageObjectScope;
      relativePath: string;
    }> = [
      { projectId: 'p', sessionId: 's', scope: 'manifest', relativePath: 'manifest.json' },
      { projectId: 'p', sessionId: 's', scope: 'session', relativePath: 'transcript.jsonl' },
      {
        projectId: 'p',
        sessionId: 's',
        scope: 'workspace',
        relativePath: '.claude/settings.json',
      },
      {
        projectId: 'my project',
        sessionId: 'sess:1',
        scope: 'global',
        relativePath: '~/.claude/agents/reviewer.md',
      },
    ];
    for (const input of inputs) {
      const key = buildObjectKey(input);
      const parsed = parseObjectKey(key);
      expect(parsed).toEqual(input);
    }
  });
});

describe('S3StorageAdapter getObject/headObject/listObjects', () => {
  const baseConfig = makeS3Config();
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(S3Client.prototype, 'send');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getObject returns body bytes and metadata', async () => {
    const bodyBytes = new TextEncoder().encode('hello');
    sendSpy.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => bodyBytes } as never,
      ContentType: 'application/json',
      ETag: '"etag"',
      LastModified: new Date('2026-01-01T00:00:00Z'),
      Metadata: { sha256: 'abc' },
    } as never);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.getObject?.(makeInput({ relativePath: 'file.json' }));

    expect(result).toBeDefined();
    expect(result?.body).toEqual(bodyBytes);
    expect(result?.contentType).toBe('application/json');
    expect(result?.etag).toBe('"etag"');
    expect(result?.metadata).toEqual({ sha256: 'abc' });

    const command = sendSpy.mock.calls[0][0] as GetObjectCommand;
    expect(command.input.Bucket).toBe('my-bucket');
    expect(command.input.Key).toBe('proj-1/sess-1/workspace/file.json');
  });

  it('getObject returns undefined for 404', async () => {
    sendSpy.mockRejectedValueOnce(new AwsError('NoSuchKey', 'not found', 404));

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.getObject?.(makeInput({ relativePath: 'missing.json' }));
    expect(result).toBeUndefined();
  });

  it('headObject returns metadata without body', async () => {
    sendSpy.mockResolvedValueOnce({
      ContentLength: 42,
      ContentType: 'application/json',
      ETag: '"etag"',
      LastModified: new Date('2026-01-01T00:00:00Z'),
      Metadata: { sha256: 'abc' },
    } as never);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.headObject?.(makeInput({ relativePath: 'file.json' }));

    expect(result).toBeDefined();
    expect(result?.contentLength).toBe(42);
    expect(result?.contentType).toBe('application/json');
    expect(result?.etag).toBe('"etag"');

    const command = sendSpy.mock.calls[0][0] as HeadObjectCommand;
    expect(command.input.Bucket).toBe('my-bucket');
    expect(command.input.Key).toBe('proj-1/sess-1/workspace/file.json');
  });

  it('headObject returns undefined for 404', async () => {
    sendSpy.mockRejectedValueOnce(new AwsError('NoSuchKey', 'not found', 404));

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.headObject?.(makeInput({ relativePath: 'missing.json' }));
    expect(result).toBeUndefined();
  });

  it('listObjects lists all objects under a project prefix', async () => {
    sendSpy.mockResolvedValueOnce({
      Contents: [
        { Key: 'proj-1/sess-a/manifest.json', Size: 100, LastModified: new Date('2026-01-01') },
        {
          Key: 'proj-1/sess-a/session/transcript.jsonl',
          Size: 200,
          LastModified: new Date('2026-01-02'),
        },
      ],
      IsTruncated: false,
    } as never);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.listObjects?.({ projectId: 'proj-1' });

    expect(result?.objects).toHaveLength(2);
    expect(result?.objects[0]?.key).toBe('proj-1/sess-a/manifest.json');
    expect(result?.objects[0]?.size).toBe(100);
    expect(result?.objects[1]?.key).toBe('proj-1/sess-a/session/transcript.jsonl');

    const command = sendSpy.mock.calls[0][0] as ListObjectsV2Command;
    expect(command.input.Bucket).toBe('my-bucket');
    expect(command.input.Prefix).toBe('proj-1/');
  });

  it('listObjects paginates with continuation tokens', async () => {
    sendSpy
      .mockResolvedValueOnce({
        Contents: [{ Key: 'proj-1/sess-a/manifest.json', Size: 100 }],
        IsTruncated: true,
        NextContinuationToken: 'token-1',
      } as never)
      .mockResolvedValueOnce({
        Contents: [{ Key: 'proj-1/sess-b/manifest.json', Size: 200 }],
        IsTruncated: false,
      } as never);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.listObjects?.({ projectId: 'proj-1' });

    expect(result?.objects).toHaveLength(2);
    expect(sendSpy).toHaveBeenCalledTimes(2);

    const secondCommand = sendSpy.mock.calls[1][0] as ListObjectsV2Command;
    expect(secondCommand.input.ContinuationToken).toBe('token-1');
  });

  it('listObjects scopes to a session when sessionId is provided', async () => {
    sendSpy.mockResolvedValueOnce({
      Contents: [{ Key: 'proj-1/sess-a/manifest.json', Size: 100 }],
      IsTruncated: false,
    } as never);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    await adapter.listObjects?.({ projectId: 'proj-1', sessionId: 'sess-a' });

    const command = sendSpy.mock.calls[0][0] as ListObjectsV2Command;
    expect(command.input.Prefix).toBe('proj-1/sess-a/');
  });

  it('listObjects returns empty when no objects exist', async () => {
    sendSpy.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false } as never);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.listObjects?.({ projectId: 'proj-1' });
    expect(result?.objects).toEqual([]);
  });

  it('listObjects decodes percent-encoded keys', async () => {
    sendSpy.mockResolvedValueOnce({
      Contents: [{ Key: 'my%20project/sess-a/session/file.json', Size: 100 }],
      IsTruncated: false,
    } as never);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.listObjects?.({ projectId: 'my project' });
    expect(result?.objects[0]?.key).toBe('my project/sess-a/session/file.json');
  });

  it('listObjects lists all objects when projectId is omitted', async () => {
    sendSpy.mockResolvedValueOnce({
      Contents: [
        { Key: 'proj-1/sess-a/manifest.json', Size: 100 },
        { Key: 'proj-2/sess-b/session/transcript.jsonl', Size: 200 },
      ],
      IsTruncated: false,
    } as never);

    const adapter = new S3StorageAdapter(baseConfig, { retries: 0 });
    const result = await adapter.listObjects?.({});

    expect(result?.objects).toHaveLength(2);

    const command = sendSpy.mock.calls[0][0] as ListObjectsV2Command;
    expect(command.input.Prefix).toBe('');
  });
});
