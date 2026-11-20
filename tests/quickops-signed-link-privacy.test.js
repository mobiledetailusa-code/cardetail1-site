'use strict';

/**
 * QuickOps Daily Dispatch — the signed SMS job link (/ops/t, tech-quick-ops)
 * must not bypass the technician PII policy: 12-hour America/New_York window,
 * terminal state in any status field, rescheduling, invalid schedules, and
 * reassignment. Each check runs against a live link session, re-reading the
 * booking on every request.
 */

const { describe, it, before, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
const { setSlotIndexStoreOverride } = require('../netlify/lib/slot-index');
const {
  setTechQuickOpsStoreFactories,
  resetTechQuickOpsStoreFactories,
} = require('../netlify/lib/tech-quick-ops-token');
const {
  assignQuickOpsTech,
  unassignQuickOpsTech,
  setQuickOpsTechRoster,
  resetQuickOpsTechRoster,
} = require('../netlify/lib/quick-ops-assign');
const { projectTechQuickOpsBooking } = require('../netlify/lib/tech-quick-ops-view');
const { techQuickOpsPage } = require('../netlify/lib/quick-ops-html');
const techHandler = require('../netlify/functions/tech-quick-ops');

const ID = 'CD1-TQ-PII';
// 2026-09-19 is EDT (UTC-4): a 9:00 AM ET arrival is 13:00Z; unlock is 01:00Z.
const START = Date.parse('2026-09-19T13:00:00.000Z');
const HOUR = 3600 * 1000;
const PII = /Alex|Rivera|Harbor View|201-?555-?0177|\+12015550177|Gate code/;

function booking(overrides = {}) {
  return {
    id: ID,
    firstName: 'Alex',
    lastName: 'Rivera',
    phone: '+12015550177',
    package: 'Interior Detail',
    preferredDate: '2026-09-19',
    preferredTime: '9:00 AM',
    confirmedDate: '2026-09-19',
    confirmedTime: '9:00 AM',
    confirmedTimeWindow: '9:00 AM - 10:00 AM',
    address: '12 Harbor View, Fort Lee, NJ',
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    bookingVersion: 1,
    quoteVersion: 1,
    approvedFinalAmount: 190,
    totalPrice: 190,
    techPayoutAmount: 120,
    notes: 'Gate code 12',
    accessNotes: 'Gate code 12, side door',
    vehicles: [{ year: 2025, make: 'Honda', model: 'Civic', category: 'cars' }],
    ledger: { currency: 'usd', approvedCents: 19000, settledCents: 0, creditedCents: 0, entries: [] },
    transactionalSmsConsentAccepted: true,
    changeRequests: [],
    ...overrides,
  };
}

let bookingStore;
let nowMock;

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CONTEXT = 'production';
  process.env.CD1_POSTGRES_PAYMENT = 'false';
  process.env.TECH_QUICK_OPS_SECRET = 'test-tech-quick-ops-secret-32chars';
});

beforeEach(() => {
  const tokenStore = createCasMemoryStore();
  const sessionStore = createCasMemoryStore();
  setTechQuickOpsStoreFactories({ tokenStore: () => tokenStore, sessionStore: () => sessionStore });
  setQuickOpsTechRoster(async () => [
    { techId: 'sam', fullName: 'Sam Lee', active: true, phone: '2015550199', smsConsent: true },
  ]);
  bookingStore = createCasMemoryStore({ [ID]: booking() });
  setBookingStoreOverride(bookingStore);
  setSlotIndexStoreOverride(createCasMemoryStore());
  nowMock = mock.method(Date, 'now', () => START - 14 * HOUR);
});

afterEach(() => {
  mock.restoreAll();
  resetTechQuickOpsStoreFactories();
  resetQuickOpsTechRoster();
  setBookingStoreOverride(null);
  setSlotIndexStoreOverride(null);
});

async function openLink(phone = '2015550123') {
  const rec = await getBookingRecord(ID);
  const assigned = await assignQuickOpsTech(rec.booking, { phone, skipSms: true });
  assert.equal(assigned.ok, true, assigned.message || assigned.error);
  const token = decodeURIComponent(assigned.techUrl.split('/').pop());
  const opened = await techHandler.handler({
    httpMethod: 'GET',
    path: `/ops/t/${token}`,
    rawUrl: `https://cardetail1.com/ops/t/${token}`,
    headers: { host: 'cardetail1.com', accept: 'text/html' },
  });
  assert.equal(opened.statusCode, 302);
  return String(opened.headers['Set-Cookie']).split(';')[0];
}

async function view(cookie, accept = 'application/json') {
  return techHandler.handler({
    httpMethod: 'GET',
    path: '/ops/t',
    headers: { cookie, host: 'cardetail1.com', accept },
  });
}

async function patchBooking(patch) {
  const rec = await getBookingRecord(ID);
  const next = { ...rec.booking, ...patch, bookingVersion: (Number(rec.booking.bookingVersion) || 0) + 1 };
  await bookingStore.setJSON(ID, next);
}

