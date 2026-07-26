'use strict';

/**
 * Catalog draft repository — memory (unit tests) + PostgreSQL (staging).
 * Stage 2 never mutates publication pointers or booking/payment data.
 */

const { assertSiteId, newId, SITE_ID } = require('./ids');
const { validateCompleteCatalogDraft, validateReleaseCandidate } = require('./schemas');

function conflictError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  err.statusCode = 409;
  Object.assign(err, extra);
  return err;
}

function sanitizeDraftResponse(row) {
  if (!row) return null;
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : { ...(row.payload || {}) };
  return {
    siteId: row.siteId,
    draftId: row.id || null,
    version: Number(row.version) || Number(payload.draftVersion) || 1,
    status: 'draft',
    packages: payload.packages || [],
    addOns: payload.addOns || [],
    vehicleClasses: payload.vehicleClasses || [],
    navigation: payload.navigation || { siteId: row.siteId, headerItems: [] },
    footer: payload.footer || { siteId: row.siteId, tagline: '', groups: [], legalLinks: [], copyright: '' },
    pages: payload.pages || [],
    galleries: payload.galleries || [],
    serviceAreas: payload.serviceAreas || [],
    media: payload.media || [],
    priceConflicts: payload.priceConflicts || [],
    unmappedContent: payload.unmappedContent || [],
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : payload.updatedAt || null,
    updatedBy: row.updatedBy || payload.updatedBy || null,
    lastSavedAt: payload.lastSavedAt || (row.updatedAt ? new Date(row.updatedAt).toISOString() : null),
    lastSavedBy: payload.lastSavedBy || row.updatedBy || null,
  };
}

function emptyPayload(siteId) {
  return {
    siteId,
    status: 'draft',
    packages: [],
    addOns: [],
    vehicleClasses: [],
    navigation: { siteId, headerItems: [] },
    footer: { siteId, tagline: '', groups: [], legalLinks: [], copyright: '' },
    pages: [],
    galleries: [],
    serviceAreas: [],
    media: [],
    priceConflicts: [],
    unmappedContent: [],
    draftVersion: 1,
    updatedAt: null,
    updatedBy: null,
    lastSavedAt: null,
    lastSavedBy: null,
  };
}

