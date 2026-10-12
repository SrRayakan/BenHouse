import { Injectable } from '@nestjs/common';
import { Prisma } from '@benhouse/database';
import type { Prisma as PrismaTypes } from '@benhouse/database';
import { ApiError } from '../auth/auth.errors';
import { SessionAuthorizationService } from '../auth/session-authorization.service';
import { withSerializableRetry } from '../auth/serializable-transaction';
import { DatabaseService } from '../infrastructure/database/database.service';
import type {
  ListingDto,
  PropertyAuthorizationDto,
  PropertyDto,
  LocationDto,
} from './marketplace.dto';
import type { ListingWrite, PropertyWrite } from './marketplace.input';
import { validateRentalCombination } from './marketplace.input';
import { parsePropertyLocation } from './location.input';
import {
  capabilitiesForProperty,
  hasMarketplaceCapability,
  isAuthorizationEffective,
  type AuthorizationRecord,
  type MembershipRecord,
} from './marketplace.policy';
import {
  MarketplaceTransactionObserver,
  observeMarketplaceTransactionStart,
  type MarketplaceTransactionOperation,
} from './marketplace-transaction-observer';

type Tx = PrismaTypes.TransactionClient;
type Pagination = { limit: number; offset: number };
type Grant = {
  authorizationType: 'MANAGER' | 'PUBLISHER';
  userId?: string;
  organizationId?: string;
  validFrom?: Date;
  validUntil?: Date;
};
type PropertyWithAuthorizations = PrismaTypes.PropertyGetPayload<{
  include: { authorizations: true };
}>;
type ListingRecord = PrismaTypes.ListingGetPayload<Record<string, never>>;

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

