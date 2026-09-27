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
    async set(key, value, opts) {
      if (hooks.beforeSet) await hooks.beforeSet(key, value);
      return real.set(key, value, opts);
    },
  };
}

async function bookingRecordKeys(store) {
  const keys = await collectKeys(store);
  return keys.filter((key) => !String(key).startsWith('occupancy-claim/'));
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
  submitBooking.__test.setBlobsStoreOverride(null);
  const refused = await post(ceramicBody(), '203.0.113.50');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'preview_booking_disabled');
  assert.equal(refused.body.bookingCreated, false);
  assert.equal((await collectKeys(bookings)).length, 0);
  assert.equal((await collectKeys(slots)).length, 0);

  process.env.CONTEXT = 'dev';
  submitBooking.__test.setBlobsStoreOverride(async () => bookings);
  const byHost = await post(ceramicBody({ phone: '2015550141' }), '203.0.113.51', {
    host: 'deploy-preview-327--cardetail1.netlify.app',
  });
  assert.equal(byHost.status, 403);
  assert.equal(byHost.body.error, 'preview_booking_disabled');
  assert.equal((await collectKeys(bookings)).length, 0);
  assert.equal((await collectKeys(slots)).length, 0);
});

test('isolated blobs keep a confirmed 12-hour span and a retry does not duplicate it', async () => {
  const payload = ceramicBody({ phone: '2015550142', email: 'span-blobs@example.com' });
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
  assert.equal((await bookingRecordKeys(bookings)).length, 1);
  assert.equal((await collectKeys(slots)).length, 6);

  const conflict = await post(ceramicBody({
    phone: '2015550143',
    preferredDate: '2026-10-06',
    preferredArrivalWindow: '08:00-11:00',
  }), '203.0.113.63');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.bookingCreated, false);
  assert.equal(conflict.body.error, 'booking_slot_unavailable');
  assert.equal((await bookingRecordKeys(bookings)).length, 1);
});

test('a failed booking write stays unconfirmed and retry finalizes once', async () => {
  const payload = ceramicBody({ phone: '2015550144', email: 'fail-write@example.com' });
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
  assert.equal((await bookingRecordKeys(realBookings)).length, 1);
  assert.equal((await collectKeys(slots)).filter((key) => key.includes('/booked/')).length, 6);
});

const SPAN_STARTS = ['2026-10-05', '2026-10-07', '2026-10-13', '2026-10-15', '2026-10-19', '2026-10-21'];

function nextWeekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const cursor = new Date(y, m - 1, d + 1);
  return [
    cursor.getFullYear(),
    String(cursor.getMonth() + 1).padStart(2, '0'),
    String(cursor.getDate()).padStart(2, '0'),
  ].join('-');
}

