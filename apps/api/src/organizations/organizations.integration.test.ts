import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';
import { AppModule } from '../app.module';
import { configureApplication } from '../main';
import { DatabaseService } from '../infrastructure/database/database.service';
import { createSessionToken, sessionSecretDigest } from '../auth/session-token';
import { deriveCsrfToken } from '../auth/csrf';
import { createPrismaClient, Prisma } from '@benhouse/database';
import type { Prisma as PrismaTypes } from '@benhouse/database';
import {
  waitForQueryBlockedBy,
  withAuditFailureFixture,
  type AuditFailureFixture,
  TestOrganizationTransactionObserver,
} from './postgres-test-fixtures';
import { OrganizationTransactionObserver } from './organization-transaction-observer';

type ApiResponse = { status: number; body: unknown };
type Actor = { userId: string; sessionId: string; cookie: string; csrfToken: string };

describe('B1.4 Organization Core HTTP y PostgreSQL', () => {
  let app: NestExpressApplication;
  let database: DatabaseService;
  let baseUrl: string;
  let cookieName: string;
  let databaseName: string;
  let originalDatabaseUrl: string | undefined;
  let transactionObserver: TestOrganizationTransactionObserver;
  const suite = randomUUID();
  const apiApplicationName = `b14_api_${suite}`;

  beforeAll(async () => {
    loadLocalEnvironmentFile();
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrlForApplication(apiApplicationName, false);
    const config = readAppConfig();
    cookieName = config.auth.sessionCookieName;
    transactionObserver = new TestOrganizationTransactionObserver();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OrganizationTransactionObserver)
      .useValue(transactionObserver)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    configureApplication(app, config);
    await app.listen(0, '127.0.0.1');
    database = app.get(DatabaseService);
    const identity = await database.prisma.$queryRaw<Array<{ databaseName: string }>>(
      Prisma.sql`SELECT current_database() AS "databaseName"`,
    );
    databaseName = identity[0]?.databaseName ?? '';
    expect(databaseName).toBe('benhouse_test');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Puerto de test no disponible.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    expect([
      transactionObserver.eventCount(),
      transactionObserver.waiterCount(),
      transactionObserver.activeReceiptCount(),
    ]).toEqual([0, 0, 0]);
    await app?.close();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  async function request(
    method: string,
    path: string,
    options: {
      actor?: Actor;
      body?: unknown;
      origin?: string | null;
      csrfToken?: string | null;
      requestId?: string;
    } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.origin !== null) headers.origin = options.origin ?? 'http://localhost:3000';
    if (options.actor) headers.cookie = `${cookieName}=${options.actor.cookie}`;
    const csrf = options.csrfToken === undefined ? options.actor?.csrfToken : options.csrfToken;
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

  async function createActor(
    status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' = 'ACTIVE',
    verified = true,
  ): Promise<Actor> {
    const now = new Date();
    const user = await database.prisma.user.create({
      data: {
        email: `b14-${suite}-${randomUUID()}@example.test`,
        displayName: 'Profesional sintético',
        status,
        emailVerifiedAt: verified ? now : null,
      },
    });
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
      csrfToken: deriveCsrfToken(token.selector, user.sessionVersion, config.auth.csrfKeys),
    };
  }

  async function createOrganization(actor: Actor, name = 'BenHouse Partners') {
    const response = await request('POST', '/organizations', { actor, body: { name } });
    expect(response.status).toBe(201);
    return response.body as {
      id: string;
      name: string;
      status: string;
      capabilities: string[];
    };
  }

  async function raceCommittedInvalidation(
    requestId: string,
    mutate: (tx: PrismaTypes.TransactionClient) => Promise<void>,
    expectedQuery: string,
    operation: () => Promise<ApiResponse>,
  ): Promise<ApiResponse> {
    const auxiliary = await createNamedPrismaClient(`b14_blocker_${randomUUID()}`);
    const observer = await createNamedPrismaClient(`b14_observer_${randomUUID()}`);
    let release!: () => void;
    let mutationStarted!: (pid: number) => void;
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));
    const mutationReady = new Promise<number>((resolve) => (mutationStarted = resolve));
    const mutation = auxiliary.$transaction(async (tx) => {
      const backend = await tx.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      await mutate(tx);
      mutationStarted(backend[0]!.pid);
      await releaseSignal;
    });
    let pending: Promise<ApiResponse> | undefined;
    try {
      const blockerPid = await mutationReady;
      const transactionStarted = transactionObserver.waitFor({
        requestId,
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
      });
      pending = operation();
      const transaction = await transactionStarted;
      const blocked = await waitForQueryBlockedBy(observer, {
        blockerPid,
        databaseName,
        applicationName: apiApplicationName,
        expectedQuery,
        requestId,
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
        transaction,
        diagnosticRoute: '/organizations/:id',
        allowedWaitEvents: ['transactionid', 'tuple'],
        expectedBlockedPid: transaction.backendPid,
        expectedVirtualTransactionId: transaction.virtualTransactionId,
        timeoutMs: 1_500,
      });
      expect(blocked.blockingPids).toEqual([blockerPid]);
      expect(blocked.pid).not.toBe(blockerPid);
      release();
      await mutation;
      return await pending;
    } finally {
      release();
      await mutation.catch(() => undefined);
      await pending?.catch(() => undefined);
      await Promise.all([auxiliary.$disconnect(), observer.$disconnect()]);
      transactionObserver.clearRequest(requestId);
      expect([
        transactionObserver.eventCount(requestId),
        transactionObserver.waiterCount(),
        transactionObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);
    }
  }

  async function withAuditFailure<T>(
    requestId: string,
    failures: number,
    sqlState: '40001' | 'P0001',
    callback: (fixture: AuditFailureFixture) => Promise<T>,
  ): Promise<T> {
    return withAuditFailureFixture(database.prisma, { requestId, failures, sqlState }, callback);
  }

  async function createNamedPrismaClient(applicationName: string) {
    const prior = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrlForApplication(applicationName, true);
    const client = createPrismaClient();
    try {
      await client.$connect();
      return client;
    } finally {
      if (prior === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prior;
    }
  }

  function databaseUrlForApplication(applicationName: string, singleConnection: boolean): string {
    const source = originalDatabaseUrl ?? process.env.DATABASE_URL;
    if (!source) throw new Error('DATABASE_URL no disponible para la suite B1.4.');
    const url = new URL(source);
    url.searchParams.set('application_name', applicationName);
    if (singleConnection) url.searchParams.set('connection_limit', '1');
    else url.searchParams.delete('connection_limit');
    return url.toString();
  }

  async function expectNoUpdateEffect(
    organizationId: string,
    expectedName: string,
    requestId: string,
  ): Promise<void> {
    expect(
      await database.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    ).toMatchObject({ name: expectedName });
    expect(
      await database.prisma.auditEvent.count({
        where: { requestId, action: 'ORGANIZATION_UPDATED' },
      }),
    ).toBe(0);
  }

  it('crea Organization, admin inicial y auditoría en una única operación', async () => {
    const actor = await createActor();
    const requestId = `organization-create-${randomUUID()}`;
    const created = await request('POST', '/organizations', {
      actor,
      body: { name: '  Jose\u0301\tCasa  ' },
      requestId,
    });
    expect(created).toMatchObject({
      status: 201,
      body: {
        name: 'José Casa',
        status: 'ACTIVE',
        capabilities: [
          'ORGANIZATION_VIEW',
          'ORGANIZATION_MANAGE',
          'ORGANIZATION_MEMBERS_VIEW',
          'ORGANIZATION_MEMBERS_MANAGE',
          'ORGANIZATION_ADMIN_TRANSFER',
        ],
      },
    });
    const organizationId = (created.body as { id: string }).id;
    const organization = await database.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      include: { members: true },
    });
    expect(organization).toMatchObject({ createdByUserId: actor.userId, status: 'ACTIVE' });
    expect(organization.members).toMatchObject([
      {
        userId: actor.userId,
        role: 'ADMIN',
        status: 'ACTIVE',
        invitationId: null,
        endedAt: null,
      },
    ]);
    const audit = await database.prisma.auditEvent.findFirstOrThrow({
      where: { requestId, action: 'ORGANIZATION_CREATED' },
    });
    expect(audit).toMatchObject({
      actorUserId: actor.userId,
      resourceId: organizationId,
      newState: 'ACTIVE',
    });
    expect(JSON.stringify(audit)).not.toContain('José Casa');
  });

  it('hace rollback real del servicio si falla la auditoría tras Organization y ADMIN', async () => {
    const actor = await createActor();
    const requestId = `rollback-create-${randomUUID()}`;
    const name = `Rollback real ${randomUUID()}`;
    await withAuditFailure(requestId, 1, 'P0001', async () => {
      const response = await request('POST', '/organizations', {
        actor,
        body: { name },
        requestId,
      });
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' } },
      });
      expect(await database.prisma.organization.count({ where: { name } })).toBe(0);
      expect(
        await database.prisma.organizationMember.count({
          where: { organization: { name } },
        }),
      ).toBe(0);
      expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
    });
  });

  it('permite nombres duplicados, varias organizaciones y listado aislado/paginado', async () => {
    const actor = await createActor();
    const outsider = await createActor();
    const first = await createOrganization(actor, 'Nombre compartido');
    await createOrganization(actor, 'Nombre compartido');
    await createOrganization(outsider, 'Nombre compartido');
    const list = await request('GET', '/organizations?limit=100&offset=0', {
      actor,
      origin: null,
    });
    expect(list.status).toBe(200);
    const items = list.body as Array<{ id: string }>;
    expect(items).toHaveLength(2);
    expect(items.map(({ id }) => id)).toContain(first.id);
    const page = await request('GET', '/organizations?limit=1&offset=0', {
      actor,
      origin: null,
    });
    expect(page.status).toBe(200);
    expect(page.body).toHaveLength(1);
    expect((await request('GET', '/organizations?limit=101', { actor, origin: null })).status).toBe(
      400,
    );
  });

  it('aplica contrato query estricto en los cinco endpoints', async () => {
    const actor = await createActor();
    const organization = await createOrganization(actor, 'Query estricta');
    const cases: Array<[string, string, unknown?]> = [
      ['POST', '/organizations?extra=1', { name: 'Inválida' }],
      ['GET', '/organizations?extra=1'],
      ['GET', '/organizations?limit=1&limit=2'],
      ['GET', `/organizations/${organization.id}?extra=1`],
      ['PATCH', `/organizations/${organization.id}?extra=1`, { name: 'Inválida' }],
      ['GET', `/organizations/${organization.id}/members?extra=1`],
      ['GET', `/organizations/${organization.id}/members?offset=0&offset=1`],
      ['GET', '/organizations?=1'],
      ['GET', '/organizations?limit=01'],
      ['GET', '/organizations?offset=-1'],
      ['GET', '/organizations?offset=1.5'],
    ];
    for (const [method, path, body] of cases) {
      const response = await request(method, path, {
        actor,
        body,
        origin: method === 'GET' ? null : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }
    expect(
      await database.prisma.organization.findUniqueOrThrow({ where: { id: organization.id } }),
    ).toMatchObject({ name: 'Query estricta' });
  });

  it('admite dos creaciones simultáneas válidas sin mezclar administradores', async () => {
    const actor = await createActor();
    const responses = await Promise.all([
      request('POST', '/organizations', { actor, body: { name: 'Concurrente A' } }),
      request('POST', '/organizations', { actor, body: { name: 'Concurrente B' } }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    const ids = responses.map(({ body }) => (body as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
    const memberships = await database.prisma.organizationMember.findMany({
      where: { organizationId: { in: ids } },
    });
    expect(memberships).toHaveLength(2);
    expect(
      memberships.every(({ userId, role }) => userId === actor.userId && role === 'ADMIN'),
    ).toBe(true);
  });

  it('aplica Origin, CSRF, sesión elegible y mass assignment sin efectos', async () => {
    const actor = await createActor();
    const before = await database.prisma.organization.count();
    expect(
      (
        await request('POST', '/organizations', {
          actor,
          body: { name: 'Sin origin' },
          origin: null,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('POST', '/organizations', {
          actor,
          body: { name: 'Sin CSRF' },
          csrfToken: null,
        })
      ).status,
    ).toBe(403);
    for (const body of [
      { name: 'Escalada', role: 'ADMIN' },
      { name: 'Actor falso', createdByUserId: randomUUID() },
      { name: 'Estado falso', status: 'ACTIVE' },
      { name: 'Miembro falso', memberId: randomUUID() },
    ]) {
      expect((await request('POST', '/organizations', { actor, body })).status).toBe(400);
    }
    expect(await database.prisma.organization.count()).toBe(before);
    expect((await request('POST', '/organizations', { body: { name: 'Anónima' } })).status).toBe(
      401,
    );
    for (const ineligible of [
      await createActor('ACTIVE', false),
      await createActor('SUSPENDED'),
      await createActor('DEACTIVATED'),
    ]) {
      expect(
        (
          await request('POST', '/organizations', {
            actor: ineligible,
            body: { name: 'No permitida' },
          })
        ).status,
      ).toBe(401);
    }
  });

  it('autoriza el preflight CORS exacto para PATCH con credenciales y headers permitidos', async () => {
    const response = await fetch(`${baseUrl}/organizations/${randomUUID()}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type,x-csrf-token,x-request-id',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')?.split(',')).toContain('PATCH');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-csrf-token',
    );
  });

  it('oculta Organization ajena/inexistente y autoriza PATCH solo a ADMIN', async () => {
    const admin = await createActor();
    const professional = await createActor();
    const outsider = await createActor();
    const organization = await createOrganization(admin);
    await database.prisma.organizationMember.create({
      data: {
        organizationId: organization.id,
        userId: professional.userId,
        role: 'PROFESSIONAL_MEMBER',
        status: 'ACTIVE',
      },
    });
    const missing = randomUUID();
    for (const id of [organization.id, missing]) {
      expect(
        (await request('GET', `/organizations/${id}`, { actor: outsider, origin: null })).status,
      ).toBe(404);
    }
    expect(
      (
        await request('PATCH', `/organizations/${organization.id}`, {
          actor: professional,
          body: { name: 'Escalada rechazada' },
        })
      ).status,
    ).toBe(403);
    const requestId = `organization-update-${randomUUID()}`;
    const updated = await request('PATCH', `/organizations/${organization.id}`, {
      actor: admin,
      body: { name: '  Nombre actualizado  ' },
      requestId,
    });
    expect(updated).toMatchObject({ status: 200, body: { name: 'Nombre actualizado' } });
    const audit = await database.prisma.auditEvent.findFirstOrThrow({
      where: { requestId, action: 'ORGANIZATION_UPDATED' },
    });
    expect(audit.metadata).toEqual({ changedFields: ['name'] });
    expect(JSON.stringify(audit)).not.toContain('Nombre actualizado');
  });

  it('serializa dos ediciones concurrentes y audita cada commit', async () => {
    const admin = await createActor();
    const organization = await createOrganization(admin, 'Antes de concurrencia');
    const requestIds = [`update-a-${randomUUID()}`, `update-b-${randomUUID()}`];
    const blocker = await createNamedPrismaClient(`b14_patch_order_blocker_${randomUUID()}`);
    const observer = await createNamedPrismaClient(`b14_patch_order_observer_${randomUUID()}`);
    let release!: () => void;
    let ready!: (pid: number) => void;
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));
    const blockerReady = new Promise<number>((resolve) => (ready = resolve));
    const heldLock = blocker.$transaction(async (tx) => {
      const backend = await tx.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${organization.id}::uuid FOR UPDATE`,
      );
      ready(backend[0]!.pid);
      await releaseSignal;
    });
    let first: Promise<ApiResponse> | undefined;
    let second: Promise<ApiResponse> | undefined;
    let firstPid = -1;
    let secondPid = -1;
    try {
      const blockerPid = await blockerReady;
      const firstStarted = transactionObserver.waitFor({
        requestId: requestIds[0]!,
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
      });
      first = request('PATCH', `/organizations/${organization.id}`, {
        actor: admin,
        body: { name: 'Edición concurrente A' },
        requestId: requestIds[0],
      });
      const firstTransaction = await firstStarted;
      const firstBlocked = await waitForQueryBlockedBy(observer, {
        blockerPid,
        databaseName,
        applicationName: apiApplicationName,
        expectedQuery: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
        requestId: requestIds[0]!,
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
        transaction: firstTransaction,
        diagnosticRoute: '/organizations/:id',
        allowedWaitEvents: ['transactionid', 'tuple'],
        expectedBlockedPid: firstTransaction.backendPid,
        expectedVirtualTransactionId: firstTransaction.virtualTransactionId,
      });
      firstPid = firstBlocked.pid;

      const secondStarted = transactionObserver.waitFor({
        requestId: requestIds[1]!,
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
      });
      second = request('PATCH', `/organizations/${organization.id}`, {
        actor: admin,
        body: { name: 'Edición concurrente B' },
        requestId: requestIds[1],
      });
      const secondTransaction = await secondStarted;
      expect(secondTransaction.requestId).toBe(requestIds[1]);
      expect(secondTransaction.virtualTransactionId).toMatch(/^\d+\/\d+$/);
      await expect(
        waitForQueryBlockedBy(observer, {
          blockerPid: firstPid,
          databaseName,
          applicationName: apiApplicationName,
          expectedQuery: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
          requestId: requestIds[0]!,
          operation: 'ORGANIZATION_UPDATE',
          attempt: 1,
          transaction: secondTransaction,
          allowedWaitEvents: ['transactionid', 'tuple'],
          expectedBlockedPid: secondTransaction.backendPid,
          expectedVirtualTransactionId: secondTransaction.virtualTransactionId,
        }),
      ).rejects.toThrow('evento causal esperado');
      await expect(
        waitForQueryBlockedBy(observer, {
          blockerPid: firstPid,
          databaseName,
          applicationName: apiApplicationName,
          expectedQuery: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
          requestId: requestIds[1]!,
          operation: 'ORGANIZATION_UPDATE',
          attempt: 1,
          transaction: secondTransaction,
          diagnosticRoute: '/organizations/:id',
          allowedWaitEvents: ['transactionid', 'tuple'],
          expectedBlockedPid: firstPid,
          expectedVirtualTransactionId: secondTransaction.virtualTransactionId,
        }),
      ).rejects.toThrow('evento causal esperado');
      const secondBlocked = await waitForQueryBlockedBy(observer, {
        blockerPid: firstPid,
        databaseName,
        applicationName: apiApplicationName,
        expectedQuery: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
        requestId: requestIds[1]!,
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
        transaction: secondTransaction,
        diagnosticRoute: '/organizations/:id',
        allowedWaitEvents: ['transactionid', 'tuple'],
        expectedBlockedPid: secondTransaction.backendPid,
        expectedVirtualTransactionId: secondTransaction.virtualTransactionId,
      });
      secondPid = secondBlocked.pid;
      expect(secondPid).not.toBe(firstPid);
      release();
      await heldLock;
    } finally {
      release();
      await heldLock.catch(() => undefined);
      await Promise.all([first?.catch(() => undefined), second?.catch(() => undefined)]);
      await Promise.all([blocker.$disconnect(), observer.$disconnect()]);
      transactionObserver.clearRequest(requestIds[0]!);
      transactionObserver.clearRequest(requestIds[1]!);
      expect([
        transactionObserver.eventCount(),
        transactionObserver.waiterCount(),
        transactionObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);
    }
    const responses = await Promise.all([first!, second!]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    expect(responses.map(({ body }) => body)).toEqual([
      expect.objectContaining({ name: 'Edición concurrente A' }),
      expect.objectContaining({ name: 'Edición concurrente B' }),
    ]);
    const persisted = await database.prisma.organization.findUniqueOrThrow({
      where: { id: organization.id },
    });
    expect(persisted.name).toBe('Edición concurrente B');
    const audits = await database.prisma.auditEvent.findMany({
      where: { requestId: { in: requestIds }, action: 'ORGANIZATION_UPDATED' },
      select: { requestId: true, metadata: true },
    });
    expect(audits).toHaveLength(2);
    expect(new Set(audits.map(({ requestId }) => requestId))).toEqual(new Set(requestIds));
    expect(
      audits.every(({ metadata }) => JSON.stringify(metadata) === '{"changedFields":["name"]}'),
    ).toBe(true);
  });

  it.each(['SUSPENDED', 'DEACTIVATED'] as const)(
    'PATCH espera el lock User y rechaza al actor %s tras la relectura',
    async (status) => {
      const actor = await createActor();
      const organization = await createOrganization(actor, `Antes de ${status}`);
      const requestId = `race-user-${status}-${randomUUID()}`;
      const response = await raceCommittedInvalidation(
        requestId,
        async (tx) => {
          await tx.user.update({ where: { id: actor.userId }, data: { status } });
        },
        'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
        () =>
          request('PATCH', `/organizations/${organization.id}`, {
            actor,
            body: { name: 'No autorizada' },
            requestId,
          }),
      );
      expect(response).toMatchObject({
        status: 401,
        body: { error: { code: 'AUTHENTICATION_REQUIRED' } },
      });
      expect(
        await database.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
      ).toMatchObject({
        status,
      });
      await expectNoUpdateEffect(organization.id, `Antes de ${status}`, requestId);
    },
    10_000,
  );

  it('PATCH espera el lock User y rechaza un sessionVersion incrementado', async () => {
    const actor = await createActor();
    const organization = await createOrganization(actor, 'Antes de sessionVersion');
    const requestId = `race-version-${randomUUID()}`;
    const response = await raceCommittedInvalidation(
      requestId,
      async (tx) => {
        await tx.user.update({
          where: { id: actor.userId },
          data: { sessionVersion: { increment: 1 } },
        });
      },
      'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
      () =>
        request('PATCH', `/organizations/${organization.id}`, {
          actor,
          body: { name: 'No autorizada' },
          requestId,
        }),
    );
    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: 'AUTHENTICATION_REQUIRED' } },
    });
    const [user, session] = await Promise.all([
      database.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } }),
      database.prisma.session.findUniqueOrThrow({ where: { id: actor.sessionId } }),
    ]);
    expect(user.sessionVersion).toBe(session.issuedSessionVersion + 1);
    await expectNoUpdateEffect(organization.id, 'Antes de sessionVersion', requestId);
  }, 10_000);

  it('PATCH espera el lock Session y rechaza la revocación confirmada', async () => {
    const actor = await createActor();
    const organization = await createOrganization(actor, 'Antes de revocar sesión');
    const requestId = `race-session-${randomUUID()}`;
    const response = await raceCommittedInvalidation(
      requestId,
      async (tx) => {
        await tx.session.update({
          where: { id: actor.sessionId },
          data: { revokedAt: new Date(), revocationReason: 'LOGOUT' },
        });
      },
      'SELECT "id" FROM "session" WHERE "id" = $1::uuid FOR UPDATE',
      () =>
        request('PATCH', `/organizations/${organization.id}`, {
          actor,
          body: { name: 'No autorizada' },
          requestId,
        }),
    );
    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: 'AUTHENTICATION_REQUIRED' } },
    });
    expect(
      (await database.prisma.session.findUniqueOrThrow({ where: { id: actor.sessionId } }))
        .revokedAt,
    ).toBeInstanceOf(Date);
    await expectNoUpdateEffect(organization.id, 'Antes de revocar sesión', requestId);
  }, 10_000);

  it.each(['SUSPENDED', 'ARCHIVED'] as const)(
    'PATCH espera el lock Organization y rechaza el estado %s confirmado',
    async (status) => {
      const actor = await createActor();
      const originalName = `Antes de Organization ${status}`;
      const organization = await createOrganization(actor, originalName);
      const requestId = `race-organization-${status}-${randomUUID()}`;
      const response = await raceCommittedInvalidation(
        requestId,
        async (tx) => {
          await tx.organization.update({ where: { id: organization.id }, data: { status } });
        },
        'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
        () =>
          request('PATCH', `/organizations/${organization.id}`, {
            actor,
            body: { name: 'No autorizada' },
            requestId,
          }),
      );
      expect(response).toMatchObject({
        status: 403,
        body: { error: { code: 'ORGANIZATION_FORBIDDEN' } },
      });
      expect(
        await database.prisma.organization.findUniqueOrThrow({ where: { id: organization.id } }),
      ).toMatchObject({ name: originalName, status });
      await expectNoUpdateEffect(organization.id, originalName, requestId);
    },
    10_000,
  );

  it.each(['REVOKED', 'LEFT'] as const)(
    'PATCH espera el lock OrganizationMember y oculta la relación %s confirmada',
    async (status) => {
      const actor = await createActor();
      const originalName = `Antes de membership ${status}`;
      const organization = await createOrganization(actor, originalName);
      const membership = await database.prisma.organizationMember.findFirstOrThrow({
        where: { organizationId: organization.id, userId: actor.userId, status: 'ACTIVE' },
      });
      const requestId = `race-membership-${status}-${randomUUID()}`;
      const response = await raceCommittedInvalidation(
        requestId,
        async (tx) => {
          await tx.organizationMember.update({
            where: { id: membership.id },
            data: {
              status,
              endedAt: new Date(Math.max(Date.now(), membership.joinedAt.getTime() + 1)),
              endedReasonCode: 'CONCURRENT_TEST',
            },
          });
        },
        'SELECT "id" FROM "organization_member" WHERE "organization_id" = $1::uuid AND "user_id" = $2::uuid ORDER BY "id" FOR UPDATE',
        () =>
          request('PATCH', `/organizations/${organization.id}`, {
            actor,
            body: { name: 'No autorizada' },
            requestId,
          }),
      );
      expect(response).toMatchObject({
        status: 404,
        body: { error: { code: 'ORGANIZATION_NOT_FOUND' } },
      });
      expect(
        await database.prisma.organizationMember.findUniqueOrThrow({
          where: { id: membership.id },
        }),
      ).toMatchObject({ status });
      await expectNoUpdateEffect(organization.id, originalName, requestId);
    },
    10_000,
  );

  it.each(['REVOKED', 'LEFT'] as const)(
    'linealiza una lectura anterior a membership %s y oculta toda lectura posterior',
    async (status) => {
      const actor = await createActor();
      const organization = await createOrganization(actor, `Linealización de lectura ${status}`);
      const membership = await database.prisma.organizationMember.findFirstOrThrow({
        where: { organizationId: organization.id, userId: actor.userId, status: 'ACTIVE' },
      });
      const auxiliary = createPrismaClient();
      let release!: () => void;
      let ready!: () => void;
      const releaseSignal = new Promise<void>((resolve) => (release = resolve));
      const mutationReady = new Promise<void>((resolve) => (ready = resolve));
      const invalidation = auxiliary.$transaction(async (tx) => {
        await tx.organizationMember.update({
          where: { id: membership.id },
          data: {
            status,
            endedAt: new Date(Math.max(Date.now(), membership.joinedAt.getTime() + 1)),
            endedReasonCode: 'CONCURRENT_READ_TEST',
          },
        });
        ready();
        await releaseSignal;
      });
      try {
        await mutationReady;
        const beforeCommit = await request('GET', `/organizations/${organization.id}`, {
          actor,
          origin: null,
        });
        expect(beforeCommit.status).toBe(200);
        release();
        await invalidation;
        expect(
          (await request('GET', `/organizations/${organization.id}`, { actor, origin: null }))
            .status,
        ).toBe(404);
        expect(
          (
            await request('GET', `/organizations/${organization.id}/members`, {
              actor,
              origin: null,
            })
          ).status,
        ).toBe(404);
        expect((await request('GET', '/organizations', { actor, origin: null })).body).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: organization.id })]),
        );
      } finally {
        release();
        await invalidation.catch(() => undefined);
        await auxiliary.$disconnect();
      }
    },
  );

  it.each(['SUSPENDED', 'DEACTIVATED'] as const)(
    'linealiza lecturas antes y después de User %s sin reutilizar snapshot',
    async (status) => {
      const actor = await createActor();
      const organization = await createOrganization(actor, `Lecturas User ${status}`);
      const auxiliary = await createNamedPrismaClient(`b14_read_user_${randomUUID()}`);
      let release!: () => void;
      let ready!: () => void;
      const releaseSignal = new Promise<void>((resolve) => (release = resolve));
      const mutationReady = new Promise<void>((resolve) => (ready = resolve));
      const invalidation = auxiliary.$transaction(async (tx) => {
        await tx.user.update({ where: { id: actor.userId }, data: { status } });
        ready();
        await releaseSignal;
      });
      try {
        await mutationReady;
        expect(
          (await request('GET', `/organizations/${organization.id}`, { actor, origin: null }))
            .status,
        ).toBe(200);
        release();
        await invalidation;
        for (const path of [
          '/organizations',
          `/organizations/${organization.id}`,
          `/organizations/${organization.id}/members`,
        ]) {
          const response = await request('GET', path, { actor, origin: null });
          expect(response.status, path).toBe(401);
          expect(response.body).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
        }
      } finally {
        release();
        await invalidation.catch(() => undefined);
        await auxiliary.$disconnect();
      }
    },
  );

  it.each(['SUSPENDED', 'ARCHIVED'] as const)(
    'linealiza lecturas antes y después de Organization %s con proyección histórica',
    async (status) => {
      const actor = await createActor();
      const organization = await createOrganization(actor, `Lecturas Organization ${status}`);
      const auxiliary = await createNamedPrismaClient(`b14_read_organization_${randomUUID()}`);
      let release!: () => void;
      let ready!: () => void;
      const releaseSignal = new Promise<void>((resolve) => (release = resolve));
      const mutationReady = new Promise<void>((resolve) => (ready = resolve));
      const invalidation = auxiliary.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: organization.id }, data: { status } });
        ready();
        await releaseSignal;
      });
      try {
        await mutationReady;
        const beforeCommit = await request('GET', `/organizations/${organization.id}`, {
          actor,
          origin: null,
        });
        expect(beforeCommit).toMatchObject({ status: 200, body: { id: organization.id } });
        expect((beforeCommit.body as { name?: string }).name).toBe(
          `Lecturas Organization ${status}`,
        );
        release();
        await invalidation;
        const list = await request('GET', '/organizations', { actor, origin: null });
        expect(list.body).toEqual(
          expect.arrayContaining([{ id: organization.id, status, capabilities: [] }]),
        );
        expect(
          await request('GET', `/organizations/${organization.id}`, { actor, origin: null }),
        ).toEqual({ status: 200, body: { id: organization.id, status, capabilities: [] } });
        expect(
          (
            await request('GET', `/organizations/${organization.id}/members`, {
              actor,
              origin: null,
            })
          ).status,
        ).toBe(403);
      } finally {
        release();
        await invalidation.catch(() => undefined);
        await auxiliary.$disconnect();
      }
    },
  );

  it('revierte PATCH si falla la auditoría del servicio', async () => {
    const actor = await createActor();
    const organization = await createOrganization(actor, 'Antes del rollback PATCH');
    const requestId = `rollback-patch-${randomUUID()}`;
    await withAuditFailure(requestId, 1, 'P0001', async () => {
      const response = await request('PATCH', `/organizations/${organization.id}`, {
        actor,
        body: { name: 'No debe persistirse' },
        requestId,
      });
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' } },
      });
      await expectNoUpdateEffect(organization.id, 'Antes del rollback PATCH', requestId);
    });
  });

  it('reintenta un 40001 real, revalida y confirma un único efecto', async () => {
    const actor = await createActor();
    const requestId = `retry-transient-${randomUUID()}`;
    const name = `Retry transitorio ${randomUUID()}`;
    await withAuditFailure(requestId, 1, '40001', async (failure) => {
      const response = await request('POST', '/organizations', {
        actor,
        body: { name },
        requestId,
      });
      expect(response.status).toBe(201);
      const organizationId = (response.body as { id: string }).id;
      expect(
        await database.prisma.organization.count({ where: { id: organizationId, name } }),
      ).toBe(1);
      expect(await database.prisma.organizationMember.count({ where: { organizationId } })).toBe(1);
      expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(1);
      expect(await failure.attempts()).toBe(2);
    });
  });

  it('agota tres 40001 reales y revierte todos los intentos', async () => {
    const actor = await createActor();
    const requestId = `retry-persistent-${randomUUID()}`;
    const name = `Retry persistente ${randomUUID()}`;
    await withAuditFailure(requestId, 3, '40001', async (failure) => {
      const response = await request('POST', '/organizations', {
        actor,
        body: { name },
        requestId,
      });
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' } },
      });
      expect(await database.prisma.organization.count({ where: { name } })).toBe(0);
      expect(
        await database.prisma.organizationMember.count({ where: { organization: { name } } }),
      ).toBe(0);
      expect(await database.prisma.auditEvent.count({ where: { requestId } })).toBe(0);
      expect(await failure.attempts()).toBe(3);
    });
  });

  it('PATCH reintenta un 40001 real y confirma una sola actualización', async () => {
    const actor = await createActor();
    const organization = await createOrganization(actor, 'Antes del retry PATCH');
    const requestId = `retry-patch-transient-${randomUUID()}`;
    const firstStarted = transactionObserver.waitFor({
      requestId,
      operation: 'ORGANIZATION_UPDATE',
      attempt: 1,
    });
    const secondStarted = transactionObserver.waitFor({
      requestId,
      operation: 'ORGANIZATION_UPDATE',
      attempt: 2,
    });
    try {
      await withAuditFailure(requestId, 1, '40001', async (failure) => {
        const response = await request('PATCH', `/organizations/${organization.id}`, {
          actor,
          body: { name: 'Después del retry PATCH' },
          requestId,
        });
        const [firstAttempt, secondAttempt] = await Promise.all([firstStarted, secondStarted]);
        expect(firstAttempt).toMatchObject({ requestId, attempt: 1 });
        expect(secondAttempt).toMatchObject({ requestId, attempt: 2 });
        expect(firstAttempt.virtualTransactionId).toMatch(/^\d+\/\d+$/);
        expect(secondAttempt.virtualTransactionId).toMatch(/^\d+\/\d+$/);
        expect(secondAttempt.virtualTransactionId).not.toBe(firstAttempt.virtualTransactionId);
        await expect(
          waitForQueryBlockedBy({ $queryRaw: async () => [] } as never, {
            blockerPid: 1,
            databaseName,
            applicationName: apiApplicationName,
            expectedQuery: 'SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE',
            requestId,
            operation: 'ORGANIZATION_UPDATE',
            attempt: 2,
            transaction: firstAttempt,
            allowedWaitEvents: ['transactionid'],
            expectedBlockedPid: firstAttempt.backendPid,
            expectedVirtualTransactionId: firstAttempt.virtualTransactionId,
          }),
        ).rejects.toThrow('evento causal esperado');
        expect(response).toMatchObject({ status: 200, body: { name: 'Después del retry PATCH' } });
        expect(
          await database.prisma.auditEvent.count({
            where: { requestId, action: 'ORGANIZATION_UPDATED' },
          }),
        ).toBe(1);
        expect(await failure.attempts()).toBe(2);
      });
    } finally {
      transactionObserver.clearRequest(requestId);
      expect([
        transactionObserver.eventCount(requestId),
        transactionObserver.waiterCount(),
        transactionObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);
    }
  });

  it('PATCH agota tres 40001 reales y conserva íntegro el estado anterior', async () => {
    const actor = await createActor();
    const organization = await createOrganization(actor, 'Antes del conflicto persistente');
    const requestId = `retry-patch-persistent-${randomUUID()}`;
    await withAuditFailure(requestId, 3, '40001', async (failure) => {
      const response = await request('PATCH', `/organizations/${organization.id}`, {
        actor,
        body: { name: 'No debe persistirse' },
        requestId,
      });
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' } },
      });
      await expectNoUpdateEffect(organization.id, 'Antes del conflicto persistente', requestId);
      expect(await failure.attempts()).toBe(3);
    });
  });

  it('lista solo miembros ACTIVE con proyección mínima', async () => {
    const admin = await createActor();
    const active = await createActor();
    const revoked = await createActor();
    const left = await createActor();
    const organization = await createOrganization(admin);
    for (const [actor, status] of [
      [active, 'ACTIVE'],
      [revoked, 'REVOKED'],
      [left, 'LEFT'],
    ] as const) {
      const endedAt = new Date();
      await database.prisma.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: actor.userId,
          role: 'PROFESSIONAL_MEMBER',
          status,
          ...(status === 'ACTIVE'
            ? {}
            : {
                joinedAt: new Date(endedAt.getTime() - 1_000),
                endedAt,
                endedReasonCode: 'TEST_FIXTURE',
              }),
        },
      });
    }
    const response = await request('GET', `/organizations/${organization.id}/members`, {
      actor: active,
      origin: null,
    });
    expect(response.status).toBe(200);
    const members = response.body as Array<Record<string, unknown>>;
    expect(members).toHaveLength(2);
    expect(members.map(({ userId }) => userId)).toEqual(
      expect.arrayContaining([admin.userId, active.userId]),
    );
    expect(members.flatMap(Object.keys).sort()).not.toContain('email');
    expect(
      (await request('GET', `/organizations/${organization.id}`, { actor: revoked, origin: null }))
        .status,
    ).toBe(404);
    expect(
      (await request('GET', `/organizations/${organization.id}`, { actor: left, origin: null }))
        .status,
    ).toBe(404);
  });

  it.each(['REVOKED', 'LEFT'] as const)(
    'niega a una membership %s acceso B1.4 en todos los estados de Organization',
    async (membershipStatus) => {
      for (const organizationStatus of ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const) {
        const admin = await createActor();
        const formerMember = await createActor();
        const organization = await createOrganization(
          admin,
          `${membershipStatus} ${organizationStatus}`,
        );
        const endedAt = new Date();
        await database.prisma.organizationMember.create({
          data: {
            organizationId: organization.id,
            userId: formerMember.userId,
            role: 'PROFESSIONAL_MEMBER',
            status: membershipStatus,
            joinedAt: new Date(endedAt.getTime() - 1_000),
            endedAt,
            endedReasonCode: 'TEST_FIXTURE',
          },
        });
        if (organizationStatus !== 'ACTIVE') {
          await database.prisma.organization.update({
            where: { id: organization.id },
            data: { status: organizationStatus },
          });
        }
        expect(
          (
            await request('GET', `/organizations/${organization.id}`, {
              actor: formerMember,
              origin: null,
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await request('GET', `/organizations/${organization.id}/members`, {
              actor: formerMember,
              origin: null,
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await request('GET', '/organizations?limit=100&offset=0', {
              actor: formerMember,
              origin: null,
            })
          ).body,
        ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: organization.id })]));
      }
    },
  );

  it('limita SUSPENDED/ARCHIVED a proyección histórica mínima y niega operaciones', async () => {
    for (const status of ['SUSPENDED', 'ARCHIVED'] as const) {
      const actor = await createActor();
      const organization = await createOrganization(actor, `Organización ${status}`);
      await database.prisma.organization.update({
        where: { id: organization.id },
        data: { status },
      });
      const response = await request('GET', `/organizations/${organization.id}`, {
        actor,
        origin: null,
      });
      expect(response).toEqual({
        status: 200,
        body: { id: organization.id, status, capabilities: [] },
      });
      expect(
        (
          await request('PATCH', `/organizations/${organization.id}`, {
            actor,
            body: { name: 'No mutable' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request('GET', `/organizations/${organization.id}/members`, {
            actor,
            origin: null,
          })
        ).status,
      ).toBe(403);
    }
  });

  it('rechaza UUID malformado y expone ORGANIZATION_CREATE solo en sesión elegible', async () => {
    const actor = await createActor();
    expect(
      (await request('GET', '/organizations/no-es-uuid', { actor, origin: null })).status,
    ).toBe(400);
    const session = await request('GET', '/auth/session', { actor, origin: null });
    expect(session.body).toMatchObject({ capabilities: ['ORGANIZATION_CREATE'] });
    const unverified = await createActor('ACTIVE', false);
    expect(
      (await request('GET', '/auth/session', { actor: unverified, origin: null })).body,
    ).toEqual({
      authenticated: false,
    });
  });

  it('devuelve 503 antes de crear efectos cuando PostgreSQL no está disponible', async () => {
    const actor = await createActor();
    const before = await database.prisma.organization.count({
      where: { createdByUserId: actor.userId },
    });
    const originalDatabaseUrl = process.env.DATABASE_URL;
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
      const response = await fetch(`http://127.0.0.1:${address.port}/organizations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: `${cookieName}=${actor.cookie}`,
          'x-csrf-token': actor.csrfToken,
        },
        body: JSON.stringify({ name: 'Sin dependencia' }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' },
      });
    } finally {
      await unavailableApp?.close();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
    expect(
      await database.prisma.organization.count({ where: { createdByUserId: actor.userId } }),
    ).toBe(before);
  });

  it('un fallo del observer revierte PATCH y se informa como error interno explícito', async () => {
    const actor = await createActor();
    const organization = await createOrganization(actor, 'Antes del observer');
    const requestId = `observer-error-${randomUUID()}`;
    const original = transactionObserver.transactionStarted;
    try {
      transactionObserver.transactionStarted = () => {
        throw new Error('B14_OBSERVER_FAILURE');
      };
      const response = await request('PATCH', `/organizations/${organization.id}`, {
        actor,
        body: { name: 'No debe persistir' },
        requestId,
      });
      expect(response.status).toBe(500);
      await expectNoUpdateEffect(organization.id, 'Antes del observer', requestId);
      expect([
        transactionObserver.eventCount(requestId),
        transactionObserver.activeReceiptCount(),
      ]).toEqual([0, 0]);
    } finally {
      transactionObserver.transactionStarted = original;
      transactionObserver.clearRequest(requestId);
    }
  });

  it('rechaza el replay causal tras HTTP con el mismo PID físico y prueba VXID independientemente', async () => {
    const actor = await createActor();
    const organization = await createOrganization(actor, 'Antes del replay');
    const requestId = `replay-consumed-${randomUUID()}`;
    const otherRequestId = `replay-issued-${randomUUID()}`;
    const dedicatedObserver = new TestOrganizationTransactionObserver();
    const priorUrl = process.env.DATABASE_URL;
    let dedicatedApp: NestExpressApplication | undefined;
    let holder: Awaited<ReturnType<typeof createNamedPrismaClient>> | undefined;
    let inspector: Awaited<ReturnType<typeof createNamedPrismaClient>> | undefined;
    let release: (() => void) | undefined;
    let held: Promise<unknown> | undefined;
    let direct: Promise<unknown> | undefined;
    const sql = 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE';
    try {
      process.env.DATABASE_URL = databaseUrlForApplication(`b14_replay_api_${randomUUID()}`, true);
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(OrganizationTransactionObserver)
        .useValue(dedicatedObserver)
        .compile();
      dedicatedApp = moduleRef.createNestApplication<NestExpressApplication>({
        logger: false,
        bodyParser: false,
      });
      configureApplication(dedicatedApp, readAppConfig());
      await dedicatedApp.listen(0, '127.0.0.1');
      expect(dedicatedApp.get(OrganizationTransactionObserver)).toBe(dedicatedObserver);
      const dedicatedDatabase = dedicatedApp.get(DatabaseService).prisma;
      const address = dedicatedApp.getHttpServer().address();
      if (!address || typeof address === 'string')
        throw new Error('Puerto de replay no disponible.');
      const dedicatedUrl = `http://127.0.0.1:${address.port}`;
      process.env.DATABASE_URL = priorUrl;
      holder = await createNamedPrismaClient(`b14_replay_holder_${randomUUID()}`);
      inspector = await createNamedPrismaClient(`b14_replay_inspector_${randomUUID()}`);
      const patch = async (id: string, name: string) => {
        const response = await fetch(`${dedicatedUrl}/organizations/${organization.id}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:3000',
            cookie: `${cookieName}=${actor.cookie}`,
            'x-csrf-token': actor.csrfToken,
            'x-request-id': id,
          },
          body: JSON.stringify({ name }),
        });
        return response.status;
      };
      const hold = async () => {
        let unlock!: () => void;
        let ready!: (pid: number) => void;
        const signal = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const started = new Promise<number>((resolve) => {
          ready = resolve;
        });
        const running = holder!.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>(
              Prisma.sql`SELECT pg_backend_pid() AS pid`,
            );
            await tx.$queryRawUnsafe(sql, organization.id);
            ready(rows[0]!.pid);
            await signal;
          },
          { timeout: 15_000 },
        );
        void running.catch(() => undefined);
        held = running;
        release = unlock;
        return started;
      };
      const waitForDirectBlock = async (pid: number) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const activity = await inspector!.$queryRaw<
            Array<{ waitEventType: string | null; virtualTransactionId: string | null }>
          >(
            Prisma.sql`SELECT wait_event_type AS "waitEventType", (SELECT virtualtransaction::text FROM pg_locks WHERE pid = activity.pid AND locktype = 'virtualxid' AND granted = true) AS "virtualTransactionId" FROM pg_stat_activity AS activity WHERE pid = ${pid}`,
          );
          if (activity[0]?.waitEventType === 'Lock' && activity[0].virtualTransactionId) {
            return activity[0].virtualTransactionId;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('El SQL directo nunca quedó bloqueado en el PID causal.');
      };

      const firstBlockerPid = await hold();
      const firstWait = dedicatedObserver.waitFor({
        requestId,
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
        timeoutMs: 5_000,
      });
      const pendingPatch = patch(requestId, 'Después del PATCH');
      let receipt;
      try {
        receipt = await Promise.race([
          firstWait,
          pendingPatch.then((status) => {
            throw new Error(`PATCH terminó antes del evento causal: HTTP ${status}`);
          }),
        ]);
      } catch (error) {
        const activity = await inspector.$queryRaw<
          Array<{ applicationName: string; state: string; waitEvent: string | null }>
        >(
          Prisma.sql`SELECT application_name AS "applicationName", state, wait_event AS "waitEvent" FROM pg_stat_activity WHERE datname = 'benhouse_test'`,
        );
        throw new Error(`Replay sin evento: ${JSON.stringify(activity)}`, { cause: error });
      }
      const expected = {
        blockerPid: firstBlockerPid,
        databaseName,
        applicationName: '',
        expectedQuery: sql,
        requestId,
        operation: 'ORGANIZATION_UPDATE' as const,
        attempt: 1,
        transaction: receipt,
        allowedWaitEvents: ['transactionid', 'tuple'],
        expectedBlockedPid: receipt.backendPid,
        expectedVirtualTransactionId: receipt.virtualTransactionId,
        timeoutMs: 1_500,
      };
      const applicationRows = await inspector.$queryRaw<Array<{ applicationName: string }>>(
        Prisma.sql`SELECT application_name AS "applicationName" FROM pg_stat_activity WHERE pid = ${receipt.backendPid}`,
      );
      expected.applicationName = applicationRows[0]!.applicationName;
      await expect(waitForQueryBlockedBy(inspector, expected)).resolves.toMatchObject({
        pid: receipt.backendPid,
        virtualTransactionId: receipt.virtualTransactionId,
      });
      release!();
      await held;
      release = undefined;
      expect(await pendingPatch).toBe(200);
      dedicatedObserver.clearRequest(requestId);
      expect([
        dedicatedObserver.eventCount(),
        dedicatedObserver.waiterCount(),
        dedicatedObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);

      const secondBlockerPid = await hold();
      const reusedPid = await dedicatedDatabase.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      expect(reusedPid[0]!.pid).toBe(receipt.backendPid);
      direct = dedicatedDatabase.$queryRawUnsafe(sql, organization.id).then((value) => value);
      const reusedVxid = await waitForDirectBlock(receipt.backendPid);
      expect(reusedVxid).not.toBe(receipt.virtualTransactionId);
      let polls = 0;
      await expect(
        waitForQueryBlockedBy(
          {
            $queryRaw: async () => {
              polls++;
              return [];
            },
          } as never,
          { ...expected, blockerPid: secondBlockerPid },
        ),
      ).rejects.toThrow('evento causal esperado');
      expect(polls).toBe(0);
      release!();
      await held;
      await direct;
      release = undefined;
      direct = undefined;

      const issuedWait = dedicatedObserver.waitFor({
        requestId: otherRequestId,
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
      });
      const finalPatch = patch(otherRequestId, 'Transacción nueva');
      const issued = await issuedWait;
      expect(await finalPatch).toBe(200);
      const thirdBlockerPid = await hold();
      const again = await dedicatedDatabase.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      expect(again[0]!.pid).toBe(issued.backendPid);
      direct = dedicatedDatabase.$queryRawUnsafe(sql, organization.id).then((value) => value);
      const issuedReusedVxid = await waitForDirectBlock(issued.backendPid);
      expect(issuedReusedVxid).not.toBe(issued.virtualTransactionId);
      await expect(
        waitForQueryBlockedBy(inspector, {
          ...expected,
          blockerPid: thirdBlockerPid,
          requestId: otherRequestId,
          transaction: issued,
          expectedBlockedPid: issued.backendPid,
          expectedVirtualTransactionId: issued.virtualTransactionId,
        }),
      ).rejects.toThrow('transacción virtual causal ya no está activa');
      release!();
      await held;
      await direct;
      release = undefined;
      direct = undefined;
      expect(
        await dedicatedDatabase.auditEvent.count({
          where: { requestId, action: 'ORGANIZATION_UPDATED' },
        }),
      ).toBe(1);
      expect(
        await dedicatedDatabase.auditEvent.count({
          where: { requestId: otherRequestId, action: 'ORGANIZATION_UPDATED' },
        }),
      ).toBe(1);
      dedicatedObserver.clearRequest(otherRequestId);
      expect([
        dedicatedObserver.eventCount(),
        dedicatedObserver.waiterCount(),
        dedicatedObserver.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);
    } finally {
      release?.();
      await Promise.all([held?.catch(() => undefined), direct?.catch(() => undefined)]);
      dedicatedObserver.clearRequest(requestId);
      dedicatedObserver.clearRequest(otherRequestId);
      await Promise.all([dedicatedApp?.close(), holder?.$disconnect(), inspector?.$disconnect()]);
      if (priorUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorUrl;
    }
  }, 45_000);
});
