import { describe, expect, it } from 'vitest';
import {
  parseAuthorizationGrant,
  parseListingCreate,
  parseListingPatch,
  parsePagination,
  parsePropertyCreate,
  parsePropertyPatch,
  parseUuid,
} from './marketplace.input';

describe('B1.6 marketplace input estricto', () => {
  it.each([undefined, null])('rechaza crear disponibilidad sin inicio (%s)', (availableFrom) => {
    expect(() =>
      parseListingCreate({
        propertyId: '11111111-1111-4111-8111-111111111111',
        transactionType: 'SALE',
        price: '1000',
        currency: 'EUR',
        description: 'Vivienda sintética',
        ...(availableFrom === undefined ? {} : { availableFrom }),
        availableUntil: '2027-03-31T00:00:00Z',
      }),
    ).toThrow();
  });

  it.each([
    ['2027-02-28T00:00:00Z', '2027-02-28T00:00:00.000Z'],
    ['2028-02-29T23:59:59.1Z', '2028-02-29T23:59:59.100Z'],
    ['2000-02-29T12:34:56.12Z', '2000-02-29T12:34:56.120Z'],
    ['2027-04-30T12:34:56.123Z', '2027-04-30T12:34:56.123Z'],
  ])('acepta calendario UTC válido %s', (input, canonical) => {
    expect(parseListingPatch({ availableFrom: input }).availableFrom?.toISOString()).toBe(
      canonical,
    );
    expect(parseListingPatch({ availableUntil: input }).availableUntil?.toISOString()).toBe(
      canonical,
    );
    expect(
      parseAuthorizationGrant({
        authorizationType: 'MANAGER',
        userId: '11111111-1111-4111-8111-111111111111',
        validFrom: input,
      }).validFrom?.toISOString(),
    ).toBe(canonical);
  });

  it.each([
    '2027-02-29T00:00:00Z',
    '2027-02-30T00:00:00Z',
    '2028-02-30T00:00:00.12Z',
    '2100-02-29T00:00:00Z',
    '2027-04-31T00:00:00Z',
    '2027-01-00T00:00:00Z',
    '2027-13-01T00:00:00Z',
    '2027-02-28T24:00:00Z',
    '2027-02-28T00:00:00+00:00',
    '2027-02-28T00:00:00.1234Z',
  ])('rechaza calendario o sintaxis UTC inválidos %s', (input) => {
    expect(() => parseListingPatch({ availableFrom: input })).toThrow();
    expect(() => parseListingPatch({ availableUntil: input })).toThrow();
    expect(() =>
      parseAuthorizationGrant({
        authorizationType: 'MANAGER',
        userId: '11111111-1111-4111-8111-111111111111',
        validUntil: input,
      }),
    ).toThrow();
  });

  it.each([
    'APARTMENT',
    'HOUSE',
    'TOWNHOUSE',
    'PENTHOUSE',
    'DUPLEX',
    'STUDIO',
    'LAND',
    'COMMERCIAL',
    'OTHER',
  ])('acepta el tipo Property %s', (type) => {
    expect(parsePropertyCreate({ type })).toMatchObject({ type });
  });

  it('normaliza decimales seguros y rechaza Float, campos internos y áreas incoherentes', () => {
    expect(parsePropertyCreate({ type: 'HOUSE', builtArea: '120.5' })).toMatchObject({
      builtArea: '120.50',
    });
    expect(() => parsePropertyCreate({ type: 'HOUSE', builtArea: 120.5 })).toThrow();
    expect(() => parsePropertyCreate({ type: 'HOUSE', status: 'ARCHIVED' })).toThrow();
    expect(() =>
      parsePropertyCreate({ type: 'HOUSE', builtArea: '80', usableArea: '81' }),
    ).toThrow();
    expect(() => parsePropertyPatch({})).toThrow();
  });

  it.each([
    [{ transactionType: 'SALE', rentalMode: 'LONG_TERM' }],
    [{ transactionType: 'RENT', rentalMode: null }],
    [{ transactionType: 'RENT' }],
  ])('rechaza combinación SALE/RENT inválida', (partial) => {
    expect(() =>
      parseListingCreate({
        propertyId: '11111111-1111-4111-8111-111111111111',
        price: '1000.00',
        currency: 'EUR',
        description: 'Vivienda sintética',
        ...partial,
      }),
    ).toThrow();
  });

  it.each(['LONG_TERM', 'SEASONAL', 'VACATION', 'ROOM'])('acepta RENT %s', (rentalMode) => {
    expect(
      parseListingCreate({
        propertyId: '11111111-1111-4111-8111-111111111111',
        transactionType: 'RENT',
        rentalMode,
        price: '1200',
        currency: 'EUR',
        description: 'Alquiler sintético',
      }),
    ).toMatchObject({ price: '1200.00', rentalMode });
  });

  it('valida precio, moneda, fechas y mass assignment de Listing', () => {
    expect(() => parseListingPatch({ price: 1 })).toThrow();
    expect(() => parseListingPatch({ price: '0.00' })).toThrow();
    expect(() => parseListingPatch({ price: '1.001' })).toThrow();
    expect(() => parseListingPatch({ currency: 'eur' })).toThrow();
    expect(() => parseListingPatch({ currency: 'ZZZ' })).toThrow();
    expect(() => parseListingPatch({ status: 'PUBLISHED' })).toThrow();
    expect(() => parseListingPatch({ publisherUserId: crypto.randomUUID() })).toThrow();
    expect(() => parseListingPatch({ availableUntil: '2026-01-01T00:00:00Z' })).not.toThrow();
  });

  it('exige subject XOR y prohíbe conceder OWNER', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(() => parseAuthorizationGrant({ authorizationType: 'OWNER', userId: id })).toThrow();
    expect(() => parseAuthorizationGrant({ authorizationType: 'MANAGER' })).toThrow();
    expect(() =>
      parseAuthorizationGrant({ authorizationType: 'MANAGER', userId: id, organizationId: id }),
    ).toThrow();
    expect(parseAuthorizationGrant({ authorizationType: 'PUBLISHER', userId: id })).toMatchObject({
      userId: id,
    });
  });

  it('aplica UUID canónico y paginación allowlisted', () => {
    expect(parseUuid('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(() => parseUuid('11111111-1111-4111-8111-11111111111A')).toThrow();
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({ limit: '100', offset: '10000' })).toEqual({
      limit: 100,
      offset: 10000,
    });
    expect(() => parsePagination({ limit: ['1', '2'] })).toThrow();
    expect(() => parsePagination({ limit: '101' })).toThrow();
    expect(() => parsePagination({ offset: '10001' })).toThrow();
    expect(() => parsePagination({ orderBy: 'createdAt' })).toThrow();
  });
});
