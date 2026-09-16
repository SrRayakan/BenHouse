import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, Prisma, type PrismaClient } from '@benhouse/database';
import {
  BlockedQueryBarrierError,
  FixturePhaseError,
  waitForQueryBlockedBy,
  withAuditFailureFixture,
  type AuditFailureFixture,
  TestOrganizationTransactionObserver,
} from './postgres-test-fixtures';

describe('infraestructura PostgreSQL de pruebas B1.4', () => {
  let observer: PrismaClient;
  let originalDatabaseUrl: string | undefined;
  const suite = randomUUID().replaceAll('-', '');

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    observer = await createNamedClient(`b14_fixture_observer_${suite}`);
    const identity = await observer.$queryRaw<Array<{ databaseName: string }>>(
      Prisma.sql`SELECT current_database() AS "databaseName"`,
    );
    expect(identity[0]?.databaseName).toBe('benhouse_test');
  });

  afterAll(async () => {
    await expectTemporaryCatalogEmpty();
    await observer?.$disconnect();
    restoreDatabaseUrl(originalDatabaseUrl);
  });

  it('rechaza el ataque exacto sin Nest ni petición HTTP aunque se copie toda la heurística', async () => {
    const applicationName = `b14_direct_attack_${suite}`;
    const holder = await createNamedClient(`b14_direct_holder_${suite}`);
    const direct = await createNamedClient(applicationName);
    const causalObserver = new TestOrganizationTransactionObserver();
    const user = await observer.user.create({
      data: {
        email: `direct-attack-${randomUUID()}@example.test`,
        displayName: 'Ataque directo sintético',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    let release!: () => void;
    let ready!: (pid: number) => void;
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));
    const holderReady = new Promise<number>((resolve) => (ready = resolve));
    const held = holder.$transaction(async (tx) => {
      const backend = await tx.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${user.id}::uuid FOR UPDATE`,
      );
      ready(backend[0]!.pid);
      await releaseSignal;
    });
    let pending: Promise<unknown> | undefined;
    try {
      const blockerPid = await holderReady;
      let directReady!: (transaction: { backendPid: number; virtualTransactionId: string }) => void;
      const directTransactionReady = new Promise<{
        backendPid: number;
        virtualTransactionId: string;
      }>((resolve) => (directReady = resolve));
      const event = causalObserver.waitFor({
        requestId: 'no-http-request',
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
        timeoutMs: 40,
      });
      pending = (async () =>
        await direct.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<
            Array<{ backendPid: number; virtualTransactionId: string }>
          >(
            Prisma.sql`SELECT pg_backend_pid() AS "backendPid", virtualtransaction::text AS "virtualTransactionId" FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'virtualxid' AND granted = true`,
          );
          directReady(rows[0]!);
          return await tx.$queryRawUnsafe(
            'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
            user.id,
          );
        }))();
      void pending.catch(() => undefined);
      const directTransaction = await directTransactionReady;
      const blocked = await waitForDirectQueryBlockedBy(
        observer,
        directTransaction.backendPid,
        directTransaction.virtualTransactionId,
        blockerPid,
        applicationName,
      );
      expect(blocked.query).toBe('SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE');
      expect(blocked.waitEventType).toBe('Lock');
      expect(['transactionid', 'tuple']).toContain(blocked.waitEvent);
      expect(blocked.blockingPids).toEqual([blockerPid]);
      expect(blocked.virtualTransactionId).toBe(directTransaction.virtualTransactionId);
      await expect(event).rejects.toThrow('Timeout esperando evento transaccional');
      expect(causalObserver.eventCount()).toBe(0);
      await expect(
        waitForQueryBlockedBy(observer, {
          blockerPid,
          databaseName: 'benhouse_test',
          applicationName,
          expectedQuery: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
          requestId: 'no-http-request',
          operation: 'ORGANIZATION_UPDATE',
          attempt: 1,
          transaction: {
            requestId: 'no-http-request',
            operation: 'ORGANIZATION_UPDATE',
            attempt: 1,
            backendPid: directTransaction.backendPid,
            virtualTransactionId: '1/1',
            causalReceipt: true,
          } as never,
          diagnosticRoute: '/organizations/:id',
          allowedWaitEvents: ['transactionid', 'tuple'],
          expectedBlockedPid: directTransaction.backendPid,
          expectedVirtualTransactionId: '1/1',
          timeoutMs: 40,
        }),
      ).rejects.toThrow('evento causal esperado');
    } finally {
      release();
      const [holderResult, directResult] = await Promise.allSettled([
        held,
        pending ?? Promise.resolve(),
      ]);
      causalObserver.clearRequest('no-http-request');
      expect([
        causalObserver.eventCount(),
        causalObserver.waiterCount(),
        causalObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);
      await observer.user.delete({ where: { id: user.id } });
      await Promise.all([holder.$disconnect(), direct.$disconnect()]);
      await expectTemporaryCatalogEmpty();
      const remaining = await observer.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT count(*) FROM pg_stat_activity WHERE application_name IN (${`b14_direct_holder_${suite}`}, ${applicationName})`,
      );
      expect(remaining[0]?.count).toBe(0n);
      expect(holderResult.status).toBe('fulfilled');
      expect(directResult.status).toBe('fulfilled');
    }
  }, 10_000);

  it('un advisory lock ajeno no satisface la barrera aunque el SQL sea idéntico', async () => {
    const blocker = await createNamedClient(`b14_advisory_blocker_${suite}`);
    const targetApplication = `b14_advisory_target_${suite}`;
    const target = await createNamedClient(targetApplication);
    const key = Math.floor(Math.random() * 1_000_000_000);
    const causalObserver = new TestOrganizationTransactionObserver();
    let release!: () => void;
    let started!: (pid: number) => void;
    const signal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<number>((resolve) => {
      started = resolve;
    });
    const held = blocker.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${key})`);
      started(rows[0]!.pid);
      await signal;
    });
    let pending: Promise<unknown> | undefined;
    try {
      const blockerPid = await ready;
      const transactionStarted = causalObserver.waitFor({
        requestId: 'advisory-negative',
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
        timeoutMs: 5_000,
      });
      pending = target.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ backendPid: number; virtualTransactionId: string }>
        >(
          Prisma.sql`SELECT pg_backend_pid() AS "backendPid", virtualtransaction::text AS "virtualTransactionId" FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'virtualxid' AND granted = true`,
        );
        causalObserver.transactionStarted({
          requestId: 'advisory-negative',
          operation: 'ORGANIZATION_UPDATE',
          attempt: 1,
          ...rows[0]!,
        });
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${key})`);
      });
      const transaction = await transactionStarted;
      await expect(
        waitForQueryBlockedBy(observer, {
          blockerPid,
          databaseName: 'benhouse_test',
          applicationName: targetApplication,
          expectedQuery: 'SELECT pg_advisory_xact_lock($1)',
          requestId: 'advisory-negative',
          operation: 'ORGANIZATION_UPDATE',
          attempt: 1,
          transaction,
          diagnosticRoute: '/organizations/:id',
          allowedWaitEvents: ['transactionid', 'tuple'],
          expectedBlockedPid: transaction.backendPid,
          expectedVirtualTransactionId: transaction.virtualTransactionId,
          timeoutMs: 40,
          pollIntervalMs: 5,
        }),
      ).rejects.toBeInstanceOf(BlockedQueryBarrierError);
    } finally {
      release();
      await Promise.all([held.catch(() => undefined), pending?.catch(() => undefined)]);
      await Promise.all([blocker.$disconnect(), target.$disconnect()]);
      causalObserver.clearRequest('advisory-negative');
      expect([
        causalObserver.eventCount(),
        causalObserver.waiterCount(),
        causalObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);
    }
  }, 10_000);

  it.each([
    ['before-create', 'B1400'],
    ['after-sequence', 'B1401'],
    ['during-function', '42704'],
    ['during-trigger', '42883'],
    ['before-commit', 'B1403'],
  ] as const)('revierte toda la instalación si falla en %s', async (phase, expectedSqlState) => {
    let callbackCalled = false;
    const failure = withAuditFailureFixture(
      observer,
      {
        requestId: `install-${phase}-${randomUUID()}`,
        failures: 1,
        sqlState: 'P0001',
        failInstallationAt: phase,
      },
      async () => {
        callbackCalled = true;
      },
    );
    await expect(failure).rejects.toSatisfy(
      (error: unknown) => structuredSqlState(error) === expectedSqlState,
    );
    expect(callbackCalled).toBe(false);
    await expectTemporaryCatalogEmpty();
  });

  it('limpia si falla después de instalar y antes del callback', async () => {
    let callbackCalled = false;
    await expect(
      withAuditFailureFixture(
        observer,
        {
          requestId: `after-install-${randomUUID()}`,
          failures: 1,
          sqlState: 'P0001',
          failInstallationAt: 'after-install',
        },
        async () => {
          callbackCalled = true;
        },
      ),
    ).rejects.toMatchObject({ name: 'FixturePhaseError', sqlState: 'B1404' });
    expect(callbackCalled).toBe(false);
    await expectTemporaryCatalogEmpty();
  });

  it('preserva el error del callback y limpia el catálogo', async () => {
    const primary = new Error('B14_CALLBACK_FAILURE');
    await expect(
      withAuditFailureFixture(
        observer,
        { requestId: `callback-${randomUUID()}`, failures: 1, sqlState: 'P0001' },
        async () => {
          throw primary;
        },
      ),
    ).rejects.toBe(primary);
    await expectTemporaryCatalogEmpty();
  });

  it('limpia si falla después del callback y antes del cleanup', async () => {
    await expect(
      withAuditFailureFixture(
        observer,
        {
          requestId: `after-callback-${randomUUID()}`,
          failures: 1,
          sqlState: 'P0001',
          failAfterCallback: true,
        },
        async () => 'callback-completo',
      ),
    ).rejects.toMatchObject({ name: 'FixturePhaseError', sqlState: 'B1405' });
    await expectTemporaryCatalogEmpty();
  });

  it('recupera un fallo del cleanup principal con fallback transaccional', async () => {
    let fixture!: AuditFailureFixture;
    const result = await withAuditFailureFixture(
      observer,
      {
        requestId: `cleanup-${randomUUID()}`,
        failures: 1,
        sqlState: 'P0001',
        failPrimaryCleanup: true,
      },
      async (current) => {
        fixture = current;
        return 'callback-completo';
      },
    );
    expect(result).toBe('callback-completo');
    expect(fixture.diagnostics.cleanupFallbackUsed).toBe(true);
    await expectTemporaryCatalogEmpty();
  });

  it('informa ambos fallos de cleanup y deja catálogo limpio mediante recuperación final', async () => {
    let error: unknown;
    try {
      await withAuditFailureFixture(
        observer,
        {
          requestId: `cleanup-double-${randomUUID()}`,
          failures: 1,
          sqlState: 'P0001',
          failPrimaryCleanup: true,
          failFallbackCleanup: true,
        },
        async () => 'callback-completo',
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(structuredSqlState((error as AggregateError).errors[0])).toBe('B1491');
    expect(structuredSqlState((error as AggregateError).errors[1])).toBe('B1492');
    await expectTemporaryCatalogEmpty();
  });

  it('conserva primero el error principal si operación y cleanup fallan', async () => {
    const primary = new Error('B14_OPERATION_AND_CLEANUP');
    let error: unknown;
    try {
      await withAuditFailureFixture(
        observer,
        {
          requestId: `operation-cleanup-${randomUUID()}`,
          failures: 1,
          sqlState: 'P0001',
          failPrimaryCleanup: true,
          failFallbackCleanup: true,
        },
        async () => {
          throw primary;
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(primary);
    expect((error as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
    await expectTemporaryCatalogEmpty();
  });

  it('aísla dos wrappers concurrentes con nombres distintos y limpia ambos', async () => {
    const names = await Promise.all(
      [1, 2].map((index) =>
        withAuditFailureFixture(
          observer,
          {
            requestId: `concurrent-${index}-${randomUUID()}`,
            failures: 1,
            sqlState: 'P0001',
          },
          async (fixture) => [fixture.sequenceName, fixture.functionName, fixture.triggerName],
        ),
      ),
    );
    expect(new Set(names.flat()).size).toBe(6);
    await expectTemporaryCatalogEmpty();
  });

  async function expectTemporaryCatalogEmpty(): Promise<void> {
    const rows = await observer.$queryRaw<
      Array<{ functions: bigint; triggers: bigint; sequences: bigint; tables: bigint }>
    >(Prisma.sql`
      SELECT
        (SELECT count(*) FROM pg_proc WHERE proname LIKE 'b14_audit_failure_%') AS functions,
        (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'b14_audit_trigger_%') AS triggers,
        (SELECT count(*) FROM pg_class WHERE relkind = 'S' AND relname LIKE 'b14_audit_sequence_%') AS sequences,
        (SELECT count(*) FROM pg_class WHERE relkind IN ('r', 'p') AND relname LIKE 'b14_%') AS tables
    `);
    expect(rows[0]).toEqual({ functions: 0n, triggers: 0n, sequences: 0n, tables: 0n });
  }

  async function createNamedClient(applicationName: string): Promise<PrismaClient> {
    const prior = process.env.DATABASE_URL;
    const source = originalDatabaseUrl ?? prior;
    if (!source) throw new Error('DATABASE_URL no disponible para la suite B1.4.');
    const url = new URL(source);
    url.searchParams.set('application_name', applicationName);
    url.searchParams.set('connection_limit', '1');
    process.env.DATABASE_URL = url.toString();
    const client = createPrismaClient();
    try {
      await client.$connect();
      return client;
    } finally {
      restoreDatabaseUrl(prior);
    }
  }
});

function restoreDatabaseUrl(value: string | undefined): void {
  if (value === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
}

function structuredSqlState(error: unknown): unknown {
  if (error instanceof FixturePhaseError) return error.sqlState;
  if (typeof error !== 'object' || error === null) return undefined;
  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  return (meta as { code?: unknown }).code;
}

async function waitForDirectQueryBlockedBy(
  observer: PrismaClient,
  directPid: number,
  expectedVirtualTransactionId: string,
  blockerPid: number,
  applicationName: string,
): Promise<{
  query: string;
  waitEventType: string | null;
  waitEvent: string | null;
  blockingPids: number[];
  virtualTransactionId: string | null;
}> {
  const deadline = Date.now() + 5_000;
  let lastObservation: unknown;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<
      Array<{
        pid: number;
        applicationName: string;
        query: string;
        state: string;
        waitEventType: string | null;
        waitEvent: string | null;
        blockingPids: number[];
        virtualTransactionId: string | null;
      }>
    >(Prisma.sql`
      SELECT activity.pid, activity.application_name AS "applicationName", activity.query,
             activity.state, activity.wait_event_type AS "waitEventType",
             activity.wait_event AS "waitEvent", pg_blocking_pids(activity.pid) AS "blockingPids",
             (SELECT virtualtransaction::text FROM pg_locks
              WHERE pid = activity.pid AND locktype = 'virtualxid' AND granted = true)
               AS "virtualTransactionId"
      FROM pg_stat_activity AS activity
      WHERE activity.pid = ${directPid}
    `);
    const observation = rows[0];
    lastObservation = observation;
    if (
      observation?.applicationName === applicationName &&
      observation.query === 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE' &&
      observation.state === 'active' &&
      observation.waitEventType === 'Lock' &&
      ['transactionid', 'tuple'].includes(observation.waitEvent ?? '') &&
      observation.blockingPids.length === 1 &&
      observation.blockingPids[0] === blockerPid &&
      observation.virtualTransactionId === expectedVirtualTransactionId
    ) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`La consulta SQL directa no quedó bloqueada: ${JSON.stringify(lastObservation)}`);
}
