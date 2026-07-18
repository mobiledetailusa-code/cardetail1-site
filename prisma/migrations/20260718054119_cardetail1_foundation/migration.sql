-- CreateTable
CREATE TABLE "PrismaHealth" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'cardetail1',
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrismaHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRecord" (
    "id" TEXT NOT NULL,
    "bookingVersion" INTEGER NOT NULL DEFAULT 0,
    "quoteVersion" INTEGER NOT NULL DEFAULT 0,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL DEFAULT 'booking',
    "jobStatus" TEXT,
    "paymentWorkflowStatus" TEXT,
    "paymentStatus" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "preferredDate" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingRecord_phone_idx" ON "BookingRecord"("phone");

-- CreateIndex
CREATE INDEX "BookingRecord_email_idx" ON "BookingRecord"("email");

-- CreateIndex
CREATE INDEX "BookingRecord_paymentWorkflowStatus_idx" ON "BookingRecord"("paymentWorkflowStatus");

-- CreateIndex
CREATE INDEX "BookingRecord_preferredDate_idx" ON "BookingRecord"("preferredDate");

-- CreateIndex
CREATE INDEX "BookingRecord_updatedAt_idx" ON "BookingRecord"("updatedAt");
