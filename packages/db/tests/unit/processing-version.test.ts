import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  ANALYTICS_PROCESSING_METADATA_KEY,
  ANALYTICS_PROCESSING_VERSION,
  getStoredProcessingVersion,
  needsRebuild,
  rebuildAnalyticsDerivedData,
  setStoredProcessingVersion,
} from '../../src/processing-version.js';

describe('processing-version', () => {
  let executor: WasmSqliteExecutor;

  beforeEach(async () => {
    executor = await WasmSqliteExecutor.create();
    await executor.exec(FRESH_SCHEMA_SQL);
  });

  it('reports version 0 and needsRebuild true for an uninitialized database', async () => {
    const version = await getStoredProcessingVersion(executor);
    expect(version).toBe(0);

    const rebuild = await needsRebuild(executor);
    expect(rebuild).toBe(true);
  });

  it('updates and persists the stored processing version', async () => {
    await setStoredProcessingVersion(executor, 1);
    expect(await getStoredProcessingVersion(executor)).toBe(1);
    expect(await needsRebuild(executor)).toBe(true);

    // Update existing row
    await setStoredProcessingVersion(executor, ANALYTICS_PROCESSING_VERSION);
    expect(await getStoredProcessingVersion(executor)).toBe(ANALYTICS_PROCESSING_VERSION);
    expect(await needsRebuild(executor)).toBe(false);
  });

  it('rebuilds derived data and sets the current version when sessions table is empty', async () => {
    const progressSpy = vi.fn();
    expect(await needsRebuild(executor)).toBe(true);

    await rebuildAnalyticsDerivedData(executor, progressSpy);

    expect(await getStoredProcessingVersion(executor)).toBe(ANALYTICS_PROCESSING_VERSION);
    expect(await needsRebuild(executor)).toBe(false);
    expect(progressSpy).not.toHaveBeenCalled();
  });
});
