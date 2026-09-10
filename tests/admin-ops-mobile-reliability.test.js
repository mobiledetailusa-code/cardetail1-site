'use strict';

/**
 * Admin Ops mobile reliability — last-known-good snapshot, first-load
 * coalesce, bounded retry, and jobs-primary refresh semantics.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SS = require('../assets/admin-source-state.js');
const Refresh = require('../assets/operational-refresh.js');
const adminOps = fs.readFileSync(path.join(root, 'admin-ops.html'), 'utf8');
const refreshSrc = fs.readFileSync(path.join(root, 'assets/operational-refresh.js'), 'utf8');

function memoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function sampleJobs() {
  return [
    {
      id: 'CD1-100',
      bookingId: 'CD1-100',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '2015550100',
      package: 'Interior Detail',
      vehicleLabel: '2020 Honda Civic',
      preferredDate: '2026-09-12',
      preferredTime: '10:00',
      confirmedDate: '2026-09-12',
      confirmedTimeWindow: '10:00-12:00',
      serviceAddress: '12 Main St, Jersey City NJ',
      issueNotes: 'Gate code 12',
      jobStatus: 'confirmed',
      assignedTechName: 'Alex',
      stripeCustomerId: 'cus_secret',
      paymentIntentId: 'pi_secret',
      adminToken: 'tok_secret',
      eventLog: [{ t: 1, m: 'x'.repeat(200) }],
    },
  ];
}

function makeController(opts) {
  const fakeDoc = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  return Refresh.createRefreshController(Object.assign({
    window: {
      setTimeout, clearTimeout, AbortController,
      addEventListener() {}, removeEventListener() {},
      document: fakeDoc, navigator: { onLine: true },
    },
    document: fakeDoc,
    navigator: { onLine: true },
    setTimeout, clearTimeout,
  }, opts));
}

describe('Admin Ops mobile reliability', () => {
  beforeEach(() => {
    global.localStorage = memoryStorage();
    SS.clearJobsSnapshot();
  });

  it('1. first load success stores snapshot and marks hasLoaded contract', () => {
    let meta = SS.createSourceMeta();
    const start = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(start.meta, start.generation).meta;
    assert.equal(meta.hasLoaded, true);
    assert.equal(meta.error, null);
    assert.equal(SS.saveJobsSnapshot(sampleJobs(), Date.now()), true);
    const snap = SS.loadJobsSnapshot();
    assert.ok(snap);
    assert.equal(snap.jobs.length, 1);
    assert.equal(snap.jobs[0].id, 'CD1-100');
    assert.equal(snap.jobs[0].phone, '2015550100');
    assert.match(adminOps, /SS\.saveJobsSnapshot/);
    assert.match(adminOps, /jobsFreshLoaded\s*=\s*true/);
  });

  it('2. cold open with cache + network failure keeps snapshot visible (no fatal empty)', () => {
    SS.saveJobsSnapshot(sampleJobs(), Date.now() - 5 * 60 * 1000);
    const snap = SS.loadJobsSnapshot();
    assert.ok(snap && snap.jobs.length);

    let meta = SS.createSourceMeta();
    meta = Object.assign({}, meta, { hasLoaded: true, lastSuccessAt: snap.savedAt });
    const start = SS.beginSourceLoad(meta);
    const fail = SS.applySourceFailure(start.meta, start.generation, 'timeout');
    assert.equal(fail.preserveData, true);
    assert.equal(fail.meta.hasLoaded, true);
    assert.equal(snap.jobs.length, 1);

    const msg = SS.staleRefreshMessage(snap.savedAt, false);
    assert.match(msg, /Unable to refresh/i);
    assert.match(msg, /last updated/i);
    assert.doesNotMatch(msg, /Up to date/i);

    assert.match(adminOps, /jobsInitialFail = !!\(jobsMeta && jobsMeta\.error && !jobsMeta\.hasLoaded && !jobs\.length\)/);
    assert.match(adminOps, /showSnapshotBanner/);
    assert.match(adminOps, /hydrateJobsSnapshotIfAvailable/);
  });

  it('3. expired / malformed cache is ignored safely', () => {
    global.localStorage.setItem(SS.JOBS_SNAPSHOT_KEY, '{not-json');
    assert.equal(SS.loadJobsSnapshot(), null);

    global.localStorage.setItem(SS.JOBS_SNAPSHOT_KEY, JSON.stringify({
      schemaVersion: 999,
      savedAt: Date.now(),
      jobs: sampleJobs(),
    }));
    assert.equal(SS.loadJobsSnapshot(), null);

    global.localStorage.setItem(SS.JOBS_SNAPSHOT_KEY, JSON.stringify({
      schemaVersion: SS.JOBS_SNAPSHOT_SCHEMA,
      savedAt: Date.now() - (SS.JOBS_SNAPSHOT_TTL_MS + 1000),
      jobs: sampleJobs(),
    }));
    assert.equal(SS.loadJobsSnapshot(), null);
  });

  it('4. first-load in-flight is not superseded by focus/visibility; follow-up coalesced', async () => {
    let ready = false;
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const c = makeController({
      controllerKey: 'mobile-rel-4',
      isPrimaryReady: () => ready,
      requestTimeoutMs: 8000,
      onRefresh: async () => {
        calls += 1;
        await gate;
        return { ok: true };
      },
    });

    const p1 = c.refresh('initial');
    const p2 = c.refresh('focus', { supersede: true });
    const p3 = c.refresh('visibility', { supersede: true });
    const p4 = c.refresh('online', { supersede: true });
    assert.equal(calls, 1);
    assert.equal(c.getState().coalesceRequested, true);
    release();
    await Promise.all([p1, p2, p3, p4]);
    assert.equal(calls, 2);
    c.destroy();
  });

  it('5. first-load transient failure allows one bounded retry', () => {
    assert.match(adminOps, /const maxAttempts = jobsFreshLoaded \? 1 : 2/);
    assert.match(adminOps, /const canRetry = !jobsFreshLoaded && attempt < maxAttempts && transient/);
    assert.match(adminOps, /setTimeout\(r,\s*1500\)/);
    assert.match(adminOps, /msg === 'timeout'/);
  });

  it('6. auth failure does not blind-retry', () => {
    assert.match(adminOps, /status === 401 \|\| status === 403/);
    assert.match(adminOps, /session expired|unauthorized/i);
    assert.match(adminOps, /const permanent = authFail/);
    assert.match(adminOps, /canRetry = !jobsFreshLoaded && attempt < maxAttempts && transient/);
  });

  it('7. jobs success + change-requests failure remains usable', () => {
    assert.match(adminOps, /Primary operational source is Jobs/);
    assert.match(adminOps, /const syncFailure = jobsR\.status === 'rejected' \? jobsR\.reason : null/);
    assert.doesNotMatch(adminOps, /const syncFailure = jobsR\.status === 'rejected' \? jobsR\.reason\s*:\s*\(changeR/);
  });

  it('8. later poll failure preserves previous jobs (in-memory contract)', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    const jobs = sampleJobs();
    const s2 = SS.beginSourceLoad(meta);
    const fail = SS.applySourceFailure(s2.meta, s2.generation, 'HTTP 502');
    assert.equal(fail.preserveData, true);
    assert.equal(fail.meta.hasLoaded, true);
    assert.equal(jobs.length, 1);
    assert.match(adminOps, /Intentionally do NOT assign jobs=\[\].*on rejection/s);
  });

  it('9. online/focus burst coalesces before first ready', async () => {
    let ready = false;
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const c = makeController({
      controllerKey: 'mobile-rel-9',
      isPrimaryReady: () => ready,
      onRefresh: async () => {
        calls += 1;
        await gate;
        return { ok: true };
      },
    });
    c.refresh('initial');
    c.refresh('focus', { supersede: true });
    c.refresh('online', { supersede: true });
    c.refresh('visibility', { supersede: true });
    c.refresh('poll', { supersede: true });
    assert.equal(calls, 1);
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(calls <= 2, 'no refresh storm, got ' + calls);
    c.destroy();
  });

  it('10. logout clears operational snapshot', () => {
    assert.match(adminOps, /SS\.clearJobsSnapshot/);
    SS.saveJobsSnapshot(sampleJobs(), Date.now());
    assert.ok(SS.loadJobsSnapshot());
    SS.clearJobsSnapshot();
    assert.equal(SS.loadJobsSnapshot(), null);
  });

  it('security: snapshot strips tokens and payment secrets', () => {
    SS.saveJobsSnapshot(sampleJobs(), Date.now());
    const raw = global.localStorage.getItem(SS.JOBS_SNAPSHOT_KEY);
    assert.ok(raw);
    assert.doesNotMatch(raw, /cus_secret|pi_secret|tok_secret|eventLog|stripeCustomerId|paymentIntentId|adminToken/);
    const snap = SS.loadJobsSnapshot();
    const row = snap.jobs[0];
    assert.equal(row.stripeCustomerId, undefined);
    assert.equal(row.paymentIntentId, undefined);
    assert.equal(row.adminToken, undefined);
    assert.equal(row.eventLog, undefined);
    assert.equal(row.firstName, 'Ada');
    assert.equal(row.serviceAddress, '12 Main St, Jersey City NJ');
  });

  it('wiring: first-load protect + jobs-primary + snapshot hydrate present', () => {
    assert.match(adminOps, /isPrimaryReady:\s*\(\)\s*=>\s*!!jobsFreshLoaded/);
    assert.match(adminOps, /hydrateJobsSnapshotIfAvailable\(\)/);
    assert.equal(SS.JOBS_SNAPSHOT_KEY, 'cardetail1.admin.jobs.lastKnownGood.v1');
    assert.match(refreshSrc, /isPrimaryReady/);
    assert.match(refreshSrc, /coalesceRequested/);
    assert.match(refreshSrc, /Protect the first primary load/);
  });
});
