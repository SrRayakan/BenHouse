import { loadRootEnvironment } from './with-root-environment.mjs';
import { assertOwnedIdentity, runEphemeralTests } from './with-ephemeral-test-database.mjs';

export function assertOwnedDatabase(name, expectedOid, actualOid) {
  assertOwnedIdentity(
    'worker',
    { name, oid: expectedOid, system: 'same' },
    { name, oid: actualOid, system: 'same' },
  );
}
export function runWorkerTests(args, environment = process.env) {
  return runEphemeralTests('worker', args, environment);
}
if (import.meta.main) {
  loadRootEnvironment();
  await runWorkerTests(process.argv.slice(2));
}
