import { describe, expect, it } from 'vitest';
import { assertOwnedDatabase, runWorkerTests } from './with-worker-test-database.mjs';

describe('base exclusiva del worker', () => {
  const owned = `benhouse_worker_${'a'.repeat(32)}_test`;
  it('acepta únicamente el nombre propio y el OID original', () => {
    expect(() => assertOwnedDatabase(owned, '123', '123')).not.toThrow();
  });
  it.each([
    ['benhouse', '123', '123'],
    ['benhouse_test', '123', '123'],
    ['benhouse_worker_untrusted_test', '123', '123'],
    [owned, '123', '124'],
    [owned, undefined, undefined],
  ])('rechaza destino no propio o reemplazado: %s', (name, expected, actual) => {
    expect(() => assertOwnedDatabase(name, expected, actual)).toThrow('no autorizada');
  });
  it('rechaza producción antes de cualquier conexión o DDL', async () => {
    await expect(runWorkerTests([], { NODE_ENV: 'production' })).rejects.toThrow('production');
  });
});
