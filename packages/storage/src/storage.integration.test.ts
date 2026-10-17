import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rename, symlink, unlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  configuredStorage,
  InvalidImage,
  MAX_IMAGE_BYTES,
  ObjectConflict,
  StorageProvider,
} from './index';

describe('S3 local real y frontera de rutas Windows', () => {
  let storage: StorageProvider, client: S3Client;
  beforeAll(async () => {
    if (!/^[a-f0-9-]{36}$/.test(process.env.STORAGE_TEST_OWNER ?? ''))
      throw new Error('Servicio efímero obligatorio');
    storage = await configuredStorage();
    client = new S3Client({
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_S3_ACCESS_KEY!,
        secretAccessKey: process.env.STORAGE_S3_SECRET_KEY!,
      },
      maxAttempts: 1,
    });
  });
  afterAll(() => {
    storage?.close();
    client?.destroy();
  });
  const key = () => randomBytes(32).toString('hex');
  it('inmutabilidad entre instancias y consumidores concurrentes', async () => {
    const second = await configuredStorage(),
      id = key();
    try {
      const bodies = Array.from({ length: 16 }, (_, i) => Buffer.from(`synthetic-${i}`));
      const outcomes = await Promise.allSettled(
        bodies.map((b, i) => (i % 2 ? second : storage).put(id, b)),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const winner = outcomes.findIndex((o) => o.status === 'fulfilled');
      for (const o of outcomes)
        if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(ObjectConflict);
      expect(await storage.read(id)).toEqual(bodies[winner]);
      await Promise.all([storage.put(id, bodies[winner]!), second.put(id, bodies[winner]!)]);
      expect(await second.read(id)).toEqual(bodies[winner]);
    } finally {
      second.close();
    }
  });
  it('objeto ausente, borrado idempotente, claves y límites', async () => {
    const id = key();
    expect(await storage.read(id)).toBeNull();
    await storage.removeIncomplete(id);
    await storage.put(id, Buffer.from('synthetic'));
    await storage.removeIncomplete(id);
    await storage.removeIncomplete(id);
    expect(await storage.read(id)).toBeNull();
    await expect(storage.put('../public/x', Buffer.from('x'))).rejects.toThrow();
    await expect(storage.put(key(), Buffer.alloc(MAX_IMAGE_BYTES + 1))).rejects.toBeInstanceOf(
      InvalidImage,
    );
    const oversized = key();
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_S3_BUCKET,
        Key: oversized,
        Body: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      }),
    );
    await expect(storage.read(oversized)).rejects.toBeInstanceOf(InvalidImage);
    await storage.removeIncomplete(oversized);
  });
  it('PUT interrumpido no produce un objeto parcial y permite reintentar', async () => {
    const id = key(),
      abort = new AbortController();
    let read = false;
    const body = new Readable({
      read() {
        if (!read) {
          read = true;
          this.push(Buffer.from('partial'));
          setTimeout(() => abort.abort(), 100);
        }
      },
    });
    await expect(
      client.send(
        new PutObjectCommand({
          Bucket: process.env.STORAGE_S3_BUCKET,
          Key: id,
          Body: body,
          ContentLength: 1024,
          IfNoneMatch: '*',
          ChecksumSHA256: createHash('sha256').update(Buffer.alloc(1024, 'a')).digest('base64'),
        }),
        { abortSignal: abort.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).toBe(true);
    body.destroy();
    expect(await storage.read(id)).toBeNull();
    await storage.put(id, Buffer.from('complete'));
    expect(await storage.read(id)).toEqual(Buffer.from('complete'));
  });
  it('Windows: private-alias → public y sustitución durante PUT no reciben bytes', async () => {
    // No omitir en Windows: la prueba usa junctions reales, sin privilegio symlink.
    const root = await mkdtemp(join(tmpdir(), 'benhouse-c12-junction-'));
    const canonical = await realpath(root),
      pub = join(root, 'public'),
      alias = join(root, 'private-alias');
    const privateDir = join(root, 'private-parent'),
      retired = join(root, 'retired');
    let aliasCreated = false,
      swapped = false;
    try {
      await mkdir(pub);
      await mkdir(privateDir);
      await symlink(pub, alias, 'junction');
      aliasCreated = true;
      const legacy = {
        ...process.env,
        STORAGE_PROVIDER: 'local',
        STORAGE_LOCAL_ROOT: join(alias, 'media'),
      };
      await expect(configuredStorage(legacy)).rejects.toThrow();
      const id = key();
      const original = client.send.bind(client);
      // Intercepción causal de la llamada HTTP del SDK usado por el provider:
      // al dispararse, todos los argumentos ya son bucket/key, ninguna ruta.
      const send = vi.spyOn(S3Client.prototype, 'send').mockImplementationOnce(async function (
        ...args: unknown[]
      ) {
        await rename(privateDir, retired);
        await symlink(pub, privateDir, 'junction');
        swapped = true;
        send.mockRestore();
        return original(...(args as Parameters<typeof client.send>));
      });
      try {
        await storage.put(id, Buffer.from('synthetic-private'));
      } finally {
        send.mockRestore();
      }
      expect(swapped).toBe(true);
      expect(await storage.read(id)).toEqual(Buffer.from('synthetic-private'));
      expect(await readdir(pub, { recursive: true })).toEqual([]);
      expect(await readdir(retired, { recursive: true })).toEqual([]);
    } finally {
      if (aliasCreated) await unlink(alias);
      if (swapped) await unlink(privateDir);
      expect(await realpath(root)).toBe(canonical);
      expect(resolve(root)).toBe(canonical);
      await rm(root, { recursive: true });
    }
  });
});
