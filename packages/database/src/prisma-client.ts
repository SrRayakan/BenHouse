import { PrismaClient } from '@prisma/client';

export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}

export async function verifyDatabaseConnection(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}

export async function verifyPostgis(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT PostGIS_Version()`;
}

export async function verifyDatabaseInfrastructure(client: PrismaClient): Promise<void> {
  await verifyDatabaseConnection(client);
  await verifyPostgis(client);
}
