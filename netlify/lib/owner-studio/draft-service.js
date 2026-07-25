'use strict';

const { getStore } = require('./store');
const { assertSiteId, newId, SITE_ID } = require('./ids');
const {
  validatePackageDraft,
  validateAddOnDraft,
  validateNavigation,
  validateFooter,
  validatePageContent,
  validateReleaseCandidate,
} = require('./schemas');
const { appendAuditEvent } = require('./audit');
const { authorizeOwnerStudio } = require('./authorization');

function emptyDraft(siteId) {
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
    updatedAt: null,
  };
}

function readDraft(siteId = SITE_ID) {
  const id = assertSiteId(siteId);
  const store = getStore();
  if (!store.drafts.has(id)) store.drafts.set(id, emptyDraft(id));
  // Return a clone so callers cannot mutate store by accident without save
  return JSON.parse(JSON.stringify(store.drafts.get(id)));
}

function saveDraft(identity, draftInput) {
  authorizeOwnerStudio(identity, 'edit_draft');
  const siteId = assertSiteId(draftInput.siteId || SITE_ID);
  const packages = (draftInput.packages || []).map(validatePackageDraft);
  const addOns = (draftInput.addOns || []).map(validateAddOnDraft);
  const navigation = draftInput.navigation
    ? validateNavigation({ ...draftInput.navigation, siteId })
    : { siteId, headerItems: [] };
  const footer = draftInput.footer
    ? validateFooter({ ...draftInput.footer, siteId })
    : { siteId, tagline: '', groups: [], legalLinks: [], copyright: '' };
  const pages = (draftInput.pages || []).map((p) => validatePageContent({ ...p, siteId }));

  const draft = {
    ...emptyDraft(siteId),
    packages,
    addOns,
    vehicleClasses: draftInput.vehicleClasses || [],
    navigation,
    footer,
    pages,
    galleries: draftInput.galleries || [],
    serviceAreas: draftInput.serviceAreas || [],
    media: draftInput.media || [],
    updatedAt: new Date().toISOString(),
  };

  getStore().drafts.set(siteId, draft);
  appendAuditEvent({
    siteId,
    actor: identity.username,
    action: 'draft.save',
    entityType: 'CatalogDraft',
    entityId: siteId,
  });
  return readDraft(siteId);
}

function createRevision(identity, siteId = SITE_ID) {
  authorizeOwnerStudio(identity, 'edit_draft');
  const id = assertSiteId(siteId);
  const draft = readDraft(id);
  const validation = validateReleaseCandidate(
    { packages: draft.packages, addOns: draft.addOns },
    { navigation: draft.navigation, footer: draft.footer }
  );
  const revision = {
    revisionId: newId('rev'),
    siteId: id,
    createdAt: new Date().toISOString(),
    createdBy: identity.username,
    validation,
    snapshot: draft,
  };
  getStore().revisions.push(revision);
  appendAuditEvent({
    siteId: id,
    actor: identity.username,
    action: 'revision.create',
    entityType: 'CatalogRevision',
    entityId: revision.revisionId,
    detail: { ok: validation.ok, errorCount: validation.errors.length },
  });
  return revision;
}

module.exports = {
  emptyDraft,
  readDraft,
  saveDraft,
  createRevision,
};
