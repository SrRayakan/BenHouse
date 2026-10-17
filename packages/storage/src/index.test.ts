import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import {
  configuredStorage,
  inspectImage,
  InvalidImage,
  S3StorageProvider,
  MAX_IMAGE_BYTES,
} from './index';

describe('Contenido real y configuración privada', () => {
  it.each(['jpeg', 'png', 'webp'] as const)(
    'decodifica %s y calcula metadata real',
    async (format) => {
      const bytes = await sharp({
        create: { width: 8, height: 6, channels: 3, background: 'green' },
      })
        .toFormat(format)
        .toBuffer();
      expect(await inspectImage(bytes)).toMatchObject({
        mime: `image/${format}`,
        width: 8,
        height: 6,
        size: bytes.length,
      });
      await expect(inspectImage(bytes.subarray(0, bytes.length / 2))).rejects.toBeInstanceOf(
        InvalidImage,
      );
    },
  );
  it('rechaza SVG, texto, tamaño y descompresión excesiva', async () => {
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('not an image'),
      Buffer.alloc(MAX_IMAGE_BYTES + 1),
    ])
      await expect(inspectImage(bytes)).rejects.toBeInstanceOf(InvalidImage);
    const huge = await sharp({
      create: { width: 6500, height: 6500, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(inspectImage(huge)).rejects.toBeInstanceOf(InvalidImage);
  });
  it.each(['apng', 'apngInvalidSecondFrame', 'animatedWebp', 'animatedGif'])(
    'rechaza contenido animado real: %s',
    async (name) => {
      const fixtures = JSON.parse(
        await readFile(resolve(__dirname, '../fixtures/animated.json'), 'utf8'),
      );
      const bytes = Buffer.from(fixtures[name].base64, 'base64');
      const metadata = await sharp(bytes, { animated: true }).metadata();
      if (name.startsWith('apng')) expect(metadata.pages).toBeUndefined();
      else expect(metadata.pages).toBe(2);
      await expect(inspectImage(bytes)).rejects.toBeInstanceOf(InvalidImage);
    },
  );
  it.each([
    'http://0.0.0.0:9000',
    'http://192.168.1.1:9000',
    'http://127.0.0.1:9000/path',
    'file:///private/media',
  ])('falla cerrado para endpoint no permitido: %s', (endpoint) => {
    expect(
      () =>
        new S3StorageProvider({
          endpoint,
          bucket: 'property-media',
          accessKeyId: 'a'.repeat(16),
          secretAccessKey: 'b'.repeat(32),
        }),
    ).toThrow();
  });
  it('falla cerrado sin configuración', async () => {
    await expect(configuredStorage({})).rejects.toThrow();
    await expect(
      configuredStorage({ STORAGE_PROVIDER: 'local', STORAGE_LOCAL_ROOT: 'C:/private' }),
    ).rejects.toThrow();
  });
});