@Injectable()
export class MarketplaceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionAuthorizationService,
    private readonly observer: MarketplaceTransactionObserver,
  ) {}

  async createProperty(
    input: Required<Pick<PropertyWrite, 'type'>> & PropertyWrite,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<PropertyDto> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    return this.mutate('PROPERTY_CREATE', requestId, async (tx) => {
      await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
      const now = await databaseNow(tx);
      const property = await tx.property.create({ data: propertyCreateData(input, now) });
      await tx.propertyAuthorization.create({
        data: {
          propertyId: property.id,
          userId: actor.userId,
          authorizationType: 'OWNER',
          status: 'ACTIVE',
          validFrom: now,
          grantedByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        },
      });
      await audit(
        tx,
        actor.userId,
        'PROPERTY_CREATED',
        'PROPERTY',
        property.id,
        null,
        'ACTIVE',
        {
          ownershipRelation: 'OWNER',
        },
        now,
        requestId,
      );
      const created = await propertyWithAuthorizations(tx, property.id);
      if (!created) throw new Error('La Property creada no se pudo releer.');
      return propertyDto(created, actor.userId, [], now);
    });
  }

  async listProperties(cookie: string | undefined, pagination: Pagination): Promise<PropertyDto[]> {
    const actor = await this.sessions.authenticate(cookie);
    return this.read(async (tx) => {
      await this.sessions.revalidate(tx, actor);
      const now = await databaseNow(tx);
      const [properties, memberships] = await Promise.all([
        tx.property.findMany({
          where: actorPropertyWhere(actor.userId, now),
          include: { authorizations: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: pagination.limit,
          skip: pagination.offset,
        }),
        activeMemberships(tx, actor.userId),
      ]);
      return properties.map((property) => propertyDto(property, actor.userId, memberships, now));
    });
  }

  async getProperty(cookie: string | undefined, propertyId: string): Promise<PropertyDto> {
    const actor = await this.sessions.authenticate(cookie);
    return this.read(async (tx) => {
      await this.sessions.revalidate(tx, actor);
      const now = await databaseNow(tx);
      const [property, memberships] = await Promise.all([
        tx.property.findFirst({
          where: { id: propertyId, ...actorPropertyWhere(actor.userId, now) },
          include: { authorizations: true },
        }),
        activeMemberships(tx, actor.userId),
      ]);
      if (!property) throw notFound();
      return propertyDto(property, actor.userId, memberships, now);
    });
  }

  async updateProperty(
    propertyId: string,
    input: PropertyWrite,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<PropertyDto> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    return this.mutate('PROPERTY_UPDATE', requestId, async (tx) => {
      await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
      const memberships = await lockActorOrganizations(tx, actor.userId);
      await lockProperty(tx, propertyId);
      await lockPropertyAuthorizations(tx, propertyId);
      await this.sessions.revalidate(tx, actor, csrf, true);
      const now = await databaseNow(tx);
      await expireAuthorizations(tx, propertyId, now);
      const property = await propertyWithAuthorizations(tx, propertyId);
      if (!property) throw notFound();
      const capabilities = capabilitiesForProperty(
        actor.userId,
        property.authorizations,
        memberships,
        now,
      );
      if (!hasMarketplaceCapability(capabilities, 'PROPERTY_EDIT')) throw notFound();
      validatePropertyPatch(property, input);
      const updated = await tx.property.update({
        where: { id: propertyId },
        data: propertyUpdateData(input, now),
        include: { authorizations: true },
      });
      await audit(
        tx,
        actor.userId,
        'PROPERTY_UPDATED',
        'PROPERTY',
        propertyId,
        property.status,
        updated.status,
        { changedFields: Object.keys(input).sort() },
        now,
        requestId,
      );
      return propertyDto(updated, actor.userId, memberships, now);
    });
  }

  async listLocations(parentId: string | null, pagination: Pagination): Promise<LocationDto[]> {
    return this.read(async (tx) => {
      if (
        parentId &&
        !(await tx.location.findUnique({ where: { id: parentId }, select: { id: true } }))
      )
        throw notFound();
      return tx.location.findMany({
        where: { parentLocationId: parentId },
        select: locationSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: pagination.limit,
        skip: pagination.offset,
      });
    });
  }

  async getLocation(id: string): Promise<LocationDto> {
    return this.read(async (tx) => {
      const location = await tx.location.findUnique({ where: { id }, select: locationSelect });
      if (!location) throw notFound();
      return location;
    });
  }

  async getPropertyLocation(propertyId: string, cookie: string | undefined) {
    const actor = await this.sessions.authenticate(cookie);
    return this.read(async (tx) => {
      await this.sessions.revalidate(tx, actor);
      const now = await databaseNow(tx);
      const property = await propertyWithAuthorizations(tx, propertyId);
      const memberships = await activeMemberships(tx, actor.userId);
      // La dirección exacta se reserva a quien puede gestionar el inmueble.
      if (
        !property ||
        !hasMarketplaceCapability(
          capabilitiesForProperty(actor.userId, property.authorizations, memberships, now),
          'PROPERTY_EDIT',
        )
      )
        throw notFound();
      return privateLocationDto(tx, propertyId);
    });
  }

  async setPropertyLocation(
    propertyId: string,
    input: unknown,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ) {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    const value = parsePropertyLocation(input);
    return this.mutate('PROPERTY_LOCATION_SET', requestId, async (tx) => {
      await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
      const memberships = await lockActorOrganizations(tx, actor.userId);
      await lockProperty(tx, propertyId);
      await lockPropertyAuthorizations(tx, propertyId);
      await this.sessions.revalidate(tx, actor, csrf, true);
      const now = await databaseNow(tx);
      await expireAuthorizations(tx, propertyId, now);
      const property = await propertyWithAuthorizations(tx, propertyId);
      if (
        !property ||
        !hasMarketplaceCapability(
          capabilitiesForProperty(actor.userId, property.authorizations, memberships, now),
          'PROPERTY_EDIT',
        )
      )
        throw notFound();
      if (property.status !== 'ACTIVE' || property.locationVersion !== value.expectedVersion)
        throw conflict(
          'La ubicación ha cambiado o el inmueble no está activo. Recarga el recurso.',
        );
      // FK + bloqueo compartido evitan borrar/cambiar la referencia entre validación y escritura.
      const locations = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "location" WHERE "id" = ${value.locationId}::uuid FOR KEY SHARE`,
      );
      if (!locations.length) throw notFound();
      const point = value.coordinates
        ? Prisma.sql`ST_SetSRID(ST_MakePoint(${value.coordinates.longitude}, ${value.coordinates.latitude}), 4326)`
        : Prisma.sql`NULL::geometry`;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "property" SET "location_id" = ${value.locationId}::uuid,
          "location_version" = "location_version" + 1,
          "street_name" = ${value.streetName}, "street_number" = ${value.streetNumber},
          "address_unit" = ${value.addressUnit}, "postal_code" = ${value.postalCode},
          "location_point" = ${point}, "updated_at" = ${now}
        WHERE "id" = ${propertyId}::uuid
      `);
      await audit(
        tx,
        actor.userId,
        'PROPERTY_LOCATION_SET',
        'PROPERTY',
        propertyId,
        property.status,
        property.status,
        { locationVersion: value.expectedVersion + 1 },
        now,
        requestId,
      );
      return privateLocationDto(tx, propertyId);
    });
  }

  async listAuthorizations(
    propertyId: string,
    cookie: string | undefined,
  ): Promise<PropertyAuthorizationDto[]> {
    const actor = await this.sessions.authenticate(cookie);
    return this.read(async (tx) => {
      await this.sessions.revalidate(tx, actor);
      const now = await databaseNow(tx);
      const [property, memberships] = await Promise.all([
        propertyWithAuthorizations(tx, propertyId),
        activeMemberships(tx, actor.userId),
      ]);
      if (!property) throw notFound();
      const capabilities = capabilitiesForProperty(
        actor.userId,
        property.authorizations,
        memberships,
        now,
      );
      if (!hasMarketplaceCapability(capabilities, 'PROPERTY_EDIT')) throw notFound();
      return property.authorizations
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
        .map((authorization) => authorizationDto(authorization, actor.userId, now));
    });
  }

  async grantAuthorization(
    propertyId: string,
    input: Grant,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<PropertyAuthorizationDto> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    return this.mutate('PROPERTY_AUTHORIZATION_GRANT', requestId, async (tx) => {
      await lockUsers(tx, [actor.userId, ...(input.userId ? [input.userId] : [])]);
      await lockSession(tx, actor.sessionId);
      await this.sessions.revalidate(tx, actor, csrf, true);
      if (input.organizationId) {
        await lockOrganizations(tx, [input.organizationId]);
        await lockOrganizationMembers(tx, input.organizationId);
      }
      await lockProperty(tx, propertyId);
      await lockPropertyAuthorizations(tx, propertyId);
      await this.sessions.revalidate(tx, actor, csrf, true);
      const now = await databaseNow(tx);
      await expireAuthorizations(tx, propertyId, now);
      const property = await propertyWithAuthorizations(tx, propertyId);
      if (!property || !personalOwner(property.authorizations, actor.userId, now)) throw notFound();
      if (input.userId) {
        const subject = await tx.user.findUnique({ where: { id: input.userId } });
        if (!subject || subject.status !== 'ACTIVE' || !subject.emailVerifiedAt) throw conflict();
      } else {
        const organization = await tx.organization.findUnique({
          where: { id: input.organizationId! },
        });
        if (!organization || organization.status !== 'ACTIVE') throw conflict();
      }
      const validFrom = input.validFrom ?? now;
      if (input.validUntil && (input.validUntil <= validFrom || input.validUntil <= now))
        throw conflict();
      const duplicate = property.authorizations.some(
        (authorization) =>
          authorization.status === 'ACTIVE' &&
          authorization.authorizationType === input.authorizationType &&
          authorization.userId === (input.userId ?? null) &&
          authorization.organizationId === (input.organizationId ?? null),
      );
      if (duplicate) throw conflict('Ya existe una autorización activa equivalente.');
      const created = await tx.propertyAuthorization.create({
        data: {
          propertyId,
          userId: input.userId ?? null,
          organizationId: input.organizationId ?? null,
          authorizationType: input.authorizationType,
          status: 'ACTIVE',
          validFrom,
          validUntil: input.validUntil ?? null,
          grantedByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        },
      });
      await audit(
        tx,
        actor.userId,
        'PROPERTY_AUTHORIZATION_GRANTED',
        'PROPERTY_AUTHORIZATION',
        created.id,
        null,
        'ACTIVE',
        {
          propertyId,
          authorizationType: created.authorizationType,
          subjectType: created.userId ? 'USER' : 'ORGANIZATION',
        },
        now,
        requestId,
      );
      return authorizationDto(created, actor.userId, now);
    });
  }

  async revokeAuthorization(
    authorizationId: string,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<void> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    const candidate = await this.execute(() =>
      this.database.prisma.propertyAuthorization.findUnique({
        where: { id: authorizationId },
        select: { propertyId: true },
      }),
    );
    if (!candidate) throw notFound();
    await this.mutate('PROPERTY_AUTHORIZATION_REVOKE', requestId, async (tx) => {
      await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
      await lockProperty(tx, candidate.propertyId);
      await lockPropertyAuthorizations(tx, candidate.propertyId);
      await this.sessions.revalidate(tx, actor, csrf, true);
      const now = await databaseNow(tx);
      await expireAuthorizations(tx, candidate.propertyId, now);
      const property = await propertyWithAuthorizations(tx, candidate.propertyId);
      if (!property || !personalOwner(property.authorizations, actor.userId, now)) throw notFound();
      const authorization = property.authorizations.find(({ id }) => id === authorizationId);
      if (
        !authorization ||
        authorization.status !== 'ACTIVE' ||
        authorization.authorizationType === 'OWNER'
      )
        throw notFound();
      await tx.propertyAuthorization.update({
        where: { id: authorizationId },
        data: { status: 'REVOKED', revokedAt: now, updatedAt: now },
      });
      await audit(
        tx,
        actor.userId,
        'PROPERTY_AUTHORIZATION_REVOKED',
        'PROPERTY_AUTHORIZATION',
        authorizationId,
        'ACTIVE',
        'REVOKED',
        {
          propertyId: candidate.propertyId,
          authorizationType: authorization.authorizationType,
          subjectType: authorization.userId ? 'USER' : 'ORGANIZATION',
        },
        now,
        requestId,
      );
    });
  }

  async createListing(
    input: {
      propertyId: string;
      organizationId?: string;
    } & Required<Pick<ListingWrite, 'transactionType' | 'price' | 'currency' | 'description'>> &
      ListingWrite,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<ListingDto> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    return this.mutate('LISTING_CREATE', requestId, async (tx) => {
      await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
      let memberships: MembershipRecord[] = [];
      if (input.organizationId) {
        await lockOrganizations(tx, [input.organizationId]);
        await lockOrganizationMembers(tx, input.organizationId);
        memberships = await activeMemberships(tx, actor.userId);
      }
      await lockProperty(tx, input.propertyId);
      await lockPropertyAuthorizations(tx, input.propertyId);
      await this.sessions.revalidate(tx, actor, csrf, true);
      const now = await databaseNow(tx);
      await expireAuthorizations(tx, input.propertyId, now);
      const property = await propertyWithAuthorizations(tx, input.propertyId);
      if (!property || property.status !== 'ACTIVE') throw notFound();
      if (input.organizationId) {
        const membership = memberships.find(
          ({ organizationId, status, organization }) =>
            organizationId === input.organizationId &&
            status === 'ACTIVE' &&
            organization.status === 'ACTIVE',
        );
        const authorized = property.authorizations.some(
          (authorization) =>
            authorization.organizationId === input.organizationId &&
            isAuthorizationEffective(authorization, now),
        );
        if (!membership || !authorized) throw notFound();
      } else {
        const authorized = property.authorizations.some(
          (authorization) =>
            authorization.userId === actor.userId && isAuthorizationEffective(authorization, now),
        );
        if (!authorized) throw notFound();
      }
      const listing = await tx.listing.create({
        data: listingCreateData(input, actor.userId, now),
      });
      await audit(
        tx,
        actor.userId,
        'LISTING_CREATED',
        'LISTING',
        listing.id,
        null,
        'DRAFT',
        {
          propertyId: listing.propertyId,
          publisherType: listing.publisherUserId ? 'USER' : 'ORGANIZATION',
        },
        now,
        requestId,
      );
      return listingDto(listing, actor.userId);
    });
  }

  async listListings(cookie: string | undefined, pagination: Pagination): Promise<ListingDto[]> {
    const actor = await this.sessions.authenticate(cookie);
    return this.read(async (tx) => {
      await this.sessions.revalidate(tx, actor);
      const now = await databaseNow(tx);
      const listings = await tx.listing.findMany({
        where: { status: 'DRAFT', property: actorPropertyWhere(actor.userId, now) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: pagination.limit,
        skip: pagination.offset,
      });
      return listings.map((listing) => listingDto(listing, actor.userId));
    });
  }

  async getListing(cookie: string | undefined, listingId: string): Promise<ListingDto> {
    const actor = await this.sessions.authenticate(cookie);
    return this.read(async (tx) => {
      await this.sessions.revalidate(tx, actor);
      const now = await databaseNow(tx);
      const listing = await tx.listing.findFirst({
        where: { id: listingId, status: 'DRAFT', property: actorPropertyWhere(actor.userId, now) },
      });
      if (!listing) throw notFound();
      return listingDto(listing, actor.userId);
    });
  }

  async updateListing(
    listingId: string,
    input: ListingWrite,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<ListingDto> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    const candidate = await this.execute(() =>
      this.database.prisma.listing.findUnique({
        where: { id: listingId },
        select: { propertyId: true, publisherOrganizationId: true },
      }),
    );
    if (!candidate) throw notFound();
    return this.mutate('LISTING_UPDATE', requestId, async (tx) => {
      await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
      const memberships = await lockActorOrganizations(
        tx,
        actor.userId,
        candidate.publisherOrganizationId ? [candidate.publisherOrganizationId] : [],
      );
      await lockProperty(tx, candidate.propertyId);
      await lockPropertyAuthorizations(tx, candidate.propertyId);
      await lockListing(tx, listingId);
      await this.sessions.revalidate(tx, actor, csrf, true);
      const now = await databaseNow(tx);
      await expireAuthorizations(tx, candidate.propertyId, now);
      const [property, listing] = await Promise.all([
        propertyWithAuthorizations(tx, candidate.propertyId),
        tx.listing.findUnique({ where: { id: listingId } }),
      ]);
      if (
        !property ||
        !listing ||
        listing.propertyId !== candidate.propertyId ||
        listing.status !== 'DRAFT'
      )
        throw notFound();
      const capabilities = capabilitiesForProperty(
        actor.userId,
        property.authorizations,
        memberships,
        now,
      );
      if (!hasMarketplaceCapability(capabilities, 'LISTING_EDIT')) throw notFound();
      validateListingPatch(listing, input);
      const updated = await tx.listing.update({
        where: { id: listingId },
        data: listingUpdateData(input, now),
      });
      await audit(
        tx,
        actor.userId,
        'LISTING_UPDATED',
        'LISTING',
        listingId,
        'DRAFT',
        'DRAFT',
        { propertyId: listing.propertyId, changedFields: Object.keys(input).sort() },
        now,
        requestId,
      );
      return listingDto(updated, actor.userId);
    });
  }

  private async read<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    return this.execute(() =>
      withSerializableRetry(() => this.database.prisma.$transaction(operation, serializable)),
    );
  }

  private async mutate<T>(
    operation: MarketplaceTransactionOperation,
    requestId: string,
    callback: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    return this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await observeMarketplaceTransactionStart(tx, this.observer, {
            operation,
            requestId,
            attempt: ++attempt,
          });
          return callback(tx);
        }, serializable),
      ),
    );
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isAuthorizationUniqueConflict(error))
        throw conflict('Ya existe una autorización activa equivalente.');
      throw dependencyUnavailable();
    }
  }
}

