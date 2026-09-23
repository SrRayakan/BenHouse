import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthConfig } from '@benhouse/config';
import { Prisma } from '@benhouse/database';
import type { Prisma as PrismaTypes } from '@benhouse/database';
import {
  hasOrganizationCapability,
  organizationCapabilities,
} from '../authorization/organization-capabilities';
import {
  accountTokenAuthenticator,
  createInvitationTokenMaterial,
  parseAccountToken,
} from '../auth/account-token';
import { AUTH_CONFIG } from '../auth/auth.config';
import {
  ApiError,
  invalidOrExpiredToken,
  securityDependencyUnavailable,
} from '../auth/auth.errors';
import { AuthRateLimitService } from '../auth/rate-limit.service';
import {
  SessionAuthorizationService,
  type AuthenticatedSession,
} from '../auth/session-authorization.service';
import { withSerializableRetry } from '../auth/serializable-transaction';
import { constantTimeEqual } from '../auth/crypto-encoding';
import { DatabaseService } from '../infrastructure/database/database.service';
import type { MemberRole } from './organization-administration.input';
import {
  observeOrganizationTransactionStart,
  OrganizationTransactionObserver,
} from './organization-transaction-observer';

type Tx = PrismaTypes.TransactionClient;
type TransferBody = { targetMemberId: string; retainCurrentAdmin: boolean };
type Member = {
  id: string;
  userId: string;
  role: MemberRole;
  status: 'ACTIVE' | 'REVOKED' | 'LEFT';
};
const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class OrganizationAdministrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionAuthorizationService,
    private readonly rateLimits: AuthRateLimitService,
    private readonly transactionObserver: OrganizationTransactionObserver,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async invite(
    organizationId: string,
    body: { email: string; role: MemberRole },
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<{ id: string; status: 'PENDING' }> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    await this.preflightAdmin(organizationId, actor);
    await this.consumeAdminLimit('ORGANIZATION_INVITE', actor.userId, organizationId);
    const invitationId = randomUUID();
    const token = createInvitationTokenMaterial(invitationId, 1, this.config.accountTokenKeys, {
      organizationId,
      email: body.email,
      role: body.role,
    });
    let attempt = 0;
    return this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await observeOrganizationTransactionStart(tx, this.transactionObserver, {
            requestId,
            operation: 'ORGANIZATION_INVITE',
            attempt: ++attempt,
          });
          const user = await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
          await lockOrganization(tx, organizationId);
          await lockMembers(tx, organizationId);
          const { organization } = await authorizeAdmin(tx, organizationId, actor.userId, user);
          const pending = await tx.organizationInvitation.findMany({
            where: { organizationId, email: body.email, status: 'PENDING' },
            orderBy: { id: 'asc' },
          });
          await lockInvitations(
            tx,
            pending.map(({ id }) => id),
          );
          const now = await databaseNow(tx);
          for (const previous of pending) {
            if (previous.expiresAt > now) throw conflict();
            await tx.organizationInvitation.update({
              where: { id: previous.id },
              data: { status: 'EXPIRED' },
            });
          }
          const expiresAt = addSeconds(now, INVITATION_TTL_SECONDS);
          await tx.organizationInvitation.create({
            data: {
              id: invitationId,
              organizationId,
              email: body.email,
              role: body.role,
              invitedByUserId: actor.userId,
              status: 'PENDING',
              createdAt: now,
              expiresAt,
            },
          });
          await createInvitationToken(tx, token.material, expiresAt);
          await invitationOutbox(
            tx,
            invitationId,
            organization.id,
            token.material.id,
            1,
            now,
            requestId,
          );
          await audit(
            tx,
            'ORGANIZATION_INVITATION_REQUESTED',
            'ORGANIZATION_INVITATION',
            invitationId,
            { organizationId, role: body.role, generation: 1 },
            now,
            requestId,
            actor.userId,
          );
          return { id: invitationId, status: 'PENDING' as const };
        }, serializable),
      ),
    );
  }

  async resend(
    invitationId: string,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<void> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    const candidate = await this.invitationCandidate(invitationId);
    if (!candidate) throw notFound();
    await this.preflightAdmin(candidate.organizationId, actor);
    await this.consumeAdminLimit(
      'ORGANIZATION_INVITE_RESEND',
      actor.userId,
      candidate.organizationId,
    );
    let attempt = 0;
    const result = await this.execute(() =>
      withSerializableRetry(
        () =>
          this.database.prisma.$transaction(async (tx) => {
            await observeOrganizationTransactionStart(tx, this.transactionObserver, {
              requestId,
              operation: 'ORGANIZATION_INVITE_RESEND',
              attempt: ++attempt,
            });
            const user = await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
            await lockInvitationTokens(tx, invitationId);
            await lockOrganization(tx, candidate.organizationId);
            await lockMembers(tx, candidate.organizationId);
            await lockInvitations(tx, [invitationId]);
            await authorizeAdmin(tx, candidate.organizationId, actor.userId, user);
            const invitation = await tx.organizationInvitation.findUnique({
              where: { id: invitationId },
            });
            if (!invitation || invitation.organizationId !== candidate.organizationId)
              throw notFound();
            const now = await databaseNow(tx);
            if (invitation.status !== 'PENDING') throw conflict();
            if (invitation.expiresAt <= now) {
              await tx.organizationInvitation.update({
                where: { id: invitationId },
                data: { status: 'EXPIRED' },
              });
              return false;
            }
            const prior = await tx.accountToken.findMany({
              where: { organizationInvitationId: invitationId, purpose: 'ORGANIZATION_INVITATION' },
              orderBy: { generation: 'desc' },
            });
            const generation = (prior[0]?.generation ?? 0) + 1;
            const token = createInvitationTokenMaterial(
              invitationId,
              generation,
              this.config.accountTokenKeys,
              {
                organizationId: invitation.organizationId,
                email: invitation.email,
                role: invitation.role,
              },
            );
            await revokeTokens(
              tx,
              prior.map(({ id }) => id),
              now,
            );
            const expiresAt = addSeconds(now, INVITATION_TTL_SECONDS);
            await tx.organizationInvitation.update({
              where: { id: invitationId },
              data: { expiresAt },
            });
            await createInvitationToken(tx, token.material, expiresAt);
            await invitationOutbox(
              tx,
              invitationId,
              invitation.organizationId,
              token.material.id,
              generation,
              now,
              requestId,
            );
            await audit(
              tx,
              'ORGANIZATION_INVITATION_RESENT',
              'ORGANIZATION_INVITATION',
              invitationId,
              { organizationId: invitation.organizationId, generation },
              now,
              requestId,
              actor.userId,
            );
            return true;
          }, serializable),
        isInvitationGenerationConflict,
      ),
    );
    if (!result) throw invalidOrExpiredToken();
  }

  async revokeInvitation(
    invitationId: string,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<void> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    const candidate = await this.invitationCandidate(invitationId);
    if (!candidate) throw notFound();
    let attempt = 0;
    const result = await this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await observeOrganizationTransactionStart(tx, this.transactionObserver, {
            requestId,
            operation: 'ORGANIZATION_INVITE_REVOKE',
            attempt: ++attempt,
          });
          const user = await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
          await lockInvitationTokens(tx, invitationId);
          await lockOrganization(tx, candidate.organizationId);
          await lockMembers(tx, candidate.organizationId);
          await lockInvitations(tx, [invitationId]);
          await authorizeAdmin(tx, candidate.organizationId, actor.userId, user);
          const invitation = await tx.organizationInvitation.findUnique({
            where: { id: invitationId },
          });
          if (!invitation || invitation.organizationId !== candidate.organizationId)
            throw notFound();
          const now = await databaseNow(tx);
          if (invitation.status !== 'PENDING') throw conflict();
          if (invitation.expiresAt <= now) {
            await tx.organizationInvitation.update({
              where: { id: invitationId },
              data: { status: 'EXPIRED' },
            });
            return false;
          }
          const tokens = await tx.accountToken.findMany({
            where: { organizationInvitationId: invitationId },
            select: { id: true },
          });
          await revokeTokens(
            tx,
            tokens.map(({ id }) => id),
            now,
          );
          await tx.organizationInvitation.update({
            where: { id: invitationId },
            data: { status: 'REVOKED', revokedAt: now },
          });
          await audit(
            tx,
            'ORGANIZATION_INVITATION_REVOKED',
            'ORGANIZATION_INVITATION',
            invitationId,
            { organizationId: invitation.organizationId },
            now,
            requestId,
            actor.userId,
          );
          return true;
        }, serializable),
      ),
    );
    if (!result) throw invalidOrExpiredToken();
  }

  async respond(
    decision: 'ACCEPTED' | 'REJECTED',
    invitationId: string,
    rawToken: string,
    ip: string,
    requestId: string,
  ): Promise<void> {
    const parsed = parseAccountToken(rawToken);
    const subject = parsed?.selector ?? AuthRateLimitService.malformedTokenSubject(rawToken);
    await this.rateLimits.consume([
      {
        action:
          decision === 'ACCEPTED'
            ? 'ORGANIZATION_INVITATION_ACCEPT'
            : 'ORGANIZATION_INVITATION_REJECT',
        dimension: 'TOKEN',
        value: subject,
        policy:
          decision === 'ACCEPTED'
            ? 'ORGANIZATION_INVITATION_ACCEPT_TOKEN'
            : 'ORGANIZATION_INVITATION_REJECT_TOKEN',
      },
      {
        action:
          decision === 'ACCEPTED'
            ? 'ORGANIZATION_INVITATION_ACCEPT'
            : 'ORGANIZATION_INVITATION_REJECT',
        dimension: 'IP',
        value: ip,
        policy:
          decision === 'ACCEPTED'
            ? 'ORGANIZATION_INVITATION_ACCEPT_IP'
            : 'ORGANIZATION_INVITATION_REJECT_IP',
      },
      {
        action:
          decision === 'ACCEPTED'
            ? 'ORGANIZATION_INVITATION_ACCEPT'
            : 'ORGANIZATION_INVITATION_REJECT',
        dimension: 'TOKEN_IP',
        value: `${subject}\0${ip}`,
        policy:
          decision === 'ACCEPTED'
            ? 'ORGANIZATION_INVITATION_ACCEPT_TOKEN_IP'
            : 'ORGANIZATION_INVITATION_REJECT_TOKEN_IP',
      },
    ]);
    if (!parsed) throw invalidOrExpiredToken();
    const candidate = await this.invitationCandidate(invitationId);
    if (!candidate) throw invalidOrExpiredToken();
    const invitedUser =
      decision === 'ACCEPTED'
        ? await this.execute(() =>
            this.database.prisma.user.findUnique({
              where: { email: candidate.email },
              select: { id: true },
            }),
          )
        : null;
    let attempt = 0;
    const accepted = await this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await observeOrganizationTransactionStart(tx, this.transactionObserver, {
            requestId,
            operation:
              decision === 'ACCEPTED' ? 'ORGANIZATION_INVITE_ACCEPT' : 'ORGANIZATION_INVITE_REJECT',
            attempt: ++attempt,
          });
          if (invitedUser) await lockUsers(tx, [invitedUser.id]);
          await lockToken(tx, parsed.selector);
          await lockOrganization(tx, candidate.organizationId);
          await lockMembers(tx, candidate.organizationId);
          await lockInvitations(tx, [invitationId]);
          const [invitation, token, latest, organization] = await Promise.all([
            tx.organizationInvitation.findUnique({ where: { id: invitationId } }),
            tx.accountToken.findUnique({ where: { id: parsed.selector } }),
            tx.accountToken.findFirst({
              where: { organizationInvitationId: invitationId, purpose: 'ORGANIZATION_INVITATION' },
              orderBy: { generation: 'desc' },
            }),
            tx.organization.findUnique({ where: { id: candidate.organizationId } }),
          ]);
          const expected = token
            ? (accountTokenAuthenticator(
                {
                  id: token.id,
                  purpose: 'ORGANIZATION_INVITATION',
                  generation: token.generation,
                  subjectType: 'ORGANIZATION_INVITATION',
                  subjectId: invitationId,
                  keyVersion: token.keyVersion,
                  organizationId: invitation?.organizationId,
                  email: invitation?.email,
                  role: invitation?.role,
                },
                this.config.accountTokenKeys,
              ) ?? Buffer.alloc(32))
            : Buffer.alloc(32);
          const valid =
            invitation?.id === candidate.id &&
            invitation.organizationId === candidate.organizationId &&
            invitation.email === candidate.email &&
            invitation.role === candidate.role &&
            invitation.status === 'PENDING' &&
            token?.organizationInvitationId === invitationId &&
            token.userId === null &&
            token.purpose === 'ORGANIZATION_INVITATION' &&
            token.consumedAt === null &&
            token.revokedAt === null &&
            latest?.id === token.id &&
            constantTimeEqual(expected, parsed.authenticator);
          if (!valid || !invitation || !token) throw invalidOrExpiredToken();
          const now = await databaseNow(tx);
          if (invitation.expiresAt <= now || token.expiresAt <= now) {
            await revokeTokens(tx, [token.id], now);
            await tx.organizationInvitation.update({
              where: { id: invitationId },
              data: { status: 'EXPIRED' },
            });
            await audit(
              tx,
              'ORGANIZATION_INVITATION_EXPIRED',
              'ORGANIZATION_INVITATION',
              invitationId,
              { organizationId: invitation.organizationId },
              now,
              requestId,
            );
            return false;
          }
          if (organization?.status !== 'ACTIVE') throw invalidOrExpiredToken();
          let actorUserId: string | undefined;
          if (decision === 'ACCEPTED') {
            const user = invitedUser
              ? await tx.user.findUnique({ where: { id: invitedUser.id } })
              : null;
            if (
              !user ||
              user.email !== invitation.email ||
              user.status !== 'ACTIVE' ||
              !user.emailVerifiedAt
            )
              throw invalidOrExpiredToken();
            const active = await tx.organizationMember.findFirst({
              where: {
                organizationId: invitation.organizationId,
                userId: user.id,
                status: 'ACTIVE',
              },
            });
            if (active) throw invalidOrExpiredToken();
            await tx.organizationMember.create({
              data: {
                organizationId: invitation.organizationId,
                userId: user.id,
                role: invitation.role,
                status: 'ACTIVE',
                invitationId,
              },
            });
            actorUserId = user.id;
          }
          const consumed = await tx.accountToken.updateMany({
            where: { id: token.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
            data: { consumedAt: now },
          });
          if (consumed.count !== 1) throw invalidOrExpiredToken();
          await tx.organizationInvitation.update({
            where: { id: invitationId },
            data: {
              status: decision,
              respondedAt: now,
              ...(actorUserId ? { acceptedByUserId: actorUserId } : {}),
            },
          });
          await audit(
            tx,
            decision === 'ACCEPTED'
              ? 'ORGANIZATION_INVITATION_ACCEPTED'
              : 'ORGANIZATION_INVITATION_REJECTED',
            'ORGANIZATION_INVITATION',
            invitationId,
            {
              organizationId: invitation.organizationId,
              ...(actorUserId ? { memberUserId: actorUserId } : {}),
            },
            now,
            requestId,
            actorUserId,
          );
          return true;
        }, serializable),
      ),
    );
    if (!accepted) throw invalidOrExpiredToken();
  }

  async changeRole(
    organizationId: string,
    memberId: string,
    role: MemberRole,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<void> {
    await this.memberCommand('ROLE', organizationId, memberId, role, cookie, csrf, requestId);
  }

  async revokeMember(
    organizationId: string,
    memberId: string,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<void> {
    await this.memberCommand(
      'REVOKE',
      organizationId,
      memberId,
      undefined,
      cookie,
      csrf,
      requestId,
    );
  }

  async leave(
    organizationId: string,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<void> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    let attempt = 0;
    await this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await observeOrganizationTransactionStart(tx, this.transactionObserver, {
            requestId,
            operation: 'ORGANIZATION_MEMBER_LEAVE',
            attempt: ++attempt,
          });
          const user = await this.sessions.lockAndRevalidate(tx, actor, csrf, true);
          await lockOrganization(tx, organizationId);
          await lockMembers(tx, organizationId);
          const context = await organizationContext(tx, organizationId, actor.userId, user);
          const now = await databaseNow(tx);
          ensureAnotherAdmin(context.members, context.actor.id);
          await tx.organizationMember.update({
            where: { id: context.actor.id },
            data: {
              status: 'LEFT',
              endedAt: now,
              endedReasonCode: 'SELF_LEFT',
            },
          });
          await audit(
            tx,
            'ORGANIZATION_MEMBER_LEFT',
            'ORGANIZATION_MEMBER',
            context.actor.id,
            { organizationId, previousRole: context.actor.role },
            now,
            requestId,
            actor.userId,
          );
        }, serializable),
      ),
    );
  }

  async transfer(
    organizationId: string,
    body: TransferBody,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<void> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    const targetCandidate = await this.memberCandidate(body.targetMemberId);
    if (!targetCandidate || targetCandidate.organizationId !== organizationId) throw notFound();
    let attempt = 0;
    await this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await observeOrganizationTransactionStart(tx, this.transactionObserver, {
            requestId,
            operation: 'ORGANIZATION_ADMIN_TRANSFER',
            attempt: ++attempt,
          });
          await lockUsers(tx, [actor.userId, targetCandidate.userId]);
          await lockSession(tx, actor.sessionId);
          const user = await this.sessions.revalidate(tx, actor, csrf, true);
          await lockOrganization(tx, organizationId);
          await lockMembers(tx, organizationId);
          const context = await organizationContext(tx, organizationId, actor.userId, user);
          if (!hasOrganizationCapability(context.capabilities, 'ORGANIZATION_ADMIN_TRANSFER'))
            throw forbidden();
          const target = context.members.find(({ id }) => id === body.targetMemberId);
          if (!target || target.status !== 'ACTIVE') throw notFound();
          if (target.id === context.actor.id) throw conflict();
          const targetUser = await tx.user.findUnique({ where: { id: target.userId } });
          if (!targetUser || targetUser.status !== 'ACTIVE' || !targetUser.emailVerifiedAt)
            throw conflict();
          if (body.retainCurrentAdmin && target.role === 'ADMIN') throw conflict();
          const now = await databaseNow(tx);
          if (target.role !== 'ADMIN')
            await tx.organizationMember.update({
              where: { id: target.id },
              data: { role: 'ADMIN' },
            });
          if (!body.retainCurrentAdmin)
            await tx.organizationMember.update({
              where: { id: context.actor.id },
              data: { role: 'PROFESSIONAL_MEMBER' },
            });
          await audit(
            tx,
            'ORGANIZATION_ADMIN_TRANSFERRED',
            'ORGANIZATION',
            organizationId,
            {
              sourceMemberId: context.actor.id,
              targetMemberId: target.id,
              retainCurrentAdmin: body.retainCurrentAdmin,
            },
            now,
            requestId,
            actor.userId,
          );
        }, serializable),
      ),
    );
  }

  private async memberCommand(
    action: 'ROLE' | 'REVOKE',
    organizationId: string,
    memberId: string,
    role: MemberRole | undefined,
    cookie: string | undefined,
    csrf: string | undefined,
    requestId: string,
  ): Promise<void> {
    const actor = await this.sessions.authenticate(cookie, csrf, true);
    const targetCandidate = await this.memberCandidate(memberId);
    if (!targetCandidate || targetCandidate.organizationId !== organizationId) throw notFound();
    let attempt = 0;
    await this.execute(() =>
      withSerializableRetry(() =>
        this.database.prisma.$transaction(async (tx) => {
          await observeOrganizationTransactionStart(tx, this.transactionObserver, {
            requestId,
            operation:
              action === 'ROLE' ? 'ORGANIZATION_MEMBER_ROLE' : 'ORGANIZATION_MEMBER_REVOKE',
            attempt: ++attempt,
          });
          await lockUsers(tx, [actor.userId, targetCandidate.userId]);
          await lockSession(tx, actor.sessionId);
          const user = await this.sessions.revalidate(tx, actor, csrf, true);
          await lockOrganization(tx, organizationId);
          await lockMembers(tx, organizationId);
          const context = await organizationContext(tx, organizationId, actor.userId, user);
          if (!hasOrganizationCapability(context.capabilities, 'ORGANIZATION_MEMBERS_MANAGE'))
            throw forbidden();
          const target = context.members.find(({ id }) => id === memberId);
          if (!target || target.status !== 'ACTIVE') throw notFound();
          if (target.id === context.actor.id) throw conflict();
          const now = await databaseNow(tx);
          if (action === 'ROLE') {
            if (target.role === role) throw conflict();
            if (role === 'ADMIN') {
              const targetUser = await tx.user.findUnique({ where: { id: target.userId } });
              if (!targetUser || targetUser.status !== 'ACTIVE' || !targetUser.emailVerifiedAt)
                throw conflict();
            }
            if (target.role === 'ADMIN') ensureAnotherAdmin(context.members, target.id);
            await tx.organizationMember.update({ where: { id: target.id }, data: { role: role! } });
            await audit(
              tx,
              'ORGANIZATION_MEMBER_ROLE_CHANGED',
              'ORGANIZATION_MEMBER',
              target.id,
              { organizationId, previousRole: target.role, newRole: role! },
              now,
              requestId,
              actor.userId,
            );
          } else {
            if (target.role === 'ADMIN') ensureAnotherAdmin(context.members, target.id);
            await tx.organizationMember.update({
              where: { id: target.id },
              data: {
                status: 'REVOKED',
                endedAt: now,
                endedReasonCode: 'ADMIN_REVOKED',
              },
            });
            await audit(
              tx,
              'ORGANIZATION_MEMBER_REVOKED',
              'ORGANIZATION_MEMBER',
              target.id,
              { organizationId, previousRole: target.role },
              now,
              requestId,
              actor.userId,
            );
          }
        }, serializable),
      ),
    );
  }

  private async consumeAdminLimit(
    action: 'ORGANIZATION_INVITE' | 'ORGANIZATION_INVITE_RESEND',
    actorId: string,
    organizationId: string,
  ): Promise<void> {
    const name =
      action === 'ORGANIZATION_INVITE' ? 'ORGANIZATION_INVITE' : 'ORGANIZATION_INVITE_RESEND';
    await this.rateLimits.consume([
      { action, dimension: 'ACTOR', value: actorId, policy: `${name}_ACTOR` },
      { action, dimension: 'ORGANIZATION', value: organizationId, policy: `${name}_ORGANIZATION` },
      {
        action,
        dimension: 'ACTOR_ORGANIZATION',
        value: `${actorId}\0${organizationId}`,
        policy: `${name}_ACTOR_ORGANIZATION`,
      },
    ]);
  }

  private async invitationCandidate(id: string) {
    return this.execute(() =>
      this.database.prisma.organizationInvitation.findUnique({
        where: { id },
        select: { id: true, organizationId: true, email: true, role: true },
      }),
    );
  }

  private async preflightAdmin(organizationId: string, actor: AuthenticatedSession): Promise<void> {
    await this.execute(() =>
      this.database.prisma.$transaction(async (tx) => {
        const user = await this.sessions.revalidate(tx, actor);
        await authorizeAdmin(tx, organizationId, actor.userId, user);
      }, serializable),
    );
  }

  private async memberCandidate(id: string) {
    return this.execute(() =>
      this.database.prisma.organizationMember.findUnique({
        where: { id },
        select: { userId: true, organizationId: true },
      }),
    );
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isPendingInvitationConflict(error)) throw conflict();
      throw securityDependencyUnavailable();
    }
  }
}

