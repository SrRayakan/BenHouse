import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig, AuthConfig } from '@benhouse/config';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';
import { AppModule } from '../app.module';
import { configureApplication } from '../main';
import { DatabaseService } from '../infrastructure/database/database.service';
import { AUTH_CONFIG } from './auth.config';
import { hmacSha256 } from './crypto-encoding';

type RunningApp = {
  app: NestExpressApplication;
  baseUrl: string;
  database: DatabaseService;
  config: AppConfig;
};

describe('rate limit HTTP y confianza de proxy B1.2', () => {
  let baseConfig: AppConfig;
  const running: NestExpressApplication[] = [];

  beforeAll(() => {
    loadLocalEnvironmentFile();
    baseConfig = readAppConfig();
  });

  afterAll(async () => {
    await Promise.all(running.map((app) => app.close()));
  });

  async function start(authOverrides: Partial<AuthConfig>): Promise<RunningApp> {
    const auth: AuthConfig = {
      ...baseConfig.auth,
      rateLimitPepperKeys: {
        currentVersion: 1,
        keys: new Map([[1, randomBytes(32)]]),
      },
      ...authOverrides,
    };
    const config = { ...baseConfig, auth };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AUTH_CONFIG)
      .useValue(auth)
      .compile();
    const app = module.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    configureApplication(app, config);
    await app.listen(0, '127.0.0.1');
    running.push(app);
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Puerto de test no disponible.');
    return {
      app,
      baseUrl: `http://127.0.0.1:${address.port}`,
      database: app.get(DatabaseService),
      config,
    };
  }

  it('permite exactamente N intentos, bloquea N+1 con Retry-After y persiste las tres dimensiones', async () => {
    const policy = { limit: 2, windowSeconds: 60, blockSeconds: 37 };
    const instance = await start({
      rateLimits: {
        ...baseConfig.auth.rateLimits,
        LOGIN_EMAIL: policy,
        LOGIN_IP: policy,
        LOGIN_EMAIL_IP: policy,
      },
    });
    const email = `rate-${randomUUID()}@example.test`;
    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(
        await fetch(`${instance.baseUrl}/auth/login`, {
          method: 'POST',
          headers: { origin: baseConfig.auth.appOrigin, 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'Contraseña deliberadamente incorrecta 🔐' }),
        }),
      );
    }
    expect(responses.map(({ status }) => status)).toEqual([401, 401, 429]);
    expect(Number(responses[2]!.headers.get('retry-after'))).toBeGreaterThanOrEqual(36);

    const version = instance.config.auth.rateLimitPepperKeys.currentVersion;
    const pepper = instance.config.auth.rateLimitPepperKeys.keys.get(version)!;
    const dimensions = [
      ['EMAIL', email],
      ['IP', '127.0.0.1'],
      ['EMAIL_IP', `${email}\0${'127.0.0.1'}`],
    ] as const;
    for (const [dimension, value] of dimensions) {
      const digest = hmacSha256(
        pepper,
        'benhouse/auth-rate-limit/v1',
        'LOGIN',
        dimension,
        value,
        version,
      );
      const row = await instance.database.prisma.authRateLimit.findUniqueOrThrow({
        where: {
          action_dimension_subjectDigest_pepperVersion: {
            action: 'LOGIN',
            dimension,
            subjectDigest: new Uint8Array(digest),
            pepperVersion: version,
          },
        },
      });
      expect(row.attemptCount).toBe(3);
      expect(row.blockedUntil).toBeInstanceOf(Date);
    }
  });

  it.each([
    [0, '198.51.100.10, 203.0.113.20', '127.0.0.1'],
    [1, '198.51.100.10, 203.0.113.20', '203.0.113.20'],
    [2, '198.51.100.10, 203.0.113.20', '198.51.100.10'],
  ])(
    'respeta trust proxy=%i al derivar la dimensión IP',
    async (trustProxyHops, forwarded, expectedIp) => {
      const instance = await start({ trustProxyHops });
      const response = await fetch(`${instance.baseUrl}/auth/session`, {
        headers: { 'x-forwarded-for': forwarded },
      });
      expect(response.status).toBe(200);
      const version = instance.config.auth.rateLimitPepperKeys.currentVersion;
      const digest = hmacSha256(
        instance.config.auth.rateLimitPepperKeys.keys.get(version)!,
        'benhouse/auth-rate-limit/v1',
        'SESSION_READ',
        'IP',
        expectedIp,
        version,
      );
      await expect(
        instance.database.prisma.authRateLimit.findUnique({
          where: {
            action_dimension_subjectDigest_pepperVersion: {
              action: 'SESSION_READ',
              dimension: 'IP',
              subjectDigest: new Uint8Array(digest),
              pepperVersion: version,
            },
          },
        }),
      ).resolves.not.toBeNull();
    },
  );
});
