import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { verifyApiTestDatabase } from './api-test-database.mjs';

const apiRoot = resolve(import.meta.dirname, '..');
const guardPath = join(apiRoot, 'test/verified-database.mjs');
const name = `benhouse_api_${'a'.repeat(32)}_test`;
const identity = { name, oid: '42', system: '123' };
const environment = () => ({
  NODE_ENV: 'test',
  DATABASE_URL: `postgresql://synthetic@127.0.0.1:1/${name}`,
  TEST_DATABASE_URL: `postgresql://synthetic@127.0.0.1:1/${name}`,
  API_TEST_DATABASE_NAME: name,
  API_TEST_DATABASE_OID: identity.oid,
  API_TEST_DATABASE_SYSTEM: identity.system,
});

async function integrationFiles() {
  const files = [];
  for (const directory of ['src', 'test']) {
    for (const file of await readdir(join(apiRoot, directory), { recursive: true })) {
      if (/\.integration\.(test|spec)\.[cm]?[jt]s$/.test(file)) {
        files.push(join(apiRoot, directory, file));
      }
    }
  }
  return files.sort();
}

function checkGuard(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const first = tree.statements[0];
  if (
    !first ||
    !ts.isImportDeclaration(first) ||
    first.importClause ||
    !ts.isStringLiteral(first.moduleSpecifier) ||
    resolve(dirname(file), first.moduleSpecifier.text) !== guardPath
  )
    throw new Error('La primera instrucción debe importar la barrera de identidad.');
  // Los mocks hoisted pueden adelantarse a imports; la carga de entorno puede
  // sustituir una conexión ya verificada. Ninguna suite actual necesita estos APIs.
  const forbidden = new Set([
    'loadLocalEnvironmentFile',
    'loadEnvFile',
    'dotenv',
    'hoisted',
    'mock',
  ]);
  function visit(node) {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      throw new Error(`Operación incompatible con la barrera: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

describe('barrera obligatoria de las suites API', () => {
  it('descubre todas las suites y exige el import inicial sin cargas de entorno ni hoisting', async () => {
    const files = await integrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(11);
    for (const file of files) checkGuard(file, await readFile(file, 'utf8'));
  });

  it('detecta una suite futura desprotegida, imports tardíos y carga de entorno posterior', () => {
    const file = join(apiRoot, 'src/future.integration.test.ts');
    const first = "import '../test/verified-database.mjs';\n";
    for (const source of [
      "import { beforeAll } from 'vitest';",
      `import 'reflect-metadata';\n${first}`,
      `${first}process.loadEnvFile();`,
      `${first}import { loadLocalEnvironmentFile as load } from '@benhouse/config'; load();`,
      `${first}vi.hoisted(() => write());`,
      `${first}vi.mock('database', () => write());`,
    ])
      expect(() => checkGuard(file, source)).toThrow();
    expect(() => checkGuard(file, first)).not.toThrow();
  });

  it.each([
    ['sin identidad', { API_TEST_DATABASE_NAME: undefined }],
    ['sufijo genérico', { API_TEST_DATABASE_NAME: 'arbitrary_test' }],
    ['sin OID', { API_TEST_DATABASE_OID: undefined }],
    ['sin sistema', { API_TEST_DATABASE_SYSTEM: undefined }],
    ['producción', { NODE_ENV: 'production' }],
    ['URL distinta', { TEST_DATABASE_URL: 'postgresql://synthetic@localhost/arbitrary_test' }],
    ['protocolo incorrecto', { DATABASE_URL: `https://localhost/${name}` }],
  ])('rechaza %s sin abrir conexiones', async (_label, overrides) => {
    const read = vi.fn();
    await expect(verifyApiTestDatabase({ ...environment(), ...overrides }, read)).rejects.toThrow(
      'API_TEST_DATABASE_GUARD',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['name', 'oid', 'system'])('rechaza identidad física incorrecta: %s', async (key) => {
    const read = vi.fn().mockResolvedValue({ ...identity, [key]: 'incorrecta' });
    await expect(verifyApiTestDatabase(environment(), read)).rejects.toThrow(
      'API_TEST_DATABASE_GUARD',
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('valida ambas conexiones y detecta cambios del entorno durante la verificación', async () => {
    const read = vi.fn().mockResolvedValue(identity);
    await verifyApiTestDatabase(environment(), read);
    expect(read).toHaveBeenCalledTimes(2);
    const env = environment();
    await expect(
      verifyApiTestDatabase(env, async () => {
        env.DATABASE_URL = 'postgresql://changed@localhost/arbitrary_test';
        return identity;
      }),
    ).rejects.toThrow('API_TEST_DATABASE_GUARD');
  });

  it.each(['default', 'vmThreads'])(
    'ejecuta todas las suites sin config (%s) sin registrar tests ni conectar a PostgreSQL',
    async (pool) => {
      // Un servidor TCP propio sin PostgreSQL: ninguna URL puede alcanzar bases históricas.
      let connections = 0;
      const server = createServer((socket) => {
        connections++;
        socket.destroy();
      });
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      const directory = await mkdtemp(join(tmpdir(), 'benhouse-api-guard-'));
      const reportPath = join(directory, 'result.json');
      try {
        const files = await integrationFiles();
        const env = { ...process.env, NODE_ENV: 'test' };
        for (const key of Object.keys(env))
          if (key.startsWith('API_TEST_DATABASE_')) delete env[key];
        // También eliminar loaders heredados; el proceso hijo ejecuta Vitest real.
        delete env.NODE_OPTIONS;
        const url = `postgresql://synthetic:synthetic@127.0.0.1:${server.address().port}/guard_probe_test`;
        env.DATABASE_URL = url;
        env.TEST_DATABASE_URL = url;
        let failure;
        try {
          await promisify(execFile)(
            process.execPath,
            [
              resolve(apiRoot, '../../node_modules/vitest/vitest.mjs'),
              'run',
              ...files.map((file) => relative(apiRoot, file)),
              ...(pool === 'default' ? [] : ['--pool=vmThreads']),
              '--maxWorkers=1',
              '--reporter=json',
              `--outputFile=${reportPath}`,
            ],
            { cwd: apiRoot, env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 },
          );
        } catch (error) {
          failure = error;
        }
        expect(failure?.code).toBe(1);
        const report = JSON.parse(await readFile(reportPath, 'utf8'));
        expect(report.numTotalTests).toBe(0);
        expect(report.testResults).toHaveLength(files.length);
        for (const file of files) {
          const result = report.testResults.find((entry) => resolve(entry.name) === file);
          expect(result?.status).toBe('failed');
          expect(result?.message).toContain('API_TEST_DATABASE_GUARD');
          expect(result?.assertionResults).toEqual([]);
        }
        expect(connections).toBe(0);
      } finally {
        await new Promise((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
        await unlink(reportPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await rmdir(directory);
      }
    },
    60000,
  );
});
