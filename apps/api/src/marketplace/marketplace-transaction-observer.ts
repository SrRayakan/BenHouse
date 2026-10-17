import { Injectable } from '@nestjs/common';
import { Prisma } from '@benhouse/database';
import type { Prisma as PrismaTypes } from '@benhouse/database';

export type MarketplaceTransactionOperation =
  | 'MEDIA_ACCESS'
  | 'PROPERTY_CREATE'
  | 'PROPERTY_UPDATE'
  | 'PROPERTY_LOCATION_SET'
  | 'PROPERTY_AUTHORIZATION_GRANT'
  | 'PROPERTY_AUTHORIZATION_REVOKE'
  | 'LISTING_CREATE'
  | 'LISTING_UPDATE';

export type MarketplaceTransactionStartedEvent = {
  requestId: string;
  operation: MarketplaceTransactionOperation;
  attempt: number;
  backendPid: number;
  virtualTransactionId: string;
};

export abstract class MarketplaceTransactionObserver {
  abstract readonly enabled: boolean;
  abstract transactionStarted(event: MarketplaceTransactionStartedEvent): void;
}

@Injectable()
export class DisabledMarketplaceTransactionObserver implements MarketplaceTransactionObserver {
  readonly enabled = false;
  transactionStarted(): void {}
}

export async function observeMarketplaceTransactionStart(
  tx: PrismaTypes.TransactionClient,
  observer: MarketplaceTransactionObserver,
  event: Omit<MarketplaceTransactionStartedEvent, 'backendPid' | 'virtualTransactionId'>,
): Promise<void> {
  if (!observer.enabled) return;
  const rows = await tx.$queryRaw<Array<{ backendPid: number; virtualTransactionId: string }>>(
    Prisma.sql`SELECT pg_backend_pid() AS "backendPid", virtualtransaction::text AS "virtualTransactionId" FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'virtualxid' AND granted = true`,
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !Number.isInteger(row?.backendPid) ||
    typeof row?.virtualTransactionId !== 'string' ||
    !/^\d+\/\d+$/.test(row.virtualTransactionId)
  )
    throw new Error('PostgreSQL no devolvió una identidad transaccional válida.');
  observer.transactionStarted({ ...event, ...row });
}
