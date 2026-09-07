import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createPrismaClient } from './prisma-client';

const rollback = new Error('ROLLBACK_IDENTITY_TEST');

type ExpectedDatabaseError = {
  sqlState: string;
  constraint?: string;
  table?: string;
  column?: string;
};

class PartialIndexMismatchError extends Error {
  constructor(
    readonly indexName: string,
    readonly field: keyof PartialIndexDefinition | 'presence',
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super(
      `Índice parcial ${indexName}: ${field} esperaba ${JSON.stringify(expected)} y recibió ${JSON.stringify(actual)}`,
    );
    this.name = 'PartialIndexMismatchError';
  }
}

type PartialIndexDefinition = {
  name: string;
  table: string;
  method: string;
  unique: boolean;
  columns: string[];
  directions: string[];
  predicate: string;
};

const expectedPartialIndexes: PartialIndexDefinition[] = [
  {
    name: 'account_token_invitation_generation_uq',
    table: 'account_token',
    method: 'btree',
    unique: true,
    columns: ['purpose', 'organization_invitation_id', 'generation'],
    directions: ['ASC', 'ASC', 'ASC'],
    predicate: 'organization_invitation_idisnotnull',
  },
  {
    name: 'account_token_invitation_latest_idx',
    table: 'account_token',
    method: 'btree',
    unique: false,
    columns: ['purpose', 'organization_invitation_id', 'generation'],
    directions: ['ASC', 'ASC', 'DESC'],
    predicate: 'organization_invitation_idisnotnull',
  },
  {
    name: 'account_token_user_generation_uq',
    table: 'account_token',
    method: 'btree',
    unique: true,
    columns: ['purpose', 'user_id', 'generation'],
    directions: ['ASC', 'ASC', 'ASC'],
    predicate: 'user_idisnotnull',
  },
  {
    name: 'account_token_user_latest_idx',
    table: 'account_token',
    method: 'btree',
    unique: false,
    columns: ['purpose', 'user_id', 'generation'],
    directions: ['ASC', 'ASC', 'DESC'],
    predicate: 'user_idisnotnull',
  },
  {
    name: 'organization_invitation_pending_uq',
    table: 'organization_invitation',
    method: 'btree',
    unique: true,
    columns: ['organization_id', 'email'],
    directions: ['ASC', 'ASC'],
    predicate: "status='pending'",
  },
  {
    name: 'organization_member_active_uq',
    table: 'organization_member',
    method: 'btree',
    unique: true,
    columns: ['organization_id', 'user_id'],
    directions: ['ASC', 'ASC'],
    predicate: "status='active'",
  },
  {
    name: 'organization_member_invitation_uq',
    table: 'organization_member',
    method: 'btree',
    unique: true,
    columns: ['invitation_id'],
    directions: ['ASC'],
    predicate: 'invitation_idisnotnull',
  },
  {
    name: 'outbox_event_account_token_uq',
    table: 'outbox_event',
    method: 'btree',
    unique: true,
    columns: ['account_token_id'],
    directions: ['ASC'],
    predicate: 'account_token_idisnotnull',
  },
  {
    name: 'outbox_event_expired_lease_idx',
    table: 'outbox_event',
    method: 'btree',
    unique: false,
    columns: ['locked_until'],
    directions: ['ASC'],
    predicate: "status='processing'",
  },
  {
    name: 'outbox_event_lock_token_uq',
    table: 'outbox_event',
    method: 'btree',
    unique: true,
    columns: ['lock_token'],
    directions: ['ASC'],
    predicate: 'lock_tokenisnotnull',
  },
];

