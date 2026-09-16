export const GLOBAL_CAPABILITIES = ['ORGANIZATION_CREATE'] as const;

export const ORGANIZATION_CAPABILITIES = [
  'ORGANIZATION_VIEW',
  'ORGANIZATION_MANAGE',
  'ORGANIZATION_MEMBERS_VIEW',
  'ORGANIZATION_MEMBERS_MANAGE',
  'ORGANIZATION_ADMIN_TRANSFER',
] as const;

export type GlobalCapability = (typeof GLOBAL_CAPABILITIES)[number];
export type OrganizationCapability = (typeof ORGANIZATION_CAPABILITIES)[number];
export type UserAuthorizationState = {
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  emailVerifiedAt: Date | null;
};
export type OrganizationAuthorizationState = { status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' };
export type MembershipAuthorizationState = {
  status: 'ACTIVE' | 'REVOKED' | 'LEFT';
  role: 'ADMIN' | 'PROFESSIONAL_MEMBER';
};

const ROLE_CAPABILITIES: Readonly<
  Record<MembershipAuthorizationState['role'], readonly OrganizationCapability[]>
> = {
  ADMIN: ORGANIZATION_CAPABILITIES,
  PROFESSIONAL_MEMBER: ['ORGANIZATION_VIEW', 'ORGANIZATION_MEMBERS_VIEW'],
};

export function globalCapabilities(user: UserAuthorizationState): readonly GlobalCapability[] {
  return user.status === 'ACTIVE' && user.emailVerifiedAt !== null ? GLOBAL_CAPABILITIES : [];
}

export function organizationCapabilities(
  user: UserAuthorizationState,
  organization: OrganizationAuthorizationState,
  membership: MembershipAuthorizationState | undefined,
): readonly OrganizationCapability[] {
  if (
    globalCapabilities(user).length === 0 ||
    organization.status !== 'ACTIVE' ||
    membership?.status !== 'ACTIVE'
  ) {
    return [];
  }
  return ROLE_CAPABILITIES[membership.role];
}

export function hasOrganizationCapability(
  capabilities: readonly OrganizationCapability[],
  required: OrganizationCapability,
): boolean {
  return capabilities.includes(required);
}
