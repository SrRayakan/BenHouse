import type { MarketplaceCapability } from './marketplace.policy';
import type { PropertyType, RentalMode } from './marketplace.input';

export type PropertyDto = {
  id: string;
  type: PropertyType;
  builtArea: string | null;
  usableArea: string | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: number | null;
  constructionYear: number | null;
  status: 'ACTIVE' | 'ARCHIVED';
  capabilities: readonly MarketplaceCapability[];
  createdAt: string;
  updatedAt: string;
};

export type PropertyAuthorizationDto = {
  id: string;
  authorizationType: 'OWNER' | 'MANAGER' | 'PUBLISHER';
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  subject: { type: 'USER'; self: boolean } | { type: 'ORGANIZATION'; organizationId: string };
  validFrom: string;
  validUntil: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type ListingDto = {
  id: string;
  propertyId: string;
  publisher: { type: 'USER'; self: boolean } | { type: 'ORGANIZATION'; organizationId: string };
  transactionType: 'SALE' | 'RENT';
  rentalMode: RentalMode | null;
  price: string;
  currency: string;
  description: string;
  availableFrom: string | null;
  availableUntil: string | null;
  status: 'DRAFT';
  createdAt: string;
  updatedAt: string;
};
