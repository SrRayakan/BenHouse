import { invalidRequest } from '../auth/auth.errors';
import { exactObject } from '../auth/input-validation';
import { parseUuid } from './marketplace.input';

export type PropertyLocationWrite = {
  expectedVersion: number;
  locationId: string;
  streetName: string | null;
  streetNumber: string | null;
  addressUnit: string | null;
  postalCode: string | null;
  coordinates: { latitude: number; longitude: number } | null;
};

// Reemplazo completo: los campos privados omitidos se borran al cambiar de ubicación.
export function parsePropertyLocation(input: unknown): PropertyLocationWrite {
  const body = exactObject(input, [
    'expectedVersion',
    'locationId',
    'streetName',
    'streetNumber',
    'addressUnit',
    'postalCode',
    'coordinates',
  ]);
  if (typeof body.locationId !== 'string') throw invalidRequest();
  if (
    !Number.isInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0 ||
    (body.expectedVersion as number) >= 2147483647
  )
    throw invalidRequest();
  let coordinates: PropertyLocationWrite['coordinates'] = null;
  if (body.coordinates !== undefined && body.coordinates !== null) {
    const point = exactObject(body.coordinates, ['latitude', 'longitude']);
    if (
      typeof point.latitude !== 'number' ||
      !Number.isFinite(point.latitude) ||
      Math.abs(point.latitude) > 90 ||
      typeof point.longitude !== 'number' ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.longitude) > 180
    )
      throw invalidRequest();
    coordinates = { latitude: point.latitude, longitude: point.longitude };
  }
  const result = {
    expectedVersion: body.expectedVersion as number,
    locationId: parseUuid(body.locationId),
    streetName: text(body.streetName, 160),
    streetNumber: text(body.streetNumber, 24),
    addressUnit: text(body.addressUnit, 80),
    postalCode: text(body.postalCode, 16),
    coordinates,
  };
  if ((result.streetNumber || result.addressUnit) && !result.streetName) throw invalidRequest();
  return result;
}

function text(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidRequest();
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum || /[\p{Cc}\p{Cf}]/u.test(normalized))
    throw invalidRequest();
  return normalized;
}
