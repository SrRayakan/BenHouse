import { Inject, Injectable } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthConfig } from '@benhouse/config';
import { Prisma } from '@benhouse/database';
import { DatabaseService } from '../infrastructure/database/database.service';
import {
  accountTokenAuthenticator,
  createAccountTokenMaterial,
  parseAccountToken,
} from './account-token';
import { AUTH_CONFIG } from './auth.config';
import {
  ApiError,
  authenticationRequired,
  csrfInvalid,
  csrfRequired,
  invalidCredentials,
  invalidOrExpiredToken,
  securityDependencyUnavailable,
} from './auth.errors';
import { AuthRateLimitService } from './rate-limit.service';
import { PASSWORD_ENGINE, PasswordEngine } from './password';
import { parseSessionToken, verifySessionSecret } from './session-token';
import { canonicalizeEmail } from './email';
import { exactObject, requiredString } from './input-validation';
import { verifyCsrfToken } from './csrf';
import { SystemClock } from './clock';
import { withSerializableRetry } from './serializable-transaction';

type EmailBody = { email: string };
type ResetPasswordBody = { token: string; password: string };
type ChangePasswordBody = { currentPassword: string; newPassword: string };
type TokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

interface AuthenticatedCandidate {
  userId: string;
  sessionId: string;
  issuedSessionVersion: number;
  parsed: NonNullable<ReturnType<typeof parseSessionToken>>;
}