test('each of the six index writes can fail without confirming, and retry finishes the same booking', async () => {
  for (let failAt = 1; failAt <= 6; failAt += 1) {
    const start = SPAN_STARTS[failAt - 1];
    const continuation = nextWeekday(start);
    const phone = `20155502${String(failAt).padStart(2, '0')}`;
    const payload = ceramicBody({
      phone,
      preferredDate: start,
      email: `probe-${failAt}@example.com`,
    });
    const draft = await post(payload, `203.0.113.${80 + failAt}`);
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const foreignKey = `${continuation}/12:00 PM/booked/0/CD1-OTHER-${failAt}`;
    await slots.setJSON(foreignKey, 1);

    let armed = false;
    let sets = 0;
    const realSlots = slots;
    setSlotIndexStoreOverride(forwardingStore(realSlots, {
      beforeSet(key) {
        if (String(key).startsWith('span-claim/')) return;
        if (!armed) return;
        sets += 1;
        if (sets === failAt) throw new Error(`injected index write ${failAt}`);
      },
    }));
    armed = true;
    submitBooking.__test.resetNotificationAttempts();

    const failed = await post(finalizeBody(payload, draft.body), `203.0.113.${90 + failAt}`);
    assert.notEqual(failed.body.bookingCreated, true, `write ${failAt}`);
    assert.equal(failed.body.ok, false, JSON.stringify(failed.body));
    assert.equal(failed.body.error, 'occupancy_incomplete');
    assert.equal(failed.body.recoverable, true);
    assert.equal(failed.body.draftBookingId, draft.body.id);
    assert.equal(submitBooking.__test.notificationAttempts(), 0, `write ${failAt} notified`);
    const pending = await bookings.get(draft.body.id, { type: 'json' });
    assert.equal(pending.isDraft, true, `write ${failAt}`);
    assert.equal(pending.occupancyStatus, 'pending');
    assert.equal(pending.finalizedAt, undefined);
    const afterFail = (await collectKeys(realSlots)).map((key) => decodeURIComponent(key));
    assert.equal(afterFail.some((key) => key.includes('/booked/') && key.endsWith('/' + draft.body.id)), false, afterFail.join('\n'));
    assert.equal(afterFail.filter((key) => key.includes('/draft/') && key.endsWith('/' + draft.body.id)).length, 6, afterFail.join('\n'));
    assert.ok(afterFail.includes(foreignKey), afterFail.join('\n'));

    setSlotIndexStoreOverride(realSlots);
    const retried = await post(finalizeBody(payload, draft.body), `203.0.113.${100 + failAt}`);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.bookingCreated, true);
    assert.equal(retried.body.id, draft.body.id);
    assert.equal(submitBooking.__test.notificationAttempts(), 1, `write ${failAt} retry`);
    const saved = await bookings.get(draft.body.id, { type: 'json' });
    assert.equal(saved.isDraft, false);
    assert.ok(saved.finalizedAt);
    assert.equal(saved.occupancyStatus, 'complete');
    const booked = (await collectKeys(realSlots)).map((key) => decodeURIComponent(key));
    const mine = booked.filter((key) => key.endsWith('/' + saved.id));
    assert.equal(mine.length, 6, booked.join('\n'));
    assert.ok(mine.every((key) => key.includes('/booked/')));
    assert.ok(booked.includes(foreignKey), booked.join('\n'));

    const again = await post(finalizeBody(payload, draft.body), `203.0.113.${110 + failAt}`);
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.id, saved.id);
    assert.equal(submitBooking.__test.notificationAttempts(), 1);
  }
});

test('a crash after the pending record is stored does not confirm, and retry occupies the same id', async () => {
  const payload = ceramicBody({ phone: '2015550301', preferredDate: '2026-10-13', email: 'crash-pending@example.com' });
  const draft = await post(payload, '203.0.113.130');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  let pendingSeen = false;
  const realBookings = bookings;
  bookings = forwardingStore(realBookings, {
    async beforeSet(_key, value) {
      if (value && value.occupancyStatus === 'pending') pendingSeen = true;
      if (pendingSeen && value && value.isDraft === false) {
        throw new Error('interrupted before confirmation');
      }
    },
  });
  submitBooking.__test.setBlobsStoreOverride(async () => bookings);
  const realSlots = slots;
  setSlotIndexStoreOverride(forwardingStore(realSlots, {
    beforeSet() { throw new Error('interrupted before occupancy'); },
  }));
  submitBooking.__test.resetNotificationAttempts();

  const failed = await post(finalizeBody(payload, draft.body), '203.0.113.131');
  assert.equal(failed.body.bookingCreated, false);
  assert.notEqual(failed.body.bookingCreated, true);
  assert.equal(submitBooking.__test.notificationAttempts(), 0);
  const pending = await realBookings.get(draft.body.id, { type: 'json' });
  assert.equal(pendingSeen, true);
  assert.equal(pending.occupancyStatus, 'pending');
  assert.equal(pending.isDraft, true);
  assert.equal(pending.finalizedAt, undefined);
  const keys = (await collectKeys(realSlots)).map((key) => decodeURIComponent(key));
  assert.equal(keys.filter((key) => key.includes('/booked/') && key.endsWith('/' + draft.body.id)).length, 0);

  bookings = realBookings;
  submitBooking.__test.setBlobsStoreOverride(async () => bookings);
  setSlotIndexStoreOverride(realSlots);
  const retried = await post(finalizeBody(payload, draft.body), '203.0.113.132');
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.bookingCreated, true);
  assert.equal(retried.body.id, draft.body.id);
  assert.equal(submitBooking.__test.notificationAttempts(), 1);
  const saved = await realBookings.get(draft.body.id, { type: 'json' });
  assert.equal(saved.isDraft, false);
  assert.equal((await collectKeys(realSlots)).filter((key) => decodeURIComponent(key).endsWith('/' + saved.id) && key.includes('/booked/')).length, 6);
});

