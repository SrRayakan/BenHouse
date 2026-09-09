import { randomBytes, randomUUID } from 'node:crypto';
import type { VersionedKeyring } from '@benhouse/config';
import { constantTimeEqual, hmacSha256, parseCanonicalBase64Url } from './crypto-encoding';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COOKIE_PATTERN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export interface SessionToken {
  selector: string;
  secret: Buffer;
  value: string;
}

export function createSessionToken(): SessionToken {
  const selector = randomUUID();
  const secret = randomBytes(32);
  return { selector, secret, value: `${selector}.${secret.toString('base64url')}` };
}

export function parseSessionToken(input: string): Omit<SessionToken, 'value'> | undefined {
  if (Buffer.byteLength(input, 'utf8') > 96) return undefined;
  const match = COOKIE_PATTERN.exec(input);
  if (!match || !UUID_PATTERN.test(match[1] ?? '')) return undefined;
  const secret = parseCanonicalBase64Url(match[2] ?? '', 32);
  return secret ? { selector: match[1]!, secret } : undefined;
}

export function sessionSecretDigest(
  selector: string,
  secret: Buffer,
  keyVersion: number,
  keyring: VersionedKeyring,
): Buffer | undefined {
  const key = keyring.keys.get(keyVersion);
  return key
    ? hmacSha256(key, 'benhouse/session-token/v1', selector.toLowerCase(), secret, keyVersion)
    : undefined;
}

export function verifySessionSecret(
  selector: string,
  secret: Buffer,
  digest: Buffer,
  keyVersion: number,
  keyring: VersionedKeyring,
): boolean {
  const expected = sessionSecretDigest(selector, secret, keyVersion, keyring) ?? Buffer.alloc(32);
  return constantTimeEqual(digest, expected);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}
