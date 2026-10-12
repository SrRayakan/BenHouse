import '../../test/verified-database.mjs';
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readAppConfig } from '@benhouse/config';
import type { AuthConfig, AuthRateLimitPolicyName } from '@benhouse/config';
import { createPrismaClient, Prisma } from '@benhouse/database';
import { AppModule } from '../app.module';
import { configureApplication } from '../main';
import { DatabaseService } from '../infrastructure/database/database.service';
import { createSessionToken, sessionSecretDigest } from '../auth/session-token';
import { AUTH_CONFIG } from '../auth/auth.config';
import { AuthRateLimitService } from '../auth/rate-limit.service';
import { SystemClock } from '../auth/clock';
import { deriveCsrfToken } from '../auth/csrf';
import { serializeAccountToken } from '../auth/account-token';
import { cleanupOrganizationAdministration } from './organization-administration-test-cleanup';
import {
  TestOrganizationTransactionObserver,
  CausalWorkScope,
  waitForQueryBlockedBy,
  withAuditFailureFixture,
} from './postgres-test-fixtures';
import {
  OrganizationTransactionObserver,
  type OrganizationTransactionOperation,
} from './organization-transaction-observer';

type Actor = { userId: string; cookie: string; csrf: string };
type Response = {
  status: number;
  body: Record<string, unknown> | undefined;
  retryAfter: string | null;
};

