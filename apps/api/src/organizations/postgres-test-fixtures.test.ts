import { afterEach, describe, expect, it } from 'vitest';
import {
  BlockedQueryBarrierError,
  CausalWorkScope,
  matchingBlockedQueries,
  TestOrganizationTransactionObserver,
  waitForQueryBlockedBy,
  type BlockedQueryExpectation,
  type BlockedQueryObservation,
  type ObservedOrganizationTransaction,
} from './postgres-test-fixtures';

const valid: BlockedQueryObservation = {
  pid: 202,
  virtualTransactionId: '3/42',
  databaseName: 'benhouse_test',
  applicationName: 'b14-api-suite',
  waitEventType: 'Lock',
  waitEvent: 'transactionid',
  state: 'active',
  query: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
  blockingPids: [101],
};
const receiptOwners: TestOrganizationTransactionObserver[] = [];

describe('propagación de fallos de trabajo causal', () => {
  it('rechaza ready con el error original si el trabajo no llega a empezar', async () => {
    const scope = new CausalWorkScope();
    const error = new Error('Fallo de adquisición sintético');
    scope.observe(Promise.reject(error));
    await expect(scope.wait(new Promise<never>(() => undefined))).rejects.toBe(error);
  });

  it('propaga el fallo del holder después de ready mientras espera otro recibo', async () => {
    const scope = new CausalWorkScope();
    let fail!: (error: Error) => void;
    scope.observe(
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
    );
    await expect(scope.wait(Promise.resolve(123))).resolves.toBe(123);
    const error = new Error('Fallo del holder sintético');
    const waiting = scope.wait(new Promise<never>(() => undefined));
    fail(error);
    await expect(waiting).rejects.toBe(error);
  });

  it('observa también el rechazo de una petición antes de su recibo y conserva el primer error', async () => {
    const scope = new CausalWorkScope();
    const error = new Error('Fallo de petición sintético');
    scope.observe(Promise.reject(error));
    await expect(scope.wait(new Promise<never>(() => undefined))).rejects.toBe(error);
    scope.observe(Promise.reject(new Error('Fallo secundario sintético')));
    await expect(scope.wait(new Promise<never>(() => undefined))).rejects.toBe(error);
  });
});
afterEach(() => {
  for (const owner of receiptOwners.splice(0)) {
    owner.clearRequest('request-a');
    expect([owner.eventCount(), owner.waiterCount(), owner.activeReceiptCount()]).toEqual([
      0, 0, 0,
    ]);
  }
});

describe('observer transaccional B1.4', () => {
  it('entrega únicamente el evento con requestId, operación e intento exactos', async () => {
    const observer = new TestOrganizationTransactionObserver();
    const expected = observer.waitFor({
      requestId: 'request-a',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 2,
    });
    observer.transactionStarted({
      requestId: 'request-a',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 2,
      backendPid: 202,
      virtualTransactionId: '3/42',
    });
    await expect(expected).resolves.toMatchObject({ backendPid: 202, causalReceipt: true });
    observer.clearRequest('request-a');
    expect([observer.eventCount(), observer.waiterCount(), observer.activeReceiptCount()]).toEqual([
      0, 0, 0,
    ]);
  });

  it('rechaza eventos y esperas duplicados', async () => {
    const observer = new TestOrganizationTransactionObserver();
    const wait = observer.waitFor({
      requestId: 'request-b',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 1,
    });
    await expect(
      observer.waitFor({ requestId: 'request-b', operation: 'ORGANIZATION_UPDATE', attempt: 1 }),
    ).rejects.toThrow('Espera transaccional duplicada');
    observer.transactionStarted({
      requestId: 'request-b',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 1,
      backendPid: 202,
      virtualTransactionId: '3/42',
    });
    await wait;
    expect(() =>
      observer.transactionStarted({
        requestId: 'request-b',
        operation: 'ORGANIZATION_UPDATE',
        attempt: 1,
        backendPid: 203,
        virtualTransactionId: '3/43',
      }),
    ).toThrow('Evento transaccional duplicado');
    observer.clearRequest('request-b');
  });

  it('no entrega eventos de otro requestId, operación o intento y limpia el timer', async () => {
    const observer = new TestOrganizationTransactionObserver();
    const wait = observer.waitFor({
      requestId: 'request-c',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 2,
      timeoutMs: 20,
    });
    observer.transactionStarted({
      requestId: 'request-x',
      operation: 'ORGANIZATION_CREATE',
      attempt: 1,
      backendPid: 202,
      virtualTransactionId: '3/42',
    });
    await expect(wait).rejects.toThrow('Timeout esperando evento transaccional');
    observer.clearRequest('request-c');
    observer.clearRequest('request-x');
    expect(observer.eventCount()).toBe(0);
  });
});

