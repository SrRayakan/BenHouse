import { describe, expect, it } from 'vitest';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';
import { createPrismaClient, verifyDatabaseInfrastructure } from './prisma-client';

describe('infraestructura PostgreSQL/PostGIS', () => {
  it('permite Prisma, SELECT 1 y PostGIS', async () => {
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
