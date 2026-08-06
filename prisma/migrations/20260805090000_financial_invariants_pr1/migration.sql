-- PR 1: financial invariants and reprocessable Stripe webhook inbox.
-- The schema changes are additive and existing ledger rows are not rewritten.
-- Historical StripeEvent payloads are deliberately preserved. New runtime
-- writes are minimized by the application before they reach this table.

ALTER TABLE "PaymentAttempt"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'customer_balance',
  ADD COLUMN "providerCustomerId" TEXT,
  ADD COLUMN "lastProviderEventId" TEXT,
  ADD COLUMN "lastProviderEventCreatedAt" TIMESTAMP(3);

ALTER TABLE "StripeEvent"
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "providerCreatedAt" TIMESTAMP(3),
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "StripeEvent_status_idx" ON "StripeEvent"("status");

-- Keep the database default after backfill so the previously deployed
-- application bundle, whose Prisma model does not know about updatedAt, can
-- still insert StripeEvent rows during an application rollback.

-- NOT VALID keeps the migration deployable when historical rows need a
-- preflight audit. PostgreSQL still enforces these checks for every new row.
-- Owner deployment must run the validation queries documented in the PR
-- before validating these constraints in a later controlled migration.
ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_amount_positive"
  CHECK ("amountCents" > 0) NOT VALID;

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_financial_amount_nonzero"
  CHECK ("kind" = 'adjustment' OR "amountCents" > 0) NOT VALID;

ALTER TABLE "StripeEvent"
  ADD CONSTRAINT "StripeEvent_payload_is_object"
  CHECK (jsonb_typeof("payload") = 'object') NOT VALID;
