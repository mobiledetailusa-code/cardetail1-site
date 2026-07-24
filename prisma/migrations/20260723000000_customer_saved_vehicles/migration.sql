-- Stage 2B — Customer Saved Vehicles (My Vehicles migration).
-- Additive only. No drops. Booking Vehicle table remains independent.

-- AlterTable — durable import marker (null = migrate-on-access not completed)
ALTER TABLE "CustomerAccount" ADD COLUMN "vehiclesImportedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CustomerVehicle" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "label" TEXT,
    "category" TEXT,
    "year" TEXT,
    "make" TEXT,
    "model" TEXT,
    "color" TEXT,
    "notes" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "legacySourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerVehicle_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "CustomerVehicle_customerAccountId_idx" ON "CustomerVehicle"("customerAccountId");
CREATE INDEX "CustomerVehicle_customerAccountId_archivedAt_idx" ON "CustomerVehicle"("customerAccountId", "archivedAt");
CREATE INDEX "CustomerVehicle_customerAccountId_isDefault_idx" ON "CustomerVehicle"("customerAccountId", "isDefault");

-- Unique import key per account (multiple NULLs allowed for non-imported rows)
CREATE UNIQUE INDEX "CustomerVehicle_customerAccountId_legacySourceId_key"
  ON "CustomerVehicle"("customerAccountId", "legacySourceId");

-- ForeignKey
ALTER TABLE "CustomerVehicle"
  ADD CONSTRAINT "CustomerVehicle_customerAccountId_fkey"
  FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
