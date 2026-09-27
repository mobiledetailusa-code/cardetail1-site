'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getStore } = require('@netlify/blobs');
const { BlobsServer } = require('@netlify/blobs/server');

const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
const { setSlotIndexStoreOverride, indexedOccupancyForDates } = require('../netlify/lib/slot-index');
const { DRAFT_SLOT_HOLD_MS } = require('../netlify/lib/booking-schedule');

const WEEKDAY = '2026-10-05';
const TOKEN = 'isolated-blobs-token';

function ceramicBody(extra = {}) {
  return {
    isDraft: true,
    firstName: 'Probe',
    lastName: 'Isolated',
    phone: '2015550140',
    email: 'probe-isolated@example.com',
    zipCode: '07601',
    address: '100 Test St',
    paymentMethodPreference: 'cash_onsite',
    cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false,
    acceptedBookingPolicy: true,
    preferredDate: WEEKDAY,
    preferredTime: '8:00 AM',
    preferredArrivalWindow: '08:00-11:00',
    scheduleFlexibility: 'exact',
    ceramicPaymentPlan: 'prepay_full',
    ceramicEligibility: {
      repainted60: 'no',
      clearCoatFailing: 'no',
      severeContamination: 'no',
      matteWrapPpf: 'no',
      coveredCureArea: 'yes',
      remainDry12h: 'yes',
    },
    vehicleCategory: 'cars',
    vehicle: 'Large SUV',
    package: 'Professional Ceramic Protection — Up to 3 Years',
    vehicles: [{
      cat: 'cars',
      pkgId: 'ceramic_3yr',
      pkgName: 'Professional Ceramic Protection — Up to 3 Years',
      tierKey: 'suv3',
      vehicleLabel: 'Large SUV',
      basePrice: 1275,
      subtotal: 1530,
      companionInterior: true,
      companionInteriorPrice: 255,
      addons: [],
      addonTotal: 0,
    }],
    totalPrice: 1530,
    ...extra,
  };
}

function forwardingStore(real, hooks = {}) {
  return {
    async get(key, opts) { return real.get(key, opts); },
    async getWithMetadata(key, opts) { return real.getWithMetadata(key, opts); },
    async delete(key) { return real.delete(key); },
    async list(opts) { return real.list(opts); },
    async setJSON(key, value, opts) {
      if (hooks.beforeSet) await hooks.beforeSet(key, value);
      return real.setJSON(key, value, opts);
    },
  };
}

async function collectKeys(store, prefix) {
  const keys = [];
  const listed = await store.list({ prefix: prefix || '', paginate: true });
  if (listed && typeof listed[Symbol.asyncIterator] === 'function') {
    for await (const page of listed) {
      for (const blob of (page && page.blobs) || []) keys.push(blob.key);
    }
    return keys;
  }
  for (const blob of (listed && listed.blobs) || []) keys.push(blob.key);
  return keys;
}

let server;
let directory;
let submitBooking;
let bookings;
let slots;
let envSnap;

function snapshotEnv() {
  return {
    CONTEXT: process.env.CONTEXT,
    DRAFT_TOKEN_SECRET: process.env.DRAFT_TOKEN_SECRET,
    NETLIFY_DEV: process.env.NETLIFY_DEV,
    CD1_CERAMIC_DEPOSITS: process.env.CD1_CERAMIC_DEPOSITS,
  };
}

