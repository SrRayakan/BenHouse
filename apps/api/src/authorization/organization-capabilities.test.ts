import { describe, expect, it } from 'vitest';
import {
  GLOBAL_CAPABILITIES,
  ORGANIZATION_CAPABILITIES,
  globalCapabilities,
  organizationCapabilities,
} from './organization-capabilities';

const eligible = { status: 'ACTIVE' as const, emailVerifiedAt: new Date() };
const activeOrganization = { status: 'ACTIVE' as const };

describe('capabilities de Organization', () => {
  it('mantiene el mapa exhaustivo y el orden estable por rol', () => {
    expect(GLOBAL_CAPABILITIES).toEqual(['ORGANIZATION_CREATE']);
    expect(
      organizationCapabilities(eligible, activeOrganization, { status: 'ACTIVE', role: 'ADMIN' }),
    ).toEqual(ORGANIZATION_CAPABILITIES);
    expect(
      organizationCapabilities(eligible, activeOrganization, {
        status: 'ACTIVE',
        role: 'PROFESSIONAL_MEMBER',
      }),
    ).toEqual(['ORGANIZATION_VIEW', 'ORGANIZATION_MEMBERS_VIEW']);
  });

  it.each([
    [
      { status: 'ACTIVE' as const, emailVerifiedAt: null },
      activeOrganization,
      { status: 'ACTIVE' as const, role: 'ADMIN' as const },
    ],
    [
      { status: 'SUSPENDED' as const, emailVerifiedAt: new Date() },
      activeOrganization,
      { status: 'ACTIVE' as const, role: 'ADMIN' as const },
    ],
    [
      { status: 'DEACTIVATED' as const, emailVerifiedAt: new Date() },
      activeOrganization,
      { status: 'ACTIVE' as const, role: 'ADMIN' as const },
    ],
    [
      eligible,
      { status: 'SUSPENDED' as const },
      { status: 'ACTIVE' as const, role: 'ADMIN' as const },
    ],
    [
      eligible,
      { status: 'ARCHIVED' as const },
      { status: 'ACTIVE' as const, role: 'ADMIN' as const },
    ],
    [eligible, activeOrganization, { status: 'REVOKED' as const, role: 'ADMIN' as const }],
    [eligible, activeOrganization, { status: 'LEFT' as const, role: 'ADMIN' as const }],
    [eligible, activeOrganization, undefined],
  ])('no concede capabilities con un estado no elegible', (user, organization, membership) => {
    expect(organizationCapabilities(user, organization, membership)).toEqual([]);
  });

  it('concede la capability global solo a usuario ACTIVE y verificado', () => {
    expect(globalCapabilities(eligible)).toEqual(['ORGANIZATION_CREATE']);
    expect(globalCapabilities({ ...eligible, emailVerifiedAt: null })).toEqual([]);
    expect(globalCapabilities({ ...eligible, status: 'SUSPENDED' })).toEqual([]);
  });
});
