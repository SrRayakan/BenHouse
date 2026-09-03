import { describe, expect, it, vi } from 'vitest';
import { startWorker } from './index';

describe('worker', () => {
  it('puede arrancar sin crear procesamiento ficticio', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    startWorker();

    expect(info).toHaveBeenCalledWith('BenHouse Worker activo');
    info.mockRestore();
  });
});
