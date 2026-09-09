import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '@benhouse/config';
import { AuthRateLimitService } from './rate-limit.service';
import { SystemClock } from './clock';

const config = {
  rateLimitCleanupIntervalSeconds: 300,
  rateLimitCleanupBatchSize: 25,
  rateLimitPepperKeys: { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 7)]]) },
  rateLimits: { SESSION_READ_IP: { limit: 10, windowSeconds: 60, blockSeconds: 60 } },
} as unknown as AuthConfig;

describe('AuthRateLimitService lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('desreferencia y cancela el intervalo durante shutdown', () => {
    const timer = { unref: vi.fn() };
    const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer as never);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const service = new AuthRateLimitService({ prisma: {} } as never, config, new SystemClock());
    service.onModuleInit();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 300_000);
    expect(timer.unref).toHaveBeenCalledOnce();
    service.onModuleDestroy();
    expect(clear).toHaveBeenCalledWith(timer);
  });

  it('aísla el fallo de limpieza y no desactiva el consumo del limitador', async () => {
    const subject = '198.51.100.77';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const transactionQuery = vi.fn().mockResolvedValue([{ blockedUntil: null }]);
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error(`fallo para ${subject}`)),
      $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
        operation({ $queryRaw: transactionQuery }),
      ),
    };
    const service = new AuthRateLimitService({ prisma } as never, config, new SystemClock());
    await (service as unknown as { runScheduledCleanup(): Promise<void> }).runScheduledCleanup();
    await expect(
      service.consume([
        { action: 'SESSION_READ', dimension: 'IP', value: subject, policy: 'SESSION_READ_IP' },
      ]),
    ).resolves.toBeUndefined();
    expect(transactionQuery).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(subject);
  });
});
