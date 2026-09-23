import { randomUUID } from 'node:crypto';
import type { AuthConfig } from '@benhouse/config';
import { isCanonicalUuid, serializeInvitationToken } from '@benhouse/config';
import { Prisma } from '@benhouse/database';
import type { PrismaClient } from '@benhouse/database';

const EVENT_TYPE = 'ORGANIZATION_INVITATION_REQUESTED';
const LEASE_SECONDS = 300;
const MAX_ATTEMPTS = 5;

export type InvitationDelivery = {
  eventId: string;
  recipientEmail: string;
  token: string;
  locale: 'es';
};

export interface InvitationNotificationPort {
  deliverInvitation(delivery: InvitationDelivery): Promise<void>;
}

export class UnconfiguredInvitationNotificationPort implements InvitationNotificationPort {
  async deliverInvitation(): Promise<void> {
    throw new Error('Invitation notification transport is not configured.');
  }
}

type Claimed = { id: string; lockToken: string; attemptCount: number };
type Payload = {
  invitationId: string;
  organizationId: string;
  purpose: 'ORGANIZATION_INVITATION';
  generation: number;
  template: 'organization_invitation';
  locale: 'es';
};

function payloadOf(value: unknown): Payload | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.join(',') !== 'generation,invitationId,locale,organizationId,purpose,template')
    return undefined;
  if (
    !isCanonicalUuid(input.invitationId) ||
    !isCanonicalUuid(input.organizationId) ||
    input.purpose !== 'ORGANIZATION_INVITATION' ||
    !Number.isSafeInteger(input.generation) ||
    Number(input.generation) < 1 ||
    input.template !== 'organization_invitation' ||
    input.locale !== 'es'
  )
    return undefined;
  return input as Payload;
}

async function claimNext(client: PrismaClient, workerId: string): Promise<Claimed | undefined> {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "outbox_event"
      WHERE "event_type" = ${EVENT_TYPE}
        AND "event_version" = 1
        AND (
          ("status" = 'PENDING' AND "available_at" <= clock_timestamp())
          OR ("status" = 'PROCESSING' AND "locked_until" <= clock_timestamp())
        )
      ORDER BY "available_at", "occurred_at", "id"
      FOR UPDATE SKIP LOCKED LIMIT 1
    `);
    const id = rows[0]?.id;
    if (!id) return undefined;
    const lockToken = randomUUID();
    const now = await tx.$queryRaw<Array<{ value: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS value`,
    );
    const lockedAt = now[0]?.value;
    if (!lockedAt) throw new Error('Database clock unavailable.');
    const event = await tx.outboxEvent.update({
      where: { id },
      data: {
        status: 'PROCESSING',
        attemptCount: { increment: 1 },
        lockedAt,
        lockedUntil: new Date(lockedAt.getTime() + LEASE_SECONDS * 1000),
        lockedBy: workerId,
        lockToken,
        lastErrorCode: null,
      },
      select: { attemptCount: true },
    });
    return { id, lockToken, attemptCount: event.attemptCount };
  });
}

async function finish(
  client: PrismaClient,
  claimed: Claimed,
  outcome: 'PROCESSED' | 'OBSOLETE' | 'RETRY' | 'DEAD_LETTER',
  errorCode?: 'DELIVERY_FAILED' | 'TRANSPORT_UNCONFIGURED' | 'INVALID_EVENT',
): Promise<void> {
  const now = new Date();
  const terminal = outcome === 'PROCESSED' || outcome === 'OBSOLETE';
  const retry = outcome === 'RETRY';
  const updated = await client.outboxEvent.updateMany({
    where: { id: claimed.id, status: 'PROCESSING', lockToken: claimed.lockToken },
    data: {
      status: retry ? 'PENDING' : outcome,
      processedAt: terminal ? now : null,
      availableAt: retry
        ? new Date(now.getTime() + Math.min(3600, 30 * 2 ** (claimed.attemptCount - 1)) * 1000)
        : undefined,
      lastErrorCode: terminal ? null : errorCode,
      lockedAt: null,
      lockedUntil: null,
      lockedBy: null,
      lockToken: null,
    },
  });
  if (updated.count !== 1) throw new Error('Invitation outbox lease was lost.');
}

