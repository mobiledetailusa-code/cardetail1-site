-- Customer Lifecycle constraint hardening (staging-only apply).
-- Additive only. Do not edit 20260728010000_*.
-- Before applying: verify no duplicate drafts per siteId and no conflicting
-- idempotency keys. Do not auto-delete historical rows.

-- 1) One lifecycle draft per site
CREATE UNIQUE INDEX IF NOT EXISTS "OsCustomerLifecycleDraft_siteId_key"
  ON "OsCustomerLifecycleDraft"("siteId");

-- 2) AppointmentEvent idempotency support (nullable key; uniqueness when present)
ALTER TABLE "AppointmentEvent"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- Partial unique index: allow many NULL keys; enforce uniqueness when set.
CREATE UNIQUE INDEX IF NOT EXISTS "AppointmentEvent_siteId_appointmentId_idempotencyKey_key"
  ON "AppointmentEvent"("siteId", "appointmentId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
