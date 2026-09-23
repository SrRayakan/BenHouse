import { describe, expect, it, vi } from 'vitest';
import { createWorkerLoop, getWorkerStartupMessage } from './index';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('worker', () => {
  it('declara su arranque sin crear procesamiento ficticio', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    console.info(getWorkerStartupMessage());

    expect(info).toHaveBeenCalledWith('BenHouse Worker activo');
    info.mockRestore();
  });

  it('drena una entrega correcta antes de desconectar', async () => {
    const delivery = barrier();
    const order: string[] = [];
    const loop = createWorkerLoop({
      processNext: async () => {
        order.push('delivery-started');
        await delivery.promise;
        order.push('processed');
      },
      disconnect: async () => {
        order.push('disconnected');
      },
      reportError: vi.fn(),
    });

    void loop.pollNow();
    expect(order).toEqual(['delivery-started']);
    const shutdown = loop.shutdown();
    await Promise.resolve();
    expect(order).toEqual(['delivery-started']);
    delivery.resolve();
    await shutdown;
    expect(order).toEqual(['delivery-started', 'processed', 'disconnected']);
  });

  it('termina la transición de fallo antes de desconectar', async () => {
    const delivery = barrier();
    const order: string[] = [];
    const reportError = vi.fn();
    const loop = createWorkerLoop({
      processNext: async () => {
        order.push('delivery-started');
        await delivery.promise;
        order.push('retry-finished');
      },
      disconnect: async () => {
        order.push('disconnected');
      },
      reportError,
    });

    void loop.pollNow();
    const shutdown = loop.shutdown();
    expect(order).toEqual(['delivery-started']);
    delivery.resolve();
    await shutdown;
    expect(order).toEqual(['delivery-started', 'retry-finished', 'disconnected']);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('comparte el shutdown repetido y desconecta una sola vez', async () => {
    const delivery = barrier();
    const disconnect = vi.fn(async () => undefined);
    const processNext = vi.fn(async () => delivery.promise);
    const loop = createWorkerLoop({ processNext, disconnect, reportError: vi.fn() });
    void loop.pollNow();

    const first = loop.shutdown();
    const second = loop.shutdown();
    expect(second).toBe(first);
    expect(disconnect).not.toHaveBeenCalled();
    await loop.pollNow();
    expect(processNext).toHaveBeenCalledTimes(1);
    delivery.resolve();
    await Promise.all([first, second]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('no solapa dos polls', async () => {
    const delivery = barrier();
    const processNext = vi.fn(async () => delivery.promise);
    const loop = createWorkerLoop({
      processNext,
      disconnect: vi.fn(async () => undefined),
      reportError: vi.fn(),
    });
    const first = loop.pollNow();
    const second = loop.pollNow();
    expect(second).toBe(first);
    expect(processNext).toHaveBeenCalledOnce();
    delivery.resolve();
    await first;
    await loop.shutdown();
  });

  it('sin trabajo activo desconecta de inmediato y el timer usa unref', async () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
    const disconnect = vi.fn(async () => undefined);
    const loop = createWorkerLoop({
      processNext: vi.fn(async () => undefined),
      disconnect,
      reportError: vi.fn(),
    });
    loop.start();
    expect(unref).toHaveBeenCalledOnce();
    await loop.shutdown();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    expect(disconnect).toHaveBeenCalledOnce();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
