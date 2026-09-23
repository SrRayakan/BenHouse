import { Injectable } from '@nestjs/common';
import { Prisma } from '@benhouse/database';
import type { Prisma as PrismaTypes } from '@benhouse/database';

export type OrganizationTransactionOperation =
  | 'ORGANIZATION_CREATE'
  | 'ORGANIZATION_UPDATE'
  | 'ORGANIZATION_INVITE'
  | 'ORGANIZATION_INVITE_RESEND'
  | 'ORGANIZATION_INVITE_REVOKE'
  | 'ORGANIZATION_INVITE_ACCEPT'
  | 'ORGANIZATION_INVITE_REJECT'
  | 'ORGANIZATION_MEMBER_ROLE'
  | 'ORGANIZATION_MEMBER_REVOKE'
  | 'ORGANIZATION_MEMBER_LEAVE'
  | 'ORGANIZATION_ADMIN_TRANSFER';

export type OrganizationTransactionStartedEvent = {
  requestId: string;
  operation: OrganizationTransactionOperation;
  attempt: number;
  backendPid: number;
  virtualTransactionId: string;
};

export abstract class OrganizationTransactionObserver {
  abstract readonly enabled: boolean;
  abstract transactionStarted(event: OrganizationTransactionStartedEvent): void;
}

export class OrganizationTransactionObserverError extends Error {
  constructor(cause: unknown) {
    super('Falló el observer transaccional de pruebas.', { cause });
    this.name = 'OrganizationTransactionObserverError';
  }
}

@Injectable()
export class DisabledOrganizationTransactionObserver implements OrganizationTransactionObserver {
  readonly enabled = false;

  transactionStarted(): void {}
}

export async function observeOrganizationTransactionStart(
  tx: PrismaTypes.TransactionClient,
  observer: OrganizationTransactionObserver,
  event: Omit<OrganizationTransactionStartedEvent, 'backendPid' | 'virtualTransactionId'>,
): Promise<void> {
  if (!observer.enabled) return;
  const rows = await tx.$queryRaw<Array<{ backendPid: number; virtualTransactionId: string }>>(
    Prisma.sql`SELECT pg_backend_pid() AS "backendPid", virtualtransaction::text AS "virtualTransactionId" FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'virtualxid' AND granted = true`,
  );
  const backendPid = rows[0]?.backendPid;
  const virtualTransactionId = rows[0]?.virtualTransactionId;
  if (
    rows.length !== 1 ||
    typeof backendPid !== 'number' ||
    !Number.isInteger(backendPid) ||
    backendPid <= 0 ||
    typeof virtualTransactionId !== 'string' ||
    !/^\d+\/\d+$/.test(virtualTransactionId)
  ) {
    throw new Error('PostgreSQL no devolvió una identidad transaccional válida.');
  }
  try {
    observer.transactionStarted({ ...event, backendPid, virtualTransactionId });
  } catch (error) {
    throw new OrganizationTransactionObserverError(error);
  }
}
