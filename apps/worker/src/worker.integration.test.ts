import { describe, expect, it, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { configuredStorage } from '@benhouse/storage';
import { processWorkerCycle } from './index';
import { createPrismaClient, Prisma, verifyDatabaseInfrastructure } from '@benhouse/database';
import {
  loadLocalEnvironmentFile,
  readAppConfig,
  serializeInvitationToken,
} from '@benhouse/config';
import {
  processNextInvitation,
  UnconfiguredInvitationNotificationPort,
  type InvitationDelivery,
  type InvitationNotificationPort,
} from './invitation-outbox';

type TestClient = ReturnType<typeof createPrismaClient>;
type EventState = {
  id: string;
  status: 'PENDING' | 'PROCESSING';
  availableAt: Date;
  lockedUntil: Date | null;
  lockToken: string | null;
  revision: string;
};
type IsolatedEvent = EventState & { temporaryAt: Date; isolatedRevision: string };

async function assertTestDatabase(client: TestClient): Promise<void> {
  const identity = await client.$queryRaw<Array<{ name: string; oid: string }>>`
    SELECT current_database() AS name, oid::text AS oid FROM pg_database
    WHERE datname = current_database()
  `;
  if (
    process.env.NODE_ENV !== 'test' ||
    !/^benhouse_worker_[a-f0-9]{32}_test$/.test(identity[0]?.name ?? '') ||
    identity[0]?.name !== process.env.WORKER_TEST_DATABASE_NAME ||
    identity[0]?.oid !== process.env.WORKER_TEST_DATABASE_OID
  )
    throw new Error('Destino de fixture no permitido.');
}

// Solo ejercita el CAS sobre una sonda propia; nunca aísla la cola global.
async function postponeOwnProbe(client: TestClient, id: string): Promise<IsolatedEvent[]> {
  await assertTestDatabase(client);
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<EventState[]>(Prisma.sql`
      SELECT id, status, available_at AS "availableAt", locked_until AS "lockedUntil",
             lock_token AS "lockToken", xmin::text AS revision
      FROM outbox_event
      WHERE id = ${id}::uuid
        AND event_type = 'ORGANIZATION_INVITATION_REQUESTED' AND event_version = 1
        AND ((status = 'PENDING' AND available_at <= clock_timestamp())
          OR (status = 'PROCESSING' AND locked_until <= clock_timestamp()))
      ORDER BY id FOR UPDATE
    `);
    const [clock] = await tx.$queryRaw<Array<{ value: Date }>>`
      SELECT date_trunc('milliseconds', clock_timestamp() + interval '1 hour') AS value
    `;
    if (!clock) throw new Error('Reloj de aislamiento no disponible.');
    const isolated: IsolatedEvent[] = [];
    for (const row of rows) {
      const updated = await tx.$queryRaw<Array<{ revision: string }>>(Prisma.sql`
        UPDATE outbox_event SET
          available_at = ${row.status === 'PENDING' ? clock.value : row.availableAt},
          locked_until = ${row.status === 'PROCESSING' ? clock.value : row.lockedUntil}
        WHERE id = ${row.id}::uuid AND status::text = ${row.status}
          AND available_at = ${row.availableAt}
          AND locked_until IS NOT DISTINCT FROM ${row.lockedUntil}::timestamptz
          AND lock_token IS NOT DISTINCT FROM ${row.lockToken}::uuid
          AND xmin::text = ${row.revision}
          AND (status = 'PENDING' OR locked_until <= clock_timestamp())
        RETURNING xmin::text AS revision
      `);
      if (updated.length !== 1) throw new Error('El estado cambió antes del aislamiento.');
      isolated.push({ ...row, temporaryAt: clock.value, isolatedRevision: updated[0]!.revision });
    }
    return isolated;
  });
}

