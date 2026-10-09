import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';
import { createPrismaClient, Prisma } from '@benhouse/database';
import type { PrismaClient } from '@benhouse/database';
import { AppModule } from '../app.module';
import { configureApplication } from '../main';
import { DatabaseService } from '../infrastructure/database/database.service';
import { createSessionToken, sessionSecretDigest } from '../auth/session-token';
import { deriveCsrfToken } from '../auth/csrf';
import { MarketplaceTransactionObserver } from './marketplace-transaction-observer';
import {
  TestOrganizationTransactionObserver,
  matchingBlockedQueries,
  type BlockedQueryObservation,
  waitForQueryBlockedBy,
  withAuditFailureFixture,
} from '../organizations/postgres-test-fixtures';

type Actor = { userId: string; sessionId: string; cookie: string; csrf: string };
type ApiResponse = { status: number; body: unknown };

describe('B1.6 Property & Draft Listing Core HTTP/PostgreSQL', () => {
  let app: NestExpressApplication;
  let database: DatabaseService;
  let baseUrl: string;
  let cookieName: string;
  let priorDatabaseUrl: string | undefined;
  const suite = randomUUID();
  const requestPrefix = `b16-${suite}`;
  const observer = new TestOrganizationTransactionObserver();
  const apiApplicationName = `b16_api_${suite}`;
  let databaseName: string;
  const userIds = new Set<string>();
  const propertyIds = new Set<string>();
  const organizationIds = new Set<string>();

  beforeAll(async () => {
    loadLocalEnvironmentFile();
    priorDatabaseUrl = process.env.DATABASE_URL;
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) throw new Error('TEST_DATABASE_URL no disponible.');
    const url = new URL(testUrl);
    url.searchParams.set('application_name', apiApplicationName);
    process.env.DATABASE_URL = url.toString();
    const config = readAppConfig();
    cookieName = config.auth.sessionCookieName;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MarketplaceTransactionObserver)
      .useValue(observer)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    configureApplication(app, config);
    await app.listen(0, '127.0.0.1');
    database = app.get(DatabaseService);
    const identity = await database.prisma.$queryRaw<Array<{ name: string }>>(
      Prisma.sql`SELECT current_database() AS name`,
    );
    databaseName = identity[0]?.name ?? '';
    expect(databaseName).toBe('benhouse_test');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Puerto de test no disponible.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    expect([observer.eventCount(), observer.waiterCount(), observer.activeReceiptCount()]).toEqual([
      0, 0, 0,
    ]);
    if (database) {
      await database.prisma.$transaction(async (tx) => {
        const properties = [...propertyIds];
        const organizations = [...organizationIds];
        const users = [...userIds];
        await tx.listing.deleteMany({ where: { propertyId: { in: properties } } });
        await tx.propertyAuthorization.deleteMany({ where: { propertyId: { in: properties } } });
        await tx.property.deleteMany({ where: { id: { in: properties } } });
        await tx.organizationMember.deleteMany({
          where: { organizationId: { in: organizations } },
        });
        await tx.organization.deleteMany({ where: { id: { in: organizations } } });
        await tx.session.deleteMany({ where: { userId: { in: users } } });
        await tx.$executeRaw(Prisma.sql`SET LOCAL session_replication_role = replica`);
        await tx.auditEvent.deleteMany({ where: { requestId: { startsWith: requestPrefix } } });
        await tx.$executeRaw(Prisma.sql`SET LOCAL session_replication_role = origin`);
        await tx.user.deleteMany({ where: { id: { in: users } } });
      });
    }
    await app?.close();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  async function request(
    method: string,
    path: string,
    options: {
      actor?: Actor;
      body?: unknown;
      origin?: string | null;
      csrf?: string | null;
      requestId?: string;
    } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.origin !== null) headers.origin = options.origin ?? 'http://localhost:3000';
    if (options.actor) headers.cookie = `${cookieName}=${options.actor.cookie}`;
    const csrf = options.csrf === undefined ? options.actor?.csrf : options.csrf;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (options.requestId) headers['x-request-id'] = options.requestId;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  async function createActor(): Promise<Actor> {
    const now = new Date();
    const user = await database.prisma.user.create({
      data: {
        email: `b16-${suite}-${randomUUID()}@example.test`,
        displayName: 'Actor sintético B1.6',
        status: 'ACTIVE',
        emailVerifiedAt: now,
      },
    });
    userIds.add(user.id);
    const config = readAppConfig();
    const token = createSessionToken();
    const digest = sessionSecretDigest(
      token.selector,
      token.secret,
      config.auth.sessionTokenKeys.currentVersion,
      config.auth.sessionTokenKeys,
    )!;
    await database.prisma.session.create({
      data: {
        id: token.selector,
        secretDigest: new Uint8Array(digest),
        secretKeyVersion: config.auth.sessionTokenKeys.currentVersion,
        userId: user.id,
        issuedSessionVersion: user.sessionVersion,
        createdAt: now,
        lastActivityAt: now,
        idleExpiresAt: new Date(now.getTime() + 300_000),
        absoluteExpiresAt: new Date(now.getTime() + 600_000),
      },
    });
    return {
      userId: user.id,
      sessionId: token.selector,
      cookie: token.value,
      csrf: deriveCsrfToken(token.selector, user.sessionVersion, config.auth.csrfKeys),
    };
  }

  async function createProperty(actor: Actor, suffix: string = randomUUID()) {
    const response = await request('POST', '/properties', {
      actor,
      requestId: `${requestPrefix}-property-${suffix}`,
      body: { type: 'APARTMENT', builtArea: '90.50', usableArea: '80.00', rooms: 3 },
    });
    expect(response.status).toBe(201);
    const property = response.body as { id: string; capabilities: string[]; status: string };
    propertyIds.add(property.id);
    return property;
  }

  async function grant(
    owner: Actor,
    propertyId: string,
    body: Record<string, unknown>,
    suffix: string = randomUUID(),
  ) {
    return request('POST', `/properties/${propertyId}/authorizations`, {
      actor: owner,
      body,
      requestId: `${requestPrefix}-grant-${suffix}`,
    });
  }

  async function createNamedClient(applicationName: string): Promise<PrismaClient> {
    const source = process.env.DATABASE_URL;
    if (!source) throw new Error('DATABASE_URL no disponible.');
    const url = new URL(source);
    url.searchParams.set('application_name', applicationName);
    url.searchParams.set('connection_limit', '1');
    const prior = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    const client = createPrismaClient();
    process.env.DATABASE_URL = prior;
    await client.$connect();
    return client;
  }

  it.each([
    ['until-without-from', { availableUntil: '2027-03-31T00:00:00Z' }],
    ['invalid-calendar-from', { availableFrom: '2027-02-30T00:00:00Z' }],
    [
      'invalid-calendar-until',
      { availableFrom: '2027-02-01T00:00:00Z', availableUntil: '2027-02-30T00:00:00Z' },
    ],
  ])('rechaza fechas de creación %s sin Listing ni auditoría', async (suffix, dates) => {
    const actor = await createActor();
    const property = await createProperty(actor);
    const requestId = `${requestPrefix}-date-create-${suffix}`;
    const response = await request('POST', '/listings', {
      actor,
      requestId,
      body: {
        propertyId: property.id,
        transactionType: 'SALE',
        price: '1000',
        currency: 'EUR',
        description: 'Fechas sintéticas B1.6',
        ...dates,
      },
    });
    expect.soft(response.status).toBe(400);
    expect
      .soft(await database.prisma.listing.count({ where: { propertyId: property.id } }))
      .toBe(0);
    expect.soft(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
  });

  it.each(['availableFrom', 'availableUntil'])(
    'rechaza calendario inválido en PATCH %s sin cambios ni auditoría',
    async (field) => {
      const actor = await createActor();
      const property = await createProperty(actor);
      const created = await request('POST', '/listings', {
        actor,
        requestId: `${requestPrefix}-date-patch-create-${field}`,
        body: {
          propertyId: property.id,
          transactionType: 'SALE',
          price: '1000',
          currency: 'EUR',
          description: 'Fechas sintéticas B1.6',
          availableFrom: '2027-02-01T00:00:00Z',
          availableUntil: '2027-03-31T00:00:00Z',
        },
      });
      expect(created.status).toBe(201);
      const id = (created.body as { id: string }).id;
      const before = await database.prisma.listing.findUniqueOrThrow({ where: { id } });
      const requestId = `${requestPrefix}-date-patch-invalid-${field}`;
      const response = await request('PATCH', `/listings/${id}`, {
        actor,
        requestId,
        body: { [field]: '2027-02-30T00:00:00Z' },
      });
      expect.soft(response.status).toBe(400);
      expect
        .soft(await database.prisma.listing.findUniqueOrThrow({ where: { id } }))
        .toEqual(before);
      expect
        .soft(await database.prisma.listing.count({ where: { propertyId: property.id } }))
        .toBe(1);
      expect.soft(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
    },
  );

  it.each([null, '2028-02-29T00:00:00.1Z'])(
    'valida el intervalo resultante de PATCH parcial con inicio %s',
    async (availableFrom) => {
      const actor = await createActor();
      const property = await createProperty(actor);
      const suffix = availableFrom ? 'with-start' : 'without-start';
      const created = await request('POST', '/listings', {
        actor,
        requestId: `${requestPrefix}-date-partial-create-${suffix}`,
        body: {
          propertyId: property.id,
          transactionType: 'SALE',
          price: '1000',
          currency: 'EUR',
          description: 'Fechas sintéticas B1.6',
          availableFrom,
        },
      });
      expect(created.status).toBe(201);
      const id = (created.body as { id: string }).id;
      const before = await database.prisma.listing.findUniqueOrThrow({ where: { id } });
      const requestId = `${requestPrefix}-date-partial-patch-${suffix}`;
      const response = await request('PATCH', `/listings/${id}`, {
        actor,
        requestId,
        body: { availableUntil: '2028-03-31T00:00:00Z' },
      });
      expect(response.status).toBe(availableFrom ? 200 : 400);
      const after = await database.prisma.listing.findUniqueOrThrow({ where: { id } });
      expect(after).toMatchObject(
        availableFrom
          ? {
              availableFrom: before.availableFrom,
              availableUntil: new Date('2028-03-31T00:00:00Z'),
            }
          : before,
      );
      expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(
        availableFrom ? 1 : 0,
      );
      if (availableFrom) {
        const invalidRequestId = `${requestId}-clear-start`;
        expect(
          (
            await request('PATCH', `/listings/${id}`, {
              actor,
              requestId: invalidRequestId,
              body: { availableFrom: null },
            })
          ).status,
        ).toBe(400);
        expect(await database.prisma.listing.findUniqueOrThrow({ where: { id } })).toEqual(after);
        expect(
          await database.prisma.auditEvent.count({ where: { requestId: invalidRequestId } }),
        ).toBe(0);
      }
    },
  );

  async function startAndWaitBlocked<T>(options: {
    requestId: string;
    operation:
      | 'PROPERTY_UPDATE'
      | 'PROPERTY_AUTHORIZATION_GRANT'
      | 'PROPERTY_AUTHORIZATION_REVOKE'
      | 'LISTING_CREATE'
      | 'LISTING_UPDATE'
      | 'ORGANIZATION_MEMBER_REVOKE';
    blockerPid: number;
    expectedQuery: string;
    start: () => Promise<T>;
    prepareExpiry?: () => Promise<Date>;
  }): Promise<{ pending: Promise<T> }> {
    const diagnostic = await createNamedClient(`b16_observer_${randomUUID()}`);
    const expiresAt = await options.prepareExpiry?.();
    const transactionStarted = observer.waitFor({
      requestId: options.requestId,
      operation: options.operation,
      attempt: 1,
    });
    const pending = options.start();
    try {
      const transaction = await transactionStarted;
      const expectation = {
        blockerPid: options.blockerPid,
        databaseName,
        applicationName: apiApplicationName,
        expectedQuery: options.expectedQuery,
        requestId: options.requestId,
        operation: options.operation,
        attempt: 1,
        transaction,
        expectedBlockedPid: transaction.backendPid,
        expectedVirtualTransactionId: transaction.virtualTransactionId,
        allowedWaitEvents: ['transactionid', 'tuple'],
        timeoutMs: 3_000,
      };
      const blocked = await waitForQueryBlockedBy(diagnostic, expectation);
      if (expiresAt) {
        const deadline = Date.now() + 4_000;
        let expired = false;
        while (Date.now() < deadline) {
          const rows = await diagnostic.$queryRaw<
            Array<BlockedQueryObservation & { observedAt: Date }>
          >`SELECT pid,
            (SELECT virtualtransaction::text FROM pg_locks
             WHERE pid = activity.pid AND locktype = 'virtualxid' AND granted)
              AS "virtualTransactionId",
            datname AS "databaseName", application_name AS "applicationName",
            wait_event_type AS "waitEventType", wait_event AS "waitEvent", state, query,
            pg_blocking_pids(pid) AS "blockingPids", clock_timestamp() AS "observedAt"
            FROM pg_stat_activity AS activity WHERE pid = ${blocked.pid}`;
          expect(matchingBlockedQueries(rows, expectation)).toHaveLength(1);
          const row = rows[0]!;
          if (row.observedAt >= expiresAt) {
            console.info(
              'B16_POST_LOCK_CAUSAL',
              JSON.stringify({
                requestId: options.requestId,
                operation: options.operation,
                pid: row.pid,
                vxid: row.virtualTransactionId,
                blockerPid: options.blockerPid,
                query: row.query,
                waitEvent: row.waitEvent,
                expiresAt,
                observedAt: row.observedAt,
              }),
            );
            expired = true;
            break;
          }
        }
        expect(expired).toBe(true);
      }
      return { pending };
    } finally {
      await diagnostic.$disconnect();
    }
  }

  it.each([
    'listing-personal',
    'property-update',
    'authorization-grant',
    'authorization-revoke',
    'listing-organization',
    'listing-update',
  ] as const)(
    'rechaza sesión expirada durante lock: %s',
    async (scenario) => {
      const actor = await createActor();
      const subject = await createActor();
      const suffix = `post-lock-${scenario}-${randomUUID()}`;
      const requestId = `${requestPrefix}-${suffix}`;
      let propertyId: string | undefined;
      let organizationId: string | undefined;
      let blocker: PrismaClient | undefined;
      let blockingTransaction: Promise<void> | undefined;
      let pending: Promise<ApiResponse> | undefined;
      let release = () => {};
      try {
        propertyId = (await createProperty(actor, suffix)).id;
        let path = '/listings';
        let method = 'POST';
        let operation:
          | 'PROPERTY_UPDATE'
          | 'PROPERTY_AUTHORIZATION_GRANT'
          | 'PROPERTY_AUTHORIZATION_REVOKE'
          | 'LISTING_CREATE'
          | 'LISTING_UPDATE' = 'LISTING_CREATE';
        let body: Record<string, unknown> = {
          propertyId,
          transactionType: 'SALE',
          price: '250000.00',
          currency: 'EUR',
          description: 'Regresión sintética de sesión B1.6',
        };
        let listingId: string | undefined;
        if (scenario === 'property-update') {
          operation = 'PROPERTY_UPDATE';
          method = 'PATCH';
          path = `/properties/${propertyId}`;
          body = { rooms: 9 };
        } else if (scenario === 'authorization-grant') {
          operation = 'PROPERTY_AUTHORIZATION_GRANT';
          path = `/properties/${propertyId}/authorizations`;
          body = { userId: subject.userId, authorizationType: 'MANAGER' };
        } else if (scenario === 'authorization-revoke') {
          const authorization = await database.prisma.propertyAuthorization.create({
            data: {
              propertyId,
              userId: subject.userId,
              authorizationType: 'PUBLISHER',
              grantedByUserId: actor.userId,
            },
          });
          operation = 'PROPERTY_AUTHORIZATION_REVOKE';
          path = `/property-authorizations/${authorization.id}/revoke`;
          body = {};
        } else if (scenario === 'listing-organization') {
          const organization = await database.prisma.organization.create({
            data: {
              name: 'Organización sintética post-lock',
              createdByUserId: actor.userId,
              members: { create: { userId: actor.userId, role: 'ADMIN' } },
            },
          });
          organizationId = organization.id;
          organizationIds.add(organizationId);
          await database.prisma.propertyAuthorization.create({
            data: {
              propertyId,
              organizationId,
              authorizationType: 'PUBLISHER',
              grantedByUserId: actor.userId,
            },
          });
          body.organizationId = organizationId;
        } else if (scenario === 'listing-update') {
          const listing = await database.prisma.listing.create({
            data: {
              propertyId,
              publisherUserId: actor.userId,
              transactionType: 'SALE',
              price: '250000.00',
              currency: 'EUR',
              description: 'Listing sintético intacto',
            },
          });
          listingId = listing.id;
          operation = 'LISTING_UPDATE';
          method = 'PATCH';
          path = `/listings/${listingId}`;
          body = { price: '300000.00' };
        }
        // Una autorización vencida permite comprobar también que expireAuthorizations no confirma.
        const clock = await database.prisma.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`;
        await database.prisma.propertyAuthorization.create({
          data: {
            propertyId,
            userId: subject.userId,
            authorizationType: 'MANAGER',
            grantedByUserId: actor.userId,
            validFrom: new Date(clock[0]!.now.getTime() - 20_000),
            validUntil: new Date(clock[0]!.now.getTime() - 10_000),
          },
        });
        const snapshot = async () => ({
          property: await database.prisma.property.findUnique({ where: { id: propertyId } }),
          authorizations: await database.prisma.propertyAuthorization.findMany({
            where: { propertyId },
            orderBy: { id: 'asc' },
          }),
          listings: await database.prisma.listing.findMany({
            where: { propertyId },
            orderBy: { id: 'asc' },
          }),
        });
        const before = await snapshot();
        const blockerName = `b16_expiry_${randomUUID()}`;
        blocker = await createNamedClient(blockerName);
        let announce!: (pid: number) => void;
        let rejectReady!: (error: unknown) => void;
        const ready = new Promise<number>((resolve, reject) => {
          announce = resolve;
          rejectReady = reject;
        });
        const releaseSignal = new Promise<void>((resolve) => {
          release = resolve;
        });
        blockingTransaction = blocker.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            // El blocker de Listing no toma Property: eso impediría alcanzar el último lock.
            if (listingId)
              await tx.$queryRaw`SELECT "id" FROM "listing" WHERE "id" = ${listingId}::uuid FOR UPDATE`;
            else if (organizationId)
              await tx.$queryRaw`SELECT "id" FROM "organization" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
            else {
              await tx.$queryRaw`SELECT "id" FROM "property" WHERE "id" = ${propertyId}::uuid FOR UPDATE`;
              await tx.$queryRaw`SELECT "id" FROM "property_authorization" WHERE "property_id" = ${propertyId}::uuid ORDER BY "id" FOR UPDATE`;
            }
            announce(rows[0]!.pid);
            await releaseSignal;
          },
          { timeout: 10_000 },
        );
        void blockingTransaction.catch(rejectReady);
        const blockerPid = await ready;
        // Configurar antes de iniciar la petición; nunca modificar Session bajo su lock.
        const expectedQuery = listingId
          ? 'SELECT "id" FROM "listing" WHERE "id" = $1::uuid FOR UPDATE'
          : organizationId
            ? 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE'
            : 'SELECT "id" FROM "property" WHERE "id" = $1::uuid FOR UPDATE';
        await startAndWaitBlocked({
          requestId,
          operation,
          blockerPid,
          expectedQuery,
          prepareExpiry: async () => {
            const expiry = await database.prisma.$queryRaw<Array<{ expiresAt: Date }>>`
            UPDATE "session" SET idle_expires_at = clock_timestamp() + interval '2 seconds'
            WHERE id = ${actor.sessionId}::uuid RETURNING idle_expires_at AS "expiresAt"`;
            return expiry[0]!.expiresAt;
          },
          start: () => {
            pending = request(method, path, { actor, body, requestId });
            return pending;
          },
        });
        release();
        await blockingTransaction;
        const response = await pending!;
        const after = await snapshot();
        const audits = await database.prisma.auditEvent.count({ where: { requestId } });
        console.info(
          'B16_POST_LOCK_RESULT',
          JSON.stringify({
            requestId,
            status: response.status,
            listingDelta: after.listings.length - before.listings.length,
            audits,
          }),
        );
        expect(response.status).toBe(401);
        expect(response.body).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
        expect(after).toEqual(before);
        expect(audits).toBe(0);
        const residual = await database.prisma.$queryRaw<
          Array<{ transactions: bigint; waiting: bigint }>
        >`
        SELECT (SELECT count(*) FROM pg_stat_activity WHERE application_name IN (${apiApplicationName}, ${blockerName})
          AND pid <> pg_backend_pid() AND xact_start IS NOT NULL) AS transactions,
          (SELECT count(*) FROM pg_locks WHERE pid = ${blockerPid} AND NOT granted) AS waiting`;
        expect(residual).toEqual([{ transactions: 0n, waiting: 0n }]);
      } finally {
        release();
        await blockingTransaction?.catch(() => undefined);
        await pending?.catch(() => undefined);
        await blocker?.$disconnect();
        observer.clearRequest(requestId);
        await database.prisma.$transaction(async (tx) => {
          if (propertyId) {
            await tx.listing.deleteMany({ where: { propertyId } });
            await tx.propertyAuthorization.deleteMany({ where: { propertyId } });
            await tx.property.deleteMany({ where: { id: propertyId } });
          }
          if (organizationId) {
            await tx.organizationMember.deleteMany({ where: { organizationId } });
            await tx.organization.deleteMany({ where: { id: organizationId } });
          }
          await tx.session.deleteMany({
            where: { userId: { in: [actor.userId, subject.userId] } },
          });
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await tx.auditEvent.deleteMany({
            where: { actorUserId: { in: [actor.userId, subject.userId] } },
          });
          await tx.$executeRaw`SET LOCAL session_replication_role = origin`;
          await tx.user.deleteMany({ where: { id: { in: [actor.userId, subject.userId] } } });
        });
        expect([
          observer.eventCount(),
          observer.waiterCount(),
          observer.activeReceiptCount(),
        ]).toEqual([0, 0, 0]);
      }
    },
    20_000,
  );

  it('control POST Property rechaza sesión ya expirada sin efectos', async () => {
    const actor = await createActor();
    const requestId = `${requestPrefix}-expired-property-control`;
    try {
      await database.prisma.$executeRaw`UPDATE "session" SET idle_expires_at = clock_timestamp()
        WHERE id = ${actor.sessionId}::uuid`;
      const response = await request('POST', '/properties', {
        actor,
        requestId,
        body: { type: 'HOUSE' },
      });
      expect(response.status).toBe(401);
      expect(
        await database.prisma.propertyAuthorization.count({
          where: { grantedByUserId: actor.userId },
        }),
      ).toBe(0);
      expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
    } finally {
      await database.prisma.session.deleteMany({ where: { userId: actor.userId } });
      await database.prisma.user.delete({ where: { id: actor.userId } });
    }
  });

  it('protege mutaciones con sesión, Origin, CSRF y body allowlisted', async () => {
    const actor = await createActor();
    expect((await request('POST', '/properties', { body: { type: 'HOUSE' } })).status).toBe(401);
    expect(
      (await request('POST', '/properties', { actor, origin: null, body: { type: 'HOUSE' } }))
        .status,
    ).toBe(403);
    expect(
      (await request('POST', '/properties', { actor, csrf: null, body: { type: 'HOUSE' } })).status,
    ).toBe(403);
    expect(
      (
        await request('POST', '/properties', {
          actor,
          body: { type: 'HOUSE', ownerId: actor.userId, status: 'ARCHIVED' },
        })
      ).status,
    ).toBe(400);
  });

  it('crea Property + OWNER + AuditEvent atómicamente y devuelve proyección', async () => {
    const actor = await createActor();
    const property = await createProperty(actor, 'atomic');
    expect(property).toMatchObject({ status: 'ACTIVE' });
    expect(property.capabilities).toContain('PROPERTY_AUTHORIZE');
    const persisted = await database.prisma.property.findUniqueOrThrow({
      where: { id: property.id },
      include: { authorizations: true },
    });
    expect(persisted.authorizations).toHaveLength(1);
    expect(persisted.authorizations[0]).toMatchObject({
      userId: actor.userId,
      organizationId: null,
      authorizationType: 'OWNER',
      status: 'ACTIVE',
    });
    expect(
      await database.prisma.auditEvent.count({
        where: { resourceId: property.id, action: 'PROPERTY_CREATED' },
      }),
    ).toBe(1);
  });

  it('aísla cartera, detalle y PATCH entre actores', async () => {
    const owner = await createActor();
    const stranger = await createActor();
    const property = await createProperty(owner);
    const list = await request('GET', '/properties?limit=100&offset=0', { actor: stranger });
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).some(({ id }) => id === property.id)).toBe(false);
    expect((await request('GET', `/properties/${property.id}`, { actor: stranger })).status).toBe(
      404,
    );
    expect(
      (
        await request('PATCH', `/properties/${property.id}`, {
          actor: stranger,
          body: { rooms: 9 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request('PATCH', `/properties/${property.id}`, {
          actor: owner,
          body: { status: 'ARCHIVED' },
        })
      ).status,
    ).toBe(400);
    const updated = await request('PATCH', `/properties/${property.id}`, {
      actor: owner,
      body: { rooms: 4 },
      requestId: `${requestPrefix}-property-update`,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ rooms: 4 });
  });

  it('aplica OWNER, MANAGER, PUBLISHER, duplicación y revocación inmediata', async () => {
    const owner = await createActor();
    const manager = await createActor();
    const publisher = await createActor();
    const property = await createProperty(owner);
    expect(
      (await grant(owner, property.id, { authorizationType: 'MANAGER', userId: manager.userId }))
        .status,
    ).toBe(201);
    const publisherGrant = await grant(owner, property.id, {
      authorizationType: 'PUBLISHER',
      userId: publisher.userId,
    });
    expect(publisherGrant.status).toBe(201);
    expect(
      (await grant(owner, property.id, { authorizationType: 'MANAGER', userId: manager.userId }))
        .status,
    ).toBe(409);
    expect(
      (
        await request('PATCH', `/properties/${property.id}`, {
          actor: manager,
          body: { bathrooms: 2 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request('PATCH', `/properties/${property.id}`, {
          actor: publisher,
          body: { bathrooms: 3 },
        })
      ).status,
    ).toBe(404);
    const authorizations = await request('GET', `/properties/${property.id}/authorizations`, {
      actor: manager,
    });
    expect(authorizations.status).toBe(200);
    expect(JSON.stringify(authorizations.body)).not.toMatch(/userId|grantedByUserId/);
    expect(
      (
        await request('GET', `/properties/${property.id}/authorizations`, {
          actor: publisher,
        })
      ).status,
    ).toBe(404);
    const listing = await request('POST', '/listings', {
      actor: publisher,
      body: {
        propertyId: property.id,
        transactionType: 'SALE',
        price: '325000.00',
        currency: 'EUR',
        description: 'Piso sintético luminoso',
      },
      requestId: `${requestPrefix}-listing-publisher`,
    });
    expect(listing.status).toBe(201);
    const authorizationId = (publisherGrant.body as { id: string }).id;
    expect(
      (
        await request('POST', `/property-authorizations/${authorizationId}/revoke`, {
          actor: owner,
          body: {},
          requestId: `${requestPrefix}-revoke`,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request('GET', `/listings/${(listing.body as { id: string }).id}`, {
          actor: publisher,
        })
      ).status,
    ).toBe(404);
  });

  it('crea y edita Listing personal DRAFT sin permitir publisher/status/relaciones', async () => {
    const owner = await createActor();
    const property = await createProperty(owner);
    const sale = await request('POST', '/listings', {
      actor: owner,
      body: {
        propertyId: property.id,
        transactionType: 'SALE',
        price: '400000',
        currency: 'EUR',
        description: 'Ático sintético de prueba',
        publisherUserId: owner.userId,
      },
    });
    expect(sale.status).toBe(400);
    const rent = await request('POST', '/listings', {
      actor: owner,
      body: {
        propertyId: property.id,
        transactionType: 'RENT',
        rentalMode: 'LONG_TERM',
        price: '1500.5',
        currency: 'EUR',
        description: 'Alquiler sintético de larga duración',
      },
      requestId: `${requestPrefix}-listing-personal`,
    });
    expect(rent.status).toBe(201);
    expect(rent.body).toMatchObject({
      propertyId: property.id,
      status: 'DRAFT',
      price: '1500.50',
      publisher: { type: 'USER', self: true },
    });
    const id = (rent.body as { id: string }).id;
    expect(
      (await request('PATCH', `/listings/${id}`, { actor: owner, body: { status: 'PUBLISHED' } }))
        .status,
    ).toBe(400);
    const updated = await request('PATCH', `/listings/${id}`, {
      actor: owner,
      body: { price: '1450.00', description: 'Descripción sintética actualizada' },
      requestId: `${requestPrefix}-listing-update`,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ price: '1450.00', status: 'DRAFT' });
  });

  it('exige Organization ACTIVE + membership ACTIVE + autorización propia', async () => {
    const owner = await createActor();
    const member = await createActor();
    const other = await createActor();
    const property = await createProperty(owner);
    const organization = await database.prisma.organization.create({
      data: { name: `B16 ${suite} Organization`, status: 'ACTIVE', createdByUserId: member.userId },
    });
    const otherOrganization = await database.prisma.organization.create({
      data: { name: `B16 ${suite} Other`, status: 'ACTIVE', createdByUserId: other.userId },
    });
    organizationIds.add(organization.id);
    organizationIds.add(otherOrganization.id);
    const membership = await database.prisma.organizationMember.create({
      data: {
        organizationId: organization.id,
        userId: member.userId,
        role: 'PROFESSIONAL_MEMBER',
        status: 'ACTIVE',
      },
    });
    await database.prisma.organizationMember.create({
      data: {
        organizationId: otherOrganization.id,
        userId: other.userId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    expect(
      (
        await grant(owner, property.id, {
          authorizationType: 'PUBLISHER',
          organizationId: organization.id,
        })
      ).status,
    ).toBe(201);
    const body = {
      propertyId: property.id,
      organizationId: organization.id,
      transactionType: 'SALE',
      price: '250000.00',
      currency: 'EUR',
      description: 'Publicación organizativa sintética',
    };
    const created = await request('POST', '/listings', {
      actor: member,
      body,
      requestId: `${requestPrefix}-listing-org`,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      publisher: { type: 'ORGANIZATION', organizationId: organization.id },
    });
    expect((await request('POST', '/listings', { actor: other, body })).status).toBe(404);
    await database.prisma.organizationMember.update({
      where: { id: membership.id },
      data: { status: 'REVOKED', endedAt: new Date(), endedReasonCode: 'B16_TEST' },
    });
    expect((await request('POST', '/listings', { actor: member, body })).status).toBe(404);
    await database.prisma.organization.update({
      where: { id: organization.id },
      data: { status: 'SUSPENDED' },
    });
    expect(
      (
        await grant(owner, property.id, {
          authorizationType: 'MANAGER',
          organizationId: organization.id,
        })
      ).status,
    ).toBe(409);
  });

  it('rechaza query inválida/desconocida/repetida y UUID no canónico', async () => {
    const actor = await createActor();
    expect((await request('GET', '/properties?limit=101', { actor })).status).toBe(400);
    expect((await request('GET', '/properties?offset=10001', { actor })).status).toBe(400);
    expect((await request('GET', '/properties?unknown=1', { actor })).status).toBe(400);
    expect((await request('GET', '/properties?limit=1&limit=2', { actor })).status).toBe(400);
    expect((await request('GET', '/properties/NOT-A-UUID', { actor })).status).toBe(400);
  });

  it('revierte Property y OWNER si falla AuditEvent, sin filtrar internals', async () => {
    const actor = await createActor();
    const requestId = `${requestPrefix}-audit-rollback`;
    const before = await database.prisma.property.count();
    await withAuditFailureFixture(
      database.prisma,
      { requestId, failures: 1, sqlState: 'P0001' },
      async () => {
        const response = await request('POST', '/properties', {
          actor,
          body: { type: 'HOUSE' },
          requestId,
        });
        expect(response.status).toBe(503);
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toMatch(/Prisma|SQL|constraint|stack|P0001/i);
      },
    );
    expect(await database.prisma.property.count()).toBe(before);
    expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
  });

  it.each(['USER', 'ORGANIZATION'] as const)(
    'revoca autorización programada %s con instante real y auditoría atómica',
    async (subjectType) => {
      const owner = await createActor();
      const subject = await createActor();
      const suffix = `future-${subjectType}-${randomUUID()}`;
      const revokeRequest = `${requestPrefix}-${suffix}`;
      const failureRequest = `${revokeRequest}-rollback`;
      let propertyId: string | undefined;
      let organizationId: string | undefined;
      try {
        propertyId = (await createProperty(owner, suffix)).id;
        if (subjectType === 'ORGANIZATION') {
          const organization = await database.prisma.organization.create({
            data: {
              name: 'Organización sintética con autorización programada',
              createdByUserId: subject.userId,
              members: { create: { userId: subject.userId, role: 'ADMIN' } },
            },
          });
          organizationId = organization.id;
          organizationIds.add(organizationId);
        }
        const clock = async () =>
          (
            await database.prisma.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp() AS now`
          )[0]!.now;
        const now = await clock();
        const validFrom = new Date(now.getTime() + 86_400_000);
        const grantBody = {
          authorizationType: 'MANAGER',
          ...(organizationId ? { organizationId } : { userId: subject.userId }),
          validFrom: validFrom.toISOString(),
          validUntil: new Date(validFrom.getTime() + 86_400_000).toISOString(),
        };
        const granted = await grant(owner, propertyId, grantBody, suffix);
        expect(granted.status).toBe(201);
        const id = (granted.body as { id: string }).id;
        expect((await request('GET', `/properties/${propertyId}`, { actor: subject })).status).toBe(
          404,
        );
        const before = await clock();
        const response = await request('POST', `/property-authorizations/${id}/revoke`, {
          actor: owner,
          body: {},
          requestId: revokeRequest,
        });
        const after = await clock();
        expect(response.status).toBe(204);
        const revoked = await database.prisma.propertyAuthorization.findUniqueOrThrow({
          where: { id },
        });
        expect(revoked.status).toBe('REVOKED');
        expect(revoked.revokedAt!.getTime()).toBeGreaterThanOrEqual(revoked.createdAt.getTime());
        // PostgreSQL almacena estos timestamps con precisión de milisegundos.
        expect(revoked.revokedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(revoked.revokedAt!.getTime()).toBeLessThanOrEqual(after.getTime() + 1);
        expect(revoked.revokedAt!.getTime()).toBeLessThan(validFrom.getTime());
        expect((await request('GET', `/properties/${propertyId}`, { actor: subject })).status).toBe(
          404,
        );
        expect(
          (
            await request('POST', '/listings', {
              actor: subject,
              requestId: `${revokeRequest}-denied`,
              body: {
                propertyId,
                ...(organizationId ? { organizationId } : {}),
                transactionType: 'SALE',
                price: '100000.00',
                currency: 'EUR',
                description: 'Listing sintético que no debe existir',
              },
            })
          ).status,
        ).toBe(404);
        expect(await database.prisma.listing.count({ where: { propertyId } })).toBe(0);
        const audits = await database.prisma.auditEvent.findMany({
          where: { requestId: revokeRequest },
        });
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          action: 'PROPERTY_AUTHORIZATION_REVOKED',
          resourceId: id,
          previousState: 'ACTIVE',
          newState: 'REVOKED',
          occurredAt: revoked.revokedAt,
        });
        // El histórico revocado libera el unique parcial y admite otra concesión equivalente.
        const replacement = await grant(owner, propertyId, grantBody, `${suffix}-new`);
        expect(replacement.status).toBe(201);
        const replacementId = (replacement.body as { id: string }).id;
        const snapshot = await database.prisma.propertyAuthorization.findUniqueOrThrow({
          where: { id: replacementId },
        });
        await withAuditFailureFixture(
          database.prisma,
          { requestId: failureRequest, failures: 1, sqlState: 'P0001' },
          async (fixture) => {
            const failed = await request(
              'POST',
              `/property-authorizations/${replacementId}/revoke`,
              {
                actor: owner,
                body: {},
                requestId: failureRequest,
              },
            );
            expect(failed.status).toBe(503);
            expect(JSON.stringify(failed.body)).not.toMatch(/Prisma|SQL|constraint|stack|P0001/i);
            expect(await fixture.attempts()).toBe(1);
          },
        );
        expect(
          await database.prisma.propertyAuthorization.findUniqueOrThrow({
            where: { id: replacementId },
          }),
        ).toEqual(snapshot);
        expect(
          await database.prisma.auditEvent.count({ where: { requestId: failureRequest } }),
        ).toBe(0);
      } finally {
        await database.prisma.$transaction(async (tx) => {
          if (propertyId) {
            await tx.listing.deleteMany({ where: { propertyId } });
            await tx.propertyAuthorization.deleteMany({ where: { propertyId } });
            await tx.property.deleteMany({ where: { id: propertyId } });
          }
          if (organizationId) {
            await tx.organizationMember.deleteMany({ where: { organizationId } });
            await tx.organization.deleteMany({ where: { id: organizationId } });
          }
          const users = [owner.userId, subject.userId];
          await tx.session.deleteMany({ where: { userId: { in: users } } });
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await tx.auditEvent.deleteMany({ where: { actorUserId: { in: users } } });
          await tx.$executeRaw`SET LOCAL session_replication_role = origin`;
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
      }
    },
  );

  it('una autorización expirada deja de conceder acceso inmediatamente', async () => {
    const owner = await createActor();
    const publisher = await createActor();
    const property = await createProperty(owner);
    const granted = await grant(owner, property.id, {
      authorizationType: 'PUBLISHER',
      userId: publisher.userId,
    });
    const now = Date.now();
    await database.prisma.propertyAuthorization.update({
      where: { id: (granted.body as { id: string }).id },
      data: {
        validFrom: new Date(now - 7_200_000),
        validUntil: new Date(now - 3_600_000),
      },
    });
    const response = await request('POST', '/listings', {
      actor: publisher,
      body: {
        propertyId: property.id,
        transactionType: 'SALE',
        price: '1.00',
        currency: 'EUR',
        description: 'No debe persistirse por autorización expirada',
      },
      requestId: `${requestPrefix}-expired-denied`,
    });
    expect(response.status).toBe(404);
    expect(await database.prisma.listing.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it('falla cerrado con 503 y sin efectos cuando PostgreSQL no está disponible', async () => {
    const actor = await createActor();
    const before = await database.prisma.property.count();
    const original = process.env.DATABASE_URL;
    let unavailableApp: NestExpressApplication | undefined;
    try {
      process.env.DATABASE_URL = 'postgresql://invalid@127.0.0.1:1/benhouse_test?connect_timeout=1';
      const config = readAppConfig();
      unavailableApp = await NestFactory.create<NestExpressApplication>(AppModule, {
        logger: false,
        bodyParser: false,
      });
      configureApplication(unavailableApp, config);
      await unavailableApp.listen(0, '127.0.0.1');
      const address = unavailableApp.getHttpServer().address();
      if (!address || typeof address === 'string') throw new Error('Puerto de test no disponible.');
      const response = await fetch(`http://127.0.0.1:${address.port}/properties`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: `${cookieName}=${actor.cookie}`,
          'x-csrf-token': actor.csrf,
        },
        body: JSON.stringify({ type: 'HOUSE' }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' },
      });
    } finally {
      await unavailableApp?.close();
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
    expect(await database.prisma.property.count()).toBe(before);
  });

  it('serializa causalmente dos grants equivalentes en un único efecto auditado', async () => {
    const owner = await createActor();
    const target = await createActor();
    const property = await createProperty(owner);
    const blocker = await createNamedClient(`b16_blocker_${randomUUID()}`);
    let release!: () => void;
    let announce!: (pid: number) => void;
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));
    const blockerReady = new Promise<number>((resolve) => (announce = resolve));
    const committedRequest = `${requestPrefix}-grant-race-committed`;
    const blockingTransaction = blocker.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT "id" FROM "property" WHERE "id" = ${property.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "property_authorization" WHERE "property_id" = ${property.id}::uuid ORDER BY "id" FOR UPDATE`;
      const now = new Date();
      const authorization = await tx.propertyAuthorization.create({
        data: {
          propertyId: property.id,
          userId: target.userId,
          authorizationType: 'MANAGER',
          grantedByUserId: owner.userId,
          validFrom: now,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorType: 'USER',
          actorUserId: owner.userId,
          action: 'PROPERTY_AUTHORIZATION_GRANTED',
          resourceType: 'PROPERTY_AUTHORIZATION',
          resourceId: authorization.id,
          newState: 'ACTIVE',
          metadata: { propertyId: property.id, authorizationType: 'MANAGER', subjectType: 'USER' },
          requestId: committedRequest,
          correlationId: committedRequest,
        },
      });
      announce(rows[0]!.pid);
      await releaseSignal;
    });
    const apiRequest = `${requestPrefix}-grant-race-api`;
    let pending: Promise<ApiResponse> | undefined;
    try {
      const blockerPid = await blockerReady;
      ({ pending } = await startAndWaitBlocked({
        requestId: apiRequest,
        operation: 'PROPERTY_AUTHORIZATION_GRANT',
        blockerPid,
        expectedQuery: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
        start: () =>
          grant(
            owner,
            property.id,
            { authorizationType: 'MANAGER', userId: target.userId },
            'race-api',
          ),
      }));
      release();
      await blockingTransaction;
      expect([409, 503]).toContain((await pending).status);
    } finally {
      release();
      await blockingTransaction.catch(() => undefined);
      await pending?.catch(() => undefined);
      await blocker.$disconnect();
      observer.clearRequest(apiRequest);
    }
    expect(
      await database.prisma.propertyAuthorization.count({
        where: {
          propertyId: property.id,
          userId: target.userId,
          authorizationType: 'MANAGER',
          status: 'ACTIVE',
        },
      }),
    ).toBe(1);
    expect(
      await database.prisma.auditEvent.count({
        where: {
          action: 'PROPERTY_AUTHORIZATION_GRANTED',
          requestId: { in: [committedRequest, apiRequest] },
        },
      }),
    ).toBe(1);
  });

  it('ordena revoke antes de PATCH Listing y no confirma autorización obsoleta', async () => {
    const owner = await createActor();
    const publisher = await createActor();
    const property = await createProperty(owner);
    const granted = await grant(owner, property.id, {
      authorizationType: 'PUBLISHER',
      userId: publisher.userId,
    });
    const authorizationId = (granted.body as { id: string }).id;
    const created = await request('POST', '/listings', {
      actor: publisher,
      body: {
        propertyId: property.id,
        transactionType: 'SALE',
        price: '300000.00',
        currency: 'EUR',
        description: 'Listing previo a la carrera causal',
      },
      requestId: `${requestPrefix}-race-listing-created`,
    });
    const listingId = (created.body as { id: string }).id;
    const blocker = await createNamedClient(`b16_blocker_${randomUUID()}`);
    let release!: () => void;
    let announce!: (pid: number) => void;
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<number>((resolve) => (announce = resolve));
    const revokeRequest = `${requestPrefix}-race-revoke-committed`;
    const editRequest = `${requestPrefix}-race-edit-second`;
    let edit: Promise<ApiResponse> | undefined;
    const blocking = blocker.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT "id" FROM "property" WHERE "id" = ${property.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "property_authorization" WHERE "property_id" = ${property.id}::uuid ORDER BY "id" FOR UPDATE`;
      const now = new Date();
      await tx.propertyAuthorization.update({
        where: { id: authorizationId },
        data: { status: 'REVOKED', revokedAt: now },
      });
      await tx.auditEvent.create({
        data: {
          actorType: 'USER',
          actorUserId: owner.userId,
          action: 'PROPERTY_AUTHORIZATION_REVOKED',
          resourceType: 'PROPERTY_AUTHORIZATION',
          resourceId: authorizationId,
          previousState: 'ACTIVE',
          newState: 'REVOKED',
          metadata: {
            propertyId: property.id,
            authorizationType: 'PUBLISHER',
            subjectType: 'USER',
          },
          requestId: revokeRequest,
          correlationId: revokeRequest,
        },
      });
      announce(rows[0]!.pid);
      await releaseSignal;
    });
    const blockerPid = await ready;
    try {
      ({ pending: edit } = await startAndWaitBlocked({
        requestId: editRequest,
        operation: 'LISTING_UPDATE',
        blockerPid,
        expectedQuery: 'SELECT "id" FROM "property" WHERE "id" = $1::uuid FOR UPDATE',
        start: () =>
          request('PATCH', `/listings/${listingId}`, {
            actor: publisher,
            body: { price: '299000.00' },
            requestId: editRequest,
          }),
      }));
      release();
      await blocking;
      expect((await edit).status).toBe(404);
    } finally {
      release();
      await blocking.catch(() => undefined);
      await edit?.catch(() => undefined);
      await blocker.$disconnect();
      observer.clearRequest(revokeRequest);
      observer.clearRequest(editRequest);
    }
    expect(
      (await database.prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).price.toFixed(
        2,
      ),
    ).toBe('300000.00');
    expect(await database.prisma.auditEvent.count({ where: { requestId: editRequest } })).toBe(0);
  });

  it('ordena revoke antes de crear Listing y revierte el intento abortado', async () => {
    const owner = await createActor();
    const publisher = await createActor();
    const property = await createProperty(owner);
    const granted = await grant(owner, property.id, {
      authorizationType: 'PUBLISHER',
      userId: publisher.userId,
    });
    const authorizationId = (granted.body as { id: string }).id;
    const blocker = await createNamedClient(`b16_blocker_${randomUUID()}`);
    let release!: () => void;
    let announce!: (pid: number) => void;
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<number>((resolve) => (announce = resolve));
    const revokeRequest = `${requestPrefix}-create-race-revoke`;
    const createRequest = `${requestPrefix}-create-race-listing`;
    const blocking = blocker.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT "id" FROM "property" WHERE "id" = ${property.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "property_authorization" WHERE "property_id" = ${property.id}::uuid ORDER BY "id" FOR UPDATE`;
      const now = new Date();
      await tx.propertyAuthorization.update({
        where: { id: authorizationId },
        data: { status: 'REVOKED', revokedAt: now },
      });
      await tx.auditEvent.create({
        data: {
          actorType: 'USER',
          actorUserId: owner.userId,
          action: 'PROPERTY_AUTHORIZATION_REVOKED',
          resourceType: 'PROPERTY_AUTHORIZATION',
          resourceId: authorizationId,
          previousState: 'ACTIVE',
          newState: 'REVOKED',
          metadata: {
            propertyId: property.id,
            authorizationType: 'PUBLISHER',
            subjectType: 'USER',
          },
          requestId: revokeRequest,
          correlationId: revokeRequest,
        },
      });
      announce(rows[0]!.pid);
      await releaseSignal;
    });
    let pending: Promise<ApiResponse> | undefined;
    try {
      const blockerPid = await ready;
      ({ pending } = await startAndWaitBlocked({
        requestId: createRequest,
        operation: 'LISTING_CREATE',
        blockerPid,
        expectedQuery: 'SELECT "id" FROM "property" WHERE "id" = $1::uuid FOR UPDATE',
        start: () =>
          request('POST', '/listings', {
            actor: publisher,
            body: {
              propertyId: property.id,
              transactionType: 'SALE',
              price: '310000.00',
              currency: 'EUR',
              description: 'Listing que debe abortarse tras revoke',
            },
            requestId: createRequest,
          }),
      }));
      release();
      await blocking;
      expect((await pending).status).toBe(404);
    } finally {
      release();
      await blocking.catch(() => undefined);
      await pending?.catch(() => undefined);
      await blocker.$disconnect();
      observer.clearRequest(createRequest);
    }
    expect(await database.prisma.listing.count({ where: { propertyId: property.id } })).toBe(0);
    expect(await database.prisma.auditEvent.count({ where: { requestId: createRequest } })).toBe(0);
  });

  it('ordena revocación de membership antes de Listing organizativo', async () => {
    const owner = await createActor();
    const admin = await createActor();
    const member = await createActor();
    const property = await createProperty(owner);
    const organization = await database.prisma.organization.create({
      data: { name: `B16 ${suite} Race`, status: 'ACTIVE', createdByUserId: admin.userId },
    });
    organizationIds.add(organization.id);
    await database.prisma.organizationMember.create({
      data: {
        organizationId: organization.id,
        userId: admin.userId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    const membership = await database.prisma.organizationMember.create({
      data: {
        organizationId: organization.id,
        userId: member.userId,
        role: 'PROFESSIONAL_MEMBER',
        status: 'ACTIVE',
      },
    });
    expect(
      (
        await grant(owner, property.id, {
          authorizationType: 'PUBLISHER',
          organizationId: organization.id,
        })
      ).status,
    ).toBe(201);
    const blocker = await createNamedClient(`b16_blocker_${randomUUID()}`);
    let release!: () => void;
    let announce!: (pid: number) => void;
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<number>((resolve) => (announce = resolve));
    const revokeRequest = `${requestPrefix}-membership-revoke-committed`;
    const listingRequest = `${requestPrefix}-org-listing-second`;
    let listing: Promise<ApiResponse> | undefined;
    const blocking = blocker.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT "id" FROM "organization" WHERE "id" = ${organization.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "organization_member" WHERE "organization_id" = ${organization.id}::uuid ORDER BY "id" FOR UPDATE`;
      const now = new Date();
      await tx.organizationMember.update({
        where: { id: membership.id },
        data: { status: 'REVOKED', endedAt: now, endedReasonCode: 'B16_CAUSAL_REVOKE' },
      });
      await tx.auditEvent.create({
        data: {
          actorType: 'USER',
          actorUserId: admin.userId,
          action: 'ORGANIZATION_MEMBER_REVOKED',
          resourceType: 'ORGANIZATION_MEMBER',
          resourceId: membership.id,
          metadata: { organizationId: organization.id, previousRole: 'PROFESSIONAL_MEMBER' },
          requestId: revokeRequest,
          correlationId: revokeRequest,
        },
      });
      announce(rows[0]!.pid);
      await releaseSignal;
    });
    const blockerPid = await ready;
    try {
      ({ pending: listing } = await startAndWaitBlocked({
        requestId: listingRequest,
        operation: 'LISTING_CREATE',
        blockerPid,
        expectedQuery: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
        start: () =>
          request('POST', '/listings', {
            actor: member,
            body: {
              propertyId: property.id,
              organizationId: organization.id,
              transactionType: 'SALE',
              price: '280000.00',
              currency: 'EUR',
              description: 'Listing organizativo en carrera causal',
            },
            requestId: listingRequest,
          }),
      }));
      release();
      await blocking;
      expect((await listing).status).toBe(404);
    } finally {
      release();
      await blocking.catch(() => undefined);
      await listing?.catch(() => undefined);
      await blocker.$disconnect();
      observer.clearRequest(revokeRequest);
      observer.clearRequest(listingRequest);
    }
    expect(await database.prisma.auditEvent.count({ where: { requestId: listingRequest } })).toBe(
      0,
    );
    expect(
      await database.prisma.listing.count({
        where: { propertyId: property.id, publisherOrganizationId: organization.id },
      }),
    ).toBe(0);
  });
});
