-- B1.6: una autorización programada puede cancelarse antes de valid_from.
-- revoked_at conserva el instante real de cancelación, nunca anterior a created_at.
ALTER TABLE "property_authorization"
  DROP CONSTRAINT "property_authorization_state_chk",
  ADD CONSTRAINT "property_authorization_state_chk" CHECK (
    ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL AND "revoked_at" >= "created_at")
    OR
    ("status" IN ('ACTIVE', 'EXPIRED') AND "revoked_at" IS NULL)
  );