test('two concurrent requests for the same period confirm only one booking', async () => {
  const payload = ceramicBody({ phone: '2015550302', email: 'concurrent-same@example.com' });
  const draft = await post(payload, '203.0.113.140');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  submitBooking.__test.resetNotificationAttempts();
  const body = finalizeBody(payload, draft.body);
  const [first, second] = await Promise.all([
    post(body, '203.0.113.141'),
    post(body, '203.0.113.142'),
  ]);
  const created = [first, second].filter((res) => res.body.bookingCreated === true);
  assert.ok(created.length >= 1, JSON.stringify([first.body, second.body]));
  assert.ok(created.every((res) => res.body.id === draft.body.id && res.status === 200));
  const fresh = created.filter((res) => res.body.idempotent !== true);
  assert.equal(fresh.length, 1, JSON.stringify([first.body, second.body]));
  assert.equal((await bookingRecordKeys(bookings)).length, 1);
  const saved = await bookings.get(draft.body.id, { type: 'json' });
  assert.equal(saved.isDraft, false);
  const mine = (await collectKeys(slots)).filter((key) => decodeURIComponent(key).endsWith('/' + draft.body.id));
  assert.equal(mine.length, 6, mine.join('\n'));
  assert.equal(submitBooking.__test.notificationAttempts(), 1);

  const rival = await post(ceramicBody({
    phone: '2015550303',
    email: 'rival@example.com',
  }), '203.0.113.143');
  assert.equal(rival.status, 409);
  assert.equal(rival.body.bookingCreated, false);
  assert.equal((await bookingRecordKeys(bookings)).length, 1);
});

test('two concurrent customers for the same period confirm only one booking', async () => {
  const date = '2026-10-27';
  const firstBody = ceramicBody({
    phone: '2015550310',
    email: 'span-a@example.com',
    preferredDate: date,
  });
  const secondBody = ceramicBody({
    phone: '2015550311',
    email: 'span-b@example.com',
    preferredDate: date,
  });
  const [draftA, draftB] = await Promise.all([
    post(firstBody, '203.0.113.160'),
    post(secondBody, '203.0.113.161'),
  ]);
  const drafts = [draftA, draftB].filter((res) => res.status === 200 && res.body.id);
  assert.ok(drafts.length >= 1, JSON.stringify([draftA.body, draftB.body]));
  submitBooking.__test.resetNotificationAttempts();

  const finalized = await Promise.all(drafts.map((draft, index) => {
    const source = draft.body.id === draftA.body.id ? firstBody : secondBody;
    return post(finalizeBody(source, draft.body), `203.0.113.${170 + index}`);
  }));
  let winners = finalized.filter((res) => res.body.bookingCreated === true);
  assert.ok(winners.length <= 1, JSON.stringify(finalized.map((res) => res.body)));

  if (!winners.length) {
    const retry = await post(finalizeBody(firstBody, drafts[0].body), '203.0.113.172');
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.bookingCreated, true);
    winners = [retry];
  }

  const winnerId = winners[0].body.id;
  const saved = await bookings.get(winnerId, { type: 'json' });
  assert.equal(saved.isDraft, false);
  assert.equal(saved.occupancyStatus, 'complete');
  const records = await bookingRecordKeys(bookings);
  const confirmedRecords = [];
  for (const key of records) {
    const row = await bookings.get(key, { type: 'json' });
    if (row && row.isDraft === false && row.finalizedAt) confirmedRecords.push(row.id);
  }
  assert.deepEqual(confirmedRecords, [winnerId]);
  assert.equal(submitBooking.__test.notificationAttempts(), 1);
  const booked = (await collectKeys(slots)).map((key) => decodeURIComponent(key));
  const winnerSlots = booked.filter((key) => key.includes('/booked/') && key.endsWith('/' + winnerId));
  assert.equal(winnerSlots.length, 6, booked.join('\n'));
  const otherConfirmed = booked.filter((key) => key.includes('/booked/') && !key.endsWith('/' + winnerId) && !key.includes('/CD1-OTHER'));
  assert.equal(otherConfirmed.length, 0, booked.join('\n'));

  const loser = drafts.find((draft) => draft.body.id !== winnerId);
  if (loser) {
    const source = loser.body.id === draftA.body.id ? firstBody : secondBody;
    const rejected = await post(finalizeBody(source, loser.body), '203.0.113.173');
    assert.equal(rejected.body.bookingCreated, false);
    assert.notEqual(rejected.status, 200);
  }
});

