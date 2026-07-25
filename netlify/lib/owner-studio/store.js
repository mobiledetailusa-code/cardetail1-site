'use strict';

/**
 * Stage 1 in-memory store for services/tests.
 * Production Postgres models are defined in prisma/schema + migration (not applied in Stage 1).
 * Never silently falls back to writing production when staging is required — callers must
 * not invoke apply against DATABASE_URL for Owner Studio migrations.
 */

function createMemoryStore() {
  return {
    sites: new Map(),
    drafts: new Map(), // siteId -> draft
    revisions: [],
    releases: new Map(), // releaseId -> release
    currentPointer: new Map(), // siteId -> releaseId
    audit: [],
    media: new Map(),
  };
}

let defaultStore = createMemoryStore();

function getStore() {
  return defaultStore;
}

function resetStore(store) {
  defaultStore = store || createMemoryStore();
  return defaultStore;
}

module.exports = {
  createMemoryStore,
  getStore,
  resetStore,
};
