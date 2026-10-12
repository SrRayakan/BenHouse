import '../../test/verified-database.mjs';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readAppConfig } from '@benhouse/config';
import { createPrismaClient } from '@benhouse/database';
import { AppModule } from '../app.module';
import { configureApplication } from '../main';
import { DatabaseService } from '../infrastructure/database/database.service';
import { createSessionToken, sessionSecretDigest } from '../auth/session-token';
import { deriveCsrfToken } from '../auth/csrf';
import { MarketplaceTransactionObserver } from './marketplace-transaction-observer';
import {
  CausalWorkScope,
  TestOrganizationTransactionObserver,
  waitForQueryBlockedBy,
  withAuditFailureFixture,
} from '../organizations/postgres-test-fixtures';

type Actor = { userId: string; sessionId: string; cookie: string; csrf: string };

describe('C1.1 Location HTTP/PostgreSQL', () => {
  let app: NestExpressApplication;
  let database: DatabaseService;
  let baseUrl: string;
  let cookieName: string;
  let verifiedTestDatabase = false;
  const suite = randomUUID();
  const observer = new TestOrganizationTransactionObserver();
  const ids = {
    users: [] as string[],
    properties: [] as string[],
    organizations: [] as string[],
    locations: [] as string[],
    requests: [] as string[],
  };
  let countryId: string;
  let municipalityId: string;
  const priorDatabaseUrl = process.env.DATABASE_URL;
  const applicationName = `c11_${suite}`;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('application_name', applicationName);
    process.env.DATABASE_URL = url.toString();
    const config = readAppConfig();
    cookieName = config.auth.sessionCookieName;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MarketplaceTransactionObserver)
      .useValue(observer)
      .compile();
    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    configureApplication(app, config);
    await app.listen(0, '127.0.0.1');
    database = app.get(DatabaseService);
    const identity = await database.prisma.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    expect(identity[0]?.name).toBe(process.env.API_TEST_DATABASE_NAME);
    verifiedTestDatabase = true;
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Puerto no disponible.');
    baseUrl = `http://127.0.0.1:${address.port}`;
    countryId = randomUUID();
    municipalityId = randomUUID();
    ids.locations.push(countryId, municipalityId);
    await database.prisma.location.create({
      data: {
        id: countryId,
        code: `c11-${suite}-root`,
        name: 'País sintético C1.1',
        kind: 'COUNTRY',
        demoSynthetic: true,
      },
    });
    await database.prisma.location.create({
      data: {
        id: municipalityId,
        code: `c11-${suite}-city`,
        name: 'Municipio sintético C1.1',
        kind: 'MUNICIPALITY',
        parentLocationId: countryId,
        parentKind: 'COUNTRY',
        demoSynthetic: true,
      },
    });
  }, 30_000);

  afterAll(async () => {
    try {
      if (verifiedTestDatabase) {
        await database.prisma.$transaction(async (tx) => {
          await tx.listing.deleteMany({ where: { propertyId: { in: ids.properties } } });
          await tx.propertyAuthorization.deleteMany({
            where: { propertyId: { in: ids.properties } },
          });
          await tx.property.deleteMany({ where: { id: { in: ids.properties } } });
          for (const id of [...ids.locations].reverse())
            await tx.location.deleteMany({ where: { id } });
          await tx.organizationMember.deleteMany({
            where: { organizationId: { in: ids.organizations } },
          });
          await tx.organization.deleteMany({ where: { id: { in: ids.organizations } } });
          await tx.session.deleteMany({ where: { userId: { in: ids.users } } });
          // Excepción exclusiva del test: IDs exactos de esta ejecución, nunca por prefijo heredado.
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await tx.auditEvent.deleteMany({
            where: { requestId: { in: ids.requests }, actorUserId: { in: ids.users } },
          });
          await tx.$executeRaw`SET LOCAL session_replication_role = origin`;
          await tx.user.deleteMany({ where: { id: { in: ids.users } } });
        });
        expect(await database.prisma.location.count({ where: { id: { in: ids.locations } } })).toBe(
          0,
        );
        expect(
          await database.prisma.auditEvent.count({ where: { requestId: { in: ids.requests } } }),
        ).toBe(0);
      }
      expect([
        observer.eventCount(),
        observer.waiterCount(),
        observer.activeReceiptCount(),
      ]).toEqual([0, 0, 0]);
    } finally {
      await app?.close();
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
    }
  });

  function requestId() {
    const id = `c11-${randomUUID()}`;
    ids.requests.push(id);
    return id;
  }
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
  ) {
    const headers: Record<string, string> = { 'x-request-id': options.requestId ?? requestId() };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.origin !== null) headers.origin = options.origin ?? 'http://localhost:3000';
    if (options.actor) headers.cookie = `${cookieName}=${options.actor.cookie}`;
    const csrf = options.csrf === undefined ? options.actor?.csrf : options.csrf;
    if (csrf) headers['x-csrf-token'] = csrf;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as unknown,
      headers: response.headers,
    };
  }
  async function actor(): Promise<Actor> {
    const userId = randomUUID();
    ids.users.push(userId);
    const now = new Date();
    const user = await database.prisma.user.create({
      data: {
        id: userId,
        email: `c11-${userId}@example.test`,
        displayName: 'Actor sintético C1.1',
        emailVerifiedAt: now,
      },
    });
    const config = readAppConfig();
    const token = createSessionToken();
    await database.prisma.session.create({
      data: {
        id: token.selector,
        userId,
        secretDigest: new Uint8Array(
          sessionSecretDigest(
            token.selector,
            token.secret,
            config.auth.sessionTokenKeys.currentVersion,
            config.auth.sessionTokenKeys,
          )!,
        ),
        secretKeyVersion: config.auth.sessionTokenKeys.currentVersion,
        issuedSessionVersion: user.sessionVersion,
        createdAt: now,
        lastActivityAt: now,
        idleExpiresAt: new Date(now.getTime() + 300_000),
        absoluteExpiresAt: new Date(now.getTime() + 600_000),
      },
    });
    return {
      userId,
      sessionId: token.selector,
      cookie: token.value,
      csrf: deriveCsrfToken(token.selector, user.sessionVersion, config.auth.csrfKeys),
    };
  }
  async function property(owner: Actor) {
    const id = randomUUID();
    ids.properties.push(id);
    await database.prisma.property.create({
      data: {
        id,
        type: 'HOUSE',
        authorizations: {
          create: {
            userId: owner.userId,
            grantedByUserId: owner.userId,
            authorizationType: 'OWNER',
          },
        },
      },
    });
    return id;
  }
  const locationBody = (expectedVersion = 0) => ({
    expectedVersion,
    locationId: municipalityId,
    streetName: 'Vía sintética C1.1',
    streetNumber: 'S/N',
    addressUnit: 'Unidad sintética',
    postalCode: 'SYNTH',
    coordinates: { latitude: 2.5, longitude: -1.25 },
  });
  const path = (id: string) => `/properties/${id}/location`;

  it('consulta catálogo público paginado, jerarquía, vacío, errores y proyección permitida', async () => {
    expect((await request('GET', `/locations/${countryId}`)).body).toEqual({
      id: countryId,
      code: `c11-${suite}-root`,
      name: 'País sintético C1.1',
      kind: 'COUNTRY',
      parentLocationId: null,
      demoSynthetic: true,
    });
    const children = await request('GET', `/locations/${countryId}/children?limit=1`);
    expect(children.status).toBe(200);
    expect(children.body).toMatchObject([{ id: municipalityId, parentLocationId: countryId }]);
    expect((await request('GET', `/locations/${municipalityId}/children`)).body).toEqual([]);
    expect((await request('GET', '/locations?limit=1')).status).toBe(200);
    for (const suffix of ['?limit=101', '?limit=1&limit=2', '?unknown=1', '?offset=10001'])
      expect((await request('GET', `/locations${suffix}`)).status).toBe(400);
    expect((await request('GET', `/locations/${randomUUID()}/children`)).status).toBe(404);
    expect((await request('GET', '/locations/not-an-id')).status).toBe(400);
    expect((await request('POST', '/locations', { body: { name: 'No autorizado' } })).status).toBe(
      404,
    );
  });

  it('asocia/modifica, conserva Listing DRAFT, oculta dirección y audita sin contenido privado', async () => {
    const owner = await actor();
    const id = await property(owner);
    expect((await request('GET', path(id), { actor: owner })).body).toMatchObject({
      locationId: null,
      version: 0,
      coordinates: null,
    });
    const listing = await database.prisma.listing.create({
      data: {
        propertyId: id,
        publisherUserId: owner.userId,
        transactionType: 'SALE',
        price: '100',
        currency: 'EUR',
        description: 'Anuncio sintético C1.1',
      },
    });
    const writeId = requestId();
    const result = await request('PUT', path(id), {
      actor: owner,
      body: locationBody(),
      requestId: writeId,
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.body).toMatchObject({
      propertyId: id,
      locationId: municipalityId,
      version: 1,
      coordinates: { latitude: 2.5, longitude: -1.25 },
    });
    const read = await request('GET', path(id), { actor: owner });
    expect(read.body).toEqual(result.body);
    expect(read.headers.get('cache-control')).toBe('no-store');
    for (const resource of [
      `/properties/${id}`,
      '/properties',
      `/listings/${listing.id}`,
      '/listings',
      `/locations/${municipalityId}`,
    ]) {
      const response = await request('GET', resource, { actor: owner });
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toMatch(
        /streetName|streetNumber|addressUnit|postalCode|coordinates|locationPoint|Vía sintética/,
      );
    }
    const audit = await database.prisma.auditEvent.findFirstOrThrow({
      where: { requestId: writeId },
    });
    expect(audit.metadata).toEqual({ locationVersion: 1 });
    expect(audit.action).toBe('PROPERTY_LOCATION_SET');
    expect(
      (await request('PUT', path(id), { actor: owner, body: locationBody(), requestId: writeId }))
        .status,
    ).toBe(409);
    expect(await database.prisma.auditEvent.count({ where: { requestId: writeId } })).toBe(1);
    const modified = await request('PUT', path(id), {
      actor: owner,
      body: { expectedVersion: 1, locationId: countryId },
    });
    expect(modified.body).toMatchObject({
      locationId: countryId,
      version: 2,
      streetName: null,
      streetNumber: null,
      addressUnit: null,
      postalCode: null,
      coordinates: null,
    });
    expect(await database.prisma.listing.findUnique({ where: { id: listing.id } })).toEqual(
      listing,
    );
  });

  it('rechaza IDOR, PUBLISHER, sesión/CSRF/Origin, referencias inexistentes y mass assignment sin efectos', async () => {
    const owner = await actor();
    const stranger = await actor();
    const publisher = await actor();
    const id = await property(owner);
    await database.prisma.propertyAuthorization.create({
      data: {
        propertyId: id,
        userId: publisher.userId,
        grantedByUserId: owner.userId,
        authorizationType: 'PUBLISHER',
      },
    });
    for (const candidate of [stranger, publisher]) {
      expect((await request('GET', path(id), { actor: candidate })).status).toBe(404);
      expect(
        (await request('PUT', path(id), { actor: candidate, body: locationBody() })).status,
      ).toBe(404);
    }
    expect((await request('GET', path(id))).status).toBe(401);
    expect((await request('PUT', path(id), { body: locationBody() })).status).toBe(401);
    for (const extra of [
      { origin: null },
      { origin: 'https://evil.example' },
      { csrf: null },
      { csrf: 'bad' },
    ])
      expect(
        (await request('PUT', path(id), { actor: owner, body: locationBody(), ...extra })).status,
      ).toBe(403);
    expect(
      (await request('PUT', path(randomUUID()), { actor: owner, body: locationBody() })).status,
    ).toBe(404);
    expect(
      (
        await request('PUT', path(id), {
          actor: owner,
          body: { ...locationBody(), locationId: randomUUID() },
        })
      ).status,
    ).toBe(404);
    for (const extra of [
      { userId: owner.userId },
      { parentLocationId: countryId },
      { coordinates: { latitude: 91, longitude: 0 } },
      { expectedVersion: -1 },
    ])
      expect(
        (await request('PUT', path(id), { actor: owner, body: { ...locationBody(), ...extra } }))
          .status,
      ).toBe(400);
    expect(
      (
        await request('PATCH', `/properties/${id}`, {
          actor: owner,
          body: { locationId: municipalityId },
        })
      ).status,
    ).toBe(400);
    expect(await database.prisma.property.findUnique({ where: { id } })).toMatchObject({
      locationVersion: 0,
      locationId: null,
    });
    expect(await database.prisma.auditEvent.count({ where: { resourceId: id } })).toBe(0);
  });

  it.each(['expired', 'future', 'revoked', 'session-revoked', 'archived'])(
    'rechaza autorización/estado no vigente %s',
    async (scenario) => {
      const owner = await actor();
      const manager = await actor();
      const id = await property(owner);
      const now = new Date();
      await database.prisma.propertyAuthorization.create({
        data: {
          propertyId: id,
          userId: manager.userId,
          grantedByUserId: owner.userId,
          authorizationType: 'MANAGER',
          createdAt: new Date(now.getTime() - 3000),
          validFrom: new Date(now.getTime() + (scenario === 'future' ? 60000 : -2000)),
          validUntil: scenario === 'expired' ? new Date(now.getTime() - 1000) : null,
          status: scenario === 'revoked' ? 'REVOKED' : 'ACTIVE',
          revokedAt: scenario === 'revoked' ? now : null,
        },
      });
      if (scenario === 'session-revoked')
        await database.prisma.session.update({
          where: { id: manager.sessionId },
          data: { revokedAt: now, revocationReason: 'LOGOUT' },
        });
      if (scenario === 'archived')
        await database.prisma.property.update({ where: { id }, data: { status: 'ARCHIVED' } });
      expect(
        (await request('PUT', path(id), { actor: manager, body: locationBody() })).status,
      ).toBe(scenario === 'session-revoked' ? 401 : scenario === 'archived' ? 409 : 404);
      expect(await database.prisma.property.findUnique({ where: { id } })).toMatchObject({
        locationVersion: 0,
      });
    },
  );

  it('autoriza organización gestora, exige relación propia, membership y organización activas', async () => {
    const owner = await actor();
    const member = await actor();
    const id = await property(owner);
    const orgId = randomUUID();
    ids.organizations.push(orgId);
    await database.prisma.organization.create({
      data: { id: orgId, name: 'Gestora sintética C1.1', createdByUserId: member.userId },
    });
    const membership = await database.prisma.organizationMember.create({
      data: { userId: member.userId, organizationId: orgId, role: 'PROFESSIONAL_MEMBER' },
    });
    expect((await request('PUT', path(id), { actor: member, body: locationBody() })).status).toBe(
      404,
    );
    await database.prisma.propertyAuthorization.create({
      data: {
        propertyId: id,
        organizationId: orgId,
        grantedByUserId: owner.userId,
        authorizationType: 'MANAGER',
      },
    });
    expect((await request('PUT', path(id), { actor: member, body: locationBody() })).status).toBe(
      200,
    );
    await database.prisma.organization.update({
      where: { id: orgId },
      data: { status: 'SUSPENDED' },
    });
    expect((await request('GET', path(id), { actor: member })).status).toBe(404);
    expect((await request('PUT', path(id), { actor: member, body: locationBody(1) })).status).toBe(
      404,
    );
    await database.prisma.organization.update({ where: { id: orgId }, data: { status: 'ACTIVE' } });
    await database.prisma.organizationMember.update({
      where: { id: membership.id },
      data: { status: 'REVOKED', endedAt: new Date(), endedReasonCode: 'TEST' },
    });
    expect((await request('PUT', path(id), { actor: member, body: locationBody(1) })).status).toBe(
      404,
    );
  });

  it('dos actores con la misma versión solo confirman una escritura y una auditoría', async () => {
    const owner = await actor();
    const manager = await actor();
    const id = await property(owner);
    await database.prisma.propertyAuthorization.create({
      data: {
        propertyId: id,
        userId: manager.userId,
        grantedByUserId: owner.userId,
        authorizationType: 'MANAGER',
      },
    });
    const results = await Promise.all(
      [owner, manager].map((candidate, index) =>
        request('PUT', path(id), {
          actor: candidate,
          body: { ...locationBody(), streetNumber: String(index) },
        }),
      ),
    );
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(await database.prisma.property.findUnique({ where: { id } })).toMatchObject({
      locationVersion: 1,
    });
    expect(
      await database.prisma.auditEvent.count({
        where: { resourceId: id, action: 'PROPERTY_LOCATION_SET' },
      }),
    ).toBe(1);
  });

  it('revierte ubicación y versión cuando falla la auditoría', async () => {
    const owner = await actor();
    const id = await property(owner);
    const writeId = requestId();
    await withAuditFailureFixture(
      database.prisma,
      { requestId: writeId, failures: 1, sqlState: 'P0001' },
      async () => {
        const result = await request('PUT', path(id), {
          actor: owner,
          body: locationBody(),
          requestId: writeId,
        });
        expect(result.status).toBe(503);
        expect(JSON.stringify(result.body)).not.toMatch(
          /Prisma|constraint|stack|P0001|Vía sintética/i,
        );
      },
    );
    expect(await database.prisma.property.findUnique({ where: { id } })).toMatchObject({
      locationId: null,
      locationVersion: 0,
      streetName: null,
    });
    expect(await database.prisma.auditEvent.count({ where: { requestId: writeId } })).toBe(0);
  });

  it('revalida tras una revocación concurrente confirmada antes de obtener el bloqueo', async () => {
    const owner = await actor();
    const manager = await actor();
    const id = await property(owner);
    const authorization = await database.prisma.propertyAuthorization.create({
      data: {
        propertyId: id,
        userId: manager.userId,
        grantedByUserId: owner.userId,
        authorizationType: 'MANAGER',
      },
    });
    const blocker = createPrismaClient();
    const diagnostic = createPrismaClient();
    const scope = new CausalWorkScope();
    let release!: () => void;
    let announce!: (pid: number) => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<number>((resolve) => {
      announce = resolve;
    });
    const writeId = requestId();
    try {
      const blocking = scope.observe(
        blocker.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            await tx.$queryRaw`SELECT id FROM property WHERE id = ${id}::uuid FOR UPDATE`;
            await tx.propertyAuthorization.update({
              where: { id: authorization.id },
              data: { status: 'REVOKED', revokedAt: new Date() },
            });
            announce(rows[0]!.pid);
            await released;
          },
          { timeout: 10000 },
        ),
      );
      const blockerPid = await scope.wait(ready);
      const started = observer.waitFor({
        requestId: writeId,
        operation: 'PROPERTY_LOCATION_SET',
        attempt: 1,
      });
      const pending = scope.observe(
        request('PUT', path(id), { actor: manager, body: locationBody(), requestId: writeId }),
      );
      const transaction = await scope.wait(started);
      await scope.wait(
        waitForQueryBlockedBy(diagnostic, {
          blockerPid,
          databaseName: process.env.API_TEST_DATABASE_NAME!,
          applicationName,
          expectedQuery: 'SELECT "id" FROM "property" WHERE "id" = $1::uuid FOR UPDATE',
          requestId: writeId,
          operation: 'PROPERTY_LOCATION_SET',
          attempt: 1,
          transaction,
          expectedBlockedPid: transaction.backendPid,
          expectedVirtualTransactionId: transaction.virtualTransactionId,
          allowedWaitEvents: ['transactionid', 'tuple'],
          timeoutMs: 3000,
        }),
      );
      release();
      await blocking;
      expect((await pending).status).toBe(404);
      expect(await database.prisma.property.findUnique({ where: { id } })).toMatchObject({
        locationVersion: 0,
        locationId: null,
      });
      expect(await database.prisma.auditEvent.count({ where: { requestId: writeId } })).toBe(0);
    } finally {
      release();
      await scope.settle();
      observer.clearRequest(writeId);
      await blocker.$disconnect();
      await diagnostic.$disconnect();
    }
  }, 15000);
});