test('a foreign hold on a required slot is kept and blocks confirmation', async () => {
  const payload = ceramicBody({ phone: '2015550304', preferredDate: '2026-10-14', email: 'foreign-hold@example.com' });
  const draft = await post(payload, '203.0.113.150');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const foreignKey = '2026-10-15/8:00 AM/booked/0/CD1-OTHER-HOLD';
  await slots.setJSON(foreignKey, 1);
  submitBooking.__test.resetNotificationAttempts();
  const failed = await post(finalizeBody(payload, draft.body), '203.0.113.151');
  assert.equal(failed.status, 409);
  assert.equal(failed.body.bookingCreated, false);
  assert.equal(failed.body.error, 'booking_slot_unavailable');
  assert.equal(submitBooking.__test.notificationAttempts(), 0);
  const saved = await bookings.get(draft.body.id, { type: 'json' });
  assert.equal(saved.isDraft, true);
  assert.equal(saved.finalizedAt, undefined);
  const keys = (await collectKeys(slots)).map((key) => decodeURIComponent(key));
  assert.ok(keys.includes(foreignKey), keys.join('\n'));
  assert.equal(keys.some((key) => key.includes('/booked/') && key.endsWith('/' + draft.body.id)), false);
});

async function deleteKeysForBooking(id) {
  const keys = await collectKeys(slots);
  for (const key of keys) {
    if (decodeURIComponent(key).endsWith('/' + id)) await slots.delete(key);
  }
}