// Catálogo público: nunca incluye direcciones, puntos precisos de Property ni relaciones inversas.
const locationSelect = {
  id: true,
  code: true,
  name: true,
  kind: true,
  parentLocationId: true,
  demoSynthetic: true,
} as const;

async function privateLocationDto(tx: Tx, propertyId: string) {
  const rows = await tx.$queryRaw<
    Array<{
      propertyId: string;
      locationId: string | null;
      version: number;
      streetName: string | null;
      streetNumber: string | null;
      addressUnit: string | null;
      postalCode: string | null;
      latitude: number | null;
      longitude: number | null;
    }>
  >(Prisma.sql`
    SELECT "id" AS "propertyId", "location_id" AS "locationId", "location_version" AS "version",
      "street_name" AS "streetName", "street_number" AS "streetNumber", "address_unit" AS "addressUnit",
      "postal_code" AS "postalCode", ST_Y("location_point") AS latitude, ST_X("location_point") AS longitude
    FROM "property" WHERE "id" = ${propertyId}::uuid
  `);
  const row = rows[0];
  if (!row) throw notFound();
  const { latitude, longitude, ...fields } = row;
  return {
    ...fields,
    coordinates: latitude === null || longitude === null ? null : { latitude, longitude },
  };
}

function actorPropertyWhere(userId: string, now: Date): PrismaTypes.PropertyWhereInput {
  return {
    authorizations: {
      some: {
        status: 'ACTIVE',
        validFrom: { lte: now },
        AND: [
          { OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
          {
            OR: [
              { userId },
              {
                organization: {
                  status: 'ACTIVE',
                  members: { some: { userId, status: 'ACTIVE' } },
                },
              },
            ],
          },
        ],
      },
    },
  };
}

async function propertyWithAuthorizations(tx: Tx, id: string) {
  return tx.property.findUnique({ where: { id }, include: { authorizations: true } });
}

async function activeMemberships(tx: Tx, userId: string): Promise<MembershipRecord[]> {
  return tx.organizationMember.findMany({
    where: { userId, status: 'ACTIVE' },
    select: {
      organizationId: true,
      status: true,
      role: true,
      organization: { select: { status: true } },
    },
    orderBy: { id: 'asc' },
  });
}

async function lockActorOrganizations(
  tx: Tx,
  userId: string,
  additionalOrganizationIds: readonly string[] = [],
): Promise<MembershipRecord[]> {
  const candidates = await tx.organizationMember.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { organizationId: true },
  });
  const ids = [
    ...new Set([
      ...candidates.map(({ organizationId }) => organizationId),
      ...additionalOrganizationIds,
    ]),
  ].sort();
  await lockOrganizations(tx, ids);
  for (const id of ids) await lockOrganizationMembers(tx, id);
  return activeMemberships(tx, userId);
}

