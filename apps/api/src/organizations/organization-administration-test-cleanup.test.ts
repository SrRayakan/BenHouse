import { describe, expect, it, vi } from 'vitest';
import {
  cleanupOrganizationAdministration,
  runCleanupSteps,
} from './organization-administration-test-cleanup';

describe('cierre B1.5 ante fallos y preparación parcial', () => {
  it('conserva el fallo original y todos los fallos de cierre, incluso rechazos sin Error', async () => {
    const original = new Error('Fallo original de preparación');
    const closeError = new Error('Fallo cerrando la aplicación');
    const calls: string[] = [];
    const result = runCleanupSteps(
      [
        {
          name: 'app',
          run: () => {
            calls.push('app');
            throw closeError;
          },
        },
        {
          name: 'db',
          run: async () => {
            calls.push('db');
            throw undefined;
          },
        },
        {
          name: 'entorno',
          run: () => {
            calls.push('entorno');
          },
        },
      ],
      [original],
    );
    await expect(result).rejects.toSatisfy((error: AggregateError) => {
      expect(error.cause).toBe(original);
      expect(error.errors[0]).toBe(original);
      expect(error.errors[1].cause).toBe(closeError);
      expect(error.errors[2].cause).toBeUndefined();
      expect(error.errors).toHaveLength(3);
      return true;
    });
    expect(calls).toEqual(['app', 'db', 'entorno']);
  });

  for (const prior of [undefined, 'postgresql://valor-previo']) {
    it(`restaura DATABASE_URL ${prior === undefined ? 'ausente' : 'presente'} sin base ni aplicación preparada`, async () => {
      const actual = process.env.DATABASE_URL;
      const closeModule = vi.fn(async () => {
        throw new Error('Módulo parcial');
      });
      const disconnect = vi.fn(async () => undefined);
      process.env.DATABASE_URL = 'postgresql://temporal';
      try {
        await expect(
          cleanupOrganizationAdministration({
            userIds: [],
            organizationIds: [],
            requestIds: new Set(),
            resources: [
              { name: 'módulo parcial', run: closeModule },
              { name: 'cliente de referencia', run: disconnect },
              {
                name: 'observador',
                run: () => {
                  throw new Error('Observador pendiente');
                },
              },
            ],
            restoreDatabaseUrl: () => {
              if (prior === undefined) delete process.env.DATABASE_URL;
              else process.env.DATABASE_URL = prior;
            },
          }),
        ).rejects.toSatisfy((error: AggregateError) => error.errors.length === 2);
        expect(disconnect).toHaveBeenCalledOnce();
        expect(process.env.DATABASE_URL).toBe(prior);
      } finally {
        if (actual === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = actual;
      }
    });
  }
});
