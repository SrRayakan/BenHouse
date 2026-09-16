import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  normalizeOrganizationName,
  parseNoQuery,
  parseOrganizationNameBody,
  parsePagination,
} from './organization-input';

describe('entrada de Organization', () => {
  it('normaliza NFC, trim y whitespace en ese orden', () => {
    const result = normalizeOrganizationName('  Jose\u0301\t\n  Inmobiliaria  ');
    expect(result).toBe('José Inmobiliaria');
    expect(result).toBe(result.normalize('NFC'));
  });

  it('acepta límites Unicode y rechaza exceso de caracteres o bytes UTF-8', () => {
    expect(normalizeOrganizationName('a'.repeat(160))).toHaveLength(160);
    expect(normalizeOrganizationName('🟢'.repeat(80))).toBe('🟢'.repeat(80));
    expect(() => normalizeOrganizationName('a'.repeat(161))).toThrow();
    expect(() => normalizeOrganizationName('🟢'.repeat(81))).toThrow();
    expect(() => normalizeOrganizationName(' \t\n ')).toThrow();
  });

  it.each(['status', 'role', 'createdByUserId', 'memberId', 'createdAt'])(
    'rechaza mass assignment de %s',
    (field) => expect(() => parseOrganizationNameBody({ name: 'Agencia', [field]: 'x' })).toThrow(),
  );

  it('aplica paginación acotada y rechaza query desconocida', () => {
    expect(parsePagination({})).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    expect(parsePagination({ limit: String(MAX_PAGE_LIMIT), offset: '3' })).toEqual({
      limit: MAX_PAGE_LIMIT,
      offset: 3,
    });
    expect(() => parsePagination({ limit: String(MAX_PAGE_LIMIT + 1) })).toThrow();
    expect(() => parsePagination({ cursor: 'inventado' })).toThrow();
    expect(() => parsePagination({ limit: ['1', '2'] })).toThrow();
    expect(() => parsePagination({ limit: '01' })).toThrow();
    expect(() => parsePagination({ '': '1' })).toThrow();
  });

  it('rechaza cualquier query en endpoints sin parámetros', () => {
    expect(parseNoQuery({})).toBeUndefined();
    expect(() => parseNoQuery({ extra: '1' })).toThrow();
    expect(() => parseNoQuery({ extra: ['1', '2'] })).toThrow();
  });
});