describe('barrera PostgreSQL causal de B1.4', () => {
  it('acepta exclusivamente el PID recibido desde la transacción observada', async () => {
    const transaction = await receiptFor();
    expect(matchingBlockedQueries([valid], expectation(transaction))).toEqual([valid]);
  });

  it.each([
    ['advisory lock', { waitEvent: 'advisory' }],
    ['otro blocker', { blockingPids: [303] }],
    ['application_name ajeno', { applicationName: 'otra-suite' }],
    ['otra base', { databaseName: 'benhouse' }],
    ['SQL parecido', { query: 'SELECT 1 /* FROM "organization" FOR UPDATE */' }],
    ['otro PID bloqueado', { pid: 999 }],
  ] as const)('rechaza %s', async (_label, mutation) => {
    const transaction = await receiptFor();
    expect(matchingBlockedQueries([{ ...valid, ...mutation }], expectation(transaction))).toEqual(
      [],
    );
  });

  it('rechaza inmediatamente PID ausente, inválido o sin recibo causal', async () => {
    const transaction = await receiptFor();
    for (const pid of [undefined, 0, -1, 1.5]) {
      await expect(
        waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, {
          ...expectation(transaction),
          expectedBlockedPid: pid as number,
        }),
      ).rejects.toBeInstanceOf(BlockedQueryBarrierError);
    }
    await expect(
      waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, {
        ...expectation(transaction),
        transaction: { ...transaction } as ObservedOrganizationTransaction,
      }),
    ).rejects.toThrow('evento causal esperado');
  });

  it.each([
    ['requestId', { requestId: 'otro-request' }],
    ['operación', { operation: 'ORGANIZATION_CREATE' as const }],
    ['intento anterior', { attempt: 2 }],
    ['PID ajeno', { expectedBlockedPid: 999 }],
  ])('rechaza un recibo que no corresponde por %s', async (_label, mutation) => {
    const transaction = await receiptFor();
    await expect(
      waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, {
        ...expectation(transaction),
        ...mutation,
      }),
    ).rejects.toThrow('evento causal esperado');
  });

  it('falla ante varios candidatos en vez de elegir uno', async () => {
    const transaction = await receiptFor();
    const observer = { $queryRaw: async () => [valid, { ...valid }] };
    await expect(
      waitForQueryBlockedBy(observer as never, expectation(transaction)),
    ).rejects.toMatchObject({
      name: 'BlockedQueryBarrierError',
      diagnostic: { operation: 'ORGANIZATION_UPDATE', diagnosticRoute: '/organizations/:id' },
    });
  });

  it('agota un timeout corto y deja de sondear', async () => {
    const transaction = await receiptFor();
    let polls = 0;
    const observer = {
      $queryRaw: async () => {
        polls += 1;
        return [{ ...valid, waitEventType: null, waitEvent: null, blockingPids: [] }];
      },
    };
    await expect(
      waitForQueryBlockedBy(observer as never, {
        ...expectation(transaction),
        timeoutMs: 20,
        pollIntervalMs: 2,
      }),
    ).rejects.toBeInstanceOf(BlockedQueryBarrierError);
    const pollsAtRejection = polls;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(polls).toBe(pollsAtRejection);
  });

  it('falla inmediatamente si el PID causal desaparece de pg_stat_activity', async () => {
    const transaction = await receiptFor();
    await expect(
      waitForQueryBlockedBy({ $queryRaw: async () => [] } as never, expectation(transaction)),
    ).rejects.toThrow('backend causal ya no existe');
  });

  it('invalida el recibo cuando el backend termina después de iniciar el polling', async () => {
    const receipt = await receiptFor();
    let polls = 0;
    const query = {
      $queryRaw: async () => {
        polls += 1;
        return polls === 1 ? [{ ...valid, waitEventType: null, waitEvent: null }] : [];
      },
    };
    await expect(
      waitForQueryBlockedBy(query as never, { ...expectation(receipt), pollIntervalMs: 1 }),
    ).rejects.toThrow('backend causal ya no existe');
    expect(polls).toBe(2);
    await expect(waitForQueryBlockedBy(query as never, expectation(receipt))).rejects.toThrow(
      'evento causal esperado',
    );
    expect(polls).toBe(2);
  });

  it('consume un recibo válido una vez y rechaza el replay antes de consultar SQL', async () => {
    const receipt = await receiptFor();
    await expect(
      waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, expectation(receipt)),
    ).resolves.toEqual(valid);
    let polls = 0;
    await expect(
      waitForQueryBlockedBy(
        {
          $queryRaw: async () => {
            polls++;
            return [valid];
          },
        } as never,
        expectation(receipt),
      ),
    ).rejects.toThrow('evento causal esperado');
    expect(polls).toBe(0);
  });

  it('invalida tras timeout y error SQL; ninguna ruta permite un segundo claim', async () => {
    for (const failure of ['timeout', 'sql'] as const) {
      const receipt = await receiptFor();
      const query =
        failure === 'sql'
          ? {
              $queryRaw: async () => {
                throw new Error('SQL_OBSERVER_FAILED');
              },
            }
          : { $queryRaw: async () => [{ ...valid, waitEventType: null, waitEvent: null }] };
      await expect(
        waitForQueryBlockedBy(query as never, {
          ...expectation(receipt),
          timeoutMs: 10,
          pollIntervalMs: 1,
        }),
      ).rejects.toThrow(failure === 'sql' ? 'SQL_OBSERVER_FAILED' : 'Timeout');
      await expect(
        waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, expectation(receipt)),
      ).rejects.toThrow('evento causal esperado');
    }
  });

  it('rechaza PID reutilizado en una nueva virtual transaction aunque el recibo todavía esté ISSUED', async () => {
    const receipt = await receiptFor();
    await expect(
      waitForQueryBlockedBy(
        { $queryRaw: async () => [{ ...valid, virtualTransactionId: '3/43' }] } as never,
        expectation(receipt),
      ),
    ).rejects.toThrow('transacción virtual causal ya no está activa');
  });

  it('rechaza identidad de PID y VXID incorrectos de forma independiente', async () => {
    const receipt = await receiptFor();
    await expect(
      waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, {
        ...expectation(receipt),
        expectedBlockedPid: 999,
      }),
    ).rejects.toThrow('evento causal esperado');
    await expect(
      waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, {
        ...expectation(receipt),
        expectedVirtualTransactionId: '3/43',
      }),
    ).rejects.toThrow('evento causal esperado');
  });

  it('dos claims simultáneos permiten un único polling y clearRequest invalida CLAIMED', async () => {
    const receipt = await receiptFor();
    let resume!: (observations: BlockedQueryObservation[]) => void;
    const query = {
      $queryRaw: () =>
        new Promise<BlockedQueryObservation[]>((resolve) => {
          resume = resolve;
        }),
    };
    const first = waitForQueryBlockedBy(query as never, expectation(receipt));
    await expect(waitForQueryBlockedBy(query as never, expectation(receipt))).rejects.toThrow(
      'evento causal esperado',
    );
    receiptOwners.at(-1)!.clearRequest('request-a');
    resume([valid]);
    await expect(first).rejects.toThrow('invalidado durante la espera');
    await expect(waitForQueryBlockedBy(query as never, expectation(receipt))).rejects.toThrow(
      'evento causal esperado',
    );
  });

  it('clearRequest invalida ISSUED e idempotentemente elimina todas las referencias', async () => {
    const receipt = await receiptFor();
    receiptOwners.at(-1)!.clearRequest('request-a');
    receiptOwners.at(-1)!.clearRequest('request-a');
    await expect(
      waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, expectation(receipt)),
    ).rejects.toThrow('evento causal esperado');
  });

  it('dos intentos con el mismo PID usan VXID y recibos distintos; B se acepta una sola vez', async () => {
    const owner = new TestOrganizationTransactionObserver();
    const firstWait = owner.waitFor({
      requestId: 'retry-request',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 1,
    });
    const secondWait = owner.waitFor({
      requestId: 'retry-request',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 2,
    });
    owner.transactionStarted({
      requestId: 'retry-request',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 1,
      backendPid: 202,
      virtualTransactionId: '3/42',
    });
    owner.transactionStarted({
      requestId: 'retry-request',
      operation: 'ORGANIZATION_UPDATE',
      attempt: 2,
      backendPid: 202,
      virtualTransactionId: '3/43',
    });
    const [first, second] = await Promise.all([firstWait, secondWait]);
    const secondExpected = {
      ...expectation(second),
      requestId: 'retry-request',
      attempt: 2,
      expectedVirtualTransactionId: '3/43',
    };
    await expect(
      waitForQueryBlockedBy({ $queryRaw: async () => [valid] } as never, {
        ...secondExpected,
        transaction: first,
      }),
    ).rejects.toThrow('evento causal esperado');
    const secondObservation = { ...valid, virtualTransactionId: '3/43' };
    await expect(
      waitForQueryBlockedBy(
        { $queryRaw: async () => [secondObservation] } as never,
        secondExpected,
      ),
    ).resolves.toEqual(secondObservation);
    await expect(
      waitForQueryBlockedBy(
        { $queryRaw: async () => [secondObservation] } as never,
        secondExpected,
      ),
    ).rejects.toThrow('evento causal esperado');
    owner.clearRequest('retry-request');
    expect([owner.eventCount(), owner.waiterCount(), owner.activeReceiptCount()]).toEqual([
      0, 0, 0,
    ]);
  });
});

async function receiptFor(): Promise<ObservedOrganizationTransaction> {
  const observer = new TestOrganizationTransactionObserver();
  receiptOwners.push(observer);
  const receipt = observer.waitFor({
    requestId: 'request-a',
    operation: 'ORGANIZATION_UPDATE',
    attempt: 1,
  });
  observer.transactionStarted({
    requestId: 'request-a',
    operation: 'ORGANIZATION_UPDATE',
    attempt: 1,
    backendPid: 202,
    virtualTransactionId: '3/42',
  });
  return receipt;
}

function expectation(transaction: ObservedOrganizationTransaction): BlockedQueryExpectation {
  return {
    blockerPid: 101,
    databaseName: 'benhouse_test',
    applicationName: 'b14-api-suite',
    expectedQuery: 'SELECT "id" FROM "organization" WHERE "id" = $1::uuid FOR UPDATE',
    requestId: 'request-a',
    operation: 'ORGANIZATION_UPDATE',
    attempt: 1,
    transaction,
    diagnosticRoute: '/organizations/:id',
    allowedWaitEvents: ['transactionid', 'tuple'],
    expectedBlockedPid: 202,
    expectedVirtualTransactionId: transaction.virtualTransactionId,
  };
}
