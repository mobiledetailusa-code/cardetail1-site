'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const {
  finishJobQuickOps,
  reviewMessage,
  setFinishAdminActionRunner,
} = require('../netlify/lib/quick-ops-finish');
const { projectQuickOpsBooking } = require('../netlify/lib/admin-quick-ops-view');
const { quickOpsPage } = require('../netlify/lib/quick-ops-html');
const {
  dismissOrphanRequests,
  strictBookingLookup,
} = require('../netlify/lib/orphan-request-dismissal');

const ENV = { CONTEXT: 'production', SITE_URL: 'https://cardetail1.com' };

function confirmedJob(extra = {}) {
  return {
    id: extra.id || `CD1-FINISH-${Math.random().toString(36).slice(2, 8)}`,
    bookingVersion: 4,
    quoteVersion: 1,
    schemaVersion: 1,
    finalizedAt: '2026-11-01T15:00:00.000Z',
    firstName: 'Pat',
    lastName: 'Customer',
    phone: '2015550144',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    status: 'Confirmed',
    paymentMethodPreference: 'cash_onsite',
    approvedFinalAmount: 120,
    totalPrice: 120,
    paymentStatus: 'paid_cash',
    paymentWorkflowStatus: 'cash_paid',
    ledger: {
      currency: 'usd',
      approvedCents: 12000,
      settledCents: 12000,
      creditedCents: 0,
      entries: [{ entryId: 'le_cash', kind: 'settlement', method: 'cash', amountCents: 12000, currency: 'usd' }],
    },
    ...extra,
  };
}

function response(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}

describe('QuickOps "Mark job finished"', () => {
  afterEach(() => setFinishAdminActionRunner(null));

  it('runs complete_service then approve_completion, never a saved-card charge', async () => {
    const calls = [];
    setFinishAdminActionRunner(async (body) => {
      calls.push(body);
      if (body.action === 'admin_tech_status') return response(200, { ok: true });
      return response(200, {
        ok: true,
        jobStatus: 'completed_paid',
        reviewRequest: { queued: true, skipped: false, reason: null },
      });
    });
    const result = await finishJobQuickOps(confirmedJob({ id: 'CD1-F1' }));
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((c) => c.action), ['admin_tech_status', 'approve_completion']);
    assert.equal(calls[0].statusAction, 'complete_service');
    assert.equal(calls[1].confirmSavedCardCharge, false);
    assert.match(result.message, /Review request sent/);
  });

  it('skips the first step when the tech already completed the job', async () => {
    const calls = [];
    setFinishAdminActionRunner(async (body) => {
      calls.push(body.action);
      return response(200, { ok: true, jobStatus: 'completed_paid', reviewRequest: null });
    });
    await finishJobQuickOps(confirmedJob({ jobStatus: 'completed_pending_admin_review' }));
    assert.deepEqual(calls, ['approve_completion']);
  });

  it('is idempotent for a finished job and refuses a cancelled one', async () => {
    setFinishAdminActionRunner(async () => { throw new Error('must not run'); });
    const done = await finishJobQuickOps(confirmedJob({ jobStatus: 'completed_paid' }));
    assert.equal(done.ok, true);
    assert.equal(done.idempotent, true);
    const cancelled = await finishJobQuickOps(confirmedJob({ appointmentStatus: 'cancelled' }));
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error, 'cancelled');
  });

  it('surfaces a failed step instead of claiming success', async () => {
    setFinishAdminActionRunner(async () => response(409, { ok: false, error: 'version_conflict' }));
    const result = await finishJobQuickOps(confirmedJob());
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'version_conflict');
  });

  it('explains why a review request was not sent', () => {
    assert.match(reviewMessage({ skipped: true, reason: 'booking_sms_consent_required' }), /not allowed texts/);
    assert.match(reviewMessage({ skipped: true, reason: 'suppressed' }), /not allowed texts/);
    assert.match(reviewMessage({ skipped: true, reason: 'review_not_available' }), /already reviewed/);
  });

  it('offers the button only on a confirmed, unfinished job', () => {
    const open = projectQuickOpsBooking(confirmedJob());
    assert.equal(open.actions.finish, true);
    assert.match(quickOpsPage(open, 'csrf').body, /data-action="finish_job"/);
    assert.equal(projectQuickOpsBooking(confirmedJob({ appointmentStatus: 'pending_review', jobStatus: 'pending_review', status: '' })).actions.finish, false);
    assert.equal(projectQuickOpsBooking(confirmedJob({ jobStatus: 'completed_paid' })).actions.finish, false);
    assert.equal(projectQuickOpsBooking(confirmedJob({ appointmentStatus: 'cancelled' })).actions.finish, false);
  });

  it('end to end: the real handler finishes the job and reports the review outcome', async () => {
    const previousPostgres = process.env.CD1_POSTGRES_PAYMENT;
    delete process.env.CD1_POSTGRES_PAYMENT;
    const seed = confirmedJob({ id: 'CD1-FINISH-E2E' });
    const store = createCasMemoryStore({ [seed.id]: seed });
    setBookingStoreOverride(store);
    try {
      const result = await finishJobQuickOps(seed, { env: ENV });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.jobStatus, 'completed_paid');
      // Customer SMS is off in this env, so the review request is skipped, not sent.
      assert.ok(result.reviewRequest, 'approve_completion reports the review outcome');
      assert.equal(result.reviewRequest.queued, false);
      const saved = JSON.parse(store._data.get(seed.id).value);
      assert.equal(saved.jobStatus, 'completed_paid');
      assert.ok(saved.completedAt);
      const again = await finishJobQuickOps(saved, { env: ENV });
      assert.equal(again.idempotent, true);
    } finally {
      setBookingStoreOverride(null);
      if (previousPostgres != null) process.env.CD1_POSTGRES_PAYMENT = previousPostgres;
    }
  });
});