async function lockUsers(tx: Tx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort())
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${id}::uuid FOR UPDATE`);
}

async function lockSession(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "session" WHERE "id" = ${id}::uuid FOR UPDATE`);
}

async function lockOrganizations(tx: Tx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort())
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${id}::uuid FOR UPDATE`,
    );
}

async function lockOrganizationMembers(tx: Tx, organizationId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "organization_member" WHERE "organization_id" = ${organizationId}::uuid ORDER BY "id" FOR UPDATE`,
  );
}

async function lockProperty(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "property" WHERE "id" = ${id}::uuid FOR UPDATE`);
}

async function lockPropertyAuthorizations(tx: Tx, propertyId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "property_authorization" WHERE "property_id" = ${propertyId}::uuid ORDER BY "id" FOR UPDATE`,
  );
}

async function lockListing(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "listing" WHERE "id" = ${id}::uuid FOR UPDATE`);
}

async function databaseNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS now`,
  );
  if (!(rows[0]?.now instanceof Date)) throw new Error('Reloj PostgreSQL no disponible.');
  return rows[0].now;
}

async function expireAuthorizations(tx: Tx, propertyId: string, now: Date): Promise<void> {
  await tx.propertyAuthorization.updateMany({
    where: { propertyId, status: 'ACTIVE', validUntil: { lte: now } },
    data: { status: 'EXPIRED', updatedAt: now },
  });
}

