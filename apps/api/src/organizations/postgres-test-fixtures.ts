import { randomUUID } from 'node:crypto';
import type { Prisma as PrismaTypes, PrismaClient } from '@benhouse/database';
import type {
  OrganizationTransactionOperation,
  OrganizationTransactionStartedEvent,
} from './organization-transaction-observer';
import type {
  MarketplaceTransactionOperation,
  MarketplaceTransactionStartedEvent,
} from '../marketplace/marketplace-transaction-observer';

type TestTransactionOperation = OrganizationTransactionOperation | MarketplaceTransactionOperation;
type TestTransactionStartedEvent =
  OrganizationTransactionStartedEvent | MarketplaceTransactionStartedEvent;

type ReceiptState = 'ISSUED' | 'CLAIMED' | 'CONSUMED' | 'INVALIDATED';
type ReceiptRecord = { owner: TestOrganizationTransactionObserver; state: ReceiptState };
const transactionReceipts = new WeakMap<object, ReceiptRecord>();

// Un trabajo puede fallar antes de emitir ready o mientras se espera otro recibo.
// Observarlo inmediatamente evita rechazos huérfanos; wait propaga el primer fallo
// sin convertirlo en un timeout de una señal que ya no podrá emitirse.
export class CausalWorkScope {
  private readonly work: Promise<unknown>[] = [];
  private rejectFailure!: (error: unknown) => void;
  private readonly failure = new Promise<never>((_resolve, reject) => {
    this.rejectFailure = reject;
  });

  constructor() {
    void this.failure.catch(() => undefined);
  }

  observe<T>(work: Promise<T>): Promise<T> {
    this.work.push(work);
    void work.catch(this.rejectFailure);
    return work;
  }

  wait<T>(signal: Promise<T>): Promise<T> {
    return Promise.race([signal, this.failure]);
  }

  waitForWork<T>(work: Promise<T>): Promise<T> {
    return this.wait(this.observe(work));
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.work);
  }
}

export type ObservedOrganizationTransaction = Readonly<TestTransactionStartedEvent> & {
  readonly causalReceipt: true;
};

type TransactionWait = Omit<TestTransactionStartedEvent, 'backendPid' | 'virtualTransactionId'> & {
  timeoutMs?: number;
};

export class TestOrganizationTransactionObserver {
  readonly enabled = true;
  private readonly events = new Map<string, ObservedOrganizationTransaction>();
  private readonly receipts = new Map<string, ObservedOrganizationTransaction>();
  private readonly waiters = new Map<
    string,
    {
      resolve: (event: ObservedOrganizationTransaction) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  transactionStarted(event: TestTransactionStartedEvent): void {
    const key = transactionKey(event);
    if (this.events.has(key)) throw new Error(`Evento transaccional duplicado: ${key}`);
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    const receipt = Object.freeze({ ...event, causalReceipt: true as const });
    transactionReceipts.set(receipt, { owner: this, state: 'ISSUED' });
    this.events.set(key, receipt);
    this.receipts.set(key, receipt);
    clearTimeout(waiter.timer);
    this.waiters.delete(key);
    waiter.resolve(receipt);
  }

  waitFor(expected: TransactionWait): Promise<ObservedOrganizationTransaction> {
    const key = transactionKey(expected);
    if (this.waiters.has(key)) {
      return Promise.reject(new Error(`Espera transaccional duplicada: ${key}`));
    }
    if (this.events.has(key)) {
      return Promise.reject(new Error(`Evento transaccional ya consumido: ${key}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`Timeout esperando evento transaccional: ${key}`));
      }, expected.timeoutMs ?? 2_000);
      this.waiters.set(key, { resolve, reject, timer });
    });
  }

  clearRequest(requestId: string): void {
    for (const [key, waiter] of this.waiters) {
      if (key.startsWith(`${requestId}:`)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Espera cancelada durante cleanup: ${key}`));
        this.waiters.delete(key);
      }
    }
    for (const [key, receipt] of this.receipts) {
      if (key.startsWith(`${requestId}:`)) {
        const record = transactionReceipts.get(receipt);
        if (record) record.state = 'INVALIDATED';
        transactionReceipts.delete(receipt);
        this.receipts.delete(key);
      }
    }
    for (const key of this.events.keys()) {
      if (key.startsWith(`${requestId}:`)) this.events.delete(key);
    }
  }

