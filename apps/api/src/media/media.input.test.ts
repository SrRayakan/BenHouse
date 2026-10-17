import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseIntent, parseOrder } from './media.input';
describe('DTO de Media', () => {
  const valid = () => ({
    propertyId: randomUUID(),
    intentKey: randomUUID(),
    uploadToken: randomBytes(32).toString('hex'),
    mime: 'image/jpeg',
    size: 10,
    sha256: 'a'.repeat(64),
  });
  it('rechaza autoridad y claves internas inyectadas', () => {
    for (const key of ['storageKey', 'status', 'ownerId', 'createdByUserId', 'position', 'url'])
      expect(() => parseIntent({ ...valid(), [key]: 'x' })).toThrow();
  });
  it('limita mime, digest, tamaño y token', () => {
    for (const patch of [
      { mime: 'image/svg+xml' },
      { size: 0 },
      { size: 10485761 },
      { size: 1.5 },
      { sha256: 'x' },
      { uploadToken: 'x' },
    ])
      expect(() => parseIntent({ ...valid(), ...patch })).toThrow();
    expect(parseIntent(valid()).mime).toBe('image/jpeg');
  });
  it('la ordenación exige versión y IDs únicos', () => {
    const id = randomUUID();
    expect(() => parseOrder({ version: 0, ids: [id, id] })).toThrow();
    expect(() => parseOrder({ version: -1, ids: [] })).toThrow();
    expect(parseOrder({ version: 0, ids: [id] })).toEqual({ version: 0, ids: [id] });
  });
});
