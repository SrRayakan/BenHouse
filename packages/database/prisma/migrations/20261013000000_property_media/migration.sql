ALTER TABLE "property" ADD COLUMN "media_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "property" ADD CONSTRAINT "property_media_version_check" CHECK (media_version >= 0);
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'ARCHIVED', 'CANCELLED', 'EXPIRED');
CREATE TABLE "media" (
  "id" UUID NOT NULL,
  "property_id" UUID NOT NULL,
  "storage_key" VARCHAR(64) NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "upload_session_id" UUID NOT NULL,
  "token_digest" VARCHAR(64) NOT NULL,
  "intent_key" UUID NOT NULL,
  "mime" VARCHAR(32) NOT NULL,
  "size" INTEGER NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "position" INTEGER,
  "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_at" TIMESTAMPTZ(3),
  "archived_at" TIMESTAMPTZ(3),
  "cleaned_at" TIMESTAMPTZ(3),
  CONSTRAINT "media_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "media_content_check" CHECK (mime IN ('image/jpeg','image/png','image/webp') AND size BETWEEN 1 AND 10485760 AND sha256 ~ '^[a-f0-9]{64}$' AND storage_key ~ '^[a-f0-9]{64}$' AND token_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "media_lifecycle_check" CHECK (
    expires_at > created_at AND
    ((status IN ('PENDING','CANCELLED','EXPIRED') AND confirmed_at IS NULL AND position IS NULL AND width IS NULL AND height IS NULL) OR
     (status IN ('READY','ARCHIVED') AND confirmed_at IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0 AND width::bigint * height <= 40000000)) AND
    (status <> 'READY' OR (position IS NOT NULL AND position >= 0 AND archived_at IS NULL AND cleaned_at IS NULL)) AND
    (status <> 'ARCHIVED' OR (archived_at IS NOT NULL AND position IS NULL AND cleaned_at IS NULL)) AND
    (cleaned_at IS NULL OR status IN ('CANCELLED','EXPIRED'))
  )
);
CREATE UNIQUE INDEX "media_storage_key_key" ON "media"("storage_key");
CREATE UNIQUE INDEX "media_actor_intent_key" ON "media"("created_by_user_id", "intent_key");
CREATE INDEX "media_property_status_position_idx" ON "media"("property_id", "status", "position");
-- Diferida para poder permutar posiciones sin estados intermedios observables.
ALTER TABLE "media" ADD CONSTRAINT "media_property_position_key" UNIQUE (property_id, position) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION protect_media_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'confirmed media history cannot be deleted' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.property_id,NEW.storage_key,NEW.created_by_user_id,NEW.upload_session_id,NEW.token_digest,NEW.intent_key,NEW.mime,NEW.size,NEW.sha256,NEW.created_at,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.property_id,OLD.storage_key,OLD.created_by_user_id,OLD.upload_session_id,OLD.token_digest,OLD.intent_key,OLD.mime,OLD.size,OLD.sha256,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'media identity is immutable' USING ERRCODE='23514'; END IF;
  IF (OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING','READY','CANCELLED','EXPIRED')) OR
     (OLD.status = 'READY' AND NEW.status NOT IN ('READY','ARCHIVED')) OR
     (OLD.status IN ('ARCHIVED','CANCELLED','EXPIRED') AND NEW.status <> OLD.status)
  THEN RAISE EXCEPTION 'invalid media transition' USING ERRCODE='23514'; END IF;
  IF OLD.confirmed_at IS NOT NULL AND ROW(NEW.confirmed_at,NEW.width,NEW.height) IS DISTINCT FROM ROW(OLD.confirmed_at,OLD.width,OLD.height)
  THEN RAISE EXCEPTION 'media history is immutable' USING ERRCODE='23514'; END IF;
  IF (OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at) OR
     (OLD.cleaned_at IS NOT NULL AND NEW.cleaned_at IS DISTINCT FROM OLD.cleaned_at)
  THEN RAISE EXCEPTION 'media terminal timestamps are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_history_guard BEFORE UPDATE OR DELETE ON "media" FOR EACH ROW EXECUTE FUNCTION protect_media_history();