function requestStore(records) {
  const data = new Map(Object.entries(records).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const writes = [];
  return {
    data,
    writes,
    async get(key) { return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null; },
    async setJSON(key, value) { writes.push(key); data.set(key, JSON.parse(JSON.stringify(value))); },
  };
}

describe('dismiss_orphan_requests', () => {
  const bookings = {
    'CD1-LIVE': { id: 'CD1-LIVE', firstName: 'Real', jobStatus: 'confirmed' },
    'CD1-ARCH': { id: 'CD1-ARCH', firstName: 'Magno', isTest: true, archived: true, jobStatus: 'archived_test' },
  };
  const getBooking = async (id) => bookings[id] || null;
  const records = {
    cr_missing: { id: 'cr_missing', bookingId: 'CD1-B1-MULTI-51727-1', status: 'pending', requestType: 'vehicle_remove_request' },
    cr_arch: { id: 'cr_arch', bookingId: 'CD1-ARCH', status: 'needs_clarification', requestType: 'maintenance_request' },
    cr_live: { id: 'cr_live', bookingId: 'CD1-LIVE', status: 'pending', requestType: 'addon_request' },
    cr_done: { id: 'cr_done', bookingId: 'CD1-B1-MULTI-2', status: 'applied' },
  };

  it('dismisses only requests whose booking is missing or archived as a test', async () => {
    const store = requestStore(records);
    const result = await dismissOrphanRequests({ store, getBooking }, {
      requestIds: ['cr_missing', 'cr_arch', 'cr_live', 'cr_done', 'cr_nope'],
      now: '2026-11-11T12:00:00.000Z',
    });
    assert.equal(result.dismissed, 2);
    assert.deepEqual(store.writes.sort(), ['cr_arch', 'cr_missing']);
    const byId = Object.fromEntries(result.results.map((r) => [r.requestId, r]));
    assert.equal(byId.cr_live.error, 'booking_active');
    assert.equal(byId.cr_done.error, 'not_open');
    assert.equal(byId.cr_nope.error, 'not_found');
    const saved = store.data.get('cr_missing');
    assert.equal(saved.status, 'dismissed');
    assert.equal(saved.previousStatus, 'pending');
    assert.equal(saved.dismissedBy, 'admin');
    assert.equal(store.data.get('cr_live').status, 'pending');
  });

  it('dry run writes nothing; a second run is idempotent', async () => {
    const store = requestStore(records);
    const dry = await dismissOrphanRequests({ store, getBooking }, { requestIds: ['cr_missing'], dryRun: true });
    assert.equal(dry.eligible, 1);
    assert.equal(dry.dismissed, 0);
    assert.equal(store.writes.length, 0);
    await dismissOrphanRequests({ store, getBooking }, { requestIds: ['cr_missing'] });
    const again = await dismissOrphanRequests({ store, getBooking }, { requestIds: ['cr_missing'] });
    assert.equal(again.results[0].idempotent, true);
    assert.equal(store.writes.length, 1);
  });

  it('a booking lookup failure never reads as "missing"', async () => {
    const store = requestStore(records);
    const result = await dismissOrphanRequests({
      store,
      getBooking: async () => { throw new Error('blobs down'); },
    }, { requestIds: ['cr_missing'] });
    assert.equal(result.dismissed, 0);
    assert.equal(result.results[0].error, 'booking_lookup_failed');
    assert.equal(store.writes.length, 0);
  });

  it('strictBookingLookup indexes by key and payload id, and throws on read errors', async () => {
    const ok = {
      list: async () => ({ blobs: [{ key: 'key-a' }, { key: 'occupancy-claim/x' }] }),
      get: async (key) => (key === 'key-a' ? { id: 'CD1-A', firstName: 'A' } : { at: 'x', nonce: 'y' }),
    };
    const lookup = await strictBookingLookup(ok);
    assert.equal((await lookup('CD1-A')).firstName, 'A');
    assert.equal((await lookup('key-a')).firstName, 'A');
    assert.equal(await lookup('CD1-NONE'), null);
    const broken = {
      list: async () => ({ blobs: [{ key: 'key-a' }] }),
      get: async () => { throw new Error('read failed'); },
    };
    await assert.rejects(strictBookingLookup(broken), /read failed/);
  });

  it('the admin endpoint scans every open request and keeps live ones', async () => {
    const adminSecurity = require('../netlify/lib/admin-security');
    const realVerify = adminSecurity.verifyAdminRequest;
    adminSecurity.verifyAdminRequest = async () => ({ ok: true });
    delete require.cache[require.resolve('../netlify/functions/admin-customer-requests')];
    const fn = require('../netlify/functions/admin-customer-requests');
    const store = requestStore(records);
    store.list = async () => ({ blobs: [...store.data.keys()].map((key) => ({ key })) });
    fn.setRequestStoreOverride(store);
    fn.setBookingLookupOverride(getBooking);
    try {
      const call = (body) => fn.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
      const dry = JSON.parse((await call({ action: 'dismiss_orphan_requests', scanAll: true, dryRun: true })).body);
      assert.equal(dry.eligible, 2);
      assert.equal(store.writes.length, 0);
      const res = await call({ action: 'dismiss_orphan_requests', scanAll: true });
      const body = JSON.parse(res.body);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(body.dismissed, 2);
      assert.equal(body.refused, 1, 'the live booking request is kept');
      assert.equal(store.data.get('cr_live').status, 'pending');
    } finally {
      fn.setRequestStoreOverride(null);
      fn.setBookingLookupOverride(null);
      adminSecurity.verifyAdminRequest = realVerify;
      delete require.cache[require.resolve('../netlify/functions/admin-customer-requests')];
    }
  });
});
