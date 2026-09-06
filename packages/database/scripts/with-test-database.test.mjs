import { describe, expect, it } from 'vitest';
import { createTestChildEnvironment } from './with-test-database.mjs';

const validEnvironment = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://development-user:development-password@localhost:5432/benhouse',
  TEST_DATABASE_URL: 'postgresql://test-user:test-password@localhost:5432/benhouse_test',
  TEST_DATABASE_ALLOWED_HOSTS: 'localhost,127.0.0.1',
};

describe('with-test-database', () => {
  it('permite bases físicas diferentes y crea un entorno hijo sin modificar el padre', () => {
    const childEnvironment = createTestChildEnvironment(validEnvironment);

    expect(childEnvironment).toMatchObject({
      NODE_ENV: 'test',
      DATABASE_URL: validEnvironment.TEST_DATABASE_URL,
    });
    expect(validEnvironment).toMatchObject({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://development-user:development-password@localhost:5432/benhouse',
    });
  });

  it.each([
    ['production', { ...validEnvironment, NODE_ENV: 'production' }],
    [
      'destino equivalente con credenciales distintas',
      {
        ...validEnvironment,
        TEST_DATABASE_URL: 'postgres://other-user:other-password@LOCALHOST:5432/benhouse',
      },
    ],
    [
      'misma base física con schemas distintos',
      {
        ...validEnvironment,
        DATABASE_URL:
          'postgresql://development-user:development-password@localhost:5432/benhouse_test?schema=development',
        TEST_DATABASE_URL:
          'postgresql://test-user:test-password@localhost:5432/benhouse_test?schema=integration',
      },
    ],
    [
      'mismo puerto implícito y explícito',
      {
        ...validEnvironment,
        DATABASE_URL: 'postgresql://development-user:development-password@localhost/benhouse_test',
        TEST_DATABASE_URL:
          'postgresql://test-user:test-password@localhost:5432/benhouse_test',
      },
    ],
    [
      'protocolos postgres y postgresql equivalentes',
      {
        ...validEnvironment,
        DATABASE_URL: 'postgres://development-user:development-password@localhost/benhouse_test',
        TEST_DATABASE_URL:
          'postgresql://test-user:test-password@localhost:5432/benhouse_test',
      },
    ],
    ['URL malformada', { ...validEnvironment, TEST_DATABASE_URL: 'not-a-url' }],
    [
      'host fuera de política',
      {
        ...validEnvironment,
        TEST_DATABASE_URL: 'postgresql://test-user:test-password@db.example.test:5432/benhouse_test',
      },
    ],
    [
      'base sin sufijo de pruebas',
      {
        ...validEnvironment,
        TEST_DATABASE_URL: 'postgresql://test-user:test-password@localhost:5432/benhouse_staging',
      },
    ],
  ])('rechaza %s sin ejecutar procesos ni conectar a PostgreSQL', (_reason, environment) => {
    expect(() => createTestChildEnvironment(environment)).toThrow();
  });
});