function personalOwner(
  authorizations: readonly AuthorizationRecord[],
  actorId: string,
  now: Date,
): boolean {
  return authorizations.some(
    (authorization) =>
      authorization.userId === actorId &&
      authorization.authorizationType === 'OWNER' &&
      isAuthorizationEffective(authorization, now),
  );
}

function propertyCreateData(
  input: Required<Pick<PropertyWrite, 'type'>> & PropertyWrite,
  now: Date,
): PrismaTypes.PropertyUncheckedCreateInput {
  return {
    ...propertyScalarData(input),
    type: input.type,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
}

function propertyUpdateData(
  input: PropertyWrite,
  now: Date,
): PrismaTypes.PropertyUncheckedUpdateInput {
  return { ...propertyScalarData(input), updatedAt: now };
}

function propertyScalarData(input: PropertyWrite) {
  return {
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.builtArea !== undefined
      ? { builtArea: input.builtArea === null ? null : new Prisma.Decimal(input.builtArea) }
      : {}),
    ...(input.usableArea !== undefined
      ? { usableArea: input.usableArea === null ? null : new Prisma.Decimal(input.usableArea) }
      : {}),
    ...(input.rooms !== undefined ? { rooms: input.rooms } : {}),
    ...(input.bathrooms !== undefined ? { bathrooms: input.bathrooms } : {}),
    ...(input.floor !== undefined ? { floor: input.floor } : {}),
    ...(input.constructionYear !== undefined ? { constructionYear: input.constructionYear } : {}),
  };
}

