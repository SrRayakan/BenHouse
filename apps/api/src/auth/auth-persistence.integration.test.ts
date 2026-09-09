import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthConfig } from '@benhouse/config';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';
import { createPrismaClient } from '@benhouse/database';
import type { PrismaClient } from '@benhouse/database';
import { DatabaseService } from '../infrastructure/database/database.service';
import { AuthRateLimitService } from './rate-limit.service';
import { SystemClock } from './clock';
import { hmacSha256 } from './crypto-encoding';
import { ApiError } from './auth.errors';
import { AuthService } from './auth.service';
import { serializeAccountToken } from './account-token';
import { PasswordEngine } from './password';
import { createSessionToken, sessionSecretDigest } from './session-token';

class FakeClock extends SystemClock {
  constructor(private instant: Date) {
    super();
  }

  override now(): Date {
    return new Date(this.instant);
  }

  advance(seconds: number): void {
    this.instant = new Date(this.instant.getTime() + seconds * 1000);
  }
}

describe('persistencia funcional B1.2', () => {
  let client: PrismaClient;
  let config: AuthConfig;

  beforeAll(async () => {
    loadLocalEnvironmentFile();
    config = readAppConfig().auth;
    client = createPrismaClient();
    await client.$connect();
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  function database(): DatabaseService {
    return { prisma: client } as DatabaseService;
  }

  function withPolicy(
    name: keyof AuthConfig['rateLimits'],
    policy: { limit: number; windowSeconds: number; blockSeconds: number },
  ): AuthConfig {
    return { ...config, rateLimits: { ...config.rateLimits, [name]: policy } };
  }

  it('hace UPSERT concurrente sin pérdida, sin persistir IP y reinicia ventana', async () => {
    const subject = `2001:db8::${Date.now().toString(16)}`;
    const clock = new FakeClock(new Date('2030-01-01T00:00:00.000Z'));
    const localConfig = withPolicy('SESSION_READ_IP', {
      limit: 100,
      windowSeconds: 60,
      blockSeconds: 120,
    });
    const limiter = new AuthRateLimitService(database(), localConfig, clock);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.consume([
          { action: 'SESSION_READ', dimension: 'IP', value: subject, policy: 'SESSION_READ_IP' },
        ]),
      ),
    );
    const version = localConfig.rateLimitPepperKeys.currentVersion;
    const digest = hmacSha256(
      localConfig.rateLimitPepperKeys.keys.get(version)!,
      'benhouse/auth-rate-limit/v1',
      'SESSION_READ',
      'IP',
      subject,
      version,
    );
    let row = await client.authRateLimit.findUniqueOrThrow({
      where: {
        action_dimension_subjectDigest_pepperVersion: {
          action: 'SESSION_READ',
          dimension: 'IP',
          subjectDigest: new Uint8Array(digest),
          pepperVersion: version,
        },
      },
    });
    expect(row.attemptCount).toBe(4);
    expect(JSON.stringify(row)).not.toContain(subject);
    clock.advance(61);
    await limiter.consume([
      { action: 'SESSION_READ', dimension: 'IP', value: subject, policy: 'SESSION_READ_IP' },
    ]);
    row = await client.authRateLimit.findUniqueOrThrow({
      where: {
        action_dimension_subjectDigest_pepperVersion: {
          action: 'SESSION_READ',
          dimension: 'IP',
          subjectDigest: new Uint8Array(digest),
          pepperVersion: version,
        },
      },
    });
    expect(row.attemptCount).toBe(1);
    expect(row.windowStartedAt).toEqual(clock.now());
  });

  it('conserva bloqueo futuro, devuelve Retry-After redondeado y rota peppers retenidos', async () => {
    const subject = `test-ip:${randomUUID()}`;
    const clock = new FakeClock(new Date('2030-02-01T00:00:00.250Z'));
    const rotated: AuthConfig = {
      ...withPolicy('SESSION_READ_IP', { limit: 2, windowSeconds: 5, blockSeconds: 60 }),
      rateLimitPepperKeys: {
        currentVersion: 2,
        keys: new Map([
          [1, Buffer.alloc(32, 11)],
          [2, Buffer.alloc(32, 12)],
        ]),
      },
    };
    const limiter = new AuthRateLimitService(database(), rotated, clock);
    await limiter.consume([
      { action: 'SESSION_READ', dimension: 'IP', value: subject, policy: 'SESSION_READ_IP' },
    ]);
    await limiter.consume([
      { action: 'SESSION_READ', dimension: 'IP', value: subject, policy: 'SESSION_READ_IP' },
    ]);
    const blocked = await limiter
      .consume([
        { action: 'SESSION_READ', dimension: 'IP', value: subject, policy: 'SESSION_READ_IP' },
      ])
      .catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ApiError);
    expect((blocked as ApiError).retryAfterSeconds).toBe(60);
    expect(
      await client.authRateLimit.count({
        where: { action: 'SESSION_READ', dimension: 'IP', pepperVersion: { in: [1, 2] } },
      }),
    ).toBeGreaterThanOrEqual(2);
    clock.advance(10);
    const stillBlocked = await limiter
      .consume([
        { action: 'SESSION_READ', dimension: 'IP', value: subject, policy: 'SESSION_READ_IP' },
      ])
      .catch((error: unknown) => error);
    expect((stillBlocked as ApiError).retryAfterSeconds).toBe(50);
  });

  it('limpia expirados por lotes de forma segura entre réplicas sin tocar filas vigentes', async () => {
    const now = new Date('2031-01-01T00:00:00.000Z');
    const clock = new FakeClock(now);
    const localConfig = { ...config, rateLimitCleanupBatchSize: 2 };
    const expiredIds = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const row = await client.authRateLimit.create({
          data: {
            action: 'SESSION_READ',
            dimension: 'IP',
            subjectDigest: new Uint8Array(randomBytes(32)),
            pepperVersion: localConfig.rateLimitPepperKeys.currentVersion,
            windowStartedAt: new Date(`2000-01-01T00:00:0${index}.000Z`),
            windowEndsAt: new Date(`2000-01-01T00:01:0${index}.000Z`),
            expiresAt: new Date(`2000-01-01T00:02:0${index}.000Z`),
          },
        });
        return row.id;
      }),
    );
    const live = await client.authRateLimit.create({
      data: {
        action: 'SESSION_READ',
        dimension: 'IP',
        subjectDigest: new Uint8Array(randomBytes(32)),
        pepperVersion: localConfig.rateLimitPepperKeys.currentVersion,
        windowStartedAt: now,
        windowEndsAt: new Date(now.getTime() + 60_000),
        expiresAt: new Date(now.getTime() + 60_000),
      },
    });
    const replicas = [
      new AuthRateLimitService(database(), localConfig, clock),
      new AuthRateLimitService(database(), localConfig, clock),
    ];
    expect(
      (await Promise.all(replicas.map((replica) => replica.cleanupExpiredBuckets()))).sort(),
    ).toEqual([2, 2]);
    expect(await client.authRateLimit.count({ where: { id: { in: expiredIds } } })).toBe(1);
    expect(await replicas[0]!.cleanupExpiredBuckets()).toBeGreaterThanOrEqual(1);
    expect(await client.authRateLimit.count({ where: { id: { in: expiredIds } } })).toBe(0);
    expect(await client.authRateLimit.findUnique({ where: { id: live.id } })).not.toBeNull();
  });

  it('falla cerrado con 503 si PostgreSQL no decide el rate limit', async () => {
    const unavailable = {
      prisma: {
        $transaction: async () => {
          throw new Error('db unavailable');
        },
      },
    } as unknown as DatabaseService;
    const limiter = new AuthRateLimitService(unavailable, config, new FakeClock(new Date()));
    const error = await limiter
      .consume([
        { action: 'SESSION_READ', dimension: 'IP', value: '127.0.0.1', policy: 'SESSION_READ_IP' },
      ])
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'SECURITY_DEPENDENCY_UNAVAILABLE', status: 503 });
  });

  it('revierte User, credencial, token, outbox y auditoría si falla el registro', async () => {
    const id = randomUUID();
    const email = `rollback-${id}@example.test`;
    const clock = new FakeClock(new Date());
    const limiter = new AuthRateLimitService(database(), config, clock);
    const auth = new AuthService(
      database(),
      limiter,
      clock,
      config,
      new PasswordEngine(config.argon2),
    );
    const body = auth.parseRegisterBody({
      email,
      displayName: 'Rollback',
      password: 'Una contraseña robusta 🔐',
    });
    const error = await auth
      .register(body, '127.0.0.2', 'x'.repeat(129))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'SECURITY_DEPENDENCY_UNAVAILABLE', status: 503 });
    expect(await client.user.count({ where: { email } })).toBe(0);
    expect(await client.auditEvent.count({ where: { requestId: 'x'.repeat(129) } })).toBe(0);
  });

  it('solo una verificación concurrente consume el token y crea una auditoría', async () => {
    const id = randomUUID();
    const email = `concurrent-${id}@example.test`;
    const clock = new FakeClock(new Date());
    const limiter = new AuthRateLimitService(database(), config, clock);
    const auth = new AuthService(
      database(),
      limiter,
      clock,
      config,
      new PasswordEngine(config.argon2),
    );
    const body = auth.parseRegisterBody({
      email,
      displayName: 'Concurrente',
      password: 'Una contraseña robusta 🔐',
    });
    await auth.register(body, '127.0.0.3', `register-${id}`);
    const user = await client.user.findUniqueOrThrow({ where: { email } });
    const stored = await client.accountToken.findFirstOrThrow({ where: { userId: user.id } });
    const token = serializeAccountToken(
      {
        id: stored.id,
        purpose: 'EMAIL_VERIFICATION',
        generation: stored.generation,
        subjectType: 'USER',
        subjectId: user.id,
        keyVersion: stored.keyVersion,
      },
      config.accountTokenKeys,
    );
    const results = await Promise.allSettled([
      auth.verifyEmail(token, '127.0.0.4', `verify-a-${id}`),
      auth.verifyEmail(token, '127.0.0.5', `verify-b-${id}`),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await client.accountToken.count({ where: { id: stored.id, consumedAt: { not: null } } }),
    ).toBe(1);
    expect(
      await client.auditEvent.count({ where: { action: 'EMAIL_VERIFIED', resourceId: user.id } }),
    ).toBe(1);
  });

  it('rechaza login si la credencial cambia después de Argon2 y antes del lock', async () => {
    const id = randomUUID();
    const email = `credential-race-${id}@example.test`;
    const password = 'Una contraseña robusta 🔐';
    const clock = new FakeClock(new Date());
    const limiter = new AuthRateLimitService(database(), config, clock);
    const setupPasswords = new PasswordEngine(config.argon2);
    const setupAuth = new AuthService(database(), limiter, clock, config, setupPasswords);
    await setupAuth.register(
      setupAuth.parseRegisterBody({ email, displayName: 'Carrera credencial', password }),
      '127.0.0.6',
      `register-${id}`,
    );
    const user = await client.user.findUniqueOrThrow({ where: { email } });
    const stored = await client.accountToken.findFirstOrThrow({ where: { userId: user.id } });
    const token = serializeAccountToken(
      {
        id: stored.id,
        purpose: 'EMAIL_VERIFICATION',
        generation: 1,
        subjectType: 'USER',
        subjectId: user.id,
        keyVersion: stored.keyVersion,
      },
      config.accountTokenKeys,
    );
    await setupAuth.verifyEmail(token, '127.0.0.7', `verify-${id}`);

    let reachedResolve!: () => void;
    let releaseResolve!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    class PausingPasswordEngine extends PasswordEngine {
      override async verifyForLogin(candidate: string, hash: string | undefined) {
        const result = await super.verifyForLogin(candidate, hash);
        reachedResolve();
        await release;
        return result;
      }
    }
    const racingAuth = new AuthService(
      database(),
      limiter,
      clock,
      config,
      new PausingPasswordEngine(config.argon2),
    );
    const login = racingAuth.login(
      racingAuth.parseLoginBody({ email, password }),
      '127.0.0.8',
      `login-${id}`,
    );
    await reached;
    await client.passwordCredential.update({
      where: { userId: user.id },
      data: {
        passwordHash: await setupPasswords.hash('Una contraseña nueva y robusta 🔒'),
        passwordChangedAt: clock.now(),
      },
    });
    releaseResolve();
    const error = await login.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    expect(await client.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it.each(['idle', 'absoluta'] as const)(
    'rechaza una sesión cuya expiración %s vence mientras espera el lock de sesión',
    async (expiration) => {
      const id = randomUUID();
      const databaseClock = await client.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS now
      `;
      const now = databaseClock[0]!.now;
      const user = await client.user.create({
        data: {
          email: `expiry-race-${expiration}-${id}@example.test`,
          displayName: 'Carrera de expiración',
          emailVerifiedAt: now,
        },
      });
      const token = createSessionToken();
      const version = config.sessionTokenKeys.currentVersion;
      const digest = sessionSecretDigest(
        token.selector,
        token.secret,
        version,
        config.sessionTokenKeys,
      )!;
      const staleActivity = new Date(now.getTime() - 120_000);
      const soon = new Date(now.getTime() + 700);
      const later = new Date(now.getTime() + 60_000);
      await client.session.create({
        data: {
          id: token.selector,
          secretDigest: new Uint8Array(digest),
          secretKeyVersion: version,
          userId: user.id,
          issuedSessionVersion: user.sessionVersion,
          createdAt: staleActivity,
          lastActivityAt: staleActivity,
          idleExpiresAt: soon,
          absoluteExpiresAt: expiration === 'absoluta' ? soon : later,
        },
      });

      let lockAcquired!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => (lockAcquired = resolve));
      const release = new Promise<void>((resolve) => (releaseLock = resolve));
      const blockerClient = createPrismaClient();
      await blockerClient.$connect();
      const blocker = blockerClient.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "session" WHERE "id" = ${token.selector}::uuid FOR UPDATE`;
        lockAcquired();
        await release;
      });
      await locked;

      const auth = new AuthService(
        database(),
        { consume: async () => undefined } as unknown as AuthRateLimitService,
        new SystemClock(),
        config,
        {} as PasswordEngine,
      );
      let settled = false;
      const sessionRead = auth.getSession(token.value, `expiry-race-${id}`);
      void sessionRead.then(
        () => (settled = true),
        () => (settled = true),
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 800));
      } finally {
        releaseLock();
        await blocker;
        await blockerClient.$disconnect();
      }

      await expect(sessionRead).resolves.toEqual({
        view: { authenticated: false },
        clearCookie: true,
      });
      const persisted = await client.session.findUniqueOrThrow({ where: { id: token.selector } });
      expect(persisted.lastActivityAt).toEqual(staleActivity);
      expect(persisted.idleExpiresAt).toEqual(soon);
    },
  );

  it('actualiza actividad solo tras el intervalo y nunca supera la expiración absoluta', async () => {
    const id = randomUUID();
    const databaseClock = await client.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    const now = databaseClock[0]!.now;
    const user = await client.user.create({
      data: {
        email: `activity-${id}@example.test`,
        displayName: 'Actividad',
        emailVerifiedAt: now,
      },
    });
    const token = createSessionToken();
    const version = config.sessionTokenKeys.currentVersion;
    const digest = sessionSecretDigest(
      token.selector,
      token.secret,
      version,
      config.sessionTokenKeys,
    )!;
    const absoluteExpiresAt = new Date(now.getTime() + 200_000);
    await client.session.create({
      data: {
        id: token.selector,
        secretDigest: new Uint8Array(digest),
        secretKeyVersion: version,
        userId: user.id,
        issuedSessionVersion: user.sessionVersion,
        createdAt: new Date(now.getTime() - 600_000),
        lastActivityAt: new Date(now.getTime() - 600_000),
        idleExpiresAt: new Date(now.getTime() + 100_000),
        absoluteExpiresAt,
      },
    });
    const auth = new AuthService(
      database(),
      new AuthRateLimitService(database(), config, new SystemClock()),
      new SystemClock(),
      config,
      new PasswordEngine(config.argon2),
    );
    const first = await auth.getSession(token.value, '127.0.0.9');
    expect(first.view).toMatchObject({
      authenticated: true,
      session: { expiresAt: absoluteExpiresAt.toISOString() },
    });
    const updated = await client.session.findUniqueOrThrow({ where: { id: token.selector } });
    expect(updated.lastActivityAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(updated.idleExpiresAt).toEqual(absoluteExpiresAt);
    await auth.getSession(token.value, '127.0.0.9');
    const unchanged = await client.session.findUniqueOrThrow({ where: { id: token.selector } });
    expect(unchanged.lastActivityAt).toEqual(updated.lastActivityAt);
  });
});
