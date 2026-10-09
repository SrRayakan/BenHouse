import { invalidRequest } from '../auth/auth.errors';
import { exactObject } from '../auth/input-validation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROPERTY_TYPES = [
  'APARTMENT',
  'HOUSE',
  'TOWNHOUSE',
  'PENTHOUSE',
  'DUPLEX',
  'STUDIO',
  'LAND',
  'COMMERCIAL',
  'OTHER',
] as const;
const RENTAL_MODES = ['LONG_TERM', 'SEASONAL', 'VACATION', 'ROOM'] as const;
const AUTHORIZATION_TYPES = ['MANAGER', 'PUBLISHER'] as const;
const PROPERTY_FIELDS = [
  'type',
  'builtArea',
  'usableArea',
  'rooms',
  'bathrooms',
  'floor',
  'constructionYear',
] as const;
const LISTING_FIELDS = [
  'transactionType',
  'rentalMode',
  'price',
  'currency',
  'description',
  'availableFrom',
  'availableUntil',
] as const;

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export type PropertyType = (typeof PROPERTY_TYPES)[number];
export type RentalMode = (typeof RENTAL_MODES)[number];
export type PropertyWrite = {
  type?: PropertyType;
  builtArea?: string | null;
  usableArea?: string | null;
  rooms?: number | null;
  bathrooms?: number | null;
  floor?: number | null;
  constructionYear?: number | null;
};
export type ListingWrite = {
  transactionType?: 'SALE' | 'RENT';
  rentalMode?: RentalMode | null;
  price?: string;
  currency?: string;
  description?: string;
  availableFrom?: Date | null;
  availableUntil?: Date | null;
};

export function parseNoQuery(input: unknown): void {
  exactObject(input, []);
}

