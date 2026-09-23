import { createPrismaClient, verifyDatabaseInfrastructure } from '@benhouse/database';
import { loadLocalEnvironmentFile, readAppConfig, redactSensitiveValue } from '@benhouse/config';
import { processNextInvitation, UnconfiguredInvitationNotificationPort } from './invitation-outbox';

export function getWorkerStartupMessage(): string {
  return 'BenHouse Worker activo';
}

type WorkerLoopOptions = {
  processNext: () => Promise<unknown>;
  disconnect: () => Promise<void>;
  reportError: () => void;
  intervalMs?: number;
};

export type WorkerLoop = {
  start(): void;
  pollNow(): Promise<void>;
  shutdown(): Promise<void>;
};

export function createWorkerLoop({
  processNext,
  disconnect,
  reportError,
  intervalMs = 5_000,
}: WorkerLoopOptions): WorkerLoop {
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeTask: Promise<void> | undefined;
  let shutdownTask: Promise<void> | undefined;
  let stopped = false;

  const pollNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeTask) return activeTask;
    const task = processNext()
      .then(() => undefined)
      .catch(() => {
        reportError();
      })
      .finally(() => {
        if (activeTask === task) activeTask = undefined;
      });
    activeTask = task;
    return task;
  };

  const start = (): void => {
    if (stopped || timer) return;
    timer = setInterval(() => void pollNow(), intervalMs);
    timer.unref();
  };

  const shutdown = (): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    const taskToDrain = activeTask;
    shutdownTask = (async () => {
      await taskToDrain;
      await disconnect();
    })();
    return shutdownTask;
  };

  return { start, pollNow, shutdown };
}

export async function startWorker(): Promise<void> {
  loadLocalEnvironmentFile();
  const config = readAppConfig();

  const client = createPrismaClient();
  const loop = createWorkerLoop({
    processNext: () =>
      processNextInvitation(client, config.auth, new UnconfiguredInvitationNotificationPort()),
    disconnect: () => client.$disconnect(),
    reportError: () => {
      console.error(
        JSON.stringify({ level: 'error', service: 'worker', code: 'INVITATION_OUTBOX_FAILED' }),
      );
    },
  });
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    shutdownTask = loop.shutdown().finally(() => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    });
    return shutdownTask;
  };
  const onSignal = (): void => {
    void shutdown();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await verifyDatabaseInfrastructure(client);
    console.info(
      JSON.stringify({ level: 'info', service: 'worker', message: getWorkerStartupMessage() }),
    );
    loop.start();
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
