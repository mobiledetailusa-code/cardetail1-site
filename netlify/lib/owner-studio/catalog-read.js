'use strict';

const { SITE_ID, assertSiteId } = require('./ids');
const { getOwnerStudioFlags, useLegacyPublicContent } = require('./flags');
const { resolveCurrentRelease } = require('./release-service');
const { readDraft } = require('./draft-service');

/**
 * Public/catalog reads. Never returns incomplete drafts to public callers.
 */
function readPublishedCatalog(siteId = SITE_ID) {
  const id = assertSiteId(siteId);
  const flags = getOwnerStudioFlags();
  if (useLegacyPublicContent()) {
    return {
      source: 'legacy',
      siteId: id,
      releaseId: null,
      catalog: null,
      message: 'PUBLIC_CONTENT_SOURCE=legacy — use booking-price-catalog.js',
    };
  }
  const release = resolveCurrentRelease(id);
  if (!release) {
    return {
      source: 'legacy-fallback',
      siteId: id,
      releaseId: null,
      catalog: null,
      message: 'No published Owner Studio release; falling back to legacy',
    };
  }
  return {
    source: 'owner-studio',
    siteId: id,
    releaseId: release.releaseId,
    publishedAt: release.publishedAt,
    catalog: release.snapshots['catalog/current.json'],
    enabled: flags.enabled,
  };
}

function readOwnerStudioDraft(identity, siteId = SITE_ID) {
  const { authorizeOwnerStudio } = require('./authorization');
  authorizeOwnerStudio(identity, 'edit_draft');
  return readDraft(siteId);
}

module.exports = {
  readPublishedCatalog,
  readOwnerStudioDraft,
};
