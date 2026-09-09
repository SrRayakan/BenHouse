import { invalidRequest } from './auth.errors';

export function exactObject(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidRequest();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw invalidRequest('La solicitud contiene campos no permitidos.');
  }
  return value;
}

export function validateDisplayName(input: unknown): string {
  if (typeof input !== 'string') throw invalidRequest('El nombre no es válido.');
  const value = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const characters = [...value].length;
  if (
    characters < 1 ||
    characters > 120 ||
    Buffer.byteLength(value, 'utf8') > 240 ||
    /^\s+$/u.test(value)
  ) {
    throw invalidRequest('El nombre no es válido.');
  }
  return value;
}

export function requiredString(input: unknown, maximumBytes: number): string {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maximumBytes) {
    throw invalidRequest();
  }
  return input;
}