function normalizePredicate(predicate: string) {
  return predicate
    .replace(/"/g, '')
    .replace(/::[a-z_][a-z0-9_]*/gi, '')
    .replace(/[()\s]/g, '')
    .toLowerCase();
}

function databaseErrorText(error: unknown): string {
  const fragments: string[] = [];
  const visited = new Set<object>();

  function visit(value: unknown, depth = 0) {
    if (value === null || value === undefined || depth > 8) return;
    if (typeof value === 'string' || typeof value === 'number') {
      fragments.push(String(value));
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);

    for (const key of Object.getOwnPropertyNames(value)) {
      fragments.push(key);
      try {
        visit((value as Record<string, unknown>)[key], depth + 1);
      } catch {
        // Algunos errores del driver exponen getters no inspeccionables.
      }
    }
  }

  visit(error);
  return fragments.join('\n');
}

function expectDatabaseError(error: unknown, expected: ExpectedDatabaseError) {
  const details = databaseErrorText(error);
  const sqlStates = details.match(/\b(?:22|23|42|55)[0-9A-Z]{3}\b/g) ?? [];

  expect(sqlStates, `No se encontró el SQLSTATE ${expected.sqlState} en:\n${details}`).toContain(
    expected.sqlState,
  );
  if (expected.constraint) {
    expect(details).toMatch(new RegExp(`constraint[^\\n]{0,40}${expected.constraint}\\b`, 'i'));
  }
  if (expected.table) {
    expect(details).toMatch(
      new RegExp(`(?:table(?:_name)?|relation)[^\\n]{0,40}${expected.table}\\b`, 'i'),
    );
  }
  if (expected.column) {
    expect(details).toMatch(new RegExp(`column(?:_name)?[^\\n]{0,40}${expected.column}\\b`, 'i'));
  }
}

describe('persistencia B1 Identity Core', () => {
  let client: PrismaClient;

  beforeAll(async () => {
    client = createPrismaClient();
    await client.$connect();
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  async function rollbackAfter(assertions: (tx: Prisma.TransactionClient) => Promise<void>) {
    try {
      await client.$transaction(async (tx) => {
        await assertions(tx);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function expectDatabaseRejection(
    operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
    expected: ExpectedDatabaseError,
  ) {
    let error: unknown;
    try {
      await client.$transaction(operation);
    } catch (caught) {
      error = caught;
    }
    expect(error, 'La operación inválida fue aceptada por PostgreSQL').toBeDefined();
    expectDatabaseError(error, expected);
  }

  async function expectConstraintViolation<T>(
    expected: ExpectedDatabaseError,
    prepare: (tx: Prisma.TransactionClient) => Promise<T>,
    violate: (tx: Prisma.TransactionClient, fixture: T) => Promise<unknown>,
  ) {
    let prepared = false;
    await expectDatabaseRejection(async (tx) => {
      const fixture = await prepare(tx);
      prepared = true;
      return violate(tx, fixture);
    }, expected);
    expect(prepared, `El fixture de ${expected.constraint ?? expected.table} no terminó`).toBe(
      true,
    );
  }

  async function executeWithCapturedDiagnostic(tx: Prisma.TransactionClient, statement: string) {
    if (statement.includes('$captured_statement$')) {
      throw new Error('El SQL de prueba contiene el delimitador reservado.');
    }
    return tx.$executeRawUnsafe(`
      DO $capture_diagnostic$
      DECLARE
        captured_state text;
        captured_constraint text;
        captured_table text;
        captured_column text;
      BEGIN
        BEGIN
          EXECUTE $captured_statement$${statement}$captured_statement$;
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS
            captured_state = RETURNED_SQLSTATE,
            captured_constraint = CONSTRAINT_NAME,
            captured_table = TABLE_NAME,
            captured_column = COLUMN_NAME;
          RAISE EXCEPTION 'captured sqlstate=%, constraint=%, table=%, column=%',
            captured_state,
            coalesce(captured_constraint, ''),
            coalesce(captured_table, ''),
            coalesce(captured_column, '')
            USING ERRCODE = 'P0001';
        END;
        RAISE EXCEPTION 'La sentencia inválida fue aceptada' USING ERRCODE = 'P0002';
      END
      $capture_diagnostic$;
    `);
  }

  async function readPartialIndexes(queryable: Prisma.TransactionClient | PrismaClient) {
    const rows = await queryable.$queryRaw<
      Array<Omit<PartialIndexDefinition, 'predicate'> & { predicate: string }>
    >`
      SELECT
        index_class.relname AS name,
        table_class.relname AS "table",
        access_method.amname AS method,
        index_catalog.indisunique AS "unique",
        array_agg(attribute.attname ORDER BY key.ordinality)::text[] AS columns,
        array_agg(
          CASE WHEN (index_catalog.indoption[key.ordinality - 1] & 1) = 1
            THEN 'DESC' ELSE 'ASC' END
          ORDER BY key.ordinality
        )::text[] AS directions,
        pg_get_expr(index_catalog.indpred, index_catalog.indrelid, false) AS predicate
      FROM pg_index AS index_catalog
      JOIN pg_class AS index_class ON index_class.oid = index_catalog.indexrelid
      JOIN pg_class AS table_class ON table_class.oid = index_catalog.indrelid
      JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
      JOIN pg_am AS access_method ON access_method.oid = index_class.relam
      CROSS JOIN LATERAL unnest(index_catalog.indkey)
        WITH ORDINALITY AS key(attribute_number, ordinality)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = table_class.oid
        AND attribute.attnum = key.attribute_number
      WHERE namespace.nspname = current_schema()
        AND index_catalog.indpred IS NOT NULL
        AND key.ordinality <= index_catalog.indnkeyatts
      GROUP BY
        index_class.relname,
        table_class.relname,
        access_method.amname,
        index_catalog.indisunique,
        index_catalog.indpred,
        index_catalog.indrelid
      ORDER BY index_class.relname
    `;

    return rows.map((row) => ({ ...row, predicate: normalizePredicate(row.predicate) }));
  }

  async function assertExactPartialIndexes(queryable: Prisma.TransactionClient | PrismaClient) {
    const actualIndexes = await readPartialIndexes(queryable);
    const actualByName = new Map(actualIndexes.map((index) => [index.name, index]));

    for (const expectedIndex of expectedPartialIndexes) {
      const actualIndex = actualByName.get(expectedIndex.name);
      if (!actualIndex) {
        throw new PartialIndexMismatchError(expectedIndex.name, 'presence', true, false);
      }
      for (const field of [
        'table',
        'method',
        'unique',
        'columns',
        'directions',
        'predicate',
      ] as const) {
        if (JSON.stringify(actualIndex[field]) !== JSON.stringify(expectedIndex[field])) {
          throw new PartialIndexMismatchError(
            expectedIndex.name,
            field,
            expectedIndex[field],
            actualIndex[field],
          );
        }
      }
      actualByName.delete(expectedIndex.name);
    }

    const unexpected = actualByName.values().next().value as PartialIndexDefinition | undefined;
    if (unexpected) {
      throw new PartialIndexMismatchError(unexpected.name, 'presence', false, true);
    }
  }

  async function createUser(tx: Prisma.TransactionClient, email = `${randomUUID()}@example.test`) {
    return tx.user.create({ data: { email, displayName: 'Persona de prueba' } });
  }

  async function createOrganization(tx: Prisma.TransactionClient, createdByUserId: string) {
    return tx.organization.create({
      data: { name: 'Organización de prueba', createdByUserId },
    });
  }

  async function createInvitation(
    tx: Prisma.TransactionClient,
    organizationId: string,
    invitedByUserId: string,
    email = `${randomUUID()}@example.test`,
  ) {
    return tx.organizationInvitation.create({
      data: {
        organizationId,
        email,
        role: 'PROFESSIONAL_MEMBER',
        invitedByUserId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  }

  const checkViolation = (constraint: string, table: string): ExpectedDatabaseError => ({
    sqlState: '23514',
    constraint,
    table,
  });

  const uniqueViolation = (constraint: string, table: string): ExpectedDatabaseError => ({
    sqlState: '23505',
    constraint,
    table,
  });

  const foreignKeyViolation = (constraint: string, table: string): ExpectedDatabaseError => ({
    sqlState: '23503',
    constraint,
    table,
  });

  const notNullViolation = (table: string, column: string): ExpectedDatabaseError => ({
    sqlState: '23502',
    table,
    column,
  });

  const appendOnlyViolation = (): ExpectedDatabaseError => ({ sqlState: '55000' });

  describe('helpers de atribución exacta', () => {
    const expected = checkViolation('account_token_subject_xor_chk', 'account_token');

    it('no confunde una avería de conexión o consulta con una constraint', () => {
      expect(() =>
        expectDatabaseError(
          { code: 'P1001', message: 'No se puede alcanzar el servidor de base de datos' },
          expected,
        ),
      ).toThrow();
    });

    it('rechaza SQLSTATE correcto con constraint incorrecta', () => {
      expect(() =>
        expectDatabaseError(
          {
            database_error: 'sqlstate=23514 constraint=otra_constraint table=account_token',
          },
          expected,
        ),
      ).toThrow();
    });

    it('rechaza constraint correcta con tabla incorrecta', () => {
      expect(() =>
        expectDatabaseError(
          {
            database_error:
              'sqlstate=23514 constraint=account_token_subject_xor_chk table=otra_tabla',
          },
          expected,
        ),
      ).toThrow();
    });
  });

  describe('User y PasswordCredential', () => {
    it('impone email único y una sola credencial por usuario', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx, 'unique@example.test');
          const now = new Date();
          await tx.passwordCredential.create({
            data: {
              userId: user.id,
              passwordHash: '$argon2id$first',
              createdAt: now,
              passwordChangedAt: now,
            },
          });
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "password_credential" SELECT * FROM "password_credential" WHERE "user_id" = '${user.id}'::uuid`,
          );
        },
        uniqueViolation('password_credential_pkey', 'password_credential'),
      );

      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx, 'duplicate@example.test');
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "user" ("id", "email", "display_name", "updated_at") SELECT gen_random_uuid(), "email", "display_name", now() FROM "user" WHERE "id" = '${user.id}'::uuid`,
          );
        },
        uniqueViolation('user_email_uq', 'user'),
      );
    });

    it.each([
      [
        'sessionVersion cero',
        { email: 'version@example.test', displayName: 'Nombre', sessionVersion: 0 },
        'user_session_version_chk',
      ],
      [
        'email no canónico',
        { email: 'Upper@example.test', displayName: 'Nombre' },
        'user_email_canonical_chk',
      ],
      ['nombre vacío', { email: 'name@example.test', displayName: '' }, 'user_display_name_chk'],
      [
        'nombre sobre el límite en bytes',
        { email: 'bytes@example.test', displayName: '😀'.repeat(61) },
        'user_display_name_chk',
      ],
    ])('rechaza %s', async (_case, data, constraint) => {
      await expectDatabaseRejection(
        (tx) => tx.user.create({ data }),
        checkViolation(constraint, 'user'),
      );
    });

    it('protege la FK de credencial con ON DELETE RESTRICT', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const now = new Date();
          await tx.passwordCredential.create({
            data: {
              userId: user.id,
              passwordHash: '$argon2id$credential',
              createdAt: now,
              passwordChangedAt: now,
            },
          });
          return executeWithCapturedDiagnostic(
            tx,
            `DELETE FROM "user" WHERE "id" = '${user.id}'::uuid`,
          );
        },
        foreignKeyViolation('password_credential_user_id_fkey', 'password_credential'),
      );
    });
  });

  describe('Session', () => {
    it('acepta una sesión temporalmente coherente', async () => {
      await rollbackAfter(async (tx) => {
        const user = await createUser(tx);
        const now = new Date();
        const session = await tx.session.create({
          data: {
            secretDigest: randomBytes(32),
            secretKeyVersion: 1,
            userId: user.id,
            issuedSessionVersion: 1,
            createdAt: now,
            lastActivityAt: now,
            idleExpiresAt: new Date(now.getTime() + 30_000),
            absoluteExpiresAt: new Date(now.getTime() + 60_000),
          },
        });
        expect(session.revokedAt).toBeNull();
      });
    });

    it.each([
      ['digest corto', randomBytes(31), 1, 1, 'session_secret_digest_length_chk'],
      ['versión de clave cero', randomBytes(32), 0, 1, 'session_key_version_chk'],
      ['versión de sesión cero', randomBytes(32), 1, 0, 'session_issued_version_chk'],
    ])('rechaza %s', async (_case, digest, keyVersion, issuedVersion, constraint) => {
      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const now = new Date();
          await tx.session.create({
            data: {
              secretDigest: digest,
              secretKeyVersion: keyVersion,
              userId: user.id,
              issuedSessionVersion: issuedVersion,
              createdAt: now,
              lastActivityAt: now,
              idleExpiresAt: new Date(now.getTime() + 30_000),
              absoluteExpiresAt: new Date(now.getTime() + 60_000),
            },
          });
        },
        checkViolation(constraint, 'session'),
      );
    });

    it('rechaza expiraciones desordenadas y revocación parcial', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const now = new Date();
          await tx.session.create({
            data: {
              secretDigest: randomBytes(32),
              secretKeyVersion: 1,
              userId: user.id,
              issuedSessionVersion: 1,
              createdAt: now,
              lastActivityAt: now,
              idleExpiresAt: new Date(now.getTime() + 60_000),
              absoluteExpiresAt: new Date(now.getTime() + 30_000),
            },
          });
        },
        checkViolation('session_time_order_chk', 'session'),
      );

      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const now = new Date();
          await tx.session.create({
            data: {
              secretDigest: randomBytes(32),
              secretKeyVersion: 1,
              userId: user.id,
              issuedSessionVersion: 1,
              createdAt: now,
              lastActivityAt: now,
              idleExpiresAt: new Date(now.getTime() + 30_000),
              absoluteExpiresAt: new Date(now.getTime() + 60_000),
              revokedAt: now,
            },
          });
        },
        checkViolation('session_revocation_chk', 'session'),
      );
    });

    it.each([
      ['createdAt posterior a lastActivityAt', 0, -1, 30_000, 60_000],
      ['lastActivityAt posterior a idleExpiresAt', 0, 30_000, 20_000, 60_000],
      ['idleExpiresAt posterior a absoluteExpiresAt', 0, 10_000, 60_000, 30_000],
    ])(
      'atribuye el orden temporal completo: %s',
      async (_case, createdOffset, activityOffset, idleOffset, absoluteOffset) => {
        await expectConstraintViolation(
          checkViolation('session_time_order_chk', 'session'),
          createUser,
          (tx, user) => {
            const origin = new Date();
            return tx.session.create({
              data: {
                secretDigest: randomBytes(32),
                secretKeyVersion: 1,
                userId: user.id,
                issuedSessionVersion: 1,
                createdAt: new Date(origin.getTime() + createdOffset),
                lastActivityAt: new Date(origin.getTime() + activityOffset),
                idleExpiresAt: new Date(origin.getTime() + idleOffset),
                absoluteExpiresAt: new Date(origin.getTime() + absoluteOffset),
              },
            });
          },
        );
      },
    );

    it('protege User mediante ON DELETE RESTRICT', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const now = new Date();
          await tx.session.create({
            data: {
              secretDigest: randomBytes(32),
              secretKeyVersion: 1,
              userId: user.id,
              issuedSessionVersion: 1,
              createdAt: now,
              lastActivityAt: now,
              idleExpiresAt: new Date(now.getTime() + 30_000),
              absoluteExpiresAt: new Date(now.getTime() + 60_000),
            },
          });
          return executeWithCapturedDiagnostic(
            tx,
            `DELETE FROM "user" WHERE "id" = '${user.id}'::uuid`,
          );
        },
        foreignKeyViolation('session_user_id_fkey', 'session'),
      );
    });
  });

  describe('AccountToken', () => {
    it('acepta los dos tipos de sujeto con propósito compatible', async () => {
      await rollbackAfter(async (tx) => {
        const user = await createUser(tx);
        const organization = await createOrganization(tx, user.id);
        const invitation = await createInvitation(tx, organization.id, user.id);
        const expiresAt = new Date(Date.now() + 60_000);
        await tx.accountToken.create({
          data: {
            purpose: 'EMAIL_VERIFICATION',
            generation: 1,
            keyVersion: 1,
            userId: user.id,
            expiresAt,
          },
        });
        await tx.accountToken.create({
          data: {
            purpose: 'ORGANIZATION_INVITATION',
            generation: 1,
            keyVersion: 1,
            organizationInvitationId: invitation.id,
            expiresAt,
          },
        });
      });
    });

    it('rechaza ausencia de sujeto y sujeto incompatible sin solapar constraints', async () => {
      await expectDatabaseRejection(
        (tx) =>
          tx.accountToken.create({
            data: {
              purpose: 'EMAIL_VERIFICATION',
              generation: 1,
              keyVersion: 1,
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
        checkViolation('account_token_subject_xor_chk', 'account_token'),
      );

      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          await tx.accountToken.create({
            data: {
              purpose: 'ORGANIZATION_INVITATION',
              generation: 1,
              keyVersion: 1,
              userId: user.id,
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
        },
        checkViolation('account_token_purpose_subject_chk', 'account_token'),
      );
    });

    it('rechaza generación/expiración inválidas y doble estado terminal', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          await tx.accountToken.create({
            data: {
              purpose: 'PASSWORD_RESET',
              generation: 0,
              keyVersion: 1,
              userId: user.id,
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
        },
        checkViolation('account_token_generation_chk', 'account_token'),
      );

      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const now = new Date();
          await tx.accountToken.create({
            data: {
              purpose: 'PASSWORD_RESET',
              generation: 1,
              keyVersion: 1,
              userId: user.id,
              createdAt: now,
              expiresAt: new Date(now.getTime() - 1),
            },
          });
        },
        checkViolation('account_token_expiry_chk', 'account_token'),
      );

      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const now = new Date();
          await tx.accountToken.create({
            data: {
              purpose: 'PASSWORD_RESET',
              generation: 1,
              keyVersion: 1,
              userId: user.id,
              expiresAt: new Date(now.getTime() + 60_000),
              consumedAt: now,
              revokedAt: now,
              revocationReasonCode: 'REPLACED',
            },
          });
        },
        checkViolation('account_token_terminal_state_chk', 'account_token'),
      );
    });

    it.each([
      ['consumedAt anterior a createdAt', 'consumedAt', true, 'account_token_terminal_state_chk'],
      ['revokedAt anterior a createdAt', 'revokedAt', true, 'account_token_terminal_state_chk'],
      ['revokedAt sin razón', 'revokedAt', false, 'account_token_revocation_reason_chk'],
      ['razón sin revokedAt', 'reasonOnly', false, 'account_token_revocation_reason_chk'],
    ] as const)(
      'atribuye terminalidad completa: %s',
      async (_case, variant, beforeCreation, constraint) => {
        await expectConstraintViolation(
          checkViolation(constraint, 'account_token'),
          createUser,
          (tx, user) => {
            const createdAt = new Date();
            const terminalAt = new Date(createdAt.getTime() + (beforeCreation ? -1 : 1));
            return tx.accountToken.create({
              data: {
                purpose: 'PASSWORD_RESET',
                generation: 1,
                keyVersion: 1,
                userId: user.id,
                createdAt,
                expiresAt: new Date(createdAt.getTime() + 60_000),
                consumedAt: variant === 'consumedAt' ? terminalAt : undefined,
                revokedAt: variant === 'revokedAt' ? terminalAt : undefined,
                revocationReasonCode:
                  variant === 'revokedAt' && beforeCreation
                    ? 'REPLACED'
                    : variant === 'reasonOnly'
                      ? 'REPLACED'
                      : undefined,
              },
            });
          },
        );
      },
    );

    it('impone generación única por propósito y sujeto', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const data = {
            purpose: 'EMAIL_VERIFICATION' as const,
            generation: 1,
            keyVersion: 1,
            userId: user.id,
            expiresAt: new Date(Date.now() + 60_000),
          };
          const token = await tx.accountToken.create({ data });
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "account_token" SELECT gen_random_uuid(), "purpose", "generation", "key_version", "user_id", "organization_invitation_id", "created_at", "expires_at", "consumed_at", "revoked_at", "revocation_reason_code" FROM "account_token" WHERE "id" = '${token.id}'::uuid`,
          );
        },
        uniqueViolation('account_token_user_generation_uq', 'account_token'),
      );
    });
  });

  describe('Organization, membership e invitation', () => {
    it('permite historial pero solo una membership activa', async () => {
      await rollbackAfter(async (tx) => {
        const user = await createUser(tx);
        const organization = await createOrganization(tx, user.id);
        const joinedAt = new Date();
        const endedAt = new Date(joinedAt.getTime() + 1);
        await tx.organizationMember.create({
          data: {
            organizationId: organization.id,
            userId: user.id,
            role: 'ADMIN',
            status: 'LEFT',
            joinedAt,
            endedAt,
            endedReasonCode: 'VOLUNTARY',
          },
        });
        await tx.organizationMember.create({
          data: {
            organizationId: organization.id,
            userId: user.id,
            role: 'ADMIN',
          },
        });
        expect(await tx.organizationMember.count()).toBe(2);
      });

      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const organization = await createOrganization(tx, user.id);
          const data = { organizationId: organization.id, userId: user.id, role: 'ADMIN' as const };
          const member = await tx.organizationMember.create({ data });
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "organization_member" SELECT gen_random_uuid(), "organization_id", "user_id", "role", "status", "invitation_id", "joined_at", "ended_at", "ended_reason_code", "created_at", now() FROM "organization_member" WHERE "id" = '${member.id}'::uuid`,
          );
        },
        uniqueViolation('organization_member_active_uq', 'organization_member'),
      );
    });

    it('impide que una invitación cree dos memberships', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const creator = await createUser(tx);
          const first = await createUser(tx);
          const second = await createUser(tx);
          const organization = await createOrganization(tx, creator.id);
          const invitation = await createInvitation(tx, organization.id, creator.id);
          const member = await tx.organizationMember.create({
            data: {
              organizationId: organization.id,
              userId: first.id,
              invitationId: invitation.id,
              role: 'PROFESSIONAL_MEMBER',
            },
          });
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "organization_member" SELECT gen_random_uuid(), "organization_id", '${second.id}'::uuid, "role", "status", "invitation_id", "joined_at", "ended_at", "ended_reason_code", "created_at", now() FROM "organization_member" WHERE "id" = '${member.id}'::uuid`,
          );
        },
        uniqueViolation('organization_member_invitation_uq', 'organization_member'),
      );
    });

    it('rechaza estados de membership incoherentes', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const organization = await createOrganization(tx, user.id);
          await tx.organizationMember.create({
            data: {
              organizationId: organization.id,
              userId: user.id,
              role: 'ADMIN',
              status: 'REVOKED',
            },
          });
        },
        checkViolation('organization_member_state_chk', 'organization_member'),
      );
    });

    it('permite una nueva invitación tras finalizar la anterior', async () => {
      await rollbackAfter(async (tx) => {
        const creator = await createUser(tx);
        const organization = await createOrganization(tx, creator.id);
        const email = 'invited@example.test';
        const first = await createInvitation(tx, organization.id, creator.id, email);
        await tx.organizationInvitation.update({
          where: { id: first.id },
          data: { status: 'REJECTED', respondedAt: new Date(first.createdAt.getTime() + 1) },
        });
        await createInvitation(tx, organization.id, creator.id, email);
        expect(await tx.organizationInvitation.count()).toBe(2);
      });

      await expectDatabaseRejection(
        async (tx) => {
          const creator = await createUser(tx);
          const organization = await createOrganization(tx, creator.id);
          const invitation = await createInvitation(
            tx,
            organization.id,
            creator.id,
            'pending@example.test',
          );
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "organization_invitation" SELECT gen_random_uuid(), "organization_id", "email", "role", "status", "invited_by_user_id", "accepted_by_user_id", "created_at", "expires_at", "responded_at", "revoked_at", now() FROM "organization_invitation" WHERE "id" = '${invitation.id}'::uuid`,
          );
        },
        uniqueViolation('organization_invitation_pending_uq', 'organization_invitation'),
      );
    });

    it('rechaza invitación expirada al crearla y estados incoherentes', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const creator = await createUser(tx);
          const organization = await createOrganization(tx, creator.id);
          await tx.organizationInvitation.create({
            data: {
              organizationId: organization.id,
              email: 'expired@example.test',
              role: 'PROFESSIONAL_MEMBER',
              invitedByUserId: creator.id,
              expiresAt: new Date(0),
            },
          });
        },
        checkViolation('organization_invitation_expiry_chk', 'organization_invitation'),
      );

      await expectDatabaseRejection(
        async (tx) => {
          const creator = await createUser(tx);
          const organization = await createOrganization(tx, creator.id);
          await tx.organizationInvitation.create({
            data: {
              organizationId: organization.id,
              email: 'accepted@example.test',
              role: 'PROFESSIONAL_MEMBER',
              status: 'ACCEPTED',
              invitedByUserId: creator.id,
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
        },
        checkViolation('organization_invitation_state_chk', 'organization_invitation'),
      );
    });
  });

  describe('AuthRateLimit', () => {
    it('mantiene una fila estable sin windowStartedAt en el unique', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const digest = randomBytes(32);
          const now = new Date();
          const base = {
            action: 'LOGIN' as const,
            dimension: 'EMAIL' as const,
            subjectDigest: digest,
            pepperVersion: 1,
            windowEndsAt: new Date(now.getTime() + 60_000),
            expiresAt: new Date(now.getTime() + 120_000),
          };
          const rateLimit = await tx.authRateLimit.create({
            data: { ...base, windowStartedAt: now },
          });
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "auth_rate_limit" SELECT gen_random_uuid(), "action", "dimension", "subject_digest", "pepper_version", "window_started_at" + interval '1 second', "window_ends_at", "attempt_count", "blocked_until", "expires_at", now() FROM "auth_rate_limit" WHERE "id" = '${rateLimit.id}'::uuid`,
          );
        },
        uniqueViolation('auth_rate_limit_subject_uq', 'auth_rate_limit'),
      );
    });

    it.each([
      ['digest corto', randomBytes(31), 1, 0, 'auth_rate_limit_digest_length_chk'],
      ['pepper cero', randomBytes(32), 0, 0, 'auth_rate_limit_pepper_version_chk'],
      ['contador negativo', randomBytes(32), 1, -1, 'auth_rate_limit_attempt_count_chk'],
    ])('rechaza %s', async (_case, subjectDigest, pepperVersion, attemptCount, constraint) => {
      await expectDatabaseRejection(
        (tx) => {
          const now = new Date();
          return tx.authRateLimit.create({
            data: {
              action: 'LOGIN',
              dimension: 'IP',
              subjectDigest,
              pepperVersion,
              windowStartedAt: now,
              windowEndsAt: new Date(now.getTime() + 60_000),
              attemptCount,
              expiresAt: new Date(now.getTime() + 120_000),
            },
          });
        },
        checkViolation(constraint, 'auth_rate_limit'),
      );
    });

    it('rechaza ventana y expiración incoherentes', async () => {
      await expectDatabaseRejection(
        (tx) => {
          const now = new Date();
          return tx.authRateLimit.create({
            data: {
              action: 'SESSION_READ',
              dimension: 'IP',
              subjectDigest: randomBytes(32),
              pepperVersion: 1,
              windowStartedAt: now,
              windowEndsAt: new Date(now.getTime() - 1),
              expiresAt: now,
            },
          });
        },
        checkViolation('auth_rate_limit_window_chk', 'auth_rate_limit'),
      );

      await expectDatabaseRejection(
        (tx) => {
          const now = new Date();
          return tx.authRateLimit.create({
            data: {
              action: 'LOGIN',
              dimension: 'IP',
              subjectDigest: randomBytes(32),
              pepperVersion: 1,
              windowStartedAt: now,
              windowEndsAt: new Date(now.getTime() + 60_000),
              blockedUntil: new Date(now.getTime() + 180_000),
              expiresAt: new Date(now.getTime() + 120_000),
            },
          });
        },
        checkViolation('auth_rate_limit_expiry_chk', 'auth_rate_limit'),
      );
    });

    it('atribuye expiración anterior al final de ventana', async () => {
      await expectConstraintViolation(
        checkViolation('auth_rate_limit_expiry_chk', 'auth_rate_limit'),
        async () => undefined,
        (tx) => {
          const now = new Date();
          return tx.authRateLimit.create({
            data: {
              action: 'LOGIN',
              dimension: 'IP',
              subjectDigest: randomBytes(32),
              pepperVersion: 1,
              windowStartedAt: now,
              windowEndsAt: new Date(now.getTime() + 60_000),
              expiresAt: new Date(now.getTime() + 30_000),
            },
          });
        },
      );
    });
  });

  describe('AuditEvent', () => {
    it('permite insertar con metadata objeto por defecto', async () => {
      await rollbackAfter(async (tx) => {
        const event = await tx.auditEvent.create({
          data: { actorType: 'SYSTEM', action: 'TEST_CREATED', resourceType: 'TEST' },
        });
        expect(event.metadata).toEqual({});
      });
    });

    it('rechaza UPDATE y DELETE directos', async () => {
      await expectDatabaseRejection(async (tx) => {
        const event = await tx.auditEvent.create({
          data: { actorType: 'SYSTEM', action: 'TEST_UPDATE', resourceType: 'TEST' },
        });
        await tx.auditEvent.update({ where: { id: event.id }, data: { action: 'MUTATED' } });
      }, appendOnlyViolation());

      await expectDatabaseRejection(async (tx) => {
        const event = await tx.auditEvent.create({
          data: { actorType: 'SYSTEM', action: 'TEST_DELETE', resourceType: 'TEST' },
        });
        await tx.auditEvent.delete({ where: { id: event.id } });
      }, appendOnlyViolation());
    });

    it('permite exclusivamente el ON DELETE SET NULL aprobado para el actor', async () => {
      await rollbackAfter(async (tx) => {
        const user = await createUser(tx);
        const event = await tx.auditEvent.create({
          data: {
            actorType: 'USER',
            actorUserId: user.id,
            action: 'TEST_ACTOR_DELETE',
            resourceType: 'USER',
            resourceId: user.id,
          },
        });
        await tx.user.delete({ where: { id: user.id } });
        expect(
          (await tx.auditEvent.findUniqueOrThrow({ where: { id: event.id } })).actorUserId,
        ).toBeNull();
      });
    });
  });

  describe('OutboxEvent', () => {
    const baseOutbox = () => ({
      eventType: 'TEST_EVENT',
      aggregateType: 'TEST',
      aggregateId: randomUUID(),
    });

    it.each(['PENDING', 'PROCESSING', 'PROCESSED', 'OBSOLETE', 'DEAD_LETTER'] as const)(
      'acepta el estado coherente %s',
      async (status) => {
        await rollbackAfter(async (tx) => {
          const now = new Date();
          await tx.outboxEvent.create({
            data: {
              ...baseOutbox(),
              status,
              ...(status === 'PROCESSING'
                ? {
                    lockedAt: now,
                    lockedUntil: new Date(now.getTime() + 30_000),
                    lockedBy: 'worker-test',
                    lockToken: randomUUID(),
                  }
                : {}),
              ...(status === 'PROCESSED' || status === 'OBSOLETE' ? { processedAt: now } : {}),
              ...(status === 'DEAD_LETTER' ? { lastErrorCode: 'PERMANENT_FAILURE' } : {}),
            },
          });
        });
      },
    );

    it('rechaza ownership parcial y lease desordenado', async () => {
      await expectDatabaseRejection(
        (tx) =>
          tx.outboxEvent.create({
            data: { ...baseOutbox(), status: 'PROCESSING', lockedBy: 'worker-only' },
          }),
        checkViolation('outbox_event_lock_group_chk', 'outbox_event'),
      );

      await expectDatabaseRejection(
        (tx) => {
          const now = new Date();
          return tx.outboxEvent.create({
            data: {
              ...baseOutbox(),
              status: 'PROCESSING',
              lockedAt: now,
              lockedUntil: new Date(now.getTime() - 1),
              lockedBy: 'worker-test',
              lockToken: randomUUID(),
            },
          });
        },
        checkViolation('outbox_event_lease_order_chk', 'outbox_event'),
      );
    });

    it('rechaza estados terminales incoherentes', async () => {
      await expectDatabaseRejection(
        (tx) => tx.outboxEvent.create({ data: { ...baseOutbox(), status: 'PROCESSED' } }),
        checkViolation('outbox_event_state_chk', 'outbox_event'),
      );
      await expectDatabaseRejection(
        (tx) =>
          tx.outboxEvent.create({
            data: {
              ...baseOutbox(),
              status: 'OBSOLETE',
              processedAt: new Date(),
              lastErrorCode: 'NOT_AN_ERROR',
            },
          }),
        checkViolation('outbox_event_state_chk', 'outbox_event'),
      );
      await expectDatabaseRejection(
        (tx) => tx.outboxEvent.create({ data: { ...baseOutbox(), status: 'DEAD_LETTER' } }),
        checkViolation('outbox_event_state_chk', 'outbox_event'),
      );
    });

    it('impone lockToken y accountTokenId únicos', async () => {
      await expectDatabaseRejection(
        async (tx) => {
          const lockToken = randomUUID();
          const now = new Date();
          const lock = {
            status: 'PROCESSING' as const,
            lockedAt: now,
            lockedUntil: new Date(now.getTime() + 30_000),
            lockedBy: 'worker-test',
            lockToken,
          };
          const event = await tx.outboxEvent.create({ data: { ...baseOutbox(), ...lock } });
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "outbox_event" SELECT gen_random_uuid(), "event_type", "event_version", "aggregate_type", gen_random_uuid(), "account_token_id", "payload", "status", "occurred_at", "available_at", "attempt_count", "locked_at", "locked_until", "locked_by", "lock_token", "processed_at", "last_error_code", "correlation_id", "causation_id", "created_at" FROM "outbox_event" WHERE "id" = '${event.id}'::uuid`,
          );
        },
        uniqueViolation('outbox_event_lock_token_uq', 'outbox_event'),
      );

      await expectDatabaseRejection(
        async (tx) => {
          const user = await createUser(tx);
          const token = await tx.accountToken.create({
            data: {
              purpose: 'PASSWORD_RESET',
              generation: 1,
              keyVersion: 1,
              userId: user.id,
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
          const event = await tx.outboxEvent.create({
            data: { ...baseOutbox(), accountTokenId: token.id },
          });
          return executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "outbox_event" SELECT gen_random_uuid(), "event_type", "event_version", "aggregate_type", gen_random_uuid(), "account_token_id", "payload", "status", "occurred_at", "available_at", "attempt_count", "locked_at", "locked_until", "locked_by", "lock_token", "processed_at", "last_error_code", "correlation_id", "causation_id", "created_at" FROM "outbox_event" WHERE "id" = '${event.id}'::uuid`,
          );
        },
        uniqueViolation('outbox_event_account_token_uq', 'outbox_event'),
      );
    });
  });

  describe('cobertura física precisa de checks', () => {
    it.each([
      ['hash vacío', '', 'password_credential_hash_chk'],
      ['hash por encima de 512 bytes', 'á'.repeat(257), 'password_credential_hash_chk'],
    ])('atribuye PasswordCredential: %s', async (_case, passwordHash, constraint) => {
      await expectConstraintViolation(
        checkViolation(constraint, 'password_credential'),
        createUser,
        (tx, user) => {
          const now = new Date();
          return tx.passwordCredential.create({
            data: {
              userId: user.id,
              passwordHash,
              createdAt: now,
              passwordChangedAt: now,
            },
          });
        },
      );
    });

    it('atribuye passwordChangedAt anterior a createdAt', async () => {
      await expectConstraintViolation(
        checkViolation('password_credential_changed_at_chk', 'password_credential'),
        createUser,
        (tx, user) => {
          const createdAt = new Date();
          return tx.passwordCredential.create({
            data: {
              userId: user.id,
              passwordHash: '$argon2id$valid',
              createdAt,
              passwordChangedAt: new Date(createdAt.getTime() - 1),
            },
          });
        },
      );
    });

    it('separa XOR y compatibilidad de propósito de AccountToken', async () => {
      await expectConstraintViolation(
        checkViolation('account_token_subject_xor_chk', 'account_token'),
        async () => undefined,
        (tx) =>
          tx.accountToken.create({
            data: {
              purpose: 'EMAIL_VERIFICATION',
              generation: 1,
              keyVersion: 1,
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
      );

      await expectConstraintViolation(
        checkViolation('account_token_purpose_subject_chk', 'account_token'),
        async (tx) => {
          const creator = await createUser(tx);
          const organization = await createOrganization(tx, creator.id);
          return createInvitation(tx, organization.id, creator.id);
        },
        (tx, invitation) =>
          tx.accountToken.create({
            data: {
              purpose: 'EMAIL_VERIFICATION',
              generation: 1,
              keyVersion: 1,
              organizationInvitationId: invitation.id,
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
      );
    });

    it('atribuye keyVersion cero y unique de generación por invitación', async () => {
      await expectConstraintViolation(
        checkViolation('account_token_key_version_chk', 'account_token'),
        createUser,
        (tx, user) =>
          tx.accountToken.create({
            data: {
              purpose: 'PASSWORD_RESET',
              generation: 1,
              keyVersion: 0,
              userId: user.id,
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
      );

      await expectConstraintViolation(
        {
          sqlState: '23505',
          constraint: 'account_token_invitation_generation_uq',
          table: 'account_token',
        },
        async (tx) => {
          const creator = await createUser(tx);
          const organization = await createOrganization(tx, creator.id);
          const invitation = await createInvitation(tx, organization.id, creator.id);
          const data = {
            purpose: 'ORGANIZATION_INVITATION' as const,
            generation: 1,
            keyVersion: 1,
            organizationInvitationId: invitation.id,
            expiresAt: new Date(Date.now() + 60_000),
          };
          return tx.accountToken.create({ data });
        },
        (tx, token) =>
          tx.$executeRawUnsafe(`
            DO $capture_unique$
            DECLARE
              captured_state text;
              captured_constraint text;
              captured_table text;
            BEGIN
              INSERT INTO "account_token"
                ("id", "purpose", "generation", "key_version", "organization_invitation_id", "expires_at")
              SELECT
                gen_random_uuid(), "purpose", "generation", "key_version",
                "organization_invitation_id", "expires_at"
              FROM "account_token"
              WHERE "id" = '${token.id}'::uuid;
            EXCEPTION WHEN unique_violation THEN
              GET STACKED DIAGNOSTICS
                captured_state = RETURNED_SQLSTATE,
                captured_constraint = CONSTRAINT_NAME,
                captured_table = TABLE_NAME;
              RAISE EXCEPTION 'sqlstate=%, constraint=%, table=%',
                captured_state, captured_constraint, captured_table
                USING ERRCODE = 'P0001';
            END
            $capture_unique$;
          `),
      );
    });

    it.each(['PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED'] as const)(
      'acepta explícitamente OrganizationInvitation %s coherente',
      async (status) => {
        await rollbackAfter(async (tx) => {
          const creator = await createUser(tx);
          const organization = await createOrganization(tx, creator.id);
          const createdAt = new Date();
          const terminalAt = new Date(createdAt.getTime() + 1);
          await tx.organizationInvitation.create({
            data: {
              organizationId: organization.id,
              email: `${status.toLowerCase()}-${randomUUID()}@example.test`,
              role: 'PROFESSIONAL_MEMBER',
              status,
              invitedByUserId: creator.id,
              acceptedByUserId: status === 'ACCEPTED' ? creator.id : undefined,
              createdAt,
              expiresAt: new Date(createdAt.getTime() + 60_000),
              respondedAt: status === 'ACCEPTED' || status === 'REJECTED' ? terminalAt : undefined,
              revokedAt: status === 'REVOKED' ? terminalAt : undefined,
            },
          });
        });
      },
    );

    it.each([
      ['PENDING con respuesta', 'PENDING', 'respondedAt'],
      ['ACCEPTED sin aceptante', 'ACCEPTED', 'respondedAt'],
      ['REJECTED con aceptante', 'REJECTED', 'acceptedByUserId'],
      ['REVOKED con respuesta', 'REVOKED', 'respondedAt'],
      ['EXPIRED con revocación', 'EXPIRED', 'revokedAt'],
    ] as const)('atribuye OrganizationInvitation: %s', async (_case, status, invalidField) => {
      await expectConstraintViolation(
        checkViolation('organization_invitation_state_chk', 'organization_invitation'),
        async (tx) => {
          const creator = await createUser(tx);
          const organization = await createOrganization(tx, creator.id);
          return { creator, organization, now: new Date() };
        },
        (tx, { creator, organization, now }) =>
          tx.organizationInvitation.create({
            data: {
              organizationId: organization.id,
              email: `${randomUUID()}@example.test`,
              role: 'PROFESSIONAL_MEMBER',
              status,
              invitedByUserId: creator.id,
              expiresAt: new Date(now.getTime() + 60_000),
              respondedAt:
                invalidField === 'respondedAt' || status === 'REJECTED'
                  ? new Date(now.getTime() + 1)
                  : undefined,
              acceptedByUserId: invalidField === 'acceptedByUserId' ? creator.id : undefined,
              revokedAt:
                invalidField === 'revokedAt' || status === 'REVOKED'
                  ? new Date(now.getTime() + 1)
                  : undefined,
            },
          }),
      );
    });

    const baseOutbox = () => ({
      eventType: 'PHYSICAL_CHECK_TEST',
      aggregateType: 'TEST',
      aggregateId: randomUUID(),
    });

    it.each([
      ['eventVersion cero', { eventVersion: 0 }, 'outbox_event_version_chk'],
      ['attemptCount negativo', { attemptCount: -1 }, 'outbox_event_attempt_count_chk'],
    ])('atribuye OutboxEvent: %s', async (_case, data, constraint) => {
      await expectConstraintViolation(
        checkViolation(constraint, 'outbox_event'),
        async () => undefined,
        (tx) => tx.outboxEvent.create({ data: { ...baseOutbox(), ...data } }),
      );
    });

    it.each([
      ['lockedUntil sobrante', { lockedUntil: new Date(Date.now() + 30_000) }],
      ['lockedBy sobrante', { lockedBy: 'worker-extra' }],
      ['lockToken sobrante', { lockToken: randomUUID() }],
    ])('atribuye lock-group con PENDING compatible: %s', async (_case, lock) => {
      await expectConstraintViolation(
        checkViolation('outbox_event_lock_group_chk', 'outbox_event'),
        async () => undefined,
        (tx) => tx.outboxEvent.create({ data: { ...baseOutbox(), ...lock } }),
      );
    });

    it.each(['lockedUntil', 'lockedBy', 'lockToken'] as const)(
      'atribuye lock-group con PROCESSING y %s ausente',
      async (missing) => {
        const now = new Date();
        const lock: {
          lockedAt: Date;
          lockedUntil?: Date;
          lockedBy?: string;
          lockToken?: string;
        } = {
          lockedAt: now,
          lockedUntil: new Date(now.getTime() + 30_000),
          lockedBy: 'worker-missing',
          lockToken: randomUUID(),
        };
        delete lock[missing];
        await expectConstraintViolation(
          checkViolation('outbox_event_lock_group_chk', 'outbox_event'),
          async () => undefined,
          (tx) =>
            tx.outboxEvent.create({
              data: { ...baseOutbox(), status: 'PROCESSING', ...lock },
            }),
        );
      },
    );

    it.each([
      ['PENDING con grupo completo', 'PENDING', true, false, undefined],
      ['PROCESSING sin grupo', 'PROCESSING', false, false, undefined],
      ['PROCESSED sin processedAt', 'PROCESSED', false, false, undefined],
      ['OBSOLETE con error', 'OBSOLETE', false, true, new Date()],
      ['DEAD_LETTER sin error', 'DEAD_LETTER', false, false, undefined],
    ] as const)(
      'atribuye state-check: %s',
      async (_case, status, withLock, withError, processedAt) => {
        await expectConstraintViolation(
          checkViolation('outbox_event_state_chk', 'outbox_event'),
          async () => undefined,
          (tx) => {
            const now = new Date();
            return tx.outboxEvent.create({
              data: {
                ...baseOutbox(),
                status,
                processedAt,
                lastErrorCode: withError ? 'INVALID_TERMINAL_ERROR' : undefined,
                ...(withLock
                  ? {
                      lockedAt: now,
                      lockedUntil: new Date(now.getTime() + 30_000),
                      lockedBy: 'worker-state',
                      lockToken: randomUUID(),
                    }
                  : {}),
              },
            });
          },
        );
      },
    );

    it.each([
      ['array', []],
      ['string', 'texto'],
      ['número', 42],
      ['booleano', true],
      ['JSON null', Prisma.JsonNull],
    ])('atribuye metadata JSON no objeto: %s', async (_case, metadata) => {
      await expectConstraintViolation(
        checkViolation('audit_event_metadata_object_chk', 'audit_event'),
        async () => undefined,
        (tx) =>
          tx.auditEvent.create({
            data: {
              actorType: 'SYSTEM',
              action: 'INVALID_METADATA',
              resourceType: 'TEST',
              metadata,
            },
          }),
      );
    });

    it('distingue JSON null de SQL NULL en AuditEvent.metadata', async () => {
      await expectDatabaseRejection(
        (tx) =>
          executeWithCapturedDiagnostic(
            tx,
            `INSERT INTO "audit_event" ("id", "actor_type", "action", "resource_type", "metadata") VALUES ('${randomUUID()}'::uuid, 'SYSTEM', 'SQL_NULL', 'TEST', NULL)`,
          ),
        notNullViolation('audit_event', 'metadata'),
      );

      const metadataColumn = await client.$queryRaw<Array<{ notNull: boolean }>>`
        SELECT attnotnull AS "notNull"
        FROM pg_attribute
        WHERE attrelid = 'audit_event'::regclass
          AND attname = 'metadata'
      `;
      expect(metadataColumn).toEqual([{ notNull: true }]);
    });

    it.each([
      ['revokedAt sin razón', true, false, false],
      ['razón sin revokedAt', false, true, false],
      ['revokedAt anterior a createdAt', true, true, true],
    ])('atribuye terminalidad de Session: %s', async (_case, withDate, withReason, before) => {
      await expectConstraintViolation(
        checkViolation('session_revocation_chk', 'session'),
        createUser,
        (tx, user) => {
          const createdAt = new Date();
          const baseTime = new Date(createdAt.getTime() + 1);
          return tx.session.create({
            data: {
              secretDigest: randomBytes(32),
              secretKeyVersion: 1,
              userId: user.id,
              issuedSessionVersion: 1,
              createdAt,
              lastActivityAt: baseTime,
              idleExpiresAt: new Date(baseTime.getTime() + 30_000),
              absoluteExpiresAt: new Date(baseTime.getTime() + 60_000),
              revokedAt: withDate ? new Date(createdAt.getTime() + (before ? -1 : 1)) : undefined,
              revocationReason: withReason ? 'LOGOUT' : undefined,
            },
          });
        },
      );
    });
  });

  it('expone las acciones ON DELETE y los índices parciales aprobados', async () => {
    const foreignKeys = await client.$queryRaw<Array<{ name: string; action: string }>>`
      SELECT conname AS name, confdeltype::text AS action
      FROM pg_constraint
      WHERE conname IN (
        'password_credential_user_id_fkey',
        'session_user_id_fkey',
        'account_token_user_id_fkey',
        'account_token_organization_invitation_id_fkey',
        'organization_created_by_user_id_fkey',
        'organization_member_organization_id_fkey',
        'organization_member_user_id_fkey',
        'organization_member_invitation_id_fkey',
        'organization_invitation_organization_id_fkey',
        'organization_invitation_invited_by_user_id_fkey',
        'organization_invitation_accepted_by_user_id_fkey',
        'audit_event_actor_user_id_fkey',
        'outbox_event_account_token_id_fkey'
      )
      ORDER BY conname
    `;
    expect(foreignKeys).toHaveLength(13);
    expect(foreignKeys.filter(({ action }) => action === 'r')).toHaveLength(12);
    expect(foreignKeys.find(({ name }) => name === 'audit_event_actor_user_id_fkey')?.action).toBe(
      'n',
    );

    await assertExactPartialIndexes(client);
  });

  describe('controles anti-falso-positivo con rollback', () => {
    it('demuestra que retirar XOR admite exactamente su fixture inválido', async () => {
      await rollbackAfter(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "account_token" DROP CONSTRAINT "account_token_subject_xor_chk"',
        );
        const token = await tx.accountToken.create({
          data: {
            purpose: 'EMAIL_VERIFICATION',
            generation: 1,
            keyVersion: 1,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        expect(token.userId).toBeNull();
        expect(token.organizationInvitationId).toBeNull();
      });
    });

    it('demuestra que retirar lock-group admite exactamente su fixture inválido', async () => {
      await rollbackAfter(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "outbox_event" DROP CONSTRAINT "outbox_event_lock_group_chk"',
        );
        const event = await tx.outboxEvent.create({
          data: {
            eventType: 'ANTI_FALSE_POSITIVE',
            aggregateType: 'TEST',
            aggregateId: randomUUID(),
            lockedBy: 'worker-without-lock',
          },
        });
        expect(event.lockedBy).toBe('worker-without-lock');
        expect(event.lockedAt).toBeNull();
      });
    });

    it('demuestra que alterar columnas y predicado rompe el contrato exacto del índice', async () => {
      await rollbackAfter(async (tx) => {
        await tx.$executeRawUnsafe('DROP INDEX "outbox_event_expired_lease_idx"');
        await tx.$executeRawUnsafe(
          'CREATE INDEX "outbox_event_expired_lease_idx" ON "outbox_event" ("locked_at") WHERE "status" = \'PENDING\'',
        );

        await expect(assertExactPartialIndexes(tx)).rejects.toMatchObject({
          name: 'PartialIndexMismatchError',
          indexName: 'outbox_event_expired_lease_idx',
          field: 'columns',
          expected: ['locked_until'],
          actual: ['locked_at'],
        });
      });

      await assertExactPartialIndexes(client);
    });

    it('confirma que las tres definiciones originales quedaron restauradas', async () => {
      const constraints = await client.$queryRaw<Array<{ name: string; definition: string }>>`
        SELECT conname AS name, pg_get_constraintdef(oid, false) AS definition
        FROM pg_constraint
        WHERE conname IN (
          'account_token_subject_xor_chk',
          'outbox_event_lock_group_chk'
        )
        ORDER BY conname
      `;

      expect(constraints).toEqual([
        {
          name: 'account_token_subject_xor_chk',
          definition: 'CHECK (((user_id IS NOT NULL) <> (organization_invitation_id IS NOT NULL)))',
        },
        {
          name: 'outbox_event_lock_group_chk',
          definition:
            'CHECK ((((locked_at IS NULL) AND (locked_until IS NULL) AND (locked_by IS NULL) AND (lock_token IS NULL)) OR ((locked_at IS NOT NULL) AND (locked_until IS NOT NULL) AND (locked_by IS NOT NULL) AND (lock_token IS NOT NULL))))',
        },
      ]);
      await assertExactPartialIndexes(client);
    });
  });
});
