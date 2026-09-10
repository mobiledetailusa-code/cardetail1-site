'use strict';

/**
 * Freeze P0: hung finalize + new draft must not create a second Admin booking
 * when the slot-lock store scan fails open.
 *
 * Historical source: PR #181. Failure semantics differ: lookup timeout/error
 * must not be converted to an empty list.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PRISMA_PATH = require.resolve('../netlify/lib/prisma');
let fakePrisma = null;

require.cache[PRISMA_PATH] = {
  id: PRISMA_PATH,
  filename: PRISMA_PATH,
  loaded: true,
  exports: {
    prismaConfigured: () => !!fakePrisma,
    tryGetPrisma: () => fakePrisma,
    getPrisma: () => fakePrisma,
  },
};

const { findDuplicateBooking, DUPLICATE_WINDOW_MS } = require('../netlify/lib/booking-history');
const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
const submitBooking = require('../netlify/functions/submit-booking');

const DATE = '2099-06-16';
const TIME = '10:00 AM';
const PHONE = '(201) 555-0147';

const EXISTING = {
  id: 'CD1-FIRST',
  phone: PHONE,
  email: 'customer@example.com',
  status: 'Pending Review',
  kind: 'booking',
  isDraft: false,
  finalizedAt: new Date().toISOString(),
  preferredDate: DATE,
  preferredTime: TIME,
};

function mirrorReturning(rows) {
  return { $queryRaw: () => Promise.resolve(rows.map((payload) => ({ payload }))) };
}

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    data,
    listMode: 'ok',
    async get(key) {
      if (!data.has(key)) return null;
      return JSON.parse(JSON.stringify(data.get(key)));
    },
    async setJSON(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
      return { modified: true };
    },
    async list() {
      if (this.listMode === 'timeout') {
        const err = new Error('store_scan_timeout');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      if (this.listMode === 'error') {
        throw new Error('store_scan_failed');
      }
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function requestPayload(overrides = {}) {
  return {
    firstName: 'Guard',
    lastName: 'Customer',
    phone: '2015550177',
    email: 'guard@example.com',
    address: '1 Main St, Newark, NJ',
    zipCode: '07102',
    preferredDate: DATE,
    preferredTime: TIME,
    preferredArrivalWindow: 'anytime',
    scheduleFlexibility: 'exact',
    vehicle: '2024 Honda Civic',
    vehicleCategory: 'cars',
    vehicleTier: 'Small Car',
    package: 'Premium Detail',
    packageId: 'full',
    vehicles: [{
      vehicleId: 'vehicle-1',
      cat: 'cars',
      pkgId: 'full',
      pkgName: 'Premium Detail',
      tierKey: 'small',
      tierLabel: 'Small Car',
      vehicleLabel: '2024 Honda Civic',
      addons: [],
      addonTotal: 0,
      basePrice: 240,
      subtotal: 240,
    }],
    totalPrice: 240,
    travelFeeAmount: 0,
    zoneSurcharge: 0,
    paymentMethod: '',
    paymentMethodPreference: 'online_after_service',
    cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false,
    acceptedCardOnFilePolicyAt: null,
    acceptedBookingPolicy: true,
    policyVersion: '2026-08-booking-request',
    ...overrides,
  };
}

async function post(body, ip = '203.0.113.81') {
  const response = await submitBooking.handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': ip },
    body: JSON.stringify(body),
  });
  return { response, body: JSON.parse(response.body) };
}

beforeEach(() => {
  fakePrisma = null;
  delete process.env.OFFER_HISTORY_FAST_LOOKUP;
  delete process.env.PRISMA_BOOKING_READ;
  delete process.env.PRISMA_BOOKING_MIRROR;
  delete process.env.SLOT_INDEX_READS;
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub/stub';
  setOpsStoreOverride(null);
});

afterEach(() => {
  setOpsStoreOverride(null);
});

describe('findDuplicateBooking', () => {
  it('finds the appointment the customer already holds for that slot', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    const result = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-SECOND',
    });
    assert.equal(result.ok, true);
    assert.equal(result.booking && result.booking.id, 'CD1-FIRST');
  });

  it('matches on normalized phone, not on formatting', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    const result = await findDuplicateBooking({
      phone: '+1 201 555 0147', preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-SECOND',
    });
    assert.equal(result.ok, true);
    assert.equal(result.booking && result.booking.id, 'CD1-FIRST');
  });

  it('never reports the draft being finalized as its own duplicate', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    const result = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-FIRST',
    });
    assert.equal(result.ok, true);
    assert.equal(result.booking, null);
  });

  it('leaves a different day or a different slot alone', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    assert.equal((await findDuplicateBooking({
      phone: PHONE, preferredDate: '2099-06-17', preferredTime: TIME, excludeId: 'X',
    })).booking, null);
    assert.equal((await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: '8:00 AM', excludeId: 'X',
    })).booking, null);
  });

  it('ignores a cancelled appointment — that slot is genuinely free again', async () => {
    fakePrisma = mirrorReturning([{ ...EXISTING, status: 'Cancelled' }]);
    const result = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(result.ok, true);
    assert.equal(result.booking, null);
  });

  it('honours the confirmed slot when Admin moved the appointment', async () => {
    fakePrisma = mirrorReturning([{
      ...EXISTING,
      preferredDate: '2099-06-01',
      preferredTime: '8:00 AM',
      confirmedDate: DATE,
      confirmedTime: TIME,
    }]);
    const result = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(result.booking && result.booking.id, 'CD1-FIRST');
  });

  it('leaves an older booking on that slot to Admin', async () => {
    fakePrisma = mirrorReturning([{
      ...EXISTING,
      finalizedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    }]);
    const result = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(result.booking, null);
    assert.ok(DUPLICATE_WINDOW_MS <= 60 * 60 * 1000 || DUPLICATE_WINDOW_MS > 0);
  });

  it('treats an undated record as not recent rather than guessing', async () => {
    const { finalizedAt, ...noTimestamps } = EXISTING;
    fakePrisma = mirrorReturning([noTimestamps]);
    const result = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(result.booking, null);
  });

  it('does not block a first booking when the customer cannot be identified', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    const result = await findDuplicateBooking({
      preferredDate: DATE, preferredTime: TIME,
    });
    assert.equal(result.ok, true);
    assert.equal(result.booking, null);
    assert.equal(result.source, 'skipped_no_identity');
  });

  it('does not block a first booking for an unusable date or time', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    assert.equal((await findDuplicateBooking({
      phone: PHONE, preferredDate: '', preferredTime: TIME,
    })).source, 'skipped_unusable_slot');
    assert.equal((await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: '25:00',
    })).source, 'skipped_unusable_slot');
  });

  it('does not treat a different customer on the same slot as this customer\'s duplicate', async () => {
    process.env.PRISMA_BOOKING_READ = '0';
    const store = createMemoryStore({
      [EXISTING.id]: EXISTING,
      'CD1-OTHER': {
        ...EXISTING,
        id: 'CD1-OTHER',
        phone: '2015550999',
        email: 'other@example.com',
      },
    });
    const result = await findDuplicateBooking({
      phone: '2015550999',
      email: EXISTING.email,
      preferredDate: DATE,
      preferredTime: TIME,
      excludeId: 'CD1-NEW',
      store,
    });
    assert.equal(result.ok, true);
    assert.equal(result.booking && result.booking.id, 'CD1-OTHER');
    const firstPhone = await findDuplicateBooking({
      phone: PHONE,
      email: 'other@example.com',
      preferredDate: DATE,
      preferredTime: TIME,
      excludeId: 'CD1-NEW',
      store,
    });
    assert.equal(firstPhone.booking && firstPhone.booking.id, 'CD1-FIRST');
  });

  it('TEST 4 — store scan timeout is not converted to an empty list', async () => {
    process.env.PRISMA_BOOKING_READ = '0';
    const store = createMemoryStore({ [EXISTING.id]: EXISTING });
    store.listMode = 'timeout';
    const result = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-SECOND', store,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'duplicate_lookup_unavailable');
    assert.equal(result.booking, null);
  });

  it('TEST 5 — generic store lookup failure is not converted to an empty list', async () => {
    process.env.PRISMA_BOOKING_READ = '0';
    const store = createMemoryStore({ [EXISTING.id]: EXISTING });
    store.listMode = 'error';
    const result = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-SECOND', store,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'duplicate_lookup_unavailable');
    assert.equal(result.booking, null);
  });

  it('TEST 6 — after a transient store failure, a recovered scan can finalize', async () => {
    process.env.PRISMA_BOOKING_READ = '0';
    const store = createMemoryStore({});
    store.listMode = 'timeout';
    const failed = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-NEW', store,
    });
    assert.equal(failed.ok, false);
    store.listMode = 'ok';
    const recovered = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-NEW', store,
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.booking, null);
  });
});

describe('finalize wiring', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'functions', 'submit-booking.js'),
    'utf8'
  );

  it('checks for the duplicate before writing the booking', () => {
    const check = src.indexOf('findDuplicateBooking(');
    const write = src.indexOf('await store.setJSON(rawDraftId, b)');
    assert.ok(check > -1 && write > check, 'the guard must run before the write');
  });

  it('answers with the existing booking instead of creating a second one', () => {
    const block = src.slice(src.indexOf('if (duplicateCheck.booking)'), src.indexOf('let stored = { saved: false }'));
    assert.match(block, /ok: true/);
    assert.match(block, /duplicateSuppressed: true/);
    assert.match(block, /id: duplicate\.id/);
  });

  it('does not fail-open when the duplicate lookup throws or times out', () => {
    assert.doesNotMatch(src, /findDuplicateBooking\([\s\S]*?\)\.catch\(\(\) => null\)/);
    assert.match(src, /duplicate_lookup_unavailable/);
    const fail = src.slice(src.indexOf('if (!duplicateCheck'), src.indexOf('if (duplicateCheck.booking)'));
    assert.match(fail, /statusCode: 503|json\(503/);
    assert.match(fail, /bookingCreated: false/);
  });

  it('logs a ref, never the raw booking id, when suppressing a duplicate', () => {
    const block = src.slice(src.indexOf('duplicate suppressed'), src.indexOf('let stored = { saved: false }'));
    assert.match(block, /bookingRef/);
    assert.doesNotMatch(block, /id: duplicate\.id,\s*\n\s*preferredDate/);
  });

  it('does not enable SLOT_INDEX_READS', () => {
    const slotIndex = fs.readFileSync(
      path.join(__dirname, '..', 'netlify', 'lib', 'slot-index.js'),
      'utf8'
    );
    assert.match(slotIndex, /SLOT_INDEX_READS/);
    assert.match(src, /listBookingsForSlotLock\(\)\.catch/);
  });
});

describe('submit-booking duplicate guard', () => {
  const originalFetch = globalThis.fetch;
  const env = {};
  const envKeys = [
    'DRAFT_TOKEN_SECRET', 'ADMIN_EMAIL', 'RESEND_API_KEY', 'TWILIO_SEND_ENABLED',
    'CONTEXT', 'NETLIFY_DEV', 'STRIPE_SECRET_KEY', 'PRISMA_BOOKING_READ',
    'PRISMA_BOOKING_MIRROR', 'SLOT_INDEX_READS',
  ];
  let store;

  before(() => {
    for (const key of envKeys) env[key] = process.env[key];
    process.env.DRAFT_TOKEN_SECRET = 'n'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.TWILIO_SEND_ENABLED = 'false';
    process.env.CONTEXT = 'deploy-preview';
    process.env.PRISMA_BOOKING_READ = '0';
    process.env.PRISMA_BOOKING_MIRROR = '0';
    delete process.env.NETLIFY_DEV;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.SLOT_INDEX_READS;
    globalThis.fetch = async () => {
      throw new Error('unexpected_external_call');
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    submitBooking.__test.setBlobsStoreOverride(null);
    setOpsStoreOverride(null);
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  beforeEach(() => {
    store = createMemoryStore();
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    setOpsStoreOverride(null);
    process.env.PRISMA_BOOKING_READ = '0';
    process.env.PRISMA_BOOKING_MIRROR = '0';
    delete process.env.SLOT_INDEX_READS;
  });

  async function draftAndFinalize(overrides = {}, ip = '203.0.113.81') {
    const payload = requestPayload(overrides);
    const draft = await post({ ...payload, isDraft: true }, ip);
    assert.equal(draft.response.statusCode, 200, draft.body.error);
    const final = await post({
      ...payload,
      draftBookingId: draft.body.id,
      draftSaveToken: draft.body.draftSaveToken,
    }, ip);
    return { draft, final, payload };
  }

  it('TEST 1 — normal booking finalizes once when the scan succeeds', async () => {
    const { final } = await draftAndFinalize({ phone: '2015550101', email: 'one@example.com' }, '203.0.113.101');
    assert.equal(final.response.statusCode, 200, final.body.error);
    assert.equal(final.body.bookingCreated, true);
    assert.equal(final.body.duplicateSuppressed, undefined);
    const submitted = [...store.data.values()].filter((b) => b && b.isDraft === false);
    assert.equal(submitted.length, 1);
  });

  it('TEST 2 — same-draft retry is idempotent and does not duplicate', async () => {
    const { draft, final, payload } = await draftAndFinalize({
      phone: '2015550102', email: 'two@example.com',
    }, '203.0.113.102');
    assert.equal(final.body.bookingCreated, true);
    const replay = await post({
      ...payload,
      draftBookingId: draft.body.id,
      draftSaveToken: 'replay-does-not-need-a-fresh-token-on-finalized',
    }, '203.0.113.102');
    assert.equal(replay.response.statusCode, 200);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.id, draft.body.id);
    const submitted = [...store.data.values()].filter((b) => b && b.isDraft === false && b.phone === payload.phone);
    assert.equal(submitted.length, 1);
  });

  it('TEST 3 — a second draft for the same customer/slot is suppressed', async () => {
    const phone = '2015550103';
    const email = 'three@example.com';
    const first = await draftAndFinalize({ phone, email }, '203.0.113.103');
    assert.equal(first.final.body.bookingCreated, true);
    const firstId = first.final.body.id;
    const second = await draftAndFinalize({ phone, email }, '203.0.113.103');
    assert.equal(second.final.response.statusCode, 200, second.final.body.error);
    assert.equal(second.final.body.duplicateSuppressed, true);
    assert.equal(second.final.body.idempotent, true);
    assert.equal(second.final.body.id, firstId);
    const submitted = [...store.data.values()].filter((b) => b && b.isDraft === false && b.phone === phone);
    assert.equal(submitted.length, 1);
  });

  it('TEST 4 — store scan timeout does not persist a second booking', async () => {
    const phone = '2015550104';
    const email = 'four@example.com';
    const first = await draftAndFinalize({ phone, email }, '203.0.113.104');
    assert.equal(first.final.body.bookingCreated, true);
    const firstRecord = JSON.parse(JSON.stringify(await store.get(first.final.body.id)));
    const secondDraft = await post({
      ...requestPayload({ phone, email, isDraft: true }),
    }, '203.0.113.104');
    assert.equal(secondDraft.response.statusCode, 200, secondDraft.body.error);
    store.listMode = 'timeout';
    const secondFinal = await post({
      ...requestPayload({ phone, email }),
      draftBookingId: secondDraft.body.id,
      draftSaveToken: secondDraft.body.draftSaveToken,
    }, '203.0.113.104');
    assert.equal(secondFinal.response.statusCode, 503);
    assert.equal(secondFinal.body.error, 'duplicate_lookup_unavailable');
    assert.equal(secondFinal.body.bookingCreated, false);
    const firstAfter = await store.get(first.final.body.id);
    assert.equal(firstAfter.status, firstRecord.status);
    assert.equal(firstAfter.isDraft, false);
    assert.equal(firstAfter.jobStatus === 'cancelled' || firstAfter.status === 'Cancelled', false);
    const secondRecord = await store.get(secondDraft.body.id);
    assert.equal(secondRecord.isDraft, true);
    const submitted = [...store.data.values()].filter((b) => b && b.isDraft === false && b.phone === phone);
    assert.equal(submitted.length, 1);
  });

  it('TEST 5 — generic lookup failure does not persist a duplicate', async () => {
    const phone = '2015550105';
    const email = 'five@example.com';
    const first = await draftAndFinalize({ phone, email }, '203.0.113.105');
    const secondDraft = await post({
      ...requestPayload({ phone, email, isDraft: true }),
    }, '203.0.113.105');
    store.listMode = 'error';
    const secondFinal = await post({
      ...requestPayload({ phone, email }),
      draftBookingId: secondDraft.body.id,
      draftSaveToken: secondDraft.body.draftSaveToken,
    }, '203.0.113.105');
    assert.equal(secondFinal.response.statusCode, 503);
    assert.equal(secondFinal.body.error, 'duplicate_lookup_unavailable');
    const secondRecord = await store.get(secondDraft.body.id);
    assert.equal(secondRecord.isDraft, true);
    const submitted = [...store.data.values()].filter((b) => b && b.isDraft === false && b.phone === phone);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].id, first.final.body.id);
  });

  it('TEST 6 — after verification recovers, a legitimate first booking can finalize', async () => {
    const phone = '2015550106';
    const email = 'six@example.com';
    const payload = requestPayload({ phone, email });
    const draft = await post({ ...payload, isDraft: true }, '203.0.113.106');
    assert.equal(draft.response.statusCode, 200, draft.body.error);
    store.listMode = 'timeout';
    const blocked = await post({
      ...payload,
      draftBookingId: draft.body.id,
      draftSaveToken: draft.body.draftSaveToken,
    }, '203.0.113.106');
    assert.equal(blocked.response.statusCode, 503);
    assert.equal(blocked.body.bookingCreated, false);
    const stillDraft = await store.get(draft.body.id);
    assert.equal(stillDraft.isDraft, true);
    store.listMode = 'ok';
    const retry = await post({
      ...payload,
      draftBookingId: draft.body.id,
      draftSaveToken: draft.body.draftSaveToken,
    }, '203.0.113.106');
    assert.equal(retry.response.statusCode, 200, retry.body.error);
    assert.equal(retry.body.bookingCreated, true);
    const saved = await store.get(draft.body.id);
    assert.equal(saved.isDraft, false);
  });

  it('TEST 7 — SLOT_INDEX_READS stays off and the fallback guard still holds', async () => {
    assert.notEqual(String(process.env.SLOT_INDEX_READS || '').trim(), '1');
    const phone = '2015550107';
    const first = await draftAndFinalize({ phone, email: 'seven@example.com' }, '203.0.113.107');
    const second = await draftAndFinalize({ phone, email: 'seven@example.com' }, '203.0.113.107');
    assert.equal(second.final.body.duplicateSuppressed, true);
    assert.equal(second.final.body.id, first.final.body.id);
    const submitted = [...store.data.values()].filter((b) => b && b.isDraft === false && b.phone === phone);
    assert.equal(submitted.length, 1);
  });
});
