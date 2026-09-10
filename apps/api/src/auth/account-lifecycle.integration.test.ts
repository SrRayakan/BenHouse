import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';
import { AppModule } from '../app.module';
import { configureApplication } from '../main';
import { DatabaseService } from '../infrastructure/database/database.service';
import { serializeAccountToken } from './account-token';
import { deriveCsrfToken } from './csrf';
import { hashPassword, verifyPassword } from './password';
import { PASSWORD_ENGINE, PasswordEngine } from './password';
import { createSessionToken, sessionSecretDigest } from './session-token';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AuthRateLimitService } from './rate-limit.service';
import { hmacSha256 } from './crypto-encoding';

type ApiResponse = { status: number; body: unknown; headers: Headers };
const b13RateLimitActions = [
  'RESEND_VERIFICATION',
  'FORGOT_PASSWORD',
  'RESET_PASSWORD',
  'LOGOUT_ALL',
  'CHANGE_PASSWORD',
] as const;

describe('B1.3 Account Lifecycle HTTP y PostgreSQL', () => {
  let app: NestExpressApplication;
  let database: DatabaseService;
  let baseUrl: string;
  const suite = randomUUID();
  const originalPassword = 'Contraseña original de B1.3 🔐';

  beforeAll(async () => {
    loadLocalEnvironmentFile();
    const config = readAppConfig();
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
      bodyParser: false,
    });
    configureApplication(app, config);
    database = app.get(DatabaseService);
    await database.prisma.authRateLimit.deleteMany({
      where: { action: { in: [...b13RateLimitActions] } },
    });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Puerto de test no disponible.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await database?.prisma.authRateLimit.deleteMany({
      where: { action: { in: [...b13RateLimitActions] } },
    });
    await app?.close();
  });

  async function request(
    path: string,
    options: {
      body?: unknown;
      origin?: string | null;
      cookie?: string;
      csrf?: string;
      requestId?: string;
      method?: 'GET' | 'POST';
    } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.origin !== null) headers.origin = options.origin ?? 'http://localhost:3000';
    if (options.cookie) headers.cookie = options.cookie;
    if (options.csrf) headers['x-csrf-token'] = options.csrf;
    if (options.requestId) headers['x-request-id'] = options.requestId;
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      headers: response.headers,
    };
  }

  async function createAccount(
    label: string,
    options: {
      verified?: boolean;
      status?: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
      credential?: boolean;
    } = {},
  ) {
    const config = readAppConfig();
    const now = new Date();
    return database.prisma.user.create({
      data: {
        email: `${label}-${suite}@example.test`,
        displayName: `Cuenta ${label}`,
        status: options.status ?? 'ACTIVE',
        emailVerifiedAt: options.verified === false ? null : now,
        ...(options.credential === false
          ? {}
          : {
              passwordCredential: {
                create: {
                  passwordHash: await hashPassword(originalPassword, config.auth.argon2),
                  passwordChangedAt: now,
                  createdAt: now,
                },
              },
            }),
      },
      include: { passwordCredential: true },
    });
  }

  async function createSession(userId: string, issuedSessionVersion: number) {
    const config = readAppConfig();
    const token = createSessionToken();
    const digest = sessionSecretDigest(
      token.selector,
      token.secret,
      config.auth.sessionTokenKeys.currentVersion,
      config.auth.sessionTokenKeys,
    )!;
    const now = new Date();
    await database.prisma.session.create({
      data: {
        id: token.selector,
        secretDigest: new Uint8Array(digest),
        secretKeyVersion: config.auth.sessionTokenKeys.currentVersion,
        userId,
        issuedSessionVersion,
        createdAt: now,
        lastActivityAt: now,
        idleExpiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 120_000),
      },
    });
    return {
      id: token.selector,
      cookie: `benhouse-local-session=${token.value}`,
      csrf: deriveCsrfToken(token.selector, issuedSessionVersion, config.auth.csrfKeys),
    };
  }

  async function externalToken(userId: string, purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET') {
    const config = readAppConfig();
    const token = await database.prisma.accountToken.findFirstOrThrow({
      where: { userId, purpose },
      orderBy: { generation: 'desc' },
    });
    return serializeAccountToken(
      {
        id: token.id,
        purpose,
        generation: token.generation,
        subjectType: 'USER',
        subjectId: userId,
        keyVersion: token.keyVersion,
      },
      config.auth.accountTokenKeys,
    );
  }

  function sessionCookieValue(cookie: string): string {
    return cookie.slice(cookie.indexOf('=') + 1);
  }

  function p2034() {
    return { code: 'P2034' };
  }

  function sqlState(code: string) {
    return { cause: { meta: { code } } };
  }

  function expectExpiredSessionCookie(header: string | null): void {
    const cookie = header ?? '';
    expect(cookie).toMatch(/^benhouse-local-session=;/);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toMatch(/;\s*Secure(?:;|$)/i);
    const expires = cookie.match(/Expires=([^;]+)/i)?.[1];
    expect(expires).toBeDefined();
    expect(new Date(expires!).getTime()).toBeLessThan(Date.now());
  }

  it('rechaza Origin, CSRF y campos no permitidos antes de mutar', async () => {
    const user = await createAccount('guards');
    const session = await createSession(user.id, user.sessionVersion);
    const baseline = await database.prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(
      (await request('/auth/logout', { body: {}, cookie: session.cookie, origin: null })).body,
    ).toMatchObject({ error: { code: 'ORIGIN_REQUIRED' } });
    expect(
      (
        await request('/auth/logout', {
          body: {},
          cookie: session.cookie,
          origin: 'null',
        })
      ).body,
    ).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    expect(
      (
        await request('/auth/logout', {
          body: {},
          cookie: session.cookie,
          origin: 'https://origen-invalido.example',
        })
      ).body,
    ).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    expect(
      (await request('/auth/logout', { body: {}, cookie: session.cookie })).body,
    ).toMatchObject({ error: { code: 'CSRF_REQUIRED' } });
    expect(
      (
        await request('/auth/logout', {
          body: {},
          cookie: session.cookie,
          csrf: '1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        })
      ).body,
    ).toMatchObject({ error: { code: 'CSRF_INVALID' } });
    const config = readAppConfig().auth;
    const wrongVersionCsrf = deriveCsrfToken(session.id, user.sessionVersion + 1, config.csrfKeys);
    expect(
      (
        await request('/auth/logout', {
          body: {},
          cookie: session.cookie,
          csrf: wrongVersionCsrf,
        })
      ).body,
    ).toMatchObject({ error: { code: 'CSRF_INVALID' } });
    expect(
      (
        await request('/auth/logout', {
          body: { userId: user.id },
          cookie: session.cookie,
          csrf: session.csrf,
        })
      ).status,
    ).toBe(400);
    expect(await database.prisma.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(
      baseline,
    );
  });

  it('logout revoca solo la sesión actual, audita y elimina la cookie', async () => {
    const user = await createAccount('logout');
    const current = await createSession(user.id, user.sessionVersion);
    const other = await createSession(user.id, user.sessionVersion);
    const response = await request('/auth/logout', {
      body: {},
      cookie: current.cookie,
      csrf: current.csrf,
      requestId: `logout-${suite}`,
    });
    expect(response.status).toBe(204);
    expectExpiredSessionCookie(response.headers.get('set-cookie'));
    expect(
      await database.prisma.session.findUniqueOrThrow({ where: { id: current.id } }),
    ).toMatchObject({ revocationReason: 'LOGOUT' });
    expect(
      await database.prisma.session.findUniqueOrThrow({ where: { id: other.id } }),
    ).toMatchObject({ revokedAt: null });
    expect(
      await database.prisma.auditEvent.count({
        where: { action: 'SESSION_REVOKED', resourceId: current.id },
      }),
    ).toBe(1);
  });

  it('logout reintenta un conflicto transitorio y no traduce conflictos agotados a 401', async () => {
    const lifecycle = app.get(AccountLifecycleService);
    const transientUser = await createAccount('logout-retry');
    const transientSession = await createSession(transientUser.id, transientUser.sessionVersion);
    const transaction = database.prisma.$transaction.bind(database.prisma);
    const transientSpy = vi.spyOn(database.prisma, '$transaction');
    transientSpy.mockRejectedValueOnce(p2034() as never).mockImplementation(transaction);
    try {
      await expect(
        lifecycle.logout(
          sessionCookieValue(transientSession.cookie),
          transientSession.csrf,
          `logout-retry-${suite}`,
        ),
      ).resolves.toBeUndefined();
      expect(transientSpy).toHaveBeenCalledTimes(2);
      expect(
        await database.prisma.auditEvent.count({
          where: { action: 'SESSION_REVOKED', resourceId: transientSession.id },
        }),
      ).toBe(1);
    } finally {
      transientSpy.mockRestore();
    }

    const persistentUser = await createAccount('logout-persistent');
    const persistentSession = await createSession(persistentUser.id, persistentUser.sessionVersion);
    const persistentSpy = vi
      .spyOn(database.prisma, '$transaction')
      .mockRejectedValue(sqlState('40001') as never);
    try {
      await expect(
        lifecycle.logout(
          sessionCookieValue(persistentSession.cookie),
          persistentSession.csrf,
          `logout-persistent-${suite}`,
        ),
      ).rejects.toMatchObject({ status: 503, code: 'SECURITY_DEPENDENCY_UNAVAILABLE' });
      expect(persistentSpy).toHaveBeenCalledTimes(3);
      expect(
        await database.prisma.session.findUniqueOrThrow({ where: { id: persistentSession.id } }),
      ).toMatchObject({ revokedAt: null });
    } finally {
      persistentSpy.mockRestore();
    }
  });

  it('logout-all incrementa versión y revoca físicamente todas las sesiones', async () => {
    const user = await createAccount('logout-all');
    const first = await createSession(user.id, user.sessionVersion);
    await createSession(user.id, user.sessionVersion);
    const response = await request('/auth/logout-all', {
      body: {},
      cookie: first.cookie,
      csrf: first.csrf,
      requestId: `logout-all-${suite}`,
    });
    expect(response.status).toBe(204);
    expectExpiredSessionCookie(response.headers.get('set-cookie'));
    expect(
      (await database.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion,
    ).toBe(user.sessionVersion + 1);
    const sessions = await database.prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revocationReason === 'LOGOUT_ALL')).toBe(true);
  });

  it('logout-all reintenta y confirma un único incremento de sessionVersion', async () => {
    const user = await createAccount('logout-all-retry');
    const session = await createSession(user.id, user.sessionVersion);
    const lifecycle = app.get(AccountLifecycleService);
    const limiter = app.get(AuthRateLimitService);
    const consumeSpy = vi.spyOn(limiter, 'consume').mockResolvedValue(undefined);
    const transaction = database.prisma.$transaction.bind(database.prisma);
    const transactionSpy = vi.spyOn(database.prisma, '$transaction');
    transactionSpy.mockRejectedValueOnce(p2034() as never).mockImplementation(transaction);
    try {
      await lifecycle.logoutAll(
        sessionCookieValue(session.cookie),
        session.csrf,
        `logout-all-retry-${suite}`,
        `logout-all-retry-${suite}`,
      );
      expect(transactionSpy).toHaveBeenCalledTimes(2);
      expect(
        (await database.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion,
      ).toBe(user.sessionVersion + 1);
      expect(
        await database.prisma.auditEvent.count({
          where: { action: 'ALL_SESSIONS_REVOKED', resourceId: user.id },
        }),
      ).toBe(1);
    } finally {
      transactionSpy.mockRestore();
      consumeSpy.mockRestore();
    }
  });

  it.each(['logout-all', 'change-password'] as const)(
    '%s devuelve 503 tras agotar los reintentos serializables sin efectos parciales',
    async (action) => {
      const user = await createAccount(`persistent-${action}`);
      const session = await createSession(user.id, user.sessionVersion);
      const beforeCredential = await database.prisma.passwordCredential.findUniqueOrThrow({
        where: { userId: user.id },
      });
      const lifecycle = app.get(AccountLifecycleService);
      const limiter = app.get(AuthRateLimitService);
      const consumeSpy = vi.spyOn(limiter, 'consume').mockResolvedValue(undefined);
      const transactionSpy = vi
        .spyOn(database.prisma, '$transaction')
        .mockRejectedValue(sqlState('40001') as never);
      try {
        const operation =
          action === 'logout-all'
            ? lifecycle.logoutAll(
                sessionCookieValue(session.cookie),
                session.csrf,
                `persistent-${action}-${suite}`,
                `persistent-${action}-${suite}`,
              )
            : lifecycle.changePassword(
                {
                  currentPassword: originalPassword,
                  newPassword: 'Contraseña que no debe persistir 🔐',
                },
                sessionCookieValue(session.cookie),
                session.csrf,
                `persistent-${action}-${suite}`,
                `persistent-${action}-${suite}`,
              );
        await expect(operation).rejects.toMatchObject({
          status: 503,
          code: 'SECURITY_DEPENDENCY_UNAVAILABLE',
        });
        expect(transactionSpy).toHaveBeenCalledTimes(3);
        expect(
          await database.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
        ).toMatchObject({ sessionVersion: user.sessionVersion });
        expect(
          await database.prisma.session.findUniqueOrThrow({ where: { id: session.id } }),
        ).toMatchObject({ revokedAt: null });
        expect(
          await database.prisma.passwordCredential.findUniqueOrThrow({
            where: { userId: user.id },
          }),
        ).toEqual(beforeCredential);
      } finally {
        transactionSpy.mockRestore();
        consumeSpy.mockRestore();
      }
    },
  );

  it('resend es neutral y solo genera para ACTIVE no verificada con generación monotónica', async () => {
    const eligible = await createAccount('resend-eligible', { verified: false });
    const verified = await createAccount('resend-verified');
    const suspended = await createAccount('resend-suspended', {
      verified: false,
      status: 'SUSPENDED',
    });
    const deactivated = await createAccount('resend-deactivated', {
      verified: false,
      status: 'DEACTIVATED',
    });
    const bodies = await Promise.all([
      request('/auth/resend-verification', { body: { email: eligible.email } }),
      request('/auth/resend-verification', { body: { email: verified.email } }),
      request('/auth/resend-verification', { body: { email: suspended.email } }),
      request('/auth/resend-verification', { body: { email: deactivated.email } }),
      request('/auth/resend-verification', {
        body: { email: `absent-${suite}@example.test` },
      }),
    ]);
    expect(new Set(bodies.map(({ status }) => status))).toEqual(new Set([202]));
    expect(new Set(bodies.map(({ body }) => JSON.stringify(body))).size).toBe(1);
    expect(new Set(bodies.map(({ headers }) => headers.get('content-type'))).size).toBe(1);
    expect(await database.prisma.accountToken.count({ where: { userId: eligible.id } })).toBe(1);
    expect(await database.prisma.accountToken.count({ where: { userId: verified.id } })).toBe(0);
    expect(await database.prisma.accountToken.count({ where: { userId: suspended.id } })).toBe(0);
    expect(await database.prisma.accountToken.count({ where: { userId: deactivated.id } })).toBe(0);
    await request('/auth/resend-verification', { body: { email: eligible.email } });
    const tokens = await database.prisma.accountToken.findMany({
      where: { userId: eligible.id },
      orderBy: { generation: 'asc' },
      include: { outboxEvents: true },
    });
    expect(tokens.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(tokens[0]).toMatchObject({ revocationReasonCode: 'SUPERSEDED' });
    expect(tokens[0]?.outboxEvents[0]).toMatchObject({ status: 'OBSOLETE' });
    expect(tokens[1]?.outboxEvents[0]).toMatchObject({ status: 'PENDING' });
  });

  it('serializa dos resend-verification concurrentes con generaciones y efectos únicos', async () => {
    const user = await createAccount('resend-concurrent', { verified: false });
    const transaction = database.prisma.$transaction.bind(database.prisma);
    const failures: Array<{
      code?: unknown;
      metaCode?: unknown;
      metaTarget?: unknown;
      causeCode?: unknown;
    }> = [];
    const transactionSpy = vi
      .spyOn(database.prisma, '$transaction')
      .mockImplementation(async (...args) => {
        try {
          return await transaction(...args);
        } catch (error) {
          const candidate = error as {
            code?: unknown;
            meta?: { code?: unknown; target?: unknown };
            cause?: { code?: unknown };
          };
          failures.push({
            code: candidate.code,
            metaCode: candidate.meta?.code,
            metaTarget: candidate.meta?.target,
            causeCode: candidate.cause?.code,
          });
          throw error;
        }
      });
    let responses: ApiResponse[];
    try {
      responses = await Promise.all([
        request('/auth/resend-verification', {
          body: { email: user.email },
          requestId: `resend-concurrent-a-${suite}`,
        }),
        request('/auth/resend-verification', {
          body: { email: user.email },
          requestId: `resend-concurrent-b-${suite}`,
        }),
      ]);
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      responses!.map(({ status }) => status),
      JSON.stringify(failures),
    ).toEqual([202, 202]);
    const tokens = await database.prisma.accountToken.findMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION' },
      orderBy: { generation: 'asc' },
      include: { outboxEvents: true },
    });
    expect(tokens.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(tokens[0]).toMatchObject({ revocationReasonCode: 'SUPERSEDED' });
    expect(tokens[0]?.outboxEvents).toHaveLength(1);
    expect(tokens[1]?.outboxEvents).toHaveLength(1);
    expect(
      await database.prisma.auditEvent.count({
        where: { action: 'VERIFICATION_RESENT', resourceId: user.id },
      }),
    ).toBe(2);
  });

  it('resend devuelve 503 tras tres conflictos persistentes del índice de generación', async () => {
    const user = await createAccount('resend-p2002-persistent', { verified: false });
    const lifecycle = app.get(AccountLifecycleService);
    const limiter = app.get(AuthRateLimitService);
    const consumeSpy = vi.spyOn(limiter, 'consume').mockResolvedValue(undefined);
    const transactionSpy = vi.spyOn(database.prisma, '$transaction').mockRejectedValue({
      code: 'P2002',
      meta: {
        modelName: 'AccountToken',
        target: ['purpose', 'user_id', 'generation'],
      },
    } as never);
    try {
      await expect(
        lifecycle.resendVerification(
          { email: user.email },
          `resend-p2002-persistent-${suite}`,
          `resend-p2002-persistent-${suite}`,
        ),
      ).rejects.toMatchObject({ status: 503, code: 'SECURITY_DEPENDENCY_UNAVAILABLE' });
      expect(transactionSpy).toHaveBeenCalledTimes(3);
      expect(
        await database.prisma.accountToken.count({
          where: { userId: user.id, purpose: 'EMAIL_VERIFICATION' },
        }),
      ).toBe(0);
      expect(
        await database.prisma.auditEvent.count({
          where: { action: 'VERIFICATION_RESENT', resourceId: user.id },
        }),
      ).toBe(0);
    } finally {
      transactionSpy.mockRestore();
      consumeSpy.mockRestore();
    }
  });

  it('forgot es neutral y reset consume una sola vez, cambia PHC y revoca sesiones', async () => {
    const eligible = await createAccount('forgot');
    const unverified = await createAccount('forgot-unverified', { verified: false });
    const suspended = await createAccount('forgot-suspended', { status: 'SUSPENDED' });
    const deactivated = await createAccount('forgot-deactivated', { status: 'DEACTIVATED' });
    const noCredential = await createAccount('forgot-no-credential', { credential: false });
    const requests = await Promise.all([
      request('/auth/forgot-password', { body: { email: eligible.email } }),
      request('/auth/forgot-password', { body: { email: unverified.email } }),
      request('/auth/forgot-password', { body: { email: suspended.email } }),
      request('/auth/forgot-password', { body: { email: deactivated.email } }),
      request('/auth/forgot-password', { body: { email: noCredential.email } }),
      request('/auth/forgot-password', { body: { email: `missing-${suite}@example.test` } }),
    ]);
    expect(requests.every(({ status }) => status === 202)).toBe(true);
    expect(new Set(requests.map(({ body }) => JSON.stringify(body))).size).toBe(1);
    expect(new Set(requests.map(({ headers }) => headers.get('content-type'))).size).toBe(1);
    expect(await database.prisma.accountToken.count({ where: { userId: unverified.id } })).toBe(0);
    expect(await database.prisma.accountToken.count({ where: { userId: suspended.id } })).toBe(0);
    expect(await database.prisma.accountToken.count({ where: { userId: deactivated.id } })).toBe(0);
    expect(await database.prisma.accountToken.count({ where: { userId: noCredential.id } })).toBe(
      0,
    );
    const token = await externalToken(eligible.id, 'PASSWORD_RESET');
    await createSession(eligible.id, eligible.sessionVersion);
    await createSession(eligible.id, eligible.sessionVersion);
    const newPassword = 'Contraseña restablecida de B1.3 ✅';
    const results = await Promise.all([
      request('/auth/reset-password', { body: { token, password: newPassword } }),
      request('/auth/reset-password', { body: { token, password: newPassword } }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([204, 400]);
    const current = await database.prisma.user.findUniqueOrThrow({
      where: { id: eligible.id },
      include: { passwordCredential: true, sessions: true },
    });
    expect(current.sessionVersion).toBe(eligible.sessionVersion + 1);
    expect(current.sessions.every((session) => session.revocationReason === 'PASSWORD_RESET')).toBe(
      true,
    );
    expect(current.passwordCredential?.passwordChangedAt.getTime()).toBeGreaterThan(
      eligible.passwordCredential!.passwordChangedAt.getTime(),
    );
    await expect(
      verifyPassword(newPassword, current.passwordCredential!.passwordHash),
    ).resolves.toMatchObject({ valid: true });
    expect(
      JSON.stringify(
        await database.prisma.auditEvent.findMany({ where: { resourceId: eligible.id } }),
      ),
    ).not.toContain(newPassword);
  });

  it('reintenta P2034 en reset, reutiliza Argon2 y confirma los efectos una sola vez', async () => {
    const user = await createAccount('reset-p2034');
    await request('/auth/forgot-password', { body: { email: user.email } });
    const token = await externalToken(user.id, 'PASSWORD_RESET');
    const lifecycle = app.get(AccountLifecycleService);
    const limiter = app.get(AuthRateLimitService);
    const engine = app.get<PasswordEngine>(PASSWORD_ENGINE);
    const consumeSpy = vi.spyOn(limiter, 'consume').mockResolvedValue(undefined);
    const hashSpy = vi.spyOn(engine, 'hash');
    const transaction = database.prisma.$transaction.bind(database.prisma);
    const transactionSpy = vi.spyOn(database.prisma, '$transaction');
    transactionSpy.mockRejectedValueOnce(p2034() as never).mockImplementation(transaction);
    try {
      await expect(
        lifecycle.resetPassword(
          { token, password: 'Contraseña retry P2034 válida 🔐' },
          `reset-p2034-${suite}`,
          `reset-p2034-${suite}`,
        ),
      ).resolves.toBeUndefined();
      expect(hashSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy).toHaveBeenCalledTimes(2);
      expect(
        await database.prisma.auditEvent.count({
          where: { action: 'PASSWORD_RESET', resourceId: user.id },
        }),
      ).toBe(1);
    } finally {
      transactionSpy.mockRestore();
      hashSpy.mockRestore();
      consumeSpy.mockRestore();
    }
  });

  it('tras 40001 revalida el token consumido y devuelve el error neutral', async () => {
    const user = await createAccount('reset-40001-consumed');
    await request('/auth/forgot-password', { body: { email: user.email } });
    const external = await externalToken(user.id, 'PASSWORD_RESET');
    const stored = await database.prisma.accountToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'PASSWORD_RESET' },
    });
    const lifecycle = app.get(AccountLifecycleService);
    const limiter = app.get(AuthRateLimitService);
    const consumeSpy = vi.spyOn(limiter, 'consume').mockResolvedValue(undefined);
    const transaction = database.prisma.$transaction.bind(database.prisma);
    const transactionSpy = vi.spyOn(database.prisma, '$transaction');
    transactionSpy
      .mockImplementationOnce(async () => {
        await database.prisma.accountToken.update({
          where: { id: stored.id },
          data: { consumedAt: new Date() },
        });
        throw sqlState('40001');
      })
      .mockImplementation(transaction);
    try {
      await expect(
        lifecycle.resetPassword(
          { token: external, password: 'Contraseña retry consumido válida 🔐' },
          `reset-consumed-${suite}`,
        ),
      ).rejects.toMatchObject({ status: 400, code: 'INVALID_OR_EXPIRED_TOKEN' });
      expect(transactionSpy).toHaveBeenCalledTimes(2);
      expect(
        await database.prisma.auditEvent.count({
          where: { action: 'PASSWORD_RESET', resourceId: user.id },
        }),
      ).toBe(0);
    } finally {
      transactionSpy.mockRestore();
      consumeSpy.mockRestore();
    }
  });

  it.each([
    ['conflictos persistentes', 'serialization', sqlState('40001')],
    ['conexión', 'connection', { code: 'P1001' }],
    ['SQLSTATE distinto', 'syntax', sqlState('42601')],
  ] as const)('reset devuelve 503 ante %s sin efectos parciales', async (_case, id, failure) => {
    const user = await createAccount(`reset-503-${id}`);
    await request('/auth/forgot-password', { body: { email: user.email } });
    const external = await externalToken(user.id, 'PASSWORD_RESET');
    const before = await database.prisma.passwordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    const lifecycle = app.get(AccountLifecycleService);
    const limiter = app.get(AuthRateLimitService);
    const consumeSpy = vi.spyOn(limiter, 'consume').mockResolvedValue(undefined);
    const transactionSpy = vi
      .spyOn(database.prisma, '$transaction')
      .mockRejectedValue(failure as never);
    try {
      await expect(
        lifecycle.resetPassword(
          { token: external, password: 'Contraseña error operacional válida 🔐' },
          `reset-503-${suite}`,
        ),
      ).rejects.toMatchObject({ status: 503, code: 'SECURITY_DEPENDENCY_UNAVAILABLE' });
      expect(transactionSpy).toHaveBeenCalledTimes(_case === 'conflictos persistentes' ? 3 : 1);
      expect(
        await database.prisma.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } }),
      ).toEqual(before);
      expect(
        await database.prisma.auditEvent.count({
          where: { action: 'PASSWORD_RESET', resourceId: user.id },
        }),
      ).toBe(0);
    } finally {
      transactionSpy.mockRestore();
      consumeSpy.mockRestore();
    }
  });

  it('change-password revalida credencial, revoca todo y neutraliza la actual incorrecta', async () => {
    const user = await createAccount('change');
    const current = await createSession(user.id, user.sessionVersion);
    const other = await createSession(user.id, user.sessionVersion);
    const wrong = await request('/auth/change-password', {
      body: {
        currentPassword: `${originalPassword}!`,
        newPassword: 'Contraseña nueva válida 123 🔑',
      },
      cookie: current.cookie,
      csrf: current.csrf,
    });
    expect(wrong).toMatchObject({ status: 401, body: { error: { code: 'INVALID_CREDENTIALS' } } });
    const cross = await request('/auth/change-password', {
      body: { currentPassword: originalPassword, newPassword: 'Contraseña nueva válida 123 🔑' },
      cookie: current.cookie,
      csrf: other.csrf,
    });
    expect(cross).toMatchObject({ status: 403, body: { error: { code: 'CSRF_INVALID' } } });
    const changed = await request('/auth/change-password', {
      body: { currentPassword: originalPassword, newPassword: 'Contraseña nueva válida 123 🔑' },
      cookie: current.cookie,
      csrf: current.csrf,
      requestId: `change-${suite}`,
    });
    expect(changed.status).toBe(204);
    expectExpiredSessionCookie(changed.headers.get('set-cookie'));
    const persisted = await database.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { sessions: true },
    });
    expect(persisted.sessionVersion).toBe(user.sessionVersion + 1);
    expect(
      persisted.sessions.every((session) => session.revocationReason === 'PASSWORD_CHANGE'),
    ).toBe(true);
  });

  it('change-password reintenta sin repetir Argon2 y confirma una sola vez', async () => {
    const user = await createAccount('change-retry');
    const session = await createSession(user.id, user.sessionVersion);
    const lifecycle = app.get(AccountLifecycleService);
    const limiter = app.get(AuthRateLimitService);
    const engine = app.get<PasswordEngine>(PASSWORD_ENGINE);
    const consumeSpy = vi.spyOn(limiter, 'consume').mockResolvedValue(undefined);
    const verifySpy = vi.spyOn(engine, 'verifyForLogin');
    const hashSpy = vi.spyOn(engine, 'hash');
    const transaction = database.prisma.$transaction.bind(database.prisma);
    const transactionSpy = vi.spyOn(database.prisma, '$transaction');
    transactionSpy.mockRejectedValueOnce(p2034() as never).mockImplementation(transaction);
    try {
      await lifecycle.changePassword(
        {
          currentPassword: originalPassword,
          newPassword: 'Contraseña change retry válida 🔐',
        },
        sessionCookieValue(session.cookie),
        session.csrf,
        `change-retry-${suite}`,
        `change-retry-${suite}`,
      );
      expect(transactionSpy).toHaveBeenCalledTimes(2);
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(hashSpy).toHaveBeenCalledTimes(1);
      expect(
        (await database.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion,
      ).toBe(user.sessionVersion + 1);
      expect(
        await database.prisma.auditEvent.count({
          where: { action: 'PASSWORD_CHANGED', resourceId: user.id },
        }),
      ).toBe(1);
    } finally {
      transactionSpy.mockRestore();
      hashSpy.mockRestore();
      verifySpy.mockRestore();
      consumeSpy.mockRestore();
    }
  });

  it('tokens inválidos, obsoletos y reutilizados comparten el contrato neutral', async () => {
    const user = await createAccount('invalid-reset');
    await request('/auth/forgot-password', { body: { email: user.email } });
    const first = await externalToken(user.id, 'PASSWORD_RESET');
    await request('/auth/forgot-password', { body: { email: user.email } });
    const malformed = 'token-malformado';
    for (const token of [
      first,
      malformed,
      `v1.${randomUUID()}.${randomBytes(32).toString('base64url')}`,
    ]) {
      const response = await request('/auth/reset-password', {
        body: { token, password: 'Contraseña de token inválido 123 🔒' },
      });
      expect(response).toMatchObject({
        status: 400,
        body: { error: { code: 'INVALID_OR_EXPIRED_TOKEN' } },
      });
    }
  });

  it.each(['expired', 'revoked', 'consumed'] as const)(
    'neutraliza token de reset %s',
    async (state) => {
      const user = await createAccount(`reset-${state}`);
      await request('/auth/forgot-password', { body: { email: user.email } });
      const external = await externalToken(user.id, 'PASSWORD_RESET');
      const token = await database.prisma.accountToken.findFirstOrThrow({
        where: { userId: user.id, purpose: 'PASSWORD_RESET' },
      });
      await database.prisma.accountToken.update({
        where: { id: token.id },
        data:
          state === 'expired'
            ? {
                createdAt: new Date(Date.now() - 2_000),
                expiresAt: new Date(Date.now() - 1_000),
              }
            : state === 'revoked'
              ? { revokedAt: new Date(), revocationReasonCode: 'SECURITY_RESPONSE' }
              : { consumedAt: new Date() },
      });
      expect(
        await request('/auth/reset-password', {
          body: { token: external, password: 'Contraseña para token neutralizado 🔒' },
        }),
      ).toMatchObject({
        status: 400,
        body: { error: { code: 'INVALID_OR_EXPIRED_TOKEN' } },
      });
    },
  );

  it('serializa dos change-password y solo una credencial puede ganar', async () => {
    const user = await createAccount('change-race');
    const first = await createSession(user.id, user.sessionVersion);
    const second = await createSession(user.id, user.sessionVersion);
    const responses = await Promise.all([
      request('/auth/change-password', {
        body: { currentPassword: originalPassword, newPassword: 'Primera contraseña carrera 🔐' },
        cookie: first.cookie,
        csrf: first.csrf,
      }),
      request('/auth/change-password', {
        body: { currentPassword: originalPassword, newPassword: 'Segunda contraseña carrera 🔐' },
        cookie: second.cookie,
        csrf: second.csrf,
      }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([204, 401]);
    expect(
      (
        await request('/auth/session', {
          method: 'GET',
          cookie: first.cookie,
          origin: null,
        })
      ).body,
    ).toEqual({ authenticated: false });
    expect(
      (
        await request('/auth/session', {
          method: 'GET',
          cookie: second.cookie,
          origin: null,
        })
      ).body,
    ).toEqual({ authenticated: false });
  });

  it.each(['logout', 'logout-all', 'change-password'] as const)(
    'serializa %s frente a getSession sin reactivar la sesión',
    async (action) => {
      const user = await createAccount(`session-race-${action}`);
      const session = await createSession(user.id, user.sessionVersion);
      const mutation = request(`/auth/${action}`, {
        body:
          action === 'change-password'
            ? { currentPassword: originalPassword, newPassword: `Nueva contraseña ${action} 🔐` }
            : {},
        cookie: session.cookie,
        csrf: session.csrf,
      });
      const concurrentRead = request('/auth/session', {
        method: 'GET',
        cookie: session.cookie,
        origin: null,
      });
      const [mutationResult] = await Promise.all([mutation, concurrentRead]);
      expect(mutationResult.status).toBe(204);
      const finalRead = await request('/auth/session', {
        method: 'GET',
        cookie: session.cookie,
        origin: null,
      });
      expect(finalRead.body).toEqual({ authenticated: false });
      expect(
        (await database.prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt,
      ).toBeInstanceOf(Date);
    },
  );

  it('revalida una generación nueva mientras Argon2 se calcula fuera de la transacción', async () => {
    const user = await createAccount('reset-revoked-during-hash');
    await request('/auth/forgot-password', { body: { email: user.email } });
    const external = await externalToken(user.id, 'PASSWORD_RESET');
    const engine = app.get<PasswordEngine>(PASSWORD_ENGINE);
    const originalHash = engine.hash.bind(engine);
    let announce!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (announce = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(engine, 'hash').mockImplementation(async (password) => {
      announce();
      await gate;
      return originalHash(password);
    });
    try {
      const resetting = request('/auth/reset-password', {
        body: { token: external, password: 'Contraseña tras revocación concurrente 🔒' },
      });
      await started;
      await request('/auth/forgot-password', { body: { email: user.email } });
      release();
      expect(await resetting).toMatchObject({
        status: 400,
        body: { error: { code: 'INVALID_OR_EXPIRED_TOKEN' } },
      });
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('reintenta el P2002 exacto, recalcula generación y preserva el lease PROCESSING', async () => {
    const user = await createAccount('outbox-lease', { verified: false });
    await request('/auth/resend-verification', { body: { email: user.email } });
    const first = await database.prisma.accountToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION' },
      include: { outboxEvents: true },
    });
    const lockedAt = new Date();
    const lockToken = randomUUID();
    await database.prisma.outboxEvent.update({
      where: { id: first.outboxEvents[0]!.id },
      data: {
        status: 'PROCESSING',
        lockedAt,
        lockedUntil: new Date(lockedAt.getTime() + 60_000),
        lockedBy: `b13-${suite}`,
        lockToken,
      },
    });
    const lifecycle = app.get(AccountLifecycleService);
    const limiter = app.get(AuthRateLimitService);
    const consumeSpy = vi.spyOn(limiter, 'consume').mockResolvedValue(undefined);
    const transaction = database.prisma.$transaction.bind(database.prisma);
    const transactionSpy = vi.spyOn(database.prisma, '$transaction');
    transactionSpy
      .mockRejectedValueOnce({
        code: 'P2002',
        meta: {
          modelName: 'AccountToken',
          target: ['purpose', 'user_id', 'generation'],
        },
      } as never)
      .mockImplementation(transaction);
    try {
      await lifecycle.resendVerification(
        { email: user.email },
        `outbox-lease-${suite}`,
        `outbox-lease-${suite}`,
      );
      expect(transactionSpy).toHaveBeenCalledTimes(2);
    } finally {
      transactionSpy.mockRestore();
      consumeSpy.mockRestore();
    }
    expect(
      await database.prisma.outboxEvent.findUniqueOrThrow({
        where: { id: first.outboxEvents[0]!.id },
      }),
    ).toMatchObject({ status: 'PROCESSING', lockedBy: `b13-${suite}`, lockToken });
    expect(
      await database.prisma.accountToken.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ revocationReasonCode: 'SUPERSEDED' });
    const tokens = await database.prisma.accountToken.findMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION' },
      orderBy: { generation: 'asc' },
      include: { outboxEvents: true },
    });
    expect(tokens.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(tokens.every(({ outboxEvents }) => outboxEvents.length === 1)).toBe(true);
    expect(
      await database.prisma.auditEvent.count({
        where: { action: 'VERIFICATION_RESENT', resourceId: user.id },
      }),
    ).toBe(2);
  });

  it('revierte token, PHC, versión, sesiones y auditoría si falla antes del commit', async () => {
    const user = await createAccount('rollback-reset');
    const session = await createSession(user.id, user.sessionVersion);
    await request('/auth/forgot-password', { body: { email: user.email } });
    const external = await externalToken(user.id, 'PASSWORD_RESET');
    const token = await database.prisma.accountToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'PASSWORD_RESET' },
    });
    await database.prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS b13_fail_password_reset_audit_trg ON "audit_event"',
    );
    await database.prisma.$executeRawUnsafe(
      'DROP FUNCTION IF EXISTS b13_fail_password_reset_audit()',
    );
    await database.prisma.$executeRawUnsafe(
      "CREATE FUNCTION b13_fail_password_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'b13 forced rollback'; END; $$",
    );
    await database.prisma.$executeRawUnsafe(
      'CREATE TRIGGER b13_fail_password_reset_audit_trg BEFORE INSERT ON "audit_event" FOR EACH ROW WHEN (NEW."action" = \'PASSWORD_RESET\') EXECUTE FUNCTION b13_fail_password_reset_audit()',
    );
    try {
      const response = await request('/auth/reset-password', {
        body: { token: external, password: 'Contraseña que debe hacer rollback 🔐' },
      });
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' } },
      });
      const [currentUser, currentCredential, currentToken, currentSession, auditCount] =
        await Promise.all([
          database.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
          database.prisma.passwordCredential.findUniqueOrThrow({ where: { userId: user.id } }),
          database.prisma.accountToken.findUniqueOrThrow({ where: { id: token.id } }),
          database.prisma.session.findUniqueOrThrow({ where: { id: session.id } }),
          database.prisma.auditEvent.count({
            where: { action: 'PASSWORD_RESET', resourceId: user.id },
          }),
        ]);
      expect(currentUser.sessionVersion).toBe(user.sessionVersion);
      expect(currentCredential.passwordHash).toBe(user.passwordCredential!.passwordHash);
      expect(currentToken).toMatchObject({ consumedAt: null, revokedAt: null });
      expect(currentSession).toMatchObject({ revokedAt: null, revocationReason: null });
      expect(auditCount).toBe(0);
    } finally {
      await database.prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS b13_fail_password_reset_audit_trg ON "audit_event"',
      );
      await database.prisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS b13_fail_password_reset_audit()',
      );
    }
  });

  it('revalida que la credencial no cambió durante la verificación fuera del lock', async () => {
    const user = await createAccount('credential-race');
    const session = await createSession(user.id, user.sessionVersion);
    const engine = app.get<PasswordEngine>(PASSWORD_ENGINE);
    const originalVerify = engine.verifyForLogin.bind(engine);
    let announce!: () => void;
    let release!: () => void;
    const verified = new Promise<void>((resolve) => (announce = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(engine, 'verifyForLogin').mockImplementation(async (...args) => {
      const result = await originalVerify(...args);
      announce();
      await gate;
      return result;
    });
    try {
      const changing = request('/auth/change-password', {
        body: { currentPassword: originalPassword, newPassword: 'Contraseña que no debe ganar 🔐' },
        cookie: session.cookie,
        csrf: session.csrf,
      });
      await verified;
      const replacement = await hashPassword(
        'Cambio externo concurrente válido 🔐',
        readAppConfig().auth.argon2,
      );
      await database.prisma.passwordCredential.update({
        where: { userId: user.id },
        data: { passwordHash: replacement, passwordChangedAt: new Date() },
      });
      release();
      expect(await changing).toMatchObject({
        status: 401,
        body: { error: { code: 'INVALID_CREDENTIALS' } },
      });
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('usa exactamente las dimensiones persistentes de B1.3', async () => {
    const lifecycle = app.get(AccountLifecycleService);
    const config = readAppConfig().auth;
    const nonce = randomUUID();
    const resend = await createAccount(`dimensions-resend-${nonce}`, { verified: false });
    const forgot = await createAccount(`dimensions-forgot-${nonce}`);
    const logoutAllUser = await createAccount(`dimensions-logout-all-${nonce}`);
    const logoutAllSession = await createSession(logoutAllUser.id, logoutAllUser.sessionVersion);
    const changeUser = await createAccount(`dimensions-change-${nonce}`);
    const changeSession = await createSession(changeUser.id, changeUser.sessionVersion);
    const logoutUser = await createAccount(`dimensions-logout-${nonce}`);
    const logoutSession = await createSession(logoutUser.id, logoutUser.sessionVersion);
    const ipSuffix = nonce.replaceAll('-', '').slice(0, 4);
    const ips = {
      resend: `2001:db8:1::${ipSuffix}`,
      forgot: `2001:db8:2::${ipSuffix}`,
      reset: `2001:db8:3::${ipSuffix}`,
      logoutAll: `2001:db8:4::${ipSuffix}`,
      change: `2001:db8:5::${ipSuffix}`,
    };
    const malformed = `malformed-${nonce}`;
    const malformedSubject = AuthRateLimitService.malformedTokenSubject(malformed);
    const beforeLogout = await database.prisma.authRateLimit.count();

    await lifecycle.resendVerification({ email: resend.email }, ips.resend);
    await lifecycle.forgotPassword({ email: forgot.email }, ips.forgot);
    await expect(
      lifecycle.resetPassword(
        { token: malformed, password: 'Contraseña dimensiones válida 🔐' },
        ips.reset,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_OR_EXPIRED_TOKEN' });
    await lifecycle.logoutAll(
      sessionCookieValue(logoutAllSession.cookie),
      logoutAllSession.csrf,
      ips.logoutAll,
    );
    await lifecycle.changePassword(
      { currentPassword: originalPassword, newPassword: 'Contraseña dimensiones nueva 🔐' },
      sessionCookieValue(changeSession.cookie),
      changeSession.csrf,
      ips.change,
    );
    const beforeCurrentLogout = await database.prisma.authRateLimit.count();
    await lifecycle.logout(sessionCookieValue(logoutSession.cookie), logoutSession.csrf);
    expect(await database.prisma.authRateLimit.count()).toBe(beforeCurrentLogout);
    expect(beforeCurrentLogout).toBeGreaterThan(beforeLogout);

    const expected = [
      ['RESEND_VERIFICATION', 'EMAIL', resend.email],
      ['RESEND_VERIFICATION', 'IP', ips.resend],
      ['RESEND_VERIFICATION', 'EMAIL_IP', `${resend.email}\0${ips.resend}`],
      ['FORGOT_PASSWORD', 'EMAIL', forgot.email],
      ['FORGOT_PASSWORD', 'IP', ips.forgot],
      ['FORGOT_PASSWORD', 'EMAIL_IP', `${forgot.email}\0${ips.forgot}`],
      ['RESET_PASSWORD', 'TOKEN', malformedSubject],
      ['RESET_PASSWORD', 'IP', ips.reset],
      ['RESET_PASSWORD', 'TOKEN_IP', `${malformedSubject}\0${ips.reset}`],
      ['LOGOUT_ALL', 'ACTOR', logoutAllUser.id],
      ['LOGOUT_ALL', 'IP', ips.logoutAll],
      ['CHANGE_PASSWORD', 'ACTOR', changeUser.id],
      ['CHANGE_PASSWORD', 'IP', ips.change],
    ] as const;
    const version = config.rateLimitPepperKeys.currentVersion;
    const pepper = config.rateLimitPepperKeys.keys.get(version)!;
    const ownRows = await Promise.all(
      expected.map(async ([action, dimension, subject]) => {
        const digest = hmacSha256(
          pepper,
          'benhouse/auth-rate-limit/v1',
          action,
          dimension,
          subject,
          version,
        );
        return database.prisma.authRateLimit.findUnique({
          where: {
            action_dimension_subjectDigest_pepperVersion: {
              action,
              dimension,
              subjectDigest: new Uint8Array(digest),
              pepperVersion: version,
            },
          },
          select: { action: true, dimension: true },
        });
      }),
    );
    expect(ownRows).not.toContain(null);
    expect(ownRows).toEqual(expected.map(([action, dimension]) => ({ action, dimension })));
  });

  it('aplica N/N+1 y Retry-After al reenvío', async () => {
    const email = `rate-${suite}@example.test`;
    const firstFive = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      firstFive.push(await request('/auth/resend-verification', { body: { email } }));
    }
    expect(firstFive.every(({ status }) => status === 202)).toBe(true);
    const blocked = await request('/auth/resend-verification', { body: { email } });
    expect(blocked).toMatchObject({ status: 429, body: { error: { code: 'RATE_LIMITED' } } });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('responde 503 por HTTP antes de efectos si PostgreSQL no decide el rate limit', async () => {
    const config = readAppConfig();
    const unavailableDatabase = {
      prisma: {
        $transaction: async () => {
          throw new Error('database unavailable');
        },
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(unavailableDatabase)
      .compile();
    const unavailableApp = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    configureApplication(unavailableApp, config);
    await unavailableApp.listen(0, '127.0.0.1');
    try {
      const address = unavailableApp.getHttpServer().address();
      if (!address || typeof address === 'string') throw new Error('Puerto de test no disponible.');
      const email = `unavailable-${suite}@example.test`;
      const response = await fetch(`http://127.0.0.1:${address.port}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' },
      });
      expect(await database.prisma.user.count({ where: { email } })).toBe(0);
    } finally {
      await unavailableApp.close();
    }
  });

  it('payloads de outbox y auditoría permanecen allowlisted y sin PII', async () => {
    const user = await createAccount('payload');
    await request('/auth/forgot-password', {
      body: { email: user.email },
      requestId: `payload-${suite}`,
    });
    const token = await database.prisma.accountToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'PASSWORD_RESET' },
      include: { outboxEvents: true },
    });
    expect(Object.keys(token.outboxEvents[0]!.payload as object).sort()).toEqual(
      ['accountTokenId', 'generation', 'locale', 'purpose', 'template', 'userId'].sort(),
    );
    const serialized = JSON.stringify({
      outbox: token.outboxEvents[0]!.payload,
      audit: await database.prisma.auditEvent.findMany({ where: { resourceId: user.id } }),
    });
    expect(serialized).not.toContain(user.email);
    expect(serialized).not.toContain(originalPassword);
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('@');
  });
});
