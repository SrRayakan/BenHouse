import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { createPrismaClient } from './prisma-client';

describe('C1.1 integridad geográfica PostgreSQL/PostGIS', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = createPrismaClient();
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(rows[0]?.name).toBe('benhouse_test');
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // Toda prueba termina en rollback, también cuando una aserción falla. No borra históricos.
  async function isolated(work: (tx: Prisma.TransactionClient) => Promise<void>) {
    const rollback = new Error('Rollback del fixture C1.1');
    try {
      await prisma.$transaction(async (tx) => {
        await work(tx);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
  async function root(tx: Prisma.TransactionClient) {
    return tx.location.create({
      data: {
        code: `synthetic-${randomUUID()}`,
        name: 'País sintético',
        kind: 'COUNTRY',
        demoSynthetic: true,
      },
    });
  }

  it('conserva Property sin ubicación, admite jerarquía y usa longitud/latitud SRID 4326', async () => {
    await isolated(async (tx) => {
      const property = await tx.property.create({ data: { type: 'HOUSE' } });
      expect(property).toMatchObject({ locationId: null, locationVersion: 0, streetName: null });
      const country = await root(tx);
      const municipality = await tx.location.create({
        data: {
          code: `synthetic-${randomUUID()}`,
          name: 'Municipio sintético',
          kind: 'MUNICIPALITY',
          parentLocationId: country.id,
          parentKind: 'COUNTRY',
          demoSynthetic: true,
        },
      });
      await tx.$executeRaw`UPDATE property SET location_id = ${municipality.id}::uuid,
        location_point = ST_SetSRID(ST_MakePoint(-1.25, 2.5),4326) WHERE id = ${property.id}::uuid`;
      const rows = await tx.$queryRaw<Array<{ x: number; y: number; srid: number }>>`
        SELECT ST_X(location_point) AS x, ST_Y(location_point) AS y, ST_SRID(location_point) AS srid
        FROM property WHERE id = ${property.id}::uuid`;
      expect(rows).toEqual([{ x: -1.25, y: 2.5, srid: 4326 }]);
    });
  });

  it.each([
    'missing-parent',
    'wrong-parent-kind',
    'same-level',
    'cycle',
    'root-with-parent',
    'nonroot-without-parent',
  ])('rechaza jerarquía %s incluso mediante escritura directa', async (scenario) => {
    await isolated(async (tx) => {
      const country = await root(tx);
      const child = await tx.location.create({
        data: {
          code: `synthetic-${randomUUID()}`,
          name: 'Provincia sintética',
          kind: 'PROVINCE',
          parentLocationId: country.id,
          parentKind: 'COUNTRY',
          demoSynthetic: true,
        },
      });
      if (scenario === 'cycle') {
        await expect(
          tx.location.update({
            where: { id: country.id },
            data: {
              parentLocationId: child.id,
              parentKind: 'PROVINCE',
            },
          }),
        ).rejects.toThrow();
        return;
      }
      await expect(
        tx.location.create({
          data: {
            code: `synthetic-${randomUUID()}`,
            name: 'Nodo sintético',
            demoSynthetic: true,
            kind: scenario === 'root-with-parent' ? 'COUNTRY' : 'PROVINCE',
            parentLocationId:
              scenario === 'nonroot-without-parent'
                ? null
                : scenario === 'missing-parent'
                  ? randomUUID()
                  : scenario === 'same-level'
                    ? child.id
                    : country.id,
            parentKind:
              scenario === 'nonroot-without-parent'
                ? null
                : scenario === 'wrong-parent-kind'
                  ? 'AUTONOMOUS_COMMUNITY'
                  : scenario === 'same-level'
                    ? 'PROVINCE'
                    : 'COUNTRY',
          },
        }),
      ).rejects.toThrow();
    });
  });

  it.each([
    'missing-location',
    'delete-referenced-location',
    'private-without-location',
    'negative-version',
    'unit-without-street',
  ])('protege Property: %s', async (scenario) => {
    await isolated(async (tx) => {
      const country = await root(tx);
      const property = await tx.property.create({
        data: { type: 'HOUSE', locationId: country.id },
      });
      if (scenario === 'delete-referenced-location') {
        await expect(tx.location.delete({ where: { id: country.id } })).rejects.toThrow();
        return;
      }
      const data =
        scenario === 'missing-location'
          ? { locationId: randomUUID() }
          : scenario === 'private-without-location'
            ? { locationId: null, postalCode: 'SYNTH' }
            : scenario === 'negative-version'
              ? { locationVersion: -1 }
              : { addressUnit: 'SYNTH' };
      await expect(tx.property.update({ where: { id: property.id }, data })).rejects.toThrow();
    });
  });

  it.each([
    'SRID=4326;POINT(181 0)',
    'SRID=4326;POINT(0 91)',
    'SRID=4326;POINT EMPTY',
    'SRID=4326;POINT(NaN 0)',
    'SRID=3857;POINT(0 0)',
    'SRID=4326;LINESTRING(0 0,1 1)',
  ])('rechaza geometría inválida %s', async (point) => {
    await isolated(async (tx) => {
      const country = await root(tx);
      await expect(
        tx.$executeRaw`UPDATE location SET centroid = ST_GeomFromEWKT(${point}) WHERE id = ${country.id}::uuid`,
      ).rejects.toThrow();
    });
  });

  it('mantiene índices GIST en ambos puntos', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
      AND indexname IN ('location_centroid_idx','property_location_point_idx')`;
    expect(indexes).toHaveLength(2);
    for (const index of indexes) expect(index.indexdef).toContain('USING gist');
  });
});
