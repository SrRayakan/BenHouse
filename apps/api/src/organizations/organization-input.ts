import { invalidRequest } from '../auth/auth.errors';
import { exactObject } from '../auth/input-validation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export function parseNoQuery(input: unknown): void {
  exactObject(input, []);
}

export function parseOrganizationNameBody(input: unknown): { name: string } {
  const body = exactObject(input, ['name']);
  return { name: normalizeOrganizationName(body.name) };
}

export function normalizeOrganizationName(input: unknown): string {
  if (typeof input !== 'string') throw invalidRequest('El nombre de la organización no es válido.');
  const value = input.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const characters = [...value].length;
  if (characters < 1 || characters > 160 || Buffer.byteLength(value, 'utf8') > 320) {
    throw invalidRequest('El nombre de la organización no es válido.');
  }
  return value;
}

export function parseOrganizationId(input: string): string {
  if (!UUID_PATTERN.test(input)) throw invalidRequest('El identificador no es válido.');
  return input;
}

export function parsePagination(input: unknown): { limit: number; offset: number } {
  const query = exactObject(input, ['limit', 'offset']);
  return {
    limit: boundedInteger(query.limit, DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT),
    offset: boundedInteger(query.offset, 0, 0, 10_000),
  };
}

function boundedInteger(
  input: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (input === undefined) return fallback;
  if (typeof input !== 'string' || !/^(0|[1-9]\d*)$/.test(input)) throw invalidRequest();
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidRequest();
  return value;
}
