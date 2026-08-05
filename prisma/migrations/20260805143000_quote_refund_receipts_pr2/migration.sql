-- PR 2: versioned quote adjustments and webhook-confirmed Stripe refunds.
-- Additive only. Existing settled quotes and ledger history remain untouched.

CREATE TYPE "RefundRequestStatus" AS ENUM (
  'creating',
  'pending_webhook',
  'requires_action',
  'succeeded',
  'failed',
  'canceled'
);

ALTER TABLE "Quote"
  ADD COLUMN "adjustmentId" TEXT,
  ADD COLUMN "adjustmentReason" TEXT,
  ADD COLUMN "approvedBy" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Quote_adjustmentId_key" ON "Quote"("adjustmentId");

CREATE TABLE "RefundRequest" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "quoteVersion" INTEGER NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "reason" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "status" "RefundRequestStatus" NOT NULL DEFAULT 'creating',
  "requestGroupKey" TEXT NOT NULL,
  "partIndex" INTEGER NOT NULL DEFAULT 0,
  "idempotencyKey" TEXT NOT NULL,
  "providerRefundId" TEXT,
  "lastProviderEventId" TEXT,
  "lastProviderEventCreatedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "succeededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RefundRequest_amount_positive" CHECK ("amountCents" > 0),
  CONSTRAINT "RefundRequest_currency_lowercase" CHECK ("currency" = lower("currency")),
  CONSTRAINT "RefundRequest_bookingId_fkey" FOREIGN KEY ("bookingId")
    REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RefundRequest_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId")
    REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RefundRequest_idempotencyKey_key" ON "RefundRequest"("idempotencyKey");
CREATE UNIQUE INDEX "RefundRequest_providerRefundId_key" ON "RefundRequest"("providerRefundId");
CREATE UNIQUE INDEX "RefundRequest_requestGroupKey_partIndex_key" ON "RefundRequest"("requestGroupKey", "partIndex");
CREATE INDEX "RefundRequest_bookingId_idx" ON "RefundRequest"("bookingId");
CREATE INDEX "RefundRequest_paymentAttemptId_idx" ON "RefundRequest"("paymentAttemptId");
CREATE INDEX "RefundRequest_requestGroupKey_idx" ON "RefundRequest"("requestGroupKey");
CREATE INDEX "RefundRequest_status_idx" ON "RefundRequest"("status");