test('retry restores slots for a pending-protocol record and leaves a legacy finalized record untouched', async () => {
  const recoverablePayload = ceramicBody({ phone: '2015550321', preferredDate: '2026-10-22', email: 'recover@example.com' });
  const recoverableDraft = await post(recoverablePayload, '203.0.113.190');
  assert.equal(recoverableDraft.status, 200, JSON.stringify(recoverableDraft.body));
  const recoverableId = recoverableDraft.body.id;
  const recoverableSaved = await bookings.get(recoverableId, { type: 'json' });
  await bookings.setJSON(recoverableId, {
    ...recoverableSaved,
    isDraft: false,
    kind: 'booking',
    finalizedAt: '2026-09-27T16:00:00.000Z',
    occupancyStatus: 'complete',
    occupancyPendingAt: recoverableSaved.occupancyPendingAt || '2026-09-27T15:59:00.000Z',
  });
  await deleteKeysForBooking(recoverableId);
  submitBooking.__test.resetNotificationAttempts();
  const restored = await post(finalizeBody(recoverablePayload, recoverableDraft.body), '203.0.113.191');
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.bookingCreated, true);
  assert.equal(restored.body.id, recoverableId);
  assert.equal(submitBooking.__test.notificationAttempts(), 1);
  const restoredKeys = (await collectKeys(slots)).map((key) => decodeURIComponent(key));
  assert.equal(restoredKeys.filter((key) => key.includes('/booked/') && key.endsWith('/' + recoverableId)).length, 6);
  const restoredAgain = await post(finalizeBody(recoverablePayload, recoverableDraft.body), '203.0.113.192');
  assert.equal(restoredAgain.body.idempotent, true);
  assert.equal(submitBooking.__test.notificationAttempts(), 1);

  const legacyPayload = ceramicBody({ phone: '2015550322', preferredDate: '2026-10-26', email: 'legacy@example.com' });
  const legacyDraft = await post(legacyPayload, '203.0.113.193');
  assert.equal(legacyDraft.status, 200, JSON.stringify(legacyDraft.body));
  const legacyId = legacyDraft.body.id;
  const legacySaved = await bookings.get(legacyId, { type: 'json' });
  const legacy = {
    ...legacySaved,
    isDraft: false,
    kind: 'booking',
    finalizedAt: '2026-09-27T16:00:00.000Z',
    occupancyStatus: 'complete',
  };
  delete legacy.occupancyPendingAt;
  await bookings.setJSON(legacyId, legacy);
  await deleteKeysForBooking(legacyId);
  submitBooking.__test.resetNotificationAttempts();
  const untouched = await post(finalizeBody(legacyPayload, legacyDraft.body), '203.0.113.194');
  assert.equal(untouched.status, 503, JSON.stringify(untouched.body));
  assert.equal(untouched.body.bookingCreated, false);
  assert.equal(untouched.body.error, 'occupancy_incomplete');
  assert.equal(submitBooking.__test.notificationAttempts(), 0);
  const legacyKeys = (await collectKeys(slots)).map((key) => decodeURIComponent(key));
  assert.equal(legacyKeys.filter((key) => key.endsWith('/' + legacyId)).length, 0, legacyKeys.join('\n'));
  const legacyRecord = await bookings.get(legacyId, { type: 'json' });
  assert.equal(legacyRecord.isDraft, false);
  assert.equal(legacyRecord.finalizedAt, '2026-09-27T16:00:00.000Z');
});

function stripeFetchGuard() {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.includes('api.stripe.com')) calls.push(target);
    if (typeof original === 'function') return original(url, opts);
    return { ok: false, status: 599, json: async () => ({}) };
  };
  return {
    calls,
    restore() { global.fetch = original; },
  };
}

test('occupancy failure before payment does not charge, and retry finalizes the same draft once', async () => {
  const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
  const payload = ceramicBody({
    phone: '2015550330',
    email: 'occupancy-before-pay@example.com',
    preferredDate: '2026-10-08',
    ceramicPaymentPlan: 'prepay_full',
  });
  const draft = await post(payload, '203.0.113.210');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const realSlots = slots;
  setSlotIndexStoreOverride(forwardingStore(realSlots, {
    beforeSet(key) {
      if (String(key).startsWith('span-claim/')) return;
      throw new Error('occupancy write failed before payment');
    },
  }));
  submitBooking.__test.resetNotificationAttempts();
  const stripe = stripeFetchGuard();
  try {
    const failed = await post(finalizeBody(payload, draft.body), '203.0.113.211');
    assert.equal(failed.body.bookingCreated, false);
    assert.equal(failed.body.error, 'occupancy_incomplete');
    assert.equal(failed.body.recoverable, true);
    assert.equal(submitBooking.__test.notificationAttempts(), 0);
    const pending = await bookings.get(draft.body.id, { type: 'json' });
    assert.equal(pending.isDraft, true);
    assert.equal(pending.occupancyStatus, 'pending');
    assert.equal(pending.finalizedAt, undefined);
    assert.notEqual(pending.paymentStatus, 'paid');
    assert.equal(stripe.calls.length, 0);

    setOpsStoreOverride(bookings);
    const checkout = require('../netlify/functions/ceramic-checkout-intent');
    const refused = await checkout.handler({
      httpMethod: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.212' },
      body: JSON.stringify({
        bookingId: draft.body.id,
        phone: payload.phone,
        phase: 'checkout',
        expectedQuoteVersion: 1,
      }),
    });
    const refusedBody = JSON.parse(refused.body);
    assert.notEqual(refusedBody.ok, true);
    assert.notEqual(refusedBody.error, 'stripe_create_failed');
    if (process.env.DATABASE_URL) {
      assert.equal(refusedBody.error, 'booking_not_ready');
    }
    assert.equal(stripe.calls.length, 0);
  } finally {
    stripe.restore();
    setOpsStoreOverride(null);
    setSlotIndexStoreOverride(realSlots);
  }

  const retried = await post(finalizeBody(payload, draft.body), '203.0.113.213');
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.bookingCreated, true);
  assert.equal(retried.body.id, draft.body.id);
  assert.equal(retried.body.paymentSucceeded, false);
  assert.equal(retried.body.amountPaid, 0);
  assert.equal(submitBooking.__test.notificationAttempts(), 1);
  const saved = await bookings.get(draft.body.id, { type: 'json' });
  assert.equal(saved.isDraft, false);
  assert.equal(saved.paymentStatus, 'unpaid');
  const again = await post(finalizeBody(payload, draft.body), '203.0.113.214');
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.id, draft.body.id);
  assert.equal(submitBooking.__test.notificationAttempts(), 1);
});

