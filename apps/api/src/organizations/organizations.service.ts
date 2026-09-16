import { Injectable } from '@nestjs/common';
import { Prisma } from '@benhouse/database';
import type { Prisma as PrismaTypes } from '@benhouse/database';
import {
  globalCapabilities,
  hasOrganizationCapability,
  organizationCapabilities,
} from '../authorization/organization-capabilities';
import { ApiError, securityDependencyUnavailable } from '../auth/auth.errors';
import { SessionAuthorizationService } from '../auth/session-authorization.service';
import { withSerializableRetry } from '../auth/serializable-transaction';
import { DatabaseService } from '../infrastructure/database/database.service';
import type { MemberDto, OrganizationDto } from './organization.dto';
import {
  observeOrganizationTransactionStart,
  OrganizationTransactionObserverError,
  OrganizationTransactionObserver,
} from './organization-transaction-observer';

type Pagination = { limit: number; offset: number };

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionAuthorizationService,
    private readonly transactionObserver: OrganizationTransactionObserver,
  ) {}

  async create(
    name: string,
    cookie: string | undefined,
    csrfToken: string | undefined,
    requestId: string,
  ): Promise<OrganizationDto> {
    const candidate = await this.sessions.authenticate(cookie, csrfToken, true);
    let attempt = 0;
    return this.execute(async () =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          attempt += 1;
          await observeOrganizationTransactionStart(tx, this.transactionObserver, {
            requestId,
            operation: 'ORGANIZATION_CREATE',
            attempt,
          });
          // Orden mixto: User -> Session; las filas Organization todavía no existen.
          const user = await this.sessions.lockAndRevalidate(tx, candidate, csrfToken, true);
          if (!globalCapabilities(user).includes('ORGANIZATION_CREATE')) throw forbidden();
          const organization = await tx.organization.create({
            data: { name, status: 'ACTIVE', createdByUserId: candidate.userId },
          });
          const membership = await tx.organizationMember.create({
            data: {
              organizationId: organization.id,
              userId: candidate.userId,
              role: 'ADMIN',
              status: 'ACTIVE',
              invitationId: null,
            },
          });
          await tx.auditEvent.create({
            data: {
              actorType: 'USER',
              actorUserId: candidate.userId,
              action: 'ORGANIZATION_CREATED',
              resourceType: 'ORGANIZATION',
              resourceId: organization.id,
              newState: 'ACTIVE',
              metadata: { initialMemberId: membership.id, initialRole: 'ADMIN' },
              requestId,
            },
          });
          return fullDto(organization, organizationCapabilities(user, organization, membership));
        }, serializable),
      ),
    );
  }

  async list(cookie: string | undefined, pagination: Pagination): Promise<OrganizationDto[]> {
    const candidate = await this.sessions.authenticate(cookie);
    return this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          const user = await this.sessions.revalidate(tx, candidate);
          const organizations = await tx.organization.findMany({
            where: {
              members: { some: { userId: candidate.userId, status: 'ACTIVE' } },
            },
            include: {
              members: {
                where: { userId: candidate.userId, status: 'ACTIVE' },
                select: { role: true, status: true },
                take: 1,
              },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: pagination.limit,
            skip: pagination.offset,
          });
          return organizations.map((organization) =>
            dtoForState(
              organization,
              organizationCapabilities(user, organization, organization.members[0]),
            ),
          );
        }, serializable),
      ),
    );
  }

  async get(cookie: string | undefined, organizationId: string): Promise<OrganizationDto> {
    const candidate = await this.sessions.authenticate(cookie);
    return this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          const user = await this.sessions.revalidate(tx, candidate);
          const organization = await relatedOrganization(tx, organizationId, candidate.userId);
          if (!organization) throw notFound();
          const capabilities = organizationCapabilities(
            user,
            organization,
            organization.members[0],
          );
          if (
            organization.status === 'ACTIVE' &&
            !hasOrganizationCapability(capabilities, 'ORGANIZATION_VIEW')
          ) {
            throw forbidden();
          }
          return dtoForState(organization, capabilities);
        }, serializable),
      ),
    );
  }

  async updateName(
    cookie: string | undefined,
    csrfToken: string | undefined,
    organizationId: string,
    name: string,
    requestId: string,
  ): Promise<OrganizationDto> {
    const candidate = await this.sessions.authenticate(cookie, csrfToken, true);
    let attempt = 0;
    return this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          attempt += 1;
          await observeOrganizationTransactionStart(tx, this.transactionObserver, {
            requestId,
            operation: 'ORGANIZATION_UPDATE',
            attempt,
          });
          // Orden mixto: User -> Session -> Organization -> OrganizationMember.
          const user = await this.sessions.lockAndRevalidate(tx, candidate, csrfToken, true);
          await lockOrganization(tx, organizationId);
          await lockActorMembership(tx, organizationId, candidate.userId);
          const organization = await relatedOrganization(tx, organizationId, candidate.userId);
          if (!organization) throw notFound();
          const capabilities = organizationCapabilities(
            user,
            organization,
            organization.members[0],
          );
          if (!hasOrganizationCapability(capabilities, 'ORGANIZATION_MANAGE')) throw forbidden();
          const updated = await tx.organization.update({
            where: { id: organizationId },
            data: { name },
          });
          await tx.auditEvent.create({
            data: {
              actorType: 'USER',
              actorUserId: candidate.userId,
              action: 'ORGANIZATION_UPDATED',
              resourceType: 'ORGANIZATION',
              resourceId: organizationId,
              previousState: organization.status,
              newState: updated.status,
              metadata: { changedFields: ['name'] },
              requestId,
            },
          });
          return fullDto(updated, capabilities);
        }, serializable),
      ),
    );
  }

  async members(
    cookie: string | undefined,
    organizationId: string,
    pagination: Pagination,
  ): Promise<MemberDto[]> {
    const candidate = await this.sessions.authenticate(cookie);
    return this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          const user = await this.sessions.revalidate(tx, candidate);
          const organization = await relatedOrganization(tx, organizationId, candidate.userId);
          if (!organization) throw notFound();
          const capabilities = organizationCapabilities(
            user,
            organization,
            organization.members[0],
          );
          if (!hasOrganizationCapability(capabilities, 'ORGANIZATION_MEMBERS_VIEW')) {
            throw forbidden();
          }
          const memberships = await tx.organizationMember.findMany({
            where: { organizationId, status: 'ACTIVE' },
            select: {
              id: true,
              userId: true,
              role: true,
              joinedAt: true,
              user: { select: { displayName: true } },
            },
            orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
            take: pagination.limit,
            skip: pagination.offset,
          });
          return memberships.map((membership) => ({
            id: membership.id,
            userId: membership.userId,
            displayName: membership.user.displayName,
            role: membership.role,
            joinedAt: membership.joinedAt.toISOString(),
          }));
        }, serializable),
      ),
    );
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiError || error instanceof OrganizationTransactionObserverError)
        throw error;
      throw securityDependencyUnavailable();
    }
  }
}

