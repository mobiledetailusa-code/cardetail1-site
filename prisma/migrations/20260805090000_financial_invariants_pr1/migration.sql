-- PR 1: financial invariants and reprocessable Stripe webhook inbox.
-- The schema changes are additive and existing ledger rows are not rewritten.
-- Historical StripeEvent payloads are deliberately minimized in place while
-- preserving the provider/event bindings needed for reconciliation.

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

-- Minimize historical inbox rows in-place. Older code stored the provider
-- object wholesale, which could include client_secret, billing details,
-- payment-method details, charge data, and raw error messages. Retain only
-- the binding and reconciliation fields required for operations.
UPDATE "StripeEvent"
SET "payload" = jsonb_strip_nulls(jsonb_build_object(
  'objectType', COALESCE("payload"->>'objectType', "payload"->>'object'),
  'objectId', COALESCE("payload"->>'objectId', "payload"->>'id'),
  'status', "payload"->>'status',
  'amountCents', CASE
    WHEN COALESCE("payload"->>'amountCents', "payload"->>'amount_received', "payload"->>'amount') ~ '^-?[0-9]+$'
      THEN COALESCE("payload"->>'amountCents', "payload"->>'amount_received', "payload"->>'amount')::INTEGER
    ELSE NULL
  END,
  'currency', lower("payload"->>'currency'),
  'purpose', COALESCE("payload"->>'purpose', "payload"#>>'{metadata,purpose}'),
  'bookingId', COALESCE(
    "payload"->>'bookingId',
    "payload"#>>'{metadata,bookingId}',
    "payload"#>>'{metadata,booking_id}'
  ),
  'quoteVersion', CASE
    WHEN COALESCE(
      "payload"->>'quoteVersion',
      "payload"#>>'{metadata,quoteVersion}',
      "payload"#>>'{metadata,quote_version}'
    ) ~ '^[0-9]+$'
      THEN COALESCE(
        "payload"->>'quoteVersion',
        "payload"#>>'{metadata,quoteVersion}',
        "payload"#>>'{metadata,quote_version}'
      )::INTEGER
    ELSE NULL
  END,
  'livemode', CASE
    WHEN lower("payload"->>'livemode') IN ('true', 'false')
      THEN ("payload"->>'livemode')::BOOLEAN
    ELSE NULL
  END
));

-- The temporary default above backfills existing rows. Runtime writes use
-- Prisma's @updatedAt behavior, so drop it to keep migration history and the
-- declarative schema identical.
ALTER TABLE "StripeEvent"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

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
