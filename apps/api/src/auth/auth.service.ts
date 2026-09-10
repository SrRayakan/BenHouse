import { Inject, Injectable } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthConfig } from '@benhouse/config';
import { Prisma } from '@benhouse/database';
import { DatabaseService } from '../infrastructure/database/database.service';
import { accountTokenAuthenticator, parseAccountToken } from './account-token';
import { AUTH_CONFIG } from './auth.config';
import {
  ApiError,
  invalidCredentials,
  invalidOrExpiredToken,
  securityDependencyUnavailable,
} from './auth.errors';
import { AuthRateLimitService } from './rate-limit.service';
import { PASSWORD_ENGINE, PasswordEngine } from './password';
import {
  createSessionToken,
  parseSessionToken,
  sessionSecretDigest,
  verifySessionSecret,
} from './session-token';
import { canonicalizeEmail } from './email';
import { exactObject, requiredString, validateDisplayName } from './input-validation';
import { deriveCsrfToken } from './csrf';
import { SystemClock } from './clock';
import { isSerializationFailure, withSerializableRetry } from './serializable-transaction';

type RegisterBody = { email: string; displayName: string; password: string };
type LoginBody = { email: string; password: string };
type SessionView = {
  authenticated: true;
  user: { id: string; email: string; displayName: string; status: 'ACTIVE'; emailVerified: true };
  capabilities: [];
  session: { expiresAt: string };
  csrfToken: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rateLimits: AuthRateLimitService,
    private readonly clock: SystemClock,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(PASSWORD_ENGINE) private readonly passwords: PasswordEngine,
  ) {}

  parseRegisterBody(input: unknown): RegisterBody {
    const body = exactObject(input, ['email', 'displayName', 'password']);
    return {
      email: canonicalizeEmail(body.email),
      displayName: requiredString(body.displayName, 240),
      password: requiredString(body.password, 512),
    };
  }

  parseLoginBody(input: unknown): LoginBody {
    const body = exactObject(input, ['email', 'password']);
    return {
      email: canonicalizeEmail(body.email),
      password: requiredString(body.password, 512),
    };
  }

  parseVerifyBody(input: unknown): string {
    const body = exactObject(input, ['token']);
    return requiredString(body.token, 128);
  }

  async register(body: RegisterBody, ip: string, requestId?: string): Promise<void> {
    await this.rateLimits.consume([
      { action: 'REGISTER', dimension: 'EMAIL', value: body.email, policy: 'REGISTER_EMAIL' },
      { action: 'REGISTER', dimension: 'IP', value: ip, policy: 'REGISTER_IP' },
      {
        action: 'REGISTER',
        dimension: 'EMAIL_IP',
        value: `${body.email}\0${ip}`,
        policy: 'REGISTER_EMAIL_IP',
      },
    ]);
    const displayName = validateDisplayName(body.displayName);
    const password = this.passwords.validate(body.password);
    const passwordHash = await this.passwords.hash(password);
    const now = this.clock.now();
    try {
      await this.database.prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({
          where: { email: body.email },
          select: { id: true },
        });
        if (existing) return;
        const user = await tx.user.create({
          data: { email: body.email, displayName, status: 'ACTIVE' },
          select: { id: true },
        });
        await tx.passwordCredential.create({
          data: {
            userId: user.id,
            passwordHash,
            createdAt: now,
            passwordChangedAt: now,
          },
        });
        const tokenId = randomUUID();
        const token = await tx.accountToken.create({
          data: {
            id: tokenId,
            purpose: 'EMAIL_VERIFICATION',
            generation: 1,
            keyVersion: this.config.accountTokenKeys.currentVersion,
            userId: user.id,
            createdAt: now,
            expiresAt: addSeconds(now, this.config.emailVerificationTtlSeconds),
          },
          select: { id: true, generation: true },
        });
        await tx.outboxEvent.create({
          data: {
            eventType: 'EMAIL_VERIFICATION_REQUESTED',
            aggregateType: 'USER',
            aggregateId: user.id,
            accountTokenId: token.id,
            payload: {
              userId: user.id,
              accountTokenId: token.id,
              purpose: 'EMAIL_VERIFICATION',
              generation: token.generation,
              template: 'email-verification-v1',
              locale: 'es-ES',
            },
            occurredAt: now,
            correlationId: requestId,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorType: 'ANONYMOUS',
            action: 'USER_REGISTERED',
            resourceType: 'USER',
            resourceId: user.id,
            newState: 'ACTIVE_UNVERIFIED',
            metadata: { purpose: 'EMAIL_VERIFICATION', generation: 1 },
            requestId,
            correlationId: requestId,
            occurredAt: now,
          },
        });
      });
    } catch (error) {
      if (isUserEmailUniqueConstraint(error)) return;
      throw securityDependencyUnavailable();
    }
  }

  async verifyEmail(rawToken: string, ip: string, requestId?: string): Promise<void> {
    const parsed = parseAccountToken(rawToken);
    const tokenSubject = parsed?.selector ?? AuthRateLimitService.malformedTokenSubject(rawToken);
    await this.rateLimits.consume([
      {
        action: 'VERIFY_EMAIL',
        dimension: 'TOKEN',
        value: tokenSubject,
        policy: 'VERIFY_EMAIL_TOKEN',
      },
      { action: 'VERIFY_EMAIL', dimension: 'IP', value: ip, policy: 'VERIFY_EMAIL_IP' },
      {
        action: 'VERIFY_EMAIL',
        dimension: 'TOKEN_IP',
        value: `${tokenSubject}\0${ip}`,
        policy: 'VERIFY_EMAIL_TOKEN_IP',
      },
    ]);
    if (!parsed) throw invalidOrExpiredToken();
    const now = this.clock.now();
    try {
      await withSerializableRetry(() =>
        this.database.prisma.$transaction(
          async (tx) => {
            const candidate = await tx.accountToken.findUnique({
              where: { id: parsed.selector },
              select: { userId: true },
            });
            if (!candidate?.userId) throw invalidOrExpiredToken();
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${candidate.userId}::uuid FOR UPDATE`,
            );
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "account_token" WHERE "id" = ${parsed.selector}::uuid FOR UPDATE`,
            );
            const token = await tx.accountToken.findUnique({ where: { id: parsed.selector } });
            if (
              !token?.userId ||
              token.userId !== candidate.userId ||
              token.purpose !== 'EMAIL_VERIFICATION'
            )
              throw invalidOrExpiredToken();
            const user = await tx.user.findUnique({ where: { id: token.userId } });
            const latest = await tx.accountToken.findFirst({
              where: { userId: token.userId, purpose: 'EMAIL_VERIFICATION' },
              orderBy: { generation: 'desc' },
              select: { generation: true },
            });
            const expected =
              accountTokenAuthenticator(
                {
                  id: token.id,
                  purpose: 'EMAIL_VERIFICATION',
                  generation: token.generation,
                  subjectType: 'USER',
                  subjectId: token.userId,
                  keyVersion: token.keyVersion,
                },
                this.config.accountTokenKeys,
              ) ?? Buffer.alloc(32);
            const valid =
              token.consumedAt === null &&
              token.revokedAt === null &&
              token.expiresAt > now &&
              latest?.generation === token.generation &&
              user?.status === 'ACTIVE' &&
              user.emailVerifiedAt === null &&
              expected.length === parsed.authenticator.length &&
              timingSafeEqual(expected, parsed.authenticator);
            if (!valid) throw invalidOrExpiredToken();
            const consumed = await tx.accountToken.updateMany({
              where: { id: token.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
              data: { consumedAt: now },
            });
            const verified = await tx.user.updateMany({
              where: { id: token.userId, status: 'ACTIVE', emailVerifiedAt: null },
              data: { emailVerifiedAt: now },
            });
            if (consumed.count !== 1 || verified.count !== 1) throw invalidOrExpiredToken();
            await tx.accountToken.updateMany({
              where: {
                userId: token.userId,
                purpose: 'EMAIL_VERIFICATION',
                generation: { lt: token.generation },
                consumedAt: null,
                revokedAt: null,
              },
              data: { revokedAt: now, revocationReasonCode: 'SUPERSEDED' },
            });
            await tx.auditEvent.create({
              data: {
                actorType: 'ANONYMOUS',
                action: 'EMAIL_VERIFIED',
                resourceType: 'USER',
                resourceId: token.userId,
                previousState: 'ACTIVE_UNVERIFIED',
                newState: 'ACTIVE_VERIFIED',
                metadata: { purpose: 'EMAIL_VERIFICATION', generation: token.generation },
                requestId,
                correlationId: requestId,
                occurredAt: now,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw securityDependencyUnavailable();
    }
  }

  async login(
    body: LoginBody,
    ip: string,
    requestId?: string,
  ): Promise<{ cookie: string; view: SessionView }> {
    await this.rateLimits.consume([
      { action: 'LOGIN', dimension: 'EMAIL', value: body.email, policy: 'LOGIN_EMAIL' },
      { action: 'LOGIN', dimension: 'IP', value: ip, policy: 'LOGIN_IP' },
      {
        action: 'LOGIN',
        dimension: 'EMAIL_IP',
        value: `${body.email}\0${ip}`,
        policy: 'LOGIN_EMAIL_IP',
      },
    ]);
    let user;
    try {
      user = await this.database.prisma.user.findUnique({
        where: { email: body.email },
        include: { passwordCredential: true },
      });
    } catch {
      throw securityDependencyUnavailable();
    }
    const passwordResult = await this.passwords.verifyForLogin(
      body.password,
      user?.passwordCredential?.passwordHash,
    );
    const candidateHash = passwordResult.candidateHash;
    if (
      !passwordResult.valid ||
      !user?.passwordCredential ||
      user.status !== 'ACTIVE' ||
      user.emailVerifiedAt === null
    ) {
      throw invalidCredentials();
    }
    const replacementHash = passwordResult.needsRehash
      ? await this.passwords.hash(body.password)
      : undefined;
    const sessionToken = createSessionToken();
    const now = this.clock.now();
    const absoluteExpiresAt = addSeconds(now, this.config.sessionAbsoluteTtlSeconds);
    const idleExpiresAt = minimumDate(
      addSeconds(now, this.config.sessionIdleTtlSeconds),
      absoluteExpiresAt,
    );
    let result;
    try {
      result = await this.database.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${user.id}::uuid FOR UPDATE`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT "user_id" FROM "password_credential" WHERE "user_id" = ${user.id}::uuid FOR UPDATE`,
          );
          const current = await tx.user.findUnique({
            where: { id: user.id },
            include: { passwordCredential: true },
          });
          if (
            current?.status !== 'ACTIVE' ||
            current.emailVerifiedAt === null ||
            current.passwordCredential?.passwordHash !== candidateHash
          )
            throw invalidCredentials();
          if (replacementHash) {
            await tx.passwordCredential.update({
              where: { userId: user.id },
              data: { passwordHash: replacementHash, passwordChangedAt: now },
            });
          }
          const keyVersion = this.config.sessionTokenKeys.currentVersion;
          const digest = sessionSecretDigest(
            sessionToken.selector,
            sessionToken.secret,
            keyVersion,
            this.config.sessionTokenKeys,
          );
          if (!digest) throw new Error('Versión de sesión actual desconocida.');
          const session = await tx.session.create({
            data: {
              id: sessionToken.selector,
              secretDigest: new Uint8Array(digest),
              secretKeyVersion: keyVersion,
              userId: current.id,
              issuedSessionVersion: current.sessionVersion,
              createdAt: now,
              lastActivityAt: now,
              idleExpiresAt,
              absoluteExpiresAt,
            },
          });
          await tx.auditEvent.createMany({
            data: [
              {
                actorType: 'USER',
                actorUserId: current.id,
                action: 'USER_LOGGED_IN',
                resourceType: 'USER',
                resourceId: current.id,
                metadata: {},
                requestId,
                correlationId: requestId,
                occurredAt: now,
              },
              {
                actorType: 'USER',
                actorUserId: current.id,
                action: 'SESSION_CREATED',
                resourceType: 'SESSION',
                resourceId: session.id,
                metadata: {},
                requestId,
                correlationId: requestId,
                occurredAt: now,
              },
            ],
          });
          return { current, session };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw securityDependencyUnavailable();
    }
    return {
      cookie: sessionToken.value,
      view: sessionView(
        result.current,
        result.session.id,
        result.session.issuedSessionVersion,
        result.session.idleExpiresAt,
        this.config,
      ),
    };
  }

  async getSession(
    cookie: string | undefined,
    ip: string,
  ): Promise<{ view: SessionView | { authenticated: false }; clearCookie: boolean }> {
    await this.rateLimits.consume([
      { action: 'SESSION_READ', dimension: 'IP', value: ip, policy: 'SESSION_READ_IP' },
    ]);
    if (!cookie) return { view: { authenticated: false }, clearCookie: false };
    const parsed = parseSessionToken(cookie);
    if (!parsed) return { view: { authenticated: false }, clearCookie: true };
    let authenticated;
    try {
      authenticated = await this.database.prisma.$transaction(
        async (tx) => {
          const candidate = await tx.session.findUnique({
            where: { id: parsed.selector },
            select: { userId: true },
          });
          if (!candidate) return undefined;

          // El orden global de bloqueo es user -> session, igual que en login y mutaciones de cuenta.
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${candidate.userId}::uuid FOR UPDATE`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "session" WHERE "id" = ${parsed.selector}::uuid FOR UPDATE`,
          );
          const [databaseClock] = await tx.$queryRaw<Array<{ currentTime: Date }>>(
            Prisma.sql`SELECT clock_timestamp() AS "currentTime"`,
          );
          const now = databaseClock?.currentTime;
          if (!(now instanceof Date)) throw new Error('Reloj PostgreSQL no disponible.');
          const session = await tx.session.findUnique({
            where: { id: parsed.selector },
            include: { user: true },
          });
          if (
            !session ||
            session.userId !== candidate.userId ||
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
            return undefined;

          let expiresAt = session.idleExpiresAt;
          const writeThreshold = addSeconds(now, -this.config.sessionLastSeenWriteIntervalSeconds);
          if (session.lastActivityAt <= writeThreshold) {
            expiresAt = minimumDate(
              addSeconds(now, this.config.sessionIdleTtlSeconds),
              session.absoluteExpiresAt,
            );
            const refreshed = await tx.session.updateMany({
              where: {
                id: session.id,
                revokedAt: null,
                idleExpiresAt: { gt: now },
                absoluteExpiresAt: { gt: now },
                issuedSessionVersion: session.user.sessionVersion,
              },
              data: { lastActivityAt: now, idleExpiresAt: expiresAt },
            });
            if (refreshed.count !== 1) return undefined;
          }
          return sessionView(
            session.user,
            session.id,
            session.issuedSessionVersion,
            expiresAt,
            this.config,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationFailure(error))
        return { view: { authenticated: false }, clearCookie: true };
      throw securityDependencyUnavailable();
    }
    if (!authenticated) return { view: { authenticated: false }, clearCookie: true };
    return {
      view: authenticated,
      clearCookie: false,
    };
  }
}

function sessionView(
  user: {
    id: string;
    email: string;
    displayName: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  },
  sessionId: string,
  issuedSessionVersion: number,
  expiresAt: Date,
  config: AuthConfig,
): SessionView {
  if (user.status !== 'ACTIVE') throw invalidCredentials();
  return {
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: 'ACTIVE',
      emailVerified: true,
    },
    capabilities: [],
    session: { expiresAt: expiresAt.toISOString() },
    csrfToken: deriveCsrfToken(sessionId, issuedSessionVersion, config.csrfKeys),
  };
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function minimumDate(left: Date, right: Date): Date {
  return left <= right ? left : right;
}

function isUserEmailUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes('email');
}
