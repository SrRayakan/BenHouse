import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('devuelve el estado técnico de la API', () => {
    expect(new HealthController().getHealth()).toEqual({ status: 'ok', service: 'api' });
  });
});
