'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
const { setSlotIndexStoreOverride, parseSlotIndexKey, indexedOccupancyForDates } = require('../netlify/lib/slot-index');
const { DRAFT_SLOT_HOLD_MS } = require('../netlify/lib/booking-schedule');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const { projectQuickOpsBooking } = require('../netlify/lib/admin-quick-ops-view');

const WEEKDAY = '2026-09-28';
const GENERIC_CARD_FALLBACK = 'Could not register booking. Please try again.';

function createMemoryStore() {
  const data = new Map();
  return {
    data,
    async get(key, opts = {}) {
      if (!data.has(key)) return null;
      const raw = data.get(key);
      return opts.type === 'json' ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) {
      data.set(key, JSON.stringify(value));
    },
    async delete(key) { data.delete(key); },
    async list({ prefix } = {}) {
      const keys = [...data.keys()].filter((key) => !prefix || String(key).startsWith(prefix));
      return { blobs: keys.map((key) => ({ key })) };
    },
    records() {
      const out = [];
      for (const raw of data.values()) {
        try {
          const value = JSON.parse(raw);
          if (value && value.id) out.push(value);
        } catch { /* slot markers are not bookings */ }
      }
      return out;
    },
  };
}

const eligible = {
  repainted60: 'no',
  clearCoatFailing: 'no',
  severeContamination: 'no',
  matteWrapPpf: 'no',
  coveredCureArea: 'yes',
  remainDry12h: 'yes',
};

function ceramicBody(extra = {}) {
  return {
    isDraft: true,
    firstName: 'Probe',
    lastName: 'Isolated',
    phone: '2015550199',
    email: 'probe-isolated@example.com',
    zipCode: '07601',
    address: '100 Test St',
    paymentMethodPreference: 'cash_onsite',
    cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false,
    acceptedBookingPolicy: true,
    preferredDate: WEEKDAY,
    preferredTime: '8:00 AM',
    preferredArrivalWindow: 'anytime',
    scheduleFlexibility: 'exact',
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

function ordinary(preference, extra = {}) {
  const card = preference === 'online_after_service';
  return {
    isDraft: true,
    firstName: 'Probe',
    lastName: 'Isolated',
    phone: '2015550188',
    email: 'probe-isolated@example.com',
    zipCode: '07601',
    address: '100 Test St',
    paymentMethodPreference: preference,
    cardOnFileRequired: card,
    acceptedCardOnFilePolicy: card,
    acceptedBookingPolicy: true,
    preferredDate: WEEKDAY,
    preferredTime: '10:00 AM',
    preferredArrivalWindow: '10:00-13:00',
    scheduleFlexibility: 'exact',
    vehicleCategory: 'cars',
    vehicle: 'Small Car',
    package: 'Premium Full Detail',
    vehicles: [{
      cat: 'cars',
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      tierKey: 'small',
      vehicleLabel: 'Small Car',
      basePrice: 250,
      subtotal: 250,
      addons: [],
      addonTotal: 0,
    }],
    totalPrice: 250,
    ...extra,
  };
}

let bookings;
let slots;
let submitBooking;

function useStores() {
  bookings = createMemoryStore();
  slots = createMemoryStore();
  submitBooking.__test.setBlobsStoreOverride(async () => bookings);
  setSlotIndexStoreOverride(slots);
}

async function post(body, ip) {
  const res = await submitBooking.handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch { parsed = {}; }
  return { status: res.statusCode, body: parsed };
}

function indexKeys() {
  return [...slots.data.keys()];
}

beforeEach(() => {
  process.env.DRAFT_TOKEN_SECRET = 'd'.repeat(32);
  process.env.CONTEXT = 'dev';
  process.env.NETLIFY_DEV = 'true';
  process.env.CD1_CERAMIC_DEPOSITS = '1';
  delete require.cache[SUBMIT_PATH];
  submitBooking = require('../netlify/functions/submit-booking');
  useStores();
});

afterEach(() => {
  try { submitBooking.__test.setBlobsStoreOverride(null); } catch { /* ignore */ }
  setSlotIndexStoreOverride(null);
  delete process.env.DRAFT_TOKEN_SECRET;
});

async function finalize(draftBody, draftResponse, extra = {}) {
  return post({
    ...draftBody,
    isDraft: false,
    draftBookingId: draftResponse.id,
    draftSaveToken: draftResponse.draftSaveToken,
    acceptedBookingPolicy: true,
    ...extra,
  }, '203.0.113.90');
}

test('card registration prefers the server message over the generic fallback', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(
    html,
    /String\(draftData\.userMessage\|\|draftData\.message\|\|''\)\.trim\(\)\|\|draftErrMap\[draftData\.error\]/
  );
  assert.match(html, /Could not register booking\. Please try again\./);
});

test('ordinary cash and card-at-service bookings persist once', async () => {
  for (const [preference, ip] of [['cash_onsite', '203.0.113.11'], ['card_onsite', '203.0.113.12']]) {
    useStores();
    const payload = ordinary(preference, {
      phone: preference === 'cash_onsite' ? '2015550188' : '2015550187',
      email: preference === 'cash_onsite' ? 'cash-onsite@example.com' : 'card-onsite@example.com',
    });
    const draft = await post(payload, ip);
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.ok, true);
    assert.equal(draft.body.bookingCreated, false);
    const fin = await finalize(payload, draft.body);
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(fin.body.bookingCreated, true);
    const saved = bookings.records().find((row) => row.id === fin.body.id);
    assert.equal(saved.isDraft, false);
    assert.equal(saved.paymentMethodPreference, preference);
    assert.equal(saved.totalPrice, 250);
    assert.equal(saved.amountPaid || 0, 0);
    const again = await finalize(payload, draft.body);
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.id, fin.body.id);
    assert.equal(bookings.records().filter((row) => row.id === fin.body.id).length, 1);
    const garage = projectBookingForCustomer(saved);
    const admin = projectQuickOpsBooking(saved);
    assert.equal(garage.id, saved.id);
    assert.equal(admin.bookingId, saved.id);
    assert.equal(admin.paid, false);
  }
});