@Injectable()
export class AccountLifecycleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rateLimits: AuthRateLimitService,
    private readonly clock: SystemClock,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(PASSWORD_ENGINE) private readonly passwords: PasswordEngine,
  ) {}

  parseEmptyBody(input: unknown): void {
    exactObject(input, []);
  }

  parseEmailBody(input: unknown): EmailBody {
    const body = exactObject(input, ['email']);
    return { email: canonicalizeEmail(body.email) };
  }

  parseResetPasswordBody(input: unknown): ResetPasswordBody {
    const body = exactObject(input, ['token', 'password']);
    return {
      token: requiredString(body.token, 128),
      password: requiredString(body.password, 512),
    };
  }

  parseChangePasswordBody(input: unknown): ChangePasswordBody {
    const body = exactObject(input, ['currentPassword', 'newPassword']);
    return {
      currentPassword: requiredString(body.currentPassword, 512),
      newPassword: requiredString(body.newPassword, 512),
    };
  }

  async logout(
    cookie: string | undefined,
    csrfToken: string | undefined,
    requestId?: string,
  ): Promise<void> {
    const candidate = await this.authenticate(cookie, csrfToken);
    try {
      await withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await lockUser(tx, candidate.userId);
          await lockSession(tx, candidate.sessionId);
          const now = await databaseNow(tx);
          await this.revalidateSession(tx, candidate, csrfToken!, now);
          const revoked = await tx.session.updateMany({
            where: { id: candidate.sessionId, revokedAt: null },
            data: { revokedAt: now, revocationReason: 'LOGOUT' },
          });
          if (revoked.count !== 1) throw authenticationRequired();
          await tx.auditEvent.create({
            data: auditData(
              'SESSION_REVOKED',
              'SESSION',
              candidate.sessionId,
              now,
              requestId,
              {
                reason: 'LOGOUT',
              },
              candidate.userId,
            ),
          });
        }, serializable),
      );
    } catch (error) {
      throw mapAuthenticatedMutationError(error);
    }
  }

  async logoutAll(
    cookie: string | undefined,
    csrfToken: string | undefined,
    ip: string,
    requestId?: string,
  ): Promise<void> {
    const candidate = await this.authenticate(cookie, csrfToken);
    await this.rateLimits.consume([
      {
        action: 'LOGOUT_ALL',
        dimension: 'ACTOR',
        value: candidate.userId,
        policy: 'LOGOUT_ALL_ACTOR',
      },
      { action: 'LOGOUT_ALL', dimension: 'IP', value: ip, policy: 'LOGOUT_ALL_IP' },
    ]);
    try {
      await withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await lockUser(tx, candidate.userId);
          await lockUserSessions(tx, candidate.userId);
          const now = await databaseNow(tx);
          await this.revalidateSession(tx, candidate, csrfToken!, now);
          await tx.user.update({
            where: { id: candidate.userId },
            data: { sessionVersion: { increment: 1 } },
          });
          await tx.session.updateMany({
            where: { userId: candidate.userId, revokedAt: null },
            data: { revokedAt: now, revocationReason: 'LOGOUT_ALL' },
          });
          await tx.auditEvent.create({
            data: auditData(
              'ALL_SESSIONS_REVOKED',
              'USER',
              candidate.userId,
              now,
              requestId,
              { reason: 'LOGOUT_ALL' },
              candidate.userId,
            ),
          });
        }, serializable),
      );
    } catch (error) {
      throw mapAuthenticatedMutationError(error);
    }
  }

  async resendVerification(body: EmailBody, ip: string, requestId?: string): Promise<void> {
    await this.rateLimits.consume([
      {
        action: 'RESEND_VERIFICATION',
        dimension: 'EMAIL',
        value: body.email,
        policy: 'RESEND_VERIFICATION_EMAIL',
      },
      {
        action: 'RESEND_VERIFICATION',
        dimension: 'IP',
        value: ip,
        policy: 'RESEND_VERIFICATION_IP',
      },
      {
        action: 'RESEND_VERIFICATION',
        dimension: 'EMAIL_IP',
        value: `${body.email}\0${ip}`,
        policy: 'RESEND_VERIFICATION_EMAIL_IP',
      },
    ]);
    await this.requestAccountToken(body.email, 'EMAIL_VERIFICATION', requestId);
  }

  async forgotPassword(body: EmailBody, ip: string, requestId?: string): Promise<void> {
    await this.rateLimits.consume([
      {
        action: 'FORGOT_PASSWORD',
        dimension: 'EMAIL',
        value: body.email,
        policy: 'FORGOT_PASSWORD_EMAIL',
      },
      { action: 'FORGOT_PASSWORD', dimension: 'IP', value: ip, policy: 'FORGOT_PASSWORD_IP' },
      {
        action: 'FORGOT_PASSWORD',
        dimension: 'EMAIL_IP',
        value: `${body.email}\0${ip}`,
        policy: 'FORGOT_PASSWORD_EMAIL_IP',
      },
    ]);
    await this.requestAccountToken(body.email, 'PASSWORD_RESET', requestId);
  }

  async resetPassword(body: ResetPasswordBody, ip: string, requestId?: string): Promise<void> {
    const parsed = parseAccountToken(body.token);
    const tokenSubject = parsed?.selector ?? AuthRateLimitService.malformedTokenSubject(body.token);
    await this.rateLimits.consume([
      {
        action: 'RESET_PASSWORD',
        dimension: 'TOKEN',
        value: tokenSubject,
        policy: 'RESET_PASSWORD_TOKEN',
      },
      { action: 'RESET_PASSWORD', dimension: 'IP', value: ip, policy: 'RESET_PASSWORD_IP' },
      {
        action: 'RESET_PASSWORD',
        dimension: 'TOKEN_IP',
        value: `${tokenSubject}\0${ip}`,
        policy: 'RESET_PASSWORD_TOKEN_IP',
      },
    ]);
    const password = this.passwords.validate(body.password);
    const passwordHash = await this.passwords.hash(password);
    if (!parsed) throw invalidOrExpiredToken();

    let candidate;
    try {
      candidate = await this.database.prisma.accountToken.findUnique({
        where: { id: parsed.selector },
        select: { userId: true },
      });
    } catch {
      throw securityDependencyUnavailable();
    }
    if (!candidate?.userId) throw invalidOrExpiredToken();

    try {
      await withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await lockUser(tx, candidate.userId!);
          await lockCredential(tx, candidate.userId!);
          await lockUserSessions(tx, candidate.userId!);
          await lockUserTokens(tx, candidate.userId!, 'PASSWORD_RESET');
          const now = await databaseNow(tx);
          const [user, credential, token, latest] = await Promise.all([
            tx.user.findUnique({ where: { id: candidate.userId! } }),
            tx.passwordCredential.findUnique({ where: { userId: candidate.userId! } }),
            tx.accountToken.findUnique({ where: { id: parsed.selector } }),
            tx.accountToken.findFirst({
              where: { userId: candidate.userId!, purpose: 'PASSWORD_RESET' },
              orderBy: { generation: 'desc' },
              select: { generation: true },
            }),
          ]);
          const expected = token
            ? (accountTokenAuthenticator(
                {
                  id: token.id,
                  purpose: 'PASSWORD_RESET',
                  generation: token.generation,
                  subjectType: 'USER',
                  subjectId: candidate.userId!,
                  keyVersion: token.keyVersion,
                },
                this.config.accountTokenKeys,
              ) ?? Buffer.alloc(32))
            : Buffer.alloc(32);
          const valid =
            token?.purpose === 'PASSWORD_RESET' &&
            token.userId === candidate.userId &&
            token.consumedAt === null &&
            token.revokedAt === null &&
            token.expiresAt > now &&
            latest?.generation === token.generation &&
            user?.status === 'ACTIVE' &&
            user.emailVerifiedAt !== null &&
            Boolean(credential) &&
            expected.length === parsed.authenticator.length &&
            timingSafeEqual(expected, parsed.authenticator);
          if (!valid || !token || !credential) throw invalidOrExpiredToken();
          const consumed = await tx.accountToken.updateMany({
            where: { id: token.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
            data: { consumedAt: now },
          });
          if (consumed.count !== 1) throw invalidOrExpiredToken();
          await tx.passwordCredential.update({
            where: { userId: candidate.userId! },
            data: { passwordHash, passwordChangedAt: now },
          });
          await tx.user.update({
            where: { id: candidate.userId! },
            data: { sessionVersion: { increment: 1 } },
          });
          await tx.session.updateMany({
            where: { userId: candidate.userId!, revokedAt: null },
            data: { revokedAt: now, revocationReason: 'PASSWORD_RESET' },
          });
          const revokedIds = await revokeOtherTokens(
            tx,
            candidate.userId!,
            'PASSWORD_RESET',
            token.id,
            now,
          );
          await obsoleteTokenEvents(tx, revokedIds, now);
          await tx.auditEvent.create({
            data: auditData('PASSWORD_RESET', 'USER', candidate.userId!, now, requestId, {
              generation: token.generation,
            }),
          });
        }, serializable),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw securityDependencyUnavailable();
    }
  }

  async changePassword(
    body: ChangePasswordBody,
    cookie: string | undefined,
    csrfToken: string | undefined,
    ip: string,
    requestId?: string,
  ): Promise<void> {
    const candidate = await this.authenticate(cookie, csrfToken);
    await this.rateLimits.consume([
      {
        action: 'CHANGE_PASSWORD',
        dimension: 'ACTOR',
        value: candidate.userId,
        policy: 'CHANGE_PASSWORD_ACTOR',
      },
      { action: 'CHANGE_PASSWORD', dimension: 'IP', value: ip, policy: 'CHANGE_PASSWORD_IP' },
    ]);
    const newPassword = this.passwords.validate(body.newPassword);
    let credential;
    try {
      credential = await this.database.prisma.passwordCredential.findUnique({
        where: { userId: candidate.userId },
      });
    } catch {
      throw securityDependencyUnavailable();
    }
    const current = await this.passwords.verifyForLogin(
      body.currentPassword,
      credential?.passwordHash,
    );
    const newHash = await this.passwords.hash(newPassword);
    if (!current.valid || !credential) throw invalidCredentials();

    try {
      await withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await lockUser(tx, candidate.userId);
          await lockCredential(tx, candidate.userId);
          await lockUserSessions(tx, candidate.userId);
          await lockUserTokens(tx, candidate.userId, 'PASSWORD_RESET');
          const now = await databaseNow(tx);
          await this.revalidateSession(tx, candidate, csrfToken!, now);
          const lockedCredential = await tx.passwordCredential.findUnique({
            where: { userId: candidate.userId },
          });
          if (!lockedCredential || lockedCredential.passwordHash !== current.candidateHash)
            throw invalidCredentials();
          await tx.passwordCredential.update({
            where: { userId: candidate.userId },
            data: { passwordHash: newHash, passwordChangedAt: now },
          });
          await tx.user.update({
            where: { id: candidate.userId },
            data: { sessionVersion: { increment: 1 } },
          });
          await tx.session.updateMany({
            where: { userId: candidate.userId, revokedAt: null },
            data: { revokedAt: now, revocationReason: 'PASSWORD_CHANGE' },
          });
          const revokedIds = await revokeOtherTokens(
            tx,
            candidate.userId,
            'PASSWORD_RESET',
            undefined,
            now,
          );
          await obsoleteTokenEvents(tx, revokedIds, now);
          await tx.auditEvent.create({
            data: auditData(
              'PASSWORD_CHANGED',
              'USER',
              candidate.userId,
              now,
              requestId,
              {},
              candidate.userId,
            ),
          });
        }, serializable),
      );
    } catch (error) {
      throw mapAuthenticatedMutationError(error);
    }
  }

  private async requestAccountToken(
    email: string,
    purpose: TokenPurpose,
    requestId?: string,
  ): Promise<void> {
    let candidate;
    try {
      candidate = await this.database.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
    } catch {
      throw securityDependencyUnavailable();
    }

    // Mantiene una operación HMAC en rutas inexistentes/no elegibles sin crear outbox ficticio.
    createAccountTokenMaterial(randomUUID(), 1, this.config.accountTokenKeys, purpose);
    if (!candidate) return;

    try {
      await withSerializableRetry(
        () =>
          this.database.prisma.$transaction(async (tx) => {
            await lockUser(tx, candidate.id);
            if (purpose === 'PASSWORD_RESET') await lockCredential(tx, candidate.id);
            await lockUserTokens(tx, candidate.id, purpose);
            const now = await databaseNow(tx);
            const user = await tx.user.findUnique({
              where: { id: candidate.id },
              include: { passwordCredential: true },
            });
            const eligible =
              user?.status === 'ACTIVE' &&
              (purpose === 'EMAIL_VERIFICATION'
                ? user.emailVerifiedAt === null
                : user.emailVerifiedAt !== null && Boolean(user.passwordCredential));
            if (!eligible || !user) return;
            const latest = await tx.accountToken.findFirst({
              where: { userId: user.id, purpose },
              orderBy: { generation: 'desc' },
              select: { generation: true },
            });
            const generation = (latest?.generation ?? 0) + 1;
            const revokedIds = await revokeOtherTokens(tx, user.id, purpose, undefined, now);
            await obsoleteTokenEvents(tx, revokedIds, now);
            const created = createAccountTokenMaterial(
              user.id,
              generation,
              this.config.accountTokenKeys,
              purpose,
            );
            const token = await tx.accountToken.create({
              data: {
                id: created.material.id,
                purpose,
                generation,
                keyVersion: created.material.keyVersion,
                userId: user.id,
                createdAt: now,
                expiresAt: addSeconds(
                  now,
                  purpose === 'EMAIL_VERIFICATION'
                    ? this.config.emailVerificationTtlSeconds
                    : this.config.passwordResetTtlSeconds,
                ),
              },
            });
            const eventType =
              purpose === 'EMAIL_VERIFICATION' ? 'VERIFICATION_RESENT' : 'PASSWORD_RESET_REQUESTED';
            await tx.outboxEvent.create({
              data: {
                eventType,
                aggregateType: 'USER',
                aggregateId: user.id,
                accountTokenId: token.id,
                payload: {
                  userId: user.id,
                  accountTokenId: token.id,
                  purpose,
                  generation,
                  template:
                    purpose === 'EMAIL_VERIFICATION'
                      ? 'email-verification-v1'
                      : 'password-reset-v1',
                  locale: 'es-ES',
                },
                occurredAt: now,
                correlationId: requestId,
              },
            });
            await tx.auditEvent.create({
              data: auditData(eventType, 'USER', user.id, now, requestId, { purpose, generation }),
            });
          }, serializable),
        isRetryableAccountTokenGenerationConflict,
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw securityDependencyUnavailable();
    }
  }

  private async authenticate(
    cookie: string | undefined,
    csrfToken: string | undefined,
  ): Promise<AuthenticatedCandidate> {
    const parsed = cookie ? parseSessionToken(cookie) : undefined;
    if (!parsed) throw authenticationRequired();
    let session;
    try {
      session = await this.database.prisma.session.findUnique({
        where: { id: parsed.selector },
        include: { user: true },
      });
    } catch {
      throw securityDependencyUnavailable();
    }
    const now = this.clock.now();
    if (
      !session ||
      !verifySessionSecret(
        parsed.selector,
        parsed.secret,
        Buffer.from(session.secretDigest),
        session.secretKeyVersion,
        this.config.sessionTokenKeys,
      ) ||
      session.revokedAt !== null ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      session.issuedSessionVersion !== session.user.sessionVersion ||
      session.user.status !== 'ACTIVE' ||
      session.user.emailVerifiedAt === null
    )
      throw authenticationRequired();
    if (!csrfToken) throw csrfRequired();
    if (!verifyCsrfToken(csrfToken, session.id, session.issuedSessionVersion, this.config.csrfKeys))
      throw csrfInvalid();
    return {
      userId: session.userId,
      sessionId: session.id,
      issuedSessionVersion: session.issuedSessionVersion,
      parsed,
    };
  }

  private async revalidateSession(
    tx: Prisma.TransactionClient,
    candidate: AuthenticatedCandidate,
    csrfToken: string,
    now: Date,
  ): Promise<void> {
    const session = await tx.session.findUnique({
      where: { id: candidate.sessionId },
      include: { user: true },
    });
    if (
      !session ||
      session.userId !== candidate.userId ||
      !verifySessionSecret(
        candidate.parsed.selector,
        candidate.parsed.secret,
        Buffer.from(session.secretDigest),
        session.secretKeyVersion,
        this.config.sessionTokenKeys,
      ) ||
      session.revokedAt !== null ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      session.issuedSessionVersion !== candidate.issuedSessionVersion ||
      session.issuedSessionVersion !== session.user.sessionVersion ||
      session.user.status !== 'ACTIVE' ||
      session.user.emailVerifiedAt === null
    )
      throw authenticationRequired();
    if (!verifyCsrfToken(csrfToken, session.id, session.issuedSessionVersion, this.config.csrfKeys))
      throw csrfInvalid();
  }
}

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