describe('signed SMS link (tech-quick-ops) honours the 12-hour PII policy', () => {
  it('locks before the window and unlocks inside it on the same session', async () => {
    const cookie = await openLink();

    let res = await view(cookie);
    assert.equal(res.statusCode, 200);
    let body = JSON.parse(res.body);
    assert.equal(body.view.piiLocked, true);
    assert.equal(body.view.piiLockReason, 'before_unlock_window');
    assert.equal(body.view.piiUnlocksAt, '2026-09-19T01:00:00.000Z');
    assert.equal(body.view.customer.name, 'Customer');
    assert.equal(body.view.service.address, '');
    assert.equal(body.view.telUrl, '');
    assert.equal(body.view.mapUrl, '');
    assert.equal(body.view.actions.call, false);
    assert.equal(body.view.actions.map, false);
    assert.equal(body.view.jobSheet.customerNote, '');
    assert.equal(body.view.jobSheet.accessNotes, '');
    assert.doesNotMatch(res.body, PII);
    // Operational fields stay so the technician can plan.
    assert.equal(body.view.service.package, 'Interior Detail');
    assert.match(body.view.service.date, /Sep 19, 2026/);
    assert.equal(body.view.yourPay.label, '$120');

    const html = await view(cookie, 'text/html');
    assert.equal(html.statusCode, 200);
    assert.doesNotMatch(html.body, PII);
    assert.match(html.body, /12 hours before the arrival window/);

    nowMock.mock.mockImplementation(() => START - 11 * HOUR);
    res = await view(cookie);
    body = JSON.parse(res.body);
    assert.equal(body.view.piiLocked, false);
    assert.equal(body.view.customer.name, 'Alex Rivera');
    assert.equal(body.view.service.address, '12 Harbor View, Fort Lee, NJ');
    assert.equal(body.view.actions.call, true);
  });

  it('relocks immediately when the job is rescheduled further out', async () => {
    nowMock.mock.mockImplementation(() => START - 2 * HOUR);
    const cookie = await openLink();
    assert.equal(JSON.parse((await view(cookie)).body).view.piiLocked, false);
    await patchBooking({ confirmedDate: '2026-09-22', preferredDate: '2026-09-22' });
    const res = await view(cookie);
    const body = JSON.parse(res.body);
    assert.equal(body.view.piiLocked, true);
    assert.equal(body.view.piiLockReason, 'before_unlock_window');
    assert.doesNotMatch(res.body, PII);
  });

  it('fails closed on an invalid or inconsistent schedule even on the service day', async () => {
    nowMock.mock.mockImplementation(() => START - HOUR);
    for (const [patch, reason] of [
      [{ confirmedTime: 'Morning', confirmedTimeWindow: '' }, 'invalid_time'],
      [{ preferredDate: '2026-09-20' }, 'inconsistent_date'],
    ]) {
      const fresh = await openLinkWith(patch);
      const res = await view(fresh);
      const body = JSON.parse(res.body);
      assert.equal(body.view.piiLocked, true, JSON.stringify(patch));
      assert.equal(body.view.piiLockReason, reason);
      assert.doesNotMatch(res.body, PII);
    }
  });

  it('a stale legacy Cancelled status locks the link even though jobStatus still says confirmed', async () => {
    nowMock.mock.mockImplementation(() => START - HOUR);
    const cookie = await openLink();
    await patchBooking({ status: 'Cancelled' });
    const res = await view(cookie);
    const body = JSON.parse(res.body);
    assert.equal(body.view.piiLocked, true);
    assert.equal(body.view.piiLockReason, 'cancelled');
    assert.equal(body.view.actions.call, false);
    assert.doesNotMatch(res.body, PII);
  });

  it('completion (any status field) locks the link while payment actions remain', async () => {
    nowMock.mock.mockImplementation(() => START + 2 * HOUR);
    const cookie = await openLink();
    await patchBooking({ serviceStatus: 'service_completed' });
    const res = await view(cookie);
    const body = JSON.parse(res.body);
    assert.equal(body.view.piiLocked, true);
    assert.equal(body.view.piiLockReason, 'completed');
    assert.equal(body.view.paymentDue, true, 'payment link actions are unchanged');
    assert.doesNotMatch(res.body, PII);
  });

  it('reassignment and unassignment end the old link session with no PII', async () => {
    nowMock.mock.mockImplementation(() => START - HOUR);
    const cookie = await openLink('2015550123');
    assert.equal(JSON.parse((await view(cookie)).body).view.piiLocked, false);

    const rec = await getBookingRecord(ID);
    const moved = await assignQuickOpsTech(rec.booking, { phone: '2015550124', skipSms: true });
    assert.equal(moved.ok, true);
    let res = await view(cookie);
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.body, PII);

    const cookie2 = await openLink('2015550125');
    const cur = await getBookingRecord(ID);
    assert.equal((await unassignQuickOpsTech(cur.booking, { by: 'admin' })).ok, true);
    res = await view(cookie2);
    assert.equal(res.statusCode, 401);
    assert.doesNotMatch(res.body, PII);
  });

  it('the projection itself redacts, so every POST response view is covered too', () => {
    const v = projectTechQuickOpsBooking(booking(), null, { nowMs: START - 13 * HOUR });
    assert.equal(v.piiLocked, true);
    assert.doesNotMatch(JSON.stringify(v), PII);
    const page = techQuickOpsPage(v, 'csrf');
    assert.doesNotMatch(page.body.replace(/<script[\s\S]*?<\/script>/g, ''), PII);
  });
});

async function openLinkWith(patch) {
  bookingStore = createCasMemoryStore({ [ID]: booking(patch) });
  setBookingStoreOverride(bookingStore);
  return openLink();
}
