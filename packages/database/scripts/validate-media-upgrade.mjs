// Validación de upgrade exclusivamente en una base creada por el runner verificado.
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadRootEnvironment } from './with-root-environment.mjs';
import { runEphemeralTests } from './with-ephemeral-test-database.mjs';

const previous = [
  '20260904000000_enable_postgis',
  '20260906231526_identity_core',
  '20260924000000_property_draft_listing_core',
  '20260927000000_property_authorization_scheduled_revocation',
  '20261011000000_location_core',
];
const prisma = resolve(import.meta.dirname, '../node_modules/prisma/build/index.js');
const schema = resolve(import.meta.dirname, '../prisma/schema.prisma');
function cli(args, env) {
  const r = spawnSync(process.execPath, [prisma, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.status !== 0) throw new Error('Falló la validación Prisma de la base efímera.');
  return r.stdout;
}
async function snapshot(client) {
  const rows = await client.$queryRawUnsafe(`
    SELECT 'user' kind, id::text, row_to_json(t)::jsonb::text value, xmin::text revision FROM "user" t
    UNION ALL SELECT 'property',id::text,(row_to_json(t)::jsonb - 'media_version')::text,xmin::text FROM property t
    UNION ALL SELECT 'property_authorization',id::text,row_to_json(t)::jsonb::text,xmin::text FROM property_authorization t
    UNION ALL SELECT 'location',id::text,row_to_json(t)::jsonb::text,xmin::text FROM location t
    UNION ALL SELECT 'migration',id::text,row_to_json(t)::jsonb::text,xmin::text FROM _prisma_migrations t WHERE migration_name <> '20261013000000_property_media'
    ORDER BY kind,id`);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
loadRootEnvironment();
const root = await mkdtemp(join(tmpdir(), 'benhouse-c12-upgrade-'));
try {
  const old = join(root, 'schema.prisma');
  await writeFile(
    old,
    'datasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\n',
  );
  await mkdir(join(root, 'migrations'));
  for (const name of previous)
    await cp(
      resolve(import.meta.dirname, '../prisma/migrations', name),
      join(root, 'migrations', name),
      { recursive: true },
    );
  await cp(
    resolve(import.meta.dirname, '../prisma/migrations/migration_lock.toml'),
    join(root, 'migrations/migration_lock.toml'),
  );
  await runEphemeralTests('api', [], process.env, {
    run: async (command, _args, env) => {
      if (command === 'vitest') return; // Esta validación reemplaza pruebas por upgrade + comparación.
      cli(['migrate', 'deploy', '--schema', old], env);
      const client = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
      try {
        const user = randomUUID(),
          property = randomUUID(),
          location = randomUUID(),
          auth = randomUUID();
        await client.$executeRaw`INSERT INTO "user" (id,email,display_name,updated_at) VALUES (${user}::uuid,${`${user}@example.test`},'Usuario sintético upgrade',clock_timestamp())`;
        await client.$executeRaw`INSERT INTO location (id,code,name,kind,demo_synthetic,updated_at) VALUES (${location}::uuid,${location},'País sintético','COUNTRY',true,clock_timestamp())`;
        await client.$executeRaw`INSERT INTO property (id,type,location_id,location_point,updated_at) VALUES (${property}::uuid,'HOUSE',${location}::uuid,ST_SetSRID(ST_MakePoint(-3.7,40.4),4326),clock_timestamp())`;
        await client.$executeRaw`INSERT INTO property_authorization (id,property_id,user_id,authorization_type,granted_by_user_id,updated_at) VALUES (${auth}::uuid,${property}::uuid,${user}::uuid,'OWNER',${user}::uuid,clock_timestamp())`;
        const before = await snapshot(client);
        cli(['migrate', 'deploy', '--schema', schema], env);
        if (before !== (await snapshot(client)))
          throw new Error('El upgrade alteró filas o migraciones históricas.');
        const row = await client.property.findUniqueOrThrow({ where: { id: property } });
        if (row.mediaVersion !== 0 || (await client.media.count()) !== 0)
          throw new Error('Valores iniciales de Media incorrectos.');
        const url = new URL(env.DATABASE_URL);
        url.searchParams.set('options', '-c default_transaction_read_only=on');
        const drift = cli(
          [
            'migrate',
            'diff',
            '--from-url',
            url.toString(),
            '--to-schema-datamodel',
            schema,
            '--exit-code',
          ],
          env,
        );
        if (!drift.includes('No difference detected')) throw new Error('Drift inesperado.');
        console.log(
          'C1.2 upgrade: cinco migraciones históricas y cuatro filas sintéticas conservadas (contenido y xmin); mediaVersion=0; Media vacía; drift=0.',
        );
      } finally {
        await client.$disconnect();
      }
    },
  });
} finally {
  await rm(root, { recursive: true });
  console.log('C1.2 upgrade: directorio temporal propio eliminado.');
}
