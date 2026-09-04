import { createPrismaClient, verifyDatabaseInfrastructure } from '@benhouse/database';
import { loadLocalEnvironmentFile, readAppConfig, redactSensitiveValue } from '@benhouse/config';

export function getWorkerStartupMessage(): string {
  return 'BenHouse Worker activo';
}

export async function startWorker(): Promise<void> {
  loadLocalEnvironmentFile();
  readAppConfig();

  const client = createPrismaClient();
  const shutdown = async (): Promise<void> => {
    await client.$disconnect();
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  try {
    await verifyDatabaseInfrastructure(client);
    console.info(
      JSON.stringify({ level: 'info', service: 'worker', message: getWorkerStartupMessage() }),
    );
  } catch (error) {
    await shutdown();
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'worker',
        message: 'El worker no ha podido conectar con la infraestructura de persistencia.',
        error: redactSensitiveValue(error instanceof Error ? error.message : 'Error desconocido.'),
      }),
    );
    throw error;
  }
}

if (require.main === module) {
  void startWorker().catch(() => {
    process.exitCode = 1;
  });
}
