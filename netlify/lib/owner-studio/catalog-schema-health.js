'use strict';

/**
 * Sanitized Owner Studio catalog schema readiness (no table contents / no DB IDs).
 */

const REQUIRED_OS_TABLES = [
  'OsSite',
  'OsCatalogDraft',
  'OsCatalogRevision',
  'OsPackage',
  'OsAddOn',
  'OsVehicleClass',
  'OsAuditLog',
];

async function probeOwnerStudioCatalogSchema(prisma) {
  const result = {
    configured: !!prisma,
    ready: false,
    requiredTablesPresent: false,
    draftReadable: false,
    error: null,
  };
  if (!prisma) {
    result.error = 'prisma_unavailable';
    return result;
  }
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY(ARRAY[${REQUIRED_OS_TABLES.map((t) => `'${t}'`).join(',')}])
    `);
    const present = new Set((rows || []).map((r) => r.tablename));
    const requiredTablesPresent = REQUIRED_OS_TABLES.every((t) => present.has(t));
    result.requiredTablesPresent = requiredTablesPresent;
    if (!requiredTablesPresent) {
      result.error = 'required_tables_missing';
      return result;
    }
    // Prove Prisma model mapping works (not only pg_tables).
    await prisma.osCatalogDraft.findFirst({ select: { id: true } });
    result.draftReadable = true;
    result.ready = true;
    return result;
  } catch (e) {
    result.error = e.code || 'schema_probe_failed';
    return result;
  }
}

module.exports = {
  REQUIRED_OS_TABLES,
  probeOwnerStudioCatalogSchema,
};