  eventCount(requestId?: string): number {
    if (!requestId) return this.events.size;
    return [...this.events.keys()].filter((key) => key.startsWith(`${requestId}:`)).length;
  }

  waiterCount(): number {
    return this.waiters.size;
  }

  activeReceiptCount(): number {
    return this.receipts.size;
  }

  releaseReceipt(receipt: ObservedOrganizationTransaction): void {
    const key = transactionKey(receipt);
    if (this.receipts.get(key) === receipt) this.receipts.delete(key);
    if (this.events.get(key) === receipt) this.events.delete(key);
  }
}

export type BlockedQueryObservation = {
  pid: number;
  virtualTransactionId: string | null;
  databaseName: string;
  applicationName: string;
  waitEventType: string | null;
  waitEvent: string | null;
  state: string | null;
  query: string;
  blockingPids: readonly number[];
};

export type BlockedQueryExpectation = {
  blockerPid: number;
  databaseName: string;
  applicationName: string;
  expectedQuery: string;
  requestId: string;
  operation: TestTransactionOperation;
  attempt: number;
  transaction: ObservedOrganizationTransaction;
  diagnosticRoute?: string;
  allowedWaitEvents: readonly string[];
  expectedBlockedPid: number;
  expectedVirtualTransactionId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export class BlockedQueryBarrierError extends Error {
  constructor(
    message: string,
    readonly diagnostic: Record<string, unknown>,
  ) {
    super(`${message}: ${JSON.stringify(diagnostic)}`);
    this.name = 'BlockedQueryBarrierError';
  }
}

type QueryObserver = Pick<PrismaClient, '$queryRaw'>;

export function matchingBlockedQueries(
  observations: readonly BlockedQueryObservation[],
  expected: BlockedQueryExpectation,
): BlockedQueryObservation[] {
  const expectedSql = normalizeSql(expected.expectedQuery);
  return observations.filter(
    (candidate) =>
      candidate.databaseName === expected.databaseName &&
      candidate.applicationName === expected.applicationName &&
      candidate.waitEventType === 'Lock' &&
      candidate.state === 'active' &&
      candidate.waitEvent !== 'advisory' &&
      candidate.waitEvent !== null &&
      expected.allowedWaitEvents.includes(candidate.waitEvent) &&
      normalizeSql(candidate.query) === expectedSql &&
      candidate.blockingPids.length === 1 &&
      candidate.blockingPids[0] === expected.blockerPid &&
      candidate.pid === expected.expectedBlockedPid &&
      candidate.virtualTransactionId === expected.expectedVirtualTransactionId,
  );
}

export async function waitForQueryBlockedBy(
  observer: QueryObserver,
  expected: BlockedQueryExpectation,
): Promise<BlockedQueryObservation> {
  const record = claimCausalTransaction(expected);
  const timeoutMs = expected.timeoutMs ?? 5_000;
  const pollIntervalMs = expected.pollIntervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  let lastObservations: BlockedQueryObservation[] = [];

  let accepted = false;
  try {
    while (Date.now() < deadline) {
      if (record.state !== 'CLAIMED') {
        throw barrierFailure(
          'El recibo fue invalidado durante la espera',
          expected,
          lastObservations,
        );
      }
      lastObservations = await observer.$queryRaw<BlockedQueryObservation[]>`
      SELECT
        pid,
        (SELECT virtualtransaction::text FROM pg_locks
         WHERE pid = activity.pid AND locktype = 'virtualxid' AND granted = true)
          AS "virtualTransactionId",
        datname AS "databaseName",
        application_name AS "applicationName",
        wait_event_type AS "waitEventType",
        wait_event AS "waitEvent",
        state,
        query,
        pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity AS activity
      WHERE datname = ${expected.databaseName}
        AND (pid = ${expected.expectedBlockedPid} OR wait_event_type = 'Lock')
    `;
      if (record.state !== 'CLAIMED') {
        throw barrierFailure(
          'El recibo fue invalidado durante la espera',
          expected,
          lastObservations,
        );
      }
      const causalBackend = lastObservations.find(({ pid }) => pid === expected.expectedBlockedPid);
      if (!causalBackend) {
        throw barrierFailure(
          'El backend causal ya no existe en la base esperada',
          expected,
          lastObservations,
        );
      }
      if (causalBackend.virtualTransactionId !== expected.expectedVirtualTransactionId) {
        throw barrierFailure(
          'La transacción virtual causal ya no está activa',
          expected,
          lastObservations,
        );
      }
      const matches = matchingBlockedQueries(lastObservations, expected);
      if (matches.length === 1) {
        accepted = true;
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw barrierFailure('La barrera encontró varios backends candidatos', expected, matches);
      }
      await delay(pollIntervalMs);
    }
    throw barrierFailure('Timeout esperando el backend bloqueado', expected, lastObservations);
  } finally {
    record.state = accepted && record.state === 'CLAIMED' ? 'CONSUMED' : 'INVALIDATED';
    transactionReceipts.delete(expected.transaction);
    record.owner.releaseReceipt(expected.transaction);
  }
}

function barrierFailure(
  message: string,
  expected: BlockedQueryExpectation,
  observations: readonly BlockedQueryObservation[],
): BlockedQueryBarrierError {
  return new BlockedQueryBarrierError(message, {
    blockerPid: expected.blockerPid,
    expectedBlockedPid: expected.expectedBlockedPid,
    expectedVirtualTransactionId: expected.expectedVirtualTransactionId,
    databaseName: expected.databaseName,
    applicationName: expected.applicationName,
    requestId: expected.requestId,
    operation: expected.operation,
    attempt: expected.attempt,
    diagnosticRoute: expected.diagnosticRoute,
    expectedQuery: normalizeSql(expected.expectedQuery),
    allowedWaitEvents: expected.allowedWaitEvents,
    observations: observations.map(({ query, ...observation }) => ({
      ...observation,
      query: normalizeSql(query),
    })),
  });
}

function claimCausalTransaction(expected: BlockedQueryExpectation): ReceiptRecord {
  if (!Number.isInteger(expected.expectedBlockedPid) || expected.expectedBlockedPid <= 0) {
    throw barrierFailure('PID bloqueado obligatorio e inválido', expected, []);
  }
  const record = transactionReceipts.get(expected.transaction);
  if (
    !record ||
    record.state !== 'ISSUED' ||
    expected.transaction.requestId !== expected.requestId ||
    expected.transaction.operation !== expected.operation ||
    expected.transaction.attempt !== expected.attempt ||
    expected.transaction.backendPid !== expected.expectedBlockedPid ||
    expected.transaction.virtualTransactionId !== expected.expectedVirtualTransactionId ||
    !/^\d+\/\d+$/.test(expected.expectedVirtualTransactionId)
  ) {
    throw barrierFailure('El PID no procede del evento causal esperado', expected, []);
  }
  record.state = 'CLAIMED';
  return record;
}

function transactionKey(event: {
  requestId: string;
  operation: TestTransactionOperation;
  attempt: number;
}): string {
  return `${event.requestId}:${event.operation}:${event.attempt}`;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type FixtureCatalog = { functions: bigint; triggers: bigint; sequences: bigint };

export type AuditFailureInstallationPhase =
  | 'before-create'
  | 'after-sequence'
  | 'during-function'
  | 'during-trigger'
  | 'before-commit'
  | 'after-install';

export type AuditFailureFixtureOptions = {
  requestId: string;
  failures: number;
  sqlState: '40001' | 'P0001';
  failInstallationAt?: AuditFailureInstallationPhase;
  failAfterCallback?: boolean;
  failPrimaryCleanup?: boolean;
  failFallbackCleanup?: boolean;
};

export type AuditFailureFixture = {
  sequenceName: string;
  functionName: string;
  triggerName: string;
  diagnostics: { cleanupFallbackUsed: boolean };
  attempts(): Promise<number>;
};

type FixtureDatabase = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe' | '$transaction'>;

export async function withAuditFailureFixture<T>(
  database: FixtureDatabase,
  options: AuditFailureFixtureOptions,
  callback: (fixture: AuditFailureFixture) => Promise<T>,
): Promise<T> {
  const names = auditFailureObjectNames();
  const diagnostics = { cleanupFallbackUsed: false };
  const fixture: AuditFailureFixture = {
    ...names,
    diagnostics,
    attempts: async () => {
      const rows = await database.$queryRawUnsafe<Array<{ lastValue: bigint }>>(
        `SELECT last_value AS "lastValue" FROM "${names.sequenceName}"`,
      );
      return Number(rows[0]?.lastValue);
    },
  };

  try {
    await database.$transaction(async (tx) => installAuditFailure(tx, names, options));
  } catch (installationError) {
    const catalog = await auditFailureCatalog(database, names);
    if (!emptyCatalog(catalog)) {
      throw new AggregateError(
        [
          installationError,
          new Error(`Instalación parcial persistida: ${JSON.stringify(catalog)}`),
        ],
        'Falló la instalación atómica del fixture de auditoría',
      );
    }
    throw installationError;
  }

  let operationError: unknown;
  let result: T | undefined;
  try {
    if (options.failInstallationAt === 'after-install') {
      throw new FixturePhaseError('B14_AFTER_INSTALL', 'B1404');
    }
    result = await callback(fixture);
    if (options.failAfterCallback) {
      throw new FixturePhaseError('B14_AFTER_CALLBACK', 'B1405');
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanupAuditFailure(database, names, options, diagnostics);
  } catch (error) {
    cleanupError = error;
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      'Fallaron la operación principal y la limpieza del fixture de auditoría',
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result as T;
}

export class FixturePhaseError extends Error {
  constructor(
    message: string,
    readonly sqlState: string,
  ) {
    super(message);
    this.name = 'FixturePhaseError';
  }
}

function auditFailureObjectNames() {
  const suffix = randomUUID().replaceAll('-', '');
  return {
    sequenceName: `b14_audit_sequence_${suffix}`,
    functionName: `b14_audit_failure_${suffix}`,
    triggerName: `b14_audit_trigger_${suffix}`,
  };
}

async function installAuditFailure(
  tx: PrismaTypes.TransactionClient,
  names: ReturnType<typeof auditFailureObjectNames>,
  options: AuditFailureFixtureOptions,
): Promise<void> {
  const requestLiteral = options.requestId.replaceAll("'", "''");
  if (options.failInstallationAt === 'before-create') {
    await raiseSqlState(tx, 'B14_BEFORE_CREATE', 'B1400');
  }
  await tx.$executeRawUnsafe(`CREATE SEQUENCE "${names.sequenceName}"`);
  if (options.failInstallationAt === 'after-sequence') {
    await raiseSqlState(tx, 'B14_AFTER_SEQUENCE', 'B1401');
  }
  if (options.failInstallationAt === 'during-function') {
    await tx.$executeRawUnsafe(
      `CREATE FUNCTION "${names.functionName}"() RETURNS trigger LANGUAGE b14_missing_language AS 'x'`,
    );
  }
  await tx.$executeRawUnsafe(`
    CREATE FUNCTION "${names.functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.request_id = '${requestLiteral}' AND nextval('${names.sequenceName}') <= ${options.failures} THEN
        RAISE EXCEPTION 'B14_CONTROLLED_AUDIT_FAILURE' USING ERRCODE = '${options.sqlState}';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  if (options.failInstallationAt === 'during-trigger') {
    await tx.$executeRawUnsafe(`
      CREATE TRIGGER "${names.triggerName}"
      BEFORE INSERT ON "audit_event"
      FOR EACH ROW EXECUTE FUNCTION "b14_missing_function_${names.triggerName}"()
    `);
  }
  await tx.$executeRawUnsafe(`
    CREATE TRIGGER "${names.triggerName}"
    BEFORE INSERT ON "audit_event"
    FOR EACH ROW EXECUTE FUNCTION "${names.functionName}"()
  `);
  if (options.failInstallationAt === 'before-commit') {
    await raiseSqlState(tx, 'B14_BEFORE_COMMIT', 'B1403');
  }
}

async function cleanupAuditFailure(
  database: FixtureDatabase,
  names: ReturnType<typeof auditFailureObjectNames>,
  options: AuditFailureFixtureOptions,
  diagnostics: AuditFailureFixture['diagnostics'],
): Promise<void> {
  try {
    await database.$transaction(async (tx) => {
      await dropAuditFailureObjects(tx, names);
      if (options.failPrimaryCleanup)
        await raiseSqlState(tx, 'B14_PRIMARY_CLEANUP_FAILURE', 'B1491');
    });
  } catch (primaryCleanupError) {
    diagnostics.cleanupFallbackUsed = true;
    try {
      await database.$transaction(async (tx) => {
        await dropAuditFailureObjects(tx, names);
        if (options.failFallbackCleanup) {
          await raiseSqlState(tx, 'B14_FALLBACK_CLEANUP_FAILURE', 'B1492');
        }
      });
    } catch (fallbackCleanupError) {
      let emergencyCleanupError: unknown;
      try {
        await database.$transaction((tx) => dropAuditFailureObjects(tx, names));
      } catch (error) {
        emergencyCleanupError = error;
      }
      throw new AggregateError(
        [
          primaryCleanupError,
          fallbackCleanupError,
          ...(emergencyCleanupError === undefined ? [] : [emergencyCleanupError]),
        ],
        'Fallaron la limpieza principal y la recuperación del fixture de auditoría',
      );
    }
  }
  const catalog = await auditFailureCatalog(database, names);
  if (!emptyCatalog(catalog)) throw new Error(`Cleanup incompleto: ${JSON.stringify(catalog)}`);
}

async function dropAuditFailureObjects(
  tx: PrismaTypes.TransactionClient,
  names: ReturnType<typeof auditFailureObjectNames>,
): Promise<void> {
  await tx.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${names.triggerName}" ON "audit_event"`);
  await tx.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${names.functionName}"()`);
  await tx.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${names.sequenceName}"`);
}

async function raiseSqlState(
  tx: PrismaTypes.TransactionClient,
  message: string,
  sqlState: string,
): Promise<never> {
  await tx.$executeRawUnsafe(
    `DO $$ BEGIN RAISE EXCEPTION '${message}' USING ERRCODE = '${sqlState}'; END $$`,
  );
  throw new FixturePhaseError(message, sqlState);
}

async function auditFailureCatalog(
  database: Pick<PrismaClient, '$queryRawUnsafe'>,
  names: ReturnType<typeof auditFailureObjectNames>,
): Promise<FixtureCatalog> {
  const rows = await database.$queryRawUnsafe<FixtureCatalog[]>(`
    SELECT
      (SELECT count(*) FROM pg_proc WHERE proname = '${names.functionName}') AS functions,
      (SELECT count(*) FROM pg_trigger WHERE tgname = '${names.triggerName}') AS triggers,
      (SELECT count(*) FROM pg_class WHERE relkind = 'S' AND relname = '${names.sequenceName}') AS sequences
  `);
  return rows[0] ?? { functions: -1n, triggers: -1n, sequences: -1n };
}

function emptyCatalog(catalog: FixtureCatalog): boolean {
  return catalog.functions === 0n && catalog.triggers === 0n && catalog.sequences === 0n;
}
