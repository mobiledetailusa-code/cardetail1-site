'use strict';

/**
 * Customer Lifecycle draft repository — PostgreSQL with optimistic concurrency.
 * Never publishes; never touches bookings/payments.
 */

const { assertSiteId, newId, SITE_ID } = require('./ids');
const { defaultMembershipDraftPayload } = require('../customer-lifecycle/membership-foundation');

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
    maintenanceRules: payload.maintenanceRules || defaultMembershipDraftPayload().maintenanceRules,
    membershipPlans: payload.membershipPlans || defaultMembershipDraftPayload().membershipPlans,
    simulatorAssumptions: payload.simulatorAssumptions || defaultMembershipDraftPayload().simulatorAssumptions,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : payload.updatedAt || null,
    updatedBy: row.updatedBy || payload.updatedBy || null,
  };
}

function createCustomerLifecycleRepository(prisma) {
  if (!prisma) throw new Error('prisma_required');

  async function ensureSite(siteId) {
    assertSiteId(siteId);
    const existing = await prisma.osSite.findUnique({ where: { siteId } });
    if (existing) return existing;
    return prisma.osSite.create({
      data: { siteId, name: 'Detailing Zone', status: 'active' },
    });
  }

  async function getDraft(siteId = SITE_ID) {
    await ensureSite(siteId);
    let row = await prisma.osCustomerLifecycleDraft.findFirst({ where: { siteId } });
    if (!row) {
      const payload = defaultMembershipDraftPayload();
      payload.siteId = siteId;
      row = await prisma.osCustomerLifecycleDraft.create({
        data: {
          id: newId('oscld'),
          siteId,
          payload,
          version: 1,
          updatedBy: 'system',
        },
      });
    }
    return sanitizeDraftResponse(row);
  }

  async function listRevisions(siteId = SITE_ID, { limit = 30 } = {}) {
    await ensureSite(siteId);
    const rows = await prisma.osCustomerLifecycleRevision.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });
    return rows.map((r) => ({
      revisionId: r.revisionId,
      siteId: r.siteId,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
      validation: r.validation,
    }));
  }

  async function saveDraft(siteId, expectedVersion, payload, actor) {
    await ensureSite(siteId);
    const expected = Math.round(Number(expectedVersion));
    if (!Number.isFinite(expected) || expected < 1) {
      const err = new Error('expectedVersion is required');
      err.code = 'validation_failed';
      err.statusCode = 400;
      throw err;
    }

    return prisma.$transaction(async (tx) => {
      let existing = await tx.osCustomerLifecycleDraft.findFirst({ where: { siteId } });
      if (!existing) {
        existing = await tx.osCustomerLifecycleDraft.create({
          data: {
            id: newId('oscld'),
            siteId,
            payload: defaultMembershipDraftPayload(),
            version: 1,
            updatedBy: actor || 'system',
          },
        });
      }
      if (Number(existing.version) !== expected) {
        throw conflictError('stale_draft_version', 'Draft changed. Reload and retry.', {
          expectedVersion: expected,
          currentVersion: Number(existing.version),
        });
      }
      const nextVersion = expected + 1;
      const nextPayload = {
        ...defaultMembershipDraftPayload(),
        ...(payload || {}),
        siteId,
        draftVersion: nextVersion,
        updatedAt: new Date().toISOString(),
        updatedBy: actor || null,
      };
      const revisionId = newId('osclr');
      await tx.osCustomerLifecycleRevision.create({
        data: {
          revisionId,
          siteId,
          payload: nextPayload,
          validation: { ok: true },
          createdBy: actor || null,
        },
      });
      const updated = await tx.osCustomerLifecycleDraft.updateMany({
        where: { id: existing.id, version: expected },
        data: { version: nextVersion, payload: nextPayload, updatedBy: actor || null },
      });
      if (updated.count !== 1) {
        throw conflictError('stale_draft_version', 'Draft changed. Reload and retry.', {
          expectedVersion: expected,
          currentVersion: Number(existing.version),
        });
      }
      const row = await tx.osCustomerLifecycleDraft.findUnique({ where: { id: existing.id } });
      return { draft: sanitizeDraftResponse(row), revisionId };
    });
  }

  async function restoreRevisionAsNewDraft(siteId, revisionId, expectedVersion, actor) {
    const rev = await prisma.osCustomerLifecycleRevision.findFirst({
      where: { siteId, revisionId: String(revisionId || '') },
    });
    if (!rev) {
      const err = new Error('revision_not_found');
      err.code = 'revision_not_found';
      err.statusCode = 404;
      throw err;
    }
    const payload = typeof rev.payload === 'string' ? JSON.parse(rev.payload) : { ...(rev.payload || {}) };
    delete payload.draftVersion;
    delete payload.version;
    delete payload.updatedAt;
    delete payload.updatedBy;
    return saveDraft(siteId, expectedVersion, payload, actor);
  }

  return {
    getDraft,
    listRevisions,
    saveDraft,
    restoreRevisionAsNewDraft,
  };
}

module.exports = {
  createCustomerLifecycleRepository,
  conflictError,
};
