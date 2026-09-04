import { afterEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { loadLocalEnvironmentFile, readAppConfig } from '@benhouse/config';
import { AppModule } from './app.module';
import { DatabaseService } from './infrastructure/database/database.service';

type Timings = Record<string, number>;

async function measure<T>(timings: Timings, phase: string, action: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    timings[phase] = Number((performance.now() - startedAt).toFixed(1));
  }
}

function getReady(
  port: number,
  origin: string,
): Promise<{ statusCode: number; body: Record<string, unknown>; cors: string | undefined }> {
  return new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/ready',
        method: 'GET',
        headers: { Origin: origin, Connection: 'close' },
        agent: false,
      },
      (response) => {
        let payload = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          payload += chunk;
        });
        response.on('end', () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: JSON.parse(payload) as Record<string, unknown>,
              cors: response.headers['access-control-allow-origin'],
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    clientRequest.on('error', reject);
    clientRequest.end();
  });
}

describe('readiness de la API', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('expone /ready sin filtrar secretos y aplica CORS configurado', async () => {
    const timings: Timings = {};
    loadLocalEnvironmentFile();
    const config = readAppConfig();
    app = await measure(timings, 'nest.create', () => NestFactory.create(AppModule, { logger: false }));
    app.enableCors({ origin: [config.corsOrigin], methods: ['GET'], credentials: false });
    await measure(timings, 'app.init', () => app!.init());

    const database = app.get(DatabaseService);
    await measure(timings, 'prisma.connect', () => database.connect());
    await measure(timings, 'database.select1', () => database.verifyConnection());
    await measure(timings, 'postgis.version', () => database.verifyPostgis());
    await measure(timings, 'app.listen', () => app!.listen(0, '127.0.0.1'));

    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('No se ha podido obtener el puerto de prueba de la API.');
    }

    const response = await measure(timings, 'http.ready', () =>
      getReady(address.port, config.corsOrigin),
    );

    try {
      expect(response.statusCode).toBe(200);
      expect(response.cors).toBe(config.corsOrigin);
      expect(response.body).toEqual({
        status: 'ok',
        service: 'api',
        database: 'ready',
        postgis: 'ready',
      });
      expect(JSON.stringify(response.body)).not.toContain(config.databaseUrl);
    } finally {
      await measure(timings, 'prisma.disconnect', () => database.disconnect());
      await measure(timings, 'app.close', () => app!.close());
      app = undefined;
      console.info(JSON.stringify({ event: 'api.ready.integration.timings_ms', timings }));
    }
  });
});