export async function processNextInvitation(
  client: PrismaClient,
  config: AuthConfig,
  notifications: InvitationNotificationPort,
  workerId = `invitation-${process.pid}`,
): Promise<'IDLE' | 'PROCESSED' | 'OBSOLETE' | 'RETRY' | 'DEAD_LETTER'> {
  const claimed = await claimNext(client, workerId);
  if (!claimed) return 'IDLE';
  try {
    const event = await client.outboxEvent.findUnique({ where: { id: claimed.id } });
    const payload = payloadOf(event?.payload);
    if (
      !event ||
      event.eventType !== EVENT_TYPE ||
      event.eventVersion !== 1 ||
      event.aggregateType !== 'ORGANIZATION_INVITATION' ||
      !payload ||
      event.aggregateId !== payload.invitationId ||
      !event.accountTokenId
    ) {
      await finish(client, claimed, 'DEAD_LETTER', 'INVALID_EVENT');
      return 'DEAD_LETTER';
    }
    const [invitation, accountToken, latest, organization, clock] = await Promise.all([
      client.organizationInvitation.findUnique({ where: { id: payload.invitationId } }),
      client.accountToken.findUnique({ where: { id: event.accountTokenId } }),
      client.accountToken.findFirst({
        where: {
          organizationInvitationId: payload.invitationId,
          purpose: 'ORGANIZATION_INVITATION',
        },
        orderBy: { generation: 'desc' },
      }),
      client.organization.findUnique({ where: { id: payload.organizationId } }),
      client.$queryRaw<Array<{ value: Date }>>(Prisma.sql`SELECT clock_timestamp() AS value`),
    ]);
    const now = clock[0]?.value;
    if (
      !invitation ||
      !accountToken ||
      !latest ||
      !organization ||
      !now ||
      invitation.organizationId !== payload.organizationId ||
      accountToken.organizationInvitationId !== payload.invitationId ||
      accountToken.purpose !== payload.purpose ||
      accountToken.generation !== payload.generation
    ) {
      await finish(client, claimed, 'DEAD_LETTER', 'INVALID_EVENT');
      return 'DEAD_LETTER';
    }
    if (
      invitation.status !== 'PENDING' ||
      invitation.expiresAt <= now ||
      organization.status !== 'ACTIVE' ||
      latest.id !== accountToken.id ||
      accountToken.expiresAt <= now ||
      accountToken.consumedAt ||
      accountToken.revokedAt
    ) {
      await finish(client, claimed, 'OBSOLETE');
      return 'OBSOLETE';
    }
    const token = serializeInvitationToken(
      {
        id: accountToken.id,
        purpose: 'ORGANIZATION_INVITATION',
        generation: accountToken.generation,
        subjectType: 'ORGANIZATION_INVITATION',
        subjectId: invitation.id,
        organizationId: invitation.organizationId,
        email: invitation.email,
        role: invitation.role,
        keyVersion: accountToken.keyVersion,
      },
      config.accountTokenKeys,
    );
    await notifications.deliverInvitation({
      eventId: event.id,
      recipientEmail: invitation.email,
      token,
      locale: 'es',
    });
    await finish(client, claimed, 'PROCESSED');
    return 'PROCESSED';
  } catch {
    const code =
      notifications instanceof UnconfiguredInvitationNotificationPort
        ? 'TRANSPORT_UNCONFIGURED'
        : 'DELIVERY_FAILED';
    const outcome = claimed.attemptCount >= MAX_ATTEMPTS ? 'DEAD_LETTER' : 'RETRY';
    await finish(client, claimed, outcome, code);
    return outcome;
  }
}