async function restoreEvent(client: TestClient, event: IsolatedEvent): Promise<void> {
  // xmin detecta también cambios de otros campos y ABA dentro de la vida de este fixture.
  const count = await client.$executeRaw(Prisma.sql`
    UPDATE outbox_event SET available_at = ${event.availableAt}, locked_until = ${event.lockedUntil}
    WHERE id = ${event.id}::uuid AND status::text = ${event.status}
      AND available_at = ${event.status === 'PENDING' ? event.temporaryAt : event.availableAt}
      AND locked_until IS NOT DISTINCT FROM
        ${event.status === 'PROCESSING' ? event.temporaryAt : event.lockedUntil}::timestamptz
      AND lock_token IS NOT DISTINCT FROM ${event.lockToken}::uuid
      AND xmin::text = ${event.isolatedRevision}
  `);
  if (count !== 1) throw new Error('Restauración omitida: cambio concurrente detectado.');
}

type CleanupStep = { name: string; run: () => Promise<unknown> };

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function cleanupFixture(
  own: CleanupStep[],
  restoration: CleanupStep[],
  disconnect: () => Promise<void>,
  primaryErrors: unknown[] = [],
): Promise<void> {
  const errors = [...primaryErrors];
  for (const step of [...own, ...restoration, { name: 'desconexión', run: disconnect }]) {
    try {
      await step.run();
    } catch {
      // No incluir mensajes Prisma, payloads ni valores de autenticación en el diagnóstico.
      errors.push(new Error(`Falló cleanup: ${step.name}.`));
    }
  }
  if (errors.length === 1 && primaryErrors.length === 1) throw primaryErrors[0];
  if (errors.length) throw new AggregateError(errors, 'Falló el fixture o su cleanup.');
}

describe('infraestructura del worker', () => {
  it('conecta con PostgreSQL y PostGIS', async () => {
    loadLocalEnvironmentFile();
    readAppConfig();
    const client = createPrismaClient();

    try {
      await expect(verifyDatabaseInfrastructure(client)).resolves.toBeUndefined();
    } finally {
      await client.$disconnect();
    }
  });
});

