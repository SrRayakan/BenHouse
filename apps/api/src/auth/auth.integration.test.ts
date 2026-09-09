import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';
import { AppModule } from '../app.module';
import { configureApplication } from '../main';
import { DatabaseService } from '../infrastructure/database/database.service';
import { serializeAccountToken } from './account-token';
import { createSessionToken, sessionSecretDigest } from './session-token';

type ApiResponse = { status: number; body: unknown; headers: Headers };

describe('Identity Auth Core API y seguridad', () => {
  let app: NestExpressApplication;
  let database: DatabaseService;
  let baseUrl: string;
  const suite = randomUUID();
  const email = `identity-${suite}@example.test`;
  const password = 'Una contraseña robusta 🔐';

  beforeAll(async () => {
    loadLocalEnvironmentFile();
    const config = readAppConfig();
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
      bodyParser: false,
    });
    configureApplication(app, config);
    await app.listen(0, '127.0.0.1');
    database = app.get(DatabaseService);
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Puerto de test no disponible.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      origin?: string | null;
      cookie?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.origin !== null) headers.origin = options.origin ?? 'http://localhost:3000';
    if (options.cookie) headers.cookie = options.cookie;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
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

  async function externalVerificationToken(userEmail: string): Promise<string> {
    const config = readAppConfig();
    const user = await database.prisma.user.findUniqueOrThrow({ where: { email: userEmail } });
    const token = await database.prisma.accountToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION' },
      orderBy: { generation: 'desc' },
    });
    return serializeAccountToken(
      {
        id: token.id,
        purpose: 'EMAIL_VERIFICATION',
        generation: token.generation,
        subjectType: 'USER',
        subjectId: user.id,
        keyVersion: token.keyVersion,
      },
      config.auth.accountTokenKeys,
    );
  }

  it('registra atómicamente con respuesta neutral, outbox mínimo y auditoría sin PII', async () => {
    const response = await request('POST', '/auth/register', {
      body: { email: `  ${email.toUpperCase()}  `, displayName: '  Ben House  ', password },
      headers: { 'x-request-id': `register-${suite}` },
    });
    expect(response).toMatchObject({ status: 202, body: { status: 'verification_required' } });
    const user = await database.prisma.user.findUniqueOrThrow({
      where: { email },
      include: { passwordCredential: true, accountTokens: { include: { outboxEvents: true } } },
    });
    expect(user).toMatchObject({
      displayName: 'Ben House',
      status: 'ACTIVE',
      emailVerifiedAt: null,
    });
    expect(user.passwordCredential?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.accountTokens).toHaveLength(1);
    expect(user.accountTokens[0]?.outboxEvents).toHaveLength(1);
    const outbox = user.accountTokens[0]?.outboxEvents[0];
    expect(Object.keys((outbox?.payload ?? {}) as object).sort()).toEqual(
      ['accountTokenId', 'generation', 'locale', 'purpose', 'template', 'userId'].sort(),
    );
    const serialized = JSON.stringify(outbox?.payload);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain(password);
    const audit = await database.prisma.auditEvent.findFirstOrThrow({
      where: { requestId: `register-${suite}`, action: 'USER_REGISTERED' },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('@');

    const duplicate = await request('POST', '/auth/register', {
      body: { email, displayName: 'Otro nombre', password: 'Otra contraseña robusta 🔒' },
    });
    expect(duplicate).toMatchObject({ status: 202, body: { status: 'verification_required' } });
    expect(await database.prisma.user.count({ where: { email } })).toBe(1);
    expect(await database.prisma.accountToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it('normaliza displayName a NFC antes de espacios y límites y persiste el resultado final', async () => {
    const normalizedEmail = `nfc-${suite}@example.test`;
    const decomposed = `  ${'e\u0301'.repeat(60)}\t\n `;
    expect(
      (
        await request('POST', '/auth/register', {
          body: { email: normalizedEmail, displayName: decomposed, password },
        })
      ).status,
    ).toBe(202);
    const user = await database.prisma.user.findUniqueOrThrow({
      where: { email: normalizedEmail },
    });
    expect(user.displayName).toBe('é'.repeat(60));
    expect(user.displayName).toBe(user.displayName.normalize('NFC'));
  });

  it('resuelve registro concurrente con una sola cuenta, generación y outbox', async () => {
    const concurrentEmail = `register-race-${suite}@example.test`;
    const payload = { email: concurrentEmail, displayName: 'Registro concurrente', password };
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => request('POST', '/auth/register', { body: payload })),
    );
    expect(responses.map(({ status }) => status)).toEqual([202, 202, 202]);
    const user = await database.prisma.user.findUniqueOrThrow({
      where: { email: concurrentEmail },
    });
    expect(await database.prisma.passwordCredential.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await database.prisma.accountToken.count({ where: { userId: user.id, generation: 1 } }),
    ).toBe(1);
    expect(
      await database.prisma.outboxEvent.count({
        where: { aggregateId: user.id, eventType: 'EMAIL_VERIFICATION_REQUESTED' },
      }),
    ).toBe(1);
  });

  it('rechaza mass assignment, DTO inválido y Origin ausente/null/incorrecto', async () => {
    const body = { email: `invalid-${suite}@example.test`, displayName: 'Prueba', password };
    expect(
      (await request('POST', '/auth/register', { body: { ...body, status: 'ACTIVE' } })).status,
    ).toBe(400);
    expect((await request('POST', '/auth/register', { body, origin: null })).body).toMatchObject({
      error: { code: 'ORIGIN_REQUIRED' },
    });
    expect((await request('POST', '/auth/register', { body, origin: 'null' })).body).toMatchObject({
      error: { code: 'ORIGIN_NOT_ALLOWED' },
    });
    expect(
      (await request('POST', '/auth/register', { body, origin: 'https://evil.example' })).body,
    ).toMatchObject({
      error: { code: 'ORIGIN_NOT_ALLOWED' },
    });
    expect(
      (await request('POST', '/auth/register', { body: { ...body, email: 'no-es-email' } })).status,
    ).toBe(400);
    expect(
      (await request('POST', '/auth/register', { body: { ...body, displayName: '   ' } })).status,
    ).toBe(400);
    expect(
      (await request('POST', '/auth/register', { body: { ...body, password: 'corta' } })).status,
    ).toBe(400);
    const oversized = await request('POST', '/auth/register', {
      body: { ...body, displayName: 'x'.repeat(9_000) },
    });
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(oversized.body)).not.toMatch(/stack|express|body-parser|prisma/i);
  });

  it('verifica email una sola vez y neutraliza token malformado, consumido y obsoleto', async () => {
    const token = await externalVerificationToken(email);
    expect((await request('POST', '/auth/verify-email', { body: { token } })).status).toBe(204);
    const user = await database.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    for (const invalid of [
      token,
      'token-malformado',
      `v1.${randomUUID()}.${randomBytes(32).toString('base64url')}`,
    ]) {
      const response = await request('POST', '/auth/verify-email', { body: { token: invalid } });
      expect(response).toMatchObject({
        status: 400,
        body: { error: { code: 'INVALID_OR_EXPIRED_TOKEN' } },
      });
    }

    const obsoleteEmail = `obsolete-${suite}@example.test`;
    await request('POST', '/auth/register', {
      body: { email: obsoleteEmail, displayName: 'Obsoleto', password },
    });
    const obsoleteUser = await database.prisma.user.findUniqueOrThrow({
      where: { email: obsoleteEmail },
    });
    const first = await database.prisma.accountToken.findFirstOrThrow({
      where: { userId: obsoleteUser.id },
    });
    const config = readAppConfig();
    const firstExternal = serializeAccountToken(
      {
        id: first.id,
        purpose: 'EMAIL_VERIFICATION',
        generation: 1,
        subjectType: 'USER',
        subjectId: obsoleteUser.id,
        keyVersion: first.keyVersion,
      },
      config.auth.accountTokenKeys,
    );
    await database.prisma.accountToken.create({
      data: {
        purpose: 'EMAIL_VERIFICATION',
        generation: 2,
        keyVersion: first.keyVersion,
        userId: obsoleteUser.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(
      (await request('POST', '/auth/verify-email', { body: { token: firstExternal } })).status,
    ).toBe(400);

    for (const state of ['expired', 'revoked', 'suspended'] as const) {
      const stateEmail = `${state}-${suite}@example.test`;
      const stateUser = await database.prisma.user.create({
        data: {
          email: stateEmail,
          displayName: 'Token inválido',
          status: state === 'suspended' ? 'SUSPENDED' : 'ACTIVE',
        },
      });
      const now = new Date();
      const createdAt = state === 'expired' ? new Date(now.getTime() - 120_000) : now;
      const storedToken = await database.prisma.accountToken.create({
        data: {
          purpose: 'EMAIL_VERIFICATION',
          generation: 1,
          keyVersion: config.auth.accountTokenKeys.currentVersion,
          userId: stateUser.id,
          createdAt,
          expiresAt:
            state === 'expired'
              ? new Date(now.getTime() - 60_000)
              : new Date(now.getTime() + 60_000),
          ...(state === 'revoked'
            ? { revokedAt: now, revocationReasonCode: 'SECURITY_RESPONSE' }
            : {}),
        },
      });
      const external = serializeAccountToken(
        {
          id: storedToken.id,
          purpose: 'EMAIL_VERIFICATION',
          generation: 1,
          subjectType: 'USER',
          subjectId: stateUser.id,
          keyVersion: storedToken.keyVersion,
        },
        config.auth.accountTokenKeys,
      );
      expect(
        (await request('POST', '/auth/verify-email', { body: { token: external } })).status,
      ).toBe(400);
    }
  });

  it('hace login neutral, evita fixation y devuelve sesión/CSRF estables entre pestañas', async () => {
    const wrong = await request('POST', '/auth/login', {
      body: { email, password: `${password}!` },
    });
    const absent = await request('POST', '/auth/login', {
      body: { email: `absent-${suite}@example.test`, password },
    });
    expect(wrong.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(absent.body).toEqual(wrong.body);

    const fixation = `${randomUUID()}.${randomBytes(32).toString('base64url')}`;
    const login = await request('POST', '/auth/login', {
      body: { email, password },
      cookie: `benhouse-local-session=${fixation}`,
    });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      authenticated: true,
      capabilities: [],
      user: { email, status: 'ACTIVE', emailVerified: true },
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('benhouse-local-session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain(fixation);
    expect(setCookie).not.toMatch(/Domain=/i);
    const secondLogin = await request('POST', '/auth/login', { body: { email, password } });
    expect(secondLogin.headers.get('set-cookie')).not.toBe(setCookie);
    const cookie = setCookie.split(';')[0]!;
    const first = await request('GET', '/auth/session', { cookie, origin: null });
    const second = await request('GET', '/auth/session', { cookie, origin: null });
    expect(first.status).toBe(200);
    expect(first.body).toEqual(second.body);
    expect(first.body).toMatchObject({ authenticated: true, user: { email }, capabilities: [] });
  });

  it('verifica por HTTP un PHC estándar y neutraliza costes corruptos sin responder 500', async () => {
    const vectorEmail = `phc-vector-${suite}@example.test`;
    const vectorPassword = 'correct horse battery staple';
    const vector =
      '$argon2id$v=19$m=8192,t=2,p=2$MDEyMzQ1Njc4OWFiY2RlZg$Lfz83byharzEIwclGubPCAc+3Z3N+99q5KhR9BlAkZc';
    const now = new Date();
    await database.prisma.user.create({
      data: {
        email: vectorEmail,
        displayName: 'Vector interoperable',
        status: 'ACTIVE',
        emailVerifiedAt: now,
        passwordCredential: {
          create: { passwordHash: vector, createdAt: now, passwordChangedAt: now },
        },
      },
    });
    expect(
      (
        await request('POST', '/auth/login', {
          body: { email: vectorEmail, password: vectorPassword },
        })
      ).status,
    ).toBe(200);

    const corruptEmail = `phc-corrupt-${suite}@example.test`;
    await database.prisma.user.create({
      data: {
        email: corruptEmail,
        displayName: 'PHC corrupto',
        status: 'ACTIVE',
        emailVerifiedAt: now,
        passwordCredential: {
          create: {
            passwordHash:
              '$argon2id$v=19$m=9999999999,t=9999999999,p=9999999999$MDEyMzQ1Njc4OWFiY2RlZg$Lfz83byharzEIwclGubPCAc+3Z3N+99q5KhR9BlAkZc',
            createdAt: now,
            passwordChangedAt: now,
          },
        },
      },
    });
    const corrupt = await request('POST', '/auth/login', {
      body: { email: corruptEmail, password: vectorPassword },
    });
    expect(corrupt.status).toBe(401);
    expect(corrupt.body).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
  });

  it('devuelve sesión anónima y limpia cookies corruptas, revocadas, vencidas o versionadas', async () => {
    expect((await request('GET', '/auth/session', { origin: null })).body).toEqual({
      authenticated: false,
    });
    const corrupt = await request('GET', '/auth/session', {
      origin: null,
      cookie: 'benhouse-local-session=corrupta',
    });
    expect(corrupt.body).toEqual({ authenticated: false });
    expect(corrupt.headers.get('set-cookie')).toContain('benhouse-local-session=;');

    const user = await database.prisma.user.findUniqueOrThrow({ where: { email } });
    for (const kind of [
      'revoked',
      'idle-expired',
      'absolute-expired',
      'versioned',
      'unknown-key',
    ] as const) {
      const created = await createStoredSession(user.id, user.sessionVersion, kind);
      const response = await request('GET', '/auth/session', {
        origin: null,
        cookie: `benhouse-local-session=${created.cookie}`,
      });
      expect(response.body).toEqual({ authenticated: false });
      expect(response.headers.get('set-cookie')).toContain('benhouse-local-session=;');
    }
  });

  it('impide login de cuenta no verificada, suspendida o desactivada sin distinguir la causa', async () => {
    const unverified = `unverified-${suite}@example.test`;
    await request('POST', '/auth/register', {
      body: { email: unverified, displayName: 'No verificada', password },
    });
    const baseline = await request('POST', '/auth/login', {
      body: { email: unverified, password },
    });
    expect(baseline.status).toBe(401);
    const user = await database.prisma.user.findUniqueOrThrow({ where: { email } });
    for (const status of ['SUSPENDED', 'DEACTIVATED'] as const) {
      await database.prisma.user.update({ where: { id: user.id }, data: { status } });
      const response = await request('POST', '/auth/login', { body: { email, password } });
      expect(response.status).toBe(401);
      expect(response.body).toEqual(baseline.body);
    }
    await database.prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
  });

  it.each([
    ['suspensión', 'suspension'],
    ['revocación', 'revocacion'],
    ['versión', 'version'],
  ] as const)(
    'serializa lectura HTTP frente a %s concurrente sin refrescar una sesión inválida',
    async (mutation, emailLabel) => {
      const user = await database.prisma.user.create({
        data: {
          email: `race-${emailLabel}-${randomUUID()}@example.test`,
          displayName: 'Carrera de sesión',
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });
      const stored = await createStoredSession(user.id, user.sessionVersion);
      const staleActivity = new Date(Date.now() - 120_000);
      await database.prisma.session.update({
        where: { id: stored.id },
        data: {
          createdAt: new Date(staleActivity.getTime() - 1_000),
          lastActivityAt: staleActivity,
        },
      });
      let announceLock!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>((resolve) => (announceLock = resolve));
      const release = new Promise<void>((resolve) => (releaseLock = resolve));
      const mutationTransaction = database.prisma.$transaction(async (tx) => {
        if (mutation === 'revocación') {
          await tx.session.update({
            where: { id: stored.id },
            data: { revokedAt: new Date(), revocationReason: 'SECURITY_RESPONSE' },
          });
        } else {
          await tx.user.update({
            where: { id: user.id },
            data:
              mutation === 'suspensión'
                ? { status: 'SUSPENDED' }
                : { sessionVersion: { increment: 1 } },
          });
        }
        announceLock();
        await release;
      });
      await locked;
      const sessionRead = request('GET', '/auth/session', {
        origin: null,
        cookie: `benhouse-local-session=${stored.cookie}`,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseLock();
      await mutationTransaction;
      const response = await sessionRead;
      expect(response.body).toEqual({ authenticated: false });
      expect(response.headers.get('set-cookie')).toContain('benhouse-local-session=;');
      const persisted = await database.prisma.session.findUniqueOrThrow({
        where: { id: stored.id },
      });
      expect(persisted.lastActivityAt).toEqual(staleActivity);
    },
  );

  it('aplica CORS con credenciales y niega preflight no autorizado sin ACAO', async () => {
    const allowed = await fetch(`${baseUrl}/auth/session`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    const denied = await fetch(`${baseUrl}/auth/session`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(denied.headers.get('access-control-allow-credentials')).toBeNull();
  });

  async function createStoredSession(
    userId: string,
    issuedSessionVersion: number,
    kind:
      | 'valid'
      | 'revoked'
      | 'idle-expired'
      | 'absolute-expired'
      | 'versioned'
      | 'unknown-key' = 'valid',
  ) {
    const config = readAppConfig();
    const token = createSessionToken();
    const digest = sessionSecretDigest(
      token.selector,
      token.secret,
      config.auth.sessionTokenKeys.currentVersion,
      config.auth.sessionTokenKeys,
    )!;
    const now = new Date();
    const createdAt =
      kind === 'idle-expired' || kind === 'absolute-expired'
        ? new Date(now.getTime() - 120_000)
        : now;
    const lastActivityAt =
      kind === 'idle-expired' || kind === 'absolute-expired'
        ? new Date(now.getTime() - 90_000)
        : now;
    const idleExpiresAt =
      kind === 'idle-expired'
        ? new Date(now.getTime() - 1_000)
        : kind === 'absolute-expired'
          ? new Date(now.getTime() - 2_000)
          : new Date(now.getTime() + 60_000);
    const absoluteExpiresAt =
      kind === 'absolute-expired'
        ? new Date(now.getTime() - 1_000)
        : new Date(now.getTime() + 120_000);
    const session = await database.prisma.session.create({
      data: {
        id: token.selector,
        secretDigest: new Uint8Array(digest),
        secretKeyVersion:
          kind === 'unknown-key' ? 32_767 : config.auth.sessionTokenKeys.currentVersion,
        userId,
        issuedSessionVersion:
          kind === 'versioned' ? issuedSessionVersion + 1 : issuedSessionVersion,
        createdAt,
        lastActivityAt,
        idleExpiresAt,
        absoluteExpiresAt,
        ...(kind === 'revoked'
          ? { revokedAt: now, revocationReason: 'SECURITY_RESPONSE' as const }
          : {}),
      },
    });
    return { id: session.id, cookie: token.value };
  }
});
