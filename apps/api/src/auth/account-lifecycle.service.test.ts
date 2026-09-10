import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '@benhouse/config';
import {
  AccountLifecycleService,
  isRetryableAccountTokenGenerationConflict,
} from './account-lifecycle.service';
import { securityDependencyUnavailable } from './auth.errors';
import { PasswordEngine } from './password';
import { SystemClock } from './clock';
import {
  SERIALIZABLE_MAX_ATTEMPTS,
  isSerializationFailure,
  withSerializableRetry,
} from './serializable-transaction';

const keyring = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 1)]]) };
const config = {
  appOrigin: 'http://localhost:3000',
  allowedOrigins: ['http://localhost:3000'],
  sessionCookieName: 'benhouse-test-session',
  sessionCookieSecure: false,
  sessionAbsoluteTtlSeconds: 3600,
  sessionIdleTtlSeconds: 600,
  sessionLastSeenWriteIntervalSeconds: 60,
  sessionTokenKeys: keyring,
  csrfKeys: keyring,
  accountTokenKeys: keyring,
  rateLimitPepperKeys: keyring,
  emailVerificationTtlSeconds: 3600,
  passwordResetTtlSeconds: 1800,
  argon2: { memoryKiB: 8192, passes: 2, parallelism: 2 },
  rateLimits: {},
  rateLimitCleanupIntervalSeconds: 300,
  rateLimitCleanupBatchSize: 500,
  trustProxyHops: 0,
} as unknown as AuthConfig;

function service(database: object, consume = vi.fn().mockResolvedValue(undefined)) {
  return {
    lifecycle: new AccountLifecycleService(
      database as never,
      { consume } as never,
      new SystemClock(),
      config,
      new PasswordEngine(config.argon2),
    ),
    consume,
  };
}

describe('AccountLifecycleService', () => {
  it('reintenta P2034 y SQLSTATE 40001 de forma estructurada y acotada', async () => {
    const transient = { code: 'P2034' };
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue('ok');
    await expect(withSerializableRetry(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);

    expect(isSerializationFailure({ cause: { meta: { code: '40001' } } })).toBe(true);
    expect(isSerializationFailure({ code: '08006' })).toBe(false);
    expect(isSerializationFailure({ meta: { code: '42601' } })).toBe(false);

    const persistent = vi.fn<() => Promise<void>>().mockRejectedValue({ meta: { code: '40001' } });
    await expect(withSerializableRetry(persistent)).rejects.toMatchObject({
      meta: { code: '40001' },
    });
    expect(persistent).toHaveBeenCalledTimes(SERIALIZABLE_MAX_ATTEMPTS);

    const uniqueGeneration = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        code: 'P2002',
        meta: {
          modelName: 'AccountToken',
          target: ['purpose', 'user_id', 'generation'],
        },
      })
      .mockResolvedValue('created');
    await expect(
      withSerializableRetry(uniqueGeneration, isRetryableAccountTokenGenerationConflict),
    ).resolves.toBe('created');
    expect(uniqueGeneration).toHaveBeenCalledTimes(2);

    const persistentGeneration = vi.fn<() => Promise<void>>().mockRejectedValue({
      code: 'P2002',
      meta: {
        modelName: 'AccountToken',
        target: ['purpose', 'user_id', 'generation'],
      },
    });
    await expect(
      withSerializableRetry(persistentGeneration, isRetryableAccountTokenGenerationConflict),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(persistentGeneration).toHaveBeenCalledTimes(SERIALIZABLE_MAX_ATTEMPTS);
  });

  it.each([
    ['User.email', { code: 'P2002', meta: { modelName: 'User', target: ['email'] } }],
    [
      'OutboxEvent.accountTokenId',
      { code: 'P2002', meta: { modelName: 'OutboxEvent', target: ['account_token_id'] } },
    ],
    ['AccountToken.id', { code: 'P2002', meta: { modelName: 'AccountToken', target: ['id'] } }],
    [
      'índice de invitación',
      {
        code: 'P2002',
        meta: {
          modelName: 'AccountToken',
          target: ['purpose', 'invitation_id', 'generation'],
        },
      },
    ],
    ['sin meta', { code: 'P2002' }],
    ['sin modelName', { code: 'P2002', meta: { target: ['purpose', 'user_id', 'generation'] } }],
    ['target vacío', { code: 'P2002', meta: { modelName: 'AccountToken', target: [] } }],
    [
      'target parcial',
      { code: 'P2002', meta: { modelName: 'AccountToken', target: ['purpose', 'user_id'] } },
    ],
    [
      'target correcto con campo extra',
      {
        code: 'P2002',
        meta: {
          modelName: 'AccountToken',
          target: ['purpose', 'user_id', 'generation', 'id'],
        },
      },
    ],
    [
      'otro código Prisma',
      {
        code: 'P2003',
        meta: {
          modelName: 'AccountToken',
          target: ['purpose', 'user_id', 'generation'],
        },
      },
    ],
  ] as const)('no reintenta P2002 ajeno: %s', async (_case, failure) => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    await expect(
      withSerializableRetry(operation, isRetryableAccountTokenGenerationConflict),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rechaza campos desconocidos y tipos inválidos en todos los DTO', () => {
    const { lifecycle } = service({});
    expect(() => lifecycle.parseEmptyBody({ userId: 'no' })).toThrow();
    expect(() => lifecycle.parseEmailBody({ email: 'a@example.test', status: 'ACTIVE' })).toThrow();
    expect(() =>
      lifecycle.parseResetPasswordBody({ token: 'x', password: 'y', sessionId: 'no' }),
    ).toThrow();
    expect(() =>
      lifecycle.parseChangePasswordBody({
        currentPassword: 'x',
        newPassword: 'y',
        actor: 'no',
      }),
    ).toThrow();
  });

  it('canoniza email y aplica exactamente EMAIL, IP y EMAIL_IP a solicitudes públicas', async () => {
    const { lifecycle, consume } = service({
      prisma: { user: { findUnique: vi.fn().mockResolvedValue(null) } },
    });
    const email = 'persona@example.test';
    await lifecycle.resendVerification(
      lifecycle.parseEmailBody({ email: '  PERSONA@EXAMPLE.TEST ' }),
      '127.0.0.1',
    );
    expect(consume).toHaveBeenLastCalledWith([
      expect.objectContaining({ action: 'RESEND_VERIFICATION', dimension: 'EMAIL', value: email }),
      expect.objectContaining({ action: 'RESEND_VERIFICATION', dimension: 'IP' }),
      expect.objectContaining({ action: 'RESEND_VERIFICATION', dimension: 'EMAIL_IP' }),
    ]);
    await lifecycle.forgotPassword({ email }, '127.0.0.1');
    expect(consume).toHaveBeenLastCalledWith([
      expect.objectContaining({ action: 'FORGOT_PASSWORD', dimension: 'EMAIL' }),
      expect.objectContaining({ action: 'FORGOT_PASSWORD', dimension: 'IP' }),
      expect.objectContaining({ action: 'FORGOT_PASSWORD', dimension: 'EMAIL_IP' }),
    ]);
  });

  it('falla cerrado antes de cualquier efecto si el limitador persistente no está disponible', async () => {
    const findUnique = vi.fn();
    const consume = vi.fn().mockRejectedValue(securityDependencyUnavailable());
    const { lifecycle } = service({ prisma: { user: { findUnique } } }, consume);
    await expect(
      lifecycle.forgotPassword({ email: 'persona@example.test' }, '127.0.0.1'),
    ).rejects.toMatchObject({ status: 503, code: 'SECURITY_DEPENDENCY_UNAVAILABLE' });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
