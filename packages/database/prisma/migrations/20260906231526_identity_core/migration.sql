-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "SessionRevocationReason" AS ENUM ('LOGOUT', 'LOGOUT_ALL', 'PASSWORD_CHANGE', 'PASSWORD_RESET', 'USER_SUSPENDED', 'USER_DEACTIVATED', 'ADMIN_REVOKED', 'SECURITY_RESPONSE');

-- CreateEnum
CREATE TYPE "AccountTokenPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'ORGANIZATION_INVITATION');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrganizationMemberRole" AS ENUM ('ADMIN', 'PROFESSIONAL_MEMBER');

-- CreateEnum
CREATE TYPE "OrganizationMemberStatus" AS ENUM ('ACTIVE', 'REVOKED', 'LEFT');

-- CreateEnum
CREATE TYPE "OrganizationInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuthRateLimitAction" AS ENUM ('REGISTER', 'LOGIN', 'SESSION_READ', 'FORGOT_PASSWORD', 'RESET_PASSWORD', 'VERIFY_EMAIL', 'RESEND_VERIFICATION', 'LOGOUT_ALL', 'CHANGE_PASSWORD', 'ORGANIZATION_INVITE', 'ORGANIZATION_INVITE_RESEND', 'ORGANIZATION_INVITATION_ACCEPT', 'ORGANIZATION_INVITATION_REJECT');

