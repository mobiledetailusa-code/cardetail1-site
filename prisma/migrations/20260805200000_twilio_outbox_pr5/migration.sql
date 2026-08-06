-- PR5: post-commit Twilio outbox and delivery lifecycle.
-- Additive only. Sending remains feature-flagged off by default.

CREATE TYPE "SmsOutboxStatus" AS ENUM (
  'accepted',
  'sent',
  'delivered',
  'failed'
);

CREATE TABLE "SmsOutbox" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "bookingId" TEXT,
  "customerAccountId" TEXT,
  "toE164" TEXT NOT NULL,
  "templateKey" TEXT NOT NULL,
  "templateVersion" TEXT NOT NULL,
  "templateData" JSONB NOT NULL,
  "status" "SmsOutboxStatus" NOT NULL DEFAULT 'accepted',
  "providerMessageSid" TEXT,
  "providerStatus" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SmsOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SmsOutbox_attempt_count_nonnegative" CHECK ("attemptCount" >= 0),
  CONSTRAINT "SmsOutbox_max_attempts_bounded" CHECK ("maxAttempts" BETWEEN 1 AND 10),
  CONSTRAINT "SmsOutbox_recipient_e164" CHECK ("toE164" ~ '^[+][1-9][0-9]{7,14}$')
);

CREATE UNIQUE INDEX "SmsOutbox_idempotencyKey_key" ON "SmsOutbox"("idempotencyKey");
CREATE UNIQUE INDEX "SmsOutbox_providerMessageSid_key" ON "SmsOutbox"("providerMessageSid");
CREATE INDEX "SmsOutbox_status_availableAt_idx" ON "SmsOutbox"("status", "availableAt");
CREATE INDEX "SmsOutbox_customerAccountId_status_idx" ON "SmsOutbox"("customerAccountId", "status");
CREATE INDEX "SmsOutbox_bookingId_idx" ON "SmsOutbox"("bookingId");
CREATE INDEX "SmsOutbox_claimable_idx"
  ON "SmsOutbox"("availableAt", "leaseExpiresAt")
  WHERE "status" = 'accepted' AND "providerMessageSid" IS NULL;
