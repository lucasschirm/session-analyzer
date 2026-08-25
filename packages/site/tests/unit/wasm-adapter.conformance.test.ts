// @vitest-environment node
/**
 * Conformance tests for the site-owned SQLite WASM executor adapter.
 *
 * Runs the shared db-core adapter conformance suite against the in-memory WASM
 * backend and asserts OPFS-to-memory fallback reporting in Node (OPFS is
 * unavailable in this environment).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { runAdapterConformanceSuite } from '../../../db-core/tests/conformance/suite';
import { WasmSqliteExecutor } from '../../src/db/wasm-sqlite-executor';

const executor = await WasmSqliteExecutor.create({ preferOpfs: false });

describe('WasmSqliteExecutor', () => {
  afterAll(async () => {
    await executor.close();
  });

  runAdapterConformanceSuite(executor, { label: 'WASM in-memory' });

  it('reports wasm-memory backend and ephemeral durability in Node', () => {
    expect(executor.backend.backendName).toBe('wasm-memory');
    expect(executor.backend.durability).toBe('ephemeral');
    expect(executor.backend.supports.durable).toBe(false);
    expect(executor.fallbackReason).toBeUndefined();
    expect(executor.backend.journalMode).toBe('memory');
    expect(executor.backend.supports.wal).toBe(false);
  });

  it('falls back to in-memory and reports the fallback explicitly when OPFS is unavailable', async () => {
    const fallback = await WasmSqliteExecutor.create();
    try {
      expect(fallback.backend.backendName).toBe('wasm-memory');
      expect(fallback.backend.durability).toBe('ephemeral');
      expect(fallback.backend.supports.durable).toBe(false);
      expect(fallback.fallbackReason).toBe('unsupported');
      expect(fallback.backend.journalMode).toBe('memory');
      expect(fallback.backend.supports.wal).toBe(false);
    } finally {
      await fallback.close();
    }
  });
});