// Orden global B1 Identity: User -> PasswordCredential -> Session -> AccountToken.
// Cada comando omite los tipos de fila que no necesita y ordena por id los conjuntos.

async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${userId}::uuid FOR UPDATE`);
}

async function lockCredential(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "user_id" FROM "password_credential" WHERE "user_id" = ${userId}::uuid FOR UPDATE`,
  );
}

async function lockSession(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`,
  );
}

async function lockUserSessions(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "session" WHERE "user_id" = ${userId}::uuid ORDER BY "id" FOR UPDATE`,
  );
}

async function lockUserTokens(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: TokenPurpose,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "account_token" WHERE "user_id" = ${userId}::uuid AND "purpose" = ${purpose}::"AccountTokenPurpose" ORDER BY "id" FOR UPDATE`,
  );
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ currentTime: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "currentTime"`,
  );
  if (!(row?.currentTime instanceof Date)) throw new Error('Reloj PostgreSQL no disponible.');
  return row.currentTime;
}

async function revokeOtherTokens(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: TokenPurpose,
  exceptId: string | undefined,
  now: Date,
): Promise<string[]> {
  const tokens = await tx.accountToken.findMany({
    where: {
      userId,
      purpose,
      consumedAt: null,
      revokedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (tokens.length > 0) {
    await tx.accountToken.updateMany({
      where: { id: { in: tokens.map(({ id }) => id) }, consumedAt: null, revokedAt: null },
      data: { revokedAt: now, revocationReasonCode: 'SUPERSEDED' },
    });
  }
  return tokens.map(({ id }) => id);
}

async function obsoleteTokenEvents(
  tx: Prisma.TransactionClient,
  tokenIds: readonly string[],
  now: Date,
): Promise<void> {
  if (tokenIds.length === 0) return;
  await tx.outboxEvent.updateMany({
    where: { accountTokenId: { in: [...tokenIds] }, status: 'PENDING' },
    data: { status: 'OBSOLETE', processedAt: now },
  });
  await tx.outboxEvent.updateMany({
    where: {
      accountTokenId: { in: [...tokenIds] },
      status: 'PROCESSING',
      lockedUntil: { lte: now },
    },
    data: {
      status: 'OBSOLETE',
      processedAt: now,
      lockedAt: null,
      lockedUntil: null,
      lockedBy: null,
      lockToken: null,
    },
  });
}

function auditData(
  action: string,
  resourceType: string,
  resourceId: string,
  occurredAt: Date,
  requestId: string | undefined,
  metadata: Prisma.InputJsonObject,
  actorUserId?: string,
) {
  return {
    actorType: actorUserId ? ('USER' as const) : ('ANONYMOUS' as const),
    ...(actorUserId ? { actorUserId } : {}),
    action,
    resourceType,
    resourceId,
    metadata,
    requestId,
    correlationId: requestId,
    occurredAt,
  };
}

function mapAuthenticatedMutationError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return securityDependencyUnavailable();
}

export function isRetryableAccountTokenGenerationConflict(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    meta?: { modelName?: unknown; target?: unknown } | null;
  } | null;
  const target = candidate?.meta?.target;
  return (
    candidate?.code === 'P2002' &&
    candidate.meta?.modelName === 'AccountToken' &&
    Array.isArray(target) &&
    target.length === 3 &&
    target[0] === 'purpose' &&
    target[1] === 'user_id' &&
    target[2] === 'generation'
  );
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
