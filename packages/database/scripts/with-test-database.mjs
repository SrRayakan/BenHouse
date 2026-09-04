import { execute, loadRootEnvironment } from './with-root-environment.mjs';

loadRootEnvironment();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL es obligatoria para las pruebas de integración.');
}

if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL debe ser distinta de DATABASE_URL para proteger la base de desarrollo.',
  );
}

const [command, ...arguments_] = process.argv.slice(2);
if (!command) {
  throw new Error('Debe indicarse un comando para ejecutar con TEST_DATABASE_URL.');
}

process.env.DATABASE_URL = testDatabaseUrl;
execute(command, arguments_);
