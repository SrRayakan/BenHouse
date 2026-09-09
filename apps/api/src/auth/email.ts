import { domainToASCII } from 'node:url';
import { invalidRequest } from './auth.errors';

const LOCAL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function canonicalizeEmail(input: unknown): string {
  if (typeof input !== 'string') throw invalidRequest('El email no es válido.');
  const trimmed = input.trim();
  const separator = trimmed.lastIndexOf('@');
  if (separator <= 0 || separator !== trimmed.indexOf('@')) {
    throw invalidRequest('El email no es válido.');
  }
  const local = trimmed.slice(0, separator);
  const unicodeDomain = trimmed.slice(separator + 1);
  if (
    local.length > 64 ||
    !LOCAL_PATTERN.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    throw invalidRequest('El email no es válido.');
  }
  const asciiDomain = domainToASCII(unicodeDomain);
  const labels = asciiDomain.split('.');
  if (
    !asciiDomain ||
    asciiDomain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label))
  ) {
    throw invalidRequest('El email no es válido.');
  }
  const canonical = `${local}@${asciiDomain}`.toLowerCase();
  if (
    [...canonical].some((character) => (character.codePointAt(0) ?? 128) > 127) ||
    Buffer.byteLength(canonical, 'utf8') > 254
  ) {
    throw invalidRequest('El email no es válido.');
  }
  return canonical;
}
