-- CreateEnum
CREATE TYPE "BookingLifecycleStatus" AS ENUM ('draft', 'submitted', 'confirmed', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'approved', 'settled', 'superseded');

-- CreateEnum
CREATE TYPE "ChangeRequestKind" AS ENUM ('package_change', 'addon', 'vehicle_add', 'vehicle_replace', 'address', 'reschedule', 'cancel', 'maintenance');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('pending', 'auto_applied', 'approved', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "ProviderObjectType" AS ENUM ('payment_intent', 'checkout_session', 'setup_intent');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('creating', 'open', 'requires_action', 'succeeded', 'failed', 'canceled', 'expired', 'superseded');

-- CreateEnum
CREATE TYPE "LedgerEntryKind" AS ENUM ('settlement', 'refund', 'adjustment', 'fee');

-- CreateEnum
CREATE TYPE "StripeEventStatus" AS ENUM ('received', 'processing', 'processed', 'failed');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "bookingVersion" INTEGER NOT NULL DEFAULT 0,
    "status" "BookingLifecycleStatus" NOT NULL DEFAULT 'draft',
    "isDraft" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "category" TEXT,
    "make" TEXT,
    "model" TEXT,
    "lengthFeet" INTEGER,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "quoteVersion" INTEGER NOT NULL,
    "approvedCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "quoteVersion" INTEGER,
    "kind" "ChangeRequestKind" NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "requiresAdminReview" BOOLEAN NOT NULL DEFAULT false,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "quoteId" TEXT,
    "quoteVersion" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerObjectType" "ProviderObjectType" NOT NULL,
    "providerObjectId" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'creating',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "quoteId" TEXT,
    "paymentAttemptId" TEXT,
    "kind" "LedgerEntryKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "quoteVersion" INTEGER NOT NULL,
    "providerObjectId" TEXT,
    "providerEventId" TEXT,
    "stripeEventId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "bookingId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "StripeEventStatus" NOT NULL DEFAULT 'received',
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_stripeCustomerId_key" ON "Customer"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- CreateIndex
CREATE INDEX "Booking_customerId_idx" ON "Booking"("customerId");

-- CreateIndex
CREATE INDEX "Booking_status_idx" ON "Booking"("status");

-- CreateIndex
CREATE INDEX "Vehicle_bookingId_idx" ON "Vehicle"("bookingId");

-- CreateIndex
CREATE INDEX "Quote_bookingId_idx" ON "Quote"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_bookingId_quoteVersion_key" ON "Quote"("bookingId", "quoteVersion");

-- CreateIndex
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");

-- CreateIndex
CREATE INDEX "QuoteItem_vehicleId_idx" ON "QuoteItem"("vehicleId");

-- CreateIndex
CREATE INDEX "ChangeRequest_bookingId_idx" ON "ChangeRequest"("bookingId");

-- CreateIndex
CREATE INDEX "ChangeRequest_status_idx" ON "ChangeRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_providerObjectId_key" ON "PaymentAttempt"("providerObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_idempotencyKey_key" ON "PaymentAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentAttempt_bookingId_idx" ON "PaymentAttempt"("bookingId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_quoteVersion_idx" ON "PaymentAttempt"("quoteVersion");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_providerEventId_key" ON "LedgerEntry"("providerEventId");

-- CreateIndex
CREATE INDEX "LedgerEntry_bookingId_idx" ON "LedgerEntry"("bookingId");

-- CreateIndex
CREATE INDEX "LedgerEntry_quoteId_idx" ON "LedgerEntry"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeEvent_stripeEventId_key" ON "StripeEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "StripeEvent_bookingId_idx" ON "StripeEvent"("bookingId");

-- CreateIndex
CREATE INDEX "StripeEvent_type_idx" ON "StripeEvent"("type");

-- CreateIndex
CREATE INDEX "AuditEvent_bookingId_idx" ON "AuditEvent"("bookingId");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Manual addition (not representable in schema.prisma): at most one active
-- (creating|open|requires_action) payment obligation per bookingId+quoteVersion.
-- A future `prisma migrate dev` will not see this in the Prisma schema and may
-- report drift; do not let `migrate reset`/autogenerated diffs silently drop it.
CREATE UNIQUE INDEX "PaymentAttempt_one_active_obligation"
  ON "PaymentAttempt" ("bookingId", "quoteVersion")
  WHERE "status" IN ('creating', 'open', 'requires_action');

-- Manual addition: LedgerEntry is append-only. Block UPDATE and DELETE at the
-- database level so no application bug or ad-hoc query can mutate settled history.
CREATE OR REPLACE FUNCTION ledger_entry_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry rows are immutable: % is not permitted on LedgerEntry (id=%)', TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_no_update
  BEFORE UPDATE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_immutable();

CREATE TRIGGER ledger_entry_no_delete
  BEFORE DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_immutable();