function createMemoryCatalogRepository(seed = {}) {
  const drafts = new Map(seed.drafts || []);
  const revisions = Array.isArray(seed.revisions) ? seed.revisions.slice() : [];
  const audits = Array.isArray(seed.audits) ? seed.audits.slice() : [];

  async function ensureSite() {
    /* memory no-op */
  }

  async function getCatalogDraft(siteId) {
    const id = assertSiteId(siteId);
    const row = drafts.get(id);
    if (!row) return null;
    return sanitizeDraftResponse(row);
  }

  async function createCatalogDraft(siteId, actor) {
    const id = assertSiteId(siteId);
    if (drafts.has(id)) {
      throw conflictError('draft_already_exists', 'Catalog draft already exists for site');
    }
    const now = new Date().toISOString();
    const payload = emptyPayload(id);
    payload.updatedAt = now;
    payload.updatedBy = actor;
    payload.lastSavedAt = now;
    payload.lastSavedBy = actor;
    const row = {
      id: newId('draft'),
      siteId: id,
      version: 1,
      payload,
      updatedAt: now,
      updatedBy: actor,
    };
    drafts.set(id, row);
    audits.push({
      id: newId('audit'),
      siteId: id,
      actor,
      action: 'catalog.draft.create',
      entityType: 'CatalogDraft',
      entityId: row.id,
      detail: { version: 1 },
      createdAt: now,
    });
    return sanitizeDraftResponse(row);
  }

  async function saveCatalogDraft(siteId, expectedVersion, payloadInput, actor) {
    const id = assertSiteId(siteId);
    const existing = drafts.get(id);
    if (!existing) {
      const err = new Error('draft_not_found');
      err.code = 'draft_not_found';
      err.statusCode = 404;
      throw err;
    }
    const currentVersion = Number(existing.version) || 1;
    if (Number(expectedVersion) !== currentVersion) {
      throw conflictError('stale_draft_version', 'Draft was modified by another session', {
        expectedVersion: Number(expectedVersion),
        currentVersion,
      });
    }
    const validated = validateCompleteCatalogDraft({ ...payloadInput, siteId: id });
    const nextVersion = currentVersion + 1;
    const now = new Date().toISOString();
    const payload = {
      ...validated,
      draftVersion: nextVersion,
      updatedAt: now,
      updatedBy: actor,
      lastSavedAt: now,
      lastSavedBy: actor,
    };
    const validation = validateReleaseCandidate(
      { packages: payload.packages, addOns: payload.addOns, vehicleClasses: payload.vehicleClasses },
      { navigation: payload.navigation, footer: payload.footer }
    );
    const revisionId = newId('rev');
    revisions.push({
      revisionId,
      siteId: id,
      payload: JSON.parse(JSON.stringify(payload)),
      validation,
      createdAt: now,
      createdBy: actor,
      source: 'save_draft',
      version: nextVersion,
    });
    existing.version = nextVersion;
    existing.payload = payload;
    existing.updatedAt = now;
    existing.updatedBy = actor;
    drafts.set(id, existing);
    audits.push({
      id: newId('audit'),
      siteId: id,
      actor,
      action: 'catalog.draft.save',
      entityType: 'CatalogDraft',
      entityId: existing.id,
      detail: { version: nextVersion, revisionId, ok: validation.ok, errorCount: validation.errors.length },
      createdAt: now,
    });
    return {
      draft: sanitizeDraftResponse(existing),
      revisionId,
      validation,
    };
  }

  async function getCatalogRevision(siteId, revisionId) {
    const id = assertSiteId(siteId);
    const rev = revisions.find((r) => r.siteId === id && r.revisionId === revisionId);
    return rev ? JSON.parse(JSON.stringify(rev)) : null;
  }

  async function listCatalogRevisions(siteId, pagination = {}) {
    const id = assertSiteId(siteId);
    const limit = Math.min(Math.max(Number(pagination.limit) || 20, 1), 100);
    const offset = Math.max(Number(pagination.offset) || 0, 0);
    const rows = revisions
      .filter((r) => r.siteId === id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return {
      total: rows.length,
      items: rows.slice(offset, offset + limit).map((r) => ({
        revisionId: r.revisionId,
        siteId: r.siteId,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
        source: r.source || 'save_draft',
        version: r.version,
        validationOk: !!(r.validation && r.validation.ok),
        errorCount: (r.validation && r.validation.errors && r.validation.errors.length) || 0,
        summary: {
          packageCount: (r.payload && r.payload.packages && r.payload.packages.length) || 0,
          addOnCount: (r.payload && r.payload.addOns && r.payload.addOns.length) || 0,
          vehicleClassCount: (r.payload && r.payload.vehicleClasses && r.payload.vehicleClasses.length) || 0,
          unresolvedConflicts: ((r.payload && r.payload.priceConflicts) || []).filter((c) => c.status === 'unresolved').length,
        },
      })),
    };
  }

  async function restoreRevisionAsNewDraft(siteId, revisionId, expectedVersion, actor) {
    const rev = await getCatalogRevision(siteId, revisionId);
    if (!rev) {
      const err = new Error('revision_not_found');
      err.code = 'revision_not_found';
      err.statusCode = 404;
      throw err;
    }
    return saveCatalogDraft(siteId, expectedVersion, rev.payload, actor);
  }

  async function readCatalogEntities(siteId) {
    const draft = await getCatalogDraft(siteId);
    if (!draft) {
      return { packages: [], addOns: [], vehicleClasses: [], priceConflicts: [], unmappedContent: [] };
    }
    return {
      packages: draft.packages,
      addOns: draft.addOns,
      vehicleClasses: draft.vehicleClasses,
      priceConflicts: draft.priceConflicts,
      unmappedContent: draft.unmappedContent,
    };
  }

  async function recordAuditEvent(siteId, actor, action, metadata = {}) {
    const id = assertSiteId(siteId);
    const row = {
      id: newId('audit'),
      siteId: id,
      actor: String(actor || 'unknown'),
      action: String(action || 'unknown'),
      entityType: metadata.entityType || null,
      entityId: metadata.entityId || null,
      detail: metadata.detail || null,
      createdAt: new Date().toISOString(),
    };
    audits.push(row);
    return row;
  }

  return {
    kind: 'memory',
    ensureSite,
    getCatalogDraft,
    createCatalogDraft,
    saveCatalogDraft,
    getCatalogRevision,
    listCatalogRevisions,
    restoreRevisionAsNewDraft,
    readCatalogEntities,
    recordAuditEvent,
    _memory: { drafts, revisions, audits },
  };
}

function createPostgresCatalogRepository(prismaClient) {
  if (!prismaClient) {
    const err = new Error('prisma_required');
    err.code = 'prisma_required';
    throw err;
  }
  const prisma = prismaClient;

  async function ensureSite(siteId, name = 'Cardetail1') {
    const id = assertSiteId(siteId);
    await prisma.osSite.upsert({
      where: { siteId: id },
      create: { siteId: id, name, status: 'active' },
      update: { updatedAt: new Date() },
    });
    return id;
  }

  async function findDraftRow(siteId, tx = prisma) {
    return tx.osCatalogDraft.findFirst({
      where: { siteId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async function getCatalogDraft(siteId) {
    const id = assertSiteId(siteId);
    const row = await findDraftRow(id);
    return sanitizeDraftResponse(row);
  }

  async function createCatalogDraft(siteId, actor) {
    const id = await ensureSite(siteId);
    const existing = await findDraftRow(id);
    if (existing) {
      throw conflictError('draft_already_exists', 'Catalog draft already exists for site');
    }
    const now = new Date();
    const payload = emptyPayload(id);
    payload.updatedAt = now.toISOString();
    payload.updatedBy = actor;
    payload.lastSavedAt = now.toISOString();
    payload.lastSavedBy = actor;
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.osCatalogDraft.create({
        data: {
          siteId: id,
          version: 1,
          payload,
          updatedBy: actor,
        },
      });
      await tx.osAuditLog.create({
        data: {
          siteId: id,
          actor: String(actor || 'unknown'),
          action: 'catalog.draft.create',
          entityType: 'CatalogDraft',
          entityId: created.id,
          detail: { version: 1 },
        },
      });
      return created;
    });
    return sanitizeDraftResponse(row);
  }

  async function saveCatalogDraft(siteId, expectedVersion, payloadInput, actor) {
    const id = await ensureSite(siteId);
    const expected = Number(expectedVersion);
    if (!Number.isInteger(expected) || expected < 1) {
      const err = new Error('invalid_expected_version');
      err.code = 'invalid_expected_version';
      err.statusCode = 400;
      throw err;
    }
    const validated = validateCompleteCatalogDraft({ ...payloadInput, siteId: id });

    return prisma.$transaction(async (tx) => {
      const existing = await tx.osCatalogDraft.findFirst({
        where: { siteId: id },
        orderBy: { updatedAt: 'desc' },
      });
      if (!existing) {
        const err = new Error('draft_not_found');
        err.code = 'draft_not_found';
        err.statusCode = 404;
        throw err;
      }
      if (Number(existing.version) !== expected) {
        throw conflictError('stale_draft_version', 'Draft was modified by another session', {
          expectedVersion: expected,
          currentVersion: Number(existing.version),
        });
      }
      const nextVersion = expected + 1;
      const nowIso = new Date().toISOString();
      const payload = {
        ...validated,
        draftVersion: nextVersion,
        updatedAt: nowIso,
        updatedBy: actor,
        lastSavedAt: nowIso,
        lastSavedBy: actor,
      };
      const validation = validateReleaseCandidate(
        { packages: payload.packages, addOns: payload.addOns, vehicleClasses: payload.vehicleClasses },
        { navigation: payload.navigation, footer: payload.footer }
      );
      const revisionId = newId('rev');
      await tx.osCatalogRevision.create({
        data: {
          revisionId,
          siteId: id,
          payload,
          validation,
          createdBy: actor,
        },
      });
      const updated = await tx.osCatalogDraft.updateMany({
        where: { id: existing.id, version: expected },
        data: {
          version: nextVersion,
          payload,
          updatedBy: actor,
        },
      });
      if (updated.count !== 1) {
        throw conflictError('stale_draft_version', 'Draft was modified by another session', {
          expectedVersion: expected,
        });
      }
      await tx.osAuditLog.create({
        data: {
          siteId: id,
          actor: String(actor || 'unknown'),
          action: 'catalog.draft.save',
          entityType: 'CatalogDraft',
          entityId: existing.id,
          detail: {
            version: nextVersion,
            revisionId,
            ok: validation.ok,
            errorCount: validation.errors.length,
          },
        },
      });
      const row = await tx.osCatalogDraft.findUnique({ where: { id: existing.id } });
      return {
        draft: sanitizeDraftResponse(row),
        revisionId,
        validation,
      };
    });
  }

  async function getCatalogRevision(siteId, revisionId) {
    const id = assertSiteId(siteId);
    const rev = await prisma.osCatalogRevision.findFirst({
      where: { siteId: id, revisionId: String(revisionId || '') },
    });
    if (!rev) return null;
    return {
      revisionId: rev.revisionId,
      siteId: rev.siteId,
      payload: rev.payload,
      validation: rev.validation,
      createdAt: rev.createdAt.toISOString(),
      createdBy: rev.createdBy,
      source: (rev.payload && rev.payload._source) || 'save_draft',
      version: (rev.payload && rev.payload.draftVersion) || null,
    };
  }

  async function listCatalogRevisions(siteId, pagination = {}) {
    const id = assertSiteId(siteId);
    const limit = Math.min(Math.max(Number(pagination.limit) || 20, 1), 100);
    const offset = Math.max(Number(pagination.offset) || 0, 0);
    const [total, rows] = await Promise.all([
      prisma.osCatalogRevision.count({ where: { siteId: id } }),
      prisma.osCatalogRevision.findMany({
        where: { siteId: id },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);
    return {
      total,
      items: rows.map((r) => {
        const payload = r.payload || {};
        const validation = r.validation || {};
        return {
          revisionId: r.revisionId,
          siteId: r.siteId,
          createdAt: r.createdAt.toISOString(),
          createdBy: r.createdBy,
          source: payload._source || 'save_draft',
          version: payload.draftVersion || null,
          validationOk: !!validation.ok,
          errorCount: (validation.errors && validation.errors.length) || 0,
          summary: {
            packageCount: (payload.packages && payload.packages.length) || 0,
            addOnCount: (payload.addOns && payload.addOns.length) || 0,
            vehicleClassCount: (payload.vehicleClasses && payload.vehicleClasses.length) || 0,
            unresolvedConflicts: (payload.priceConflicts || []).filter((c) => c.status === 'unresolved').length,
          },
        };
      }),
    };
  }

  async function restoreRevisionAsNewDraft(siteId, revisionId, expectedVersion, actor) {
    const rev = await getCatalogRevision(siteId, revisionId);
    if (!rev) {
      const err = new Error('revision_not_found');
      err.code = 'revision_not_found';
      err.statusCode = 404;
      throw err;
    }
    const payload = { ...(rev.payload || {}) };
    delete payload.draftVersion;
    delete payload.version;
    delete payload._source;
    delete payload.updatedAt;
    delete payload.updatedBy;
    delete payload.lastSavedAt;
    delete payload.lastSavedBy;
    const result = await saveCatalogDraft(siteId, expectedVersion, payload, actor);
    await recordAuditEvent(siteId, actor, 'catalog.draft.restore', {
      entityType: 'CatalogRevision',
      entityId: revisionId,
      detail: { newRevisionId: result.revisionId, expectedVersion },
    });
    return result;
  }

  async function readCatalogEntities(siteId) {
    const draft = await getCatalogDraft(siteId);
    if (!draft) {
      return { packages: [], addOns: [], vehicleClasses: [], priceConflicts: [], unmappedContent: [] };
    }
    return {
      packages: draft.packages,
      addOns: draft.addOns,
      vehicleClasses: draft.vehicleClasses,
      priceConflicts: draft.priceConflicts,
      unmappedContent: draft.unmappedContent,
    };
  }

  async function recordAuditEvent(siteId, actor, action, metadata = {}) {
    const id = assertSiteId(siteId);
    return prisma.osAuditLog.create({
      data: {
        siteId: id,
        actor: String(actor || 'unknown'),
        action: String(action || 'unknown'),
        entityType: metadata.entityType || null,
        entityId: metadata.entityId || null,
        detail: metadata.detail || undefined,
      },
    });
  }

  return {
    kind: 'postgres',
    ensureSite,
    getCatalogDraft,
    createCatalogDraft,
    saveCatalogDraft,
    getCatalogRevision,
    listCatalogRevisions,
    restoreRevisionAsNewDraft,
    readCatalogEntities,
    recordAuditEvent,
  };
}

function getDefaultCatalogRepository() {
  // Prefer postgres when DATABASE_URL is configured; otherwise memory for unit tests.
  try {
    const { tryGetPrisma } = require('../prisma');
    const client = tryGetPrisma();
    if (client) return createPostgresCatalogRepository(client);
  } catch (_) {
    /* fall through */
  }
  return createMemoryCatalogRepository();
}

module.exports = {
  SITE_ID,
  emptyPayload,
  sanitizeDraftResponse,
  createMemoryCatalogRepository,
  createPostgresCatalogRepository,
  getDefaultCatalogRepository,
  conflictError,
};
