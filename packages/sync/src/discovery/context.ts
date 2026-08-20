import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactScope } from '../artifact.js';
import { DEFAULT_SYNC_LIMITS, type SyncLimits } from '../limits.js';
import type { DiscoveryArtifact, DiscoveryError, DiscoveryResult } from './contract.js';
import { validatePath } from './paths.js';

export type AddFileResult = 'added' | 'skipped' | 'stopped';

export class DiscoveryContext {
  artifacts: DiscoveryArtifact[] = [];
  errors: DiscoveryError[] = [];
  totalBytes = 0;
  stopped = false;

  constructor(readonly limits: SyncLimits = DEFAULT_SYNC_LIMITS) {}

  toResult(): DiscoveryResult {
    return {
      artifacts: this.artifacts,
      errors: this.errors,
      totalBytes: this.totalBytes,
      filesDiscovered: this.artifacts.length,
    };
  }

  addError(error: DiscoveryError): void {
    this.errors.push(error);
  }

  stop(code: 'SYNC_TOTAL_SIZE_EXCEEDED' | 'SYNC_FILE_COUNT_EXCEEDED', message: string): void {
    this.stopped = true;
    this.addError({ code, message });
  }

  async addFile(
    absolutePath: string,
    root: string,
    scope: ArtifactScope,
    projectId: string,
    sessionId: string,
    storageRelativePath?: string,
  ): Promise<AddFileResult> {
    if (this.stopped) {
      return 'stopped';
    }

    const resolvedPath = path.resolve(absolutePath);

    const validated = await validatePath(resolvedPath, root);
    if (validated.error) {
      this.addError(validated.error);
      return 'skipped';
    }
    if (validated.stat === undefined) {
      return 'skipped';
    }
    if (!validated.stat.isFile()) {
      return 'skipped';
    }

    const size = validated.stat.size;
    const relativePath =
      storageRelativePath ?? validated.relativePath ?? path.relative(root, resolvedPath);
    const maxFileBytes =
      scope === 'session' ? this.limits.maxTranscriptBytes : this.limits.maxFileBytes;

    if (size > maxFileBytes) {
      this.addError({
        code: 'SYNC_FILE_TOO_LARGE',
        path: resolvedPath,
        message: `File size ${size} exceeds the ${scope === 'session' ? 'transcript' : 'file'} limit of ${maxFileBytes} bytes`,
      });
      return 'skipped';
    }

    if (this.artifacts.length >= this.limits.maxFiles) {
      this.stop(
        'SYNC_FILE_COUNT_EXCEEDED',
        `File count would exceed the limit of ${this.limits.maxFiles}`,
      );
      return 'stopped';
    }

    if (this.totalBytes + size > this.limits.maxTotalBytes) {
      this.stop(
        'SYNC_TOTAL_SIZE_EXCEEDED',
        `Total capture size would exceed the limit of ${this.limits.maxTotalBytes} bytes`,
      );
      return 'stopped';
    }

    let content: Buffer;
    try {
      content = await fsp.readFile(resolvedPath);
    } catch (err) {
      this.addError({
        code: 'SYNC_DISCOVERY_ERROR',
        path: resolvedPath,
        message: `Failed to read file: ${(err as Error).message}`,
      });
      return 'skipped';
    }

    if (!this.validateContent(resolvedPath, content, scope)) {
      return 'skipped';
    }

    const sha256 = createHash('sha256').update(content).digest('hex');

    this.artifacts.push({
      projectId,
      sessionId,
      scope,
      relativePath,
      sha256,
      size,
      absolutePath: resolvedPath,
    });

    this.totalBytes += size;
    return 'added';
  }

  private validateContent(absolutePath: string, content: Buffer, scope: ArtifactScope): boolean {
    const name = path.basename(absolutePath).toLowerCase();

    if (scope === 'session' || name.endsWith('.jsonl')) {
      return this.validateJsonl(absolutePath, content);
    }

    if (name.endsWith('.json')) {
      return this.validateJson(absolutePath, content);
    }

    return true;
  }

  private validateJson(absolutePath: string, content: Buffer): boolean {
    const text = content.toString('utf8');
    if (text.length === 0) {
      return true;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      this.addError({
        code: 'SYNC_JSON_PARSE_FAILED',
        path: absolutePath,
        message: `Failed to parse JSON: ${(err as Error).message}`,
      });
      return false;
    }

    try {
      this.checkDepth(parsed, 0);
    } catch {
      this.addError({
        code: 'SYNC_JSON_PARSE_FAILED',
        path: absolutePath,
        message: `JSON depth exceeds the limit of ${this.limits.maxJsonDepth}`,
      });
      return false;
    }

    return true;
  }

  private checkDepth(value: unknown, depth: number): void {
    if (depth > this.limits.maxJsonDepth) {
      throw new Error('Maximum JSON depth exceeded');
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        this.checkDepth(item, depth + 1);
      }
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        this.checkDepth((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  }

  private validateJsonl(absolutePath: string, content: Buffer): boolean {
    const text = content.toString('utf8');
    const lines = text.split('\n');

    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (lineBytes > this.limits.maxJsonlLineBytes) {
        this.addError({
          code: 'SYNC_JSON_PARSE_FAILED',
          path: absolutePath,
          message: `JSONL line exceeds the limit of ${this.limits.maxJsonlLineBytes} bytes`,
        });
        return false;
      }
    }

    return true;
  }
}