function listingCreateData(
  input: { propertyId: string; organizationId?: string } & Required<
    Pick<ListingWrite, 'transactionType' | 'price' | 'currency' | 'description'>
  > &
    ListingWrite,
  actorId: string,
  now: Date,
): PrismaTypes.ListingUncheckedCreateInput {
  return {
    propertyId: input.propertyId,
    publisherUserId: input.organizationId ? null : actorId,
    publisherOrganizationId: input.organizationId ?? null,
    responsibleMemberUserId: input.organizationId ? actorId : null,
    transactionType: input.transactionType,
    rentalMode: input.rentalMode ?? null,
    price: new Prisma.Decimal(input.price),
    currency: input.currency,
    description: input.description,
    availableFrom: input.availableFrom ?? null,
    availableUntil: input.availableUntil ?? null,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
  };
}

function listingUpdateData(
  input: ListingWrite,
  now: Date,
): PrismaTypes.ListingUncheckedUpdateInput {
  return {
    ...(input.transactionType !== undefined ? { transactionType: input.transactionType } : {}),
    ...(input.rentalMode !== undefined ? { rentalMode: input.rentalMode } : {}),
    ...(input.price !== undefined ? { price: new Prisma.Decimal(input.price) } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.availableFrom !== undefined ? { availableFrom: input.availableFrom } : {}),
    ...(input.availableUntil !== undefined ? { availableUntil: input.availableUntil } : {}),
    updatedAt: now,
  };
}

