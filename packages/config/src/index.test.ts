import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, readAppConfig, redactSensitiveValue } from './index';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://benhouse:secret@localhost:5432/benhouse_test',
  API_PORT: '3001',
  APP_ORIGIN: 'http://localhost:3000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
  LOG_LEVEL: 'info',
  SESSION_COOKIE_NAME: 'benhouse-test-session',
  SESSION_ABSOLUTE_TTL_SECONDS: '86400',
  SESSION_IDLE_TTL_SECONDS: '3600',
  SESSION_LAST_SEEN_WRITE_INTERVAL_SECONDS: '60',
  SESSION_TOKEN_KEYS: '1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  SESSION_TOKEN_CURRENT_KEY_VERSION: '1',
  CSRF_KEYS: '1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  CSRF_CURRENT_KEY_VERSION: '1',
  ACCOUNT_TOKEN_KEYS: '1:AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
  ACCOUNT_TOKEN_CURRENT_KEY_VERSION: '1',
  AUTH_RATE_LIMIT_PEPPER_KEYS: '1:AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
  AUTH_RATE_LIMIT_CURRENT_PEPPER_VERSION: '1',
  EMAIL_VERIFICATION_TTL_SECONDS: '3600',
  PASSWORD_RESET_TTL_SECONDS: '1800',
  ARGON2_MEMORY_KIB: '8192',
  ARGON2_PASSES: '2',
  ARGON2_PARALLELISM: '2',
  TRUST_PROXY_HOPS: '0',
  AUTH_RATE_LIMIT_REGISTER_EMAIL: '5:60:60',
  AUTH_RATE_LIMIT_REGISTER_IP: '10:60:60',
  AUTH_RATE_LIMIT_REGISTER_EMAIL_IP: '5:60:60',
  AUTH_RATE_LIMIT_LOGIN_EMAIL: '5:60:60',
  AUTH_RATE_LIMIT_LOGIN_IP: '10:60:60',
  AUTH_RATE_LIMIT_LOGIN_EMAIL_IP: '5:60:60',
  AUTH_RATE_LIMIT_VERIFY_EMAIL_TOKEN: '5:60:60',
  AUTH_RATE_LIMIT_VERIFY_EMAIL_IP: '10:60:60',
  AUTH_RATE_LIMIT_VERIFY_EMAIL_TOKEN_IP: '5:60:60',
  AUTH_RATE_LIMIT_RESEND_VERIFICATION_EMAIL: '5:60:60',
  AUTH_RATE_LIMIT_RESEND_VERIFICATION_IP: '10:60:60',
  AUTH_RATE_LIMIT_RESEND_VERIFICATION_EMAIL_IP: '5:60:60',
  AUTH_RATE_LIMIT_FORGOT_PASSWORD_EMAIL: '5:60:60',
  AUTH_RATE_LIMIT_FORGOT_PASSWORD_IP: '10:60:60',
  AUTH_RATE_LIMIT_FORGOT_PASSWORD_EMAIL_IP: '5:60:60',
  AUTH_RATE_LIMIT_RESET_PASSWORD_TOKEN: '5:60:60',
  AUTH_RATE_LIMIT_RESET_PASSWORD_IP: '10:60:60',
  AUTH_RATE_LIMIT_RESET_PASSWORD_TOKEN_IP: '5:60:60',
  AUTH_RATE_LIMIT_LOGOUT_ALL_ACTOR: '5:60:60',
  AUTH_RATE_LIMIT_LOGOUT_ALL_IP: '10:60:60',
  AUTH_RATE_LIMIT_CHANGE_PASSWORD_ACTOR: '5:60:60',
  AUTH_RATE_LIMIT_CHANGE_PASSWORD_IP: '10:60:60',
  AUTH_RATE_LIMIT_SESSION_READ_IP: '60:60:60',
  AUTH_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS: '300',
  AUTH_RATE_LIMIT_CLEANUP_BATCH_SIZE: '500',
};

function productionEnvironment(): NodeJS.ProcessEnv {
  const key = () => randomBytes(32).toString('base64url');
  return {
    ...validEnvironment,
    NODE_ENV: 'production',
    SESSION_COOKIE_NAME: '__Host-benhouse-session',
    APP_ORIGIN: 'https://app.benhouse.example',
    CORS_ALLOWED_ORIGINS: 'https://app.benhouse.example',
    SESSION_TOKEN_KEYS: `1:${key()}`,
    CSRF_KEYS: `1:${key()}`,
    ACCOUNT_TOKEN_KEYS: `1:${key()}`,
    AUTH_RATE_LIMIT_PEPPER_KEYS: `1:${key()}`,
    ARGON2_MEMORY_KIB: '19456',
  };
}

