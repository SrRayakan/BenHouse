import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPrismaClient } from '@benhouse/database';
import { configuredStorage, StorageProvider } from '@benhouse/storage';
import { processNextMediaCleanup } from './media-cleanup';

describe('Limpieza C1.2 con outbox/PostgreSQL y objetos reales', () => {
  let client: ReturnType<typeof createPrismaClient>, storage: StorageProvider;
  beforeAll(async () => {
    if (
      process.env.NODE_ENV !== 'test' ||
      !/^benhouse_worker_[a-f0-9]{32}_test$/.test(process.env.WORKER_TEST_DATABASE_NAME ?? '')
    )
      throw new Error('Base exclusiva obligatoria');
    client = createPrismaClient();
    const [row] = await client.$queryRaw<Array<{ name: string; oid: string; system: string }>>`
      SELECT current_database() name, d.oid::text oid, c.system_identifier::text system
      FROM pg_database d CROSS JOIN pg_control_system() c WHERE datname=current_database()`;
    if (
      row?.name !== process.env.WORKER_TEST_DATABASE_NAME ||
      row?.oid !== process.env.WORKER_TEST_DATABASE_OID ||
      row?.system !== process.env.WORKER_TEST_DATABASE_SYSTEM
    )
      throw new Error('Identidad física incorrecta');
    if (!process.env.STORAGE_TEST_OWNER) throw new Error('Servicio efímero obligatorio');
    storage = await configuredStorage();
  });
  afterAll(async () => {
    await client?.$disconnect();
    storage?.close();
  });
  async function fixture(
    status: 'PENDING' | 'READY' | 'ARCHIVED' | 'CANCELLED' = 'PENDING',
    future = false,
  ) {
    const p = await client.property.create({ data: { type: 'HOUSE' } });
    const now = Date.now(),
      confirmed = status === 'READY' || status === 'ARCHIVED';
    const media = await client.media.create({
      data: {
        propertyId: p.id,
        storageKey: randomBytes(32).toString('hex'),
        createdByUserId: randomUUID(),
        uploadSessionId: randomUUID(),
        tokenDigest: 'a'.repeat(64),
        sha256: 'b'.repeat(64),
        intentKey: randomUUID(),
        size: 3,
        mime: 'image/png',
        status,
        createdAt: new Date(now - 3600_000),
        expiresAt: new Date(now + (future ? 3600_000 : -1000)),
        ...(confirmed ? { confirmedAt: new Date(now - 2000), width: 1, height: 1 } : {}),
        ...(status === 'READY' ? { position: 0 } : {}),
        ...(status === 'ARCHIVED' ? { archivedAt: new Date(now - 500) } : {}),
      },
    });
    await storage.put(media.storageKey, Buffer.from('abc'));
    const event = await client.outboxEvent.create({
      data: {
        eventType: 'MEDIA_UPLOAD_CLEANUP',
        aggregateType: 'MEDIA',
        aggregateId: media.id,
        availableAt: new Date(now - 500),
      },
    });
    return { media, event };
  }
  it('elimina objetos incompletos; dos workers no duplican auditoría', async () => {
    const { media, event } = await fixture();
    await Promise.all([
      processNextMediaCleanup(client, storage),
      processNextMediaCleanup(client, storage),
    ]);
    expect(await storage.read(media.storageKey)).toBeNull();
    expect(await client.media.findUnique({ where: { id: media.id } })).toMatchObject({
      status: 'EXPIRED',
      cleanedAt: expect.any(Date),
    });
    expect(await client.outboxEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      status: 'PROCESSED',
    });
    expect(
      await client.auditEvent.count({
        where: { resourceId: media.id, action: 'MEDIA_INCOMPLETE_CLEANED' },
      }),
    ).toBe(1);
  });
  it('conserva READY y ARCHIVED, incluso con limpieza ya programada', async () => {
    for (const status of ['READY', 'ARCHIVED'] as const) {
      const { media, event } = await fixture(status);
      await processNextMediaCleanup(client, storage);
      expect(await storage.read(media.storageKey)).toEqual(Buffer.from('abc'));
      expect((await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
        'OBSOLETE',
      );
    }
  });
  it('no caduca anticipadamente; cancelación permite limpiar antes del TTL', async () => {
    const pending = await fixture('PENDING', true);
    await processNextMediaCleanup(client, storage);
    expect(await storage.read(pending.media.storageKey)).not.toBeNull();
    expect(
      (await client.outboxEvent.findUniqueOrThrow({ where: { id: pending.event.id } })).availableAt,
    ).toEqual(pending.media.expiresAt);
    const cancelled = await fixture('CANCELLED', true);
    await processNextMediaCleanup(client, storage);
    expect(await storage.read(cancelled.media.storageKey)).toBeNull();
  });
  it('fallo de storage queda durable y se reintenta; objeto inexistente es idempotente', async () => {
    const { media, event } = await fixture();
    const spy = vi
      .spyOn(storage, 'removeIncomplete')
      .mockRejectedValueOnce(new Error('fallo sintético'));
    try {
      await processNextMediaCleanup(client, storage);
    } finally {
      spy.mockRestore();
    }
    expect(await client.outboxEvent.findUnique({ where: { id: event.id } })).toMatchObject({
      status: 'PENDING',
      attemptCount: 1,
      lastErrorCode: 'MEDIA_STORAGE_DELETE_FAILED',
    });
    expect((await client.media.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
      'PENDING',
    );
    await storage.removeIncomplete(media.storageKey);
    await client.outboxEvent.update({
      where: { id: event.id },
      data: { availableAt: new Date(0) },
    });
    await processNextMediaCleanup(client, storage);
    expect((await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      'PROCESSED',
    );
  });
  it('rollback SQL tras borrar el objeto se recupera sin perder la tarea', async () => {
    const { media, event } = await fixture();
    const fn = `c12_fail_${randomUUID().replaceAll('-', '')}`;
    await client.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='${media.id}'::uuid THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$`,
    );
    await client.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await expect(processNextMediaCleanup(client, storage)).rejects.toThrow();
    } finally {
      await client.$executeRawUnsafe(`DROP TRIGGER ${fn} ON audit_event`);
      await client.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
    expect(await storage.read(media.storageKey)).toBeNull();
    expect((await client.media.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
      'PENDING',
    );
    expect((await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      'PENDING',
    );
    await processNextMediaCleanup(client, storage);
    expect((await client.media.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
      'EXPIRED',
    );
  });
});