async function relatedOrganization(
  tx: PrismaTypes.TransactionClient,
  organizationId: string,
  userId: string,
) {
  return tx.organization.findFirst({
    where: {
      id: organizationId,
      members: { some: { userId, status: 'ACTIVE' } },
    },
    include: {
      members: {
        where: { userId, status: 'ACTIVE' },
        select: { role: true, status: true },
        take: 1,
      },
    },
  });
}

function dtoForState(
  organization: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
    createdAt: Date;
    updatedAt: Date;
  },
  capabilities: readonly import('../authorization/organization-capabilities').OrganizationCapability[],
): OrganizationDto {
  if (organization.status !== 'ACTIVE') {
    return { id: organization.id, status: organization.status, capabilities: [] };
  }
  return fullDto(organization, capabilities);
}

function fullDto(
  organization: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
    createdAt: Date;
    updatedAt: Date;
  },
  capabilities: readonly import('../authorization/organization-capabilities').OrganizationCapability[],
): OrganizationDto {
  return {
    id: organization.id,
    name: organization.name,
    status: 'ACTIVE',
    capabilities,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

async function lockOrganization(
  tx: PrismaTypes.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${organizationId}::uuid FOR UPDATE`,
  );
}

async function lockActorMembership(
  tx: PrismaTypes.TransactionClient,
  organizationId: string,
  userId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "organization_member" WHERE "organization_id" = ${organizationId}::uuid AND "user_id" = ${userId}::uuid ORDER BY "id" FOR UPDATE`,
  );
}

function notFound(): ApiError {
  return new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'La organización no existe.');
}

function forbidden(): ApiError {
  return new ApiError(403, 'ORGANIZATION_FORBIDDEN', 'No tienes permiso para esta acción.');
}
