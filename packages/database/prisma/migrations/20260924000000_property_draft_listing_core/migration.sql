-- B1.6 Property & Draft Listing Core.

CREATE TYPE "PropertyType" AS ENUM (
  'APARTMENT', 'HOUSE', 'TOWNHOUSE', 'PENTHOUSE', 'DUPLEX',
  'STUDIO', 'LAND', 'COMMERCIAL', 'OTHER'
);
CREATE TYPE "PropertyStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "PropertyAuthorizationType" AS ENUM ('OWNER', 'MANAGER', 'PUBLISHER');
CREATE TYPE "PropertyAuthorizationStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
CREATE TYPE "ListingTransactionType" AS ENUM ('SALE', 'RENT');
CREATE TYPE "ListingRentalMode" AS ENUM ('LONG_TERM', 'SEASONAL', 'VACATION', 'ROOM');
CREATE TYPE "ListingStatus" AS ENUM (
  'DRAFT', 'UNDER_REVIEW', 'PUBLISHED', 'PAUSED', 'RESERVED',
  'IN_OPERATION', 'CLOSED', 'REJECTED', 'WITHDRAWN'
);

CREATE TABLE "property" (
  "id" UUID NOT NULL,
  "type" "PropertyType" NOT NULL,
  "built_area" DECIMAL(10,2),
  "usable_area" DECIMAL(10,2),
  "rooms" SMALLINT,
  "bathrooms" SMALLINT,
  "floor" SMALLINT,
  "construction_year" SMALLINT,
  "status" "PropertyStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "property_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "property_built_area_chk" CHECK ("built_area" IS NULL OR "built_area" > 0),
  CONSTRAINT "property_usable_area_chk" CHECK ("usable_area" IS NULL OR "usable_area" > 0),
  CONSTRAINT "property_area_order_chk" CHECK (
    "built_area" IS NULL OR "usable_area" IS NULL OR "usable_area" <= "built_area"
  ),
  CONSTRAINT "property_rooms_chk" CHECK ("rooms" IS NULL OR "rooms" >= 0),
  CONSTRAINT "property_bathrooms_chk" CHECK ("bathrooms" IS NULL OR "bathrooms" >= 0),
  CONSTRAINT "property_floor_chk" CHECK ("floor" IS NULL OR "floor" BETWEEN -20 AND 300),
  CONSTRAINT "property_construction_year_chk" CHECK (
    "construction_year" IS NULL OR "construction_year" BETWEEN 1000 AND 2200
  )
);

CREATE TABLE "property_authorization" (
  "id" UUID NOT NULL,
  "property_id" UUID NOT NULL,
  "user_id" UUID,
  "organization_id" UUID,
  "authorization_type" "PropertyAuthorizationType" NOT NULL,
  "status" "PropertyAuthorizationStatus" NOT NULL DEFAULT 'ACTIVE',
  "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_until" TIMESTAMPTZ(3),
  "granted_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  CONSTRAINT "property_authorization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "property_authorization_subject_xor_chk" CHECK (
    ("user_id" IS NOT NULL) <> ("organization_id" IS NOT NULL)
  ),
  CONSTRAINT "property_authorization_validity_chk" CHECK (
    "valid_until" IS NULL OR "valid_until" > "valid_from"
  ),
  CONSTRAINT "property_authorization_state_chk" CHECK (
    ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL AND "revoked_at" >= "valid_from")
    OR
    ("status" IN ('ACTIVE', 'EXPIRED') AND "revoked_at" IS NULL)
  )
);

CREATE TABLE "listing" (
  "id" UUID NOT NULL,
  "property_id" UUID NOT NULL,
  "publisher_user_id" UUID,
  "publisher_organization_id" UUID,
  "responsible_member_user_id" UUID,
  "transaction_type" "ListingTransactionType" NOT NULL,
  "rental_mode" "ListingRentalMode",
  "price" DECIMAL(18,2) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "description" TEXT NOT NULL,
  "available_from" TIMESTAMPTZ(3),
  "available_until" TIMESTAMPTZ(3),
  "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "listing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "listing_publisher_xor_chk" CHECK (
    ("publisher_user_id" IS NOT NULL) <> ("publisher_organization_id" IS NOT NULL)
  ),
  CONSTRAINT "listing_responsible_member_chk" CHECK (
    ("publisher_organization_id" IS NOT NULL AND "responsible_member_user_id" IS NOT NULL)
    OR
    ("publisher_organization_id" IS NULL AND "responsible_member_user_id" IS NULL)
  ),
  CONSTRAINT "listing_rental_mode_chk" CHECK (
    ("transaction_type" = 'RENT' AND "rental_mode" IS NOT NULL)
    OR
    ("transaction_type" = 'SALE' AND "rental_mode" IS NULL)
  ),
  CONSTRAINT "listing_price_chk" CHECK ("price" > 0),
  CONSTRAINT "listing_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "listing_description_chk" CHECK (
    char_length("description") BETWEEN 1 AND 5000
    AND octet_length("description") <= 10000
    AND "description" = btrim("description")
  ),
  CONSTRAINT "listing_availability_chk" CHECK (
    "available_until" IS NULL OR
    ("available_from" IS NOT NULL AND "available_until" > "available_from")
  )
);

CREATE INDEX "property_status_created_idx"
  ON "property" ("status", "created_at" DESC, "id");
CREATE INDEX "property_authorization_property_status_idx"
  ON "property_authorization" ("property_id", "status", "valid_until");
CREATE INDEX "property_authorization_user_status_idx"
  ON "property_authorization" ("user_id", "status", "valid_until");
CREATE INDEX "property_authorization_org_status_idx"
  ON "property_authorization" ("organization_id", "status", "valid_until");
CREATE UNIQUE INDEX "property_authorization_active_user_uq"
  ON "property_authorization" ("property_id", "user_id", "authorization_type")
  WHERE "status" = 'ACTIVE' AND "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "property_authorization_active_org_uq"
  ON "property_authorization" ("property_id", "organization_id", "authorization_type")
  WHERE "status" = 'ACTIVE' AND "organization_id" IS NOT NULL;
CREATE INDEX "listing_property_status_created_idx"
  ON "listing" ("property_id", "status", "created_at" DESC, "id");
CREATE INDEX "listing_publisher_user_idx"
  ON "listing" ("publisher_user_id", "status", "created_at" DESC, "id");
CREATE INDEX "listing_publisher_org_idx"
  ON "listing" ("publisher_organization_id", "status", "created_at" DESC, "id");

ALTER TABLE "property_authorization"
  ADD CONSTRAINT "property_authorization_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "property"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "property_authorization_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "property_authorization_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "property_authorization_granted_by_user_id_fkey"
  FOREIGN KEY ("granted_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "listing"
  ADD CONSTRAINT "listing_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "property"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "listing_publisher_user_id_fkey"
  FOREIGN KEY ("publisher_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "listing_publisher_organization_id_fkey"
  FOREIGN KEY ("publisher_organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "listing_responsible_member_user_id_fkey"
  FOREIGN KEY ("responsible_member_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