-- CreateEnum
CREATE TYPE "AuthRateLimitDimension" AS ENUM ('EMAIL', 'IP', 'EMAIL_IP', 'TOKEN', 'TOKEN_IP', 'ACTOR', 'ORGANIZATION', 'ACTOR_ORGANIZATION');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'ANONYMOUS', 'SERVICE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'OBSOLETE', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ(3),
    "session_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_credential" (
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(512) NOT NULL,
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "password_credential_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "secret_digest" BYTEA NOT NULL,
    "secret_key_version" SMALLINT NOT NULL,
    "user_id" UUID NOT NULL,
    "issued_session_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason" "SessionRevocationReason",

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_token" (
    "id" UUID NOT NULL,
    "purpose" "AccountTokenPurpose" NOT NULL,
    "generation" INTEGER NOT NULL,
    "key_version" SMALLINT NOT NULL,
    "user_id" UUID,
    "organization_invitation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason_code" VARCHAR(64),

    CONSTRAINT "account_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_member" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrganizationMemberRole" NOT NULL,
    "status" "OrganizationMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "invitation_id" UUID,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_reason_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitation" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "OrganizationMemberRole" NOT NULL,
    "status" "OrganizationInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_by_user_id" UUID NOT NULL,
    "accepted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "responded_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_rate_limit" (
    "id" UUID NOT NULL,
    "action" "AuthRateLimitAction" NOT NULL,
    "dimension" "AuthRateLimitDimension" NOT NULL,
    "subject_digest" BYTEA NOT NULL,
    "pepper_version" SMALLINT NOT NULL,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "window_ends_at" TIMESTAMPTZ(3) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "blocked_until" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_rate_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_user_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "resource_type" VARCHAR(60) NOT NULL,
    "resource_id" UUID,
    "previous_state" VARCHAR(40),
    "new_state" VARCHAR(40),
    "reason_code" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "request_id" VARCHAR(128),
    "correlation_id" VARCHAR(128),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "event_version" SMALLINT NOT NULL DEFAULT 1,
    "aggregate_type" VARCHAR(60) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "account_token_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ(3),
    "locked_until" TIMESTAMPTZ(3),
    "locked_by" VARCHAR(100),
    "lock_token" UUID,
    "processed_at" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(80),
    "correlation_id" VARCHAR(128),
    "causation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_uq" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_secret_digest_uq" ON "session"("secret_digest");

-- CreateIndex
CREATE INDEX "session_user_revoked_idx" ON "session"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "session_idle_expires_idx" ON "session"("idle_expires_at");

-- CreateIndex
CREATE INDEX "session_absolute_expires_idx" ON "session"("absolute_expires_at");

-- CreateIndex
CREATE INDEX "account_token_expires_idx" ON "account_token"("expires_at");

-- CreateIndex
CREATE INDEX "organization_member_org_status_role_idx" ON "organization_member"("organization_id", "status", "role");

-- CreateIndex
CREATE INDEX "organization_member_user_status_idx" ON "organization_member"("user_id", "status");

-- CreateIndex
CREATE INDEX "organization_member_history_idx" ON "organization_member"("organization_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "organization_invitation_org_status_expiry_idx" ON "organization_invitation"("organization_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "organization_invitation_email_status_idx" ON "organization_invitation"("email", "status");

-- CreateIndex
CREATE INDEX "auth_rate_limit_expires_idx" ON "auth_rate_limit"("expires_at");

-- CreateIndex
CREATE INDEX "auth_rate_limit_blocked_idx" ON "auth_rate_limit"("action", "dimension", "blocked_until");

-- CreateIndex
CREATE INDEX "auth_rate_limit_digest_idx" ON "auth_rate_limit"("subject_digest", "pepper_version");

-- CreateIndex
CREATE UNIQUE INDEX "auth_rate_limit_subject_uq" ON "auth_rate_limit"("action", "dimension", "subject_digest", "pepper_version");

-- CreateIndex
CREATE INDEX "audit_event_resource_idx" ON "audit_event"("resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_event_actor_idx" ON "audit_event"("actor_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_event_action_idx" ON "audit_event"("action", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_event_request_idx" ON "audit_event"("request_id");

-- CreateIndex
CREATE INDEX "audit_event_correlation_idx" ON "audit_event"("correlation_id");

-- CreateIndex
CREATE INDEX "outbox_event_claim_idx" ON "outbox_event"("status", "available_at", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_event_aggregate_idx" ON "outbox_event"("aggregate_type", "aggregate_id", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_event_correlation_idx" ON "outbox_event"("correlation_id");

-- AddForeignKey
ALTER TABLE "password_credential" ADD CONSTRAINT "password_credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_token" ADD CONSTRAINT "account_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_token" ADD CONSTRAINT "account_token_organization_invitation_id_fkey" FOREIGN KEY ("organization_invitation_id") REFERENCES "organization_invitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "organization_invitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_account_token_id_fkey" FOREIGN KEY ("account_token_id") REFERENCES "account_token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma no expresa checks ni índices parciales. Estas restricciones materializan
-- las invariantes del contrato B1 Identity Core directamente en PostgreSQL.

-- User y credencial.
ALTER TABLE "user"
  ADD CONSTRAINT "user_email_canonical_chk" CHECK (
    "email" = btrim("email")
    AND "email" = lower("email")
    AND octet_length("email") = char_length("email")
    AND octet_length("email") BETWEEN 3 AND 254
    AND position('@' IN "email") > 1
  ),
  ADD CONSTRAINT "user_display_name_chk" CHECK (
    "display_name" = btrim("display_name")
    AND char_length("display_name") BETWEEN 1 AND 120
    AND octet_length("display_name") <= 240
  ),
  ADD CONSTRAINT "user_session_version_chk" CHECK ("session_version" >= 1);

ALTER TABLE "password_credential"
  ADD CONSTRAINT "password_credential_hash_chk" CHECK (
    char_length("password_hash") > 0
    AND octet_length("password_hash") <= 512
  ),
  ADD CONSTRAINT "password_credential_changed_at_chk" CHECK (
    "password_changed_at" >= "created_at"
  );

-- Session.
ALTER TABLE "session"
  ADD CONSTRAINT "session_secret_digest_length_chk" CHECK (octet_length("secret_digest") = 32),
  ADD CONSTRAINT "session_key_version_chk" CHECK ("secret_key_version" > 0),
  ADD CONSTRAINT "session_issued_version_chk" CHECK ("issued_session_version" >= 1),
  ADD CONSTRAINT "session_time_order_chk" CHECK (
    "created_at" <= "last_activity_at"
    AND "last_activity_at" <= "idle_expires_at"
    AND "idle_expires_at" <= "absolute_expires_at"
  ),
  ADD CONSTRAINT "session_revocation_chk" CHECK (
    ("revoked_at" IS NULL AND "revocation_reason" IS NULL)
    OR
    ("revoked_at" IS NOT NULL AND "revocation_reason" IS NOT NULL AND "revoked_at" >= "created_at")
  );

-- AccountToken: exactamente un sujeto y propósito compatible.
ALTER TABLE "account_token"
  ADD CONSTRAINT "account_token_subject_xor_chk" CHECK (
    ("user_id" IS NOT NULL) <> ("organization_invitation_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "account_token_purpose_subject_chk" CHECK (
    (
      "purpose" IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')
      AND "organization_invitation_id" IS NULL
    )
    OR
    (
      "purpose" = 'ORGANIZATION_INVITATION'
      AND "user_id" IS NULL
    )
  ),
  ADD CONSTRAINT "account_token_generation_chk" CHECK ("generation" >= 1),
  ADD CONSTRAINT "account_token_key_version_chk" CHECK ("key_version" > 0),
  ADD CONSTRAINT "account_token_expiry_chk" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "account_token_terminal_state_chk" CHECK (
    NOT ("consumed_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
    AND ("consumed_at" IS NULL OR "consumed_at" >= "created_at")
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  ),
  ADD CONSTRAINT "account_token_revocation_reason_chk" CHECK (
    ("revoked_at" IS NULL AND "revocation_reason_code" IS NULL)
    OR
    ("revoked_at" IS NOT NULL AND "revocation_reason_code" IS NOT NULL)
  );

CREATE UNIQUE INDEX "account_token_user_generation_uq"
  ON "account_token" ("purpose", "user_id", "generation")
  WHERE "user_id" IS NOT NULL;

CREATE UNIQUE INDEX "account_token_invitation_generation_uq"
  ON "account_token" ("purpose", "organization_invitation_id", "generation")
  WHERE "organization_invitation_id" IS NOT NULL;

CREATE INDEX "account_token_user_latest_idx"
  ON "account_token" ("purpose", "user_id", "generation" DESC)
  WHERE "user_id" IS NOT NULL;

CREATE INDEX "account_token_invitation_latest_idx"
  ON "account_token" ("purpose", "organization_invitation_id", "generation" DESC)
  WHERE "organization_invitation_id" IS NOT NULL;

-- Organization, membership e invitation.
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_name_chk" CHECK (
    "name" = btrim("name")
    AND char_length("name") BETWEEN 1 AND 160
    AND octet_length("name") <= 320
  );

ALTER TABLE "organization_member"
  ADD CONSTRAINT "organization_member_state_chk" CHECK (
    (
      "status" = 'ACTIVE'
      AND "ended_at" IS NULL
      AND "ended_reason_code" IS NULL
    )
    OR
    (
      "status" IN ('REVOKED', 'LEFT')
      AND "ended_at" IS NOT NULL
      AND "ended_at" >= "joined_at"
    )
  );

CREATE UNIQUE INDEX "organization_member_active_uq"
  ON "organization_member" ("organization_id", "user_id")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "organization_member_invitation_uq"
  ON "organization_member" ("invitation_id")
  WHERE "invitation_id" IS NOT NULL;

ALTER TABLE "organization_invitation"
  ADD CONSTRAINT "organization_invitation_email_canonical_chk" CHECK (
    "email" = btrim("email")
    AND "email" = lower("email")
    AND octet_length("email") = char_length("email")
    AND octet_length("email") BETWEEN 3 AND 254
    AND position('@' IN "email") > 1
  ),
  ADD CONSTRAINT "organization_invitation_expiry_chk" CHECK (
    "expires_at" > "created_at"
  ),
  ADD CONSTRAINT "organization_invitation_state_chk" CHECK (
    (
      "status" IN ('PENDING', 'EXPIRED')
      AND "accepted_by_user_id" IS NULL
      AND "responded_at" IS NULL
      AND "revoked_at" IS NULL
    )
    OR
    (
      "status" = 'ACCEPTED'
      AND "accepted_by_user_id" IS NOT NULL
      AND "responded_at" IS NOT NULL
      AND "responded_at" >= "created_at"
      AND "revoked_at" IS NULL
    )
    OR
    (
      "status" = 'REJECTED'
      AND "accepted_by_user_id" IS NULL
      AND "responded_at" IS NOT NULL
      AND "responded_at" >= "created_at"
      AND "revoked_at" IS NULL
    )
    OR
    (
      "status" = 'REVOKED'
      AND "accepted_by_user_id" IS NULL
      AND "responded_at" IS NULL
      AND "revoked_at" IS NOT NULL
      AND "revoked_at" >= "created_at"
    )
  );

CREATE UNIQUE INDEX "organization_invitation_pending_uq"
  ON "organization_invitation" ("organization_id", "email")
  WHERE "status" = 'PENDING';

-- AuthRateLimit mantiene una única fila mutable por sujeto y política.
ALTER TABLE "auth_rate_limit"
  ADD CONSTRAINT "auth_rate_limit_digest_length_chk" CHECK (octet_length("subject_digest") = 32),
  ADD CONSTRAINT "auth_rate_limit_pepper_version_chk" CHECK ("pepper_version" > 0),
  ADD CONSTRAINT "auth_rate_limit_window_chk" CHECK ("window_ends_at" > "window_started_at"),
  ADD CONSTRAINT "auth_rate_limit_attempt_count_chk" CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "auth_rate_limit_expiry_chk" CHECK (
    "expires_at" >= "window_ends_at"
    AND ("blocked_until" IS NULL OR "expires_at" >= "blocked_until")
  );

-- AuditEvent es append-only para el rol ordinario. Retención futura solo podrá
-- ejecutarse mediante una migración/operación administrativa controlada que,
-- con privilegios de propietario, deshabilite y rehabilite este trigger.
ALTER TABLE "audit_event"
  ADD CONSTRAINT "audit_event_action_chk" CHECK (char_length(btrim("action")) > 0),
  ADD CONSTRAINT "audit_event_resource_type_chk" CHECK (char_length(btrim("resource_type")) > 0),
  ADD CONSTRAINT "audit_event_metadata_object_chk" CHECK (jsonb_typeof("metadata") = 'object');

CREATE FUNCTION "reject_audit_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- La única mutación automática permitida es ON DELETE SET NULL de la FK
  -- AuditEvent.actorUserId. Una actualización directa sigue siendo rechazada.
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND OLD."actor_user_id" IS NOT NULL
     AND NEW."actor_user_id" IS NULL
     AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "audit_event_append_only_trg"
BEFORE UPDATE OR DELETE ON "audit_event"
FOR EACH ROW
EXECUTE FUNCTION "reject_audit_event_mutation"();

-- OutboxEvent: coherencia de estado y ownership robusto del lease.
ALTER TABLE "outbox_event"
  ADD CONSTRAINT "outbox_event_version_chk" CHECK ("event_version" > 0),
  ADD CONSTRAINT "outbox_event_attempt_count_chk" CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "outbox_event_lock_group_chk" CHECK (
    (
      "locked_at" IS NULL
      AND "locked_until" IS NULL
      AND "locked_by" IS NULL
      AND "lock_token" IS NULL
    )
    OR
    (
      "locked_at" IS NOT NULL
      AND "locked_until" IS NOT NULL
      AND "locked_by" IS NOT NULL
      AND "lock_token" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "outbox_event_lease_order_chk" CHECK (
    "locked_until" IS NULL OR "locked_until" > "locked_at"
  ),
  ADD CONSTRAINT "outbox_event_state_chk" CHECK (
    (
      "status" = 'PENDING'
      AND "processed_at" IS NULL
      AND "locked_at" IS NULL
    )
    OR
    (
      "status" = 'PROCESSING'
      AND "processed_at" IS NULL
      AND "locked_at" IS NOT NULL
    )
    OR
    (
      "status" IN ('PROCESSED', 'OBSOLETE')
      AND "processed_at" IS NOT NULL
      AND "last_error_code" IS NULL
      AND "locked_at" IS NULL
    )
    OR
    (
      "status" = 'DEAD_LETTER'
      AND "processed_at" IS NULL
      AND "last_error_code" IS NOT NULL
      AND "locked_at" IS NULL
    )
  );

CREATE UNIQUE INDEX "outbox_event_account_token_uq"
  ON "outbox_event" ("account_token_id")
  WHERE "account_token_id" IS NOT NULL;

CREATE UNIQUE INDEX "outbox_event_lock_token_uq"
  ON "outbox_event" ("lock_token")
  WHERE "lock_token" IS NOT NULL;

CREATE INDEX "outbox_event_expired_lease_idx"
  ON "outbox_event" ("locked_until")
  WHERE "status" = 'PROCESSING';
