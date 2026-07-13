'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { buildRevopsDashboard } = require('../netlify/lib/revops-dashboard');
const revenueStore = require('../netlify/lib/revenue-store');

const qaPath = require.resolve('../netlify/functions/qa-revops-lifecycle.js');
const householdPath = require.resolve('../netlify/lib/revenue-household.js');
const storePath = require.resolve('../netlify/lib/revenue-store.js');

function withMockedStores(run) {
  const store = {
    data: new Map(),
    async set(key, value) { this.data.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async get(key, opts = {}) {
      const raw = this.data.get(key);
      if (raw == null) return null;
      if (opts.type === 'text') return raw;
      try { return JSON.parse(raw); } catch { return raw; }
    },
    async delete(key) { this.data.delete(key); },
    async list() {
      return { blobs: [...this.data.keys()].map((key) => ({ key })) };
    },
  };

  const stores = { events: store, opportunities: store, leads: store, households: store };
  const realStore = require(storePath);
  const orig = {
    getRevenueStore: realStore.getRevenueStore,
    blobListKeys: realStore.blobListKeys,
    blobGetJson: realStore.blobGetJson,
    blobSetJson: realStore.blobSetJson,
  };

  realStore.getRevenueStore = async (name) => stores[name] || store;
  realStore.blobListKeys = async (s, opts = {}) => {
    const listing = await s.list();
    let keys = ((listing && listing.blobs) || []).map((b) => b.key);
    if (opts.prefix) keys = keys.filter((k) => k.startsWith(opts.prefix));
    return keys.slice(0, opts.limit || keys.length);
  };
  realStore.blobGetJson = async (s, key) => {
    const raw = await s.get(key, { type: 'text' });
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  realStore.blobSetJson = async (s, key, value) => {
    await s.set(key, JSON.stringify(value));
  };

  delete require.cache[householdPath];
  delete require.cache[qaPath];
  const qaMod = require(qaPath);

  return run({ store, qaMod }).finally(() => {
    Object.assign(realStore, orig);
    delete require.cache[householdPath];
    delete require.cache[qaPath];
    require(qaPath);
  });
}

test('qa-revops seed stores opportunities under opp_ keys', async () => {
  await withMockedStores(async ({ store, qaMod }) => {
    const result = await qaMod.__test.seedQaFixtures();
    assert.ok(result.eventsSeeded >= 8);
    const oppKeys = [...store.data.keys()].filter((k) => k.startsWith('opp_'));
    assert.ok(oppKeys.length >= 5, `expected opp_ keys, got ${oppKeys.join(',')}`);

    const dash = await buildRevopsDashboard({});
    assert.equal(dash.ok, true);
    assert.ok(dash.summary.sessions > 0);
    assert.ok(dash.summary.garagePlanRequests > 0);
    const reasons = new Set((dash.priorityQueue || []).map((i) => i.attentionReason));
    assert.ok(reasons.has('garage_plan_request'));
    assert.ok(reasons.has('payment_step_abandonment'));
    assert.ok(reasons.has('failed_customer_notification'));
    assert.ok(!(dash.priorityQueue || []).some((i) => i.garagePlanStatus === 'converted_to_booking'));
    assert.ok(!(dash.priorityQueue || []).some((i) => i.stage === 'Confirmed'));

    const removed = await qaMod.__test.cleanupQa();
    assert.ok(removed >= 1);
  });
});

test('qa-revops malformed record is skipped with warning', async () => {
  const store = {
    data: new Map(),
    async set(key, value) { this.data.set(key, value); },
    async get(key) { return this.data.get(key) ?? null; },
    async delete(key) { this.data.delete(key); },
    async list() {
      return { blobs: [...this.data.keys()].map((key) => ({ key })) };
    },
  };

  const origGet = revenueStore.getRevenueStore;
  const origList = revenueStore.blobListKeys;
  const origGetJson = revenueStore.blobGetJson;

  revenueStore.getRevenueStore = async () => store;
  revenueStore.blobListKeys = async (s) => {
    const listing = await s.list();
    return ((listing && listing.blobs) || []).map((b) => b.key);
  };
  revenueStore.blobGetJson = async (s, key) => {
    const raw = await s.get(key);
    if (!raw) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return null; }
    }
    return raw;
  };

  try {
    const key = `opp_QA_REVOPS_malformed`;
    await store.set(key, '{ invalid');
    const dash = await buildRevopsDashboard({});
    assert.equal(dash.ok, true);
    assert.ok((dash.warnings || []).some((w) => String(w).includes('skipped_malformed_opportunities')));
    await store.delete(key);
  } finally {
    revenueStore.getRevenueStore = origGet;
    revenueStore.blobListKeys = origList;
    revenueStore.blobGetJson = origGetJson;
  }
});

test('qa-revops function file is branch-only and uses verifyAdminKey', () => {
  const src = read('netlify/functions/qa-revops-lifecycle.js');
  assert.match(src, /operations-core-job-lifecycle/);
  assert.match(src, /verifyAdminKey/);
  assert.match(src, /QA-REVOPS/);
  assert.match(src, /seed_malformed/);
});
