'use strict';

/**
 * Freeze P0: duplicate/slot verification must fail closed.
 *
 * Historical PR #181 added same-customer matching but still answered null on
 * lookup failure. That is not ported. Timeout/error must not become "no
 * conflicting booking" and must not write a second authoritative record.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
const { matchDuplicateBooking, findDuplicateBooking } = require('../netlify/lib/booking-history');

const DATE = '2099-06-16';
const TIME = '10:00 AM';
const PHONE = '2015550147';

function readSubmit() {
  return fs.readFileSync(path.join(ROOT, 'netlify/functions/submit-booking.js'), 'utf8');
}

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const store = {
    data,
    async get(key) {
      if (!data.has(key)) return null;
      return JSON.parse(JSON.stringify(data.get(key)));
    },
    async setJSON(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
    finalized() {
      return [...data.values()].filter((b) => b && b.isDraft === false);
    },
  };
  return store;
}

function requestPayload(overrides = {}) {
  return {
    firstName: 'Guard',
    lastName: 'Customer',
    phone: PHONE,
    email: 'guard@example.com',
    address: '1 Main St, Newark, NJ',
    zipCode: '07102',
    preferredDate: DATE,
    preferredTime: TIME,
    preferredArrivalWindow: '',
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
    acceptedBookingPolicy: true,
    policyVersion: '2026-08-booking-request',
    ...overrides,
  };
}

function existingBooking(overrides = {}) {
  return {
    id: 'CD1-FIRST',
    phone: PHONE,
    email: 'guard@example.com',
    status: 'Pending Review',
    isDraft: false,
    kind: 'booking',
    bookingVersion: 1,
    finalizedAt: new Date().toISOString(),
    preferredDate: DATE,
    preferredTime: TIME,
    ...overrides,
  };
}

describe('matchDuplicateBooking', () => {
  const EXISTING = existingBooking();

  it('finds the appointment the customer already holds for that slot', () => {
    const dupe = matchDuplicateBooking([EXISTING], {
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-SECOND',
    });
    assert.equal(dupe && dupe.id, 'CD1-FIRST');
  });

  it('matches on normalized phone, not on formatting', () => {
    const dupe = matchDuplicateBooking([EXISTING], {
      phone: '+1 201 555 0147', preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-SECOND',
    });
    assert.equal(dupe && dupe.id, 'CD1-FIRST');
  });

  it('never reports the draft being finalized as its own duplicate', () => {
    const dupe = matchDuplicateBooking([EXISTING], {
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-FIRST',
    });
    assert.equal(dupe, null);
  });

  it('leaves a different day or a different slot alone', () => {
    assert.equal(matchDuplicateBooking([EXISTING], {
      phone: PHONE, preferredDate: '2099-06-17', preferredTime: TIME, excludeId: 'X',
    }), null);
    assert.equal(matchDuplicateBooking([EXISTING], {
      phone: PHONE, preferredDate: DATE, preferredTime: '8:00 AM', excludeId: 'X',
    }), null);
  });

  it('ignores a cancelled appointment — that slot is genuinely free again', () => {
    const dupe = matchDuplicateBooking([{ ...EXISTING, status: 'Cancelled' }], {
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(dupe, null);
  });

  it('honours the confirmed slot when Admin moved the appointment', () => {
    const dupe = matchDuplicateBooking([{
      ...EXISTING,
      preferredDate: '2099-06-01',
      preferredTime: '8:00 AM',
      confirmedDate: DATE,
      confirmedTime: TIME,
    }], {
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(dupe && dupe.id, 'CD1-FIRST');
  });

  it('leaves an older booking on that slot to occupancy, not this match', () => {
    const dupe = matchDuplicateBooking([{
      ...EXISTING,
      finalizedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    }], {
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(dupe, null);
  });

  it('treats an undated record as not recent rather than guessing', () => {
    const { finalizedAt, ...noTimestamps } = EXISTING;
    const dupe = matchDuplicateBooking([noTimestamps], {
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(dupe, null);
  });
});

describe('findDuplicateBooking fail-closed lookup', () => {
  it('does not invent a clear slot when the provided scan failed', async () => {
    const result = await findDuplicateBooking({
      phone: PHONE,
      preferredDate: DATE,
      preferredTime: TIME,
      bookings: undefined,
    });
    // No bookings array and no usable store still must not throw; a failed
    // blobs scan returns ok:false rather than duplicate:null-from-error.
    assert.ok(result);
    assert.equal(typeof result.ok, 'boolean');
    if (!result.ok) assert.equal(result.error, 'booking_verification_unavailable');
  });

  it('uses an injected list without treating it as a failed lookup', async () => {
    const result = await findDuplicateBooking({
      phone: PHONE,
      preferredDate: DATE,
      preferredTime: TIME,
      excludeId: 'CD1-SECOND',
      bookings: [existingBooking()],
    });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate && result.duplicate.id, 'CD1-FIRST');
  });
});

describe('finalize wiring', () => {
  it('checks for the duplicate before writing the booking', () => {
    const src = readSubmit();
    const check = src.indexOf('findDuplicateBooking(');
    const write = src.indexOf('await store.setJSON(rawDraftId, b)');
    assert.ok(check > -1 && write > check, 'the guard must run before the write');
  });

  it('does not convert a slot-lock scan failure into an empty list', () => {
    const src = readSubmit();
    assert.match(src, /listBookingsForSlotLock\(\)\.catch/);
    assert.doesNotMatch(src, /listBookingsForSlotLock\(\)\.catch\(\(\)\s*=>\s*\[\]\)/);
    assert.match(src, /booking_verification_unavailable/);
  });

  it('SLOT_INDEX_READS is not enabled by this guard', () => {
    const src = readSubmit();
    assert.doesNotMatch(src, /SLOT_INDEX_READS\s*=\s*['"]1['"]/);
  });
});

describe('submit-booking fail-closed duplicate guard', () => {
  let submitBooking;
  let store;
  const originalFetch = globalThis.fetch;
  const env = {};
  const envKeys = [
    'DRAFT_TOKEN_SECRET', 'ADMIN_EMAIL', 'RESEND_API_KEY', 'TWILIO_SEND_ENABLED',
    'CONTEXT', 'NETLIFY_DEV', 'STRIPE_SECRET_KEY', 'SLOT_INDEX_READS',
  ];

  async function post(body) {
    const response = await submitBooking.handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.80' },
      body: JSON.stringify(body),
    });
    return { response, body: JSON.parse(response.body) };
  }

  async function createDraft(overrides = {}) {
    return post(requestPayload({ isDraft: true, ...overrides }));
  }

  async function finalizeDraft(draftBody, overrides = {}) {
    return post(requestPayload({
      draftBookingId: draftBody.id,
      draftSaveToken: draftBody.draftSaveToken,
      ...overrides,
    }));
  }

  before(() => {
    for (const key of envKeys) env[key] = process.env[key];
    process.env.DRAFT_TOKEN_SECRET = 'n'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.TWILIO_SEND_ENABLED = 'false';
    process.env.CONTEXT = 'deploy-preview';
    delete process.env.NETLIFY_DEV;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.SLOT_INDEX_READS;
    delete require.cache[SUBMIT_PATH];
    submitBooking = require('../netlify/functions/submit-booking');
    globalThis.fetch = async () => {
      throw new Error('unexpected_external_call');
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    submitBooking.__test.setBlobsStoreOverride(null);
    submitBooking.__test.setSlotScanTimeoutMs(0);
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  beforeEach(() => {
    store = createMemoryStore();
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    submitBooking.__test.setSlotScanTimeoutMs(0);
    delete process.env.SLOT_INDEX_READS;
  });

  afterEach(() => {
    submitBooking.__test.setSlotScanTimeoutMs(0);
  });

  it('TEST 1 — scan succeeds, no duplicate, booking persists once', async () => {
    const draft = await createDraft();
    assert.equal(draft.response.statusCode, 200, draft.body.error);
    const final = await finalizeDraft(draft.body);
    assert.equal(final.response.statusCode, 200, final.body.error);
    assert.equal(final.body.bookingCreated, true);
    assert.equal(store.finalized().length, 1);
  });

  it('TEST 2 — already finalized draft retried stays idempotent', async () => {
    const draft = await createDraft({ phone: '2015550148' });
    const final = await finalizeDraft(draft.body, { phone: '2015550148' });
    assert.equal(final.response.statusCode, 200, final.body.error);
    const replay = await finalizeDraft({
      id: final.body.id,
      draftSaveToken: 'replay-does-not-need-a-fresh-token-on-finalized',
    }, { phone: '2015550148' });
    assert.equal(replay.response.statusCode, 200, replay.body.error);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.id, final.body.id);
    assert.equal(store.finalized().filter((b) => b.phone === '2015550148').length, 1);
  });

  it('TEST 3 — second fresh draft for the same slot is blocked', async () => {
    const firstDraft = await createDraft();
    const first = await finalizeDraft(firstDraft.body);
    assert.equal(first.response.statusCode, 200, first.body.error);
    const secondDraft = await createDraft({ phone: '2015550149', email: 'second@example.com' });
    assert.equal(secondDraft.response.statusCode, 409);
    assert.equal(secondDraft.body.error, 'booking_slot_unavailable');
    assert.equal(store.finalized().length, 1);
  });

  it('TEST 3 finalize — seeded first booking blocks a different draft', async () => {
    const draft = await createDraft({ phone: '2015550150', email: 'third@example.com' });
    assert.equal(draft.response.statusCode, 200, draft.body.error);
    store.data.set('CD1-FIRST', existingBooking({
      phone: '2015550150',
      email: 'third@example.com',
    }));
    const final = await finalizeDraft(draft.body, { phone: '2015550150', email: 'third@example.com' });
    assert.equal(final.response.statusCode, 409);
    assert.equal(final.body.error, 'booking_slot_unavailable');
    const saved = await store.get(draft.body.id);
    assert.equal(saved.isDraft, true);
    assert.equal(store.finalized().length, 1);
    assert.equal(store.finalized()[0].id, 'CD1-FIRST');
  });

  it('TEST 4 — lookup timeout does not write a booking', async () => {
    store.list = () => new Promise(() => {});
    submitBooking.__test.setSlotScanTimeoutMs(40);
    const draft = await createDraft({ phone: '2015550151' });
    assert.equal(draft.response.statusCode, 503);
    assert.equal(draft.body.error, 'booking_verification_unavailable');
    assert.equal(store.finalized().length, 0);
    assert.equal(store.data.size, 0);
  });

  it('TEST 5 — lookup throw does not write a booking', async () => {
    store.list = async () => {
      throw new Error('blob_list_failed');
    };
    const draft = await createDraft({ phone: '2015550152' });
    assert.equal(draft.response.statusCode, 503);
    assert.equal(draft.body.error, 'booking_verification_unavailable');
    assert.equal(store.finalized().length, 0);
    assert.equal(store.data.size, 0);
  });

  it('TEST 6 — retry after temporary verification failure can finalize', async () => {
    const originalList = store.list.bind(store);
    store.list = async () => {
      throw new Error('temporary_scan_down');
    };
    const blocked = await createDraft({ phone: '2015550153' });
    assert.equal(blocked.response.statusCode, 503);
    assert.equal(store.data.size, 0);
    store.list = originalList;
    const draft = await createDraft({ phone: '2015550153' });
    assert.equal(draft.response.statusCode, 200, draft.body.error);
    const final = await finalizeDraft(draft.body, { phone: '2015550153' });
    assert.equal(final.response.statusCode, 200, final.body.error);
    assert.equal(store.finalized().length, 1);
  });

  it('TEST 7 — SLOT_INDEX_READS stays off and fallback scan remains fail-closed', async () => {
    assert.equal(process.env.SLOT_INDEX_READS, undefined);
    store.list = async () => {
      throw new Error('index_off_scan_failed');
    };
    const draft = await createDraft({ phone: '2015550154' });
    assert.equal(draft.response.statusCode, 503);
    assert.equal(draft.body.error, 'booking_verification_unavailable');
    assert.equal(store.finalized().length, 0);
  });

  it('TEST 8 — existing booking after interrupted tail blocks a new draft', async () => {
    store.data.set('CD1-FIRST', existingBooking({
      notificationDelivery: { adminEmail: { status: 'failed' } },
    }));
    const draft = await createDraft();
    assert.equal(draft.response.statusCode, 409);
    assert.equal(draft.body.error, 'booking_slot_unavailable');
    assert.equal(store.finalized().map((b) => b.id).join(','), 'CD1-FIRST');
  });
});

describe('adversarial: persist then new draft then verification A/B/C', () => {
  let submitBooking;
  let store;
  const originalFetch = globalThis.fetch;

  async function post(body) {
    const response = await submitBooking.handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.81' },
      body: JSON.stringify(body),
    });
    return { response, body: JSON.parse(response.body) };
  }

  before(() => {
    process.env.DRAFT_TOKEN_SECRET = 'n'.repeat(40);
    process.env.CONTEXT = 'deploy-preview';
    process.env.TWILIO_SEND_ENABLED = 'false';
    delete process.env.SLOT_INDEX_READS;
    delete require.cache[SUBMIT_PATH];
    submitBooking = require('../netlify/functions/submit-booking');
    globalThis.fetch = async () => {
      throw new Error('unexpected_external_call');
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    submitBooking.__test.setBlobsStoreOverride(null);
    submitBooking.__test.setSlotScanTimeoutMs(0);
  });

  beforeEach(() => {
    store = createMemoryStore();
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    submitBooking.__test.setSlotScanTimeoutMs(0);
  });

  async function persistFirst() {
    const draft = await post(requestPayload({ isDraft: true, phone: '2015550160' }));
    assert.equal(draft.response.statusCode, 200, draft.body.error);
    const final = await post(requestPayload({
      phone: '2015550160',
      draftBookingId: draft.body.id,
      draftSaveToken: draft.body.draftSaveToken,
    }));
    assert.equal(final.response.statusCode, 200, final.body.error);
    assert.equal(store.finalized().length, 1);
    return final.body.id;
  }

  it('A — successful verification prevents a second booking', async () => {
    await persistFirst();
    const second = await post(requestPayload({
      isDraft: true,
      phone: '2015550161',
      email: 'other@example.com',
    }));
    assert.equal(second.response.statusCode, 409);
    assert.equal(store.finalized().length, 1);
  });

  it('B — timeout after first persist does not write a second booking', async () => {
    await persistFirst();
    const originalList = store.list.bind(store);
    store.list = () => new Promise(() => {});
    submitBooking.__test.setSlotScanTimeoutMs(40);
    const second = await post(requestPayload({
      isDraft: true,
      phone: '2015550162',
      email: 'timeout@example.com',
    }));
    assert.equal(second.response.statusCode, 503);
    store.list = originalList;
    assert.equal(store.finalized().length, 1);
  });

  it('C — thrown verification after first persist does not write a second booking', async () => {
    await persistFirst();
    store.list = async () => {
      throw new Error('scan_threw');
    };
    const second = await post(requestPayload({
      isDraft: true,
      phone: '2015550163',
      email: 'throw@example.com',
    }));
    assert.equal(second.response.statusCode, 503);
    assert.equal(store.finalized().length, 1);
  });
});
