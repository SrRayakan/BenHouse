import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { ReadyController } from './ready.controller';

describe('ReadyController', () => {
  it('devuelve preparación cuando la infraestructura responde', async () => {
    const database = { verifyInfrastructure: vi.fn().mockResolvedValue(undefined) };
    const controller = new ReadyController(database as never);

    await expect(controller.getReady()).resolves.toEqual({
      status: 'ok',
      service: 'api',
      database: 'ready',
      postgis: 'ready',
    });
  });

  it('responde de forma controlada si la infraestructura no está disponible', async () => {
    const database = {
      verifyInfrastructure: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const controller = new ReadyController(database as never);

    await expect(controller.getReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
