import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { withLocalObjectService } from './local-object-service.mjs';
import { verifyObjectIsolation } from './verify-object-isolation.mjs';
import { verifyBackupRestore } from './object-backup.mjs';

await withLocalObjectService(async (storage, context) => {
  await verifyObjectIsolation(storage, context);
  const result = spawnSync(
    process.execPath,
    [
      resolve('../../node_modules/vitest/vitest.mjs'),
      'run',
      'src/storage.integration.test.ts',
      '--pool=vmThreads',
      '--maxWorkers=1',
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, ...storage } },
  );
  if (result.error || result.status !== 0) throw new Error('Regresiones de objetos fallidas.');
  await verifyBackupRestore(storage, context);
});
