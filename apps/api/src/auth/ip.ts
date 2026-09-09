import { isIP } from 'node:net';

export function canonicalizeIp(input: string): string | undefined {
  let value = input.trim().toLowerCase();
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6 || value.includes('%')) return undefined;
  try {
    const hostname = new URL(`http://[${value}]`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return undefined;
  }
}