function validateListingPatch(listing: ListingRecord, input: ListingWrite): void {
  validateRentalCombination({
    transactionType: input.transactionType ?? listing.transactionType,
    rentalMode: input.rentalMode !== undefined ? input.rentalMode : listing.rentalMode,
  });
  const availableFrom =
    input.availableFrom !== undefined ? input.availableFrom : listing.availableFrom;
  const availableUntil =
    input.availableUntil !== undefined ? input.availableUntil : listing.availableUntil;
  if (availableUntil && (!availableFrom || availableUntil <= availableFrom))
    throw new ApiError(400, 'INVALID_REQUEST', 'La solicitud no es válida.');
}

function validatePropertyPatch(property: PropertyWithAuthorizations, input: PropertyWrite): void {
  const built =
    input.builtArea !== undefined
      ? input.builtArea === null
        ? null
        : new Prisma.Decimal(input.builtArea)
      : property.builtArea;
  const usable =
    input.usableArea !== undefined
      ? input.usableArea === null
        ? null
        : new Prisma.Decimal(input.usableArea)
      : property.usableArea;
  if (built && usable && usable.greaterThan(built)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'La solicitud no es válida.');
  }
}

function propertyDto(
  property: PropertyWithAuthorizations,
  actorId: string,
  memberships: readonly MembershipRecord[],
  now: Date,
): PropertyDto {
  return {
    id: property.id,
    type: property.type,
    builtArea: property.builtArea?.toFixed(2) ?? null,
    usableArea: property.usableArea?.toFixed(2) ?? null,
    rooms: property.rooms,
    bathrooms: property.bathrooms,
    floor: property.floor,
    constructionYear: property.constructionYear,
    status: property.status,
    capabilities: capabilitiesForProperty(actorId, property.authorizations, memberships, now),
    createdAt: property.createdAt.toISOString(),
    updatedAt: property.updatedAt.toISOString(),
  };
}

