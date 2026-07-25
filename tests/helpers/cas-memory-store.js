'use strict';

/**
 * In-memory Blob store with real onlyIfMatch / onlyIfNew CAS semantics.
 * Used to force interleaving races in concurrency tests.
 */
function createCasMemoryStore(seed = {}) {
  const data = new Map();
  let etagCounter = 0;

  for (const [k, v] of Object.entries(seed)) {
    const etag = `etag-${++etagCounter}`;
    data.set(k, { value: JSON.stringify(v), etag });
  }

  return {
    _data: data,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      const parsed = JSON.parse(entry.value);
      return opts && opts.type === 'json' ? parsed : entry.value;
    },
    async getWithMetadata(key, opts = {}) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      const parsed = JSON.parse(entry.value);
      return {
        data: opts.type === 'json' ? parsed : entry.value,
        etag: entry.etag,
        metadata: {},
      };
    },
    async setJSON(key, value, options = {}) {
      const exists = data.has(key);
      if (options.onlyIfNew && exists) return { modified: false };
      if (options.onlyIfMatch) {
        if (!exists || data.get(key).etag !== options.onlyIfMatch) {
          return { modified: false };
        }
      }
      const etag = `etag-${++etagCounter}`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
    async delete(key) {
      data.delete(key);
    },
    /** Test helper: force a hang between getWithMetadata and setJSON. */
    installConsumeHook(hook) {
      const originalGet = this.getWithMetadata.bind(this);
      const originalSet = this.setJSON.bind(this);
      this.getWithMetadata = async (...args) => {
        const result = await originalGet(...args);
        if (typeof hook.afterGet === 'function') await hook.afterGet(result);
        return result;
      };
      this.setJSON = async (...args) => {
        if (typeof hook.beforeSet === 'function') await hook.beforeSet(...args);
        return originalSet(...args);
      };
    },
  };
}

module.exports = { createCasMemoryStore };
