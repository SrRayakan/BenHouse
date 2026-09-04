import { describe, expect, it } from 'vitest';
import { createPrismaClient, verifyDatabaseInfrastructure } from '@benhouse/database';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';

describe('infraestructura del worker', () => {
  it('conecta con PostgreSQL y PostGIS', async () => {
    loadLocalEnvironmentFile();
    readAppConfig();
    const client = createPrismaClient();

    try {
      await expect(verifyDatabaseInfrastructure(client)).resolves.toBeUndefined();
    } finally {
      await client.$disconnect();
    }
  });
});
