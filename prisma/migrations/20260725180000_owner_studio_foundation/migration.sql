-- Owner Studio Stage 1 foundation
-- GENERATED FOR STAGING ONLY — DO NOT APPLY TO PRODUCTION IN STAGE 1.
-- Requires isolated staging database fingerprint confirmation before migrate deploy.

CREATE TABLE "OsSite" (
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OsSite_pkey" PRIMARY KEY ("siteId")
);

CREATE TABLE "OsSiteSettings" (
    "siteId" TEXT NOT NULL,
    "businessName" TEXT,
    "legalEntityName" TEXT,
    "phoneE164" TEXT,
    "publicEmail" TEXT,
    "logoMediaId" TEXT,
    "announcement" TEXT,
    "socialLinksJson" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OsSiteSettings_pkey" PRIMARY KEY ("siteId")
);

CREATE TABLE "OsPackage" (
    "siteId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "legacyKey" TEXT,
    "category" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OsPackage_pkey" PRIMARY KEY ("siteId","packageId")
);

CREATE TABLE "OsPackageRevision" (
    "packageRevisionId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "shortDescription" TEXT NOT NULL DEFAULT '',
    "durationMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "OsPackageRevision_pkey" PRIMARY KEY ("packageRevisionId")
);

CREATE TABLE "OsPackagePrice" (
    "packagePriceId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "vehicleClassId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "amountCents" INTEGER NOT NULL,
    "priceModel" TEXT NOT NULL DEFAULT 'flat',
    "perFootCents" INTEGER,
    "minCents" INTEGER,
    "baseCents" INTEGER,
    "releaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OsPackagePrice_pkey" PRIMARY KEY ("packagePriceId")
);

CREATE TABLE "OsPackageFeature" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "packageRevisionId" TEXT,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "OsPackageFeature_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OsPackageAvailability" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'public',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metaJson" JSONB,
    CONSTRAINT "OsPackageAvailability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OsVehicleClass" (
    "siteId" TEXT NOT NULL,
    "vehicleClassId" TEXT NOT NULL,
    "legacyKey" TEXT,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OsVehicleClass_pkey" PRIMARY KEY ("siteId","vehicleClassId")
);

CREATE TABLE "OsAddOn" (
    "siteId" TEXT NOT NULL,
    "addOnId" TEXT NOT NULL,
    "legacyKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "allowQuantity" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OsAddOn_pkey" PRIMARY KEY ("siteId","addOnId")
);

CREATE TABLE "OsAddOnRevision" (
    "addOnRevisionId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "addOnId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "OsAddOnRevision_pkey" PRIMARY KEY ("addOnRevisionId")
);

CREATE TABLE "OsAddOnPrice" (
    "addOnPriceId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "addOnId" TEXT NOT NULL,
    "category" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "amountCents" INTEGER NOT NULL,
    "releaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OsAddOnPrice_pkey" PRIMARY KEY ("addOnPriceId")
);

CREATE TABLE "OsAddOnCompatibility" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "addOnId" TEXT NOT NULL,
    "category" TEXT,
    "packageId" TEXT,
    CONSTRAINT "OsAddOnCompatibility_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OsMediaAsset" (
    "mediaId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "alt" TEXT NOT NULL DEFAULT '',
    "caption" TEXT NOT NULL DEFAULT '',
    "contentType" TEXT NOT NULL DEFAULT 'image/webp',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OsMediaAsset_pkey" PRIMARY KEY ("mediaId")
);

CREATE TABLE "OsCatalogDraft" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "OsCatalogDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OsCatalogRevision" (
    "revisionId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "validation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "OsCatalogRevision_pkey" PRIMARY KEY ("revisionId")
);

CREATE TABLE "OsPublishedRelease" (
    "releaseId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "revisionId" TEXT,
    "catalogJson" JSONB NOT NULL,
    "contentJson" JSONB NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT,
    CONSTRAINT "OsPublishedRelease_pkey" PRIMARY KEY ("releaseId")
);

CREATE TABLE "OsCurrentReleasePointer" (
    "siteId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "OsCurrentReleasePointer_pkey" PRIMARY KEY ("siteId")
);

