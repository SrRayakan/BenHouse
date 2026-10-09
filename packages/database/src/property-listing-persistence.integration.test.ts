import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPrismaClient } from './prisma-client';

describe('B1.6 persistencia PostgreSQL Property/Listing', () => {
  let prisma: PrismaClient;
  const ids = {
    users: [] as string[],
    organizations: [] as string[],
    properties: [] as string[],
  };

  beforeAll(async () => {
    prisma = createPrismaClient();
    const identity = await prisma.$queryRaw<Array<{ databaseName: string }>>`
      SELECT current_database() AS "databaseName"
    `;
    expect(identity[0]?.databaseName).toBe('benhouse_test');
  });

  afterAll(async () => {
    await prisma.listing.deleteMany({ where: { propertyId: { in: ids.properties } } });
    await prisma.propertyAuthorization.deleteMany({
      where: { propertyId: { in: ids.properties } },
    });
    await prisma.property.deleteMany({ where: { id: { in: ids.properties } } });
    await prisma.organization.deleteMany({ where: { id: { in: ids.organizations } } });
    await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    await prisma.$disconnect();
  });

  async function user() {
    const value = await prisma.user.create({
      data: {
        email: `b16-db-${randomUUID()}@example.test`,
        displayName: 'Fixture sintético B1.6',
        emailVerifiedAt: new Date(),
      },
    });
    ids.users.push(value.id);
    return value;
  }

  async function property() {
    const value = await prisma.property.create({ data: { type: 'APARTMENT' } });
    ids.properties.push(value.id);
    return value;
  }

  it('refuerza XOR de subjects y unicidad activa equivalente', async () => {
    const [grantor, subject] = await Promise.all([user(), user()]);
    const organization = await prisma.organization.create({
      data: { name: `B16 DB ${randomUUID()}`, createdByUserId: grantor.id },
    });
    ids.organizations.push(organization.id);
    const resource = await property();
    await expect(
      prisma.propertyAuthorization.create({
        data: {
          propertyId: resource.id,
          userId: subject.id,
          organizationId: organization.id,
          authorizationType: 'MANAGER',
          grantedByUserId: grantor.id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.propertyAuthorization.create({
        data: {
          propertyId: resource.id,
          authorizationType: 'MANAGER',
          grantedByUserId: grantor.id,
        },
      }),
    ).rejects.toThrow();
    await prisma.propertyAuthorization.create({
      data: {
        propertyId: resource.id,
        userId: subject.id,
        authorizationType: 'MANAGER',
        grantedByUserId: grantor.id,
      },
    });
    await expect(
      prisma.propertyAuthorization.create({
        data: {
          propertyId: resource.id,
          userId: subject.id,
          authorizationType: 'MANAGER',
          grantedByUserId: grantor.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  async function withScheduledAuthorization(
    callback: (data: {
      propertyId: string;
      userId: string;
      grantedByUserId: string;
      authorizationType: 'MANAGER';
      createdAt: Date;
      validFrom: Date;
      validUntil: Date;
    }) => Promise<void>,
  ) {
    const grantor = await user();
    const subject = await user();
    const resource = await property();
    try {
      const clock = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const createdAt = clock[0]!.now;
      await callback({
        propertyId: resource.id,
        userId: subject.id,
        grantedByUserId: grantor.id,
        authorizationType: 'MANAGER',
        createdAt,
        validFrom: new Date(createdAt.getTime() + 86_400_000),
        validUntil: new Date(createdAt.getTime() + 172_800_000),
      });
    } finally {
      await prisma.propertyAuthorization.deleteMany({ where: { propertyId: resource.id } });
      await prisma.property.delete({ where: { id: resource.id } });
      await prisma.user.deleteMany({ where: { id: { in: [grantor.id, subject.id] } } });
    }
  }

  it('admite revocación programada desde createdAt y libera el unique parcial', async () => {
    await withScheduledAuthorization(async (data) => {
      const scheduled = await prisma.propertyAuthorization.create({ data });
      const revoked = await prisma.propertyAuthorization.update({
        where: { id: scheduled.id },
        data: { status: 'REVOKED', revokedAt: data.createdAt },
      });
      expect(revoked.revokedAt).toEqual(data.createdAt);
      expect(revoked.revokedAt!.getTime()).toBeLessThan(data.validFrom.getTime());
      const replacement = await prisma.propertyAuthorization.create({ data });
      expect(replacement.status).toBe('ACTIVE');
      expect(
        await prisma.propertyAuthorization.count({ where: { propertyId: data.propertyId } }),
      ).toBe(2);
    });
  });

  it.each([
    'revoked-null',
    'revoked-before-created',
    'active-revoked',
    'expired-revoked',
    'invalid-validity',
  ] as const)(
    'rechaza estado o vigencia inválidos de autorización programada: %s',
    async (scenario) => {
      await withScheduledAuthorization(async (data) => {
        const status =
          scenario === 'active-revoked'
            ? ('ACTIVE' as const)
            : scenario === 'expired-revoked'
              ? ('EXPIRED' as const)
              : ('REVOKED' as const);
        const revokedAt =
          scenario === 'revoked-null'
            ? null
            : scenario === 'revoked-before-created'
              ? new Date(data.createdAt.getTime() - 1)
              : data.createdAt;
        await expect(
          prisma.propertyAuthorization.create({
            data: {
              ...data,
              status,
              revokedAt,
              ...(scenario === 'invalid-validity' ? { validUntil: data.validFrom } : {}),
            },
          }),
        ).rejects.toThrow(
          scenario === 'invalid-validity'
            ? /property_authorization_validity_chk/
            : /property_authorization_state_chk/,
        );
        expect(
          await prisma.propertyAuthorization.count({ where: { propertyId: data.propertyId } }),
        ).toBe(0);
      });
    },
  );

  it('refuerza XOR publisher, responsible member y SALE/RENT', async () => {
    const publisher = await user();
    const resource = await property();
    const base = {
      propertyId: resource.id,
      transactionType: 'SALE' as const,
      price: '100000.00',
      currency: 'EUR',
      description: 'Listing sintético de persistencia',
    };
    await expect(prisma.listing.create({ data: base })).rejects.toThrow();
    await expect(
      prisma.listing.create({
        data: { ...base, publisherUserId: publisher.id, responsibleMemberUserId: publisher.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.listing.create({
        data: { ...base, publisherUserId: publisher.id, rentalMode: 'LONG_TERM' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.listing.create({
        data: {
          ...base,
          publisherUserId: publisher.id,
          transactionType: 'RENT',
          rentalMode: null,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.listing.create({ data: { ...base, publisherUserId: publisher.id, price: '0.00' } }),
    ).rejects.toThrow();
    await expect(
      prisma.listing.create({ data: { ...base, publisherUserId: publisher.id, currency: 'eur' } }),
    ).rejects.toThrow();
  });

  it('refuerza FK, nullability, checks estructurales e índices B1.6', async () => {
    const publisher = await user();
    await expect(
      prisma.listing.create({
        data: {
          propertyId: randomUUID(),
          publisherUserId: publisher.id,
          transactionType: 'SALE',
          price: '1.00',
          currency: 'EUR',
          description: 'FK sintética',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.property.create({ data: { type: 'HOUSE', builtArea: '50', usableArea: '51' } }),
    ).rejects.toThrow();
    const indexes = await prisma.$queryRaw<Array<{ indexName: string }>>`
      SELECT indexname AS "indexName"
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('property', 'property_authorization', 'listing')
    `;
    const names = indexes.map(({ indexName }) => indexName);
    expect(names).toEqual(
      expect.arrayContaining([
        'property_status_created_idx',
        'property_authorization_active_user_uq',
        'property_authorization_active_org_uq',
        'listing_property_status_created_idx',
        'listing_publisher_user_idx',
        'listing_publisher_org_idx',
      ]),
    );
  });

  it('hace rollback completo de Property + OWNER', async () => {
    const owner = await user();
    const propertyId = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.property.create({ data: { id: propertyId, type: 'LAND' } });
        await tx.propertyAuthorization.create({
          data: {
            propertyId,
            userId: owner.id,
            authorizationType: 'OWNER',
            grantedByUserId: owner.id,
          },
        });
        throw new Error('B16_CONTROLLED_ROLLBACK');
      }),
    ).rejects.toThrow('B16_CONTROLLED_ROLLBACK');
    expect(await prisma.property.count({ where: { id: propertyId } })).toBe(0);
    expect(await prisma.propertyAuthorization.count({ where: { propertyId } })).toBe(0);
  });
});