test('12-hour ceramic interior draft reserves every required day before payment', async () => {
  const payload = ceramicBody();
  const draft = await post(payload, '203.0.113.21');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const saved = bookings.records().find((row) => row.id === draft.body.id);
  assert.equal(saved.appointmentDurationMinutes, 720);
  assert.equal(saved.appointmentSchedule.multiDay, true);
  assert.equal(saved.totalPrice, 1530);
  const keys = indexKeys();
  assert.ok(keys.some((key) => key.startsWith(`${WEEKDAY}/8:00 AM/`)), keys.join(','));
  assert.ok(keys.some((key) => key.startsWith(`${WEEKDAY}/2:00 PM/`)), keys.join(','));
  assert.ok(keys.some((key) => key.startsWith('2026-09-29/8:00 AM/')), keys.join(','));
  assert.equal(keys.length, 6);

  const spill = await post(ordinary('cash_onsite', {
    phone: '2015550170',
    preferredDate: WEEKDAY,
    preferredTime: '8:00 AM',
    preferredArrivalWindow: '08:00-11:00',
  }), '203.0.113.22');
  assert.equal(spill.status, 409);
  assert.equal(spill.body.error, 'booking_slot_unavailable');
  assert.equal(spill.body.bookingCreated, false);
});

test('confirmed 12-hour appointment keeps every span after the draft hold expires', async () => {
  const payload = ceramicBody({ phone: '2015550166', email: 'span-hold@example.com' });
  const draft = await post(payload, '203.0.113.41');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const draftKeys = indexKeys().map(parseSlotIndexKey);
  assert.equal(draftKeys.length, 6);
  assert.ok(draftKeys.every((entry) => entry && entry.state === 'draft' && entry.expiresAtMs > Date.now()));
  const afterDraftTtl = Date.now() + DRAFT_SLOT_HOLD_MS + 60 * 1000;
  const expiredDraft = await indexedOccupancyForDates([WEEKDAY, '2026-09-29'], { nowMs: afterDraftTtl });
  assert.equal(expiredDraft.ok, true);
  assert.equal(expiredDraft.occupancy[`${WEEKDAY}|8:00 AM`] || 0, 0);
  assert.equal(expiredDraft.occupancy['2026-09-29|8:00 AM'] || 0, 0);

  const fin = await finalize(payload, draft.body);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.bookingCreated, true);
  const saved = bookings.records().find((row) => row.id === fin.body.id);
  assert.equal(saved.isDraft, false);
  assert.equal(saved.appointmentStatus, 'pending_review');
  assert.equal(saved.paymentStatus, 'unpaid');
  assert.equal(saved.amountPaid, 0);
  assert.equal(saved.appointmentDurationMinutes, 720);
  assert.equal(saved.totalPrice, 1530);
  assert.equal(saved.appointmentSchedule.multiDay, true);
  assert.deepEqual(saved.appointmentSchedule.days.map((day) => day.date), [WEEKDAY, '2026-09-29']);
  assert.ok(saved.vehicles.some((vehicle) => vehicle.companionInterior === true));

  const bookedKeys = indexKeys().map(parseSlotIndexKey);
  assert.equal(bookedKeys.length, 6);
  assert.ok(bookedKeys.every((entry) => entry && entry.state === 'booked' && entry.bookingId === saved.id));
  const stillHeld = await indexedOccupancyForDates([WEEKDAY, '2026-09-29', '2026-09-30'], { nowMs: afterDraftTtl });
  assert.equal(stillHeld.occupancy[`${WEEKDAY}|8:00 AM`], 1);
  assert.equal(stillHeld.occupancy[`${WEEKDAY}|2:00 PM`], 1);
  assert.equal(stillHeld.occupancy['2026-09-29|8:00 AM'], 1);
  assert.equal(stillHeld.occupancy['2026-09-29|10:00 AM'], 1);
  assert.equal(stillHeld.occupancy['2026-09-29|12:00 PM'] || 0, 0);

  const conflict = await post(ordinary('cash_onsite', {
    phone: '2015550167',
    preferredDate: '2026-09-29',
    preferredTime: '8:00 AM',
    preferredArrivalWindow: '08:00-11:00',
  }), '203.0.113.42');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'booking_slot_unavailable');
  assert.equal(conflict.body.bookingCreated, false);
  assert.equal(bookings.records().filter((row) => row.isDraft !== true && row.id !== saved.id).length, 0);

  const { handler } = require('../netlify/functions/booking-availability');
  const nearby = await handler({
    httpMethod: 'GET',
    queryStringParameters: {
      action: 'nearby',
      fromDate: WEEKDAY,
      limit: '8',
      durationMinutes: '720',
      companionInterior: '1',
    },
  });
  const openings = JSON.parse(nearby.body).openings;
  assert.ok(openings.length > 0);
  for (const opening of openings) {
    assert.equal(opening.preferredTime, '8:00 AM');
    assert.equal(opening.preferredArrivalWindow, '08:00-11:00');
    assert.notEqual(opening.preferredDate, WEEKDAY);
    assert.notEqual(opening.preferredDate, '2026-09-29');
  }
});

