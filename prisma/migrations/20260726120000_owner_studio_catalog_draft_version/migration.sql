-- Owner Studio Stage 2: optimistic concurrency version on catalog drafts.
-- Apply to isolated staging only via owner-studio:staging:migrate.

ALTER TABLE "OsCatalogDraft" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
