import type { OrganizationCapability } from '../authorization/organization-capabilities';

export type OrganizationDto =
  | {
      id: string;
      name: string;
      status: 'ACTIVE';
      capabilities: readonly OrganizationCapability[];
      createdAt: string;
      updatedAt: string;
    }
  | {
      id: string;
      status: 'SUSPENDED' | 'ARCHIVED';
      capabilities: [];
    };

export type MemberDto = {
  id: string;
  userId: string;
  displayName: string;
  role: 'ADMIN' | 'PROFESSIONAL_MEMBER';
  joinedAt: string;
};