describe('B1.5 Invitations & Membership Administration HTTP/PostgreSQL', () => {
  let app: NestExpressApplication;
  let database: DatabaseService;
  let baseUrl: string;
  let cookieName: string;
  let priorDatabaseUrl: string | undefined;
  let transactionObserver: TestOrganizationTransactionObserver;
  let moduleRef: TestingModule | undefined;
  let reference: ReturnType<typeof createPrismaClient> | undefined;
  const suite = randomUUID();
  const apiApplicationName = `b15_api_${suite}`;
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  const requestIds = new Set<string>();

  beforeAll(async () => {
    priorDatabaseUrl = process.env.DATABASE_URL;
    const referenceDatabaseUrl = process.env.DATABASE_URL!;
    const apiUrl = new URL(process.env.DATABASE_URL!);
    // Compose publica PostgreSQL en IPv4; localhost puede intentar primero ::1.
    if (apiUrl.hostname === 'localhost') apiUrl.hostname = '127.0.0.1';
    apiUrl.searchParams.set('application_name', apiApplicationName);
    process.env.DATABASE_URL = apiUrl.toString();
    const config = readAppConfig();
    cookieName = config.auth.sessionCookieName;
    transactionObserver = new TestOrganizationTransactionObserver();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OrganizationTransactionObserver)
      .useValue(transactionObserver)
      .compile();
    database = moduleRef.get(DatabaseService);
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    configureApplication(app, config);
    app.set('trust proxy', 1);
    await app.listen(0, '127.0.0.1');
    const databaseIdentity = await database.prisma.$queryRaw<Array<{ name: string }>>(
      Prisma.sql`SELECT current_database() AS name`,
    );
    expect(databaseIdentity[0]?.name).toBe(process.env.API_TEST_DATABASE_NAME);
    reference = createPrismaClient({ datasourceUrl: referenceDatabaseUrl });
    const identity = (client: ReturnType<typeof createPrismaClient>) => client.$queryRaw`
      SELECT current_database() AS name, database.oid::text AS oid,
             control.system_identifier::text AS system
      FROM pg_database AS database CROSS JOIN pg_control_system() AS control
      WHERE database.datname=current_database()
    `;
    expect(await identity(database.prisma)).toEqual(await identity(reference));
    await reference.$disconnect();
    reference = undefined;
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Puerto HTTP no disponible.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    // Vitest conserva por separado los fallos de beforeAll/it y este afterAll.
    await cleanupOrganizationAdministration({
      database: database?.prisma,
      userIds,
      organizationIds,
      requestIds,
      resources: [
        {
          name: 'aplicación o módulo parcial',
          run: () => (app ? app.close() : moduleRef?.close()),
        },
        {
          name: 'servidor HTTP tras fallo de cierre',
          run: () => (app?.getHttpServer()?.listening ? app.getHttpAdapter().close() : undefined),
        },
        { name: 'cliente de datos', run: () => database?.disconnect() },
        { name: 'cliente de referencia', run: () => reference?.$disconnect() },
        {
          name: 'observador transaccional',
          run: () => {
            if (!transactionObserver) return;
            expect([
              transactionObserver.eventCount(),
              transactionObserver.waiterCount(),
              transactionObserver.activeReceiptCount(),
            ]).toEqual([0, 0, 0]);
          },
        },
      ],
      restoreDatabaseUrl: () => {
        if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = priorDatabaseUrl;
      },
    });
  }, 30_000);

  async function request(
    method: string,
    path: string,
    body?: unknown,
    actor?: Actor,
    origin: string | null = 'http://localhost:3000',
    requestId = `b15-${suite}-${randomUUID()}`,
    ip = `2001:db8:${suite.slice(0, 4)}:${suite.slice(4, 8)}::1`,
  ): Promise<Response> {
    requestIds.add(requestId);
    const headers: Record<string, string> = {
      'x-request-id': requestId,
      'x-forwarded-for': ip,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (origin !== null) headers.origin = origin;
    if (actor) {
      headers.cookie = `${cookieName}=${actor.cookie}`;
      headers['x-csrf-token'] = actor.csrf;
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      retryAfter: response.headers.get('retry-after'),
    };
  }

  async function actor(): Promise<Actor> {
    const now = new Date();
    const user = await database.prisma.user.create({
      data: {
        email: `b15-${suite.slice(0, 8)}-${randomUUID().slice(0, 16)}@example.test`,
        displayName: 'Usuario sintético',
        status: 'ACTIVE',
        emailVerifiedAt: now,
      },
    });
    userIds.push(user.id);
    const config = readAppConfig();
    const session = createSessionToken();
    const digest = sessionSecretDigest(
      session.selector,
      session.secret,
      config.auth.sessionTokenKeys.currentVersion,
      config.auth.sessionTokenKeys,
    )!;
    await database.prisma.session.create({
      data: {
        id: session.selector,
        userId: user.id,
        secretDigest: new Uint8Array(digest),
        secretKeyVersion: config.auth.sessionTokenKeys.currentVersion,
        issuedSessionVersion: user.sessionVersion,
        createdAt: now,
        lastActivityAt: now,
        idleExpiresAt: new Date(now.getTime() + 300_000),
        absoluteExpiresAt: new Date(now.getTime() + 600_000),
      },
    });
    return {
      userId: user.id,
      cookie: session.value,
      csrf: deriveCsrfToken(session.selector, user.sessionVersion, config.auth.csrfKeys),
    };
  }

  async function organization(owner: Actor): Promise<string> {
    const result = await request('POST', '/organizations', { name: `B1.5 ${suite}` }, owner);
    expect(result.status).toBe(201);
    const id = result.body?.id;
    if (typeof id !== 'string') throw new Error('Organización sin ID.');
    organizationIds.push(id);
    return id;
  }

  async function invitationToken(id: string): Promise<string> {
    const invitation = await database.prisma.organizationInvitation.findUniqueOrThrow({
      where: { id },
    });
    const token = await database.prisma.accountToken.findFirstOrThrow({
      where: { organizationInvitationId: id },
      orderBy: { generation: 'desc' },
    });
    return serializeAccountToken(
      {
        id: token.id,
        purpose: 'ORGANIZATION_INVITATION',
        generation: token.generation,
        subjectType: 'ORGANIZATION_INVITATION',
        subjectId: id,
        keyVersion: token.keyVersion,
        organizationId: invitation.organizationId,
        email: invitation.email,
        role: invitation.role,
      },
      readAppConfig().auth.accountTokenKeys,
    );
  }

  async function withRatePolicies<T>(
    names: readonly AuthRateLimitPolicyName[],
    policy: { limit: number; windowSeconds: number; blockSeconds: number },
    callback: () => Promise<T>,
    rotatePepper = false,
  ): Promise<T> {
    const auth = app.get<AuthConfig>(AUTH_CONFIG);
    const originalPolicies = auth.rateLimits;
    const originalPeppers = auth.rateLimitPepperKeys;
    auth.rateLimits = {
      ...originalPolicies,
      ...Object.fromEntries(names.map((name) => [name, policy])),
    };
    if (rotatePepper) {
      auth.rateLimitPepperKeys = {
        currentVersion: 2,
        keys: new Map([
          [1, randomBytes(32)],
          [2, randomBytes(32)],
        ]),
      };
    }
    try {
      return await callback();
    } finally {
      auth.rateLimits = originalPolicies;
      auth.rateLimitPepperKeys = originalPeppers;
    }
  }

  function namedClient(name: string): ReturnType<typeof createPrismaClient> {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('application_name', name);
    return createPrismaClient({ datasourceUrl: url.toString() });
  }

  async function causalInvalidation(options: {
    requestId: string;
    operation: OrganizationTransactionOperation;
    expectedQuery: string;
    block: (tx: Prisma.TransactionClient) => Promise<void>;
    mutate: (tx: Prisma.TransactionClient) => Promise<void>;
    request: () => Promise<Response>;
  }): Promise<Response> {
    const holder = namedClient(`b15_holder_${randomUUID()}`);
    const inspector = namedClient(`b15_inspector_${randomUUID()}`);
    let release!: () => void;
    let signalReady!: (pid: number) => void;
    const signal = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<number>((resolve) => (signalReady = resolve));
    const scope = new CausalWorkScope();
    const held = scope.observe(
      holder.$transaction(
        async (tx) => {
          const backend = await tx.$queryRaw<Array<{ pid: number }>>(
            Prisma.sql`SELECT pg_backend_pid() AS pid`,
          );
          await options.block(tx);
          signalReady(backend[0]!.pid);
          await signal;
          await options.mutate(tx);
        },
        { timeout: 10_000 },
      ),
    );
    let pending: Promise<Response> | undefined;
    try {
      const blockerPid = await scope.wait(ready);
      const receipt = scope.observe(
        transactionObserver.waitFor({
          requestId: options.requestId,
          operation: options.operation,
          attempt: 1,
        }),
      );
      pending = scope.observe(options.request());
      const transaction = await scope.wait(receipt);
      const blocked = await scope.waitForWork(
        waitForQueryBlockedBy(inspector, {
          blockerPid,
          databaseName: process.env.API_TEST_DATABASE_NAME!,
          applicationName: apiApplicationName,
          expectedQuery: options.expectedQuery,
          requestId: options.requestId,
          operation: options.operation,
          attempt: 1,
          transaction,
          diagnosticRoute: 'B1.5',
          allowedWaitEvents: ['transactionid', 'tuple'],
          expectedBlockedPid: transaction.backendPid,
          expectedVirtualTransactionId: transaction.virtualTransactionId,
          timeoutMs: 2_000,
        }),
      );
      expect(blocked.blockingPids).toEqual([blockerPid]);
      release();
      await held;
      return await pending;
    } finally {
      release();
      await held.catch(() => undefined);
      await pending?.catch(() => undefined);
      transactionObserver.clearRequest(options.requestId);
      await scope.settle();
      await Promise.all([holder.$disconnect(), inspector.$disconnect()]);
      expect([
        transactionObserver.eventCount(options.requestId),
        transactionObserver.waiterCount(),
        transactionObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);
    }
  }

  async function causalTokenPair(options: {
    holder?: ReturnType<typeof createPrismaClient>;
    tokenId?: string;
    hold?: (tx: Prisma.TransactionClient) => Promise<void>;
    first: {
      requestId: string;
      operation: OrganizationTransactionOperation;
      query: string;
      run: () => Promise<Response>;
    };
    second: {
      requestId: string;
      operation: OrganizationTransactionOperation;
      query: string;
      run: () => Promise<Response>;
    };
  }): Promise<[Response, Response]> {
    const holder = options.holder ?? namedClient(`b15_token_holder_${randomUUID()}`);
    const inspector = namedClient(`b15_token_inspector_${randomUUID()}`);
    let release!: () => void;
    let ready!: (pid: number) => void;
    const signal = new Promise<void>((resolve) => (release = resolve));
    const blockerReady = new Promise<number>((resolve) => (ready = resolve));
    const scope = new CausalWorkScope();
    const held = scope.observe(
      holder.$transaction(
        async (tx) => {
          const backend = await tx.$queryRaw<Array<{ pid: number }>>(
            Prisma.sql`SELECT pg_backend_pid() AS pid`,
          );
          if (options.hold) await options.hold(tx);
          else if (options.tokenId)
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "account_token" WHERE "id" = ${options.tokenId}::uuid FOR UPDATE`,
            );
          else throw new Error('Falta el lock causal inicial.');
          ready(backend[0]!.pid);
          await signal;
        },
        { timeout: 30_000 },
      ),
    );
    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    try {
      const holderPid = await scope.wait(blockerReady);
      const firstStarted = scope.observe(
        transactionObserver.waitFor({
          requestId: options.first.requestId,
          operation: options.first.operation,
          attempt: 1,
          timeoutMs: 10_000,
        }),
      );
      first = scope.observe(options.first.run());
      const firstReceipt = await scope.wait(firstStarted);
      await scope.waitForWork(
        waitForQueryBlockedBy(inspector, {
          blockerPid: holderPid,
          databaseName: process.env.API_TEST_DATABASE_NAME!,
          applicationName: apiApplicationName,
          expectedQuery: options.first.query,
          requestId: options.first.requestId,
          operation: options.first.operation,
          attempt: 1,
          transaction: firstReceipt,
          allowedWaitEvents: ['transactionid', 'tuple'],
          expectedBlockedPid: firstReceipt.backendPid,
          expectedVirtualTransactionId: firstReceipt.virtualTransactionId,
          timeoutMs: 5_000,
        }),
      );
      const secondStarted = scope.observe(
        transactionObserver.waitFor({
          requestId: options.second.requestId,
          operation: options.second.operation,
          attempt: 1,
          timeoutMs: 10_000,
        }),
      );
      second = scope.observe(options.second.run());
      const secondReceipt = await scope.wait(secondStarted);
      await scope.waitForWork(
        waitForQueryBlockedBy(inspector, {
          blockerPid: firstReceipt.backendPid,
          databaseName: process.env.API_TEST_DATABASE_NAME!,
          applicationName: apiApplicationName,
          expectedQuery: options.second.query,
          requestId: options.second.requestId,
          operation: options.second.operation,
          attempt: 1,
          transaction: secondReceipt,
          allowedWaitEvents: ['transactionid', 'tuple'],
          expectedBlockedPid: secondReceipt.backendPid,
          expectedVirtualTransactionId: secondReceipt.virtualTransactionId,
          timeoutMs: 5_000,
        }),
      );
      release();
      await held;
      return [await first, await second];
    } finally {
      release();
      await held.catch(() => undefined);
      await Promise.all([first?.catch(() => undefined), second?.catch(() => undefined)]);
      transactionObserver.clearRequest(options.first.requestId);
      transactionObserver.clearRequest(options.second.requestId);
      await scope.settle();
      // Un holder inyectado es prestado: su propietario puede tener otra transacción viva.
      await Promise.all([
        ...(options.holder ? [] : [holder.$disconnect()]),
        inspector.$disconnect(),
      ]);
      expect([
        transactionObserver.eventCount(options.first.requestId),
        transactionObserver.eventCount(options.second.requestId),
        transactionObserver.waiterCount(),
        transactionObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0, 0]);
    }
  }

  it.each([false, true])(
    'propaga P2028 del holder y respeta su propietario (aserción fallida: %s)',
    async (failAssertion) => {
      const name = `b15_pool_probe_${randomUUID()}`;
      const url = new URL(process.env.DATABASE_URL!);
      url.searchParams.set('application_name', name);
      url.searchParams.set('connection_limit', '1');
      const holder = createPrismaClient({ datasourceUrl: url.toString() });
      const disconnect = vi.spyOn(holder, '$disconnect');
      const phases: string[] = [];
      const errors: unknown[] = [];
      let release!: () => void;
      let ready!: (pid: number) => void;
      const signal = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<number>((resolve) => {
        ready = resolve;
      });
      let exhausted!: (error: unknown) => void;
      const exhaustion = new Promise<unknown>((resolve) => {
        exhausted = resolve;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let busy: Promise<void> | undefined;
      let result: Promise<{ kind: 'resolved' } | { kind: 'rejected'; error: unknown }> | undefined;
      let backendPid: number | undefined;
      try {
        await holder.$connect();
        busy = holder.$transaction(
          async (tx) => {
            const [backend] = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS pid`;
            ready(backend!.pid);
            await signal;
          },
          { timeout: 10_000 },
        );
        const pid = await Promise.race([
          entered,
          busy.then(() => {
            throw new Error('La sonda terminó antes de ready.');
          }),
        ]);
        backendPid = pid;
        phases.push('busy-ready');
        const original = holder.$transaction.bind(holder);
        const start = vi.spyOn(holder, '$transaction').mockImplementation((callback, options) => {
          const pending = original(callback, { ...options, maxWait: 100 });
          // Observación del rechazo real del motor; no simula SQL ni el error P2028.
          void pending.catch(exhausted);
          return pending;
        });
        const run = vi.fn(async (): Promise<Response> => ({
          status: 204,
          body: undefined,
          retryAfter: null,
        }));
        result = causalTokenPair({
          holder,
          hold: async () => {
            throw new Error('No debe adquirir otra conexión.');
          },
          first: {
            requestId: 'pool-first',
            operation: 'ORGANIZATION_ADMIN_TRANSFER',
            query: '',
            run,
          },
          second: {
            requestId: 'pool-second',
            operation: 'ORGANIZATION_MEMBER_REVOKE',
            query: '',
            run,
          },
        }).then(
          () => ({ kind: 'resolved' as const }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );
        const failure = await exhaustion;
        expect(failure).toMatchObject({ code: 'P2028' });
        phases.push('P2028-real');
        const activity = await database.prisma.$queryRaw<
          Array<{ pid: number; blockers: number[] }>
        >`
        SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE application_name=${name}
      `;
        expect(activity).toEqual([{ pid, blockers: [] }]);
        // El plazo solo detecta una espera huérfana DESPUÉS del P2028 observado.
        const outcome = await Promise.race([
          result,
          new Promise<{ kind: 'orphaned' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'orphaned' }), 1_000);
          }),
        ]);
        expect(outcome).toEqual({ kind: 'rejected', error: failure });
        phases.push('helper-finished');
        expect(disconnect).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
        expect([
          transactionObserver.waiterCount(),
          transactionObserver.activeReceiptCount(),
        ]).toEqual([0, 0]);
        if (failAssertion) expect(false, 'Aserción sintética posterior al P2028 real').toBe(true);
      } catch (error) {
        errors.push(error);
      } finally {
        if (timer) clearTimeout(timer);
        phases.push('owner-release');
        release?.();
        // También se espera el helper si una aserción falló antes de consumir su resultado.
        const settled = await Promise.allSettled([busy, result]);
        for (const outcome of settled)
          if (outcome.status === 'rejected') errors.push(outcome.reason);
        phases.push('busy-finished');
        try {
          await holder.$disconnect();
          phases.push('owner-disconnect');
        } catch (error) {
          errors.push(error);
        }
        expect(disconnect).toHaveBeenCalledOnce();
        vi.restoreAllMocks();
      }
      expect(phases).toEqual([
        'busy-ready',
        'P2028-real',
        'helper-finished',
        'owner-release',
        'busy-finished',
        'owner-disconnect',
      ]);
      const [residual] = await database.prisma.$queryRaw<Array<{ clients: bigint; locks: bigint }>>`
      SELECT (SELECT count(*) FROM pg_stat_activity WHERE application_name=${name}) AS clients,
             (SELECT count(*) FROM pg_locks WHERE pid=${backendPid}) AS locks
    `;
      expect(residual).toEqual({ clients: 0n, locks: 0n });
      if (failAssertion) {
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
        expect((errors[0] as Error).message).toContain(
          'Aserción sintética posterior al P2028 real',
        );
      } else if (errors.length) {
        throw new AggregateError(errors, 'Falló la sonda P2028 o su limpieza.');
      }
    },
    15_000,
  );

  it('crea invitación, acepta por token sin sesión, impide replay y administra la membership', async () => {
    const owner = await actor();
    const recipient = await actor();
    const orgId = await organization(owner);
    const recipientEmail = (
      await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
    ).email;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email: recipientEmail.toUpperCase(), role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const invitationId = created.body?.id;
    if (typeof invitationId !== 'string') throw new Error('Invitación sin ID.');
    const token = await invitationToken(invitationId);
    expect(
      (
        await request(
          'POST',
          `/organization-invitations/${invitationId}/accept`,
          { token },
          undefined,
          null,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request('POST', `/organization-invitations/${invitationId}/accept`, { token })).status,
    ).toBe(204);
    expect(
      (await request('POST', `/organization-invitations/${invitationId}/accept`, { token })).status,
    ).toBe(400);
    const membership = await database.prisma.organizationMember.findFirstOrThrow({
      where: { invitationId, userId: recipient.userId },
    });
    expect(membership.status).toBe('ACTIVE');
    expect(membership.role).toBe('PROFESSIONAL_MEMBER');
    expect(
      (
        await request(
          'PATCH',
          `/organizations/${orgId}/members/${membership.id}/role`,
          { role: 'ADMIN', extra: true },
          owner,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          'PATCH',
          `/organizations/${orgId}/members/${membership.id}/role`,
          { role: 'ADMIN' },
          owner,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await request(
          'POST',
          `/organizations/${orgId}/transfer-administration`,
          { targetMemberId: membership.id, retainCurrentAdmin: false },
          owner,
        )
      ).status,
    ).toBe(204);
    const ownerMember = await database.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgId, userId: owner.userId },
    });
    expect(
      (
        await database.prisma.organizationMember.findUniqueOrThrow({
          where: { id: ownerMember.id },
        })
      ).role,
    ).toBe('PROFESSIONAL_MEMBER');
    expect((await request('POST', `/organizations/${orgId}/leave`, {}, owner)).status).toBe(204);
    expect((await request('POST', `/organizations/${orgId}/leave`, {}, recipient)).status).toBe(
      409,
    );
    expect(
      (await database.prisma.organizationMember.findUniqueOrThrow({ where: { id: membership.id } }))
        .status,
    ).toBe('ACTIVE');
  }, 30_000);

  it('reenvía con generación nueva, rechaza sin cuenta y revoca una invitación distinta', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const email = `b15-${suite.slice(0, 8)}-${randomUUID().slice(0, 16)}@example.test`;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'ADMIN' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const first = await invitationToken(id);
    expect(
      (await request('POST', `/organization-invitations/${id}/resend`, {}, owner)).status,
    ).toBe(204);
    const second = await invitationToken(id);
    expect(second).not.toBe(first);
    expect(
      (await request('POST', `/organization-invitations/${id}/reject`, { token: first })).status,
    ).toBe(400);
    expect(
      (await request('POST', `/organization-invitations/${id}/reject`, { token: second })).status,
    ).toBe(204);
    expect(
      (await request('POST', `/organization-invitations/${id}/reject`, { token: second })).status,
    ).toBe(400);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('REJECTED');
    const another = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      {
        email: `b15-${suite.slice(0, 8)}-${randomUUID().slice(0, 16)}@example.test`,
        role: 'ADMIN',
      },
      owner,
    );
    expect(another.status).toBe(201);
    const anotherId = another.body?.id as string;
    const anotherToken = await invitationToken(anotherId);
    expect(
      (await request('POST', `/organization-invitations/${anotherId}/revoke`, {}, owner)).status,
    ).toBe(204);
    expect(
      (
        await request('POST', `/organization-invitations/${anotherId}/reject`, {
          token: anotherToken,
        })
      ).status,
    ).toBe(400);
    const prior = await database.prisma.accountToken.findFirstOrThrow({
      where: { organizationInvitationId: id, generation: 1 },
      include: { outboxEvents: true },
    });
    expect(prior.revokedAt).not.toBeNull();
    expect(prior.outboxEvents[0]?.status).toBe('OBSOLETE');
  }, 30_000);

  it('serializa dos salidas concurrentes y conserva un ADMIN ACTIVE', async () => {
    const first = await actor();
    const second = await actor();
    const orgId = await organization(first);
    await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: second.userId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    const firstId = `b15-${suite}-${randomUUID()}`;
    const secondId = `b15-${suite}-${randomUUID()}`;
    const results = await causalTokenPair({
      hold: async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`,
        );
      },
      first: {
        requestId: firstId,
        operation: 'ORGANIZATION_MEMBER_LEAVE',
        query: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organizations/${orgId}/leave`,
            {},
            first,
            'http://localhost:3000',
            firstId,
          ),
      },
      second: {
        requestId: secondId,
        operation: 'ORGANIZATION_MEMBER_LEAVE',
        query: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organizations/${orgId}/leave`,
            {},
            second,
            'http://localhost:3000',
            secondId,
          ),
      },
    });
    expect(results.map(({ status }) => status).sort()).toEqual([204, 409]);
    expect(
      await database.prisma.organizationMember.count({
        where: {
          organizationId: orgId,
          status: 'ACTIVE',
          role: 'ADMIN',
        },
      }),
    ).toBe(1);
    expect(
      (await database.prisma.auditEvent.count({ where: { requestId: firstId } })) +
        (await database.prisma.auditEvent.count({ where: { requestId: secondId } })),
    ).toBe(1);
  }, 60_000);

  it('aceptación contra aceptación observa ambos locks causales y consume una vez', async () => {
    const owner = await actor();
    const recipient = await actor();
    const orgId = await organization(owner);
    const email = (
      await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
    ).email;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    const tokenId = (
      await database.prisma.accountToken.findFirstOrThrow({
        where: { organizationInvitationId: id },
      })
    ).id;
    const firstId = `b15-${suite}-${randomUUID()}`;
    const secondId = `b15-${suite}-${randomUUID()}`;
    const [first, second] = await causalTokenPair({
      tokenId,
      first: {
        requestId: firstId,
        operation: 'ORGANIZATION_INVITE_ACCEPT',
        query: 'SELECT "id" FROM "account_token" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organization-invitations/${id}/accept`,
            { token },
            undefined,
            'http://localhost:3000',
            firstId,
          ),
      },
      second: {
        requestId: secondId,
        operation: 'ORGANIZATION_INVITE_ACCEPT',
        query: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organization-invitations/${id}/accept`,
            { token },
            undefined,
            'http://localhost:3000',
            secondId,
          ),
      },
    });
    expect([first.status, second.status]).toEqual([204, 400]);
    expect(
      await database.prisma.organizationMember.count({
        where: { invitationId: id, status: 'ACTIVE' },
      }),
    ).toBe(1);
    expect(
      await database.prisma.auditEvent.count({
        where: { resourceId: id, action: 'ORGANIZATION_INVITATION_ACCEPTED' },
      }),
    ).toBe(1);
    expect(await database.prisma.outboxEvent.count({ where: { accountTokenId: tokenId } })).toBe(1);
    expect(
      (await database.prisma.accountToken.findUniqueOrThrow({ where: { id: tokenId } })).consumedAt,
    ).not.toBeNull();
  }, 60_000);

  it('aceptación contra rechazo observa el lock de token y deja un solo resultado', async () => {
    const owner = await actor();
    const recipient = await actor();
    const orgId = await organization(owner);
    const email = (
      await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
    ).email;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    const tokenId = (
      await database.prisma.accountToken.findFirstOrThrow({
        where: { organizationInvitationId: id },
      })
    ).id;
    const firstId = `b15-${suite}-${randomUUID()}`;
    const secondId = `b15-${suite}-${randomUUID()}`;
    const [first, second] = await causalTokenPair({
      tokenId,
      first: {
        requestId: firstId,
        operation: 'ORGANIZATION_INVITE_ACCEPT',
        query: 'SELECT "id" FROM "account_token" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organization-invitations/${id}/accept`,
            { token },
            undefined,
            'http://localhost:3000',
            firstId,
          ),
      },
      second: {
        requestId: secondId,
        operation: 'ORGANIZATION_INVITE_REJECT',
        query: 'SELECT "id" FROM "account_token" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organization-invitations/${id}/reject`,
            { token },
            undefined,
            'http://localhost:3000',
            secondId,
          ),
      },
    });
    expect([first.status, second.status]).toEqual([204, 400]);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('ACCEPTED');
    expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(1);
    expect(
      await database.prisma.auditEvent.count({
        where: { resourceId: id, action: 'ORGANIZATION_INVITATION_ACCEPTED' },
      }),
    ).toBe(1);
    expect(
      await database.prisma.auditEvent.count({
        where: { resourceId: id, action: 'ORGANIZATION_INVITATION_REJECTED' },
      }),
    ).toBe(0);
  }, 60_000);

  it('aceptación contra revocación administrativa no deja efectos del perdedor', async () => {
    const owner = await actor();
    const recipient = await actor();
    const orgId = await organization(owner);
    const email = (
      await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
    ).email;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    const tokenId = (
      await database.prisma.accountToken.findFirstOrThrow({
        where: { organizationInvitationId: id },
      })
    ).id;
    const firstId = `b15-${suite}-${randomUUID()}`;
    const secondId = `b15-${suite}-${randomUUID()}`;
    const [first, second] = await causalTokenPair({
      tokenId,
      first: {
        requestId: firstId,
        operation: 'ORGANIZATION_INVITE_ACCEPT',
        query: 'SELECT "id" FROM "account_token" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organization-invitations/${id}/accept`,
            { token },
            undefined,
            'http://localhost:3000',
            firstId,
          ),
      },
      second: {
        requestId: secondId,
        operation: 'ORGANIZATION_INVITE_REVOKE',
        query:
          'SELECT "id" FROM "account_token" WHERE "organization_invitation_id" = $1::uuid ORDER BY "id" FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organization-invitations/${id}/revoke`,
            {},
            owner,
            'http://localhost:3000',
            secondId,
          ),
      },
    });
    expect([first.status, second.status]).toEqual([204, 409]);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('ACCEPTED');
    expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(1);
    expect(await database.prisma.auditEvent.count({ where: { requestId: secondId } })).toBe(0);
    expect(await database.prisma.outboxEvent.count({ where: { accountTokenId: tokenId } })).toBe(1);
  }, 60_000);

  for (const response of ['accept', 'reject'] as const) {
    it(`reenvío contra ${response} invalida causalmente la generación anterior`, async () => {
      const owner = await actor();
      const recipient = await actor();
      const orgId = await organization(owner);
      const email = (
        await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
      ).email;
      const created = await request(
        'POST',
        `/organizations/${orgId}/invitations`,
        { email, role: 'PROFESSIONAL_MEMBER' },
        owner,
      );
      expect(created.status).toBe(201);
      const id = created.body?.id as string;
      const oldToken = await invitationToken(id);
      const tokenId = (
        await database.prisma.accountToken.findFirstOrThrow({
          where: { organizationInvitationId: id },
        })
      ).id;
      const firstId = `b15-${suite}-${randomUUID()}`;
      const secondId = `b15-${suite}-${randomUUID()}`;
      const [first, second] = await causalTokenPair({
        tokenId,
        first: {
          requestId: firstId,
          operation: 'ORGANIZATION_INVITE_RESEND',
          query:
            'SELECT "id" FROM "account_token" WHERE "organization_invitation_id" = $1::uuid ORDER BY "id" FOR UPDATE',
          run: () =>
            request(
              'POST',
              `/organization-invitations/${id}/resend`,
              {},
              owner,
              'http://localhost:3000',
              firstId,
            ),
        },
        second: {
          requestId: secondId,
          operation:
            response === 'accept' ? 'ORGANIZATION_INVITE_ACCEPT' : 'ORGANIZATION_INVITE_REJECT',
          query:
            response === 'accept'
              ? 'SELECT "id" FROM "account_token" WHERE "id" = $1::uuid FOR UPDATE'
              : 'SELECT "id" FROM "account_token" WHERE "id" = $1::uuid FOR UPDATE',
          run: () =>
            request(
              'POST',
              `/organization-invitations/${id}/${response}`,
              { token: oldToken },
              undefined,
              'http://localhost:3000',
              secondId,
            ),
        },
      });
      expect([first.status, second.status]).toEqual([204, 400]);
      const invitation = await database.prisma.organizationInvitation.findUniqueOrThrow({
        where: { id },
      });
      expect(invitation.status).toBe('PENDING');
      expect(
        await database.prisma.accountToken.count({
          where: { organizationInvitationId: id, generation: 2 },
        }),
      ).toBe(1);
      expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(
        0,
      );
      expect(await database.prisma.auditEvent.count({ where: { requestId: secondId } })).toBe(0);
      expect(
        await database.prisma.outboxEvent.count({
          where: { accountTokenId: tokenId, status: 'OBSOLETE' },
        }),
      ).toBe(1);
      expect(
        await database.prisma.organizationMember.count({
          where: { organizationId: orgId, status: 'ACTIVE', role: 'ADMIN' },
        }),
      ).toBeGreaterThanOrEqual(1);
    }, 60_000);
  }

  it('reenvío contra revocación serializa dos acciones administrativas', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email: `b15-${randomUUID()}@example.test`, role: 'ADMIN' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const tokenId = (
      await database.prisma.accountToken.findFirstOrThrow({
        where: { organizationInvitationId: id },
      })
    ).id;
    const firstId = `b15-${suite}-${randomUUID()}`;
    const secondId = `b15-${suite}-${randomUUID()}`;
    const [first, second] = await causalTokenPair({
      tokenId,
      first: {
        requestId: firstId,
        operation: 'ORGANIZATION_INVITE_RESEND',
        query:
          'SELECT "id" FROM "account_token" WHERE "organization_invitation_id" = $1::uuid ORDER BY "id" FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organization-invitations/${id}/resend`,
            {},
            owner,
            'http://localhost:3000',
            firstId,
          ),
      },
      second: {
        requestId: secondId,
        operation: 'ORGANIZATION_INVITE_REVOKE',
        query: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organization-invitations/${id}/revoke`,
            {},
            owner,
            'http://localhost:3000',
            secondId,
          ),
      },
    });
    expect([first.status, second.status]).toEqual([204, 204]);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('REVOKED');
    expect(
      await database.prisma.accountToken.count({
        where: { organizationInvitationId: id, generation: 2, revokedAt: { not: null } },
      }),
    ).toBe(1);
    expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(0);
    expect(await database.prisma.auditEvent.count({ where: { requestId: firstId } })).toBe(1);
    expect(await database.prisma.auditEvent.count({ where: { requestId: secondId } })).toBe(1);
  }, 60_000);

  it('oculta recursos ajenos y no permite que un miembro agote el cupo compartido', async () => {
    const owner = await actor();
    const outsider = await actor();
    const professional = await actor();
    const orgId = await organization(owner);
    await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: professional.userId,
        role: 'PROFESSIONAL_MEMBER',
        status: 'ACTIVE',
      },
    });
    const before = await database.prisma.authRateLimit.count({
      where: { action: 'ORGANIZATION_INVITE' },
    });
    const body = { email: `b15-${randomUUID().slice(0, 16)}@example.test`, role: 'ADMIN' };
    expect(
      (await request('POST', `/organizations/${orgId}/invitations`, body, outsider)).status,
    ).toBe(404);
    expect(
      (await request('POST', `/organizations/${orgId}/invitations`, body, professional)).status,
    ).toBe(403);
    expect(
      await database.prisma.authRateLimit.count({ where: { action: 'ORGANIZATION_INVITE' } }),
    ).toBe(before);
    expect(
      (await request('POST', `/organizations/${orgId}/invitations?x=1`, body, owner)).status,
    ).toBe(400);
    expect(
      (
        await request(
          'POST',
          `/organizations/${orgId}/invitations`,
          { ...body, userId: outsider.userId },
          owner,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          'POST',
          `/organizations/${orgId}/transfer-administration`,
          { targetMemberId: randomUUID() },
          owner,
        )
      ).status,
    ).toBe(400);
    expect(
      (await request('POST', `/organizations/${orgId}/leave`, { memberId: randomUUID() }, owner))
        .status,
    ).toBe(400);
  }, 30_000);

  it('limita crear por ACTOR/ORGANIZATION/ACTOR_ORGANIZATION con pepper rotado', async () => {
    const owner = await actor();
    const outsider = await actor();
    const orgId = await organization(owner);
    const names: AuthRateLimitPolicyName[] = [
      'ORGANIZATION_INVITE_ACTOR',
      'ORGANIZATION_INVITE_ORGANIZATION',
      'ORGANIZATION_INVITE_ACTOR_ORGANIZATION',
    ];
    await withRatePolicies(
      names,
      { limit: 2, windowSeconds: 120, blockSeconds: 120 },
      async () => {
        const before = await database.prisma.authRateLimit.findMany({
          where: { action: 'ORGANIZATION_INVITE' },
          select: { id: true },
        });
        const body = () => ({ email: `limit-${randomUUID()}@example.test`, role: 'ADMIN' });
        expect(
          (await request('POST', `/organizations/${orgId}/invitations`, body(), outsider)).status,
        ).toBe(404);
        for (let index = 0; index < 2; index += 1)
          expect(
            (await request('POST', `/organizations/${orgId}/invitations`, body(), owner)).status,
          ).toBe(201);
        const blocked = await request('POST', `/organizations/${orgId}/invitations`, body(), owner);
        expect(blocked.status).toBe(429);
        expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
        expect(Number(blocked.retryAfter)).toBeLessThanOrEqual(120);
        const buckets = await database.prisma.authRateLimit.findMany({
          where: { action: 'ORGANIZATION_INVITE', id: { notIn: before.map(({ id }) => id) } },
        });
        expect(buckets).toHaveLength(6);
        expect(new Set(buckets.map(({ dimension }) => dimension))).toEqual(
          new Set(['ACTOR', 'ORGANIZATION', 'ACTOR_ORGANIZATION']),
        );
        expect(new Set(buckets.map(({ pepperVersion }) => pepperVersion))).toEqual(new Set([1, 2]));
        expect(
          buckets.every(
            ({ attemptCount, subjectDigest }) => attemptCount === 3 && subjectDigest.length === 32,
          ),
        ).toBe(true);
        expect(
          buckets.every(
            ({ subjectDigest }) =>
              !Buffer.from(subjectDigest).includes(Buffer.from(owner.userId)) &&
              !Buffer.from(subjectDigest).includes(Buffer.from(orgId)),
          ),
        ).toBe(true);
      },
      true,
    );
  }, 30_000);

  it('limita resend por sus tres dimensiones y mantiene la generación al bloquear', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email: `resend-${randomUUID()}@example.test`, role: 'ADMIN' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const names: AuthRateLimitPolicyName[] = [
      'ORGANIZATION_INVITE_RESEND_ACTOR',
      'ORGANIZATION_INVITE_RESEND_ORGANIZATION',
      'ORGANIZATION_INVITE_RESEND_ACTOR_ORGANIZATION',
    ];
    await withRatePolicies(names, { limit: 2, windowSeconds: 120, blockSeconds: 120 }, async () => {
      for (let index = 0; index < 2; index += 1)
        expect(
          (await request('POST', `/organization-invitations/${id}/resend`, {}, owner)).status,
        ).toBe(204);
      const blocked = await request('POST', `/organization-invitations/${id}/resend`, {}, owner);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
      expect(Number(blocked.retryAfter)).toBeLessThanOrEqual(120);
      expect(
        (
          await database.prisma.accountToken.findMany({
            where: { organizationInvitationId: id },
            orderBy: { generation: 'asc' },
          })
        ).map(({ generation }) => generation),
      ).toEqual([1, 2, 3]);
    });
  }, 30_000);

  it('aísla el bucket compartido de Organization y el bucket ACTOR_ORGANIZATION', async () => {
    const owner = await actor();
    const second = await actor();
    const third = await actor();
    const outsider = await actor();
    const orgId = await organization(owner);
    const otherOrgId = await organization(owner);
    for (const member of [second, third]) {
      await database.prisma.organizationMember.create({
        data: { organizationId: orgId, userId: member.userId, role: 'ADMIN', status: 'ACTIVE' },
      });
    }
    const auth = app.get<AuthConfig>(AUTH_CONFIG);
    const original = auth.rateLimits;
    auth.rateLimits = {
      ...original,
      ORGANIZATION_INVITE_ACTOR: { limit: 20, windowSeconds: 120, blockSeconds: 120 },
      ORGANIZATION_INVITE_ORGANIZATION: { limit: 2, windowSeconds: 120, blockSeconds: 120 },
      ORGANIZATION_INVITE_ACTOR_ORGANIZATION: { limit: 20, windowSeconds: 120, blockSeconds: 120 },
    };
    const body = () => ({ email: `shared-${randomUUID()}@example.test`, role: 'ADMIN' });
    try {
      expect(
        (await request('POST', `/organizations/${orgId}/invitations`, body(), owner)).status,
      ).toBe(201);
      expect(
        (await request('POST', `/organizations/${orgId}/invitations`, body(), second)).status,
      ).toBe(201);
      const before = await database.prisma.authRateLimit.findMany({
        where: { action: 'ORGANIZATION_INVITE', dimension: 'ORGANIZATION' },
      });
      expect(
        (await request('POST', `/organizations/${orgId}/invitations`, body(), outsider)).status,
      ).toBe(404);
      const after = await database.prisma.authRateLimit.findMany({
        where: { action: 'ORGANIZATION_INVITE', dimension: 'ORGANIZATION' },
      });
      expect(after.map(({ id, attemptCount }) => [id, attemptCount])).toEqual(
        before.map(({ id, attemptCount }) => [id, attemptCount]),
      );
      expect(
        (await request('POST', `/organizations/${orgId}/invitations`, body(), third)).status,
      ).toBe(429);
      expect(
        (await request('POST', `/organizations/${otherOrgId}/invitations`, body(), owner)).status,
      ).toBe(201);
      auth.rateLimits = {
        ...original,
        ORGANIZATION_INVITE_ACTOR: { limit: 20, windowSeconds: 120, blockSeconds: 120 },
        ORGANIZATION_INVITE_ORGANIZATION: { limit: 20, windowSeconds: 120, blockSeconds: 120 },
        ORGANIZATION_INVITE_ACTOR_ORGANIZATION: { limit: 1, windowSeconds: 120, blockSeconds: 120 },
      };
      const fresh = await actor();
      const freshOrg = await organization(fresh);
      const freshOtherOrg = await organization(fresh);
      expect(
        (await request('POST', `/organizations/${freshOrg}/invitations`, body(), fresh)).status,
      ).toBe(201);
      expect(
        (await request('POST', `/organizations/${freshOrg}/invitations`, body(), fresh)).status,
      ).toBe(429);
      expect(
        (await request('POST', `/organizations/${freshOtherOrg}/invitations`, body(), fresh))
          .status,
      ).toBe(201);
    } finally {
      auth.rateLimits = original;
    }
  }, 30_000);

  it('limita accept y reject por TOKEN/IP/TOKEN_IP sin compartir IP entre casos', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    for (const decision of ['accept', 'reject'] as const) {
      const created = await request(
        'POST',
        `/organizations/${orgId}/invitations`,
        { email: `${decision}-${randomUUID()}@example.test`, role: 'ADMIN' },
        owner,
      );
      expect(created.status).toBe(201);
      const id = created.body?.id as string;
      const token = await invitationToken(id);
      const ip = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;
      const prefix =
        decision === 'accept' ? 'ORGANIZATION_INVITATION_ACCEPT' : 'ORGANIZATION_INVITATION_REJECT';
      const names = [
        `${prefix}_TOKEN`,
        `${prefix}_IP`,
        `${prefix}_TOKEN_IP`,
      ] as AuthRateLimitPolicyName[];
      await withRatePolicies(
        names,
        { limit: 2, windowSeconds: 120, blockSeconds: 120 },
        async () => {
          const send = () =>
            request(
              'POST',
              `/organization-invitations/${id}/${decision}`,
              { token },
              undefined,
              'http://localhost:3000',
              `b15-${suite}-${randomUUID()}`,
              ip,
            );
          expect((await send()).status).toBe(decision === 'reject' ? 204 : 400);
          expect((await send()).status).toBe(400);
          const blocked = await send();
          expect(blocked.status).toBe(429);
          expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
          expect(Number(blocked.retryAfter)).toBeLessThanOrEqual(120);
          const buckets = await database.prisma.authRateLimit.findMany({
            where: { action: prefix },
          });
          expect(new Set(buckets.map(({ dimension }) => dimension))).toEqual(
            new Set(['TOKEN', 'IP', 'TOKEN_IP']),
          );
          expect(
            buckets.every(
              ({ subjectDigest }) =>
                subjectDigest.length === 32 &&
                !Buffer.from(subjectDigest).includes(Buffer.from(ip)) &&
                !Buffer.from(subjectDigest).includes(Buffer.from(token)),
            ),
          ).toBe(true);
        },
      );
    }
  }, 30_000);

  it('aísla IP y TOKEN_IP y aplica el incremento concurrente atómico', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const tokens: Array<{ id: string; token: string }> = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await request(
        'POST',
        `/organizations/${orgId}/invitations`,
        { email: `ip-${randomUUID()}@example.test`, role: 'ADMIN' },
        owner,
      );
      expect(created.status).toBe(201);
      const id = created.body?.id as string;
      tokens.push({ id, token: await invitationToken(id) });
    }
    const auth = app.get<AuthConfig>(AUTH_CONFIG);
    const original = auth.rateLimits;
    const ip = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;
    const send = (entry: { id: string; token: string }, address: string) =>
      request(
        'POST',
        `/organization-invitations/${entry.id}/accept`,
        { token: entry.token },
        undefined,
        'http://localhost:3000',
        `b15-${suite}-${randomUUID()}`,
        address,
      );
    try {
      auth.rateLimits = {
        ...original,
        ORGANIZATION_INVITATION_ACCEPT_TOKEN: { limit: 20, windowSeconds: 120, blockSeconds: 120 },
        ORGANIZATION_INVITATION_ACCEPT_IP: { limit: 2, windowSeconds: 120, blockSeconds: 120 },
        ORGANIZATION_INVITATION_ACCEPT_TOKEN_IP: {
          limit: 20,
          windowSeconds: 120,
          blockSeconds: 120,
        },
      };
      expect((await send(tokens[0]!, ip)).status).toBe(400);
      expect((await send(tokens[1]!, ip)).status).toBe(400);
      expect((await send(tokens[2]!, ip)).status).toBe(429);
      const otherIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;
      expect((await send(tokens[2]!, otherIp)).status).toBe(400);
      auth.rateLimits = {
        ...original,
        ORGANIZATION_INVITATION_ACCEPT_TOKEN: { limit: 20, windowSeconds: 120, blockSeconds: 120 },
        ORGANIZATION_INVITATION_ACCEPT_IP: { limit: 20, windowSeconds: 120, blockSeconds: 120 },
        ORGANIZATION_INVITATION_ACCEPT_TOKEN_IP: {
          limit: 1,
          windowSeconds: 120,
          blockSeconds: 120,
        },
      };
      const thirdIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;
      const parallel = await Promise.all([send(tokens[0]!, thirdIp), send(tokens[0]!, thirdIp)]);
      expect(parallel.map(({ status }) => status).sort()).toEqual([400, 429]);
      expect(
        (
          await send(
            tokens[0]!,
            `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`,
          )
        ).status,
      ).toBe(400);
    } finally {
      auth.rateLimits = original;
    }
  }, 30_000);

  it('falla cerrado con 503 si PostgreSQL no está disponible para rate limiting público', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    expect(url.pathname).toBe(`/${process.env.API_TEST_DATABASE_NAME}`);
    url.port = '1';
    const unavailable = createPrismaClient({ datasourceUrl: url.toString() });
    const rateService = app.get(AuthRateLimitService);
    const originalConsume = rateService.consume;
    const isolated = new AuthRateLimitService(
      { prisma: unavailable } as unknown as DatabaseService,
      app.get<AuthConfig>(AUTH_CONFIG),
      new SystemClock(),
    );
    rateService.consume = isolated.consume.bind(isolated);
    try {
      const result = await request(
        'POST',
        `/organization-invitations/${randomUUID()}/accept`,
        { token: 'invalid' },
        undefined,
        'http://localhost:3000',
        `b15-${suite}-${randomUUID()}`,
        `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`,
      );
      expect(result.status).toBe(503);
      expect(result.body?.error).toEqual({
        code: 'SECURITY_DEPENDENCY_UNAVAILABLE',
        message: 'La autenticación no está disponible temporalmente.',
      });
    } finally {
      rateService.consume = originalConsume;
      await unavailable.$disconnect();
    }
  }, 30_000);

  it('mantiene usable el token hasta que exista el usuario verificado y revierte al fallar auditoría', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const future = await actor();
    const email = (await database.prisma.user.findUniqueOrThrow({ where: { id: future.userId } }))
      .email;
    await database.prisma.user.update({
      where: { id: future.userId },
      data: { emailVerifiedAt: null },
    });
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    expect(
      (await request('POST', `/organization-invitations/${id}/accept`, { token })).status,
    ).toBe(400);
    expect(
      (
        await database.prisma.accountToken.findFirstOrThrow({
          where: { organizationInvitationId: id },
        })
      ).consumedAt,
    ).toBeNull();
    await database.prisma.user.update({
      where: { id: future.userId },
      data: { emailVerifiedAt: new Date() },
    });
    expect(
      (await request('POST', `/organization-invitations/${id}/accept`, { token })).status,
    ).toBe(204);
    const failingRequestId = `b15-${suite}-${randomUUID()}`;
    await withAuditFailureFixture(
      database.prisma,
      { requestId: failingRequestId, failures: 1, sqlState: 'P0001' },
      async () => {
        const failed = await request(
          'POST',
          `/organizations/${orgId}/invitations`,
          { email: `b15-${randomUUID().slice(0, 16)}@example.test`, role: 'ADMIN' },
          owner,
          'http://localhost:3000',
          failingRequestId,
        );
        expect(failed.status).toBe(503);
      },
    );
    expect(
      await database.prisma.organizationInvitation.count({ where: { organizationId: orgId } }),
    ).toBe(1);
    expect(
      await database.prisma.outboxEvent.count({ where: { correlationId: failingRequestId } }),
    ).toBe(0);
  }, 30_000);

  it('permite transferir a otro ADMIN con degradación y bloquea revocaciones cruzadas', async () => {
    const first = await actor();
    const second = await actor();
    const orgId = await organization(first);
    const firstMember = await database.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgId, userId: first.userId },
    });
    const secondMember = await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: second.userId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    expect(
      (
        await request(
          'POST',
          `/organizations/${orgId}/transfer-administration`,
          { targetMemberId: secondMember.id, retainCurrentAdmin: true },
          first,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          'POST',
          `/organizations/${orgId}/transfer-administration`,
          { targetMemberId: secondMember.id, retainCurrentAdmin: false },
          first,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await database.prisma.organizationMember.findUniqueOrThrow({
          where: { id: firstMember.id },
        })
      ).role,
    ).toBe('PROFESSIONAL_MEMBER');
    expect(
      (
        await request(
          'POST',
          `/organizations/${orgId}/members/${secondMember.id}/revoke`,
          {},
          first,
        )
      ).status,
    ).toBe(403);
    const third = await actor();
    const thirdMember = await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: third.userId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    const results = await Promise.all([
      request('POST', `/organizations/${orgId}/members/${thirdMember.id}/revoke`, {}, second),
      request('POST', `/organizations/${orgId}/members/${secondMember.id}/revoke`, {}, third),
    ]);
    expect(results.some(({ status }) => status === 204)).toBe(true);
    expect(results.some(({ status }) => status === 404 || status === 409)).toBe(true);
    expect(
      await database.prisma.organizationMember.count({
        where: {
          organizationId: orgId,
          status: 'ACTIVE',
          role: 'ADMIN',
        },
      }),
    ).toBe(1);
  }, 30_000);

  it('serializa invitaciones duplicadas y reenvíos concurrentes sin repetir generación', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const body = { email: `b15-${randomUUID().slice(0, 16)}@example.test`, role: 'ADMIN' };
    const created = await Promise.all([
      request('POST', `/organizations/${orgId}/invitations`, body, owner),
      request('POST', `/organizations/${orgId}/invitations`, body, owner),
    ]);
    expect(created.map(({ status }) => status).sort()).toEqual([201, 409]);
    const id = created.find(({ status }) => status === 201)?.body?.id as string;
    expect(
      await database.prisma.organizationInvitation.count({
        where: {
          organizationId: orgId,
          email: body.email,
          status: 'PENDING',
        },
      }),
    ).toBe(1);
    const resent = await Promise.all([
      request('POST', `/organization-invitations/${id}/resend`, {}, owner),
      request('POST', `/organization-invitations/${id}/resend`, {}, owner),
    ]);
    expect(resent.map(({ status }) => status)).toEqual([204, 204]);
    const tokens = await database.prisma.accountToken.findMany({
      where: { organizationInvitationId: id },
      orderBy: { generation: 'asc' },
    });
    expect(tokens.map(({ generation }) => generation)).toEqual([1, 2, 3]);
    expect(tokens.filter(({ revokedAt }) => revokedAt === null)).toHaveLength(1);
    expect(
      await database.prisma.outboxEvent.count({
        where: {
          accountTokenId: { in: tokens.map(({ id: tokenId }) => tokenId) },
          status: 'PENDING',
        },
      }),
    ).toBe(1);
  }, 30_000);

  it('preserva un lease PROCESSING vigente al reenviar', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email: `b15-${randomUUID().slice(0, 16)}@example.test`, role: 'ADMIN' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const prior = await database.prisma.accountToken.findFirstOrThrow({
      where: { organizationInvitationId: id },
      orderBy: { generation: 'desc' },
    });
    const leaseToken = randomUUID();
    const now = new Date();
    await database.prisma.outboxEvent.updateMany({
      where: { accountTokenId: prior.id },
      data: {
        status: 'PROCESSING',
        lockedAt: now,
        lockedUntil: new Date(now.getTime() + 60_000),
        lockedBy: 'b15-worker',
        lockToken: leaseToken,
      },
    });
    expect(
      (await request('POST', `/organization-invitations/${id}/resend`, {}, owner)).status,
    ).toBe(204);
    const event = await database.prisma.outboxEvent.findFirstOrThrow({
      where: { accountTokenId: prior.id },
    });
    expect(event.status).toBe('PROCESSING');
    expect(event.lockToken).toBe(leaseToken);
    expect(event.lockedBy).toBe('b15-worker');
    expect(
      (await database.prisma.accountToken.findUniqueOrThrow({ where: { id: prior.id } })).revokedAt,
    ).not.toBeNull();
  }, 30_000);

  it('serializa degradaciones cruzadas y transferencia frente a salida del destino', async () => {
    const first = await actor();
    const second = await actor();
    const orgId = await organization(first);
    const firstMember = await database.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgId, userId: first.userId },
    });
    const secondMember = await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: second.userId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    const demotions = await Promise.all([
      request(
        'PATCH',
        `/organizations/${orgId}/members/${secondMember.id}/role`,
        { role: 'PROFESSIONAL_MEMBER' },
        first,
      ),
      request(
        'PATCH',
        `/organizations/${orgId}/members/${firstMember.id}/role`,
        { role: 'PROFESSIONAL_MEMBER' },
        second,
      ),
    ]);
    expect(demotions.some(({ status }) => status === 204)).toBe(true);
    expect(demotions.some(({ status }) => status === 403 || status === 409)).toBe(true);
    expect(
      await database.prisma.organizationMember.count({
        where: {
          organizationId: orgId,
          status: 'ACTIVE',
          role: 'ADMIN',
        },
      }),
    ).toBe(1);

    const admin =
      (
        await database.prisma.organizationMember.findFirstOrThrow({
          where: { organizationId: orgId, status: 'ACTIVE', role: 'ADMIN' },
        })
      ).userId === first.userId
        ? first
        : second;
    const third = await actor();
    const thirdMember = await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: third.userId,
        role: 'PROFESSIONAL_MEMBER',
        status: 'ACTIVE',
      },
    });
    const race = await Promise.all([
      request(
        'POST',
        `/organizations/${orgId}/transfer-administration`,
        { targetMemberId: thirdMember.id, retainCurrentAdmin: false },
        admin,
      ),
      request('POST', `/organizations/${orgId}/leave`, {}, third),
    ]);
    expect(race.some(({ status }) => status === 204)).toBe(true);
    expect(race.some(({ status }) => status === 404 || status === 409)).toBe(true);
    expect(
      await database.prisma.organizationMember.count({
        where: {
          organizationId: orgId,
          status: 'ACTIVE',
          role: 'ADMIN',
        },
      }),
    ).toBe(1);
  }, 30_000);

  it('abre dos transacciones reales sin esperar la resolución IPv6 de localhost', async () => {
    const scope = new CausalWorkScope();
    const pids: number[] = [];
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const signal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transactions = [0, 1].map(() =>
      scope.observe(
        database.prisma.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          pids.push(row!.pid);
          if (pids.length === 2) ready();
          await signal;
        }),
      ),
    );
    try {
      await scope.wait(entered);
      expect(new Set(pids).size).toBe(2);
    } finally {
      release();
      await scope.settle();
    }
    await Promise.all(transactions);
    const [residual] = await database.prisma.$queryRaw<Array<{ transactions: bigint }>>`
      SELECT count(*) AS transactions FROM pg_stat_activity
      WHERE pid IN (${Prisma.join(pids)}) AND pid<>pg_backend_pid() AND xact_start IS NOT NULL
    `;
    expect(residual?.transactions).toBe(0n);
  });

  it.each(['transfer', 'revoke'] as const)(
    'revalida destino revocado y organización suspendida bajo los locks: %s primero',
    async (winner) => {
      const first = await actor();
      const second = await actor();
      const target = await actor();
      const orgId = await organization(first);
      await database.prisma.organizationMember.create({
        data: { organizationId: orgId, userId: second.userId, role: 'ADMIN', status: 'ACTIVE' },
      });
      const targetMember = await database.prisma.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: target.userId,
          role: 'PROFESSIONAL_MEMBER',
          status: 'ACTIVE',
        },
      });
      const transferId = `b15-${suite}-${randomUUID()}`;
      const revokeId = `b15-${suite}-${randomUUID()}`;
      const events: Record<string, unknown>[] = [];
      const originalStarted = transactionObserver.transactionStarted.bind(transactionObserver);
      const started = vi
        .spyOn(transactionObserver, 'transactionStarted')
        .mockImplementation((event) => {
          events.push({
            phase: 'transaction-started',
            operation: event.operation,
            attempt: event.attempt,
            pid: event.backendPid,
            virtualTransactionId: event.virtualTransactionId,
          });
          originalStarted(event);
        });
      // Observadores pass-through: no cambian resultados, espera máxima ni política de retry.
      const originalTransaction = database.prisma.$transaction.bind(database.prisma);
      const transactions = vi
        .spyOn(database.prisma, '$transaction')
        .mockImplementation((callback, options) => {
          const pending = originalTransaction(callback, options);
          void pending.catch((error: unknown) => {
            const structured = error as { code?: string; meta?: { code?: string } };
            events.push({
              phase: 'transaction-rejected',
              code: structured.code,
              sqlState: structured.meta?.code,
            });
          });
          return pending;
        });
      const completed = (operation: string) => (response: Response) => {
        events.push({
          phase: 'response',
          operation,
          status: response.status,
          code: (response.body?.error as { code?: string } | undefined)?.code ?? null,
        });
        return response;
      };
      try {
        const commands = {
          transfer: {
            requestId: transferId,
            operation: 'ORGANIZATION_ADMIN_TRANSFER' as const,
            run: () =>
              request(
                'POST',
                `/organizations/${orgId}/transfer-administration`,
                { targetMemberId: targetMember.id, retainCurrentAdmin: false },
                first,
                'http://localhost:3000',
                transferId,
              ).then(completed('transfer')),
          },
          revoke: {
            requestId: revokeId,
            operation: 'ORGANIZATION_MEMBER_REVOKE' as const,
            run: () =>
              request(
                'POST',
                `/organizations/${orgId}/members/${targetMember.id}/revoke`,
                {},
                second,
                'http://localhost:3000',
                revokeId,
              ).then(completed('revoke')),
          },
        };
        const follower = winner === 'transfer' ? 'revoke' : 'transfer';
        // Dos bloqueos reales comprobados por PID y transacción virtual:
        // holder -> ganador (Organization), ganador -> seguidor (User).
        const [winningResponse, followingResponse] = await causalTokenPair({
          hold: async (tx) => {
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`,
            );
          },
          first: {
            ...commands[winner],
            query: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
          },
          second: {
            ...commands[follower],
            query: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
          },
        });
        const members = await database.prisma.organizationMember.findMany({
          where: { organizationId: orgId },
          select: { userId: true, role: true, status: true },
        });
        const audits = await database.prisma.auditEvent.findMany({
          where: { requestId: { in: [transferId, revokeId] } },
          select: { action: true, requestId: true },
          orderBy: { occurredAt: 'asc' },
        });
        const finalMembers = Object.fromEntries(
          members.map(({ userId, ...member }) => [
            userId === first.userId ? 'first' : userId === second.userId ? 'second' : 'target',
            member,
          ]),
        );
        const diagnostic = JSON.stringify({
          winner,
          events,
          members: finalMembers,
          audits: audits.map(({ action, requestId }) => ({
            action,
            operation: requestId === transferId ? 'transfer' : 'revoke',
          })),
        });
        process.stdout.write(`B15_CAUSAL_RACE ${diagnostic}\n`);
        expect([winningResponse.status, followingResponse.status], diagnostic).toEqual(
          winner === 'transfer' ? [204, 204] : [204, 404],
        );
        expect(finalMembers, diagnostic).toEqual({
          first: {
            role: winner === 'transfer' ? 'PROFESSIONAL_MEMBER' : 'ADMIN',
            status: 'ACTIVE',
          },
          second: { role: 'ADMIN', status: 'ACTIVE' },
          target: {
            role: winner === 'transfer' ? 'ADMIN' : 'PROFESSIONAL_MEMBER',
            status: 'REVOKED',
          },
        });
        expect(audits.filter(({ requestId }) => requestId === transferId)).toHaveLength(
          winner === 'transfer' ? 1 : 0,
        );
        expect(audits.filter(({ requestId }) => requestId === revokeId)).toHaveLength(1);
        expect(audits.map(({ action }) => action)).toEqual(
          winner === 'transfer'
            ? ['ORGANIZATION_ADMIN_TRANSFERRED', 'ORGANIZATION_MEMBER_REVOKED']
            : ['ORGANIZATION_MEMBER_REVOKED'],
        );
        expect(
          events.some(({ sqlState }) => sqlState === '40001'),
          diagnostic,
        ).toBe(true);
        const attempts = events.filter(
          (event) =>
            event.phase === 'transaction-started' &&
            event.operation === commands[follower].operation,
        );
        expect(
          attempts.map(({ attempt }) => attempt),
          diagnostic,
        ).toEqual([1, 2]);
        expect(attempts[0]!.virtualTransactionId).not.toBe(attempts[1]!.virtualTransactionId);
        expect(
          events.some(({ code }) => code === 'P2028'),
          diagnostic,
        ).toBe(false);
      } finally {
        started.mockRestore();
        transactions.mockRestore();
      }
      await database.prisma.organization.update({
        where: { id: orgId },
        data: { status: 'SUSPENDED' },
      });
      const before = await database.prisma.auditEvent.count({ where: { resourceId: orgId } });
      expect((await request('POST', `/organizations/${orgId}/leave`, {}, second)).status).toBe(403);
      expect(
        (
          await request(
            'POST',
            `/organizations/${orgId}/invitations`,
            { email: `b15-${randomUUID().slice(0, 16)}@example.test`, role: 'ADMIN' },
            second,
          )
        ).status,
      ).toBe(403);
      expect(await database.prisma.auditEvent.count({ where: { resourceId: orgId } })).toBe(before);
    },
    30_000,
  );

  it('revierte ambos roles si falla la auditoría de transferencia', async () => {
    const owner = await actor();
    const target = await actor();
    const orgId = await organization(owner);
    const ownerMember = await database.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgId, userId: owner.userId },
    });
    const targetMember = await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: target.userId,
        role: 'PROFESSIONAL_MEMBER',
        status: 'ACTIVE',
      },
    });
    const requestId = `b15-${suite}-${randomUUID()}`;
    await withAuditFailureFixture(
      database.prisma,
      { requestId, failures: 1, sqlState: 'P0001' },
      async () => {
        const result = await request(
          'POST',
          `/organizations/${orgId}/transfer-administration`,
          { targetMemberId: targetMember.id, retainCurrentAdmin: false },
          owner,
          'http://localhost:3000',
          requestId,
        );
        expect(result.status).toBe(503);
      },
    );
    expect(
      (
        await database.prisma.organizationMember.findUniqueOrThrow({
          where: { id: ownerMember.id },
        })
      ).role,
    ).toBe('ADMIN');
    expect(
      (
        await database.prisma.organizationMember.findUniqueOrThrow({
          where: { id: targetMember.id },
        })
      ).role,
    ).toBe('PROFESSIONAL_MEMBER');
    expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
  }, 30_000);

  it('materializa EXPIRED solo tras validar el token y bloquea la aceptación', async () => {
    const owner = await actor();
    const recipient = await actor();
    const orgId = await organization(owner);
    const email = (
      await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
    ).email;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    await database.prisma.organizationInvitation.update({
      where: { id },
      data: {
        createdAt: new Date(Date.now() - 86_400_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    expect(
      (
        await request('POST', `/organization-invitations/${id}/accept`, {
          token: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
        })
      ).status,
    ).toBe(400);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PENDING');
    expect(
      (await request('POST', `/organization-invitations/${id}/accept`, { token })).status,
    ).toBe(400);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('EXPIRED');
    expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(0);
  }, 30_000);

  it('rechaza mutaciones individuales de claims sin efectos de dominio', async () => {
    const owner = await actor();
    const recipient = await actor();
    const orgId = await organization(owner);
    const otherOrgId = await organization(owner);
    const email = (
      await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
    ).email;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    const accountToken = await database.prisma.accountToken.findFirstOrThrow({
      where: { organizationInvitationId: id },
    });
    const auditBefore = await database.prisma.auditEvent.count({ where: { resourceId: id } });
    const outboxBefore = await database.prisma.outboxEvent.count({
      where: { accountTokenId: accountToken.id },
    });
    const assertUnchanged = async () => {
      expect(
        (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('PENDING');
      expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(
        0,
      );
      expect(await database.prisma.auditEvent.count({ where: { resourceId: id } })).toBe(
        auditBefore,
      );
      expect(
        await database.prisma.outboxEvent.count({ where: { accountTokenId: accountToken.id } }),
      ).toBe(outboxBefore);
      expect(
        (await database.prisma.accountToken.findUniqueOrThrow({ where: { id: accountToken.id } }))
          .consumedAt,
      ).toBeNull();
    };
    for (const data of [
      { organizationId: otherOrgId },
      { email: `other-${randomUUID()}@example.test` },
      { role: 'ADMIN' as const },
    ]) {
      try {
        await database.prisma.organizationInvitation.update({ where: { id }, data });
        expect(
          (await request('POST', `/organization-invitations/${id}/accept`, { token })).status,
        ).toBe(400);
        await assertUnchanged();
      } finally {
        await database.prisma.organizationInvitation.update({
          where: { id },
          data: { organizationId: orgId, email, role: 'PROFESSIONAL_MEMBER' },
        });
      }
    }
    try {
      await database.prisma.accountToken.update({
        where: { id: accountToken.id },
        data: { generation: 2 },
      });
      expect(
        (await request('POST', `/organization-invitations/${id}/accept`, { token })).status,
      ).toBe(400);
      await assertUnchanged();
    } finally {
      await database.prisma.accountToken.update({
        where: { id: accountToken.id },
        data: { generation: 1 },
      });
    }
    expect(
      (await request('POST', `/organization-invitations/${randomUUID()}/accept`, { token })).status,
    ).toBe(400);
    await assertUnchanged();
  }, 30_000);

  it('expira un token auténtico sin User y revierte toda escritura si falla la auditoría', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const email = `future-${randomUUID()}@example.test`;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'ADMIN' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    await database.prisma.organizationInvitation.update({
      where: { id },
      data: {
        createdAt: new Date(Date.now() - 86_400_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const failingRequestId = `b15-${suite}-${randomUUID()}`;
    await withAuditFailureFixture(
      database.prisma,
      { requestId: failingRequestId, failures: 1, sqlState: 'P0001' },
      async () => {
        expect(
          (
            await request(
              'POST',
              `/organization-invitations/${id}/accept`,
              { token },
              undefined,
              'http://localhost:3000',
              failingRequestId,
            )
          ).status,
        ).toBe(503);
      },
    );
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PENDING');
    expect(
      (
        await database.prisma.accountToken.findFirstOrThrow({
          where: { organizationInvitationId: id },
        })
      ).revokedAt,
    ).toBeNull();
    expect(await database.prisma.auditEvent.count({ where: { requestId: failingRequestId } })).toBe(
      0,
    );
    expect(
      (await request('POST', `/organization-invitations/${id}/accept`, { token })).status,
    ).toBe(400);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('EXPIRED');
    expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(0);
    expect(
      (await request('POST', `/organization-invitations/${id}/accept`, { token })).status,
    ).toBe(400);
  }, 30_000);

  it('expiración concurrente contra aceptación se decide tras el lock causal', async () => {
    const owner = await actor();
    const recipient = await actor();
    const orgId = await organization(owner);
    const email = (
      await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
    ).email;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    const tokenId = (
      await database.prisma.accountToken.findFirstOrThrow({
        where: { organizationInvitationId: id },
      })
    ).id;
    const requestId = `b15-${suite}-${randomUUID()}`;
    const result = await causalInvalidation({
      requestId,
      operation: 'ORGANIZATION_INVITE_ACCEPT',
      expectedQuery: 'SELECT "id" FROM "account_token" WHERE "id" = $1::uuid FOR UPDATE',
      block: async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "account_token" WHERE "id" = ${tokenId}::uuid FOR UPDATE`,
        );
      },
      mutate: async (tx) => {
        await tx.organizationInvitation.update({
          where: { id },
          data: {
            createdAt: new Date(Date.now() - 86_400_000),
            expiresAt: new Date(Date.now() - 1_000),
          },
        });
      },
      request: () =>
        request(
          'POST',
          `/organization-invitations/${id}/accept`,
          { token },
          undefined,
          'http://localhost:3000',
          requestId,
        ),
    });
    expect(result.status).toBe(400);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('EXPIRED');
    expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(0);
    expect(
      await database.prisma.auditEvent.count({
        where: { resourceId: id, action: 'ORGANIZATION_INVITATION_EXPIRED' },
      }),
    ).toBe(1);
    expect(
      await database.prisma.auditEvent.count({
        where: { resourceId: id, action: 'ORGANIZATION_INVITATION_ACCEPTED' },
      }),
    ).toBe(0);
    expect(
      await database.prisma.organizationMember.count({
        where: { organizationId: orgId, status: 'ACTIVE', role: 'ADMIN' },
      }),
    ).toBe(1);
  }, 30_000);

  it('materializa EXPIRED aunque el User invitado no esté verificado', async () => {
    const owner = await actor();
    const recipient = await actor();
    await database.prisma.user.update({
      where: { id: recipient.userId },
      data: { emailVerifiedAt: null },
    });
    const orgId = await organization(owner);
    const email = (
      await database.prisma.user.findUniqueOrThrow({ where: { id: recipient.userId } })
    ).email;
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email, role: 'PROFESSIONAL_MEMBER' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const token = await invitationToken(id);
    await database.prisma.organizationInvitation.update({
      where: { id },
      data: {
        createdAt: new Date(Date.now() - 86_400_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    expect(
      (await request('POST', `/organization-invitations/${id}/accept`, { token })).status,
    ).toBe(400);
    expect(
      (await database.prisma.organizationInvitation.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('EXPIRED');
    expect(await database.prisma.organizationMember.count({ where: { invitationId: id } })).toBe(0);
    expect(
      await database.prisma.auditEvent.count({
        where: { resourceId: id, action: 'ORGANIZATION_INVITATION_EXPIRED' },
      }),
    ).toBe(1);
  }, 30_000);

  it('impide UPDATE y DELETE reales sobre AuditEvent B1.5', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const created = await request(
      'POST',
      `/organizations/${orgId}/invitations`,
      { email: `audit-${randomUUID()}@example.test`, role: 'ADMIN' },
      owner,
    );
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const event = await database.prisma.auditEvent.findFirstOrThrow({
      where: { resourceId: id, action: 'ORGANIZATION_INVITATION_REQUESTED' },
    });
    await expect(
      database.prisma.auditEvent.update({ where: { id: event.id }, data: { action: 'MUTATED' } }),
    ).rejects.toThrow();
    await expect(database.prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    expect(
      (await database.prisma.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).action,
    ).toBe('ORGANIZATION_INVITATION_REQUESTED');
  }, 30_000);

  it('serializa dos transferencias al mismo destino y termina con un administrador', async () => {
    const first = await actor();
    const second = await actor();
    const target = await actor();
    const orgId = await organization(first);
    await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: second.userId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    const targetMember = await database.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: target.userId,
        role: 'PROFESSIONAL_MEMBER',
        status: 'ACTIVE',
      },
    });
    const body = { targetMemberId: targetMember.id, retainCurrentAdmin: false };
    const firstId = `b15-${suite}-${randomUUID()}`;
    const secondId = `b15-${suite}-${randomUUID()}`;
    const results = await causalTokenPair({
      hold: async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`,
        );
      },
      first: {
        requestId: firstId,
        operation: 'ORGANIZATION_ADMIN_TRANSFER',
        query: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organizations/${orgId}/transfer-administration`,
            body,
            first,
            'http://localhost:3000',
            firstId,
          ),
      },
      second: {
        requestId: secondId,
        operation: 'ORGANIZATION_ADMIN_TRANSFER',
        query: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'POST',
            `/organizations/${orgId}/transfer-administration`,
            body,
            second,
            'http://localhost:3000',
            secondId,
          ),
      },
    });
    expect(results.map(({ status }) => status)).toEqual([204, 204]);
    const members = await database.prisma.organizationMember.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
    });
    expect(members.filter(({ role }) => role === 'ADMIN').map(({ userId }) => userId)).toEqual([
      target.userId,
    ]);
    expect(await database.prisma.auditEvent.count({ where: { requestId: firstId } })).toBe(1);
    expect(await database.prisma.auditEvent.count({ where: { requestId: secondId } })).toBe(1);
  }, 60_000);

  for (const action of ['leave', 'revoke'] as const) {
    it(`transferencia frente a ${action} del destino observa el bloqueo causal`, async () => {
      const owner = await actor();
      const secondAdmin = await actor();
      const target = await actor();
      const orgId = await organization(owner);
      await database.prisma.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: secondAdmin.userId,
          role: 'ADMIN',
          status: 'ACTIVE',
        },
      });
      const targetMember = await database.prisma.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: target.userId,
          role: 'PROFESSIONAL_MEMBER',
          status: 'ACTIVE',
        },
      });
      const firstId = `b15-${suite}-${randomUUID()}`;
      const secondId = `b15-${suite}-${randomUUID()}`;
      const [first, second] = await causalTokenPair({
        hold: async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`,
          );
        },
        first: {
          requestId: firstId,
          operation: 'ORGANIZATION_ADMIN_TRANSFER',
          query: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
          run: () =>
            request(
              'POST',
              `/organizations/${orgId}/transfer-administration`,
              { targetMemberId: targetMember.id, retainCurrentAdmin: false },
              owner,
              'http://localhost:3000',
              firstId,
            ),
        },
        second: {
          requestId: secondId,
          operation:
            action === 'leave' ? 'ORGANIZATION_MEMBER_LEAVE' : 'ORGANIZATION_MEMBER_REVOKE',
          query: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
          run: () =>
            action === 'leave'
              ? request(
                  'POST',
                  `/organizations/${orgId}/leave`,
                  {},
                  target,
                  'http://localhost:3000',
                  secondId,
                )
              : request(
                  'POST',
                  `/organizations/${orgId}/members/${targetMember.id}/revoke`,
                  {},
                  secondAdmin,
                  'http://localhost:3000',
                  secondId,
                ),
        },
      });
      expect([first.status, second.status]).toEqual([204, 204]);
      expect(
        (
          await database.prisma.organizationMember.findUniqueOrThrow({
            where: { id: targetMember.id },
          })
        ).status,
      ).not.toBe('ACTIVE');
      expect(
        await database.prisma.organizationMember.count({
          where: { organizationId: orgId, status: 'ACTIVE', role: 'ADMIN' },
        }),
      ).toBe(1);
      expect(await database.prisma.auditEvent.count({ where: { requestId: firstId } })).toBe(1);
      expect(await database.prisma.auditEvent.count({ where: { requestId: secondId } })).toBe(1);
    }, 60_000);
  }

  it('degradaciones cruzadas conservan un administrador tras el bloqueo causal', async () => {
    const first = await actor();
    const second = await actor();
    const orgId = await organization(first);
    const firstMember = await database.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: orgId, userId: first.userId },
    });
    const secondMember = await database.prisma.organizationMember.create({
      data: { organizationId: orgId, userId: second.userId, role: 'ADMIN', status: 'ACTIVE' },
    });
    const firstId = `b15-${suite}-${randomUUID()}`;
    const secondId = `b15-${suite}-${randomUUID()}`;
    const [one, two] = await causalTokenPair({
      hold: async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`,
        );
      },
      first: {
        requestId: firstId,
        operation: 'ORGANIZATION_MEMBER_ROLE',
        query: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'PATCH',
            `/organizations/${orgId}/members/${secondMember.id}/role`,
            { role: 'PROFESSIONAL_MEMBER' },
            first,
            'http://localhost:3000',
            firstId,
          ),
      },
      second: {
        requestId: secondId,
        operation: 'ORGANIZATION_MEMBER_ROLE',
        query: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
        run: () =>
          request(
            'PATCH',
            `/organizations/${orgId}/members/${firstMember.id}/role`,
            { role: 'PROFESSIONAL_MEMBER' },
            second,
            'http://localhost:3000',
            secondId,
          ),
      },
    });
    expect([one.status, two.status]).toEqual([204, 403]);
    expect(
      await database.prisma.organizationMember.count({
        where: { organizationId: orgId, status: 'ACTIVE', role: 'ADMIN' },
      }),
    ).toBe(1);
    expect(await database.prisma.auditEvent.count({ where: { requestId: firstId } })).toBe(1);
    expect(await database.prisma.auditEvent.count({ where: { requestId: secondId } })).toBe(0);
  }, 60_000);

  for (const status of ['SUSPENDED', 'ARCHIVED'] as const) {
    it(`revalida Organization ${status} tras bloqueo causal`, async () => {
      const owner = await actor();
      const orgId = await organization(owner);
      const requestId = `b15-${suite}-${randomUUID()}`;
      const response = await causalInvalidation({
        requestId,
        operation: 'ORGANIZATION_MEMBER_LEAVE',
        expectedQuery: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
        block: async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${orgId}::uuid FOR UPDATE`,
          );
        },
        mutate: async (tx) => {
          await tx.organization.update({ where: { id: orgId }, data: { status } });
        },
        request: () =>
          request(
            'POST',
            `/organizations/${orgId}/leave`,
            {},
            owner,
            'http://localhost:3000',
            requestId,
          ),
      });
      expect(response.status).toBe(403);
      expect(
        (await database.prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).status,
      ).toBe(status);
      expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
      expect(
        await database.prisma.organizationMember.count({
          where: { organizationId: orgId, role: 'ADMIN', status: 'ACTIVE' },
        }),
      ).toBe(1);
    }, 30_000);
  }

  it('revalida revocación de sesión bajo su lock causal', async () => {
    const owner = await actor();
    const orgId = await organization(owner);
    const session = await database.prisma.session.findFirstOrThrow({
      where: { userId: owner.userId },
    });
    const requestId = `b15-${suite}-${randomUUID()}`;
    const response = await causalInvalidation({
      requestId,
      operation: 'ORGANIZATION_MEMBER_LEAVE',
      expectedQuery: 'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
      block: async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "session" WHERE "id" = ${session.id}::uuid FOR UPDATE`,
        );
      },
      mutate: async (tx) => {
        await tx.session.update({
          where: { id: session.id },
          data: { revokedAt: new Date(), revocationReason: 'ADMIN_REVOKED' },
        });
      },
      request: () =>
        request(
          'POST',
          `/organizations/${orgId}/leave`,
          {},
          owner,
          'http://localhost:3000',
          requestId,
        ),
    });
    expect(response.status).toBe(401);
    expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
    expect(
      await database.prisma.organizationMember.count({
        where: { organizationId: orgId, role: 'ADMIN', status: 'ACTIVE' },
      }),
    ).toBe(1);
  }, 30_000);

  for (const change of ['SESSION_VERSION', 'SUSPENDED', 'DEACTIVATED'] as const) {
    it(`revalida User ${change} bajo su lock causal`, async () => {
      const owner = await actor();
      const orgId = await organization(owner);
      const requestId = `b15-${suite}-${randomUUID()}`;
      const response = await causalInvalidation({
        requestId,
        operation: 'ORGANIZATION_MEMBER_LEAVE',
        expectedQuery: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
        block: async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${owner.userId}::uuid FOR UPDATE`,
          );
        },
        mutate: async (tx) => {
          await tx.user.update({
            where: { id: owner.userId },
            data:
              change === 'SESSION_VERSION'
                ? { sessionVersion: { increment: 1 } }
                : { status: change },
          });
        },
        request: () =>
          request(
            'POST',
            `/organizations/${orgId}/leave`,
            {},
            owner,
            'http://localhost:3000',
            requestId,
          ),
      });
      expect(response.status).toBe(401);
      expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
      expect(
        await database.prisma.organizationMember.count({
          where: { organizationId: orgId, role: 'ADMIN', status: 'ACTIVE' },
        }),
      ).toBe(1);
    }, 30_000);
  }
});