export function parseUuid(input: string): string {
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

export function parsePropertyCreate(
  input: unknown,
): Required<Pick<PropertyWrite, 'type'>> & PropertyWrite {
  const body = exactObject(input, PROPERTY_FIELDS);
  if (body.type === undefined) throw invalidRequest();
  return parsePropertyFields(body) as Required<Pick<PropertyWrite, 'type'>> & PropertyWrite;
}

export function parsePropertyPatch(input: unknown): PropertyWrite {
  const body = exactObject(input, PROPERTY_FIELDS);
  if (Object.keys(body).length === 0) throw invalidRequest();
  return parsePropertyFields(body);
}

export function parseAuthorizationGrant(input: unknown): {
  authorizationType: 'MANAGER' | 'PUBLISHER';
  userId?: string;
  organizationId?: string;
  validFrom?: Date;
  validUntil?: Date;
} {
  const body = exactObject(input, [
    'authorizationType',
    'userId',
    'organizationId',
    'validFrom',
    'validUntil',
  ]);
  if (!AUTHORIZATION_TYPES.includes(body.authorizationType as never)) throw invalidRequest();
  const userId = body.userId === undefined ? undefined : parseUuidValue(body.userId);
  const organizationId =
    body.organizationId === undefined ? undefined : parseUuidValue(body.organizationId);
  if ((userId === undefined) === (organizationId === undefined)) throw invalidRequest();
  const validFrom = body.validFrom === undefined ? undefined : parseInstant(body.validFrom);
  const validUntil = body.validUntil === undefined ? undefined : parseInstant(body.validUntil);
  if (validFrom && validUntil && validUntil <= validFrom) throw invalidRequest();
  return {
    authorizationType: body.authorizationType as 'MANAGER' | 'PUBLISHER',
    ...(userId ? { userId } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
  };
}

export function parseEmptyBody(input: unknown): void {
  if (input !== undefined) exactObject(input, []);
}

export function parseListingCreate(input: unknown): {
  propertyId: string;
  organizationId?: string;
} & Required<Pick<ListingWrite, 'transactionType' | 'price' | 'currency' | 'description'>> &
  ListingWrite {
  const body = exactObject(input, ['propertyId', 'organizationId', ...LISTING_FIELDS]);
  for (const field of ['propertyId', 'transactionType', 'price', 'currency', 'description']) {
    if (body[field] === undefined) throw invalidRequest();
  }
  const listing = parseListingFields(body);
  validateRentalCombination(listing);
  if (listing.availableUntil && !listing.availableFrom) throw invalidRequest();
  return {
    propertyId: parseUuidValue(body.propertyId),
    ...(body.organizationId === undefined
      ? {}
      : { organizationId: parseUuidValue(body.organizationId) }),
    ...(listing as Required<
      Pick<ListingWrite, 'transactionType' | 'price' | 'currency' | 'description'>
    > &
      ListingWrite),
  };
}

export function parseListingPatch(input: unknown): ListingWrite {
  const body = exactObject(input, LISTING_FIELDS);
  if (Object.keys(body).length === 0) throw invalidRequest();
  return parseListingFields(body);
}

export function validateRentalCombination(input: ListingWrite): void {
  if (
    input.transactionType === 'SALE' &&
    input.rentalMode !== null &&
    input.rentalMode !== undefined
  )
    throw invalidRequest();
  if (input.transactionType === 'RENT' && !input.rentalMode) throw invalidRequest();
}

function parsePropertyFields(body: Record<string, unknown>): PropertyWrite {
  const result: PropertyWrite = {};
  if ('type' in body) {
    if (!PROPERTY_TYPES.includes(body.type as never)) throw invalidRequest();
    result.type = body.type as PropertyType;
  }
  if ('builtArea' in body) result.builtArea = nullableDecimal(body.builtArea, 8);
  if ('usableArea' in body) result.usableArea = nullableDecimal(body.usableArea, 8);
  if ('rooms' in body) result.rooms = nullableInteger(body.rooms, 0, 32767);
  if ('bathrooms' in body) result.bathrooms = nullableInteger(body.bathrooms, 0, 32767);
  if ('floor' in body) result.floor = nullableInteger(body.floor, -20, 300);
  if ('constructionYear' in body)
    result.constructionYear = nullableInteger(body.constructionYear, 1000, 2200);
  if (
    result.builtArea &&
    result.usableArea &&
    compareDecimal(result.usableArea, result.builtArea) > 0
  )
    throw invalidRequest();
  return result;
}

function parseListingFields(body: Record<string, unknown>): ListingWrite {
  const result: ListingWrite = {};
  if ('transactionType' in body) {
    if (body.transactionType !== 'SALE' && body.transactionType !== 'RENT') throw invalidRequest();
    result.transactionType = body.transactionType;
  }
  if ('rentalMode' in body) {
    if (body.rentalMode !== null && !RENTAL_MODES.includes(body.rentalMode as never))
      throw invalidRequest();
    result.rentalMode = body.rentalMode as RentalMode | null;
  }
  if ('price' in body) result.price = positiveDecimal(body.price, 16);
  if ('currency' in body) result.currency = canonicalCurrency(body.currency);
  if ('description' in body) result.description = description(body.description);
  if ('availableFrom' in body)
    result.availableFrom = body.availableFrom === null ? null : parseInstant(body.availableFrom);
  if ('availableUntil' in body)
    result.availableUntil = body.availableUntil === null ? null : parseInstant(body.availableUntil);
  if (
    result.availableFrom &&
    result.availableUntil &&
    result.availableUntil <= result.availableFrom
  )
    throw invalidRequest();
  return result;
}

function positiveDecimal(input: unknown, maximumIntegerDigits: number): string {
  if (typeof input !== 'string') throw invalidRequest();
  const pattern = new RegExp(`^(0|[1-9]\\d{0,${maximumIntegerDigits - 1}})(?:\\.(\\d{1,2}))?$`);
  const match = pattern.exec(input);
  if (!match || /^0(?:\.0{1,2})?$/.test(input)) throw invalidRequest();
  return `${input.split('.')[0]}.${(match[2] ?? '').padEnd(2, '0')}`;
}

function nullableDecimal(input: unknown, maximumIntegerDigits: number): string | null {
  return input === null ? null : positiveDecimal(input, maximumIntegerDigits);
}

function canonicalCurrency(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Z]{3}$/.test(input)) throw invalidRequest();
  if (!Intl.supportedValuesOf('currency').includes(input)) throw invalidRequest();
  return input;
}

function description(input: unknown): string {
  if (typeof input !== 'string') throw invalidRequest();
  const value = input.normalize('NFC').trim();
  if ([...value].length < 1 || [...value].length > 5000 || Buffer.byteLength(value) > 10000)
    throw invalidRequest();
  return value;
}

function parseInstant(input: unknown): Date {
  if (
    typeof input !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input)
  )
    throw invalidRequest();
  const value = new Date(input);
  if (Number.isNaN(value.getTime())) throw invalidRequest();
  const [whole, fraction = ''] = input.slice(0, -1).split('.');
  if (value.toISOString() !== `${whole}.${fraction.padEnd(3, '0')}Z`) throw invalidRequest();
  return value;
}

function parseUuidValue(input: unknown): string {
  if (typeof input !== 'string') throw invalidRequest();
  return parseUuid(input);
}

function nullableInteger(input: unknown, minimum: number, maximum: number): number | null {
  if (input === null) return null;
  if (!Number.isInteger(input) || (input as number) < minimum || (input as number) > maximum)
    throw invalidRequest();
  return input as number;
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

function compareDecimal(left: string, right: string): number {
  const minor = (value: string) => BigInt(value.replace('.', ''));
  return minor(left) < minor(right) ? -1 : minor(left) > minor(right) ? 1 : 0;
}
