import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createTestChildEnvironment } from './with-test-database.mjs';

const schema = resolve(import.meta.dirname, '../prisma/schema.prisma');
const cli = {
  prisma: resolve(import.meta.dirname, '../node_modules/prisma/build/index.js'),
  vitest: resolve(import.meta.dirname, '../../../node_modules/vitest/vitest.mjs'),
};
function assertSuite(suite) {
  if (!['api', 'worker'].includes(suite)) throw new Error('Suite efímera no autorizada.');
}
export function assertOwnedIdentity(suite, expected, actual) {
  assertSuite(suite);
  if (
    !new RegExp(`^benhouse_${suite}_[a-f0-9]{32}_test$`).test(expected?.name ?? '') ||
    !expected?.oid ||
    !expected?.system ||
    expected.name !== actual?.name ||
    expected.oid !== actual?.oid ||
    expected.system !== actual?.system
  )
    throw new Error('Identidad de base temporal no autorizada.');
}
function assertIdentity(identity, name) {
  if (identity?.name !== name || !identity?.oid || !identity?.system)
    throw new Error('Identidad PostgreSQL incompleta o incorrecta.');
}
function assertDistinct(left, right) {
  if (left.system === right.system && left.oid === right.oid)
    throw new Error('Las bases no están físicamente aisladas.');
}
export async function readIdentity(client) {
  const rows = await client.$queryRaw`
    SELECT current_database() AS name, d.oid::text AS oid,
           c.system_identifier::text AS system
    FROM pg_database d CROSS JOIN pg_control_system() c WHERE datname=current_database()
  `;
  if (rows.length !== 1) throw new Error('Identidad PostgreSQL no disponible.');
  return rows[0];
}
async function identityAt(url) {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    return await readIdentity(client);
  } finally {
    await client.$disconnect();
  }
}
function run(command, args, environment) {
  const result = spawnSync(process.execPath, [cli[command], ...args], {
    env: environment,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Falló ${command}; salida ${result.status ?? 'sin código'}.`);
}

// Dependencias inyectables solo para regresiones unitarias; la CLI usa estas implementaciones.
export async function runEphemeralTests(suite, args, environment = process.env, overrides = {}) {
  assertSuite(suite);
  createTestChildEnvironment(environment);
  const io = {
    identityAt,
    readIdentity,
    run,
    admin: (url) => new PrismaClient({ datasourceUrl: url }),
    log: (message) => console.log(message),
    ...overrides,
  };
  const name = `benhouse_${suite}_${randomUUID().replaceAll('-', '')}_test`;
  const sharedUrl = environment.TEST_DATABASE_URL;
  const url = new URL(sharedUrl);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'public');
  createTestChildEnvironment({ ...environment, TEST_DATABASE_URL: url.toString() });
  const prefix = suite.toUpperCase();
  let admin, owned, shared;
  let creationAttempted = false;
  let created = false;
  let phase = 'verificación de bases protegidas';
  const errors = [];
  try {
    const development = await io.identityAt(environment.DATABASE_URL);
    shared = await io.identityAt(sharedUrl);
    assertIdentity(development, 'benhouse');
    assertIdentity(shared, 'benhouse_test');
    assertDistinct(development, shared);
    admin = io.admin(sharedUrl);
    assertOwnedAdmin(await io.readIdentity(admin), shared);
    io.log(
      `${suite}: base propia prevista ${name}; protegidas ${development.name}/${development.oid} y ${shared.name}/${shared.oid}, sistema ${shared.system}.`,
    );
    phase = 'creación';
    creationAttempted = true;
    // Nombre generado aquí, no aceptado de CLI/env; no IF NOT EXISTS ni FORCE.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    phase = 'captura del OID propio';
    const [row] =
      await admin.$queryRaw`SELECT oid::text AS oid FROM pg_database WHERE datname=${name}`;
    owned = { name, oid: row?.oid, system: shared.system };
    assertOwnedIdentity(suite, owned, owned);
    phase = 'verificación física de la base propia';
    const actual = await io.identityAt(url.toString());
    assertOwnedIdentity(suite, owned, actual);
    assertDistinct(actual, development);
    assertDistinct(actual, shared);
    const child = {
      ...environment,
      NODE_ENV: 'test',
      DATABASE_URL: url.toString(),
      TEST_DATABASE_URL: url.toString(),
      [`${prefix}_TEST_DATABASE_NAME`]: name,
      [`${prefix}_TEST_DATABASE_OID`]: owned.oid,
      [`${prefix}_TEST_DATABASE_SYSTEM`]: owned.system,
      ...(suite === 'worker' ? { WORKER_SHARED_TEST_DATABASE_URL: sharedUrl } : {}),
    };
    io.log(
      `${suite}: identidad propia verificada ${name}, OID ${owned.oid}, sistema ${owned.system}.`,
    );
    phase = 'migraciones';
    await io.run('prisma', ['migrate', 'deploy', '--schema', schema], child);
    phase = 'verificación posterior a migraciones';
    assertOwnedIdentity(suite, owned, await io.identityAt(url.toString()));
    phase = 'pruebas';
    await io.run('vitest', ['run', '--config', 'vitest.integration.config.mts', ...args], child);
  } catch {
    errors.push(
      new Error(
        `${suite}: falló ${phase}; no se usa ninguna base alternativa. Base prevista: ${name}.`,
      ),
    );
  } finally {
    try {
      if (created) {
        // Ante preparación parcial sin OID conocido, no se adivina la propiedad.
        assertOwnedAdmin(await io.readIdentity(admin), shared);
        const [row] =
          await admin.$queryRaw`SELECT oid::text AS oid FROM pg_database WHERE datname=${name}`;
        assertOwnedIdentity(suite, owned, { name, oid: row?.oid, system: shared.system });
        await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
        const remaining =
          await admin.$queryRaw`SELECT oid::text AS oid FROM pg_database WHERE datname=${name}`;
        if (remaining.length)
          errors.push(new Error(`${suite}: la base propia ${name} sigue presente tras DROP.`));
        else io.log(`${suite}: base propia eliminada ${name}; sin conexiones residuales.`);
      } else if (creationAttempted) {
        io.log(
          `${suite}: creación no confirmada; revisar posible recurso ${name}. No se intenta borrarlo.`,
        );
      }
    } catch {
      errors.push(
        new Error(
          `${suite}: limpieza fallida o identidad no verificable de ${name}; recurso posiblemente residual, sin FORCE.`,
        ),
      );
    } finally {
      try {
        await admin?.$disconnect();
      } catch {
        errors.push(new Error(`${suite}: falló la desconexión del administrador.`));
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, `${suite}: preparación, pruebas o limpieza fallidas.`);
}
function assertOwnedAdmin(actual, expected) {
  if (
    !expected ||
    actual?.name !== expected.name ||
    actual?.oid !== expected.oid ||
    actual?.system !== expected.system
  )
    throw new Error('El administrador cambió de identidad.');
}
