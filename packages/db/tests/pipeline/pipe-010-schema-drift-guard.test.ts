import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, type Migration, MigrationRunner } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getSqlite3,
  WasmSqliteExecutor,
} from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { ContentHasher } from '../../src/ports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

beforeAll(async () => {
  await getSqlite3();
});

async function createMigratedExecutor(
  migrations: readonly Migration[],
): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  const runner = new MigrationRunner(executor, migrations);
  await runner.migrate();
  return executor;
}

function makeDriftedMigrations(): readonly Migration[] {
  const maxId = Math.max(...MIGRATIONS.map((m) => m.id));
  const rename: Migration = {
    id: maxId + 1,
    name: 'drift-rename-sessions-project-id',
    sql: 'ALTER TABLE sessions RENAME COLUMN project_id TO project_ref;',
    checksum: 'drift-checksum',
  };
  return [...MIGRATIONS, rename];
}

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function setupIngestion(executor: WasmSqliteExecutor) {
  const hasher = createSha256ContentHasher();
  const orchestrator = new DefaultIngestionOrchestrator({
    executor,
    hasher,
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-schema-drift',
  });
  return { orchestrator, hasher };
}

async function ingestFixture(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ContentHasher,
  fixtureName: string,
  projectId: string,
  sessionId: string,
) {
  const content = readFixture(fixtureName);
  const sha256 = await hasher.hash(content);
  return orchestrator.ingestManual({
    artifacts: [
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        sha256,
        size: content.length,
        content,
        status: 'uploaded' as const,
      },
    ],
    source: { sourceId: 'default' },
    harness: 'claude-code',
    projectId,
    sessionId,
  });
}

describe('PIPE-010: schema drift guard', () => {
  it('commits an archived fixture on the current unmodified schema', async () => {
    const executor = await createMigratedExecutor(MIGRATIONS);
    const { orchestrator, hasher } = setupIngestion(executor);
    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      'project-drift-happy',
      'sess-drift-happy',
    );
    expect(receipt.status).toBe('committed');
    await executor.close();
  });

  it('fails explicitly when a bumped migration renames a column the fixture expects', async () => {
    const executor = await createMigratedExecutor(makeDriftedMigrations());
    const { orchestrator, hasher } = setupIngestion(executor);
    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      'project-drift-bad',
      'sess-drift-bad',
    );

    expect(
      receipt.status,
      'ingestion should fail after sessions.project_id is renamed to project_ref',
    ).toBe('failed');
    expect(receipt.issueIds).toContain('atomic_commit_failed');

    const { rows } = await executor.exec('PRAGMA table_info(sessions)');
    const columns = rows.map((r) => String(r.name));
    expect(
      columns,
      'drifted schema should rename sessions.project_id to project_ref',
    ).not.toContain('project_id');
    expect(columns).toContain('project_ref');

    await executor.close();
  });
});
