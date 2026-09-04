import { describe, expect, it, vi } from 'vitest';
import { getWorkerStartupMessage } from './index';

describe('worker', () => {
  it('declara su arranque sin crear procesamiento ficticio', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    console.info(getWorkerStartupMessage());

    expect(info).toHaveBeenCalledWith('BenHouse Worker activo');
    info.mockRestore();
  });
});
