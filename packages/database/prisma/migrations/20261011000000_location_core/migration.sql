-- C1.1: aditiva, sin seeds ni cambios en Property/Listing históricos.
CREATE TYPE "LocationKind" AS ENUM ('COUNTRY', 'AUTONOMOUS_COMMUNITY', 'PROVINCE', 'MUNICIPALITY', 'DISTRICT', 'NEIGHBORHOOD');

CREATE TABLE "location" (
  "id" UUID NOT NULL,
  "code" VARCHAR(96) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "kind" "LocationKind" NOT NULL,
  "parent_location_id" UUID,
  "parent_kind" "LocationKind",
  "centroid" geometry(Point,4326),
  "demo_synthetic" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "location_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "location_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "location_code_check" CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
  -- Orden estrictamente descendente: evita ciclos incluso con escrituras concurrentes.
  -- Permite omitir niveles administrativos que no existan en un territorio.
  CONSTRAINT "location_hierarchy_check" CHECK (
    ("kind" = 'COUNTRY' AND "parent_location_id" IS NULL AND "parent_kind" IS NULL) OR
    ("kind" <> 'COUNTRY' AND "parent_location_id" IS NOT NULL AND "parent_kind" IS NOT NULL AND "parent_kind" < "kind")
  ),
  CONSTRAINT "location_centroid_check" CHECK ("centroid" IS NULL OR
    (NOT ST_IsEmpty("centroid") AND ST_X("centroid") BETWEEN -180 AND 180 AND ST_Y("centroid") BETWEEN -90 AND 90))
);
CREATE UNIQUE INDEX "location_code_key" ON "location"("code");
CREATE UNIQUE INDEX "location_id_kind_key" ON "location"("id", "kind");
CREATE INDEX "location_parent_name_idx" ON "location"("parent_location_id", "name", "id");
CREATE INDEX "location_centroid_idx" ON "location" USING GIST ("centroid");
ALTER TABLE "location" ADD CONSTRAINT "location_parent_fkey" FOREIGN KEY ("parent_location_id", "parent_kind")
  REFERENCES "location"("id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "property"
  ADD COLUMN "location_id" UUID,
  ADD COLUMN "location_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "street_name" VARCHAR(160),
  ADD COLUMN "street_number" VARCHAR(24),
  ADD COLUMN "address_unit" VARCHAR(80),
  ADD COLUMN "postal_code" VARCHAR(16),
  ADD COLUMN "location_point" geometry(Point,4326),
  ADD CONSTRAINT "property_location_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "property_location_version_check" CHECK ("location_version" >= 0),
  ADD CONSTRAINT "property_location_private_check" CHECK (
    ("location_id" IS NOT NULL OR ("street_name" IS NULL AND "street_number" IS NULL AND "address_unit" IS NULL AND "postal_code" IS NULL AND "location_point" IS NULL)) AND
    ("street_name" IS NOT NULL OR ("street_number" IS NULL AND "address_unit" IS NULL)) AND
    ("street_name" IS NULL OR length(btrim("street_name")) > 0) AND
    ("street_number" IS NULL OR length(btrim("street_number")) > 0) AND
    ("address_unit" IS NULL OR length(btrim("address_unit")) > 0) AND
    ("postal_code" IS NULL OR length(btrim("postal_code")) > 0)
  ),
  ADD CONSTRAINT "property_location_point_check" CHECK ("location_point" IS NULL OR
    (NOT ST_IsEmpty("location_point") AND ST_X("location_point") BETWEEN -180 AND 180 AND ST_Y("location_point") BETWEEN -90 AND 90));
CREATE INDEX "property_location_idx" ON "property"("location_id");
CREATE INDEX "property_location_point_idx" ON "property" USING GIST ("location_point");
