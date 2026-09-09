import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig, AuthRateLimitPolicyName, RateLimitPolicy } from '@benhouse/config';
import { AuthService } from './auth.service';
import { PasswordEngine } from './password';
import { SystemClock } from './clock';

const policy: RateLimitPolicy = { limit: 10, windowSeconds: 60, blockSeconds: 60 };
const policyNames: AuthRateLimitPolicyName[] = [
  'REGISTER_EMAIL',
  'REGISTER_IP',
  'REGISTER_EMAIL_IP',
  'LOGIN_EMAIL',
  'LOGIN_IP',
  'LOGIN_EMAIL_IP',
  'VERIFY_EMAIL_TOKEN',
  'VERIFY_EMAIL_IP',
  'VERIFY_EMAIL_TOKEN_IP',
  'SESSION_READ_IP',
];
const keyring = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 1)]]) };
const config: AuthConfig = {
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
  argon2: { memoryKiB: 8192, passes: 2, parallelism: 2 },
  rateLimits: Object.fromEntries(policyNames.map((name) => [name, policy])) as Record<
    AuthRateLimitPolicyName,
    RateLimitPolicy
  >,
  rateLimitCleanupIntervalSeconds: 300,
  rateLimitCleanupBatchSize: 500,
  trustProxyHops: 0,
};

describe('AuthService', () => {
  it('ejecuta la ruta Argon2 ficticia cuando el usuario no existe', async () => {
    const passwords = new PasswordEngine(config.argon2);
    const verify = vi.spyOn(passwords, 'verifyForLogin');
    const database = {
      prisma: { user: { findUnique: vi.fn().mockResolvedValue(null) } },
    };
    const rateLimits = { consume: vi.fn().mockResolvedValue(undefined) };
    const auth = new AuthService(
      database as never,
      rateLimits as never,
      new SystemClock(),
      config,
      passwords,
    );
    const error = await auth
      .login(
        auth.parseLoginBody({
          email: 'inexistente@example.test',
          password: 'Una contraseña inexistente 🔐',
        }),
        '127.0.0.1',
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    expect(verify).toHaveBeenCalledWith('Una contraseña inexistente 🔐', undefined);
  });

  it('aplica exactamente las dimensiones persistentes de cada endpoint B1.2', async () => {
    const passwords = new PasswordEngine(config.argon2);
    const rateLimits = { consume: vi.fn().mockResolvedValue(undefined) };
    const database = {
      prisma: {
        user: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
          operation({ user: { findUnique: vi.fn().mockResolvedValue({ id: 'existing' }) } }),
        ),
      },
    };
    const auth = new AuthService(
      database as never,
      rateLimits as never,
      new SystemClock(),
      config,
      passwords,
    );
    const email = 'dimension@example.test';
    await auth.register(
      auth.parseRegisterBody({
        email,
        displayName: 'Dimensiones',
        password: 'Una contraseña de dimensiones 🔐',
      }),
      '127.0.0.1',
    );
    expect(rateLimits.consume).toHaveBeenLastCalledWith([
      expect.objectContaining({ action: 'REGISTER', dimension: 'EMAIL' }),
      expect.objectContaining({ action: 'REGISTER', dimension: 'IP' }),
      expect.objectContaining({ action: 'REGISTER', dimension: 'EMAIL_IP' }),
    ]);
    await auth
      .login(
        auth.parseLoginBody({ email, password: 'Una contraseña de dimensiones 🔐' }),
        '127.0.0.1',
      )
      .catch(() => undefined);
    expect(rateLimits.consume).toHaveBeenLastCalledWith([
      expect.objectContaining({ action: 'LOGIN', dimension: 'EMAIL' }),
      expect.objectContaining({ action: 'LOGIN', dimension: 'IP' }),
      expect.objectContaining({ action: 'LOGIN', dimension: 'EMAIL_IP' }),
    ]);
    await auth.verifyEmail('malformado', '127.0.0.1').catch(() => undefined);
    expect(rateLimits.consume).toHaveBeenLastCalledWith([
      expect.objectContaining({ action: 'VERIFY_EMAIL', dimension: 'TOKEN' }),
      expect.objectContaining({ action: 'VERIFY_EMAIL', dimension: 'IP' }),
      expect.objectContaining({ action: 'VERIFY_EMAIL', dimension: 'TOKEN_IP' }),
    ]);
    await auth.getSession(undefined, '127.0.0.1');
    expect(rateLimits.consume).toHaveBeenLastCalledWith([
      expect.objectContaining({ action: 'SESSION_READ', dimension: 'IP' }),
    ]);
  });
});
