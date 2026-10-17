import { loadRootEnvironment } from './with-root-environment.mjs';
import { runEphemeralTests } from './with-ephemeral-test-database.mjs';
import { withLocalObjectService } from '../../storage/scripts/local-object-service.mjs';

if (import.meta.main) {
  loadRootEnvironment();
  await withLocalObjectService(async (storage) => {
    await runEphemeralTests('api', process.argv.slice(2), { ...process.env, ...storage });
  });
}
