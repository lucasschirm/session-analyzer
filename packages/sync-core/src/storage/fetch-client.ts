import { AwsClient } from 'aws4fetch';
import { CAS_NAMESPACE_ROOT, encodeKeySegment } from './object-key.js';

const CONTROL_PLANE_TIMEOUT_MS = 20_000;
const STALL_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 1_000;
const MAX_RETRIES = 1;
const DEFAULT_MAX_LIST_KEYS = 1_000;
const DEFAULT_PUT_CONTENT_TYPE = 'application/json';

/**
 * The source of an {@link S3Error}.
 *
 * `s3` is a parsed S3 service error. `network` is a low-level network
 * failure, `cors` is a browser CORS block (or the indistinguishable
 * `TypeError: Failed to fetch` fetch failure), and `stall` is a transcript
 * download that made no progress for the configured stall window.
 */
export type S3ErrorKind = 's3' | 'network' | 'cors' | 'stall';

/** Initialization fields for an {@link S3Error}. */
export interface S3ErrorInit {
  /** HTTP status code; 0 for network, CORS, and stall errors. */
  status: number;
  /** S3 error code, or a machine-readable network/stall code. */
  code: string;
  /** Human-readable error description. */
  message: string;
  /** The source of the error. */
  kind: S3ErrorKind;
}

/**
 * A typed S3 error produced by the fetch client.
 *
 * The `kind` field lets callers surface CORS hints and decide whether a
 * transcript download stalled rather than treating every failure the same.
 */
export class S3Error extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly kind: S3ErrorKind;

  constructor(init: S3ErrorInit) {
    super(init.message);
    this.name = 'S3Error';
    this.status = init.status;
    this.code = init.code;
    this.kind = init.kind;
  }
}

/**
 * Configuration for {@link S3FetchClient}.
 *
 * When `endpoint` is omitted the client uses virtual-hosted URLs such as
 * `https://<bucket>.s3.<region>.amazonaws.com`. When `endpoint` is provided
 * it uses path-style URLs such as `<endpoint>/<bucket>/<key>`.
 */
export interface S3ClientConfig {
  /** AWS access key ID. */
  accessKeyId: string;
  /** AWS secret access key. */
  secretAccessKey: string;
  /** Optional AWS session token for temporary credentials. */
  sessionToken?: string;
  /** AWS region, e.g. `us-east-1`. */
  region: string;
  /** S3 bucket name. */
  bucket: string;
  /** Optional S3-compatible endpoint; enables path-style URLs. */
  endpoint?: string;
  /** Optional control plane timeout in milliseconds; defaults to 20 seconds. */
  controlPlaneTimeoutMs?: number;
  /** Optional retry/backoff delay in milliseconds; defaults to 1 second. */
  retryBackoffMs?: number;
}

/** A single page of folder prefixes returned by a listing operation. */
export interface S3ListPage {
  /** Folder prefixes on this page, with trailing slashes and encoding removed. */
  prefixes: string[];
  /** Continuation token for the next page, if the listing is truncated. */
  continuationToken?: string;
}

/** Options for paginated listing operations. */
export interface S3ListOptions {
  /** Callback invoked for each page as it arrives, enabling pipeline. */
  onPage?: (page: S3ListPage) => void | Promise<void>;
  /** Maximum number of keys S3 should return per page. */
  maxKeys?: number;
  /** Optional abort signal for cancelling in-flight listing requests. */
  signal?: AbortSignal;
}

/** Options for {@link S3FetchClient.getObject}. */
export interface S3GetObjectOptions {
  /**
   * When `true`, the body is consumed via a streaming reader with a stall
   * watchdog and no fixed total timeout. Use this for large transcript files.
   */
  streaming?: boolean;
  /** Called with the cumulative number of bytes received so far. */
  onProgress?: (bytesReceived: number) => void;
  /** Stall window for streaming downloads; defaults to 15 seconds. */
  stallTimeoutMs?: number;
  /** Optional abort signal for cancelling in-flight download requests. */
  signal?: AbortSignal;
}

/** Options for {@link S3FetchClient.putObject}. */
export interface S3PutObjectOptions {
  /** Content-Type header; defaults to `application/json`. */
  contentType?: string;
}

