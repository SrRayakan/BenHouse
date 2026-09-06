import { describe, expect, it, vi } from 'vitest';
import { StructuredLogger } from './structured-logger';

describe('StructuredLogger', () => {
  it('no filtra secretos anidados ni falla ante referencias circulares', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const circular: Record<string, unknown> = {
      request: {
        headers: {
          authorization: 'Bearer no-filtrar',
          cookie: 'session=no-filtrar',
        },
      },
      passwordHash: 'no-filtrar',
    };
    circular.self = circular;

    new StructuredLogger('debug').error(circular);

    const serialized = String(output.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('no-filtrar');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[REDACTED_CIRCULAR_REFERENCE]');
    output.mockRestore();
  });

  it('no filtra secretos recibidos mediante context', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    new StructuredLogger('debug').error(
      'Fallo controlado.',
      undefined,
      'Authorization: Bearer secreto-en-contexto password=secreto-en-contexto',
    );

    const serialized = String(output.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('secreto-en-contexto');
    expect(serialized).toContain('[REDACTED]');
    output.mockRestore();
  });
});
