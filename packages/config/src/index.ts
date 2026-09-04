import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

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

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/([a-z0-9_]*(?:password|secret|token|database_url)[a-z0-9_]*)=([^\s&]+)/gi, '$1=[REDACTED]');
}
