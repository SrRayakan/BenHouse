import { Prisma, type PrismaClient } from '@benhouse/database';
import type { StorageProvider } from '@benhouse/storage';

// Bloquea Property antes de outbox; ningún productor toma outbox antes de Property.
// El efecto externo es idempotente: si SQL revierte, se repite sin publicar objetos.
export async function processNextMediaCleanup(
  client: PrismaClient,
  storage: StorageProvider,
): Promise<boolean> {
  const candidates = await client.outboxEvent.findMany({
    where: {
      eventType: 'MEDIA_UPLOAD_CLEANUP',
      eventVersion: 1,
      status: 'PENDING',
      availableAt: { lte: new Date() },
    },
    orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
    take: 1,
  });
  const candidate = candidates[0];
  if (!candidate) return false;
  const media = await client.media.findUnique({ where: { id: candidate.aggregateId } });
  if (!media) throw new Error('MEDIA_CLEANUP_RESOURCE_MISSING');
  await client.$transaction(
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM property WHERE id=${media.propertyId}::uuid FOR UPDATE`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM outbox_event WHERE id=${candidate.id}::uuid FOR UPDATE`,
      );
      const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id: candidate.id } });
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      if (!clock || event.status !== 'PENDING' || event.availableAt > clock.now) return;
      const current = await tx.media.findUniqueOrThrow({ where: { id: media.id } });
      if (current.status === 'PENDING' && current.expiresAt > clock.now) {
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { availableAt: current.expiresAt },
        });
        return;
      }
      if (current.status === 'READY' || current.status === 'ARCHIVED') {
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'OBSOLETE', processedAt: clock.now },
        });
        return;
      }
      try {
        await storage.removeIncomplete(current.storageKey);
      } catch {
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: {
            attemptCount: { increment: 1 },
            lastErrorCode: 'MEDIA_STORAGE_DELETE_FAILED',
            availableAt: new Date(
              clock.now.getTime() +
                Math.min(3600, 30 * 2 ** Math.min(event.attemptCount, 7)) * 1000,
            ),
          },
        });
        return;
      }
      if (!current.cleanedAt) {
        const status = current.status === 'PENDING' ? 'EXPIRED' : current.status;
        await tx.media.update({
          where: { id: current.id },
          data: { status, cleanedAt: clock.now },
        });
        await tx.auditEvent.create({
          data: {
            actorType: 'SYSTEM',
            action: 'MEDIA_INCOMPLETE_CLEANED',
            resourceType: 'MEDIA',
            resourceId: current.id,
            previousState: current.status,
            newState: status,
            occurredAt: clock.now,
            correlationId: event.correlationId,
          },
        });
      }
      await tx.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSED', processedAt: clock.now, lastErrorCode: null },
      });
    },
    { timeout: 15_000 },
  );
  return true;
}
