import { randomUUID } from 'node:crypto';
import type { VersionedKeyring } from '@benhouse/config';
import { constantTimeEqual, hmacSha256, parseCanonicalBase64Url } from './crypto-encoding';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXTERNAL_PATTERN = /^v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export interface AccountTokenMaterial {
  id: string;
  purpose: 'EMAIL_VERIFICATION';
  generation: number;
  subjectType: 'USER';
  subjectId: string;
  keyVersion: number;
}

export interface ParsedAccountToken {
  selector: string;
  authenticator: Buffer;
}

export function createAccountTokenMaterial(
  userId: string,
  generation: number,
  keyring: VersionedKeyring,
): { material: AccountTokenMaterial; token: string } {
  const material: AccountTokenMaterial = {
    id: randomUUID(),
    purpose: 'EMAIL_VERIFICATION',
    generation,
    subjectType: 'USER',
    subjectId: userId.toLowerCase(),
    keyVersion: keyring.currentVersion,
  };
  return { material, token: serializeAccountToken(material, keyring) };
}

export function accountTokenAuthenticator(
  material: AccountTokenMaterial,
  keyring: VersionedKeyring,
): Buffer | undefined {
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
  const authenticator = accountTokenAuthenticator(material, keyring);
  if (!authenticator) throw new Error('Versión de clave de AccountToken desconocida.');
  return `v1.${material.id.toLowerCase()}.${authenticator.toString('base64url')}`;
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
