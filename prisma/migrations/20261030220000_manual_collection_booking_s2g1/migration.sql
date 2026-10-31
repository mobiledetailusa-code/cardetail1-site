-- S2G.1 local migration source. Not executed by this change.
-- Additive nullable columns on the existing Booking row.
-- Existing bookings stay NULL, which means no manual collection reservation.
-- No backfill, no ledger rewrite, and no PaymentAttempt change.
-- Do not treat this file as proof that a live database accepted the SQL.

ALTER TABLE "Booking"
  ADD COLUMN "manualCollectionState" TEXT,
  ADD COLUMN "manualCollectionOperationId" TEXT,
  ADD COLUMN "manualCollectionQuoteVersion" INTEGER,
  ADD COLUMN "manualCollectionUrl" TEXT,
  ADD COLUMN "manualCollectionDetail" JSONB;

-- NOT VALID matches the local financial-migration style: the constraint is
-- recorded here and is not validated against a live table by this phase.
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_manual_collection_state"
  CHECK (
    "manualCollectionState" IS NULL
    OR "manualCollectionState" IN ('reserved', 'recorded', 'closed', 'payment_reported')
  ) NOT VALID;
