import '../../test/verified-database.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@benhouse/database';
import {
  cleanupOrganizationAdministration,
  runCleanupSteps,
} from './organization-administration-test-cleanup';

describe('limpieza B1.5 en PostgreSQL', () => {
  const database = createPrismaClient();
  const allUsers: string[] = [];
  const allRequests = new Set<string>();

  beforeAll(async () => {
    const rows = await database.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    expect(rows[0]?.name).toBe(process.env.API_TEST_DATABASE_NAME);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanupOrganizationAdministration({
      database,
      userIds: allUsers,
      organizationIds: [],
      requestIds: allRequests,
      resources: [{ name: 'cliente de regresiones', run: () => database.$disconnect() }],
      restoreDatabaseUrl: () => undefined,
    });
  });

  async function fixture(requestId: string, complete = true) {
    const user = await database.user.create({
      data: { email: `b15-cleanup-${randomUUID()}@example.test`, displayName: 'B1.5 sintético' },
    });
    allUsers.push(user.id);
    const now = new Date();
    const session = await database.session.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        secretDigest: randomBytes(32),
        secretKeyVersion: 1,
        issuedSessionVersion: user.sessionVersion,
        createdAt: now,
        lastActivityAt: now,
        idleExpiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 120_000),
      },
    });
    if (!complete) return { user, session };
    const organization = await database.organization.create({
      data: { name: 'B1.5 nombre sintético compartido', createdByUserId: user.id },
    });
    const invitation = await database.organizationInvitation.create({
      data: {
        organizationId: organization.id,
        invitedByUserId: user.id,
        email: user.email,
        role: 'ADMIN',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const member = await database.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: 'ADMIN', status: 'ACTIVE' },
    });
    const token = await database.accountToken.create({
      data: {
        purpose: 'ORGANIZATION_INVITATION',
        generation: 1,
        keyVersion: 1,
        organizationInvitationId: invitation.id,
        expiresAt: invitation.expiresAt,
      },
    });
    const outbox = await database.outboxEvent.create({
      data: {
        eventType: 'ORGANIZATION_INVITATION_REQUESTED',
        eventVersion: 1,
        aggregateType: 'OrganizationInvitation',
        aggregateId: invitation.id,
        accountTokenId: token.id,
      },
    });
    allRequests.add(requestId);
    const audit = await database.auditEvent.create({
      data: {
        actorType: 'USER',
        actorUserId: user.id,
        action: 'B15_CLEANUP_SYNTHETIC',
        resourceType: 'Organization',
        resourceId: organization.id,
        requestId,
      },
    });
    return { user, session, organization, invitation, member, token, outbox, audit };
  }

  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      user: await database.user.findUnique({ where: { id: f.user.id } }),
      session: await database.session.findUnique({ where: { id: f.session.id } }),
      ...(f.organization
        ? {
            organization: await database.organization.findUnique({
              where: { id: f.organization.id },
            }),
            invitation: await database.organizationInvitation.findUnique({
              where: { id: f.invitation!.id },
            }),
            member: await database.organizationMember.findUnique({ where: { id: f.member!.id } }),
            token: await database.accountToken.findUnique({ where: { id: f.token!.id } }),
            outbox: await database.outboxEvent.findUnique({ where: { id: f.outbox!.id } }),
            audit: await database.auditEvent.findUnique({ where: { id: f.audit!.id } }),
          }
        : {}),
    };
  }

  async function assertAuditProtected(id: string) {
    const rows = await database.$queryRaw<Array<{ enabled: string }>>`
      SELECT tgenabled::text AS enabled FROM pg_trigger
      WHERE tgrelid = 'audit_event'::regclass AND tgname = 'audit_event_append_only_trg'
    `;
    expect(rows).toEqual([{ enabled: 'O' }]);
    await expect(
      database.auditEvent.update({ where: { id }, data: { action: 'MUTATED' } }),
    ).rejects.toThrow();
    await expect(database.auditEvent.delete({ where: { id } })).rejects.toThrow();
  }

  it('recupera preparación parcial, limita los borrados a IDs propios y preserva nombres y prefijos coincidentes', async () => {
    const requestId = `b15-${randomUUID()}`;
    const own = await fixture(requestId);
    const partial = await fixture(randomUUID(), false);
    const withoutSession = await database.user.create({
      data: {
        email: `b15-cleanup-${randomUUID()}@example.test`,
        displayName: 'Preparación parcial sintética',
      },
    });
    allUsers.push(withoutSession.id);
    const foreign = await fixture(`${requestId}-ajeno`);
    const before = await snapshot(foreign);
    await cleanupOrganizationAdministration({
      database,
      userIds: [own.user.id, partial.user.id, withoutSession.id],
      organizationIds: [],
      requestIds: new Set([requestId]),
      resources: [],
      restoreDatabaseUrl: () => undefined,
    });
    expect(Object.values(await snapshot(own))).toEqual(Array(8).fill(null));
    expect(await snapshot(partial)).toEqual({ user: null, session: null });
    expect(await database.user.findUnique({ where: { id: withoutSession.id } })).toBeNull();
    expect(await snapshot(foreign)).toEqual(before);
    await assertAuditProtected(foreign.audit!.id);
  });

  for (const phase of ['discovery', 'outbox', 'audit'] as const) {
    it(`continúa limpiezas independientes y cierre tras fallo de ${phase}`, async () => {
      const requestId = `b15-${randomUUID()}`;
      const own = await fixture(requestId);
      const independentRequestId = `b15-${randomUUID()}`;
      const independent = await fixture(independentRequestId, phase !== 'audit');
      const foreign = await fixture(`${requestId}-ajeno`);
      const before = await snapshot(foreign);
      const original = new Error(`Fallo original ${phase}`);
      const failure = new Error(`Fallo sintético ${phase}`);
      let client = database;
      if (phase === 'discovery')
        vi.spyOn(database.organization, 'findMany').mockRejectedValueOnce(failure);
      if (phase === 'outbox')
        vi.spyOn(database.outboxEvent, 'deleteMany').mockRejectedValueOnce(failure);
      if (phase === 'audit') {
        // Se ejecuta DELETE dentro de la transacción real, después de DISABLE TRIGGER.
        // Fallar aquí debe revertir tanto DELETE como ALTER TABLE.
        client = database.$extends({
          query: {
            auditEvent: {
              async deleteMany({ args, query }) {
                await query(args);
                throw failure;
              },
            },
          },
        }) as unknown as PrismaClient;
      }
      const closed: string[] = [];
      const prior = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'postgresql://temporal';
      try {
        await expect(
          cleanupOrganizationAdministration({
            database: client,
            userIds: [own.user.id, independent.user.id],
            organizationIds: [
              own.organization!.id,
              ...(independent.organization ? [independent.organization.id] : []),
            ],
            requestIds: new Set([requestId, independentRequestId]),
            originalErrors: [original],
            resources: [
              {
                name: 'app',
                run: () => {
                  closed.push('app');
                  throw new Error('Cierre sintético');
                },
              },
              {
                name: 'cliente',
                run: () => {
                  closed.push('cliente');
                },
              },
              {
                name: 'observador',
                run: () => {
                  closed.push('observador');
                },
              },
            ],
            restoreDatabaseUrl: () => {
              if (prior === undefined) delete process.env.DATABASE_URL;
              else process.env.DATABASE_URL = prior;
            },
          }),
        ).rejects.toSatisfy((error: AggregateError) => {
          expect(error.errors[0]).toBe(original);
          expect(error.cause).toBe(original);
          expect(containsCause(error, failure)).toBe(true);
          return true;
        });
        expect(closed).toEqual(['app', 'cliente', 'observador']);
        expect(process.env.DATABASE_URL).toBe(prior);
        expect(Object.values(await snapshot(independent))).toEqual(
          Array(phase === 'audit' ? 2 : 8).fill(null),
        );
        expect(await snapshot(foreign)).toEqual(before);
        await assertAuditProtected(foreign.audit!.id);
        if (phase === 'audit') {
          expect(await database.auditEvent.findUnique({ where: { id: own.audit!.id } })).toEqual(
            own.audit,
          );
          await assertAuditProtected(own.audit!.id);
          expect(await database.user.findUnique({ where: { id: own.user.id } })).toEqual(own.user);
          expect(await database.session.findUnique({ where: { id: own.session.id } })).toBeNull();
          expect(
            await database.organization.findUnique({ where: { id: own.organization!.id } }),
          ).toBeNull();
        }
        if (phase === 'outbox') {
          // Las FK conservan la cadena dependiente; miembros y sesiones sí se limpian.
          expect(await database.outboxEvent.findUnique({ where: { id: own.outbox!.id } })).toEqual(
            own.outbox,
          );
          expect(
            await database.organizationMember.findUnique({ where: { id: own.member!.id } }),
          ).toBeNull();
          expect(await database.session.findUnique({ where: { id: own.session.id } })).toBeNull();
          expect(await database.auditEvent.findUnique({ where: { id: own.audit!.id } })).toBeNull();
        }
        if (phase === 'discovery')
          expect(Object.values(await snapshot(own))).toEqual(Array(8).fill(null));
      } finally {
        vi.restoreAllMocks();
        await runCleanupSteps([
          {
            name: 'restaurar entorno de regresión',
            run: () => {
              if (prior === undefined) delete process.env.DATABASE_URL;
              else process.env.DATABASE_URL = prior;
            },
          },
          {
            name: 'recuperar solo fixtures de regresión',
            run: () =>
              cleanupOrganizationAdministration({
                database,
                userIds: [own.user.id, independent.user.id, foreign.user.id],
                organizationIds: [],
                requestIds: new Set([requestId, independentRequestId, `${requestId}-ajeno`]),
                resources: [],
                restoreDatabaseUrl: () => undefined,
              }),
          },
        ]);
      }
    });
  }
});

function containsCause(error: unknown, expected: Error): boolean {
  if (error === expected) return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((child) => containsCause(child, expected))
  )
    return true;
  return error instanceof Error && containsCause(error.cause, expected);
}