async function organizationContext(
  tx: Tx,
  organizationId: string,
  actorId: string,
  user: { status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'; emailVerifiedAt: Date | null },
) {
  const organization = await tx.organization.findUnique({ where: { id: organizationId } });
  const members = await tx.organizationMember.findMany({
    where: { organizationId },
    select: { id: true, userId: true, role: true, status: true },
    orderBy: { id: 'asc' },
  });
  const actor = members.find((member) => member.userId === actorId && member.status === 'ACTIVE');
  if (!organization || !actor) throw notFound();
  if (organization.status !== 'ACTIVE') throw forbidden();
  const capabilities = organizationCapabilities(user, organization, actor);
  return { organization, members, actor, capabilities };
}

async function authorizeAdmin(
  tx: Tx,
  organizationId: string,
  actorId: string,
  user: { status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'; emailVerifiedAt: Date | null },
) {
  const context = await organizationContext(tx, organizationId, actorId, user);
  if (!hasOrganizationCapability(context.capabilities, 'ORGANIZATION_MEMBERS_MANAGE'))
    throw forbidden();
  return context;
}

function ensureAnotherAdmin(members: readonly Member[], excludedId: string): void {
  if (
    !members.some(
      ({ id, role, status }) => id !== excludedId && role === 'ADMIN' && status === 'ACTIVE',
    )
  )
    throw conflict('La organización debe conservar un administrador activo.');
}

async function lockUsers(tx: Tx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort())
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user" WHERE "id" = ${id}::uuid FOR UPDATE`);
}

async function lockSession(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "session" WHERE "id" = ${id}::uuid FOR UPDATE`);
}

async function lockToken(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "account_token" WHERE "id" = ${id}::uuid FOR UPDATE`,
  );
}

