import { createPrismaClient } from '@benhouse/database';
import {
  assertOwnedIdentity,
  readIdentity,
} from '../../../packages/database/scripts/with-ephemeral-test-database.mjs';

const protectedVariables = [
  'NODE_ENV',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'API_TEST_DATABASE_NAME',
  'API_TEST_DATABASE_OID',
  'API_TEST_DATABASE_SYSTEM',
];

async function identityAt(url) {
  const client = createPrismaClient({ datasourceUrl: url });
  try {
    return await readIdentity(client);
  } finally {
    await client.$disconnect();
  }
}

export async function verifyApiTestDatabase(environment = process.env, read = identityAt) {
  const snapshot = Object.fromEntries(protectedVariables.map((key) => [key, environment[key]]));
  const expected = {
    name: snapshot.API_TEST_DATABASE_NAME,
    oid: snapshot.API_TEST_DATABASE_OID,
    system: snapshot.API_TEST_DATABASE_SYSTEM,
  };
  try {
    if (snapshot.NODE_ENV !== 'test') throw new Error();
    assertOwnedIdentity('api', expected, expected);
    for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
      const url = new URL(snapshot[key]);
      if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.pathname !== `/${expected.name}`
      )
        throw new Error();
    }
    if (snapshot.DATABASE_URL !== snapshot.TEST_DATABASE_URL) throw new Error();
    // No leer .env aquí: un proceso sin las expectativas del runner falla cerrado.
    for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
      assertOwnedIdentity('api', expected, await read(snapshot[key]));
      if (protectedVariables.some((key) => environment[key] !== snapshot[key])) throw new Error();
    }
  } catch {
    // No propagar errores del driver/URLs con credenciales.
    throw new Error(
      'API_TEST_DATABASE_GUARD: identidad efímera ausente, alterada o no verificada.',
    );
  }
}
