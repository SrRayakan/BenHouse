import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadRootEnvironment } from './with-root-environment.mjs';
import {
  createTestChildEnvironment,
  verifyPhysicalDatabaseIsolation,
} from './with-test-database.mjs';

const hardenedRunner = resolve(import.meta.dirname, 'with-test-database.mjs');
const schema = resolve(import.meta.dirname, '../prisma/schema.prisma');

export function assertOwnedDatabase(name, expectedOid, actualOid) {
  if (
    !/^benhouse_worker_[a-f0-9]{32}_test$/.test(name) ||
    !expectedOid ||
    expectedOid !== actualOid
  )
    throw new Error('Identidad de base temporal no autorizada.');
}

function run(arguments_, environment) {
  const result = spawnSync(process.execPath, [hardenedRunner, ...arguments_], {
    env: environment,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw new Error('Falló el comando de validación del worker.');
}

export async function runWorkerTests(arguments_, environment = process.env) {
  // Primero aplica todas las barreras del runner común, sin crear ni modificar bases.
  createTestChildEnvironment(environment);
  await verifyPhysicalDatabaseIsolation(environment);
  const sharedUrl = environment.TEST_DATABASE_URL;
  const name = `benhouse_worker_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(sharedUrl);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'public');
  const childEnvironment = {
    ...environment,
    TEST_DATABASE_URL: url.toString(),
    WORKER_SHARED_TEST_DATABASE_URL: sharedUrl,
    WORKER_TEST_DATABASE_NAME: name,
  };
  createTestChildEnvironment(childEnvironment);
  const admin = new PrismaClient({ datasourceUrl: sharedUrl });
  let ownedOid;
  let created = false;
  const errors = [];
  try {
    const [identity] = await admin.$queryRaw`
      SELECT current_database() AS name, d.oid::text AS oid,
             inet_server_addr()::text AS host, inet_server_port() AS port,
             c.system_identifier::text AS system
      FROM pg_database d CROSS JOIN pg_control_system() c WHERE datname=current_database()
    `;
    if (identity?.name !== 'benhouse_test') throw new Error('Base compartida no autorizada.');
    console.log(
      `Worker: origen ${identity.name}, ${identity.host}:${identity.port}, OID ${identity.oid}, sistema ${identity.system}.`,
    );
    // Identificador generado internamente, nunca recibido por CLI/env. No IF NOT EXISTS.
    assertOwnedDatabase(name, 'new', 'new');
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const [row] =
      await admin.$queryRaw`SELECT oid::text AS oid FROM pg_database WHERE datname=${name}`;
    ownedOid = row?.oid;
    assertOwnedDatabase(name, ownedOid, row?.oid);
    await verifyPhysicalDatabaseIsolation(childEnvironment);
    await verifyPhysicalDatabaseIsolation({
      DATABASE_URL: sharedUrl,
      TEST_DATABASE_URL: url.toString(),
    });
    childEnvironment.WORKER_TEST_DATABASE_OID = ownedOid;
    console.log(
      `Worker: base temporal ${name}, OID ${ownedOid}; distinta de dev y test compartida.`,
    );
    run(['prisma', 'migrate', 'deploy', '--schema', schema], childEnvironment);
    run(
      ['vitest', 'run', '--config', 'vitest.integration.config.mts', ...arguments_],
      childEnvironment,
    );
  } catch {
    // No propagar errores del driver ni URLs/credenciales.
    errors.push(new Error('Falló la preparación o ejecución de la suite worker.'));
  } finally {
    try {
      if (created) {
        const [row] =
          await admin.$queryRaw`SELECT oid::text AS oid FROM pg_database WHERE datname=${name}`;
        assertOwnedDatabase(name, ownedOid, row?.oid);
        // Sin FORCE: una conexión residual impide borrar y hace fallar la suite.
        await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
        console.log(`Worker: base temporal eliminada ${name}; sin conexiones residuales.`);
      }
    } catch {
      errors.push(
        new Error(
          `No se pudo limpiar la base temporal ${name}; revisar su identidad y conexiones.`,
        ),
      );
    } finally {
      try {
        await admin.$disconnect();
      } catch {
        errors.push(new Error('Falló la desconexión del administrador de fixtures.'));
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Suite worker o limpieza fallida.');
}

if (import.meta.main) {
  loadRootEnvironment();
  await runWorkerTests(process.argv.slice(2));
}
