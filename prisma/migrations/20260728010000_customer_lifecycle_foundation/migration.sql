-- Customer Lifecycle foundation (staging-only apply).
-- Additive: drafts/revisions + immutable AppointmentEvent.
-- No production migrate in this stage.

CREATE TABLE IF NOT EXISTS "OsCustomerLifecycleDraft" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "OsCustomerLifecycleDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OsCustomerLifecycleDraft_siteId_idx" ON "OsCustomerLifecycleDraft"("siteId");

CREATE TABLE IF NOT EXISTS "OsCustomerLifecycleRevision" (
    "revisionId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "validation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "OsCustomerLifecycleRevision_pkey" PRIMARY KEY ("revisionId")
);

CREATE INDEX IF NOT EXISTS "OsCustomerLifecycleRevision_siteId_idx" ON "OsCustomerLifecycleRevision"("siteId");

CREATE TABLE IF NOT EXISTS "AppointmentEvent" (
    "eventId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "customerId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAtUtc" TIMESTAMP(3) NOT NULL,
    "appointmentVersion" INTEGER,
    "quoteVersion" INTEGER,
    "changeSummary" TEXT NOT NULL,
    "internalNote" TEXT,
    "correlationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX IF NOT EXISTS "AppointmentEvent_siteId_appointmentId_occurredAtUtc_idx"
  ON "AppointmentEvent"("siteId", "appointmentId", "occurredAtUtc");
CREATE INDEX IF NOT EXISTS "AppointmentEvent_appointmentId_occurredAtUtc_idx"
  ON "AppointmentEvent"("appointmentId", "occurredAtUtc");
CREATE INDEX IF NOT EXISTS "AppointmentEvent_siteId_eventType_idx"
  ON "AppointmentEvent"("siteId", "eventType");

DO $$ BEGIN
  ALTER TABLE "OsCustomerLifecycleDraft"
    ADD CONSTRAINT "OsCustomerLifecycleDraft_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "OsCustomerLifecycleRevision"
    ADD CONSTRAINT "OsCustomerLifecycleRevision_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AppointmentEvent"
    ADD CONSTRAINT "AppointmentEvent_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
