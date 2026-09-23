import { randomUUID } from 'node:crypto';
import { invitationTokenAuthenticator, serializeInvitationToken } from '@benhouse/config';
import type { InvitationTokenClaims, VersionedKeyring } from '@benhouse/config';
import { constantTimeEqual, hmacSha256, parseCanonicalBase64Url } from './crypto-encoding';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXTERNAL_PATTERN = /^v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export interface AccountTokenMaterial {
  id: string;
  purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'ORGANIZATION_INVITATION';
  generation: number;
  subjectType: 'USER' | 'ORGANIZATION_INVITATION';
  subjectId: string;
  keyVersion: number;
  organizationId?: string;
  email?: string;
  role?: 'ADMIN' | 'PROFESSIONAL_MEMBER';
}

export interface ParsedAccountToken {
  selector: string;
  authenticator: Buffer;
}

export function createAccountTokenMaterial(
  userId: string,
  generation: number,
  keyring: VersionedKeyring,
  purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' = 'EMAIL_VERIFICATION',
): { material: AccountTokenMaterial; token: string } {
  const material: AccountTokenMaterial = {
    id: randomUUID(),
    purpose,
    generation,
    subjectType: 'USER',
    subjectId: userId.toLowerCase(),
    keyVersion: keyring.currentVersion,
  };
  return { material, token: serializeAccountToken(material, keyring) };
}

export function createInvitationTokenMaterial(
  invitationId: string,
  generation: number,
  keyring: VersionedKeyring,
  claims: Pick<InvitationTokenClaims, 'organizationId' | 'email' | 'role'>,
): { material: AccountTokenMaterial; token: string } {
  const material: AccountTokenMaterial = {
    id: randomUUID(),
    purpose: 'ORGANIZATION_INVITATION',
    generation,
    subjectType: 'ORGANIZATION_INVITATION',
    subjectId: invitationId.toLowerCase(),
    keyVersion: keyring.currentVersion,
    organizationId: claims.organizationId,
    email: claims.email,
    role: claims.role,
  };
  return { material, token: serializeAccountToken(material, keyring) };
}

export function accountTokenAuthenticator(
  material: AccountTokenMaterial,
  keyring: VersionedKeyring,
): Buffer | undefined {
  if (material.purpose === 'ORGANIZATION_INVITATION') {
    const claims = invitationClaims(material);
    return claims ? invitationTokenAuthenticator(claims, keyring) : undefined;
  }
  const key = keyring.keys.get(material.keyVersion);
  if (!key) return undefined;
  return hmacSha256(
    key,
    'benhouse/account-token/v1',
    material.purpose,
    material.id.toLowerCase(),
    material.generation,
    material.subjectType,
    material.subjectId.toLowerCase(),
    material.keyVersion,
  );
}

export function serializeAccountToken(
  material: AccountTokenMaterial,
  keyring: VersionedKeyring,
): string {
  if (material.purpose === 'ORGANIZATION_INVITATION') {
    const claims = invitationClaims(material);
    if (!claims) throw new Error('Claims de invitación incompletos.');
    return serializeInvitationToken(claims, keyring);
  }
  const authenticator = accountTokenAuthenticator(material, keyring);
  if (!authenticator) throw new Error('Versión de clave de AccountToken desconocida.');
  return `v1.${material.id.toLowerCase()}.${authenticator.toString('base64url')}`;
}

function invitationClaims(material: AccountTokenMaterial): InvitationTokenClaims | undefined {
  if (
    material.purpose !== 'ORGANIZATION_INVITATION' ||
    material.subjectType !== 'ORGANIZATION_INVITATION' ||
    !material.organizationId ||
    !material.email ||
    !material.role
  )
    return undefined;
  return {
    id: material.id,
    purpose: material.purpose,
    generation: material.generation,
    subjectType: material.subjectType,
    subjectId: material.subjectId,
    organizationId: material.organizationId,
    email: material.email,
    role: material.role,
    keyVersion: material.keyVersion,
  };
}

export function parseAccountToken(input: string): ParsedAccountToken | undefined {
  if (Buffer.byteLength(input, 'utf8') > 128) return undefined;
  const match = EXTERNAL_PATTERN.exec(input);
  if (!match || !UUID_PATTERN.test(match[1] ?? '')) return undefined;
  const authenticator = parseCanonicalBase64Url(match[2] ?? '', 32);
  return authenticator ? { selector: match[1]!, authenticator } : undefined;
}

export function verifyAccountTokenAuthenticator(
  parsed: ParsedAccountToken,
  material: AccountTokenMaterial,
  keyring: VersionedKeyring,
): boolean {
  const expected = accountTokenAuthenticator(material, keyring) ?? Buffer.alloc(32);
  return constantTimeEqual(parsed.authenticator, expected);
}
