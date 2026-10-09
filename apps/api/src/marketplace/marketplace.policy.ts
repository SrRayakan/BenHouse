export type AuthorizationRecord = {
  authorizationType: 'OWNER' | 'MANAGER' | 'PUBLISHER';
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  validFrom: Date;
  validUntil: Date | null;
  userId: string | null;
  organizationId: string | null;
};

export type MembershipRecord = {
  organizationId: string;
  status: 'ACTIVE' | 'REVOKED' | 'LEFT';
  role: 'ADMIN' | 'PROFESSIONAL_MEMBER';
  organization: { status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' };
};

export type MarketplaceCapability =
  'PROPERTY_VIEW' | 'PROPERTY_EDIT' | 'PROPERTY_AUTHORIZE' | 'LISTING_CREATE' | 'LISTING_EDIT';

export function isAuthorizationEffective(value: AuthorizationRecord, now: Date): boolean {
  return (
    value.status === 'ACTIVE' &&
    value.validFrom <= now &&
    (!value.validUntil || value.validUntil > now)
  );
}

export function capabilitiesForProperty(
  actorUserId: string,
  authorizations: readonly AuthorizationRecord[],
  memberships: readonly MembershipRecord[],
  now: Date,
): readonly MarketplaceCapability[] {
  const effective = authorizations.filter((authorization) => {
    if (!isAuthorizationEffective(authorization, now)) return false;
    if (authorization.userId === actorUserId) return true;
    return memberships.some(
      (membership) =>
        membership.organizationId === authorization.organizationId &&
        membership.status === 'ACTIVE' &&
        membership.organization.status === 'ACTIVE',
    );
  });
  if (effective.length === 0) return [];
  const result = new Set<MarketplaceCapability>(['PROPERTY_VIEW']);
  if (effective.some(({ authorizationType }) => authorizationType !== 'PUBLISHER'))
    result.add('PROPERTY_EDIT');
  if (
    effective.some(
      ({ authorizationType, userId }) => authorizationType === 'OWNER' && userId === actorUserId,
    )
  )
    result.add('PROPERTY_AUTHORIZE');
  result.add('LISTING_CREATE');
  result.add('LISTING_EDIT');
  return [...result];
}

export function hasMarketplaceCapability(
  capabilities: readonly MarketplaceCapability[],
  required: MarketplaceCapability,
): boolean {
  return capabilities.includes(required);
}