CREATE TABLE "OsAuditLog" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "releaseId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OsAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OsPackage_siteId_category_idx" ON "OsPackage"("siteId", "category");
CREATE INDEX "OsPackage_siteId_active_idx" ON "OsPackage"("siteId", "active");
CREATE INDEX "OsPackageRevision_siteId_packageId_idx" ON "OsPackageRevision"("siteId", "packageId");
CREATE INDEX "OsPackagePrice_siteId_packageId_idx" ON "OsPackagePrice"("siteId", "packageId");
CREATE INDEX "OsPackagePrice_siteId_releaseId_idx" ON "OsPackagePrice"("siteId", "releaseId");
CREATE INDEX "OsPackageFeature_siteId_packageId_idx" ON "OsPackageFeature"("siteId", "packageId");
CREATE INDEX "OsPackageAvailability_siteId_packageId_idx" ON "OsPackageAvailability"("siteId", "packageId");
CREATE INDEX "OsVehicleClass_siteId_category_idx" ON "OsVehicleClass"("siteId", "category");
CREATE INDEX "OsAddOnRevision_siteId_addOnId_idx" ON "OsAddOnRevision"("siteId", "addOnId");
CREATE INDEX "OsAddOnPrice_siteId_addOnId_idx" ON "OsAddOnPrice"("siteId", "addOnId");
CREATE INDEX "OsAddOnCompatibility_siteId_addOnId_idx" ON "OsAddOnCompatibility"("siteId", "addOnId");
CREATE INDEX "OsMediaAsset_siteId_published_idx" ON "OsMediaAsset"("siteId", "published");
CREATE INDEX "OsCatalogDraft_siteId_idx" ON "OsCatalogDraft"("siteId");
CREATE INDEX "OsCatalogRevision_siteId_idx" ON "OsCatalogRevision"("siteId");
CREATE INDEX "OsPublishedRelease_siteId_publishedAt_idx" ON "OsPublishedRelease"("siteId", "publishedAt");
CREATE INDEX "OsAuditLog_siteId_createdAt_idx" ON "OsAuditLog"("siteId", "createdAt");
CREATE INDEX "OsAuditLog_siteId_action_idx" ON "OsAuditLog"("siteId", "action");

ALTER TABLE "OsSiteSettings" ADD CONSTRAINT "OsSiteSettings_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsPackage" ADD CONSTRAINT "OsPackage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsPackageRevision" ADD CONSTRAINT "OsPackageRevision_siteId_packageId_fkey" FOREIGN KEY ("siteId", "packageId") REFERENCES "OsPackage"("siteId", "packageId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsPackagePrice" ADD CONSTRAINT "OsPackagePrice_siteId_packageId_fkey" FOREIGN KEY ("siteId", "packageId") REFERENCES "OsPackage"("siteId", "packageId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsPackageFeature" ADD CONSTRAINT "OsPackageFeature_siteId_packageId_fkey" FOREIGN KEY ("siteId", "packageId") REFERENCES "OsPackage"("siteId", "packageId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsPackageAvailability" ADD CONSTRAINT "OsPackageAvailability_siteId_packageId_fkey" FOREIGN KEY ("siteId", "packageId") REFERENCES "OsPackage"("siteId", "packageId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsVehicleClass" ADD CONSTRAINT "OsVehicleClass_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsAddOn" ADD CONSTRAINT "OsAddOn_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsAddOnRevision" ADD CONSTRAINT "OsAddOnRevision_siteId_addOnId_fkey" FOREIGN KEY ("siteId", "addOnId") REFERENCES "OsAddOn"("siteId", "addOnId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsAddOnPrice" ADD CONSTRAINT "OsAddOnPrice_siteId_addOnId_fkey" FOREIGN KEY ("siteId", "addOnId") REFERENCES "OsAddOn"("siteId", "addOnId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsAddOnCompatibility" ADD CONSTRAINT "OsAddOnCompatibility_siteId_addOnId_fkey" FOREIGN KEY ("siteId", "addOnId") REFERENCES "OsAddOn"("siteId", "addOnId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsMediaAsset" ADD CONSTRAINT "OsMediaAsset_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsCatalogDraft" ADD CONSTRAINT "OsCatalogDraft_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsCatalogRevision" ADD CONSTRAINT "OsCatalogRevision_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsPublishedRelease" ADD CONSTRAINT "OsPublishedRelease_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsCurrentReleasePointer" ADD CONSTRAINT "OsCurrentReleasePointer_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OsAuditLog" ADD CONSTRAINT "OsAuditLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "OsSite"("siteId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Money safety: amount columns are INTEGER cents (enforced by type).
-- Application layer rejects negatives and floats before insert.
