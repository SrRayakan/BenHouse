import { createHmac, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { canonicalizeEmail, isCanonicalUuid } from './canonical-identifiers';

const DOMAIN = 'benhouse/organization-invitation-token/v1';
const CLAIM_KEYS = [
  'email',
  'generation',
  'id',
  'keyVersion',
  'organizationId',
  'purpose',
  'role',
  'subjectId',
  'subjectType',
] as const;

export type InvitationTokenClaims = {
  id: string;
  purpose: 'ORGANIZATION_INVITATION';
  generation: number;
  subjectType: 'ORGANIZATION_INVITATION';
  subjectId: string;
  organizationId: string;
  email: string;
  role: 'ADMIN' | 'PROFESSIONAL_MEMBER';
  keyVersion: number;
};

type Keyring = { keys: ReadonlyMap<number, Buffer> };

function hasExactPlainClaims(value: unknown): value is InvitationTokenClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== CLAIM_KEYS.length ||
    keys.some((key) => typeof key !== 'string') ||
    keys.map(String).sort().join(',') !== [...CLAIM_KEYS].sort().join(',')
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && 'value' in descriptor);
  });
}

function canonical(value: unknown): value is InvitationTokenClaims {
  if (!hasExactPlainClaims(value)) return false;
  const claims = value;
  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalizeEmail(claims.email);
  } catch {
    return false;
  }
  return (
    claims.purpose === 'ORGANIZATION_INVITATION' &&
    claims.subjectType === 'ORGANIZATION_INVITATION' &&
    isCanonicalUuid(claims.id) &&
    isCanonicalUuid(claims.subjectId) &&
    isCanonicalUuid(claims.organizationId) &&
    Number.isSafeInteger(claims.generation) &&
    claims.generation > 0 &&
    Number.isSafeInteger(claims.keyVersion) &&
    claims.keyVersion > 0 &&
    canonicalEmail === claims.email &&
    (claims.role === 'ADMIN' || claims.role === 'PROFESSIONAL_MEMBER')
  );
}

function lengthPrefixed(fields: readonly (string | number)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const bytes = Buffer.from(String(field), 'utf8');
    if (bytes.length > 1_048_576) throw new Error('Claim de invitación demasiado largo.');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

export function invitationTokenAuthenticator(
  claims: InvitationTokenClaims,
  keyring: Keyring,
): Buffer | undefined {
  if (!canonical(claims)) return undefined;
  const key = keyring.keys.get(claims.keyVersion);
  if (!key) return undefined;
  return createHmac('sha256', key)
    .update(
      lengthPrefixed([
        DOMAIN,
        claims.purpose,
        claims.id,
        claims.generation,
        claims.subjectType,
        claims.subjectId,
        claims.organizationId,
        claims.email,
        claims.role,
        claims.keyVersion,
      ]),
    )
    .digest();
}

export function serializeInvitationToken(claims: InvitationTokenClaims, keyring: Keyring): string {
  const authenticator = invitationTokenAuthenticator(claims, keyring);
  if (!authenticator) throw new Error('Claims o clave de invitación inválidos.');
  return `v1.${claims.id}.${authenticator.toString('base64url')}`;
}

export function verifyInvitationToken(
  authenticator: Buffer,
  claims: InvitationTokenClaims,
  keyring: Keyring,
): boolean {
  const expected = invitationTokenAuthenticator(claims, keyring) ?? Buffer.alloc(32);
  const validLength = authenticator.length === expected.length;
  const candidate = validLength ? authenticator : Buffer.alloc(32);
  return timingSafeEqual(candidate, expected) && validLength && canonical(claims);
}
