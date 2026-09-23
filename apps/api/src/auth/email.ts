import { canonicalizeEmail as canonicalizeSharedEmail } from '@benhouse/config';
import { invalidRequest } from './auth.errors';

export function canonicalizeEmail(input: unknown): string {
  try {
    return canonicalizeSharedEmail(input);
  } catch {
    throw invalidRequest('El email no es válido.');
  }
}
