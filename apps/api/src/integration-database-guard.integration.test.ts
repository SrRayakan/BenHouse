import '../test/verified-database.mjs';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('el runner antiguo tampoco ejecuta hooks API sin identidad, aun omitiendo la config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benhouse-api-legacy-guard-'));
  const reportPath = join(directory, 'result.json');
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('API_TEST_DATABASE_')) delete env[key];
    delete env.NODE_OPTIONS;
    // Solo la base efímera ya verificada; además read-only como defensa de la regresión.
    const ephemeral = new URL(process.env.DATABASE_URL!);
    ephemeral.searchParams.set('options', '-c default_transaction_read_only=on');
    env.TEST_DATABASE_URL = ephemeral.toString();
    const development = new URL(ephemeral);
    development.pathname = '/benhouse';
    env.DATABASE_URL = development.toString();
    const apiRoot = resolve(__dirname, '..');
    let failure: unknown;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          resolve(apiRoot, '../../packages/database/scripts/with-test-database.mjs'),
          'vitest',
          'run',
          'src/auth/account-lifecycle.integration.test.ts',
          '--pool=vmThreads',
          '--maxWorkers=1',
          '--reporter=json',
          `--outputFile=${reportPath}`,
        ],
        { cwd: apiRoot, env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 1 });
    // La presencia de este informe prueba que el runner llegó realmente a Vitest.
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(report.numTotalTests).toBe(0);
    expect(report.testResults).toHaveLength(1);
    expect(report.testResults[0].name.replaceAll('\\', '/')).toContain(
      '/auth/account-lifecycle.integration.test.ts',
    );
    expect(report.testResults[0].message).toContain('API_TEST_DATABASE_GUARD');
    expect(report.testResults[0].assertionResults).toEqual([]);
  } finally {
    await unlink(reportPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(directory);
  }
}, 60000);
