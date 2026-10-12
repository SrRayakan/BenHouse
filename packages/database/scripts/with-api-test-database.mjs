import { loadRootEnvironment } from './with-root-environment.mjs';
import { runEphemeralTests } from './with-ephemeral-test-database.mjs';

if (import.meta.main) {
  loadRootEnvironment();
  await runEphemeralTests('api', process.argv.slice(2));
}
