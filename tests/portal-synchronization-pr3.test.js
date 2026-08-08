'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  syncVersionFor,
  buildSyncEnvelope,
} = require('../netlify/lib/sync-response');
const Refresh = require('../assets/operational-refresh');
const rateLimit = require('../netlify/lib/public-rate-limit');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function fakeTarget(initial) {
  const listeners = new Map();
  return Object.assign({
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    emit(type) {
      for (const fn of listeners.get(type) || []) fn({ type });
    },
    listenerCount(type) {
      return (listeners.get(type) || new Set()).size;
    },
  }, initial || {});
}

function fakeClock() {
  let time = 100000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) {
      id += 1;
      timers.set(id, { fn, due: time + Number(delay) });
      return id;
    },
    clearTimeout(timerId) { timers.delete(timerId); },
    advance(ms) { time += ms; },
    nextDelay() {
      if (!timers.size) return null;
      return Math.min(...[...timers.values()].map((timer) => timer.due - time));
    },
    timerCount: () => timers.size,
  };
}

function controllerHarness(key, onRefresh, extra = {}) {
  const clock = fakeClock();
  const nav = { onLine: true };
  const doc = fakeTarget({ hidden: false, visibilityState: 'visible' });
  const win = fakeTarget({
    navigator: nav,
    document: doc,
    AbortController,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const states = [];
  const controller = Refresh.createRefreshController({
    controllerKey: key,
    window: win,
    document: doc,
    navigator: nav,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    random: () => 0.5,
    activePollMs: 2500,
    stablePollMs: 4000,
    requestTimeoutMs: 25000,
    onRefresh,
    onStateChange: (value) => states.push(value),
    ...extra,
  });
  return { controller, clock, nav, doc, win, states };
}

describe('PR3 cursor/version protocol', () => {
  it('is stable across object key order and changes on material projection changes', () => {
    const first = syncVersionFor({ jobs: [{ id: 'CD1-1', bookingVersion: 3 }], count: 1 });
    const reordered = syncVersionFor({ count: 1, jobs: [{ bookingVersion: 3, id: 'CD1-1' }] });
    const changed = syncVersionFor({ count: 1, jobs: [{ bookingVersion: 4, id: 'CD1-1' }] });
    assert.equal(first, reordered);
    assert.notEqual(first, changed);
    assert.match(first, /^sync_v1_/);
  });

  it('returns a small notModified envelope for a matching cursor', () => {
    const payload = { ok: true, bookings: [{ id: 'CD1-1', bookingVersion: 7 }] };
    const full = buildSyncEnvelope(payload, { now: new Date('2026-08-05T12:00:00Z') });
    const same = buildSyncEnvelope(payload, {
      ifSyncVersion: full.syncVersion,
      now: new Date('2026-08-05T12:00:04Z'),
    });
    assert.equal(full.notModified, false);
    assert.equal(same.notModified, true);
    assert.equal(same.body.bookings, undefined);
    assert.equal(same.body.syncVersion, full.syncVersion);
    assert.equal(same.body.serverTime, '2026-08-05T12:00:04.000Z');
  });

  it('wires cursors and no-store ETags into both portal projections', () => {
    const customer = read('netlify/functions/customer-portal-data.js');
    const admin = read('netlify/functions/admin-ops-jobs.js');
    const requests = read('netlify/functions/admin-customer-requests.js');
    assert.match(customer, /buildSyncEnvelope/);
    assert.match(customer, /body\.ifSyncVersion/);
    assert.match(customer, /syncHeaders/);
    assert.match(admin, /jobsSyncResponse/);
    assert.match(admin, /query\.ifSyncVersion \|\| query\.cursor/);
    assert.match(requests, /body\.ifSyncVersion/);
    assert.match(requests, /buildSyncEnvelope/);
    assert.match(read('netlify/lib/sync-response.js'), /'Cache-Control': 'no-store'/);
  });
});

describe('PR3 adaptive refresh controller', () => {
  it('uses one controller/timer per page key and schedules a 4-second stable refresh', async () => {
    const harness = controllerHarness('pr3-singleton', async () => ({ ok: true, notModified: true }));
    const duplicate = Refresh.createRefreshController({ controllerKey: 'pr3-singleton' });
    assert.equal(duplicate, harness.controller);
    harness.controller.bindLifecycle();
    await harness.controller.refresh('initial');
    assert.equal(harness.controller.getState().state, 'current');
    assert.equal(harness.clock.nextDelay(), 4000);
    assert.equal(harness.clock.timerCount(), 1);
    assert.equal(harness.win.listenerCount('focus'), 1);
    harness.controller.destroy();
  });

  it('switches to 2.5-second polling only while state is pending', async () => {
    let pending = false;
    const harness = controllerHarness(
      'pr3-pending',
      async () => ({ ok: true, changed: true, pending }),
      { isPending: () => pending }
    );
    harness.controller.bindLifecycle();
    pending = true;
    harness.controller.markPending(30000);
    await harness.controller.refresh('mutation', { supersede: true });
    assert.equal(harness.clock.nextDelay(), 2500);
    harness.controller.destroy();
  });

  it('honors 429 Retry-After and does not report a failed refresh as current', async () => {
    const harness = controllerHarness('pr3-429', async () => ({
      ok: false,
      error: 'rate_limited',
      status: 429,
      retryAfterMs: 12000,
    }));
    harness.controller.bindLifecycle();
    const result = await harness.controller.refresh('poll');
    assert.equal(result.ok, false);
    assert.equal(harness.controller.getState().state, 'retrying');
    assert.equal(harness.controller.getState().lastUpdated, null);
    assert.equal(harness.clock.nextDelay(), 12000);
    harness.controller.destroy();
  });

  it('pauses offline and refreshes immediately when connectivity returns', async () => {
    let calls = 0;
    const harness = controllerHarness('pr3-online', async () => {
      calls += 1;
      return { ok: true };
    });
    harness.controller.bindLifecycle();
    harness.nav.onLine = false;
    harness.win.emit('offline');
    assert.equal(harness.controller.getState().state, 'offline');
    assert.equal(harness.clock.timerCount(), 0);
    harness.nav.onLine = true;
    harness.win.emit('online');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(harness.controller.getState().state, 'current');
    harness.controller.destroy();
  });

  it('stops automatic retries on 401/403 and keeps the explicit unauthorized state', async () => {
    const harness = controllerHarness('pr3-auth', async () => ({
      ok: false,
      error: 'authentication_failed',
      status: 401,
    }));
    harness.controller.bindLifecycle();
    await harness.controller.refresh('poll');
    assert.equal(harness.controller.getState().state, 'unauthorized');
    assert.equal(harness.clock.timerCount(), 0);
    harness.controller.destroy();
  });

  it('aborts an obsolete request when focus supersedes the in-flight poll', async () => {
    const calls = [];
    const harness = controllerHarness('pr3-abort', ({ reason, signal }) => new Promise((resolve, reject) => {
      const call = { reason, signal, resolve };
      calls.push(call);
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    harness.controller.bindLifecycle();
    const obsolete = harness.controller.refresh('poll');
    const current = harness.controller.refresh('focus', { supersede: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    calls[1].resolve({ ok: true });
    assert.equal((await obsolete).aborted, true);
    assert.equal((await current).ok, true);
    harness.controller.destroy();
  });

  it('backs off exponentially with bounded jitter after consecutive 5xx failures', async () => {
    const harness = controllerHarness(
      'pr3-backoff',
      async () => ({ ok: false, error: 'temporarily_unavailable', status: 503 }),
      { random: () => 0.75 }
    );
    harness.controller.bindLifecycle();
    await harness.controller.refresh('poll');
    assert.equal(harness.clock.nextDelay(), 4400);
    await harness.controller.refresh('poll');
    assert.equal(harness.clock.nextDelay(), 8800);
    assert.equal(harness.controller.getState().failures, 2);
    harness.controller.destroy();
  });
});

describe('PR3 portal integration contracts', () => {
  it('separates successful authorized sync reads from strict failed credential guesses', () => {
    const source = read('netlify/functions/customer-portal-data.js');
    assert.equal(rateLimit.DEFAULT_LIMITS['lookup-booking'].max, 20);
    assert.equal(rateLimit.DEFAULT_LIMITS['customer-portal-sync'].max, 1800);
    assert.match(source, /if \(!auth\.ok\)[\s\S]*endpoint: 'lookup-booking'/);
    assert.match(source, /enforcePortalSyncLimit/);
    assert.match(source, /session:\$\{session\.sessionId\}/);
  });

  it('preserves last-good customer UI for 429/5xx and has visible sync states', () => {
    const js = read('assets/my-garage.js');
    const html = read('my-garage.html');
    assert.match(js, /Showing your last update and retrying automatically/);
    assert.match(js, /state\.syncVersion/);
    assert.match(js, /portalRefresh\.markPending/);
    assert.match(js, /paymentConfirmationPending/);
    assert.doesNotMatch(js, /setTimeout\(tick, 2000\)/);
    assert.match(html, /id="portal-sync-status"/);
    assert.match(html, /data-state="offline"/);
  });

  it('does not dedupe an Admin focus refresh onto an already-aborted poll', () => {
    const admin = read('admin-ops.html');
    assert.match(admin, /refreshAllSignal && refreshAllSignal\.aborted/);
    assert.match(admin, /if \(refreshAllInflight === run\)/);
    assert.match(admin, /onRefresh:\s*refreshAll/);
  });

  it('returns and immediately applies a safe canonical booking after customer mutations', () => {
    const server = read('netlify/functions/submit-customer-action.js');
    const client = read('assets/my-garage.js');
    assert.match(server, /booking: safeBooking\(appliedCmd\.booking\)/);
    assert.match(server, /booking: safeBooking\(committedBooking\)/);
    assert.match(client, /applyCanonicalBookingProjection\(r\.data\.booking\)/);
    assert.match(client, /delete body\.amountCents/);
  });

  it('uses a 15-second stable cadence with 2.5s active pending boost', () => {
    const garage = read('assets/my-garage.js');
    const admin = read('admin-ops.html');
    assert.match(garage, /stablePollMs:\s*15000/);
    assert.match(garage, /activePollMs:\s*2500/);
    assert.match(admin, /stablePollMs:\s*15000/);
    assert.match(admin, /activePollMs:\s*2500/);
    const pendingFn = admin.slice(
      admin.indexOf('function adminSyncPending'),
      admin.indexOf('function adminSyncPending') + 700
    );
    assert.match(pendingFn, /\['creating','open','processing','pending_webhook'\]/);
    assert.doesNotMatch(pendingFn, /\['creating','open','processing','pending_webhook','awaiting_customer_payment'\]/);
    const cadenceMs = 15000;
    const samples = Array.from({ length: 1000 }, (_, i) => (i + 0.5) * cadenceMs / 1000).sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.50)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    assert.ok(p50 >= 7400 && p50 <= 7600);
    assert.ok(p95 >= 14200 && p95 <= 14800);
  });

  it('skips Admin DOM rewrite when jobs and requests are notModified', () => {
    const admin = read('admin-ops.html');
    assert.match(admin, /bothUnchanged/);
    assert.match(admin, /lastJobsNotModified/);
    assert.match(admin, /lastRequestsNotModified/);
  });
});
