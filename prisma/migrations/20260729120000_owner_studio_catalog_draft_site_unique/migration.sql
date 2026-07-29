-- Owner Studio Catalog Manager: one authoritative draft per site.
-- Precondition: staging already has a single OsCatalogDraft row per siteId
-- (verified in Stage 2 investigation). Enforce at the schema layer so a second
-- draft row cannot silently shadow saves via findFirst(orderBy updatedAt).

CREATE UNIQUE INDEX "OsCatalogDraft_siteId_key" ON "OsCatalogDraft"("siteId");
