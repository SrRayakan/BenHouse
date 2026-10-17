import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { receiveBytes } from './media.controller';
afterEach(() => vi.useRealTimers());
describe('Carga acotada de fotografías', () => {
  it('recompone bytes y rechaza cuerpos cortos o mayores que lo autorizado', async () => {
    for (const [size, valid] of [
      [3, true],
      [2, false],
      [4, false],
    ] as const) {
      const stream = new PassThrough();
      const result = receiveBytes(stream as unknown as IncomingMessage, size);
      const assertion = valid
        ? expect(result).resolves.toEqual(Buffer.from('abc'))
        : expect(result).rejects.toThrow();
      stream.end(Buffer.from('abc'));
      await assertion;
    }
  });
  it('un aborto seguido de ECONNRESET no deja un error sin listener', async () => {
    const stream = new PassThrough();
    const assertion = expect(
      receiveBytes(stream as unknown as IncomingMessage, 3),
    ).rejects.toThrow();
    stream.emit('aborted');
    expect(() => stream.emit('error', new Error('ECONNRESET'))).not.toThrow();
    await assertion;
    stream.destroy();
  });
  it('rechaza una conexión ya destruida antes de recibir', async () => {
    const stream = new PassThrough();
    stream.destroy();
    await expect(receiveBytes(stream as unknown as IncomingMessage, 3)).rejects.toThrow();
  });
  it('caduca una carga que no termina', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const assertion = expect(
      receiveBytes(stream as unknown as IncomingMessage, 3),
    ).rejects.toMatchObject({ code: 'MEDIA_UPLOAD_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    stream.destroy();
  });
});
