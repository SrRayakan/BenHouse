import type { PrismaClient } from '@benhouse/database';

type CleanupStep = { name: string; run: () => unknown | Promise<unknown> };

// Exclusivo de pruebas. Cada fallo conserva su causa y no impide los demás intentos.
export async function runCleanupSteps(steps: CleanupStep[], originalErrors: unknown[] = []) {
  const errors = [...originalErrors];
  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      errors.push(new Error(`Limpieza B1.5: ${step.name}`, { cause }));
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Fallos durante el cierre de B1.5', { cause: errors[0] });
  }
}

export async function cleanupOrganizationAdministration(options: {
  database?: PrismaClient;
  userIds: readonly string[];
  organizationIds: readonly string[];
  requestIds: ReadonlySet<string>;
  resources: CleanupStep[];
  restoreDatabaseUrl: () => void;
  originalErrors?: unknown[];
}) {
  const { database, userIds, requestIds } = options;
  const organizationIds = new Set(options.organizationIds);
  await runCleanupSteps(
    [
      {
        name: 'datos de esta ejecución',
        run: async () => {
          if (!database) return;
          const discoveryErrors: unknown[] = [];
          // Recupera un POST confirmado en PostgreSQL cuya respuesta no llegó al helper.
          // Solo los usuarios registrados tras create pertenecen a esta ejecución.
          try {
            const organizations = await database.organization.findMany({
              where: { createdByUserId: { in: [...userIds] } },
              select: { id: true },
            });
            for (const { id } of organizations) organizationIds.add(id);
          } catch (cause) {
            discoveryErrors.push(new Error('Limpieza B1.5: recuperar organizaciones', { cause }));
          }
          await runCleanupSteps(
            [
              {
                name: 'auditoría de peticiones registradas',
                run: async () => {
                  if (!requestIds.size) return;
                  // El DDL y el DELETE comparten transacción: cualquier fallo restaura el trigger.
                  await database.$transaction(async (tx) => {
                    await tx.$executeRawUnsafe(
                      'ALTER TABLE "audit_event" DISABLE TRIGGER "audit_event_append_only_trg"',
                    );
                    await tx.auditEvent.deleteMany({
                      where: { requestId: { in: [...requestIds] } },
                    });
                    await tx.$executeRawUnsafe(
                      'ALTER TABLE "audit_event" ENABLE TRIGGER "audit_event_append_only_trg"',
                    );
                  });
                },
              },
              ...[...organizationIds].flatMap((id): CleanupStep[] => [
                {
                  name: `outbox de organización ${id}`,
                  run: () =>
                    database.outboxEvent.deleteMany({
                      where: { accountToken: { organizationInvitation: { organizationId: id } } },
                    }),
                },
                {
                  name: `tokens de organización ${id}`,
                  run: () =>
                    database.accountToken.deleteMany({
                      where: { organizationInvitation: { organizationId: id } },
                    }),
                },
                {
                  name: `miembros de organización ${id}`,
                  run: () =>
                    database.organizationMember.deleteMany({ where: { organizationId: id } }),
                },
                {
                  name: `invitaciones de organización ${id}`,
                  run: () =>
                    database.organizationInvitation.deleteMany({ where: { organizationId: id } }),
                },
                {
                  name: `organización ${id}`,
                  run: () => database.organization.deleteMany({ where: { id } }),
                },
              ]),
              ...userIds.flatMap((id): CleanupStep[] => [
                {
                  name: `sesiones de usuario ${id}`,
                  run: () => database.session.deleteMany({ where: { userId: id } }),
                },
                {
                  name: `usuario ${id}`,
                  run: async () => {
                    // ON DELETE SET NULL está permitido por el trigger de auditoría.
                    // No mutar eventos que hayan sobrevivido al intento de limpieza.
                    const result = await database.user.deleteMany({
                      where: { id, auditEvents: { none: {} } },
                    });
                    if (
                      !result.count &&
                      (await database.user.findUnique({ where: { id }, select: { id: true } }))
                    ) {
                      throw new Error(`Usuario ${id} conservado por auditoría pendiente`);
                    }
                  },
                },
              ]),
            ],
            discoveryErrors,
          );
        },
      },
      ...options.resources,
      { name: 'restaurar DATABASE_URL', run: options.restoreDatabaseUrl },
    ],
    options.originalErrors,
  );
}