describe('restauración defensiva del fixture B1.6', () => {
  async function withProbe(
    data: Partial<Prisma.OutboxEventUncheckedCreateInput>,
    callback: (
      client: TestClient,
      other: TestClient,
      event: IsolatedEvent | undefined,
      id: string,
    ) => Promise<void>,
  ) {
    loadLocalEnvironmentFile();
    const client = createPrismaClient();
    const other = createPrismaClient();
    const id = randomUUID();
    let isolated: IsolatedEvent[] = [];
    const errors: unknown[] = [];
    let verified = false;
    try {
      await assertTestDatabase(client);
      verified = true;
      await client.outboxEvent.create({
        data: {
          eventType: 'ORGANIZATION_INVITATION_REQUESTED',
          eventVersion: 1,
          aggregateType: 'SYNTHETIC_FIXTURE',
          aggregateId: randomUUID(),
          availableAt: new Date('2020-01-01T00:00:00.123Z'),
          ...data,
          id,
        },
      });
      isolated = await postponeOwnProbe(client, id);
      await callback(
        client,
        other,
        isolated.find((event) => event.id === id),
        id,
      );
    } catch (error) {
      errors.push(error);
    } finally {
      await cleanupFixture(
        verified
          ? [
              {
                name: 'evento de regresión',
                run: () => client.outboxEvent.deleteMany({ where: { id } }),
              },
            ]
          : [],
        [],
        async () => {
          try {
            await other.$disconnect();
          } finally {
            await client.$disconnect();
          }
        },
        errors,
      );
    }
  }

  it('restaura exactamente availableAt de PENDING sin cambios', async () => {
    await withProbe({}, async (client, _other, event, id) => {
      expect(event).toBeDefined();
      await restoreEvent(client, event!);
      expect((await client.outboxEvent.findUniqueOrThrow({ where: { id } })).availableAt).toEqual(
        new Date('2020-01-01T00:00:00.123Z'),
      );
    });
  });

  it('preserva una reprogramación confirmada por otra conexión antes del CAS', async () => {
    await withProbe({}, async (client, other, event, id) => {
      const availableAt = new Date('2040-01-01T00:00:00.456Z');
      await other.outboxEvent.update({ where: { id }, data: { availableAt } });
      await expect(restoreEvent(client, event!)).rejects.toThrow('cambio concurrente');
      expect((await client.outboxEvent.findUniqueOrThrow({ where: { id } })).availableAt).toEqual(
        availableAt,
      );
    });
  });

  it('detecta ABA aunque el otro proceso reponga el timestamp temporal exacto', async () => {
    await withProbe({}, async (client, other, event, id) => {
      await other.outboxEvent.update({ where: { id }, data: { availableAt: event!.temporaryAt } });
      await expect(restoreEvent(client, event!)).rejects.toThrow('cambio concurrente');
      expect((await client.outboxEvent.findUniqueOrThrow({ where: { id } })).availableAt).toEqual(
        event!.temporaryAt,
      );
    });
  });

  const expiredLease = () => ({
    status: 'PROCESSING' as const,
    lockedAt: new Date('2020-01-01T00:00:00Z'),
    lockedUntil: new Date('2020-01-01T00:05:00.123Z'),
    lockedBy: 'synthetic-probe',
    lockToken: randomUUID(),
  });

  it('no modifica un lease PROCESSING vigente', async () => {
    const lease = { ...expiredLease(), lockedUntil: new Date('2040-01-01T00:00:00Z') };
    await withProbe(lease, async (client, _other, event, id) => {
      expect(event).toBeUndefined();
      expect(await client.outboxEvent.findUniqueOrThrow({ where: { id } })).toMatchObject(lease);
    });
  });

  it('restaura exactamente un lease vencido que no cambió', async () => {
    const lease = expiredLease();
    await withProbe(lease, async (client, _other, event, id) => {
      await restoreEvent(client, event!);
      expect(await client.outboxEvent.findUniqueOrThrow({ where: { id } })).toMatchObject(lease);
    });
  });

  it('el CAS verifica lockToken incluso con la revisión y timestamp actuales', async () => {
    await withProbe(expiredLease(), async (client, other, event, id) => {
      const lockToken = randomUUID();
      await other.outboxEvent.update({
        where: { id },
        data: { lockToken, lockedBy: 'synthetic-other' },
      });
      const [row] = await other.$queryRaw<Array<{ revision: string }>>`
        SELECT xmin::text AS revision FROM outbox_event WHERE id = ${id}::uuid
      `;
      // Usa la revisión actual para demostrar específicamente la condición lockToken.
      await expect(
        restoreEvent(client, { ...event!, isolatedRevision: row!.revision }),
      ).rejects.toThrow('cambio concurrente');
      expect(await client.outboxEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        lockToken,
        lockedBy: 'synthetic-other',
        lockedUntil: event!.temporaryAt,
      });
    });
  });

  it.each(['PROCESSED', 'OBSOLETE', 'DEAD_LETTER'] as const)('no altera %s', async (status) => {
    const data = {
      status,
      processedAt: status === 'DEAD_LETTER' ? null : new Date(),
      lastErrorCode: status === 'DEAD_LETTER' ? 'SYNTHETIC' : null,
    };
    await withProbe(data, async (client, _other, event, id) => {
      expect(event).toBeUndefined();
      expect(await client.outboxEvent.findUniqueOrThrow({ where: { id } })).toMatchObject(data);
    });
  });

  it('no altera eventos de otro tipo', async () => {
    await withProbe({ eventType: 'SYNTHETIC_OTHER' }, async (client, _other, event, id) => {
      expect(event).toBeUndefined();
      expect((await client.outboxEvent.findUniqueOrThrow({ where: { id } })).availableAt).toEqual(
        new Date('2020-01-01T00:00:00.123Z'),
      );
    });
  });

  it('un borrado fallido no impide otros borrados, restauración real ni desconexión', async () => {
    await withProbe({}, async (client, other, event, id) => {
      const primary = new Error('Fallo principal sintético');
      const attempted = vi.fn(async () => undefined);
      const disconnect = vi.fn(() => client.$disconnect());
      const result = await cleanupFixture(
        [
          {
            name: 'borrado rechazado por PostgreSQL',
            run: () =>
              client.$transaction(async (tx) => {
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                await tx.outboxEvent.deleteMany({ where: { id } });
              }),
          },
          { name: 'siguiente borrado', run: attempted },
        ],
        [{ name: 'restauración', run: () => restoreEvent(client, event!) }],
        disconnect,
        [primary],
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors[0]).toBe(primary);
      expect((result as AggregateError).errors).toHaveLength(2);
      expect(attempted).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledOnce();
      expect((await other.outboxEvent.findUniqueOrThrow({ where: { id } })).availableAt).toEqual(
        event!.availableAt,
      );
    });
  }, 15_000);

  it('una restauración fallida no impide las restantes ni desconexión y no se oculta', async () => {
    await withProbe({}, async (client, _other, event) => {
      const disconnect = vi.fn(() => client.$disconnect());
      const restored = vi.fn(() => restoreEvent(client, event!));
      const result = await cleanupFixture(
        [],
        [
          {
            name: 'restauración CAS rechazada',
            run: () => restoreEvent(client, { ...event!, isolatedRevision: '0' }),
          },
          { name: 'restauración restante', run: restored },
        ],
        disconnect,
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toHaveLength(1);
      expect(restored).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledOnce();
    });
  }, 15_000);
});