test('ceramic cash and card at service stay unpaid with the full balance and no stripe call', async () => {
  const originalFetch = global.fetch;
  const stripeCalls = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.stripe.com')) stripeCalls.push(String(url));
    if (typeof originalFetch === 'function') return originalFetch(url, opts);
    return { ok: false, status: 599, json: async () => ({}) };
  };
  try {
    const cases = [
      {
        label: 'cash',
        extra: { paymentMethodPreference: 'cash_onsite', phone: '2015550191', email: 'ceramic-cash@example.com' },
        ip: '203.0.113.31',
      },
      {
        label: 'card',
        extra: {
          paymentMethodPreference: 'card_onsite',
          phone: '2015550192',
          email: 'ceramic-card@example.com',
          ceramicPaymentPlan: 'deposit',
          ceramicWaterSupply: 'mobile',
        },
        ip: '203.0.113.32',
      },
    ];
    for (const row of cases) {
      useStores();
      stripeCalls.length = 0;
      const payload = ceramicBody(row.extra);
      delete payload.ceramicEligibility;
      const draft = await post(payload, row.ip);
      assert.equal(draft.status, 200, `${row.label} ${JSON.stringify(draft.body)}`);
      const fin = await finalize(payload, draft.body);
      assert.equal(fin.status, 200, `${row.label} ${JSON.stringify(fin.body)}`);
      assert.equal(fin.body.bookingCreated, true);
      assert.equal(fin.body.paymentSucceeded, false);
      const saved = bookings.records().find((item) => item.id === fin.body.id);
      assert.equal(saved.isDraft, false);
      assert.equal(saved.paymentStatus, 'unpaid');
      assert.equal(saved.amountPaid, 0);
      assert.equal(saved.balanceDue, 1530);
      assert.equal(saved.approvedFinalAmount, 1530);
      assert.equal(saved.depositAmount, 0);
      assert.equal(saved.ceramicPaymentPlan, null);
      assert.equal(saved.ceramic.paymentPlan, null);
      assert.equal(saved.ceramic.chargeAmount, 0);
      assert.equal(saved.cardOnFileRequired, false);
      assert.equal(saved.cardOnFileStatus, 'not_collected');
      assert.equal(saved.setupIntentId, undefined);
      assert.equal(saved.paymentIntentId, undefined);
      assert.equal(stripeCalls.length, 0);
      assert.equal(saved.appointmentDurationMinutes, 720);
      assert.equal(saved.appointmentSchedule.multiDay, true);
      assert.equal(saved.appointmentSchedule.days[1].date, '2026-09-29');
      const again = await finalize(payload, draft.body);
      assert.equal(again.body.idempotent, true);
      assert.equal(bookings.records().length, 1);
      const garage = projectBookingForCustomer(saved);
      const admin = projectQuickOpsBooking(saved);
      assert.equal(garage.approvedFinalAmount, 1530);
      assert.equal(garage.amountPaid, 0);
      assert.equal(garage.balanceDue, 1530);
      assert.equal(admin.paid, false);
      assert.equal(admin.ceramic.paymentPlan, null);
      assert.equal(admin.service.durationMinutes, 720);
      assert.equal(saved.ceramic.eligibility, null);
      const occupied = indexKeys().map(parseSlotIndexKey).filter((entry) => entry && entry.bookingId === saved.id && entry.state === 'booked');
      assert.equal(occupied.length, 6);
      assert.ok(occupied.some((entry) => entry.slotDate === '2026-09-29'));
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('ceramic undercarriage does not add a water fee when water access is no, unsure, or blank', async () => {
  for (const [waterAvailable, phone] of [['no', '2015550181'], ['unsure', '2015550182'], ['', '2015550183']]) {
    useStores();
    const payload = ceramicBody({
      phone,
      email: `ceramic-water-${phone}@example.com`,
      waterAvailable,
      vehicles: [{
        cat: 'cars',
        pkgId: 'ceramic_3yr',
        tierKey: 'suv3',
        vehicleLabel: 'Large SUV',
        basePrice: 1275,
        subtotal: 1705,
        companionInterior: true,
        companionInteriorPrice: 255,
        addons: [
          { id: 'undercarriage', name: 'Accessible Undercarriage Cleaning', price: 175, qty: 1 },
          { id: 'mobile_water', name: 'Mobile Water Supply', price: 50, qty: 1 },
        ],
        addonTotal: 175,
      }],
      totalPrice: 1705,
    });
    const draft = await post(payload, `203.0.113.${phone.slice(-2)}`);
    assert.equal(draft.status, 200, `${waterAvailable} ${JSON.stringify(draft.body)}`);
    const fin = await finalize(payload, draft.body);
    assert.equal(fin.status, 200, `${waterAvailable} ${JSON.stringify(fin.body)}`);
    const saved = bookings.records().find((item) => item.id === fin.body.id);
    assert.equal(saved.approvedFinalAmount, 1705);
    assert.equal(saved.balanceDue, 1705);
    assert.equal(saved.paymentStatus, 'unpaid');
    assert.equal(saved.amountPaid, 0);
    assert.equal(saved.waterAvailable, waterAvailable);
    assert.equal(saved.vehicles[0].addons.some((addon) => addon.id === 'mobile_water'), false);
    assert.equal(saved.vehicles[0].addons.some((addon) => addon.id === 'undercarriage'), true);
    assert.equal(saved.appointmentSchedule.multiDay, true);
  }
});

test('a new ceramic booking rejects pay online later and does not save a card', async () => {
  const payload = ceramicBody({
    phone: '2015550193',
    email: 'online-card@example.com',
    paymentMethodPreference: 'online_after_service',
    cardOnFileRequired: true,
    acceptedCardOnFilePolicy: true,
  });
  const draft = await post(payload, '203.0.113.41');
  assert.equal(draft.status, 400, JSON.stringify(draft.body));
  assert.equal(draft.body.error, 'ceramic_pay_at_service_only');
  assert.notEqual(draft.body.bookingCreated, true);
  assert.equal(bookings.records().length, 0);
});

test('a stored deposit plan and historical water line survive a later submit', async () => {
  const payload = ceramicBody({
    phone: '2015550197',
    email: 'ceramic-history@example.com',
  });
  const draft = await post(payload, '203.0.113.61');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const stored = bookings.records().find((row) => row.id === draft.body.id);
  stored.ceramicPaymentPlan = 'deposit';
  stored.depositAmount = 406.25;
  stored.ceramic = {
    ...(stored.ceramic || {}),
    paymentPlan: 'deposit',
    depositAmount: 406.25,
    chargeAmount: 406.25,
  };
  await bookings.setJSON(stored.id, stored);
  const fin = await finalize(payload, draft.body);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const saved = bookings.records().find((row) => row.id === fin.body.id);
  assert.equal(saved.ceramicPaymentPlan, 'deposit');
  assert.equal(saved.depositAmount, 406.25);
  assert.equal(saved.ceramic.chargeAmount, 406.25);
  assert.equal(saved.amountPaid, 0);
  assert.equal(saved.balanceDue, 1530);
  assert.equal(saved.paymentStatus, 'unpaid');
  saved.vehicles[0].addons = [
    ...(saved.vehicles[0].addons || []),
    { id: 'mobile_water', name: 'Mobile Water Supply', price: 50, qty: 1 },
  ];
  saved.approvedFinalAmount = 1580;
  saved.totalPrice = 1580;
  saved.balanceDue = 1580;
  await bookings.setJSON(saved.id, saved);
  const again = await finalize(payload, draft.body);
  assert.equal(again.body.idempotent, true);
  const kept = bookings.records().find((row) => row.id === fin.body.id);
  assert.equal(kept.depositAmount, 406.25);
  assert.equal(kept.ceramicPaymentPlan, 'deposit');
  assert.equal(kept.approvedFinalAmount, 1580);
  assert.equal(kept.vehicles[0].addons.some((addon) => addon.id === 'mobile_water' && addon.price === 50), true);
  assert.equal(bookings.records().length, 1);
});

test('a late 12-hour window reports duration instead of a taken slot', async () => {
  const late = await post(ceramicBody({
    phone: '2015550194',
    preferredArrivalWindow: '10:00-13:00',
    preferredTime: '10:00 AM',
  }), '203.0.113.51');
  assert.equal(late.status, 400);
  assert.equal(late.body.error, 'ceramic_duration_exceeds_day');
  assert.equal(late.body.bookingCreated, false);
  assert.ok(late.body.userMessage);
  assert.notEqual(late.body.userMessage, GENERIC_CARD_FALLBACK);
  assert.equal(late.body.nextValidStart.time, '8:00 AM');
  assert.equal(bookings.records().length, 0);
});

test('old eligibility answers do not block ceramic checkout and stay on the booking', async () => {
  const payload = ceramicBody({
    phone: '2015550195',
    email: 'elig-old@example.com',
    ceramicEligibility: { ...eligible, repainted60: 'yes', remainDry12h: 'no' },
  });
  const draft = await post(payload, '203.0.113.52');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const fin = await finalize(payload, draft.body);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.bookingCreated, true);
  const saved = bookings.records().find((row) => row.id === fin.body.id);
  assert.equal(saved.ceramic.eligibility.repainted60, 'yes');
  assert.equal(saved.ceramic.eligibility.remainDry12h, 'no');
  assert.equal(saved.approvedFinalAmount, 1530);
  assert.equal(saved.depositAmount, 0);
  assert.equal(saved.paymentStatus, 'unpaid');
  assert.equal(saved.ceramic.technicalApproval, undefined);
  const replayBody = { ...payload };
  delete replayBody.ceramicEligibility;
  const again = await finalize(replayBody, draft.body);
  assert.equal(again.body.idempotent, true);
  const kept = bookings.records().find((row) => row.id === fin.body.id);
  assert.equal(kept.ceramic.eligibility.repainted60, 'yes');
  assert.equal(kept.ceramic.eligibility.remainDry12h, 'no');
  assert.equal(bookings.records().length, 1);
});

test('a later finalize keeps eligibility answers already stored on the draft', async () => {
  const payload = ceramicBody({
    phone: '2015550196',
    email: 'elig-keep@example.com',
    ceramicPaymentPlan: 'deposit',
    vehicles: [{
      cat: 'cars',
      pkgId: 'ceramic_3yr',
      tierKey: 'suv3',
      vehicleLabel: 'Large SUV',
      basePrice: 1275,
      subtotal: 1625,
      companionInterior: true,
      companionInteriorPrice: 255,
      addons: [{ id: 'pethair', name: 'Pet Hair Removal', price: 95, qty: 1 }],
      addonTotal: 95,
    }],
    totalPrice: 1625,
  });
  const draft = await post(payload, '203.0.113.53');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const stored = bookings.records().find((row) => row.id === draft.body.id);
  stored.ceramic = {
    eligibility: { ...eligible, remainDry12h: 'no', severeContamination: 'yes' },
    warnings: ['stored before the form was removed'],
  };
  await bookings.setJSON(stored.id, stored);
  const fin = await finalize(payload, draft.body);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.bookingCreated, true);
  const saved = bookings.records().find((row) => row.id === fin.body.id);
  assert.equal(saved.ceramic.eligibility.remainDry12h, 'no');
  assert.equal(saved.ceramic.eligibility.severeContamination, 'yes');
  assert.deepEqual(saved.ceramic.warnings, ['stored before the form was removed']);
    assert.equal(saved.approvedFinalAmount, 1625);
    assert.equal(saved.depositAmount, 0);
    assert.equal(saved.ceramicPaymentPlan, null);
  assert.equal(saved.amountPaid, 0);
  assert.equal(saved.paymentStatus, 'unpaid');
  assert.equal(saved.appointmentDurationMinutes, 765);
  assert.equal(saved.ceramic.technicalApproval, undefined);
  assert.equal(saved.vehicleTechnicallyApproved, undefined);
  assert.ok(saved.ceramic.serviceLineItems.every((line) => line.completionStatus === 'pending'));
  assert.equal(saved.vehicles[0].addons.some((addon) => addon.id === 'ceramic_correction'), false);
  const again = await finalize(payload, draft.body);
  assert.equal(again.body.idempotent, true);
  assert.equal(bookings.records().length, 1);
});
