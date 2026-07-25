'use strict';

const { SITE_ID, assertSiteId } = require('./ids');
const { useLegacyPublicContent } = require('./flags');
const { resolveCurrentRelease } = require('./release-service');

function readPublishedSiteContent(siteId = SITE_ID) {
  const id = assertSiteId(siteId);
  if (useLegacyPublicContent()) {
    return {
      source: 'legacy',
      siteId: id,
      releaseId: null,
      content: null,
      message: 'PUBLIC_CONTENT_SOURCE=legacy — use HTML/partials',
    };
  }
  const release = resolveCurrentRelease(id);
  if (!release) {
    return {
      source: 'legacy-fallback',
      siteId: id,
      releaseId: null,
      content: null,
      message: 'No published Owner Studio release; falling back to legacy',
    };
  }
  return {
    source: 'owner-studio',
    siteId: id,
    releaseId: release.releaseId,
    publishedAt: release.publishedAt,
    content: release.snapshots['site-content/current.json'],
  };
}

module.exports = {
  readPublishedSiteContent,
};
