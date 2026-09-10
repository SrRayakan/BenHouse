import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Argon2Config, VersionedKeyring } from '@benhouse/config';
import { canonicalizeEmail } from './email';
import { validateDisplayName } from './input-validation';
import {
  PASSWORD_BLOCKLIST_VERSION,
  PasswordEngine,
  createDummyPasswordHash,
  hashPassword,
  passwordNeedsRehash,
  validatePassword,
  verifyPassword,
} from './password';
import { constantTimeEqual, hmacSha256, lengthPrefixed } from './crypto-encoding';
import {
  createAccountTokenMaterial,
  parseAccountToken,
  verifyAccountTokenAuthenticator,
} from './account-token';
import {
  createSessionToken,
  parseSessionToken,
  sessionSecretDigest,
  verifySessionSecret,
} from './session-token';
import { deriveCsrfToken, verifyCsrfToken } from './csrf';
import { canonicalizeIp } from './ip';
import { clearCookieOptions, cookieOptions } from './auth.controller';

const argon: Argon2Config = { memoryKiB: 8192, passes: 2, parallelism: 2 };
const keys = (currentVersion = 2): VersionedKeyring => ({
  currentVersion,
  keys: new Map([
    [1, Buffer.alloc(32, 1)],
    [2, Buffer.alloc(32, 2)],
  ]),
});

