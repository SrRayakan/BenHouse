import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const MAX_REDACTION_DEPTH = 8;
const MAX_REDACTION_ARRAY_LENGTH = 100;
const REDACTED_VALUE = '[REDACTED]';
const REDACTION_DEPTH_LIMIT = '[REDACTED_DEPTH_LIMIT]';
const REDACTION_CIRCULAR_REFERENCE = '[REDACTED_CIRCULAR_REFERENCE]';
const REDACTION_TRUNCATED = '[REDACTED_TRUNCATED]';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PUBLIC_AUTH_KEY_FINGERPRINTS = new Set([
  ...[0, 1, 2, 3, 7, 11, 12].map((byte) => keyFingerprint(Buffer.alloc(32, byte))),
  ...[11, 53, 97, 139].map((offset) =>
    keyFingerprint(Buffer.from(Array.from({ length: 32 }, (_, index) => (index + offset) % 256))),
  ),
]);

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface VersionedKeyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export interface Argon2Config {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
  blockSeconds: number;
}

export type AuthRateLimitPolicyName =
  | 'REGISTER_EMAIL'
  | 'REGISTER_IP'
  | 'REGISTER_EMAIL_IP'
  | 'LOGIN_EMAIL'
  | 'LOGIN_IP'
  | 'LOGIN_EMAIL_IP'
  | 'VERIFY_EMAIL_TOKEN'
  | 'VERIFY_EMAIL_IP'
  | 'VERIFY_EMAIL_TOKEN_IP'
  | 'RESEND_VERIFICATION_EMAIL'
  | 'RESEND_VERIFICATION_IP'
  | 'RESEND_VERIFICATION_EMAIL_IP'
  | 'FORGOT_PASSWORD_EMAIL'
  | 'FORGOT_PASSWORD_IP'
  | 'FORGOT_PASSWORD_EMAIL_IP'
  | 'RESET_PASSWORD_TOKEN'
  | 'RESET_PASSWORD_IP'
  | 'RESET_PASSWORD_TOKEN_IP'
  | 'LOGOUT_ALL_ACTOR'
  | 'LOGOUT_ALL_IP'
  | 'CHANGE_PASSWORD_ACTOR'
  | 'CHANGE_PASSWORD_IP'
  | 'SESSION_READ_IP';

export interface AuthConfig {
  appOrigin: string;
  allowedOrigins: readonly string[];
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  sessionAbsoluteTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  sessionLastSeenWriteIntervalSeconds: number;
  sessionTokenKeys: VersionedKeyring;
  csrfKeys: VersionedKeyring;
  accountTokenKeys: VersionedKeyring;
  rateLimitPepperKeys: VersionedKeyring;
  emailVerificationTtlSeconds: number;
  passwordResetTtlSeconds: number;
  argon2: Argon2Config;
  rateLimits: Readonly<Record<AuthRateLimitPolicyName, RateLimitPolicy>>;
  rateLimitCleanupIntervalSeconds: number;
  rateLimitCleanupBatchSize: number;
  trustProxyHops: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  apiPort: number;
  /** Alias compatible con consumidores anteriores; equivale a auth.appOrigin. */
  corsOrigin: string;
  corsAllowedOrigins: readonly string[];
  logLevel: LogLevel;
  auth: AuthConfig;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new ConfigurationError(`Falta la variable de entorno crítica ${key}.`);
  return value;
}

