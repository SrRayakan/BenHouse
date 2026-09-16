import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationsService } from './organizations.service';
import { DisabledOrganizationTransactionObserver } from './organization-transaction-observer';

const user = { id: randomUUID(), status: 'ACTIVE' as const, emailVerifiedAt: new Date() };
const candidate = {
  userId: user.id,
  sessionId: randomUUID(),
  issuedSessionVersion: 1,
  parsed: { selector: randomUUID(), secret: Buffer.alloc(32) },
};
const observer = new DisabledOrganizationTransactionObserver();

function transactionClient() {
  const organization = {
    id: randomUUID(),
    name: 'Organización',
    status: 'ACTIVE' as const,
    createdByUserId: user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    organization: {
      create: vi.fn().mockResolvedValue(organization),
    },
    organizationMember: {
      create: vi.fn().mockResolvedValue({
        id: randomUUID(),
        userId: user.id,
        organizationId: organization.id,
        role: 'ADMIN',
        status: 'ACTIVE',
      }),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({ id: randomUUID() }) },
  };
}

describe('OrganizationsService transaccional', () => {
  it('reintenta un conflicto Serializable transitorio y confirma una sola creación', async () => {
    const tx = transactionClient();
    const database = {
      prisma: {
        $transaction: vi
          .fn()
          .mockRejectedValueOnce({ code: 'P2034' })
          .mockImplementation(async (operation: (value: unknown) => Promise<unknown>) =>
            operation(tx),
          ),
      },
    };
    const sessions = {
      authenticate: vi.fn().mockResolvedValue(candidate),
      lockAndRevalidate: vi.fn().mockResolvedValue(user),
    };
    const service = new OrganizationsService(database as never, sessions as never, observer);
    await expect(
      service.create('Organización', 'cookie', 'csrf', 'request-id'),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(database.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.organization.create).toHaveBeenCalledTimes(1);
    expect(tx.organizationMember.create).toHaveBeenCalledTimes(1);
    expect(tx.auditEvent.create).toHaveBeenCalledTimes(1);
  });

  it('agota conflictos Serializable persistentes sin convertirlos en error de dominio', async () => {
    const database = { prisma: { $transaction: vi.fn().mockRejectedValue({ code: '40001' }) } };
    const sessions = { authenticate: vi.fn().mockResolvedValue(candidate) };
    const service = new OrganizationsService(database as never, sessions as never, observer);
    await expect(
      service.create('Organización', 'cookie', 'csrf', 'request-id'),
    ).rejects.toMatchObject({
      status: 503,
      code: 'SECURITY_DEPENDENCY_UNAVAILABLE',
    });
    expect(database.prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('no intenta auditoría si falla la creación del admin inicial', async () => {
    const tx = transactionClient();
    tx.organizationMember.create.mockRejectedValueOnce(new Error('fallo forzado'));
    const database = {
      prisma: {
        $transaction: vi.fn(async (operation: (value: unknown) => Promise<unknown>) =>
          operation(tx),
        ),
      },
    };
    const sessions = {
      authenticate: vi.fn().mockResolvedValue(candidate),
      lockAndRevalidate: vi.fn().mockResolvedValue(user),
    };
    const service = new OrganizationsService(database as never, sessions as never, observer);
    await expect(
      service.create('Organización', 'cookie', 'csrf', 'request-id'),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(tx.organization.create).toHaveBeenCalledTimes(1);
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
});
