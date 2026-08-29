import type {
  AdapterBackend,
  SqliteExecResult,
  SqliteExecutionOptions,
  SqliteExecutor,
  SqliteStatement,
  SqliteTransaction,
  SqliteValue,
} from '@lucasschirm/sal-db-core';

/**
 * Named pipeline stage at which the harness can throw.
 *
 * - `pre-commit`: before the first statement of the atomic commit transaction.
 * - `mid-commit`: after the root session row is written but before the commit.
 * - `mid-rollup`: after the first rollup contribution is written.
 * - `post-ingest`: after the session is committed but before rollup materialisation.
 * - `reprocess`: after the replacement generation is committed during reprocessing,
 *   before the rollup materialisation for the new generation is applied.
 * - `query`: on the first query executed outside a transaction.
 */
export type InjectionStage =
  | 'pre-commit'
  | 'mid-commit'
  | 'mid-rollup'
  | 'post-ingest'
  | 'reprocess'
  | 'query';

export interface FailureInjectionCallLogEntry {
  readonly callIndex: number;
  readonly inTransaction: boolean;
  readonly transactionExecCount: number;
  readonly firstParam: SqliteValue;
  readonly secondParam: SqliteValue;
  readonly paramCount: number;
  readonly changes: number;
  readonly lastInsertRowId: string;
  readonly columns: readonly string[];
  readonly rowCount: number;
}

export class InjectionError extends Error {
  readonly stage: InjectionStage;

  constructor(stage: InjectionStage) {
    super(`Injected pipeline failure at stage: ${stage}`);
    this.name = 'InjectionError';
    this.stage = stage;
  }
}

function isStringStartingWith(value: SqliteValue | undefined, prefix: string): boolean {
  return typeof value === 'string' && value.startsWith(prefix);
}

function hasAllColumns(
  row: Record<string, SqliteValue> | undefined,
  names: readonly string[],
): boolean {
  if (!row) return false;
  const keys = Object.keys(row);
  return names.every((name) => keys.includes(name));
}

/**
 * Test-only executor wrapper that can throw at a named point in the pipeline.
 *
 * It wraps the real in-memory SQLite executor (e.g. `WasmSqliteExecutor`) and
 * reuses its SQL runtime. It does not emit SQL of its own. When an in-transaction
 * stage is configured, the harness uses an auto-commit transaction so the
 * injected failure leaves the partial writes in place, which is what the
 * failure-injection tests need to assert recoverability.
 */
export class FailureInjectionExecutor implements SqliteExecutor {
  readonly backend: AdapterBackend;

  private readonly inner: SqliteExecutor;
  private injectionStage: InjectionStage | undefined;

  private callLog: FailureInjectionCallLogEntry[] = [];
  private callIndex = 0;
  private thrown = false;
  private thrownCallIndex = -1;
  private thrownStage: InjectionStage | undefined;

  private transactionCounter = 0;
  private transactionDepth = 0;
  private hasTransactionAttempted = false;
  private transactionExecCount = 0;

  private generationId: string | undefined;
  private sessionId: string | undefined;
  private beginGenerationSeen = false;
  private rootSessionInserted = false;
  private committed = false;
  private rollupReadSeen = false;
  private firstRuInsertSeen = false;

  constructor(inner: SqliteExecutor) {
    this.inner = inner;
    this.backend = inner.backend;
  }

  /**
   * Configure the next pipeline run to fail at `stage`. Use `undefined` for a
   * normal, non-injected run.
   */
  setInjection(stage: InjectionStage | undefined): void {
    this.injectionStage = stage;
    this.resetRunState();
  }

  getInjectionStage(): InjectionStage | undefined {
    return this.injectionStage;
  }

  getCallLog(): readonly FailureInjectionCallLogEntry[] {
    return this.callLog;
  }

  clearCallLog(): void {
    this.callLog = [];
  }

  getThrownCallIndex(): number {
    return this.thrownCallIndex;
  }

  getThrownStage(): InjectionStage | undefined {
    return this.thrownStage;
  }

  exec(
    sql: string,
    params?: readonly SqliteValue[],
    options?: SqliteExecutionOptions,
  ): SqliteExecResult {
    return this.runExec(sql, params, options, false);
  }

