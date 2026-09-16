import { Inject, Injectable } from '@nestjs/common';
import type { AuthConfig } from '@benhouse/config';
import { Prisma } from '@benhouse/database';
import type { Prisma as PrismaTypes } from '@benhouse/database';
import { DatabaseService } from '../infrastructure/database/database.service';
import { AUTH_CONFIG } from './auth.config';
import {
  authenticationRequired,
  csrfInvalid,
  csrfRequired,
  securityDependencyUnavailable,
} from './auth.errors';
import { verifyCsrfToken } from './csrf';
import { parseSessionToken, verifySessionSecret } from './session-token';

export type AuthenticatedSession = {
  userId: string;
  sessionId: string;
  issuedSessionVersion: number;
  parsed: NonNullable<ReturnType<typeof parseSessionToken>>;
};

@Injectable()
export class SessionAuthorizationService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async authenticate(
    cookie: string | undefined,
    csrfToken?: string,
    requireCsrf = false,
  ): Promise<AuthenticatedSession> {
    const parsed = cookie ? parseSessionToken(cookie) : undefined;
    if (!parsed) throw authenticationRequired();
    try {
      const session = await this.database.prisma.session.findUnique({
        where: { id: parsed.selector },
        include: { user: true },
      });
      const now = new Date();
      if (!session || !validSession(session, parsed, now, this.config)) {
        throw authenticationRequired();
      }
      if (requireCsrf)
        validateCsrf(csrfToken, session.id, session.issuedSessionVersion, this.config);
      return {
        userId: session.userId,
        sessionId: session.id,
        issuedSessionVersion: session.issuedSessionVersion,
        parsed,
      };
    } catch (error) {
      if (isAuthorizationError(error)) throw error;
      throw securityDependencyUnavailable();
    }
  }

  async revalidate(
    tx: PrismaTypes.TransactionClient,
    candidate: AuthenticatedSession,
    csrfToken?: string,
    requireCsrf = false,
  ): Promise<UserAuthorizationRecord> {
    const [session, clock] = await Promise.all([
      tx.session.findUnique({ where: { id: candidate.sessionId }, include: { user: true } }),
      tx.$queryRaw<Array<{ currentTime: Date }>>(
        Prisma.sql`SELECT clock_timestamp() AS "currentTime"`,
      ),
    ]);
    const now = clock[0]?.currentTime;
    if (
      !(now instanceof Date) ||
      !session ||
      session.userId !== candidate.userId ||
      session.issuedSessionVersion !== candidate.issuedSessionVersion ||
      !validSession(session, candidate.parsed, now, this.config)
    ) {
      throw authenticationRequired();
    }
    if (requireCsrf) validateCsrf(csrfToken, session.id, session.issuedSessionVersion, this.config);
    return {
      id: session.user.id,
      status: session.user.status,
      emailVerifiedAt: session.user.emailVerifiedAt,
    };
  }

  async lockAndRevalidate(
    tx: PrismaTypes.TransactionClient,
    candidate: AuthenticatedSession,
    csrfToken?: string,
    requireCsrf = false,
  ): Promise<UserAuthorizationRecord> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${candidate.userId}::uuid FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "session" WHERE "id" = ${candidate.sessionId}::uuid FOR UPDATE`,
    );
    return this.revalidate(tx, candidate, csrfToken, requireCsrf);
  }
}

type UserAuthorizationRecord = {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  emailVerifiedAt: Date | null;
};

function validSession(
  session: {
    id: string;
    userId: string;
    secretDigest: Uint8Array;
    secretKeyVersion: number;
    issuedSessionVersion: number;
    revokedAt: Date | null;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    user: UserAuthorizationRecord & { sessionVersion: number };
  },
  parsed: NonNullable<ReturnType<typeof parseSessionToken>>,
  now: Date,
  config: AuthConfig,
): boolean {
  return (
    verifySessionSecret(
      parsed.selector,
      parsed.secret,
      Buffer.from(session.secretDigest),
      session.secretKeyVersion,
      config.sessionTokenKeys,
    ) &&
    session.revokedAt === null &&
    session.idleExpiresAt > now &&
    session.absoluteExpiresAt > now &&
    session.issuedSessionVersion === session.user.sessionVersion &&
    session.user.status === 'ACTIVE' &&
    session.user.emailVerifiedAt !== null
  );
}

function validateCsrf(
  token: string | undefined,
  sessionId: string,
  version: number,
  config: AuthConfig,
): void {
  if (!token) throw csrfRequired();
  if (!verifyCsrfToken(token, sessionId, version, config.csrfKeys)) throw csrfInvalid();
}

function isAuthorizationError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['AUTHENTICATION_REQUIRED', 'CSRF_REQUIRED', 'CSRF_INVALID'].includes(
      String((error as { code: unknown }).code),
    ),
  );
}