async function lockInvitationTokens(tx: Tx, invitationId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "account_token" WHERE "organization_invitation_id" = ${invitationId}::uuid ORDER BY "id" FOR UPDATE`,
  );
}

async function lockOrganization(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "organization" WHERE "id" = ${id}::uuid FOR UPDATE`,
  );
}

async function lockMembers(tx: Tx, organizationId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "organization_member" WHERE "organization_id" = ${organizationId}::uuid ORDER BY "id" FOR UPDATE`,
  );
}

async function lockInvitations(tx: Tx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort())
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "organization_invitation" WHERE "id" = ${id}::uuid FOR UPDATE`,
    );
}

async function databaseNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS now`,
  );
  if (!(rows[0]?.now instanceof Date)) throw new Error('Reloj PostgreSQL no disponible.');
  return rows[0].now;
}

async function createInvitationToken(
  tx: Tx,
  material: ReturnType<typeof createInvitationTokenMaterial>['material'],
  expiresAt: Date,
): Promise<void> {
  await tx.accountToken.create({
    data: {
      id: material.id,
      purpose: 'ORGANIZATION_INVITATION',
      generation: material.generation,
      keyVersion: material.keyVersion,
      organizationInvitationId: material.subjectId,
      expiresAt,
    },
  });
}

async function invitationOutbox(
  tx: Tx,
  invitationId: string,
  organizationId: string,
  tokenId: string,
  generation: number,
  now: Date,
  requestId: string,
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      eventType: 'ORGANIZATION_INVITATION_REQUESTED',
      aggregateType: 'ORGANIZATION_INVITATION',
      aggregateId: invitationId,
      accountTokenId: tokenId,
      occurredAt: now,
      availableAt: now,
      payload: {
        invitationId,
        organizationId,
        purpose: 'ORGANIZATION_INVITATION',
        generation,
        template: 'organization_invitation',
        locale: 'es',
      },
      correlationId: requestId,
    },
  });
}

async function revokeTokens(tx: Tx, ids: readonly string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.accountToken.updateMany({
    where: { id: { in: [...ids] }, consumedAt: null, revokedAt: null },
    data: { revokedAt: now, revocationReasonCode: 'SUPERSEDED' },
  });
  await tx.outboxEvent.updateMany({
    where: { accountTokenId: { in: [...ids] }, status: 'PENDING' },
    data: { status: 'OBSOLETE', processedAt: now },
  });
  await tx.outboxEvent.updateMany({
    where: { accountTokenId: { in: [...ids] }, status: 'PROCESSING', lockedUntil: { lte: now } },
    data: {
      status: 'OBSOLETE',
      processedAt: now,
      lockedAt: null,
      lockedUntil: null,
      lockedBy: null,
      lockToken: null,
    },
  });
}

async function audit(
  tx: Tx,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Prisma.InputJsonObject,
  now: Date,
  requestId: string,
  actorUserId?: string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      actorType: actorUserId ? 'USER' : 'ANONYMOUS',
      ...(actorUserId ? { actorUserId } : {}),
      action,
      resourceType,
      resourceId,
      metadata,
      occurredAt: now,
      requestId,
      correlationId: requestId,
    },
  });
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function notFound(): ApiError {
  return new ApiError(404, 'ORGANIZATION_NOT_FOUND', 'El recurso no existe.');
}

function forbidden(): ApiError {
  return new ApiError(403, 'ORGANIZATION_FORBIDDEN', 'No tienes permiso para esta acción.');
}

function conflict(message = 'La operación no es válida en el estado actual.'): ApiError {
  return new ApiError(409, 'ORGANIZATION_CONFLICT', message);
}

function isPendingInvitationConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; meta?: { target?: unknown } } | null;
  return (
    candidate?.code === 'P2002' && candidate.meta?.target === 'organization_invitation_pending_uq'
  );
}

export function isInvitationGenerationConflict(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    meta?: { modelName?: unknown; target?: unknown };
  } | null;
  const target = candidate?.meta?.target;
  return (
    candidate?.code === 'P2002' &&
    candidate.meta?.modelName === 'AccountToken' &&
    Array.isArray(target) &&
    target.length === 3 &&
    target[0] === 'purpose' &&
    target[1] === 'organization_invitation_id' &&
    target[2] === 'generation'
  );
}