  transaction<T>(
    callback: (tx: SqliteTransaction) => unknown,
    _options?: SqliteExecutionOptions,
  ): Promise<T> {
    this.hasTransactionAttempted = true;

    if (!this.isTransactionInjectionStage()) {
      return this.inner.transaction(callback, _options) as Promise<T>;
    }

    const id = ++this.transactionCounter;
    this.transactionDepth++;
    this.transactionExecCount = 0;
    const tx = new FailureInjectionTransaction(this, id);

    try {
      const result = callback(tx);
      if (result && typeof result === 'object' && 'then' in result) {
        return (result as Promise<T>).then(
          (value) => {
            this.transactionDepth--;
            return value;
          },
          (error) => {
            this.transactionDepth--;
            throw error;
          },
        );
      }
      this.transactionDepth--;
      return Promise.resolve(result as T);
    } catch (error) {
      this.transactionDepth--;
      return Promise.reject(error);
    }
  }

  prepare(sql: string): SqliteStatement {
    return this.inner.prepare(sql);
  }

  close(): Promise<void> {
    return Promise.resolve(this.inner.close());
  }

  isBusy(): boolean {
    return this.inner.isBusy();
  }

  isClosed(): boolean {
    return this.inner.isClosed();
  }

  execInTransaction(
    sql: string,
    params?: readonly SqliteValue[],
    options?: SqliteExecutionOptions,
  ): SqliteExecResult {
    return this.runExec(sql, params, options, true);
  }

  private runExec(
    sql: string,
    params: readonly SqliteValue[] | undefined,
    options: SqliteExecutionOptions | undefined,
    inTransaction: boolean,
  ): SqliteExecResult {
    this.callIndex++;
    if (inTransaction) {
      this.transactionExecCount++;
    }

    if (this.shouldThrowBefore(sql, params, inTransaction)) {
      this.throwAt(inTransaction);
    }

    const result = this.inner.exec(sql, params, options);
    this.updateState(params, result);

    if (this.shouldThrowAfter(sql, params, result, inTransaction)) {
      this.throwAt(inTransaction);
    }

    this.logCall(params, result, inTransaction);
    return result;
  }

  private shouldThrowBefore(
    _sql: string,
    _params: readonly SqliteValue[] | undefined,
    inTransaction: boolean,
  ): boolean {
    if (this.thrown || !this.injectionStage) return false;

    if (!inTransaction) {
      return (
        this.injectionStage === 'query' &&
        this.hasTransactionAttempted &&
        this.transactionDepth === 0
      );
    }

    if (this.injectionStage === 'pre-commit' && this.transactionExecCount === 1) {
      return true;
    }

    if (
      (this.injectionStage === 'post-ingest' || this.injectionStage === 'reprocess') &&
      this.committed
    ) {
      return true;
    }

    return false;
  }

  private shouldThrowAfter(
    _sql: string,
    _params: readonly SqliteValue[] | undefined,
    _result: SqliteExecResult,
    inTransaction: boolean,
  ): boolean {
    if (this.thrown || !this.injectionStage || !inTransaction) return false;

    if (this.injectionStage === 'mid-commit' && this.rootSessionInserted) {
      return true;
    }

    if (this.injectionStage === 'mid-rollup' && this.firstRuInsertSeen) {
      return true;
    }

    return false;
  }

  private throwAt(inTransaction: boolean): never {
    const stage = this.injectionStage;
    if (!stage) {
      throw new Error('throwAt called without an active injection stage');
    }
    this.thrown = true;
    this.thrownCallIndex = inTransaction ? this.transactionExecCount : this.callIndex;
    this.thrownStage = stage;
    throw new InjectionError(stage);
  }