/** Result of a successful {@link S3FetchClient.putObject} call. */
export interface S3PutObjectResult {
  /** ETag header returned by S3, if present. */
  etag?: string;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function folderNameFromPrefix(prefix: string): string {
  const decoded = safeDecode(prefix).replace(/\/$/, '');
  const parts = decoded.split('/');
  return parts[parts.length - 1] ?? '';
}

function isReservedFolder(prefix: string): boolean {
  const decoded = safeDecode(prefix).replace(/\/$/, '');
  return decoded === CAS_NAMESPACE_ROOT || decoded.startsWith(`${CAS_NAMESPACE_ROOT}/`);
}

function parseS3ErrorXml(xml: string, status: number): { code: string; message: string } {
  const code = xml.match(/<Code>([^<]*)<\/Code>/)?.[1]?.trim();
  const message = xml.match(/<Message>([^<]*)<\/Message>/)?.[1]?.trim();
  return {
    code: code ?? 'UnknownError',
    message: message ?? `S3 returned HTTP ${status}`,
  };
}

async function s3ErrorFromResponse(response: Response): Promise<S3Error> {
  const text = await response.text();
  const { code, message } = parseS3ErrorXml(text, response.status);
  return new S3Error({ status: response.status, code, message, kind: 's3' });
}

function buildVirtualHostedBaseUrl(config: S3ClientConfig): URL {
  return new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com/`);
}

function buildPathStyleBaseUrl(config: S3ClientConfig): URL {
  const url = new URL(config.endpoint ?? 'http://localhost');
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  url.pathname += `${config.bucket}/`;
  return url;
}

function buildBaseUrl(config: S3ClientConfig): URL {
  if (config.endpoint) return buildPathStyleBaseUrl(config);
  return buildVirtualHostedBaseUrl(config);
}

function buildListUrl(
  baseUrl: URL,
  prefix: string,
  continuationToken: string | undefined,
  maxKeys: number,
): string {
  const url = new URL('', baseUrl);
  const params = new URLSearchParams();
  params.set('list-type', '2');
  params.set('delimiter', '/');
  params.set('max-keys', String(maxKeys));
  if (continuationToken) params.set('continuation-token', continuationToken);
  let query = params.toString();
  // `prefix` is already percent-encoded by callers. URLSearchParams would
  // re-encode it (e.g. `%20` -> `%2520`), so append it directly to the query
  // string to guarantee identical encoding to the path-based object URL.
  if (prefix) query = query ? `${query}&prefix=${prefix}` : `prefix=${prefix}`;
  url.search = query;
  return url.toString();
}

function parseListObjectsV2Xml(xml: string): S3ListPage {
  const prefixes: string[] = [];
  const matches = xml.matchAll(
    /<CommonPrefixes>[\s\S]*?<Prefix>([^<]*)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g,
  );
  for (const match of matches) {
    const prefix = match[1];
    if (prefix !== undefined) prefixes.push(prefix);
  }
  const isTruncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
  return {
    prefixes,
    continuationToken: isTruncated ? tokenMatch?.[1] : undefined,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asS3Error(error: unknown): S3Error | undefined {
  if (error instanceof S3Error) return error;
  return undefined;
}

function networkError(code: string, message: string, kind: S3ErrorKind): S3Error {
  return new S3Error({ status: 0, code, message, kind });
}

function mapNetworkError(error: unknown): S3Error {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return networkError('NetworkTimeout', error.message, 'network');
  }
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    const isCors = message.includes('cors') || message.includes('failed to fetch');
    return networkError(
      isCors ? 'CORSBlocked' : 'NetworkFailure',
      error.message,
      isCors ? 'cors' : 'network',
    );
  }
  if (error instanceof Error) {
    return networkError('NetworkFailure', error.message, 'network');
  }
  return networkError('NetworkFailure', String(error), 'network');
}

function mapStreamError(error: unknown): S3Error {
  const s3Error = asS3Error(error);
  if (s3Error) return s3Error;
  return mapNetworkError(error);
}

function concatenateUint8Arrays(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

class StallWatchdog {
  private timeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly stallTimeoutMs: number) {}

  start(): Promise<never> {
    return new Promise((_, reject) => {
      this.timeoutId = setTimeout(() => {
        reject(
          new S3Error({
            status: 0,
            code: 'StallTimeout',
            message: `No chunk received for ${this.stallTimeoutMs}ms`,
            kind: 'stall',
          }),
        );
      }, this.stallTimeoutMs);
    });
  }

  clear(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }
}

function recordChunk(
  chunks: Uint8Array[],
  value: Uint8Array,
  onProgress: ((bytes: number) => void) | undefined,
  received: number,
): number {
  chunks.push(value);
  received += value.length;
  onProgress?.(received);
  return received;
}

async function pumpChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  watchdog: StallWatchdog,
  onProgress: ((bytes: number) => void) | undefined,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await Promise.race([reader.read(), watchdog.start()]);
    watchdog.clear();
    if (value) received = recordChunk(chunks, value, onProgress, received);
    if (done) break;
  }
  return chunks;
}

async function readBodyWithStallWatchdog(
  body: ReadableStream<Uint8Array>,
  onProgress: ((bytes: number) => void) | undefined,
  stallTimeoutMs: number,
): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const watchdog = new StallWatchdog(stallTimeoutMs);
  try {
    const chunks = await pumpChunks(reader, watchdog, onProgress);
    return concatenateUint8Arrays(chunks);
  } catch (error) {
    throw mapStreamError(error);
  } finally {
    watchdog.clear();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Isomorphic S3 client built on `aws4fetch`.
 *
 * The client handles URL construction, query encoding, response parsing,
 * pagination, retry, split timeouts, and typed error mapping. It is
 * deliberately layout-agnostic: object keys are always supplied by callers,
 * typically via {@link buildObjectKey}.
 */
export class S3FetchClient {
  private readonly awsClient: AwsClient;
  private readonly baseUrl: URL;
  private readonly controlPlaneTimeoutMs: number;
  private readonly retryBackoffMs: number;

  constructor(config: S3ClientConfig) {
    this.baseUrl = buildBaseUrl(config);
    this.controlPlaneTimeoutMs = config.controlPlaneTimeoutMs ?? CONTROL_PLANE_TIMEOUT_MS;
    this.retryBackoffMs = config.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.awsClient = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      region: config.region,
      service: 's3',
      retries: 0,
    });
  }

  /** Send `HeadBucket` to verify bucket connectivity. */
  async headBucket(): Promise<void> {
    await this.withRetry(() => this.headBucketOnce());
  }

  /**
   * List project folders at the bucket root.
   *
   * The reserved `global/` CAS namespace is excluded from the results.
   * Pagination is automatic; use `onPage` to process each page as it arrives.
   */
  async listProjectFolders(options: S3ListOptions = {}): Promise<string[]> {
    return this.listPrefixes('', options, true);
  }

  /**
   * List session folders under a project.
   *
   * `projectId` is encoded using the same scheme as {@link encodeKeySegment}.
   */
  async listSessionFolders(projectId: string, options: S3ListOptions = {}): Promise<string[]> {
    return this.listPrefixes(`${encodeKeySegment(projectId)}/`, options, false);
  }

  /**
   * Download an object by key.
   *
   * Keys are caller-supplied and are not re-encoded. For large transcript
   * files, pass `{ streaming: true }` to enable the stall watchdog.
   */
  async getObject(key: string, options: S3GetObjectOptions = {}): Promise<ArrayBuffer> {
    if (options.streaming) return this.getObjectStreaming(key, options);
    return this.getObjectControlPlane(key, options);
  }

  /**
   * Upload an object by key.
   *
   * The default content type is `application/json` for manifest writes.
   */
  async putObject(
    key: string,
    body: ArrayBuffer | Uint8Array,
    options: S3PutObjectOptions = {},
  ): Promise<S3PutObjectResult> {
    const url = this.objectUrl(key).toString();
    const bodyBytes = new Uint8Array(body);
    const headers = new Headers();
    headers.set('Content-Type', options.contentType ?? DEFAULT_PUT_CONTENT_TYPE);
    const response = await this.withControlPlane((signal) =>
      this.signedFetch(url, { method: 'PUT', headers, body: bodyBytes }, signal),
    );
    await this.expectOk(response);
    return { etag: response.headers.get('ETag') ?? undefined };
  }

  private objectUrl(key: string): URL {
    return new URL(key, this.baseUrl);
  }

  private async signedFetch(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.awsClient.fetch(url, { ...init, signal });
    } catch (error) {
      throw mapNetworkError(error);
    }
  }

  private async expectOk(response: Response): Promise<Response> {
    if (response.ok) return response;
    throw await s3ErrorFromResponse(response);
  }

  private async withControlPlane<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const externalAborted = externalSignal?.aborted;
    if (externalAborted) {
      controller.abort();
    } else {
      timeoutId = setTimeout(() => controller.abort(), this.controlPlaneTimeoutMs);
    }
    const onExternalAbort = () => controller.abort();
    if (externalSignal && !externalAborted) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      return await operation(controller.signal);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal && !externalAborted) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        const s3Error = asS3Error(error);
        if (s3Error && s3Error.status >= 500 && s3Error.status < 600 && attempt < MAX_RETRIES) {
          attempt++;
          await delay(this.retryBackoffMs);
          continue;
        }
        throw error;
      }
    }
  }

  private async headBucketOnce(): Promise<void> {
    const response = await this.withControlPlane((signal) =>
      this.signedFetch(this.baseUrl.toString(), { method: 'HEAD' }, signal),
    );
    await this.expectOk(response);
  }

  private async listPrefixes(
    prefix: string,
    options: S3ListOptions,
    excludeReserved: boolean,
  ): Promise<string[]> {
    const all: string[] = [];
    let continuationToken: string | undefined;
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_LIST_KEYS;
    const signal = options.signal;
    do {
      const page = await this.withRetry(() =>
        this.listPage(prefix, continuationToken, maxKeys, signal),
      );
      const prefixes = excludeReserved
        ? page.prefixes.filter((p) => !isReservedFolder(p))
        : page.prefixes;
      const pageFolders = prefixes.map(folderNameFromPrefix);
      if (options.onPage)
        await options.onPage({ prefixes: pageFolders, continuationToken: page.continuationToken });
      all.push(...pageFolders);
      continuationToken = page.continuationToken;
    } while (continuationToken);
    return all;
  }

  private async listPage(
    prefix: string,
    continuationToken: string | undefined,
    maxKeys: number,
    signal?: AbortSignal,
  ): Promise<S3ListPage> {
    const url = buildListUrl(this.baseUrl, prefix, continuationToken, maxKeys);
    const response = await this.withControlPlane(
      (s) => this.signedFetch(url, { method: 'GET' }, s),
      signal,
    );
    await this.expectOk(response);
    const xml = await response.text();
    return parseListObjectsV2Xml(xml);
  }

  private async getObjectControlPlane(
    key: string,
    options: S3GetObjectOptions = {},
  ): Promise<ArrayBuffer> {
    const url = this.objectUrl(key).toString();
    const response = await this.withRetry(async () => {
      const fetched = await this.withControlPlane(
        (signal) => this.signedFetch(url, { method: 'GET' }, signal),
        options.signal,
      );
      return this.expectOk(fetched);
    });
    return response.arrayBuffer();
  }

  private async getObjectStreaming(key: string, options: S3GetObjectOptions): Promise<ArrayBuffer> {
    let attempt = 0;
    while (true) {
      try {
        return await this.streamObjectOnce(key, options);
      } catch (error) {
        const s3Error = asS3Error(error);
        const canRetry =
          s3Error && (s3Error.kind === 'stall' || (s3Error.status >= 500 && s3Error.status < 600));
        if (!canRetry || attempt >= MAX_RETRIES) throw error;
        attempt++;
        await delay(this.retryBackoffMs);
      }
    }
  }

  private async streamObjectOnce(key: string, options: S3GetObjectOptions): Promise<ArrayBuffer> {
    const url = this.objectUrl(key).toString();
    const response = await this.withControlPlane(
      (signal) => this.signedFetch(url, { method: 'GET' }, signal),
      options.signal,
    );
    await this.expectOk(response);
    const body = response.body;
    if (!body) return response.arrayBuffer();
    const stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    return readBodyWithStallWatchdog(body, options.onProgress, stallTimeoutMs);
  }
}