test('ceramic card at service stays uncharged when occupancy fails, and retry does not notify again', async () => {
  const payload = ceramicBody({
    phone: '2015550331',
    email: 'card-then-occupancy@example.com',
    preferredDate: '2026-10-09',
    paymentMethodPreference: 'card_onsite',
    cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false,
  });
  const draft = await post(payload, '203.0.113.220');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const stored = await bookings.get(draft.body.id, { type: 'json' });
  assert.equal(stored.cardOnFileStatus, 'not_collected');
  assert.equal(stored.setupIntentId, undefined);
  const realSlots = slots;
  setSlotIndexStoreOverride(forwardingStore(realSlots, {
    beforeSet(key) {
      if (String(key).startsWith('span-claim/')) return;
      throw new Error('occupancy write failed after card save');
    },
  }));
  submitBooking.__test.resetNotificationAttempts();
  const stripe = stripeFetchGuard();
  try {
    const failed = await post(finalizeBody(payload, draft.body), '203.0.113.221');
    assert.equal(failed.body.bookingCreated, false);
    assert.equal(failed.body.error, 'occupancy_incomplete');
    assert.equal(submitBooking.__test.notificationAttempts(), 0);
    assert.equal(stripe.calls.length, 0);
    const pending = await bookings.get(draft.body.id, { type: 'json' });
    assert.equal(pending.isDraft, true);
    assert.equal(pending.cardOnFileStatus, 'not_collected');
    assert.equal(pending.setupIntentId, undefined);
    assert.notEqual(pending.paymentStatus, 'paid');
  } finally {
    stripe.restore();
    setSlotIndexStoreOverride(realSlots);
  }

  const retried = await post(finalizeBody(payload, draft.body), '203.0.113.222');
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.bookingCreated, true);
  assert.equal(retried.body.paymentSucceeded, false);
  assert.equal(retried.body.amountPaid, 0);
  assert.equal(retried.body.cardOnFileStatus, 'not_collected');
  assert.equal(submitBooking.__test.notificationAttempts(), 1);
  const saved = await bookings.get(draft.body.id, { type: 'json' });
  assert.equal(saved.paymentStatus, 'unpaid');
  assert.equal(saved.amountPaid, 0);
  const again = await post(finalizeBody(payload, draft.body), '203.0.113.223');
  assert.equal(again.body.idempotent, true);
  assert.equal(submitBooking.__test.notificationAttempts(), 1);
  assert.equal((await bookingRecordKeys(bookings)).length, 1);
});