  private updateState(params: readonly SqliteValue[] | undefined, result: SqliteExecResult): void {
    const firstParam = params?.[0];
    const secondParam = params?.[1];
    const paramCount = params?.length ?? 0;

    if (
      !this.beginGenerationSeen &&
      isStringStartingWith(firstParam, 'gen-') &&
      typeof secondParam === 'string' &&
      paramCount === 10
    ) {
      this.beginGenerationSeen = true;
      this.generationId = firstParam;
      this.sessionId = secondParam;
      return;
    }

    if (
      this.beginGenerationSeen &&
      !this.rootSessionInserted &&
      firstParam === this.sessionId &&
      paramCount > 2 &&
      result.rows.length === 0
    ) {
      this.rootSessionInserted = true;
      return;
    }

    if (
      this.beginGenerationSeen &&
      !this.committed &&
      firstParam === this.generationId &&
      secondParam === this.sessionId &&
      paramCount === 2 &&
      result.rows.length === 0
    ) {
      this.committed = true;
      return;
    }

    if (
      this.committed &&
      !this.rollupReadSeen &&
      result.rows.length > 0 &&
      hasAllColumns(result.rows[0], [
        'id',
        'project_id',
        'portfolio_id',
        'occurrence_time',
        'created_at',
        'harness',
        'mode',
        'task_cohort',
      ])
    ) {
      this.rollupReadSeen = true;
      return;
    }

    if (
      this.committed &&
      this.rollupReadSeen &&
      !this.firstRuInsertSeen &&
      isStringStartingWith(firstParam, 'ru-') &&
      paramCount === 16 &&
      result.rows.length === 0
    ) {
      this.firstRuInsertSeen = true;
    }
  }

  private logCall(
    params: readonly SqliteValue[] | undefined,
    result: SqliteExecResult,
    inTransaction: boolean,
  ): void {
    if (!this.injectionStage) return;

    this.callLog.push({
      callIndex: this.callIndex,
      inTransaction,
      transactionExecCount: inTransaction ? this.transactionExecCount : 0,
      firstParam: params?.[0] ?? null,
      secondParam: params?.[1] ?? null,
      paramCount: params?.length ?? 0,
      changes: result.changes,
      lastInsertRowId: result.lastInsertRowId.toString(10),
      columns: result.rows.length > 0 ? Object.keys(result.rows[0] ?? {}) : [],
      rowCount: result.rows.length,
    });
  }

  private isTransactionInjectionStage(): boolean {
    return (
      this.injectionStage === 'pre-commit' ||
      this.injectionStage === 'mid-commit' ||
      this.injectionStage === 'mid-rollup' ||
      this.injectionStage === 'post-ingest' ||
      this.injectionStage === 'reprocess'
    );
  }

  private resetRunState(): void {
    this.callLog = [];
    this.callIndex = 0;
    this.thrown = false;
    this.thrownCallIndex = -1;
    this.thrownStage = undefined;

    this.transactionCounter = 0;
    this.transactionDepth = 0;
    this.transactionExecCount = 0;

    this.generationId = undefined;
    this.sessionId = undefined;
    this.beginGenerationSeen = false;
    this.rootSessionInserted = false;
    this.committed = false;
    this.rollupReadSeen = false;
    this.firstRuInsertSeen = false;
  }
}

class FailureInjectionTransaction implements SqliteTransaction {
  readonly id: number;
  readonly backend: AdapterBackend;
  readonly isActive = true;
  readonly nestingLevel = 1;

  private readonly controller: FailureInjectionExecutor;

  constructor(controller: FailureInjectionExecutor, id: number) {
    this.controller = controller;
    this.id = id;
    this.backend = controller.backend;
  }

  exec(
    sql: string,
    params?: readonly SqliteValue[],
    options?: SqliteExecutionOptions,
  ): SqliteExecResult {
    return this.controller.execInTransaction(sql, params, options);
  }

  prepare(sql: string): SqliteStatement {
    return this.controller.prepare(sql);
  }

  savepoint(_name: string): Promise<void> {
    return Promise.resolve();
  }

  releaseSavepoint(_name: string): Promise<void> {
    return Promise.resolve();
  }

  rollbackToSavepoint(_name: string): Promise<void> {
    return Promise.resolve();
  }

  commit(): Promise<void> {
    throw new Error('Use the transaction callback return value to commit; do not call tx.commit()');
  }

  rollback(): Promise<void> {
    throw new Error('Throw from the transaction callback to roll back; do not call tx.rollback()');
  }
}
