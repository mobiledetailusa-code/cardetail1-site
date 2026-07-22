-- Customer Identity Foundation Stage 1 — additive only.
-- No drops. Existing Customer / Booking / payment tables remain intact.
-- Booking.customerAccountId is nullable so legacy rows keep working.

-- CreateEnum
CREATE TYPE "CustomerAccountStatus" AS ENUM ('active', 'disabled', 'merged');

-- CreateEnum
CREATE TYPE "ConsentChannel" AS ENUM ('email_transactional', 'sms_transactional', 'email_marketing', 'sms_marketing');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('granted', 'revoked', 'pending');

-- CreateTable
CREATE TABLE "CustomerAccount" (
    "id" TEXT NOT NULL,
    "status" "CustomerAccountStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "stripeCustomerId" TEXT,
    "mergedIntoAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerProfile" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "displayName" TEXT,
    "email" TEXT,
    "normalizedEmail" TEXT,
    "phone" TEXT,
    "normalizedPhone" TEXT,
    "preferredContactChannel" TEXT,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAddress" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "label" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerConsent" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "channel" "ConsentChannel" NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'pending',
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "source" TEXT,
    "consentTextVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerConsent_pkey" PRIMARY KEY ("id")
);

-- AlterTable — nullable identity link; existing bookings with NULL continue to work
ALTER TABLE "Booking" ADD COLUMN "customerAccountId" TEXT;

-- Indexes (lookup aids — NOT global uniqueness on phone/email)
CREATE UNIQUE INDEX "CustomerAccount_stripeCustomerId_key" ON "CustomerAccount"("stripeCustomerId");
CREATE INDEX "CustomerAccount_status_idx" ON "CustomerAccount"("status");
CREATE INDEX "CustomerAccount_mergedIntoAccountId_idx" ON "CustomerAccount"("mergedIntoAccountId");

CREATE UNIQUE INDEX "CustomerProfile_customerAccountId_key" ON "CustomerProfile"("customerAccountId");
CREATE INDEX "CustomerProfile_normalizedEmail_idx" ON "CustomerProfile"("normalizedEmail");
CREATE INDEX "CustomerProfile_normalizedPhone_idx" ON "CustomerProfile"("normalizedPhone");

CREATE INDEX "CustomerAddress_customerAccountId_idx" ON "CustomerAddress"("customerAccountId");
CREATE INDEX "CustomerAddress_customerAccountId_isDefault_idx" ON "CustomerAddress"("customerAccountId", "isDefault");

CREATE UNIQUE INDEX "CustomerConsent_customerAccountId_channel_key" ON "CustomerConsent"("customerAccountId", "channel");
CREATE INDEX "CustomerConsent_customerAccountId_idx" ON "CustomerConsent"("customerAccountId");

CREATE INDEX "Booking_customerAccountId_idx" ON "Booking"("customerAccountId");

-- ForeignKeys
ALTER TABLE "CustomerAccount" ADD CONSTRAINT "CustomerAccount_mergedIntoAccountId_fkey" FOREIGN KEY ("mergedIntoAccountId") REFERENCES "CustomerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomerProfile" ADD CONSTRAINT "CustomerProfile_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomerConsent" ADD CONSTRAINT "CustomerConsent_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "CustomerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
