'use strict';

const crypto = require('crypto');

const SYNC_VERSION_PREFIX = 'sync_v1_';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      if (value[key] !== undefined) out[key] = stableValue(value[key]);
      return out;
    }, {});
}

function syncVersionFor(payload) {
  const serialized = JSON.stringify(stableValue(payload));
  const digest = crypto.createHash('sha256').update(serialized).digest('base64url').slice(0, 22);
  return `${SYNC_VERSION_PREFIX}${digest}`;
}

function normalizeSyncVersion(value) {
  const raw = String(value || '').trim();
  return raw.startsWith(SYNC_VERSION_PREFIX) && raw.length <= 80 ? raw : '';
}

/**
 * Cursor-based conditional response for authenticated/no-store portal reads.
 * The server still evaluates authority, but unchanged polls return a tiny body
 * and the browser never re-renders an older local snapshot.
 */
function buildSyncEnvelope(payload, { ifSyncVersion = '', now = new Date() } = {}) {
  const cleanPayload = payload && typeof payload === 'object' ? payload : {};
  const syncVersion = syncVersionFor(cleanPayload);
  const serverTime = new Date(now).toISOString();
  const unchanged = normalizeSyncVersion(ifSyncVersion) === syncVersion;

  if (unchanged) {
    return {
      body: {
        ok: true,
        notModified: true,
        syncVersion,
        serverTime,
      },
      syncVersion,
      notModified: true,
    };
  }

  return {
    body: {
      ...cleanPayload,
      notModified: false,
      syncVersion,
      serverTime,
    },
    syncVersion,
    notModified: false,
  };
}

function syncHeaders(syncVersion) {
  const version = normalizeSyncVersion(syncVersion);
  if (!version) return {};
  return {
    ETag: `W/"${version}"`,
    'X-Sync-Version': version,
    'Cache-Control': 'no-store',
  };
}

module.exports = {
  SYNC_VERSION_PREFIX,
  stableValue,
  syncVersionFor,
  normalizeSyncVersion,
  buildSyncEnvelope,
  syncHeaders,
};
