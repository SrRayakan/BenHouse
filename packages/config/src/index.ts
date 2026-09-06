import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const MAX_REDACTION_DEPTH = 8;
const MAX_REDACTION_ARRAY_LENGTH = 100;
const REDACTED_VALUE = '[REDACTED]';
const REDACTION_DEPTH_LIMIT = '[REDACTED_DEPTH_LIMIT]';
const REDACTION_CIRCULAR_REFERENCE = '[REDACTED_CIRCULAR_REFERENCE]';
const REDACTION_TRUNCATED = '[REDACTED_TRUNCATED]';

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  apiPort: number;
  corsOrigin: string;
  logLevel: LogLevel;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new ConfigurationError(`Falta la variable de entorno crítica ${key}.`);
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
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError('DATABASE_URL no es una URL válida.');
  }
  return value;
}

function parseOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
      throw new ConfigurationError('CORS_ORIGIN debe ser un origen HTTP(S) sin ruta.');
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError('CORS_ORIGIN no es un origen válido.');
  }
  return value;
}

export function readAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = required(environment, 'NODE_ENV');
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new ConfigurationError('NODE_ENV debe ser development, test o production.');
  }

  const apiPort = Number(required(environment, 'API_PORT'));
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new ConfigurationError('API_PORT debe ser un puerto válido entre 1 y 65535.');
  }

  const logLevel = required(environment, 'LOG_LEVEL');
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new ConfigurationError('LOG_LEVEL debe ser debug, info, warn o error.');
  }

  return {
    nodeEnv,
    databaseUrl: parseDatabaseUrl(required(environment, 'DATABASE_URL')),
    apiPort,
    corsOrigin: parseOrigin(required(environment, 'CORS_ORIGIN')),
    logLevel: logLevel as LogLevel,
  };
}

export function loadLocalEnvironmentFile(path?: string): void {
  const resolvedPath = path ? resolve(path) : resolve(__dirname, '../../../.env');
  if (existsSync(resolvedPath)) {
    process.loadEnvFile(resolvedPath);
  }
}

function redactString(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/([a-z0-9_]*(?:password|secret|token|database_url)[a-z0-9_]*)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]');
}

function isSensitiveKey(key: string): boolean {
  return /(?:password|passwd|cookie|authorization|token|secret|api[_-]?key|database[_-]?url)/i.test(
    key,
  );
}

export function redactSensitiveValue(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return REDACTED_VALUE;
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return REDACTION_DEPTH_LIMIT;
  }
  if (seen.has(value)) {
    return REDACTION_CIRCULAR_REFERENCE;
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const values = value
      .slice(0, MAX_REDACTION_ARRAY_LENGTH)
      .map((entry) => redactValue(entry, depth + 1, seen));
    if (value.length > MAX_REDACTION_ARRAY_LENGTH) {
      values.push(REDACTION_TRUNCATED);
    }
    return values;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    };
  }

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