describe('primitivas B1.2', () => {
  it('canoniza email una sola vez sin reglas específicas de proveedor', () => {
    expect(canonicalizeEmail('  Nombre+tag@BÜCHER.example  ')).toBe(
      'nombre+tag@xn--bcher-kva.example',
    );
    expect(canonicalizeEmail('a.b+tag@gmail.com')).toBe('a.b+tag@gmail.com');
  });

  it.each([
    'sin-arroba.example',
    '.inicio@example.com',
    'doble..punto@example.com',
    'á@example.com',
    `${'a'.repeat(250)}@example.com`,
  ])('rechaza email inválido: %s', (email) => {
    expect(() => canonicalizeEmail(email)).toThrow();
  });

  it('valida display name Unicode, trim y límites de bytes', () => {
    expect(validateDisplayName('  Benjamín 🏠  ')).toBe('Benjamín 🏠');
    expect(validateDisplayName('  Jose\u0301\t\n  Casa  ')).toBe('José Casa');
    expect(() => validateDisplayName(' '.repeat(10))).toThrow();
    expect(() => validateDisplayName('🟢'.repeat(61))).toThrow();
  });

  it('aplica política Unicode sin normalizar ni truncar', () => {
    const unicode = '🔐'.repeat(15);
    expect(validatePassword(unicode)).toBe(unicode);
    expect(validatePassword('clave segura con espacios')).toBe('clave segura con espacios');
    expect(validatePassword('e\u0301'.repeat(15))).toBe('e\u0301'.repeat(15));
    expect(() => validatePassword('corta')).toThrow();
    expect(() => validatePassword(' '.repeat(15))).toThrow();
    expect(() => validatePassword('a'.repeat(129))).toThrow();
    expect(validatePassword('🟢'.repeat(128))).toBe('🟢'.repeat(128));
  });

  it('mantiene blocklist local versionada', () => {
    expect(PASSWORD_BLOCKLIST_VERSION).toBe(1);
    expect(() => validatePassword('passwordpassword')).toThrow();
  });

  it('genera PHC Argon2id, verifica, detecta rehash y usa dummy equivalente', async () => {
    const password = 'contraseña realmente segura';
    const phc = await hashPassword(password, argon);
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=8192,t=2,p=2\$/);
    expect(phc.split('$').slice(-2).join('')).not.toMatch(/[-_=]/u);
    await expect(verifyPassword(password, phc)).resolves.toMatchObject({ valid: true });
    await expect(verifyPassword(`${password}!`, phc)).resolves.toMatchObject({ valid: false });
    expect(passwordNeedsRehash(phc, argon)).toBe(false);
    expect(passwordNeedsRehash(phc, { ...argon, passes: 3 })).toBe(true);
    const dummy = await createDummyPasswordHash(argon);
    expect(dummy).toMatch(/^\$argon2id\$v=19\$m=8192,t=2,p=2\$/);
    await expect(verifyPassword(password, dummy)).resolves.toMatchObject({ valid: false });
  });

  it('acepta un vector PHC estándar y rechaza variantes no canónicas o costosas', async () => {
    const vector =
      '$argon2id$v=19$m=8192,t=2,p=2$MDEyMzQ1Njc4OWFiY2RlZg$Lfz83byharzEIwclGubPCAc+3Z3N+99q5KhR9BlAkZc';
    await expect(verifyPassword('correct horse battery staple', vector)).resolves.toMatchObject({
      valid: true,
    });
    for (const invalid of [
      vector.replace('Lfz83', 'Lfz83='),
      vector.replace('MDEy', 'MDEy-'),
      vector.replace('MDEy', 'MDEy_'),
      vector.replace('m=8192', 'm=262145'),
      vector.replace('t=2', 't=11'),
      vector.replace('p=2', 'p=17'),
      vector.replace('m=8192', 'm=0008192'),
      vector.replace('m=8192', 'm=+8192'),
      vector.replace('m=8192', 'm=8e3'),
      vector.replace('m=8192', 'm=8192.0'),
      vector.replace('m=8192', `m=${'9'.repeat(200)}`),
      vector.replace('m=8192', 'm=9999999999'),
    ]) {
      await expect(verifyPassword('correct horse battery staple', invalid)).resolves.toEqual({
        valid: false,
      });
    }
  });

  it('absorbe un fallo inesperado de derivación del hash candidato y conserva la ruta dummy', async () => {
    let calls = 0;
    const engine = new PasswordEngine(argon, async () => {
      calls += 1;
      if (calls === 1) throw new Error('fallo nativo simulado');
      return { valid: false };
    });
    await expect(
      engine.verifyForLogin('correct horse battery staple', 'hash-corrupto'),
    ).resolves.toMatchObject({ valid: false, needsRehash: false });
    expect(calls).toBe(2);
  });

  it('ejecuta la ruta dummy también cuando el PHC no se puede parsear', async () => {
    const verifier = vi.fn().mockResolvedValue({ valid: false });
    const engine = new PasswordEngine(argon, verifier);
    await expect(
      engine.verifyForLogin('correct horse battery staple', 'PHC imposible'),
    ).resolves.toMatchObject({ valid: false });
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it('usa codificación length-prefixed y separación de dominio', () => {
    expect(lengthPrefixed('ab', 'c')).not.toEqual(lengthPrefixed('a', 'bc'));
    expect(hmacSha256(Buffer.alloc(32, 7), 'dominio-a', 'valor')).not.toEqual(
      hmacSha256(Buffer.alloc(32, 7), 'dominio-b', 'valor'),
    );
    expect(constantTimeEqual(Buffer.from('a'), Buffer.from('aa'))).toBe(false);
  });

  it('crea y parsea AccountToken sin persistir autenticador', () => {
    const created = createAccountTokenMaterial(randomUUID(), 3, keys());
    const parsed = parseAccountToken(created.token);
    expect(parsed?.selector).toBe(created.material.id);
    expect(parsed && verifyAccountTokenAuthenticator(parsed, created.material, keys())).toBe(true);
    expect(parseAccountToken(`${created.token}.extra`)).toBeUndefined();
    expect(parseAccountToken('v2.token')).toBeUndefined();
    expect(parsed && verifyAccountTokenAuthenticator(parsed, created.material, keys(1))).toBe(true);
    const withoutVersion: VersionedKeyring = {
      currentVersion: 1,
      keys: new Map([[1, Buffer.alloc(32, 1)]]),
    };
    expect(
      parsed && verifyAccountTokenAuthenticator(parsed, created.material, withoutVersion),
    ).toBe(false);
  });

  it('separa criptográficamente los propósitos de verificación y reset', () => {
    const userId = randomUUID();
    const verification = createAccountTokenMaterial(userId, 1, keys(), 'EMAIL_VERIFICATION');
    const reset = createAccountTokenMaterial(userId, 1, keys(), 'PASSWORD_RESET');
    const parsedReset = parseAccountToken(reset.token)!;
    expect(reset.material.purpose).toBe('PASSWORD_RESET');
    expect(verifyAccountTokenAuthenticator(parsedReset, reset.material, keys())).toBe(true);
    expect(verifyAccountTokenAuthenticator(parsedReset, verification.material, keys())).toBe(false);
  });

  it('parsea cookie estricta y autentica selector, secreto y versión', () => {
    const token = createSessionToken();
    const parsed = parseSessionToken(token.value);
    const digest = sessionSecretDigest(token.selector, token.secret, 2, keys());
    expect(parsed).toEqual({ selector: token.selector, secret: token.secret });
    expect(digest && verifySessionSecret(token.selector, token.secret, digest, 2, keys())).toBe(
      true,
    );
    expect(digest && verifySessionSecret(randomUUID(), token.secret, digest, 2, keys())).toBe(
      false,
    );
    expect(parseSessionToken(`${token.value}.extra`)).toBeUndefined();
  });

  it('deriva CSRF determinista, ligado a sesión y con versión autenticada', () => {
    const sessionId = randomUUID();
    const token = deriveCsrfToken(sessionId, 4, keys());
    expect(deriveCsrfToken(sessionId, 4, keys())).toBe(token);
    expect(verifyCsrfToken(token, sessionId, 4, keys())).toBe(true);
    expect(verifyCsrfToken(token, randomUUID(), 4, keys())).toBe(false);
    expect(verifyCsrfToken(`99.${token.split('.')[1]}`, sessionId, 4, keys())).toBe(false);
  });

  it.each([
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['127.0.0.1', '127.0.0.1'],
  ])('canoniza IP %s', (input, expected) => {
    expect(canonicalizeIp(input)).toBe(expected);
  });

  it('rechaza IP con zone id o texto arbitrario', () => {
    expect(canonicalizeIp('fe80::1%eth0')).toBeUndefined();
    expect(canonicalizeIp('usuario@example.com')).toBeUndefined();
  });

  it('fija cookie segura en producción y nombre separado en desarrollo', () => {
    const base = {
      appOrigin: 'https://benhouse.example',
      allowedOrigins: ['https://benhouse.example'],
      sessionCookieName: '__Host-benhouse-session',
      sessionCookieSecure: true,
      sessionAbsoluteTtlSeconds: 3600,
      sessionIdleTtlSeconds: 600,
      sessionLastSeenWriteIntervalSeconds: 60,
      sessionTokenKeys: keys(),
      csrfKeys: keys(),
      accountTokenKeys: keys(),
      rateLimitPepperKeys: keys(),
      emailVerificationTtlSeconds: 3600,
      passwordResetTtlSeconds: 1800,
      argon2: argon,
      rateLimits: {} as never,
      rateLimitCleanupIntervalSeconds: 300,
      rateLimitCleanupBatchSize: 500,
      trustProxyHops: 0,
    };
    expect(cookieOptions(base)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 3_600_000,
    });
    expect(
      cookieOptions({
        ...base,
        sessionCookieName: 'benhouse-local-session',
        sessionCookieSecure: false,
      }),
    ).toMatchObject({ secure: false });
    expect(clearCookieOptions(base)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
      expires: new Date(0),
    });
  });
});
