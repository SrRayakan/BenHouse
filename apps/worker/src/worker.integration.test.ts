import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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
    const userId = randomUUID();
    const organizationId = randomUUID();
    const invitationId = randomUUID();
    const tokenId = randomUUID();
    const eventId = randomUUID();
    const email = `worker-${eventId}@example.test`;
    const now = new Date();
    try {
      const identity = await client.$queryRaw<
        Array<{ name: string }>
      >`SELECT current_database() AS name`;
      expect(identity[0]?.name).toBe('benhouse_test');
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
    } finally {
      await client.outboxEvent.deleteMany({ where: { id: eventId } });
      await client.accountToken.deleteMany({ where: { id: tokenId } });
      await client.organizationInvitation.deleteMany({ where: { id: invitationId } });
      await client.organization.deleteMany({ where: { id: organizationId } });
      await client.user.deleteMany({ where: { id: userId } });
      await client.$disconnect();
    }
  }

  it('entrega una sola vez con dos workers y confirma después del transporte', async () => {
    await withFixture(async ({ client, eventId, invitationId, tokenId, organizationId, email }) => {
      const deliveries: InvitationDelivery[] = [];
      const port: InvitationNotificationPort = {
        async deliverInvitation(delivery) {
          deliveries.push(delivery);
          expect(
            (await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).status,
          ).toBe('PROCESSING');
        },
      };
      const config = readAppConfig().auth;
      const otherClient = createPrismaClient();
      let outcomes: string[];
      try {
        outcomes = await Promise.all([
          processNextInvitation(client, config, port, 'worker-a'),
          processNextInvitation(otherClient, config, port, 'worker-b'),
        ]);
      } finally {
        await otherClient.$disconnect();
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
