import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadLocalEnvironmentFile, readAppConfig, redactSensitiveValue } from '@benhouse/config';
import { AppModule } from './app.module';
import { GlobalHttpExceptionFilter } from './common/http/global-http-exception.filter';
import { StructuredLogger } from './infrastructure/logging/structured-logger';

async function bootstrap(): Promise<void> {
  loadLocalEnvironmentFile();
  const config = readAppConfig();
  const logger = new StructuredLogger(config.logLevel);
  const app = await NestFactory.create(AppModule, { logger });

  app.enableShutdownHooks();
  app.useGlobalFilters(new GlobalHttpExceptionFilter());
  app.enableCors({
    origin: [config.corsOrigin],
    methods: ['GET'],
    credentials: false,
  });
  await app.listen(config.apiPort);
}

function getStartupErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: 'UnknownError', message: 'Error desconocido.' };
  }

  const code =
    'code' in error && (typeof error.code === 'string' || typeof error.code === 'number')
      ? error.code
      : undefined;

  return {
    name: error.name,
    message: redactSensitiveValue(error.message),
    ...(code === undefined ? {} : { code }),
    ...(process.env.NODE_ENV === 'development' && error.stack
      ? { stack: redactSensitiveValue(error.stack) }
      : {}),
  };
}

void bootstrap().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'api',
      message: 'La API no ha podido arrancar.',
      error: getStartupErrorDetails(error),
    }),
  );
  process.exitCode = 1;
});
