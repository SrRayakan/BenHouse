import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_FIELD_LENGTH = 1_048_576;

export function lengthPrefixed(...fields: readonly (string | Buffer | number)[]): Buffer {
  const encoded = fields.map((field) => {
    if (typeof field === 'number') {
      if (!Number.isSafeInteger(field) || field < 0) throw new Error('Campo numérico inválido.');
      return Buffer.from(String(field), 'ascii');
    }
    return Buffer.isBuffer(field) ? field : Buffer.from(field, 'utf8');
  });
  for (const field of encoded) {
    if (field.length > MAX_FIELD_LENGTH) throw new Error('Campo criptográfico demasiado largo.');
  }
  return Buffer.concat(
    encoded.flatMap((field) => {
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(field.length);
      return [length, field];
    }),
  );
}

export function hmacSha256(key: Buffer, ...fields: readonly (string | Buffer | number)[]): Buffer {
  return createHmac('sha256', key)
    .update(lengthPrefixed(...fields))
    .digest();
}

export function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  const maximumLength = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(maximumLength);
  const paddedRight = Buffer.alloc(maximumLength);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}

export function parseCanonicalBase64Url(value: string, expectedBytes: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === expectedBytes && decoded.toString('base64url') === value
    ? decoded
    : undefined;
}
