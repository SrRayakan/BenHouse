import { execute, loadRootEnvironment } from './with-root-environment.mjs';

const DEFAULT_ALLOWED_TEST_DATABASE_HOSTS = ['localhost', '127.0.0.1', '::1'];

function parsePostgresDestination(value, variableName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} debe ser una URL PostgreSQL válida.`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${variableName} debe usar PostgreSQL.`);
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName || databaseName.includes('/')) {
    throw new Error(`${variableName} debe incluir un nombre de base de datos válido.`);
  }

  return {
    host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
    port: url.port || '5432',
    databaseName,
  };
}

function sameDestination(left, right) {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.databaseName === right.databaseName
  );
}

function allowedTestDatabaseHosts(environment) {
  const configuredHosts = environment.TEST_DATABASE_ALLOWED_HOSTS;
  const hosts = configuredHosts
    ? configuredHosts.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWED_TEST_DATABASE_HOSTS;

  if (hosts.length === 0) {
    throw new Error('TEST_DATABASE_ALLOWED_HOSTS debe definir al menos un host de pruebas.');
  }
  return new Set(hosts);
}

export function createTestChildEnvironment(environment = process.env) {
  if (environment.NODE_ENV === 'production') {
    throw new Error('Las pruebas de integración no pueden ejecutarse con NODE_ENV=production.');
  }

  const databaseUrl = environment.DATABASE_URL;
  const testDatabaseUrl = environment.TEST_DATABASE_URL;
  if (!databaseUrl || !testDatabaseUrl) {
    throw new Error('DATABASE_URL y TEST_DATABASE_URL son obligatorias para las pruebas de integración.');
  }

  const developmentDestination = parsePostgresDestination(databaseUrl, 'DATABASE_URL');
  const testDestination = parsePostgresDestination(testDatabaseUrl, 'TEST_DATABASE_URL');
  if (sameDestination(developmentDestination, testDestination)) {
    throw new Error(
      'TEST_DATABASE_URL debe apuntar a un destino PostgreSQL distinto de DATABASE_URL.',
    );
  }

  if (!allowedTestDatabaseHosts(environment).has(testDestination.host)) {
    throw new Error('TEST_DATABASE_URL apunta a un host no permitido por la política de pruebas.');
  }

  if (!testDestination.databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL debe apuntar a una base cuyo nombre termine en _test.');
  }

  return {
    ...environment,
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl,
  };
}

if (import.meta.main) {
  loadRootEnvironment();
  const childEnvironment = createTestChildEnvironment();
  const [command, ...arguments_] = process.argv.slice(2);
  if (!command) {
    throw new Error('Debe indicarse un comando para ejecutar con TEST_DATABASE_URL.');
  }

  execute(command, arguments_, childEnvironment);
}
