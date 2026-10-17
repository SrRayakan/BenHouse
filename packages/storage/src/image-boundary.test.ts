import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { inspectImage, InvalidImage } from './image';

// index.test puede haber cargado image.ts con Sharp real en este pool. Vaciar
// antes de importar evita observar un mock distinto de la referencia en caché.
vi.hoisted(() => vi.resetModules());

// Observa la entrada a Sharp completa, no solo metadata. Para formatos admitidos
// delega en la implementación real: las pruebas positivas usan el decoder nativo.
vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>();
  return { ...actual, default: vi.fn(actual.default) };
});
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/animated.json'), 'utf8'),
) as Record<string, { mime: string; base64: string }>;
const bytes = (name: string) => Buffer.from(fixtures[name]!.base64, 'base64');

describe('Barrera anterior al parser nativo', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['jpeg', 'png', 'webp'])(
    '%s válido conserva metadata y decode nativos',
    async (format) => {
      const input = bytes(`static${format}`);
      await expect(inspectImage(input)).resolves.toMatchObject({
        mime: `image/${format}`,
        width: 2,
        height: 2,
      });
      expect(sharp).toHaveBeenCalledTimes(2);
      for (const [received] of vi.mocked(sharp).mock.calls) expect(received).toBe(input);
    },
  );
  it('una firma JPEG admitida no sustituye la validación real posterior', async () => {
    await expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]))).rejects.toBeInstanceOf(
      InvalidImage,
    );
    expect(sharp).toHaveBeenCalledOnce();
  });
  it.each(['svg', 'gif', 'tiff', 'avif'])(
    '%s benigno no invoca Sharp, ni metadata ni decodificación',
    async (name) => {
      await expect(inspectImage(bytes(name))).rejects.toBeInstanceOf(InvalidImage);
      expect(sharp).not.toHaveBeenCalled();
    },
  );
  it.each(['apng', 'apngInvalidSecondFrame', 'animatedWebp', 'animatedGif'])(
    '%s se rechaza también antes del decoder',
    async (name) => {
      await expect(inspectImage(bytes(name))).rejects.toBeInstanceOf(InvalidImage);
      expect(sharp).not.toHaveBeenCalled();
    },
  );
  it('cabeceras cortas, firmas parciales y RIFF ajeno no invocan Sharp', async () => {
    for (const invalid of [
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8, 0xff]),
      bytes('staticpng').subarray(0, 32),
      bytes('staticwebp').subarray(0, 19),
      Buffer.from('RIFF0000WAVEfmt 00000000'),
      Buffer.from('text'),
      Buffer.concat([Buffer.from('prefix'), bytes('staticpng')]),
    ])
      await expect(inspectImage(invalid)).rejects.toBeInstanceOf(InvalidImage);
    expect(sharp).not.toHaveBeenCalled();
  });
});
