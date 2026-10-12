import { describe, expect, it, vi } from 'vitest';
import { assertOwnedIdentity, runEphemeralTests } from './with-ephemeral-test-database.mjs';

const environment = {
  DATABASE_URL: 'postgresql://local:synthetic@localhost:5432/benhouse',
  TEST_DATABASE_URL: 'postgresql://local:synthetic@localhost:5432/benhouse_test',
  API_TEST_DATABASE_NAME: 'benhouse_test', // Nunca autoridad para elegir nombre.
};

function fixture(failures = []) {
  const fail = new Set(failures);
  const shared = { name: 'benhouse_test', oid: '2', system: '100' };
  let name,
    dropped = false,
    catalogReads = 0,
    adminReads = 0,
    childReads = 0;
  const admin = {
    $executeRawUnsafe: vi.fn(async (sql) => {
      if (sql.startsWith('CREATE')) {
        name = /^CREATE DATABASE "([a-z0-9_]+)" TEMPLATE template0$/.exec(sql)?.[1];
        expect(name).toMatch(/^benhouse_(api|worker)_[a-f0-9]{32}_test$/);
        if (fail.has('create')) throw new Error('driver-secret');
      } else {
        expect(sql).toBe(`DROP DATABASE "${name}"`);
        if (fail.has('drop')) throw new Error('driver-secret');
        dropped = true;
      }
    }),
    $queryRaw: vi.fn(async (_sql, requested) => {
      expect(requested).toBe(name);
      catalogReads++;
      if (fail.has('capture-oid') && catalogReads === 1) throw new Error('driver-secret');
      if (dropped && !fail.has('drop-not-effective')) return [];
      return [{ oid: fail.has('replaced-oid') && catalogReads > 1 ? '999' : '3' }];
    }),
    $disconnect: vi.fn(async () => {
      if (fail.has('disconnect')) throw new Error('driver-secret');
    }),
  };
  const io = {
    admin: vi.fn(() => admin),
    log: vi.fn(),
    readIdentity: vi.fn(async () => {
      adminReads++;
      return {
        ...shared,
        system: fail.has('changed-admin') && adminReads > 1 ? '999' : shared.system,
      };
    }),
    identityAt: vi.fn(async (url) => {
      const databaseName = new URL(url).pathname.slice(1);
      if (databaseName === 'benhouse') return { name: databaseName, oid: '1', system: '100' };
      if (databaseName === 'benhouse_test')
        return {
          ...shared,
          oid: fail.has('shared-alias-dev') ? '1' : shared.oid,
          name: fail.has('shared-wrong-name') ? 'foreign' : shared.name,
        };
      childReads++;
      return {
        name: fail.has('wrong-name') ? 'benhouse_test' : databaseName,
        oid:
          fail.has('wrong-oid') || (fail.has('post-migrate-oid') && childReads > 1) ? '999' : '3',
        system: fail.has('wrong-system') ? '999' : '100',
      };
    }),
    run: vi.fn(async (command, args, child) => {
      expect(child.DATABASE_URL).toBe(child.TEST_DATABASE_URL);
      expect(new URL(child.DATABASE_URL).pathname).toBe(`/${name}`);
      expect(child.NODE_ENV).toBe('test');
      if (
        (command === 'prisma' && fail.has('migrate')) ||
        (command === 'vitest' && fail.has('tests'))
      )
        throw new Error('driver-secret');
    }),
  };
  return { admin, io };
}