function authorizationDto(
  authorization: PrismaTypes.PropertyAuthorizationGetPayload<Record<string, never>>,
  actorId: string,
  now: Date,
): PropertyAuthorizationDto {
  const status =
    authorization.status === 'ACTIVE' && authorization.validUntil && authorization.validUntil <= now
      ? 'EXPIRED'
      : authorization.status;
  return {
    id: authorization.id,
    authorizationType: authorization.authorizationType,
    status,
    subject: authorization.userId
      ? { type: 'USER', self: authorization.userId === actorId }
      : { type: 'ORGANIZATION', organizationId: authorization.organizationId! },
    validFrom: authorization.validFrom.toISOString(),
    validUntil: authorization.validUntil?.toISOString() ?? null,
    revokedAt: authorization.revokedAt?.toISOString() ?? null,
    createdAt: authorization.createdAt.toISOString(),
  };
}

function listingDto(listing: ListingRecord, actorId: string): ListingDto {
  if (listing.status !== 'DRAFT') throw new Error('B1.6 solo proyecta listings DRAFT.');
  return {
    id: listing.id,
    propertyId: listing.propertyId,
    publisher: listing.publisherUserId
      ? { type: 'USER', self: listing.publisherUserId === actorId }
      : { type: 'ORGANIZATION', organizationId: listing.publisherOrganizationId! },
    transactionType: listing.transactionType,
    rentalMode: listing.rentalMode,
    price: listing.price.toFixed(2),
    currency: listing.currency,
    description: listing.description,
    availableFrom: listing.availableFrom?.toISOString() ?? null,
    availableUntil: listing.availableUntil?.toISOString() ?? null,
    status: 'DRAFT',
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}

async function audit(
  tx: Tx,
  actorUserId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  previousState: string | null,
  newState: string,
  metadata: PrismaTypes.InputJsonObject,
  now: Date,
  requestId: string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      actorType: 'USER',
      actorUserId,
      action,
      resourceType,
      resourceId,
      previousState,
      newState,
      metadata,
      occurredAt: now,
      requestId,
      correlationId: requestId,
    },
  });
}

function notFound(): ApiError {
  return new ApiError(404, 'MARKETPLACE_RESOURCE_NOT_FOUND', 'El recurso no existe.');
}

function conflict(message = 'La operación no es válida en el estado actual.'): ApiError {
  return new ApiError(409, 'MARKETPLACE_CONFLICT', message);
}

function dependencyUnavailable(): ApiError {
  return new ApiError(
    503,
    'MARKETPLACE_DEPENDENCY_UNAVAILABLE',
    'El servicio no está disponible temporalmente.',
  );
}

function isAuthorizationUniqueConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; meta?: { target?: unknown } } | null;
  return (
    candidate?.code === 'P2002' &&
    ['property_authorization_active_user_uq', 'property_authorization_active_org_uq'].includes(
      String(candidate.meta?.target),
    )
  );
}
