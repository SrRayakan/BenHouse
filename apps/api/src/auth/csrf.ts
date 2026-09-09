import type { VersionedKeyring } from '@benhouse/config';
import { constantTimeEqual, hmacSha256, parseCanonicalBase64Url } from './crypto-encoding';

export function deriveCsrfToken(
  sessionId: string,
  issuedSessionVersion: number,
  keyring: VersionedKeyring,
): string {
  const version = keyring.currentVersion;
  const key = keyring.keys.get(version);
  if (!key) throw new Error('Versión CSRF actual desconocida.');
  const tag = hmacSha256(
    key,
    'benhouse/csrf/v1',
    sessionId.toLowerCase(),
    issuedSessionVersion,
    version,
  );
  return `${version}.${tag.toString('base64url')}`;
}

export function verifyCsrfToken(
  token: string,
  sessionId: string,
  issuedSessionVersion: number,
  keyring: VersionedKeyring,
): boolean {
  const match = /^(\d+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  const version = Number(match?.[1]);
  const supplied = parseCanonicalBase64Url(match?.[2] ?? '', 32) ?? Buffer.alloc(32);
  const key = keyring.keys.get(version);
  const expected = key
    ? hmacSha256(key, 'benhouse/csrf/v1', sessionId.toLowerCase(), issuedSessionVersion, version)
    : Buffer.alloc(32);
  return Boolean(match && key && constantTimeEqual(supplied, expected));
}
