import { invalidRequest } from '../auth/auth.errors';
import { canonicalizeEmail } from '../auth/email';
import { exactObject, requiredString } from '../auth/input-validation';
import { parseOrganizationId } from './organization-input';

export type MemberRole = 'ADMIN' | 'PROFESSIONAL_MEMBER';

export function parseMemberRole(input: unknown): MemberRole {
  if (input !== 'ADMIN' && input !== 'PROFESSIONAL_MEMBER') throw invalidRequest();
  return input;
}

export function parseInvitationBody(input: unknown): { email: string; role: MemberRole } {
  const body = exactObject(input, ['email', 'role']);
  return { email: canonicalizeEmail(body.email), role: parseMemberRole(body.role) };
}

export function parseTokenBody(input: unknown): { token: string } {
  const body = exactObject(input, ['token']);
  return { token: requiredString(body.token, 128) };
}

export function parseRoleBody(input: unknown): { role: MemberRole } {
  const body = exactObject(input, ['role']);
  return { role: parseMemberRole(body.role) };
}

export function parseTransferBody(input: unknown): {
  targetMemberId: string;
  retainCurrentAdmin: boolean;
} {
  const body = exactObject(input, ['targetMemberId', 'retainCurrentAdmin']);
  if (typeof body.targetMemberId !== 'string' || typeof body.retainCurrentAdmin !== 'boolean') {
    throw invalidRequest();
  }
  return {
    targetMemberId: parseOrganizationId(body.targetMemberId),
    retainCurrentAdmin: body.retainCurrentAdmin,
  };
}

export function parseEmptyBody(input: unknown): void {
  if (input !== undefined) exactObject(input, []);
}
