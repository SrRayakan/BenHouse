import { describe, expect, it } from 'vitest';
import { capabilitiesForProperty, isAuthorizationEffective } from './marketplace.policy';

const now = new Date('2026-09-24T12:00:00.000Z');
const base = {
  status: 'ACTIVE' as const,
  validFrom: new Date('2026-09-23T12:00:00.000Z'),
  validUntil: null,
  userId: 'actor',
  organizationId: null,
};

describe('B1.6 marketplace policies', () => {
  it.each(['USER', 'ORGANIZATION'] as const)(
    'cancelar una autorización futura %s impide capacidades incluso tras validFrom',
    (subjectType) => {
      const validFrom = new Date(now.getTime() + 86_400_000);
      const authorization = {
        ...base,
        validFrom,
        authorizationType: 'MANAGER' as const,
        userId: subjectType === 'USER' ? 'actor' : null,
        organizationId: subjectType === 'ORGANIZATION' ? 'org' : null,
      };
      const memberships = [
        {
          organizationId: 'org',
          role: 'ADMIN' as const,
          status: 'ACTIVE' as const,
          organization: { status: 'ACTIVE' as const },
        },
      ];
      expect(capabilitiesForProperty('actor', [authorization], memberships, now)).toEqual([]);
      expect(capabilitiesForProperty('actor', [authorization], memberships, validFrom)).toContain(
        'PROPERTY_EDIT',
      );
      for (const clock of [now, validFrom, new Date(validFrom.getTime() + 86_400_000)]) {
        expect(
          capabilitiesForProperty(
            'actor',
            [{ ...authorization, status: 'REVOKED' }],
            memberships,
            clock,
          ),
        ).toEqual([]);
      }
    },
  );
  it('OWNER personal puede editar, autorizar y publicar', () => {
    expect(
      capabilitiesForProperty('actor', [{ ...base, authorizationType: 'OWNER' }], [], now),
    ).toEqual([
      'PROPERTY_VIEW',
      'PROPERTY_EDIT',
      'PROPERTY_AUTHORIZE',
      'LISTING_CREATE',
      'LISTING_EDIT',
    ]);
  });

  it('MANAGER edita y PUBLISHER solo publica/edita Listing', () => {
    expect(
      capabilitiesForProperty('actor', [{ ...base, authorizationType: 'MANAGER' }], [], now),
    ).not.toContain('PROPERTY_AUTHORIZE');
    expect(
      capabilitiesForProperty('actor', [{ ...base, authorizationType: 'PUBLISHER' }], [], now),
    ).not.toContain('PROPERTY_EDIT');
  });

  it('membership no sustituye autorización y debe seguir activa', () => {
    const authorization = {
      ...base,
      userId: null,
      organizationId: 'org',
      authorizationType: 'MANAGER' as const,
    };
    const membership = {
      organizationId: 'org',
      role: 'PROFESSIONAL_MEMBER' as const,
      status: 'ACTIVE' as const,
      organization: { status: 'ACTIVE' as const },
    };
    expect(capabilitiesForProperty('actor', [], [membership], now)).toEqual([]);
    expect(capabilitiesForProperty('actor', [authorization], [membership], now)).toContain(
      'PROPERTY_EDIT',
    );
    expect(
      capabilitiesForProperty(
        'actor',
        [authorization],
        [{ ...membership, status: 'REVOKED' }],
        now,
      ),
    ).toEqual([]);
    expect(
      capabilitiesForProperty(
        'actor',
        [authorization],
        [{ ...membership, organization: { status: 'SUSPENDED' } }],
        now,
      ),
    ).toEqual([]);
  });

  it('revocación y expiración eliminan permiso inmediatamente', () => {
    expect(isAuthorizationEffective({ ...base, authorizationType: 'OWNER' }, now)).toBe(true);
    expect(
      isAuthorizationEffective({ ...base, authorizationType: 'OWNER', status: 'REVOKED' }, now),
    ).toBe(false);
    expect(
      isAuthorizationEffective(
        {
          ...base,
          authorizationType: 'OWNER',
          validUntil: new Date('2026-09-24T12:00:00.000Z'),
        },
        now,
      ),
    ).toBe(false);
  });
});