function restoreEnv(snap) {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(async () => {
  envSnap = snapshotEnv();
  process.env.CONTEXT = 'dev';
  process.env.DRAFT_TOKEN_SECRET = 'd'.repeat(32);
  process.env.NETLIFY_DEV = 'true';
  process.env.CD1_CERAMIC_DEPOSITS = '1';
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cd1-blobs-'));
  server = new BlobsServer({ directory, token: TOKEN });
  const started = await server.start();
  const edgeURL = `http://127.0.0.1:${started.port}`;
  const open = (name) => getStore({
    edgeURL,
    name,
    token: TOKEN,
    siteID: 'isolated-preview-site',
  });
  bookings = open('cd1-bookings');
  slots = open('cd1-slot-index');
  delete require.cache[SUBMIT_PATH];
  submitBooking = require('../netlify/functions/submit-booking');
  submitBooking.__test.setBlobsStoreOverride(async () => bookings);
  setSlotIndexStoreOverride(slots);
});

afterEach(async () => {
  try { submitBooking.__test.setBlobsStoreOverride(null); } catch { /* ignore */ }
  setSlotIndexStoreOverride(null);
  if (server) await server.stop();
  restoreEnv(envSnap);
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

async function post(body, ip, headers = {}) {
  const res = await submitBooking.handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': ip, host: 'cardetail1.com', ...headers },
    body: JSON.stringify(body),
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch { parsed = {}; }
  return { status: res.statusCode, body: parsed };
}

function finalizeBody(draftBody, draftResponse, extra = {}) {
  return {
    ...draftBody,
    isDraft: false,
    draftBookingId: draftResponse.id,
    draftSaveToken: draftResponse.draftSaveToken,
    acceptedBookingPolicy: true,
    ...extra,
  };
}

test('deploy preview refuses a booking before it touches the shared store', async () => {
  process.env.CONTEXT = 'deploy-preview';
  const refused = await post(ceramicBody(), '203.0.113.50');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'preview_booking_disabled');
  assert.equal(refused.body.bookingCreated, false);
  assert.equal((await collectKeys(bookings)).length, 0);
  assert.equal((await collectKeys(slots)).length, 0);

  process.env.CONTEXT = 'dev';
  const byHost = await post(ceramicBody({ phone: '2015550141' }), '203.0.113.51', {
    host: 'deploy-preview-327--cardetail1.netlify.app',
  });
  assert.equal(byHost.status, 403);
  assert.equal(byHost.body.error, 'preview_booking_disabled');
  assert.equal((await collectKeys(bookings)).length, 0);
  assert.equal((await collectKeys(slots)).length, 0);
});

test('isolated blobs keep a confirmed 12-hour span and a retry does not duplicate it', async () => {
  const payload = ceramicBody({ phone: '2015550142' });
  const draft = await post(payload, '203.0.113.60');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const draftKeys = await collectKeys(slots);
  assert.equal(draftKeys.length, 6);
  assert.ok(draftKeys.every((key) => key.includes('/draft/')));

  const fin = await post(finalizeBody(payload, draft.body), '203.0.113.61');
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.bookingCreated, true);
  const saved = await bookings.get(fin.body.id, { type: 'json' });
  assert.equal(saved.isDraft, false);
  assert.equal(saved.appointmentStatus, 'pending_review');
  assert.equal(saved.paymentStatus, 'unpaid');
  assert.equal(saved.appointmentDurationMinutes, 720);
  const bookedKeys = await collectKeys(slots);
  const decodedBooked = bookedKeys.map((key) => decodeURIComponent(key));
  assert.equal(bookedKeys.length, 6, bookedKeys.join('\n'));
  assert.ok(decodedBooked.every((key) => key.startsWith(`${WEEKDAY}/`) || key.startsWith('2026-10-06/')), decodedBooked.join('\n'));
  assert.ok(decodedBooked.every((key) => key.includes('/booked/') && key.endsWith('/' + saved.id)), decodedBooked.join('\n'));
  assert.ok(decodedBooked.some((key) => key.startsWith('2026-10-06/8:00 AM/')), decodedBooked.join('\n'));
  assert.ok(decodedBooked.some((key) => key.startsWith('2026-10-06/10:00 AM/')), decodedBooked.join('\n'));
  const afterHold = Date.now() + DRAFT_SLOT_HOLD_MS + 60 * 1000;
  const occupancy = await indexedOccupancyForDates([WEEKDAY, '2026-10-06', '2026-10-07'], { nowMs: afterHold });
  assert.equal(occupancy.ok, true, JSON.stringify(occupancy));
  for (const time of ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM']) {
    assert.equal(occupancy.occupancy[`${WEEKDAY}|${time}`], 1, time);
  }
  assert.equal(occupancy.occupancy['2026-10-06|8:00 AM'], 1);
  assert.equal(occupancy.occupancy['2026-10-06|10:00 AM'], 1);
  assert.equal(occupancy.occupancy['2026-10-06|12:00 PM'], undefined);
  assert.equal(occupancy.occupancy['2026-10-07|8:00 AM'], undefined);

  const again = await post(finalizeBody(payload, draft.body), '203.0.113.62');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.id, fin.body.id);
  assert.equal((await collectKeys(bookings)).length, 1);
  assert.equal((await collectKeys(slots)).length, 6);

  const conflict = await post(ceramicBody({
    phone: '2015550143',
    preferredDate: '2026-10-06',
    preferredArrivalWindow: '08:00-11:00',
  }), '203.0.113.63');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.bookingCreated, false);
  assert.equal(conflict.body.error, 'booking_slot_unavailable');
  assert.equal((await collectKeys(bookings)).length, 1);
});