describe('outbox de invitaciones B1.5', () => {
  async function withFixture(
    callback: (fixture: {
      client: ReturnType<typeof createPrismaClient>;
      eventId: string;
      invitationId: string;
      tokenId: string;
      organizationId: string;
      email: string;
    }) => Promise<void>,
  ): Promise<void> {
    loadLocalEnvironmentFile();
    const client = createPrismaClient();
    const primaryErrors: unknown[] = [];
    let verified = false;
    const userId = randomUUID();
    const organizationId = randomUUID();
    const invitationId = randomUUID();
    const tokenId = randomUUID();
    const eventId = randomUUID();
    const email = `worker-${eventId}@example.test`;
    const now = new Date();
    try {
      await assertTestDatabase(client);
      verified = true;
      await client.user.create({
        data: {
          id: userId,
          email: `owner-${eventId}@example.test`,
          displayName: 'Sintético',
          status: 'ACTIVE',
          emailVerifiedAt: now,
        },
      });
      await client.organization.create({
        data: { id: organizationId, name: 'Worker B1.5 sintético', createdByUserId: userId },
      });
      await client.organizationInvitation.create({
        data: {
          id: invitationId,
          organizationId,
          email,
          role: 'PROFESSIONAL_MEMBER',
          invitedByUserId: userId,
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      });
      await client.accountToken.create({
        data: {
          id: tokenId,
          purpose: 'ORGANIZATION_INVITATION',
          generation: 1,
          keyVersion: readAppConfig().auth.accountTokenKeys.currentVersion,
          organizationInvitationId: invitationId,
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      });
      await client.outboxEvent.create({
        data: {
          id: eventId,
          eventType: 'ORGANIZATION_INVITATION_REQUESTED',
          eventVersion: 1,
          aggregateType: 'ORGANIZATION_INVITATION',
          aggregateId: invitationId,
          accountTokenId: tokenId,
          payload: {
            invitationId,
            organizationId,
            purpose: 'ORGANIZATION_INVITATION',
            generation: 1,
            template: 'organization_invitation',
            locale: 'es',
          },
        },
      });
      await callback({ client, eventId, invitationId, tokenId, organizationId, email });
    } catch (error) {
      primaryErrors.push(error);
    } finally {
      await cleanupFixture(
        verified
          ? [
              {
                name: 'evento propio',
                run: () => client.outboxEvent.deleteMany({ where: { id: eventId } }),
              },
              {
                name: 'token propio',
                run: () => client.accountToken.deleteMany({ where: { id: tokenId } }),
              },
              {
                name: 'invitación propia',
                run: () =>
                  client.organizationInvitation.deleteMany({ where: { id: invitationId } }),
              },
              {
                name: 'organización propia',
                run: () => client.organization.deleteMany({ where: { id: organizationId } }),
              },
              {
                name: 'usuario propio',
                run: () => client.user.deleteMany({ where: { id: userId } }),
              },
            ]
          : [],
        [],
        () => client.$disconnect(),
        primaryErrors,
      );
    }
  }

  it('entrega una sola vez con dos workers y confirma después del transporte', async () => {
    await withFixture(async ({ client, eventId, invitationId, tokenId, organizationId, email }) => {
      const deliveries: InvitationDelivery[] = [];
      const entered = signal();
      const release = signal();
      const port: InvitationNotificationPort = {
        async deliverInvitation(delivery) {
          deliveries.push(delivery);
          expect(
            (await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).status,
          ).toBe('PROCESSING');
          if (deliveries.length === 1) {
            entered.resolve();
            await release.promise;
          }
        },
      };
      const config = readAppConfig().auth;
      const otherClient = createPrismaClient();
      let outcomes: string[];
      const first = processNextInvitation(client, config, port, 'worker-a');
      try {
        await Promise.race([
          entered.promise,
          first.then(() => {
            throw new Error('El worker terminó sin alcanzar el transporte.');
          }),
        ]);
        // El segundo reclama mientras el primero conserva un lease en vuelo.
        const second = await processNextInvitation(otherClient, config, port, 'worker-b');
        expect(second).toBe('IDLE');
        expect(
          (await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).attemptCount,
        ).toBe(1);
        release.resolve();
        outcomes = [await first, second];
      } finally {
        release.resolve();
        try {
          await first;
        } finally {
          await otherClient.$disconnect();
        }
      }
      expect(outcomes.sort()).toEqual(['IDLE', 'PROCESSED']);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.eventId).toBe(eventId);
      expect(deliveries[0]?.recipientEmail).toBe(email);
      const auth = readAppConfig().auth;
      expect(deliveries[0]?.token).toBe(
        serializeInvitationToken(
          {
            id: tokenId,
            purpose: 'ORGANIZATION_INVITATION',
            generation: 1,
            subjectType: 'ORGANIZATION_INVITATION',
            subjectId: invitationId,
            organizationId,
            email,
            role: 'PROFESSIONAL_MEMBER',
            keyVersion: auth.accountTokenKeys.currentVersion,
          },
          auth.accountTokenKeys,
        ),
      );
      expect((await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).status).toBe(
        'PROCESSED',
      );
      expect(await processNextInvitation(client, config, port)).toBe('IDLE');
    });
  }, 15_000);

  it.each(['PENDING_FUTURE', 'PROCESSING_LEASE', 'INSERTED_LATER'] as const)(
    'aislamiento temporal: conserva íntegro evento ajeno %s',
    async (scenario) => {
      const sharedUrl = process.env.WORKER_FOREIGN_TEST_DATABASE_URL;
      if (!sharedUrl) throw new Error('Falta el destino externo verificado por el runner.');
      const foreign = createPrismaClient({ datasourceUrl: sharedUrl });
      const foreignId = randomUUID();
      const errors: unknown[] = [];
      let verified = false;
      const verifyForeign = async () => {
        const [identity] = await foreign.$queryRaw<
          Array<{ name: string; oid: string; system: string }>
        >`
          SELECT current_database() AS name, d.oid::text AS oid, c.system_identifier::text AS system
          FROM pg_database d CROSS JOIN pg_control_system() c WHERE datname=current_database()
        `;
        if (
          process.env.NODE_ENV !== 'test' ||
          !/^benhouse_worker_[a-f0-9]{32}_test$/.test(identity?.name ?? '') ||
          identity?.name !== process.env.WORKER_FOREIGN_TEST_DATABASE_NAME ||
          identity?.oid !== process.env.WORKER_FOREIGN_TEST_DATABASE_OID ||
          identity?.system !== process.env.WORKER_FOREIGN_TEST_DATABASE_SYSTEM ||
          identity?.name === process.env.WORKER_TEST_DATABASE_NAME ||
          (identity?.system === process.env.WORKER_TEST_DATABASE_SYSTEM &&
            identity?.oid === process.env.WORKER_TEST_DATABASE_OID)
        )
          throw new Error('El fixture ajeno no es la segunda base efímera verificada.');
      };
      try {
        await verifyForeign();
        verified = true;
        const [clock] = await foreign.$queryRaw<Array<{ deadline: Date }>>`
          SELECT date_trunc('milliseconds', clock_timestamp() + interval '10 seconds') AS deadline
        `;
        const deadline = clock!.deadline;
        const createForeign = () =>
          foreign.outboxEvent.create({
            data: {
              id: foreignId,
              eventType: 'ORGANIZATION_INVITATION_REQUESTED',
              eventVersion: 1,
              aggregateType: 'SYNTHETIC_FOREIGN_FIXTURE',
              aggregateId: randomUUID(),
              payload: { synthetic: true, scenario },
              attemptCount: 2,
              availableAt: scenario === 'PENDING_FUTURE' ? deadline : new Date('2020-01-01'),
              ...(scenario === 'PROCESSING_LEASE'
                ? {
                    status: 'PROCESSING',
                    lockedAt: new Date('2020-01-01'),
                    lockedUntil: deadline,
                    lockedBy: 'synthetic-foreign-worker',
                    lockToken: randomUUID(),
                  }
                : {}),
            },
          });
        if (scenario !== 'INSERTED_LATER') await createForeign();
        await withFixture(async ({ client, eventId }) => {
          if (scenario === 'INSERTED_LATER') await createForeign();
          else {
            // Barrera causal: la preparación ya terminó y el evento aún NO es elegible.
            const [before] = await foreign.$queryRaw<Array<{ future: boolean }>>`
              SELECT clock_timestamp() < ${deadline} AS future
            `;
            expect(before?.future).toBe(true);
            const limit = performance.now() + 15_000;
            for (;;) {
              const [row] = await foreign.$queryRaw<Array<{ eligible: boolean }>>`
                SELECT clock_timestamp() >= ${deadline} AS eligible
              `;
              if (row?.eligible) break;
              if (performance.now() >= limit)
                throw new Error('No se alcanzó la barrera PostgreSQL.');
            }
          }
          const snapshot = await foreign.outboxEvent.findUniqueOrThrow({
            where: { id: foreignId },
          });
          const [version] = await foreign.$queryRaw<Array<{ revision: string }>>`
            SELECT xmin::text AS revision FROM outbox_event WHERE id=${foreignId}::uuid
          `;
          const deliverInvitation = vi.fn(async () => undefined);
          const outcomes = [
            await processNextInvitation(client, readAppConfig().auth, { deliverInvitation }),
            await processNextInvitation(client, readAppConfig().auth, { deliverInvitation }),
          ];
          expect(await foreign.outboxEvent.findUniqueOrThrow({ where: { id: foreignId } })).toEqual(
            snapshot,
          );
          expect(
            await foreign.$queryRaw`SELECT xmin::text AS revision FROM outbox_event WHERE id=${foreignId}::uuid`,
          ).toEqual([version]);
          expect(outcomes).toEqual(['PROCESSED', 'IDLE']);
          expect(deliverInvitation).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ eventId }),
          );
        });
      } catch (error) {
        errors.push(error);
      } finally {
        await cleanupFixture(
          verified
            ? [
                {
                  name: 'evento ajeno sintético propio',
                  run: async () => {
                    await verifyForeign();
                    await foreign.outboxEvent.deleteMany({ where: { id: foreignId } });
                  },
                },
              ]
            : [],
          [],
          () => foreign.$disconnect(),
          errors,
        );
      }
    },
    25_000,
  );
  it('la composición real procesa limpieza de Media e invitación en el mismo ciclo', async () => {
    await withFixture(async ({ client, eventId }) => {
      const storage = await configuredStorage();
      try {
        const p = await client.property.create({ data: { type: 'HOUSE' } });
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
            createdAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() - 1000),
          },
        });
        await storage.put(media.storageKey, Buffer.from('abc'));
        const cleanup = await client.outboxEvent.create({
          data: {
            eventType: 'MEDIA_UPLOAD_CLEANUP',
            aggregateType: 'MEDIA',
            aggregateId: media.id,
            availableAt: new Date(0),
          },
        });
        const deliverInvitation = vi.fn(async () => undefined);
        expect(
          await processWorkerCycle(client, readAppConfig().auth, storage, { deliverInvitation }),
        ).toEqual({ media: true, invitation: 'PROCESSED' });
        expect(deliverInvitation).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ eventId }),
        );
        expect(await storage.read(media.storageKey)).toBeNull();
        expect((await client.media.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
          'EXPIRED',
        );
        expect(
          (await client.outboxEvent.findUniqueOrThrow({ where: { id: cleanup.id } })).status,
        ).toBe('PROCESSED');
        expect(
          (await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).status,
        ).toBe('PROCESSED');
      } finally {
        storage.close();
      }
    });
  });

  it('reintenta sin transporte y respeta un lease PROCESSING vigente', async () => {
    await withFixture(async ({ client, eventId }) => {
      const config = readAppConfig().auth;
      const now = new Date();
      await client.outboxEvent.update({
        where: { id: eventId },
        data: {
          status: 'PROCESSING',
          lockedAt: now,
          lockedUntil: new Date(now.getTime() + 60_000),
          lockedBy: 'otro-worker',
          lockToken: randomUUID(),
        },
      });
      expect(
        await processNextInvitation(client, config, new UnconfiguredInvitationNotificationPort()),
      ).toBe('IDLE');
      await client.outboxEvent.update({
        where: { id: eventId },
        data: {
          lockedAt: new Date(now.getTime() - 120_000),
          lockedUntil: new Date(now.getTime() - 60_000),
        },
      });
      expect(
        await processNextInvitation(client, config, new UnconfiguredInvitationNotificationPort()),
      ).toBe('RETRY');
      const event = await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(event.status).toBe('PENDING');
      expect(event.attemptCount).toBe(1);
      expect(event.lastErrorCode).toBe('TRANSPORT_UNCONFIGURED');
      expect(event.lockToken).toBeNull();
    });
  });

  it('descarta token revocado y lleva payload inesperado a dead letter', async () => {
    await withFixture(async ({ client, eventId, tokenId }) => {
      const config = readAppConfig().auth;
      await client.accountToken.update({
        where: { id: tokenId },
        data: { revokedAt: new Date(), revocationReasonCode: 'SUPERSEDED' },
      });
      const port: InvitationNotificationPort = {
        async deliverInvitation() {
          throw new Error('No debe entregar.');
        },
      };
      expect(await processNextInvitation(client, config, port)).toBe('OBSOLETE');
      expect((await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).status).toBe(
        'OBSOLETE',
      );
      await client.outboxEvent.update({
        where: { id: eventId },
        data: { status: 'PENDING', processedAt: null, payload: { token: 'no permitido' } },
      });
      expect(await processNextInvitation(client, config, port)).toBe('DEAD_LETTER');
      expect(
        (await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).lastErrorCode,
      ).toBe('INVALID_EVENT');
    });
  });

  it('rechaza UUID no canónicos como INVALID_EVENT sin entregar ni reintentar', async () => {
    await withFixture(async ({ client, eventId, invitationId }) => {
      const config = readAppConfig().auth;
      const deliverInvitation = vi.fn(async () => undefined);
      const port: InvitationNotificationPort = { deliverInvitation };
      const canonical = await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
      const original = canonical.payload as Record<string, unknown>;
      const invalidValues: unknown[] = [
        'arbitrario',
        '',
        '   ',
        invitationId.slice(0, -1),
        `${invitationId.slice(0, -1)}z`,
        `prefix-${invitationId}`,
        `${invitationId}-suffix`,
        invitationId.toUpperCase(),
        [],
        42,
        {},
        null,
      ];

      for (const field of ['invitationId', 'organizationId'] as const) {
        for (const invalid of invalidValues) {
          await client.outboxEvent.update({
            where: { id: eventId },
            data: {
              status: 'PENDING',
              processedAt: null,
              availableAt: new Date(),
              lastErrorCode: null,
              payload: { ...original, [field]: invalid } as Prisma.InputJsonObject,
            },
          });
          expect(await processNextInvitation(client, config, port)).toBe('DEAD_LETTER');
          const event = await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
          expect(event.status).toBe('DEAD_LETTER');
          expect(event.lastErrorCode).toBe('INVALID_EVENT');
          expect(event.lockToken).toBeNull();
        }
      }
      expect(deliverInvitation).not.toHaveBeenCalled();
    });
  });
});
