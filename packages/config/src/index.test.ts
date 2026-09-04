import { describe, expect, it } from 'vitest';
import { ConfigurationError, readAppConfig, redactSensitiveValue } from './index';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://benhouse:secret@localhost:5432/benhouse_test',
  API_PORT: '3001',
  CORS_ORIGIN: 'http://localhost:3000',
  LOG_LEVEL: 'info',
};

describe('readAppConfig', () => {
  it('acepta una configuración válida', () => {
    expect(readAppConfig(validEnvironment)).toMatchObject({
      nodeEnv: 'test',
      apiPort: 3001,
      corsOrigin: 'http://localhost:3000',
      logLevel: 'info',
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
    'rechaza CORS_ORIGIN inválido: %s',
    (corsOrigin) => {
      expect(() => readAppConfig({ ...validEnvironment, CORS_ORIGIN: corsOrigin })).toThrow(
        ConfigurationError,
      );
    },
  );

  it('rechaza LOG_LEVEL inválido', () => {
    expect(() => readAppConfig({ ...validEnvironment, LOG_LEVEL: 'verbose' })).toThrow(
      ConfigurationError,
    );
  });

  it('redacta credenciales y secretos de logs', () => {
    expect(redactSensitiveValue(validEnvironment.DATABASE_URL)).not.toContain('secret');
    expect(redactSensitiveValue(validEnvironment.DATABASE_URL)).toBe('[REDACTED_DATABASE_URL]');
    expect(redactSensitiveValue('token=abc123')).toBe('token=[REDACTED]');
  });
});