test('a failed booking write can be retried once, and a partial index write still reports success', async () => {
  const payload = ceramicBody({ phone: '2015550144' });
  let failBookingWrite = false;
  const realBookings = bookings;
  bookings = forwardingStore(realBookings, {
    beforeSet() {
      if (failBookingWrite) {
        failBookingWrite = false;
        throw new Error('injected booking write failure');
      }
    },
  });
  submitBooking.__test.setBlobsStoreOverride(async () => bookings);

  const draft = await post(payload, '203.0.113.70');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal((await collectKeys(slots)).length, 6);

  failBookingWrite = true;
  const failed = await post(finalizeBody(payload, draft.body), '203.0.113.71');
  assert.equal(failed.status, 500);
  assert.equal(failed.body.ok, false);
  assert.notEqual(failed.body.bookingCreated, true);
  const stillDraft = await realBookings.get(draft.body.id, { type: 'json' });
  assert.equal(stillDraft.isDraft, true);
  assert.equal((await collectKeys(slots)).filter((key) => key.includes('/draft/')).length, 6);

  const retried = await post(finalizeBody(payload, draft.body), '203.0.113.72');
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.bookingCreated, true);
  assert.equal(retried.body.id, draft.body.id);
  assert.equal((await collectKeys(realBookings)).length, 1);
  assert.equal((await collectKeys(slots)).filter((key) => key.includes('/booked/')).length, 6);
});

test('index partial failure leaves the finalized record and a retry does not restore the slots', async () => {
  const payload = ceramicBody({ phone: '2015550145' });
  const draft = await post(payload, '203.0.113.80');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));

  let armed = false;
  let sets = 0;
  const realSlots = slots;
  const faultySlots = forwardingStore(realSlots, {
    beforeSet() {
      if (!armed) return;
      sets += 1;
      if (sets === 3) throw new Error('injected partial index write');
    },
  });
  setSlotIndexStoreOverride(faultySlots);
  armed = true;

  const fin = await post(finalizeBody(payload, draft.body), '203.0.113.81');
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.bookingCreated, true);
  const saved = await bookings.get(fin.body.id, { type: 'json' });
  assert.equal(saved.isDraft, false);
  assert.ok(saved.finalizedAt);
  const leftover = await collectKeys(realSlots);
  assert.equal(leftover.length, 0, leftover.join('\n'));

  setSlotIndexStoreOverride(realSlots);
  const again = await post(finalizeBody(payload, draft.body), '203.0.113.82');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.id, fin.body.id);
  assert.equal((await collectKeys(bookings)).length, 1);
  const afterRetry = await collectKeys(realSlots);
  assert.equal(afterRetry.length, 0, afterRetry.join('\n'));
});