function parseInteger(
  environment: NodeJS.ProcessEnv,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(environment, key);
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} debe ser un entero decimal.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${key} debe estar entre ${minimum} y ${maximum}.`);
  }
  return value;
}

function parseDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new ConfigurationError('DATABASE_URL debe usar PostgreSQL.');
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('DATABASE_URL no es una URL válida.');
  }
  return value;
}

function parseOrigin(value: string, key: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
      throw new ConfigurationError(`${key} debe contener orígenes HTTP(S) absolutos sin ruta.`);
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`${key} contiene un origen inválido.`);
  }
  return value;
}

function parseOrigins(environment: NodeJS.ProcessEnv): readonly string[] {
  const origins = required(environment, 'CORS_ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => parseOrigin(origin.trim(), 'CORS_ALLOWED_ORIGINS'));
  if (origins.some((origin) => origin === '*') || new Set(origins).size !== origins.length) {
    throw new ConfigurationError('CORS_ALLOWED_ORIGINS no admite wildcard ni duplicados.');
  }
  return Object.freeze(origins);
}

function parseKeyring(
  environment: NodeJS.ProcessEnv,
  keysName: string,
  currentName: string,
): VersionedKeyring {
  const keys = new Map<number, Buffer>();
  for (const entry of required(environment, keysName).split(',')) {
    const match = /^(\d+):([A-Za-z0-9_-]+)$/.exec(entry.trim());
    if (!match) throw new ConfigurationError(`${keysName} tiene formato inválido.`);
    const version = Number(match[1]);
    const encoded = match[2] ?? '';
    if (!Number.isSafeInteger(version) || version < 1 || version > 32_767 || keys.has(version)) {
      throw new ConfigurationError(`${keysName} contiene una versión inválida o duplicada.`);
    }
    if (!BASE64URL_PATTERN.test(encoded))
      throw new ConfigurationError(`${keysName} no es Base64URL.`);
    const key = Buffer.from(encoded, 'base64url');
    if (key.length < 32 || key.toString('base64url') !== encoded) {
      throw new ConfigurationError(
        `${keysName} requiere claves Base64URL canónicas de al menos 32 bytes.`,
      );
    }
    keys.set(version, key);
  }
  const currentVersion = parseInteger(environment, currentName, 1, 32_767);
  if (!keys.has(currentVersion)) {
    throw new ConfigurationError(`${currentName} no está presente en ${keysName}.`);
  }
  return { currentVersion, keys };
}

function parseRateLimit(
  environment: NodeJS.ProcessEnv,
  name: AuthRateLimitPolicyName,
): RateLimitPolicy {
  const key = `AUTH_RATE_LIMIT_${name}`;
  const match = /^(\d+):(\d+):(\d+)$/.exec(required(environment, key));
  if (!match) {
    throw new ConfigurationError(`${key} debe usar limit:windowSeconds:blockSeconds.`);
  }
  const [limit, windowSeconds, blockSeconds] = match.slice(1).map(Number);
  if (
    !limit ||
    !windowSeconds ||
    !blockSeconds ||
    !Number.isSafeInteger(limit) ||
    !Number.isSafeInteger(windowSeconds) ||
    !Number.isSafeInteger(blockSeconds) ||
    limit > 1_000_000 ||
    windowSeconds > 2_592_000 ||
    blockSeconds > 2_592_000
  ) {
    throw new ConfigurationError(`${key} contiene límites inválidos.`);
  }
  return { limit, windowSeconds, blockSeconds };
}

export function readAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = required(environment, 'NODE_ENV');
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new ConfigurationError('NODE_ENV debe ser development, test o production.');
  }
  const apiPort = parseInteger(environment, 'API_PORT', 1, 65_535);
  const logLevel = required(environment, 'LOG_LEVEL');
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new ConfigurationError('LOG_LEVEL debe ser debug, info, warn o error.');
  }
  const appOrigin = parseOrigin(required(environment, 'APP_ORIGIN'), 'APP_ORIGIN');
  const corsAllowedOrigins = parseOrigins(environment);
  if (!corsAllowedOrigins.includes(appOrigin)) {
    throw new ConfigurationError(
      'APP_ORIGIN debe estar incluido exactamente en CORS_ALLOWED_ORIGINS.',
    );
  }
  const sessionCookieName = required(environment, 'SESSION_COOKIE_NAME');
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(sessionCookieName)) {
    throw new ConfigurationError('SESSION_COOKIE_NAME no es un nombre de cookie válido.');
  }
  if (nodeEnv === 'production' && sessionCookieName !== '__Host-benhouse-session') {
    throw new ConfigurationError('Producción exige SESSION_COOKIE_NAME=__Host-benhouse-session.');
  }
  if (nodeEnv !== 'production' && sessionCookieName.startsWith('__Host-')) {
    throw new ConfigurationError('Desarrollo/test debe usar un nombre sin prefijo __Host-.');
  }
  const sessionAbsoluteTtlSeconds = parseInteger(
    environment,
    'SESSION_ABSOLUTE_TTL_SECONDS',
    60,
    31_536_000,
  );
  const sessionIdleTtlSeconds = parseInteger(
    environment,
    'SESSION_IDLE_TTL_SECONDS',
    60,
    sessionAbsoluteTtlSeconds,
  );
  const sessionLastSeenWriteIntervalSeconds = parseInteger(
    environment,
    'SESSION_LAST_SEEN_WRITE_INTERVAL_SECONDS',
    1,
    sessionIdleTtlSeconds,
  );
  const rateLimitNames: readonly AuthRateLimitPolicyName[] = [
    'REGISTER_EMAIL',
    'REGISTER_IP',
    'REGISTER_EMAIL_IP',
    'LOGIN_EMAIL',
    'LOGIN_IP',
    'LOGIN_EMAIL_IP',
    'VERIFY_EMAIL_TOKEN',
    'VERIFY_EMAIL_IP',
    'VERIFY_EMAIL_TOKEN_IP',
    'RESEND_VERIFICATION_EMAIL',
    'RESEND_VERIFICATION_IP',
    'RESEND_VERIFICATION_EMAIL_IP',
    'FORGOT_PASSWORD_EMAIL',
    'FORGOT_PASSWORD_IP',
    'FORGOT_PASSWORD_EMAIL_IP',
    'RESET_PASSWORD_TOKEN',
    'RESET_PASSWORD_IP',
    'RESET_PASSWORD_TOKEN_IP',
    'LOGOUT_ALL_ACTOR',
    'LOGOUT_ALL_IP',
    'CHANGE_PASSWORD_ACTOR',
    'CHANGE_PASSWORD_IP',
    'SESSION_READ_IP',
  ];
  const rateLimits = Object.fromEntries(
    rateLimitNames.map((name) => [name, parseRateLimit(environment, name)]),
  ) as Record<AuthRateLimitPolicyName, RateLimitPolicy>;
  const sessionTokenKeys = parseKeyring(
    environment,
    'SESSION_TOKEN_KEYS',
    'SESSION_TOKEN_CURRENT_KEY_VERSION',
  );
  const csrfKeys = parseKeyring(environment, 'CSRF_KEYS', 'CSRF_CURRENT_KEY_VERSION');
  const accountTokenKeys = parseKeyring(
    environment,
    'ACCOUNT_TOKEN_KEYS',
    'ACCOUNT_TOKEN_CURRENT_KEY_VERSION',
  );
  const rateLimitPepperKeys = parseKeyring(
    environment,
    'AUTH_RATE_LIMIT_PEPPER_KEYS',
    'AUTH_RATE_LIMIT_CURRENT_PEPPER_VERSION',
  );
  const argon2 = {
    memoryKiB: parseInteger(environment, 'ARGON2_MEMORY_KIB', 8_192, 262_144),
    passes: parseInteger(environment, 'ARGON2_PASSES', 2, 10),
    parallelism: parseInteger(environment, 'ARGON2_PARALLELISM', 2, 16),
  };
  if (nodeEnv === 'production') {
    validateProductionAuth(
      [sessionTokenKeys, csrfKeys, accountTokenKeys, rateLimitPepperKeys],
      argon2,
    );
  }

  return {
    nodeEnv,
    databaseUrl: parseDatabaseUrl(required(environment, 'DATABASE_URL')),
    apiPort,
    corsOrigin: appOrigin,
    corsAllowedOrigins,
    logLevel: logLevel as LogLevel,
    auth: {
      appOrigin,
      allowedOrigins: corsAllowedOrigins,
      sessionCookieName,
      sessionCookieSecure: nodeEnv === 'production',
      sessionAbsoluteTtlSeconds,
      sessionIdleTtlSeconds,
      sessionLastSeenWriteIntervalSeconds,
      sessionTokenKeys,
      csrfKeys,
      accountTokenKeys,
      rateLimitPepperKeys,
      emailVerificationTtlSeconds: parseInteger(
        environment,
        'EMAIL_VERIFICATION_TTL_SECONDS',
        60,
        2_592_000,
      ),
      passwordResetTtlSeconds: parseInteger(environment, 'PASSWORD_RESET_TTL_SECONDS', 60, 86_400),
      argon2,
      rateLimits: Object.freeze(rateLimits),
      rateLimitCleanupIntervalSeconds: parseInteger(
        environment,
        'AUTH_RATE_LIMIT_CLEANUP_INTERVAL_SECONDS',
        10,
        86_400,
      ),
      rateLimitCleanupBatchSize: parseInteger(
        environment,
        'AUTH_RATE_LIMIT_CLEANUP_BATCH_SIZE',
        1,
        10_000,
      ),
      trustProxyHops: parseInteger(environment, 'TRUST_PROXY_HOPS', 0, 16),
    },
  };
}

function validateProductionAuth(keyrings: readonly VersionedKeyring[], argon2: Argon2Config): void {
  if (argon2.memoryKiB < 19_456 || argon2.passes < 2 || argon2.parallelism < 2) {
    throw new ConfigurationError('Producción exige una política Argon2id fuerte.');
  }
  const fingerprints = new Set<string>();
  for (const keyring of keyrings) {
    for (const key of keyring.keys.values()) {
      const fingerprint = keyFingerprint(key);
      const insufficientVariation = new Set(key).size < 16;
      if (
        insufficientVariation ||
        PUBLIC_AUTH_KEY_FINGERPRINTS.has(fingerprint) ||
        fingerprints.has(fingerprint)
      ) {
        throw new ConfigurationError(
          'Producción exige claves no ficticias y separadas entre dominios criptográficos.',
        );
      }
      fingerprints.add(fingerprint);
    }
  }
}

function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

export function loadLocalEnvironmentFile(path?: string): void {
  const resolvedPath = path ? resolve(path) : resolve(__dirname, '../../../.env');
  if (existsSync(resolvedPath)) process.loadEnvFile(resolvedPath);
}

function redactString(value: string): string {
  return value
    .replace(/\$argon2id\$[^\s'"`]+/g, '[REDACTED_PHC]')
    .replace(/\bv1\.[0-9a-f]{8}-[0-9a-f-]{27}\.[A-Za-z0-9_-]{43}\b/gi, '[REDACTED_ACCOUNT_TOKEN]')
    .replace(
      /(?<![A-Za-z0-9_-])[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gi,
      '[REDACTED_SESSION_TOKEN]',
    )
    .replace(
      /(?<![A-Za-z0-9_-])(?:[1-9]\d{0,4})\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
      '[REDACTED_CSRF_TOKEN]',
    )
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(
      /([a-z0-9_]*(?:password|secret|token|keyring|keys|pepper|database_url)[a-z0-9_]*)=([^\s&]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b(authorization|cookie|set-cookie|x-csrf-token)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]');
}

function isSensitiveKey(key: string): boolean {
  return /(?:password|passwd|cookie|authorization|token|secret|pepper|keyring|(?:^|[_-])keys?(?:$|[_-])|api[_-]?key|database[_-]?url|csrf)/i.test(
    key,
  );
}

export function redactSensitiveValue(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return REDACTED_VALUE;
  if (depth >= MAX_REDACTION_DEPTH) return REDACTION_DEPTH_LIMIT;
  if (seen.has(value)) return REDACTION_CIRCULAR_REFERENCE;
  seen.add(value);
  if (Array.isArray(value)) {
    const values = value
      .slice(0, MAX_REDACTION_ARRAY_LENGTH)
      .map((entry) => redactValue(entry, depth + 1, seen));
    if (value.length > MAX_REDACTION_ARRAY_LENGTH) values.push(REDACTION_TRUNCATED);
    return values;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error)
    return {
      name: redactString(value.name),
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
      ...('cause' in value ? { cause: redactValue(value.cause, depth + 1, seen) } : {}),
    };
  if (value instanceof Map || value instanceof Set || ArrayBuffer.isView(value))
    return REDACTED_VALUE;
  try {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? REDACTED_VALUE : redactValue(entry, depth + 1, seen),
      ]),
    );
  } catch {
    return REDACTED_VALUE;
  }
}
