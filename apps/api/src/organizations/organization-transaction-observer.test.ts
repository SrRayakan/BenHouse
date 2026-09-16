import { describe, expect, it, vi } from 'vitest';
import {
  DisabledOrganizationTransactionObserver,
  OrganizationTransactionObserverError,
  observeOrganizationTransactionStart,
  type OrganizationTransactionObserver,
} from './organization-transaction-observer';

describe('OrganizationTransactionObserver', () => {
  it('no consulta identidad transaccional cuando el observer normal está deshabilitado', async () => {
    const query = vi.fn();
    await observeOrganizationTransactionStart(
      { $queryRaw: query } as never,
      new DisabledOrganizationTransactionObserver(),
      { requestId: 'request-1', operation: 'ORGANIZATION_UPDATE', attempt: 1 },
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('comunica PID y virtual transaction ID de la misma transacción', async () => {
    const transactionStarted = vi.fn();
    const observer: OrganizationTransactionObserver = { enabled: true, transactionStarted };
    await observeOrganizationTransactionStart(
      {
        $queryRaw: vi.fn().mockResolvedValue([{ backendPid: 321, virtualTransactionId: '3/42' }]),
      } as never,
      observer,
      { requestId: 'request-2', operation: 'ORGANIZATION_CREATE', attempt: 2 },
    );
    expect(transactionStarted).toHaveBeenCalledWith({
      requestId: 'request-2',
      operation: 'ORGANIZATION_CREATE',
      attempt: 2,
      backendPid: 321,
      virtualTransactionId: '3/42',
    });
  });

  it.each([
    { rows: [] },
    {
      rows: [
        { backendPid: 1, virtualTransactionId: '1/1' },
        { backendPid: 2, virtualTransactionId: '2/2' },
      ],
    },
    { rows: [{ backendPid: 0, virtualTransactionId: '1/1' }] },
    { rows: [{ backendPid: 1.5, virtualTransactionId: '1/1' }] },
    { rows: [{ backendPid: 1, virtualTransactionId: '' }] },
    { rows: [{ backendPid: 1, virtualTransactionId: 'invalid' }] },
  ])('rechaza un resultado PostgreSQL inválido %#', async ({ rows }) => {
    await expect(
      observeOrganizationTransactionStart(
        { $queryRaw: vi.fn().mockResolvedValue(rows) } as never,
        { enabled: true, transactionStarted: vi.fn() },
        { requestId: 'request-3', operation: 'ORGANIZATION_UPDATE', attempt: 1 },
      ),
    ).rejects.toThrow('identidad transaccional válida');
  });

  it('propaga explícitamente un fallo inesperado del observer sin crear mutaciones', async () => {
    const failure = new Error('OBSERVER_TEST_FAILURE');
    const query = vi.fn().mockResolvedValue([{ backendPid: 321, virtualTransactionId: '3/42' }]);
    await expect(
      observeOrganizationTransactionStart(
        { $queryRaw: query } as never,
        {
          enabled: true,
          transactionStarted: () => {
            throw failure;
          },
        },
        { requestId: 'observer-failure', operation: 'ORGANIZATION_UPDATE', attempt: 1 },
      ),
    ).rejects.toMatchObject({ name: OrganizationTransactionObserverError.name, cause: failure });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
