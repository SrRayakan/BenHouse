import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseEmptyBody,
  parseInvitationBody,
  parseRoleBody,
  parseTokenBody,
  parseTransferBody,
} from './organization-administration.input';
import { isInvitationGenerationConflict } from './organization-administration.service';

describe('DTO B1.5 y conflictos clasificados', () => {
  it('canoniza email y rechaza mass assignment en invitaciones', () => {
    expect(parseInvitationBody({ email: ' Recipient@Example.Test ', role: 'ADMIN' })).toEqual({
      email: 'recipient@example.test',
      role: 'ADMIN',
    });
    expect(() =>
      parseInvitationBody({ email: 'a@example.test', role: 'ADMIN', userId: randomUUID() }),
    ).toThrow();
  });

  it('rechaza roles, tokens y transferencias malformadas', () => {
    expect(() => parseRoleBody({ role: 'OWNER' })).toThrow();
    expect(() => parseTokenBody({ token: 'x', actorUserId: randomUUID() })).toThrow();
    expect(() => parseTransferBody({ targetMemberId: randomUUID() })).toThrow();
    expect(() =>
      parseTransferBody({ targetMemberId: randomUUID(), retainCurrentAdmin: 'false' }),
    ).toThrow();
    expect(
      parseTransferBody({ targetMemberId: randomUUID(), retainCurrentAdmin: false }),
    ).toMatchObject({ retainCurrentAdmin: false });
  });

  it('admite ausencia de body vacío, pero nunca campos extras', () => {
    expect(() => parseEmptyBody(undefined)).not.toThrow();
    expect(() => parseEmptyBody({})).not.toThrow();
    expect(() => parseEmptyBody({ actorId: randomUUID() })).toThrow();
  });

  it('solo reintenta P2002 del índice de generación de invitación', () => {
    expect(
      isInvitationGenerationConflict({
        code: 'P2002',
        meta: {
          modelName: 'AccountToken',
          target: ['purpose', 'organization_invitation_id', 'generation'],
        },
      }),
    ).toBe(true);
    expect(
      isInvitationGenerationConflict({
        code: 'P2002',
        meta: {
          modelName: 'AccountToken',
          target: ['purpose', 'user_id', 'generation'],
        },
      }),
    ).toBe(false);
    expect(
      isInvitationGenerationConflict({
        code: 'P2002',
        meta: {
          modelName: 'OrganizationInvitation',
          target: ['organization_id', 'email'],
        },
      }),
    ).toBe(false);
  });
});
