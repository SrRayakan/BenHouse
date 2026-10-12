import { describe, expect, it } from 'vitest';
import { parsePropertyLocation } from './location.input';

const valid = { locationId: '01234567-89ab-4cde-8fab-0123456789ab', expectedVersion: 0 };

describe('C1.1 entrada de ubicación', () => {
  it('normaliza dirección estructurada y borra datos omitidos', () => {
    expect(
      parsePropertyLocation({
        ...valid,
        streetName: '  Vía sintética  ',
        streetNumber: 'S/N',
        coordinates: { latitude: 0, longitude: 0 },
      }),
    ).toEqual({
      ...valid,
      streetName: 'Vía sintética',
      streetNumber: 'S/N',
      addressUnit: null,
      postalCode: null,
      coordinates: { latitude: 0, longitude: 0 },
    });
    expect(parsePropertyLocation(valid).coordinates).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    { ...valid, locationId: null },
    { ...valid, locationId: 'texto' },
    { ...valid, userId: valid.locationId },
    { ...valid, provinceId: valid.locationId },
    { ...valid, expectedVersion: -1 },
    { ...valid, expectedVersion: '0' },
    { ...valid, expectedVersion: 0.5 },
    { ...valid, expectedVersion: 2147483647 },
    { ...valid, streetName: '' },
    { ...valid, streetName: 'x'.repeat(161) },
    { ...valid, streetName: 'a\u0000b' },
    { ...valid, streetName: 'a\u200bb' },
    { ...valid, streetNumber: '1' },
    { ...valid, addressUnit: '2A' },
    { ...valid, postalCode: 12345 },
    { ...valid, coordinates: {} },
    ...[NaN, Infinity, -91, 91, '40'].map((latitude) => ({
      ...valid,
      coordinates: { latitude, longitude: 0 },
    })),
    ...[NaN, Infinity, -181, 181, '0'].map((longitude) => ({
      ...valid,
      coordinates: { latitude: 0, longitude },
    })),
    { ...valid, coordinates: { latitude: 0, longitude: 0, altitude: 1 } },
  ])('rechaza payload inválido %#', (input) => {
    expect(() => parsePropertyLocation(input)).toThrow();
  });
});
