import { verifyApiTestDatabase } from './api-test-database.mjs';

// Cada suite importa esta barrera antes de registrar tests/hooks, incluso sin config.
// El runner ya cargó .env: ninguna suite debe volver a cargarlo después de verificar.
await verifyApiTestDatabase();