describe('runner efímero API/worker: sin fallback ni borrado ajeno', () => {
  it.each(['api', 'worker'])('completa %s y mantiene identidad en ambas fases', async (suite) => {
    const { io, admin } = fixture();
    await runEphemeralTests(suite, ['src/example.integration.test.ts'], environment, io);
    expect(io.run.mock.calls.map(([command]) => command)).toEqual(['prisma', 'vitest']);
    const child = io.run.mock.calls[0][2];
    expect(child[`${suite.toUpperCase()}_TEST_DATABASE_NAME`]).toMatch(
      new RegExp(`^benhouse_${suite}_`),
    );
    expect(child[`${suite.toUpperCase()}_TEST_DATABASE_OID`]).toBe('3');
    expect(child[`${suite.toUpperCase()}_TEST_DATABASE_SYSTEM`]).toBe('100');
    if (suite === 'worker')
      expect(child.WORKER_SHARED_TEST_DATABASE_URL).toBe(environment.TEST_DATABASE_URL);
    expect(admin.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(admin.$disconnect).toHaveBeenCalledOnce();
  });

  it('genera nombres distintos sin usar el nombre recibido en env', async () => {
    const first = fixture(),
      second = fixture();
    await runEphemeralTests('api', [], environment, first.io);
    await runEphemeralTests('api', [], environment, second.io);
    expect(first.io.run.mock.calls[0][2].API_TEST_DATABASE_NAME).not.toBe(
      second.io.run.mock.calls[0][2].API_TEST_DATABASE_NAME,
    );
  });

  it.each(['shared-alias-dev', 'shared-wrong-name'])(
    'rechaza identidad protegida %s antes de DDL',
    async (failure) => {
      const { io, admin } = fixture([failure]);
      await expect(runEphemeralTests('api', [], environment, io)).rejects.toThrow(AggregateError);
      expect(admin.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(io.run).not.toHaveBeenCalled();
    },
  );

  it.each(['wrong-name', 'wrong-oid', 'wrong-system', 'post-migrate-oid'])(
    'rechaza identidad propia %s y limpia exclusivamente el OID creado',
    async (failure) => {
      const { io, admin } = fixture([failure]);
      await expect(runEphemeralTests('api', [], environment, io)).rejects.toThrow(AggregateError);
      expect(io.run.mock.calls.filter(([command]) => command === 'vitest')).toHaveLength(0);
      expect(admin.$executeRawUnsafe).toHaveBeenCalledTimes(2);
      expect(admin.$disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each(['create', 'capture-oid', 'replaced-oid', 'changed-admin'])(
    'no adopta ni elimina un recurso sin propiedad verificable: %s',
    async (failure) => {
      const { io, admin } = fixture([failure]);
      const error = await runEphemeralTests('api', [], environment, io).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(admin.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      expect(admin.$disconnect).toHaveBeenCalledOnce();
      if (failure === 'create' || failure === 'capture-oid') expect(io.run).not.toHaveBeenCalled();
      expect(JSON.stringify(error.errors.map(({ message }) => message))).not.toContain(
        'driver-secret',
      );
    },
  );

  it('no ejecuta pruebas tras migración parcial/fallida y limpia la base propia', async () => {
    const { io, admin } = fixture(['migrate']);
    await expect(runEphemeralTests('api', [], environment, io)).rejects.toThrow(AggregateError);
    expect(io.run.mock.calls.map(([command]) => command)).toEqual(['prisma']);
    expect(admin.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(admin.$disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ['tests'],
    ['drop'],
    ['tests', 'drop'],
    ['tests', 'drop', 'disconnect'],
    ['drop-not-effective'],
  ])('conserva errores de pruebas y limpieza: %j', async (...failures) => {
    const { io, admin } = fixture(failures);
    const error = await runEphemeralTests('api', [], environment, io).catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(failures.length);
    expect(admin.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(admin.$disconnect).toHaveBeenCalledOnce();
    expect(admin.$executeRawUnsafe.mock.calls.every(([sql]) => !sql.includes('FORCE'))).toBe(true);
  });

  it('rechaza producción antes de cualquier conexión', async () => {
    const { io } = fixture();
    await expect(
      runEphemeralTests('api', [], { ...environment, NODE_ENV: 'production' }, io),
    ).rejects.toThrow('production');
    expect(io.identityAt).not.toHaveBeenCalled();
  });

  it('la guarda de fixtures no admite nombres compartidos, OID vacío ni otro sistema', () => {
    const own = { name: `benhouse_api_${'a'.repeat(32)}_test`, oid: '3', system: '100' };
    for (const actual of [
      { ...own, name: 'benhouse_test' },
      { ...own, oid: '' },
      { ...own, system: '200' },
    ])
      expect(() => assertOwnedIdentity('api', own, actual)).toThrow('no autorizada');
    expect(() =>
      assertOwnedIdentity(
        'api',
        { ...own, name: 'benhouse_test' },
        { ...own, name: 'benhouse_test' },
      ),
    ).toThrow('no autorizada');
  });
});
