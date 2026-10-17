import '../../test/verified-database.mjs';
import 'reflect-metadata';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readAppConfig } from '@benhouse/config';
import { createPrismaClient } from '@benhouse/database';
import { configuredStorage, inspectImage, StorageProvider } from '@benhouse/storage';
import { AppModule } from '../app.module';
import { configureApplication } from '../main';
import { DatabaseService } from '../infrastructure/database/database.service';
import { createSessionToken, sessionSecretDigest } from '../auth/session-token';
import { deriveCsrfToken } from '../auth/csrf';
import { MarketplaceTransactionObserver } from '../marketplace/marketplace-transaction-observer';
import {
  CausalWorkScope,
  TestOrganizationTransactionObserver,
  waitForQueryBlockedBy,
  withAuditFailureFixture,
} from '../organizations/postgres-test-fixtures';

type Actor = { id: string; session: string; cookie: string; csrf: string };
// PNG sintético 1x1 generado con Sharp 0.35.5; CRC y decode se verifican antes de usarlo.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgaGAAAAEEAIEl6+oTAAAAAElFTkSuQmCC',
  'base64',
);
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('C1.2 Media HTTP/PostgreSQL y objetos aislados', () => {
  let app: NestExpressApplication, db: DatabaseService, base: string, storage: StorageProvider;
  const observer = new TestOrganizationTransactionObserver();
  const config = readAppConfig();
  const applicationName = `c12_${randomUUID()}`;
  const priorUrl = process.env.DATABASE_URL;
  beforeAll(async () => {
    // Fallar en la preparación si el fixture se corrompe, antes de cualquier carga HTTP.
    for (let offset = 8; offset < png.length;) {
      const end = offset + 8 + png.readUInt32BE(offset);
      expect(end + 4).toBeLessThanOrEqual(png.length);
      expect(crc32(png.subarray(offset + 4, end))).toBe(png.readUInt32BE(end));
      offset = end + 4;
    }
    expect(await inspectImage(png)).toMatchObject({
      mime: 'image/png',
      width: 1,
      height: 1,
      size: png.length,
    });
    if (!process.env.STORAGE_TEST_OWNER) throw new Error('Servicio efímero obligatorio');
    storage = await configuredStorage();
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('application_name', applicationName);
    process.env.DATABASE_URL = url.toString();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StorageProvider)
      .useValue(storage)
      .overrideProvider(MarketplaceTransactionObserver)
      .useValue(observer)
      .compile();
    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    configureApplication(app, config);
    await app.listen(0, '127.0.0.1');
    db = app.get(DatabaseService);
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Puerto no disponible');
    base = `http://127.0.0.1:${address.port}`;
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    if (priorUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorUrl;
    storage?.close();
    // Filas sintéticas pertenecen exclusivamente a la base efímera que elimina el runner.
  });
  it('aplica las seis migraciones y no presenta drift de schema', async () => {
    const rows = await db.prisma.$queryRaw<
      Array<{ name: string }>
    >`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(rows).toHaveLength(6);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', '-c default_transaction_read_only=on');
    const result = spawnSync(
      process.execPath,
      [
        resolve('../../packages/database/node_modules/prisma/build/index.js'),
        'migrate',
        'diff',
        '--from-url',
        url.toString(),
        '--to-schema-datamodel',
        resolve('../../packages/database/prisma/schema.prisma'),
        '--exit-code',
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('No difference detected');
  }, 35000);
  async function actor(): Promise<Actor> {
    const id = randomUUID(),
      now = new Date(),
      token = createSessionToken();
    await db.prisma.user.create({
      data: {
        id,
        email: `c12-${id}@example.test`,
        displayName: 'Actor sintético C1.2',
        emailVerifiedAt: now,
      },
    });
    await db.prisma.session.create({
      data: {
        id: token.selector,
        userId: id,
        secretDigest: new Uint8Array(
          sessionSecretDigest(
            token.selector,
            token.secret,
            config.auth.sessionTokenKeys.currentVersion,
            config.auth.sessionTokenKeys,
          )!,
        ),
        secretKeyVersion: config.auth.sessionTokenKeys.currentVersion,
        issuedSessionVersion: 1,
        lastActivityAt: now,
        createdAt: now,
        idleExpiresAt: new Date(now.getTime() + 3600_000),
        absoluteExpiresAt: new Date(now.getTime() + 3600_000),
      },
    });
    return {
      id,
      session: token.selector,
      cookie: token.value,
      csrf: deriveCsrfToken(token.selector, 1, config.auth.csrfKeys),
    };
  }
  async function property(owner: Actor) {
    return (
      await db.prisma.property.create({
        data: {
          type: 'HOUSE',
          authorizations: {
            create: { userId: owner.id, grantedByUserId: owner.id, authorizationType: 'OWNER' },
          },
        },
      })
    ).id;
  }
  async function http(
    method: string,
    path: string,
    a?: Actor,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const bytes = Buffer.isBuffer(body);
    const headers: Record<string, string> = {
      origin: 'http://localhost:3000',
      'x-request-id': randomUUID(),
      ...extra,
    };
    if (a) {
      headers.cookie = `${config.auth.sessionCookieName}=${a.cookie}`;
      headers['x-csrf-token'] = a.csrf;
    }
    if (body !== undefined && !headers['content-type'])
      headers['content-type'] = bytes ? 'image/png' : 'application/json';
    Object.assign(headers, extra);
    return fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : bytes ? new Uint8Array(body) : JSON.stringify(body),
    });
  }
  function input(propertyId: string, bytes = png) {
    return {
      propertyId,
      mime: 'image/png',
      size: bytes.length,
      sha256: hash(bytes),
      intentKey: randomUUID(),
      uploadToken: randomBytes(32).toString('hex'),
    };
  }
  async function intention(a: Actor, p: string, bytes = png) {
    const body = input(p, bytes);
    const response = await http('POST', '/media/upload-intent', a, body);
    expect(response.status, await response.clone().text()).toBe(201);
    const result = (await response.json()) as { media: { id: string }; upload: { url: string } };
    return { id: result.media.id, url: result.upload.url, token: body.uploadToken, body };
  }
  async function uploaded(a: Actor, p: string) {
    const i = await intention(a, p);
    const response = await http('PUT', i.url, a, png, { 'x-upload-token': i.token });
    expect(response.status, await response.clone().text()).toBe(200);
    return i;
  }
  async function ready(a: Actor, p: string) {
    const i = await uploaded(a, p);
    expect((await http('POST', `/media/${i.id}/complete-upload`, a, {})).status).toBe(200);
    return i;
  }
  it.each([
    'apng',
    'apngInvalidSecondFrame',
    'animatedWebp',
    'animatedGif',
    'svg',
    'gif',
    'tiff',
    'avif',
  ])('rechaza contenido ajeno o animado por HTTP y nunca confirma READY: %s', async (name) => {
    const fixtures = JSON.parse(
      await readFile(resolve('../../packages/storage/fixtures/animated.json'), 'utf8'),
    );
    const fixture = fixtures[name] as { mime: string; base64: string };
    const bytes = Buffer.from(fixture.base64, 'base64'),
      a = await actor(),
      p = await property(a);
    // Los formatos ajenos también se intentan camuflar como PNG: el rechazo
    // debe depender de sus bytes, no solamente del DTO o Content-Type.
    const admitted = ['image/jpeg', 'image/png', 'image/webp'].includes(fixture.mime);
    const mime = admitted ? fixture.mime : 'image/png';
    if (!admitted)
      expect(
        (
          await http('POST', '/media/upload-intent', a, {
            ...input(p, bytes),
            mime: fixture.mime,
          })
        ).status,
      ).toBe(400);
    const body = { ...input(p, bytes), mime };
    const intent = await http('POST', '/media/upload-intent', a, body);
    expect(intent.status).toBe(201);
    const { media, upload } = (await intent.json()) as {
      media: { id: string };
      upload: { url: string };
    };
    expect(
      (
        await http('PUT', upload.url, a, bytes, {
          'x-upload-token': body.uploadToken,
          'content-type': mime,
        })
      ).status,
    ).toBe(400);
    expect((await http('POST', `/media/${media.id}/complete-upload`, a, {})).status).toBe(409);
    const row = await db.prisma.media.findUniqueOrThrow({ where: { id: media.id } });
    expect(await storage.read(row.storageKey)).toBeNull();
    // También rechaza una carga fuera de la API ya presente en el servicio.
    await storage.put(row.storageKey, bytes);
    expect((await http('POST', `/media/${media.id}/complete-upload`, a, {})).status).toBe(400);
    expect(await db.prisma.media.count({ where: { propertyId: p, status: 'READY' } })).toBe(0);
    expect((await db.prisma.media.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
      'PENDING',
    );
  });
  it.each(['jpeg', 'png', 'webp'])(
    'conserva imagen estática válida %s en el flujo HTTP',
    async (format) => {
      const fixtures = JSON.parse(
        await readFile(resolve('../../packages/storage/fixtures/animated.json'), 'utf8'),
      );
      const fixture = fixtures[`static${format}`] as { mime: string; base64: string };
      const bytes = Buffer.from(fixture.base64, 'base64'),
        a = await actor(),
        p = await property(a);
      const body = { ...input(p, bytes), mime: fixture.mime };
      const intent = await http('POST', '/media/upload-intent', a, body);
      expect(intent.status).toBe(201);
      const { media, upload } = (await intent.json()) as {
        media: { id: string };
        upload: { url: string };
      };
      expect(
        (
          await http('PUT', upload.url, a, bytes, {
            'x-upload-token': body.uploadToken,
            'content-type': fixture.mime,
          })
        ).status,
      ).toBe(200);
      expect((await http('POST', `/media/${media.id}/complete-upload`, a, {})).status).toBe(200);
      const response = await http('GET', `/media/${media.id}/content`, a);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect((await db.prisma.media.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
        'READY',
      );
    },
  );
  it('completa E2E con idempotencia y lectura privada sin exponer claves', async () => {
    const a = await actor(),
      p = await property(a),
      i = await intention(a, p);
    const repeat = await http('POST', '/media/upload-intent', a, i.body);
    expect(repeat.status).toBe(201);
    expect(((await repeat.json()) as { media: { id: string } }).media.id).toBe(i.id);
    expect((await http('GET', `/media/${i.id}/content`, a)).status).toBe(404);
    for (let n = 0; n < 2; n++)
      expect((await http('PUT', i.url, a, png, { 'x-upload-token': i.token })).status).toBe(200);
    const responses = await Promise.all([
      http('POST', `/media/${i.id}/complete-upload`, a, {}),
      http('POST', `/media/${i.id}/complete-upload`, a, {}),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const list = await http('GET', `/properties/${p}/media`, a),
      text = await list.text();
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toMatch(/storageKey|tokenDigest|uploadSession|sha256|uploadToken/);
    const content = await http('GET', `/media/${i.id}/content`, a);
    expect(content.status).toBe(200);
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(png);
    expect((await http('GET', `/media/${i.id}/content`)).status).toBe(401);
    expect(
      await db.prisma.auditEvent.count({ where: { resourceId: i.id, action: 'MEDIA_CONFIRMED' } }),
    ).toBe(1);
    expect((await http('PUT', i.url, a, png, { 'x-upload-token': i.token })).status).toBe(410);
  });
  it('rechaza propietario ajeno, publisher, miembro sin autorización, CSRF y origen', async () => {
    const owner = await actor(),
      stranger = await actor(),
      publisher = await actor(),
      p = await property(owner);
    await db.prisma.propertyAuthorization.create({
      data: {
        propertyId: p,
        userId: publisher.id,
        grantedByUserId: owner.id,
        authorizationType: 'PUBLISHER',
      },
    });
    for (const a of [stranger, publisher])
      expect((await http('POST', '/media/upload-intent', a, input(p))).status).toBe(404);
    expect(
      (await http('POST', '/media/upload-intent', owner, input(p), { 'x-csrf-token': '' })).status,
    ).toBe(403);
    expect(
      (
        await http('POST', '/media/upload-intent', owner, input(p), {
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    const i = await intention(owner, p);
    expect((await http('PUT', i.url, stranger, png, { 'x-upload-token': i.token })).status).toBe(
      404,
    );
    expect((await http('POST', `/media/${i.id}/complete-upload`, stranger, {})).status).toBe(404);
    expect((await http('DELETE', `/media/${i.id}`, stranger)).status).toBe(404);
  });
  it('la autorización organizativa se revalida al revocar membership', async () => {
    const owner = await actor(),
      member = await actor(),
      p = await property(owner);
    const org = await db.prisma.organization.create({
      data: { name: 'Organización sintética C1.2', createdByUserId: owner.id },
    });
    const membership = await db.prisma.organizationMember.create({
      data: {
        organizationId: org.id,
        userId: member.id,
        role: 'PROFESSIONAL_MEMBER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });
    expect((await http('POST', '/media/upload-intent', member, input(p))).status).toBe(404);
    await db.prisma.propertyAuthorization.create({
      data: {
        propertyId: p,
        organizationId: org.id,
        grantedByUserId: owner.id,
        authorizationType: 'MANAGER',
      },
    });
    const i = await uploaded(member, p);
    await db.prisma.organizationMember.update({
      where: { id: membership.id },
      data: { status: 'REVOKED', endedAt: new Date() },
    });
    expect((await http('POST', `/media/${i.id}/complete-upload`, member, {})).status).toBe(404);
    expect((await http('PUT', i.url, member, png, { 'x-upload-token': i.token })).status).toBe(404);
  });
  it('rechaza recursos, credenciales y archivos falsificados; objeto ausente', async () => {
    const a = await actor(),
      p = await property(a),
      i = await intention(a, p),
      other = await intention(a, p);
    expect((await http('POST', `/media/${i.id}/complete-upload`, a, {})).status).toBe(409);
    expect((await http('PUT', other.url, a, png, { 'x-upload-token': i.token })).status).toBe(404);
    expect(
      (
        await http('PUT', i.url, a, png, {
          'x-upload-token': i.token,
          'content-type': 'image/jpeg',
        })
      ).status,
    ).toBe(400);
    const invalid = Buffer.from('invalid');
    const bad = await intention(a, p, invalid);
    expect((await http('PUT', bad.url, a, invalid, { 'x-upload-token': bad.token })).status).toBe(
      400,
    );
    const row = await db.prisma.media.findUniqueOrThrow({ where: { id: i.id } });
    await storage.put(row.storageKey, invalid);
    expect((await http('POST', `/media/${i.id}/complete-upload`, a, {})).status).toBe(400);
    expect((await db.prisma.media.findUniqueOrThrow({ where: { id: i.id } })).status).toBe(
      'PENDING',
    );
    expect(
      (await http('POST', '/media/upload-intent', a, { ...input(p), size: 10485761 })).status,
    ).toBe(400);
  });
  it('la caducidad invalida carga y confirmación incluso con objeto existente', async () => {
    const a = await actor(),
      p = await property(a),
      body = input(p),
      id = randomUUID();
    const row = await db.prisma.media.create({
      data: {
        id,
        propertyId: p,
        storageKey: randomBytes(32).toString('hex'),
        createdByUserId: a.id,
        uploadSessionId: a.session,
        intentKey: body.intentKey,
        tokenDigest: hash(Buffer.from(body.uploadToken)),
        mime: body.mime,
        size: body.size,
        sha256: body.sha256,
        createdAt: new Date(Date.now() - 3600_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await storage.put(row.storageKey, png);
    expect(
      (await http('PUT', `/media/${id}/object`, a, png, { 'x-upload-token': body.uploadToken }))
        .status,
    ).toBe(410);
    expect((await http('POST', `/media/${id}/complete-upload`, a, {})).status).toBe(410);
  });
  it('logout y revocación de Property bloquean autorizaciones emitidas', async () => {
    const a = await actor(),
      p = await property(a),
      i = await uploaded(a, p);
    await db.prisma.session.update({
      where: { id: a.session },
      data: { revokedAt: new Date(), revocationReason: 'LOGOUT' },
    });
    expect((await http('PUT', i.url, a, png, { 'x-upload-token': i.token })).status).toBe(401);
    expect((await http('POST', `/media/${i.id}/complete-upload`, a, {})).status).toBe(401);
    const b = await actor(),
      q = await property(b),
      j = await uploaded(b, q);
    await db.prisma.propertyAuthorization.updateMany({
      where: { propertyId: q },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    expect((await http('POST', `/media/${j.id}/complete-upload`, b, {})).status).toBe(404);
  });
  it('ordena el conjunto exacto con CAS y archiva sin borrar la foto histórica', async () => {
    const a = await actor(),
      p = await property(a),
      i = await ready(a, p),
      j = await ready(a, p),
      k = await ready(a, p);
    const current = (await (await http('GET', `/properties/${p}/media`, a)).json()) as {
      version: number;
    };
    expect(
      (
        await http('PUT', `/properties/${p}/media/order`, a, {
          version: current.version,
          ids: [i.id],
        })
      ).status,
    ).toBe(409);
    const responses = await Promise.all([
      http('PUT', `/properties/${p}/media/order`, a, {
        version: current.version,
        ids: [k.id, j.id, i.id],
      }),
      http('PUT', `/properties/${p}/media/order`, a, {
        version: current.version,
        ids: [j.id, i.id, k.id],
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await http('DELETE', `/media/${i.id}`, a)).status).toBe(204);
    expect((await http('DELETE', `/media/${i.id}`, a)).status).toBe(204);
    const row = await db.prisma.media.findUniqueOrThrow({ where: { id: i.id } });
    expect(row.status).toBe('ARCHIVED');
    expect(await storage.read(row.storageKey)).toEqual(png);
    expect((await http('GET', `/media/${i.id}/content`, a)).status).toBe(404);
  });
  it('cancelación y confirmación concurrentes nunca resucitan una foto', async () => {
    const a = await actor(),
      p = await property(a),
      i = await uploaded(a, p);
    const results = await Promise.all([
      http('POST', `/media/${i.id}/complete-upload`, a, {}),
      http('DELETE', `/media/${i.id}`, a),
    ]);
    expect([200, 410]).toContain(results[0]!.status);
    expect(results[1]!.status).toBe(204);
    expect(['CANCELLED', 'ARCHIVED']).toContain(
      (await db.prisma.media.findUniqueOrThrow({ where: { id: i.id } })).status,
    );
    expect((await http('GET', `/media/${i.id}/content`, a)).status).toBe(404);
  });
  it('rollback conserva PENDING, objeto y versión; reintento confirma una sola vez', async () => {
    const a = await actor(),
      p = await property(a),
      i = await uploaded(a, p),
      requestId = randomUUID();
    await withAuditFailureFixture(
      db.prisma,
      { requestId, failures: 1, sqlState: 'P0001' },
      async () => {
        const r = await http(
          'POST',
          `/media/${i.id}/complete-upload`,
          a,
          {},
          { 'x-request-id': requestId },
        );
        expect(r.status).toBe(503);
      },
    );
    expect((await db.prisma.media.findUniqueOrThrow({ where: { id: i.id } })).status).toBe(
      'PENDING',
    );
    expect((await db.prisma.property.findUniqueOrThrow({ where: { id: p } })).mediaVersion).toBe(0);
    expect((await http('POST', `/media/${i.id}/complete-upload`, a, {})).status).toBe(200);
  });
  it('rollback de intención no deja fila, tarea ni objeto', async () => {
    const a = await actor(),
      p = await property(a),
      body = input(p),
      requestId = randomUUID();
    const put = vi.spyOn(storage, 'put');
    await withAuditFailureFixture(
      db.prisma,
      { requestId, failures: 1, sqlState: 'P0001' },
      async () => {
        expect(
          (await http('POST', '/media/upload-intent', a, body, { 'x-request-id': requestId }))
            .status,
        ).toBe(503);
      },
    );
    expect(await db.prisma.media.count({ where: { propertyId: p } })).toBe(0);
    expect(await db.prisma.outboxEvent.count({ where: { correlationId: requestId } })).toBe(0);
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
  });
  it('dos intenciones simultáneas con la misma clave producen una única fila y tarea', async () => {
    const a = await actor(),
      p = await property(a),
      body = input(p);
    const responses = await Promise.all([
      http('POST', '/media/upload-intent', a, body),
      http('POST', '/media/upload-intent', a, body),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const rows = await db.prisma.media.findMany({ where: { propertyId: p } });
    expect(rows).toHaveLength(1);
    expect(await db.prisma.outboxEvent.count({ where: { aggregateId: rows[0]!.id } })).toBe(1);
    expect(
      (await http('POST', '/media/upload-intent', a, { ...body, sha256: '0'.repeat(64) })).status,
    ).toBe(409);
  });
  it('caducidad de autorización durante lectura del objeto revierte la confirmación', async () => {
    const owner = await actor(),
      manager = await actor(),
      p = await property(owner);
    const grant = await db.prisma.propertyAuthorization.create({
      data: {
        propertyId: p,
        userId: manager.id,
        grantedByUserId: owner.id,
        authorizationType: 'MANAGER',
      },
    });
    const i = await uploaded(manager, p);
    const expiresAt = new Date(Date.now() + 1000);
    await db.prisma.propertyAuthorization.update({
      where: { id: grant.id },
      data: { validUntil: expiresAt },
    });
    const read = storage.read.bind(storage);
    const spy = vi.spyOn(storage, 'read').mockImplementationOnce(async (key) => {
      // Reloj PostgreSQL: el test espera la caducidad concreta, no un retardo supuesto.
      await db.prisma
        .$executeRaw`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (${expiresAt}::timestamptz - clock_timestamp()))) + 0.01)`;
      return read(key);
    });
    try {
      expect((await http('POST', `/media/${i.id}/complete-upload`, manager, {})).status).toBe(404);
    } finally {
      spy.mockRestore();
    }
    expect((await db.prisma.media.findUniqueOrThrow({ where: { id: i.id } })).status).toBe(
      'PENDING',
    );
    expect((await db.prisma.property.findUniqueOrThrow({ where: { id: p } })).mediaVersion).toBe(0);
  });
  it('fallo después de escribir bytes deja objeto pendiente recuperable', async () => {
    const a = await actor(),
      p = await property(a),
      i = await intention(a, p),
      put = storage.put.bind(storage);
    const spy = vi.spyOn(storage, 'put').mockImplementationOnce(async (key, bytes) => {
      await put(key, bytes);
      throw new Error('fallo sintético');
    });
    try {
      expect((await http('PUT', i.url, a, png, { 'x-upload-token': i.token })).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect((await db.prisma.media.findUniqueOrThrow({ where: { id: i.id } })).status).toBe(
      'PENDING',
    );
    expect((await http('GET', `/media/${i.id}/content`, a)).status).toBe(404);
    expect((await http('PUT', i.url, a, png, { 'x-upload-token': i.token })).status).toBe(200);
  });
  it('revocación concurrente anterior al lock impide confirmar: barrera causal PostgreSQL', async () => {
    const owner = await actor(),
      manager = await actor(),
      p = await property(owner);
    const grant = await db.prisma.propertyAuthorization.create({
      data: {
        propertyId: p,
        userId: manager.id,
        grantedByUserId: owner.id,
        authorizationType: 'MANAGER',
      },
    });
    const i = await uploaded(manager, p),
      requestId = randomUUID(),
      blocker = createPrismaClient(),
      diagnostic = createPrismaClient(),
      scope = new CausalWorkScope();
    let release!: () => void, announce!: (pid: number) => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<number>((resolve) => {
        announce = resolve;
      });
    try {
      const blocking = scope.observe(
        blocker.$transaction(
          async (tx) => {
            const [row] = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS pid`;
            await tx.$queryRaw`SELECT id FROM property WHERE id=${p}::uuid FOR UPDATE`;
            await tx.propertyAuthorization.update({
              where: { id: grant.id },
              data: { status: 'REVOKED', revokedAt: new Date() },
            });
            announce(row!.pid);
            await released;
          },
          { timeout: 10000 },
        ),
      );
      const blockerPid = await scope.wait(ready);
      const started = observer.waitFor({ requestId, operation: 'MEDIA_ACCESS', attempt: 1 });
      const pending = scope.observe(
        http('POST', `/media/${i.id}/complete-upload`, manager, {}, { 'x-request-id': requestId }),
      );
      const transaction = await scope.wait(started);
      await scope.wait(
        waitForQueryBlockedBy(diagnostic, {
          blockerPid,
          databaseName: process.env.API_TEST_DATABASE_NAME!,
          applicationName,
          expectedQuery: 'SELECT "id" FROM "property" WHERE "id" = $1::uuid FOR UPDATE',
          requestId,
          operation: 'MEDIA_ACCESS',
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
      expect((await db.prisma.media.findUniqueOrThrow({ where: { id: i.id } })).status).toBe(
        'PENDING',
      );
    } finally {
      release();
      await scope.settle();
      observer.clearRequest(requestId);
      await blocker.$disconnect();
      await diagnostic.$disconnect();
    }
  }, 15000);
  it('constraints preservan identidad y estado; objetos de otra Property no se pueden vincular', async () => {
    const a = await actor(),
      p = await property(a),
      q = await property(a),
      i = await ready(a, p);
    await expect(
      db.prisma.media.update({ where: { id: i.id }, data: { propertyId: q } }),
    ).rejects.toThrow();
    await expect(
      db.prisma.media.update({ where: { id: i.id }, data: { storageKey: 'b'.repeat(64) } }),
    ).rejects.toThrow();
    await expect(
      db.prisma.media.update({ where: { id: i.id }, data: { status: 'PENDING' } }),
    ).rejects.toThrow();
    expect(
      (await http('POST', '/media/upload-intent', a, { ...input(p), storageKey: 'x' })).status,
    ).toBe(400);
  });
});