describe('readAppConfig', () => {
  it('acepta una configuración válida', () => {
    expect(readAppConfig(validEnvironment)).toMatchObject({
      nodeEnv: 'test',
      apiPort: 3001,
      corsOrigin: 'http://localhost:3000',
      corsAllowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
      logLevel: 'info',
      auth: { passwordResetTtlSeconds: 1800 },
    });
  });

  it('falla si falta DATABASE_URL', () => {
    const environment: NodeJS.ProcessEnv = { ...validEnvironment };
    delete environment.DATABASE_URL;
    expect(() => readAppConfig(environment)).toThrow(ConfigurationError);
  });

  it.each(['0', '65536', 'abc'])('rechaza API_PORT inválido: %s', (apiPort) => {
    expect(() => readAppConfig({ ...validEnvironment, API_PORT: apiPort })).toThrow(
      ConfigurationError,
    );
  });

  it.each(['localhost:3000', 'http://localhost:3000/ruta'])(
    'rechaza CORS_ALLOWED_ORIGINS inválido: %s',
    (corsOrigin) => {
      expect(() =>
        readAppConfig({ ...validEnvironment, CORS_ALLOWED_ORIGINS: corsOrigin }),
      ).toThrow(ConfigurationError);
    },
  );

  it('rechaza versión actual ausente del keyring', () => {
    expect(() =>
      readAppConfig({ ...validEnvironment, SESSION_TOKEN_CURRENT_KEY_VERSION: '2' }),
    ).toThrow(ConfigurationError);
  });

  it.each([
    ['APP_ORIGIN fuera de CORS', { APP_ORIGIN: 'http://otro.example' }],
    [
      'idle superior a absoluta',
      { SESSION_ABSOLUTE_TTL_SECONDS: '600', SESSION_IDLE_TTL_SECONDS: '601' },
    ],
    ['Argon2 débil', { ARGON2_MEMORY_KIB: '1024' }],
    ['rate limit cero', { AUTH_RATE_LIMIT_LOGIN_EMAIL: '0:60:60' }],
    ['proxy negativo', { TRUST_PROXY_HOPS: '-1' }],
    ['TTL de reset inválido', { PASSWORD_RESET_TTL_SECONDS: '0' }],
  ])('falla rápido ante %s', (_case, invalid) => {
    expect(() => readAppConfig({ ...validEnvironment, ...invalid })).toThrow(ConfigurationError);
  });

  it('rechaza claves demasiado cortas y cookies de producción degradadas', () => {
    expect(() => readAppConfig({ ...validEnvironment, CSRF_KEYS: '1:corta' })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      readAppConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        SESSION_COOKIE_NAME: 'benhouse-session',
      }),
    ).toThrow(ConfigurationError);
  });

  it('fuerza cookie __Host y Secure en producción', () => {
    const production = readAppConfig(productionEnvironment());
    expect(production.auth).toMatchObject({
      sessionCookieName: '__Host-benhouse-session',
      sessionCookieSecure: true,
    });
  });

  it('rechaza fixtures públicas, material repetido y Argon2 débil en producción', () => {
    const production = productionEnvironment();
    expect(() =>
      readAppConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        SESSION_COOKIE_NAME: '__Host-benhouse-session',
        APP_ORIGIN: 'https://app.benhouse.example',
        CORS_ALLOWED_ORIGINS: 'https://app.benhouse.example',
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      readAppConfig({ ...production, CSRF_KEYS: production.SESSION_TOKEN_KEYS }),
    ).toThrow(ConfigurationError);
    expect(() => readAppConfig({ ...production, ARGON2_MEMORY_KIB: '8192' })).toThrow(
      ConfigurationError,
    );
  });

  it('rechaza en cada keyring todo material público determinista conocido sin filtrarlo', () => {
    const keyringNames = [
      'SESSION_TOKEN_KEYS',
      'CSRF_KEYS',
      'ACCOUNT_TOKEN_KEYS',
      'AUTH_RATE_LIMIT_PEPPER_KEYS',
    ] as const;
    const knownPublicKeys = [
      ...[0, 1, 2, 3, 7, 11, 12].map((byte) => Buffer.alloc(32, byte)),
      ...[11, 53, 97, 139].map((offset) =>
        Buffer.from(Array.from({ length: 32 }, (_, index) => (index + offset) % 256)),
      ),
    ];

    for (const keyringName of keyringNames) {
      for (const publicKey of knownPublicKeys) {
        const encoded = publicKey.toString('base64url');
        const error = (() => {
          try {
            readAppConfig({ ...productionEnvironment(), [keyringName]: `1:${encoded}` });
          } catch (caught) {
            return caught;
          }
        })();
        expect(error).toBeInstanceOf(ConfigurationError);
        expect(String((error as Error).message)).not.toContain(encoded);
      }
    }
  });

  it('acepta claves productivas fuertes generadas durante la ejecución', () => {
    expect(readAppConfig(productionEnvironment()).nodeEnv).toBe('production');
  });

  it('redacta keyrings, peppers y CSRF', () => {
    const serialized = JSON.stringify(
      redactSensitiveValue({
        sessionTokenKeys: 'no-filtrar',
        authPepper: 'no-filtrar',
        csrfToken: 'no-filtrar',
      }),
    );
    expect(serialized).not.toContain('no-filtrar');
  });

  it('rechaza LOG_LEVEL inválido', () => {
    expect(() => readAppConfig({ ...validEnvironment, LOG_LEVEL: 'verbose' })).toThrow(
      ConfigurationError,
    );
  });

  it('redacta credenciales y secretos de logs', () => {
    expect(redactSensitiveValue(validEnvironment.DATABASE_URL)).not.toContain('secret');
    expect(redactSensitiveValue(validEnvironment.DATABASE_URL)).toBe('[REDACTED_DATABASE_URL]');
    expect(redactSensitiveValue('token=abc123')).toBe('token=[REDACTED]');
    expect(
      redactSensitiveValue(
        '$argon2id$v=19$m=8192,t=2,p=2$c2FsdHNhbHRzYWx0c2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBe('[REDACTED_PHC]');
    expect(
      redactSensitiveValue(
        'v1.123e4567-e89b-42d3-a456-426614174000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBe('[REDACTED_ACCOUNT_TOKEN]');
    const session =
      '123e4567-e89b-42d3-a456-426614174000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const csrf = '1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(redactSensitiveValue(`session=${session} csrf=${csrf}`)).toBe(
      'session=[REDACTED_SESSION_TOKEN] csrf=[REDACTED_CSRF_TOKEN]',
    );
    const punctuated = redactSensitiveValue({
      message: `(${session}), [${csrf}]; de nuevo ${session}`,
      values: [`prefijo ${csrf} sufijo`, { detail: session }],
    });
    expect(JSON.stringify(punctuated)).not.toContain(session);
    expect(JSON.stringify(punctuated)).not.toContain(csrf);
    expect(
      JSON.stringify(redactSensitiveValue(new Error('falló', { cause: session }))),
    ).not.toContain(session);
    expect(redactSensitiveValue('123e4567-e89b-42d3-a456-426614174000.no-es-token')).toContain(
      'no-es-token',
    );
    expect(redactSensitiveValue('1.etiqueta-normal')).toBe('1.etiqueta-normal');
  });

  it('redacta las 16 terminaciones Base64URL canónicas sin coincidencias parciales', () => {
    const selector = '123e4567-e89b-42d3-a456-426614174000';
    const tags = Array.from({ length: 16 }, (_, ending) => {
      const bytes = Buffer.alloc(32);
      bytes[31] = ending;
      return bytes.toString('base64url');
    });
    expect(new Set(tags.map((tag) => tag.at(-1))).size).toBe(16);

    for (const tag of tags) {
      const session = `${selector}.${tag}`;
      const csrf = `1.${tag}`;
      const error = new Error(`error (${session}), "${csrf}"`, {
        cause: [{ detail: session }, csrf],
      });
      error.name = `fallo ${session}`;
      const redacted = JSON.stringify(
        redactSensitiveValue({
          atStart: `${session} final`,
          inMiddle: `antes '${csrf}' después`,
          atEnd: `inicio ${session}`,
          array: [`(${csrf}); ${session}`, error],
        }),
      );
      expect(redacted).not.toContain(session);
      expect(redacted).not.toContain(csrf);
      expect(redacted).not.toContain(tag);
      expect(redacted).toContain('[REDACTED_SESSION_TOKEN]');
      expect(redacted).toContain('[REDACTED_CSRF_TOKEN]');

      for (const invalid of [
        selector,
        '1.2.3',
        'example.com',
        'object.identifier',
        `${selector}.${tag.slice(1)}`,
        `${selector}.${tag}-`,
        `1.${tag.slice(1)}`,
        `1.${tag}_`,
      ]) {
        expect(redactSensitiveValue(invalid)).toBe(invalid);
      }
    }
  });

  it('redacta claves sensibles en objetos, arrays, ciclos y profundidad excesiva', () => {
    const nested: Record<string, unknown> = {
      auth: {
        password: 'no-debe-aparecer',
        cookies: ['session=secreto'],
        nested: [{ authorization: 'Bearer secreto' }],
      },
    };
    nested.self = nested;

    const deeplyNested = Array.from({ length: 10 }).reduce<unknown>((value) => ({ next: value }), {
      token: 'tampoco-debe-aparecer',
    });
    const redacted = redactSensitiveValue({ nested, deeplyNested });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('no-debe-aparecer');
    expect(serialized).not.toContain('session=secreto');
    expect(serialized).not.toContain('Bearer secreto');
    expect(serialized).not.toContain('tampoco-debe-aparecer');
    expect(serialized).toContain('[REDACTED_CIRCULAR_REFERENCE]');
    expect(serialized).toContain('[REDACTED_DEPTH_LIMIT]');
  });
});
