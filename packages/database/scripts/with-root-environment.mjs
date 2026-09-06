import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function loadRootEnvironment() {
  const environmentFile = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }
}

export function execute(command, arguments_, environment = process.env) {
  const cliPaths = {
    prisma: resolve(import.meta.dirname, '../node_modules/prisma/build/index.js'),
    vitest: resolve(import.meta.dirname, '../../../node_modules/vitest/vitest.mjs'),
  };
  const cliPath = cliPaths[command];
  if (!cliPath) {
    throw new Error(`El comando ${command} no está permitido por este helper.`);
  }

  const result = spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

if (import.meta.main) {
  loadRootEnvironment();
  const [command, ...arguments_] = process.argv.slice(2);
  if (!command) {
    throw new Error('Debe indicarse un comando para ejecutar con el entorno raíz.');
  }
  execute(command, arguments_);
}
