-- Privacy-preserving SMS + voice bridge. Additive only.
-- Customer identity stays on the Cardetail1 Twilio number; ADMIN_SMS is never
-- exposed to customers.

CREATE TABLE "SmsBridgeThread" (
  "id" TEXT NOT NULL,
  "customerE164" TEXT NOT NULL,
  "last4" TEXT NOT NULL,
  "lastInboundAt" TIMESTAMP(3) NOT NULL,
  "lastOwnerAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SmsBridgeThread_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SmsBridgeThread_customer_e164" CHECK ("customerE164" ~ '^[+][1-9][0-9]{7,14}$'),
  CONSTRAINT "SmsBridgeThread_last4" CHECK ("last4" ~ '^[0-9]{4}$')
);

CREATE UNIQUE INDEX "SmsBridgeThread_customerE164_key" ON "SmsBridgeThread"("customerE164");
CREATE INDEX "SmsBridgeThread_lastInboundAt_idx" ON "SmsBridgeThread"("lastInboundAt");
CREATE INDEX "SmsBridgeThread_last4_lastInboundAt_idx" ON "SmsBridgeThread"("last4", "lastInboundAt");

CREATE TABLE "SmsBridgeMessage" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "providerSid" TEXT,
  "bodyPreview" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SmsBridgeMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SmsBridgeMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "SmsBridgeThread"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SmsBridgeMessage_providerSid_key" ON "SmsBridgeMessage"("providerSid");
CREATE INDEX "SmsBridgeMessage_threadId_createdAt_idx" ON "SmsBridgeMessage"("threadId", "createdAt");

CREATE TABLE "VoiceBridgeCall" (
  "id" TEXT NOT NULL,
  "callSid" TEXT NOT NULL,
  "fromLast4" TEXT NOT NULL,
  "dialStatus" TEXT NOT NULL,
  "notified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VoiceBridgeCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoiceBridgeCall_fromLast4" CHECK ("fromLast4" ~ '^[0-9]{4}$')
);

CREATE UNIQUE INDEX "VoiceBridgeCall_callSid_key" ON "VoiceBridgeCall"("callSid");
CREATE INDEX "VoiceBridgeCall_createdAt_idx" ON "VoiceBridgeCall"("createdAt");
