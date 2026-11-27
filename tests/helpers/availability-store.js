'use strict';

/**
 * Operational availability no longer falls back to legacy defaults when its
 * store cannot be read (it fails closed). Tests that run booking handlers
 * outside Netlify therefore install an explicit in-memory store.
 *
 * An empty store means "never configured", which resolves to the legacy
 * defaults — the same calendar these tests always exercised.
 */
const { createCasMemoryStore } = require('./cas-memory-store');

function useDefaultAvailabilityStore(config) {
  const store = createCasMemoryStore(config ? { availability: config } : {});
  require('../../netlify/lib/ops-config').setAvailabilityStoreOverride(store);
  return store;
}

module.exports = { useDefaultAvailabilityStore };
