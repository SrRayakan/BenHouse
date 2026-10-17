import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@benhouse/database';
import type { Prisma as P } from '@benhouse/database';
import { StorageProvider, inspectImage, InvalidImage, ObjectConflict } from '@benhouse/storage';
import { ApiError } from '../auth/auth.errors';
import { SessionAuthorizationService } from '../auth/session-authorization.service';
import type { AuthenticatedSession } from '../auth/session-authorization.service';
import { withSerializableRetry } from '../auth/serializable-transaction';
import { DatabaseService } from '../infrastructure/database/database.service';
import {
  lockActorOrganizations,
  lockProperty,
  lockPropertyAuthorizations,
  databaseNow,
} from '../marketplace/marketplace.service';
import { capabilitiesForProperty } from '../marketplace/marketplace.policy';
import type { parseIntent, parseOrder } from './media.input';
import {
  MarketplaceTransactionObserver,
  observeMarketplaceTransactionStart,
} from '../marketplace/marketplace-transaction-observer';

type Tx = P.TransactionClient;
type Media = P.MediaGetPayload<Record<string, never>>;
export type MediaContext = { cookie?: string; csrf?: string; requestId: string };
const fail = (status = 409, code = 'MEDIA_CONFLICT') =>
  new ApiError(status, code, 'No se puede realizar la operación de fotografía.');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class MediaService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionAuthorizationService,
    private readonly storage: StorageProvider,
    private readonly observer: MarketplaceTransactionObserver,
  ) {}

  async intent(input: ReturnType<typeof parseIntent>, ctx: MediaContext) {
    return this.authorized(input.propertyId, ctx, true, async (tx, actor, now) => {
      const prior = await tx.media.findUnique({
        where: {
          createdByUserId_intentKey: { createdByUserId: actor.userId, intentKey: input.intentKey },
        },
      });
      if (prior) {
        if (
          prior.propertyId !== input.propertyId ||
          prior.mime !== input.mime ||
          prior.size !== input.size ||
          prior.sha256 !== input.sha256 ||
          prior.tokenDigest !== digest(input.uploadToken) ||
          prior.uploadSessionId !== actor.sessionId
        )
          throw fail();
        this.pending(prior, actor, input.uploadToken, now);
        return intentDto(prior);
      }
      // Límite defensivo de admisión persistente, serializado también por User.
      const [propertyCount, actorCount] = await Promise.all([
        tx.media.count({
          where: { propertyId: input.propertyId, status: { in: ['PENDING', 'READY'] } },
        }),
        tx.media.count({
          where: {
            createdByUserId: actor.userId,
            createdAt: { gt: new Date(now.getTime() - 3600_000) },
          },
        }),
      ]);
      if (propertyCount >= 100 || actorCount >= 100) throw fail(429, 'MEDIA_RATE_LIMIT');
      const media = await tx.media.create({
        data: {
          propertyId: input.propertyId,
          mime: input.mime,
          size: input.size,
          sha256: input.sha256,
          intentKey: input.intentKey,
          tokenDigest: digest(input.uploadToken),
          storageKey: randomBytes(32).toString('hex'),
          createdByUserId: actor.userId,
          uploadSessionId: actor.sessionId,
          expiresAt: new Date(now.getTime() + 900_000),
          createdAt: now,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventType: 'MEDIA_UPLOAD_CLEANUP',
          aggregateType: 'MEDIA',
          aggregateId: media.id,
          availableAt: media.expiresAt,
          payload: {},
          correlationId: ctx.requestId,
        },
      });
      await this.audit(
        tx,
        actor.userId,
        media.id,
        'MEDIA_UPLOAD_INTENDED',
        null,
        'PENDING',
        now,
        ctx,
      );
      return intentDto(media);
    });
  }

  async upload(
    id: string,
    token: string | undefined,
    mime: string | undefined,
    bytes: Buffer,
    ctx: MediaContext,
  ) {
    const candidate = await this.candidate(id, ctx);
    return this.authorized(candidate.propertyId, ctx, true, async (tx, actor, now) => {
      const media = await tx.media.findUniqueOrThrow({ where: { id } });
      this.pending(media, actor, token, now);
      if (mime !== media.mime || bytes.length !== media.size)
        throw fail(400, 'MEDIA_INVALID_IMAGE');
      const metadata = await inspectImage(bytes);
      if (metadata.mime !== media.mime || metadata.sha256 !== media.sha256)
        throw fail(400, 'MEDIA_INVALID_IMAGE');
      await this.storage.put(media.storageKey, bytes);
      // Revalida caducidad tras I/O, antes de responder éxito.
      this.pending(media, actor, token, await databaseNow(tx));
      await this.sessions.revalidate(tx, actor, ctx.csrf, true);
      return { id, uploaded: true };
    });
  }

  async preflight(
    id: string,
    token: string | undefined,
    mime: string | undefined,
    size: number,
    ctx: MediaContext,
  ) {
    const candidate = await this.candidate(id, ctx);
    return this.authorized(candidate.propertyId, ctx, true, async (tx, actor, now) => {
      const media = await tx.media.findUniqueOrThrow({ where: { id } });
      this.pending(media, actor, token, now);
      if (media.mime !== mime || media.size !== size) throw fail(400, 'MEDIA_INVALID_IMAGE');
    });
  }

  async complete(id: string, ctx: MediaContext) {
    const candidate = await this.candidate(id, ctx);
    return this.authorized(candidate.propertyId, ctx, true, async (tx, actor, now) => {
      const media = await tx.media.findUniqueOrThrow({ where: { id } });
      if (media.status === 'READY') return mediaDto(media);
      if (media.status !== 'PENDING' || media.expiresAt <= now)
        throw fail(410, 'MEDIA_UPLOAD_EXPIRED');
      const bytes = await this.storage.read(media.storageKey);
      if (!bytes) throw fail(409, 'MEDIA_OBJECT_MISSING');
      const metadata = await inspectImage(bytes);
      if (
        metadata.mime !== media.mime ||
        metadata.size !== media.size ||
        metadata.sha256 !== media.sha256
      )
        throw fail(400, 'MEDIA_INVALID_IMAGE');
      if (media.expiresAt <= (await databaseNow(tx))) throw fail(410, 'MEDIA_UPLOAD_EXPIRED');
      const highest = await tx.media.aggregate({
        where: { propertyId: media.propertyId, status: 'READY' },
        _max: { position: true },
      });
      const updated = await tx.media.update({
        where: { id },
        data: {
          status: 'READY',
          confirmedAt: now,
          width: metadata.width,
          height: metadata.height,
          position: (highest._max.position ?? -1) + 1,
        },
      });
      await tx.property.update({
        where: { id: media.propertyId },
        data: { mediaVersion: { increment: 1 } },
      });
      await this.audit(tx, actor.userId, id, 'MEDIA_CONFIRMED', 'PENDING', 'READY', now, ctx);
      return mediaDto(updated);
    });
  }

  async list(propertyId: string, ctx: MediaContext) {
    return this.authorized(propertyId, ctx, false, async (tx) => this.collection(tx, propertyId));
  }
  async read(id: string, ctx: MediaContext) {
    const candidate = await this.candidate(id, ctx);
    return this.authorized(candidate.propertyId, ctx, false, async (tx) => {
      const media = await tx.media.findUniqueOrThrow({ where: { id } });
      if (media.status !== 'READY') throw fail(404, 'MEDIA_NOT_FOUND');
      const bytes = await this.storage.read(media.storageKey);
      if (!bytes || digestBytes(bytes) !== media.sha256 || bytes.length !== media.size)
        throw fail(503, 'MEDIA_OBJECT_UNAVAILABLE');
      return { bytes, mime: media.mime };
    });
  }
  async archive(id: string, ctx: MediaContext) {
    const candidate = await this.candidate(id, ctx);
    return this.authorized(candidate.propertyId, ctx, true, async (tx, actor, now) => {
      const media = await tx.media.findUniqueOrThrow({ where: { id } });
      if (['ARCHIVED', 'CANCELLED', 'EXPIRED'].includes(media.status)) return;
      const status = media.status === 'READY' ? 'ARCHIVED' : 'CANCELLED';
      await tx.media.update({ where: { id }, data: { status, position: null, archivedAt: now } });
      if (status === 'ARCHIVED')
        await tx.property.update({
          where: { id: media.propertyId },
          data: { mediaVersion: { increment: 1 } },
        });
      else
        await tx.outboxEvent.create({
          data: {
            eventType: 'MEDIA_UPLOAD_CLEANUP',
            aggregateType: 'MEDIA',
            aggregateId: id,
            availableAt: now,
            payload: {},
            correlationId: ctx.requestId,
          },
        });
      await this.audit(tx, actor.userId, id, 'MEDIA_ARCHIVED', media.status, status, now, ctx);
    });
  }
  async reorder(propertyId: string, input: ReturnType<typeof parseOrder>, ctx: MediaContext) {
    return this.authorized(propertyId, ctx, true, async (tx, actor, now) => {
      const current = await this.collection(tx, propertyId);
      if (
        current.version !== input.version ||
        current.items.length !== input.ids.length ||
        current.items.some((item) => !input.ids.includes(item.id))
      )
        throw fail();
      if (current.items.every((item, index) => item.id === input.ids[index])) return current;
      for (const [position, id] of input.ids.entries())
        await tx.media.update({ where: { id }, data: { position } });
      await tx.property.update({
        where: { id: propertyId },
        data: { mediaVersion: { increment: 1 } },
      });
      await this.audit(tx, actor.userId, propertyId, 'MEDIA_REORDERED', 'READY', 'READY', now, ctx);
      return this.collection(tx, propertyId);
    });
  }
  private async collection(tx: Tx, propertyId: string) {
    const property = await tx.property.findUniqueOrThrow({ where: { id: propertyId } });
    const items = await tx.media.findMany({
      where: { propertyId, status: 'READY' },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return { version: property.mediaVersion, items: items.map(mediaDto) };
  }
  private pending(media: Media, actor: AuthenticatedSession, token: string | undefined, now: Date) {
    if (media.status !== 'PENDING' || media.expiresAt <= now)
      throw fail(410, 'MEDIA_UPLOAD_EXPIRED');
    if (
      media.createdByUserId !== actor.userId ||
      media.uploadSessionId !== actor.sessionId ||
      !token ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(media.tokenDigest, 'hex'), Buffer.from(digest(token), 'hex'))
    )
      throw fail(404, 'MEDIA_NOT_FOUND');
  }
  private async candidate(id: string, ctx: MediaContext) {
    await this.sessions.authenticate(ctx.cookie);
    return this.execute(async () => {
      const row = await this.database.prisma.media.findUnique({
        where: { id },
        select: { propertyId: true },
      });
      if (!row) throw fail(404, 'MEDIA_NOT_FOUND');
      return row;
    });
  }
  private async authorized<T>(
    propertyId: string,
    ctx: MediaContext,
    mutation: boolean,
    work: (tx: Tx, actor: AuthenticatedSession, now: Date) => Promise<T>,
  ): Promise<T> {
    const actor = await this.sessions.authenticate(ctx.cookie, ctx.csrf, mutation);
    let attempt = 0;
    return this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(
          async (tx) => {
            await observeMarketplaceTransactionStart(tx, this.observer, {
              requestId: ctx.requestId,
              operation: 'MEDIA_ACCESS',
              attempt: ++attempt,
            });
            await this.sessions.lockAndRevalidate(tx, actor, ctx.csrf, mutation);
            const memberships = await lockActorOrganizations(tx, actor.userId);
            await lockProperty(tx, propertyId);
            await lockPropertyAuthorizations(tx, propertyId);
            await this.sessions.revalidate(tx, actor, ctx.csrf, mutation);
            const now = await databaseNow(tx);
            const property = await tx.property.findUnique({
              where: { id: propertyId },
              include: { authorizations: true },
            });
            if (
              !property ||
              property.status !== 'ACTIVE' ||
              !capabilitiesForProperty(
                actor.userId,
                property.authorizations,
                memberships,
                now,
              ).includes('PROPERTY_EDIT')
            )
              throw fail(404, 'MEDIA_NOT_FOUND');
            const result = await work(tx, actor, now);
            // Incluye caducidades que suceden durante decodificación/storage, no solo revocaciones por lock.
            const end = await databaseNow(tx);
            await this.sessions.revalidate(tx, actor, ctx.csrf, mutation);
            if (
              !capabilitiesForProperty(
                actor.userId,
                property.authorizations,
                memberships,
                end,
              ).includes('PROPERTY_EDIT')
            )
              throw fail(404, 'MEDIA_NOT_FOUND');
            return result;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 },
        ),
      ),
    );
  }
  private async audit(
    tx: Tx,
    actorUserId: string,
    resourceId: string,
    action: string,
    previousState: string | null,
    newState: string,
    now: Date,
    ctx: MediaContext,
  ) {
    await tx.auditEvent.create({
      data: {
        actorType: 'USER',
        actorUserId,
        action,
        resourceType: 'MEDIA',
        resourceId,
        previousState,
        newState,
        occurredAt: now,
        requestId: ctx.requestId,
        correlationId: ctx.requestId,
      },
    });
  }
  private async execute<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof InvalidImage) throw fail(400, 'MEDIA_INVALID_IMAGE');
      if (error instanceof ObjectConflict) throw fail();
      throw fail(503, 'MEDIA_DEPENDENCY_UNAVAILABLE');
    }
  }
}
function digestBytes(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}
function mediaDto(m: Media) {
  return {
    id: m.id,
    propertyId: m.propertyId,
    type: 'IMAGE' as const,
    status: String(m.status),
    mime: m.mime,
    size: m.size,
    width: m.width,
    height: m.height,
    order: m.position,
    createdAt: m.createdAt.toISOString(),
  };
}
function intentDto(m: Media) {
  return {
    media: mediaDto(m),
    upload: {
      method: 'PUT',
      url: `/media/${m.id}/object`,
      tokenHeader: 'X-Upload-Token',
      expiresAt: m.expiresAt.toISOString(),
    },
  };
}
