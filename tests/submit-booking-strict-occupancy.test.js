'use strict';
// Booking handlers need an explicit availability store (fail-closed reads).
const availability = require('./helpers/availability-store');

availability.useDefaultAvailabilityStore();

/**
 * submit-booking: the full-store occupancy fallback (used only when the slot
 * index cannot answer) must be strict. It used to keep a second, lenient scan:
 * an unreadable record was skipped, and a paginated listing that failed
 * mid-way fell back to a one-shot listing. Either could hide an existing
 * booking and let a second appointment take the same window. It now reuses
 * ops-db listBookingsForSlotLockStrict (PR #434), the same authority as public
 * recovery. Failed, partial, truncated or timed-out reads return the retryable
 * booking_verification_unavailable (503), never "no bookings". Genuine
 * conflicts stay 409 booking_slot_unavailable.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
const opsDb = require('../netlify/lib/ops-db');
const { setSlotIndexStoreOverride, slotIndexKey } = require('../netlify/lib/slot-index');

const ROOT = path.join(__dirname, '..');
const DATE = '2099-06-16';
const TIME = '10:00 AM';
const OTHER_DATE = '2099-07-21';

function isoWeekday(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function nextWeekday(fromIso, weekday) {
  const d = new Date(`${fromIso}T12:00:00Z`);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const SUNDAY = nextWeekday('2099-06-01', 0);
const PLAIN_SUNDAY = nextWeekday('2099-06-15', 0);
const CLOSED_TUESDAY = nextWeekday('2099-06-22', 2);

// CI shares one Postgres across test files and the indexed finalize path
// matches duplicates through the identity mirror, so identities are unique per run.
const RUN = Math.floor(Math.random() * 100000);
const phoneFor = (n) => `201${2000000 + RUN * 20 + n}`;
const emailFor = (n) => `strict-occupancy-${RUN}-${n}@example.com`;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** cd1-bookings double: optional paginate, per-key read faults, call counters. */
function createBookingStore(seed = {}, { paginate = false, pageSize = 100 } = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, clone(v)]));
  const failing = new Set();
  const hanging = new Set();
  const store = {
    data,
    failing,
    hanging,
    lists: 0,
    reads: 0,
    async get(key) {
      store.reads += 1;
      if (hanging.has(key)) return new Promise(() => {});
      if (failing.has(key)) throw new Error('blob_read_failed');
      return data.has(key) ? clone(data.get(key)) : null;
    },
    async setJSON(key, value) {
      data.set(key, clone(value));
      return { modified: true };
    },
    async delete(key) { data.delete(key); },
    list(opts) {
      store.lists += 1;
      const blobs = [...data.keys()].map((key) => ({ key }));
      if (paginate && opts && opts.paginate) {
        return (async function* pages() {
          for (let i = 0; i < blobs.length; i += pageSize) yield { blobs: blobs.slice(i, i + pageSize) };
        })();
      }
      return Promise.resolve({ blobs });
    },
    finalized() {
      return [...data.values()].filter((b) => b && b.kind === 'booking' && b.isDraft === false);
    },
    drafts() {
      return [...data.values()].filter((b) => b && b.isDraft === true);
    },
  };
  return store;
}

function memoryIndexStore() {
  const data = new Map();
  return {
    data,
    list({ prefix = '' } = {}) {
      const blobs = [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return (async function* pages() { yield { blobs }; })();
    },
    async set(key, value, opts = {}) {
      if (opts.onlyIfNew && data.has(key)) return { modified: false };
      data.set(key, value);
      return { modified: true };
    },
    async setJSON(key, value, opts = {}) { return this.set(key, JSON.stringify(value), opts); },
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async delete(key) { data.delete(key); },
  };
}

function bookedOn(id, date, time, overrides = {}) {
  return {
    id,
    phone: '2015550100',
    email: 'other@example.com',
    status: 'Pending Review',
    isDraft: false,
    kind: 'booking',
    bookingVersion: 1,
    finalizedAt: new Date().toISOString(),
    preferredDate: date,
    preferredTime: time,
    ...overrides,
  };
}

/** n unrelated bookings on another date: they count toward the scan bound only. */
function seedUnrelated(n) {
  const seed = {};
  for (let i = 0; i < n; i += 1) {
    const id = `CD1-SEED${String(i).padStart(4, '0')}`;
    seed[id] = bookedOn(id, OTHER_DATE, i % 2 ? '8:00 AM' : '1:00 PM');
  }
  return seed;
}

function requestPayload(overrides = {}) {
  return {
    firstName: 'Strict',
    lastName: 'Occupancy',
    phone: phoneFor(0),
    email: emailFor(0),
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
      basePrice: 250,
      subtotal: 250,
    }],
    totalPrice: 250,
    travelFeeAmount: 0,
    zoneSurcharge: 0,
    paymentMethod: '',
    paymentMethodPreference: 'card_onsite',
    cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false,
    acceptedBookingPolicy: true,
    policyVersion: '2026-08-booking-request',
    ...overrides,
  };
}

describe('submit-booking strict occupancy fallback', () => {
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
      headers: { 'x-nf-client-connection-ip': '203.0.113.81' },
      body: JSON.stringify(body),
    });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }

  const createDraft = (overrides = {}) => post(requestPayload({ isDraft: true, ...overrides }));
  const finalizeDraft = (draft, overrides = {}) => post(requestPayload({
    draftBookingId: draft.id,
    draftSaveToken: draft.draftSaveToken,
    ...overrides,
  }));

  function useStore(next) {
    store = next;
    submitBooking.__test.setBlobsStoreOverride(async () => store);
  }

  function assertUnverified(res, label) {
    assert.equal(res.status, 503, `${label}: ${res.body && res.body.error}`);
    assert.equal(res.body.error, 'booking_verification_unavailable', label);
  }

  before(() => {
    for (const key of envKeys) env[key] = process.env[key];
    process.env.DRAFT_TOKEN_SECRET = 's'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.TWILIO_SEND_ENABLED = 'false';
    process.env.CONTEXT = 'deploy-preview';
    delete process.env.NETLIFY_DEV;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.SLOT_INDEX_READS;
    delete require.cache[SUBMIT_PATH];
    submitBooking = require('../netlify/functions/submit-booking');
    globalThis.fetch = async () => { throw new Error('unexpected_external_call'); };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    submitBooking.__test.setBlobsStoreOverride(null);
    submitBooking.__test.setSlotScanTimeoutMs(0);
    setSlotIndexStoreOverride(null);
    availability.useDefaultAvailabilityStore();
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  beforeEach(() => {
    useStore(createBookingStore());
    submitBooking.__test.setSlotScanTimeoutMs(0);
    submitBooking.__test.resetNotificationAttempts();
    setSlotIndexStoreOverride(null);
    availability.useDefaultAvailabilityStore();
    delete process.env.SLOT_INDEX_READS;
  });

  afterEach(() => {
    submitBooking.__test.setSlotScanTimeoutMs(0);
    setSlotIndexStoreOverride(null);
  });

  describe('healthy slot index', () => {
    it('answers from the index without reading the booking store', async () => {
      setSlotIndexStoreOverride(memoryIndexStore());
      store.list = () => { throw new Error('scan_must_not_run'); };
      const draft = await createDraft();
      assert.equal(draft.status, 200, draft.body.error);
      const final = await finalizeDraft(draft.body);
      assert.equal(final.status, 200, final.body.error);
      assert.equal(store.finalized().length, 1);
    });

    it('a booked index entry is a genuine conflict (409), not a verification failure', async () => {
      const index = memoryIndexStore();
      await index.setJSON(slotIndexKey({ slotDate: DATE, slotTime: TIME, state: 'booked', expiresAtMs: 0, bookingId: 'CD1-HELD' }), 1);
      setSlotIndexStoreOverride(index);
      const draft = await createDraft();
      assert.equal(draft.status, 409);
      assert.equal(draft.body.error, 'booking_slot_unavailable');
      assert.equal(store.data.size, 0);
    });
  });

  describe('index unavailable: complete fallback reads', () => {
    it('a free window with a complete scan still books once', async () => {
      useStore(createBookingStore(seedUnrelated(25), { paginate: true, pageSize: 10 }));
      const draft = await createDraft();
      assert.equal(draft.status, 200, draft.body.error);
      const final = await finalizeDraft(draft.body);
      assert.equal(final.status, 200, final.body.error);
      assert.equal(final.body.bookingCreated, true);
      assert.equal(store.finalized().filter((b) => b.preferredDate === DATE).length, 1);
    });

    it('a fully occupied window is a genuine conflict (409)', async () => {
      useStore(createBookingStore({ 'CD1-TAKEN': bookedOn('CD1-TAKEN', DATE, TIME) }));
      const draft = await createDraft();
      assert.equal(draft.status, 409);
      assert.equal(draft.body.error, 'booking_slot_unavailable');
      assert.equal(store.drafts().length, 0);
    });

    it('499 records: complete scan answers', async () => {
      useStore(createBookingStore(seedUnrelated(499), { paginate: true }));
      const draft = await createDraft();
      assert.equal(draft.status, 200, draft.body.error);
    });

    it('a capacity-2 window accepts the second booking and refuses the third', async () => {
      availability.useDefaultAvailabilityStore({
        version: 1,
        dateOverrides: { [DATE]: { enabled: true, capacity: 2, arrivalWindows: ['8:00 AM', TIME] } },
      });
      useStore(createBookingStore({ 'CD1-ONE': bookedOn('CD1-ONE', DATE, TIME) }));
      const second = await createDraft();
      assert.equal(second.status, 200, second.body.error);
      store.data.set('CD1-TWO', bookedOn('CD1-TWO', DATE, TIME));
      const third = await createDraft({ phone: phoneFor(1), email: emailFor(1) });
      assert.equal(third.status, 409);
      assert.equal(third.body.error, 'booking_slot_unavailable');
    });
  });

  describe('index unavailable: incomplete fallback reads fail closed', () => {
    it('an unreadable record on the requested window is not treated as absent', async () => {
      useStore(createBookingStore({ 'CD1-HIDDEN': bookedOn('CD1-HIDDEN', DATE, TIME) }));
      store.failing.add('CD1-HIDDEN');
      const draft = await createDraft();
      assertUnverified(draft, 'unreadable record');
      assert.equal(store.drafts().length, 0, 'no draft or hold is written');
    });

    it('an unreadable unrelated record still fails closed (the scan cannot prove completeness)', async () => {
      useStore(createBookingStore(seedUnrelated(3)));
      store.failing.add('CD1-SEED0001');
      assertUnverified(await createDraft(), 'unrelated unreadable record');
      assert.equal(store.drafts().length, 0);
    });

    it('a paginated listing that fails mid-way is not replaced by a one-page listing', async () => {
      const seed = { ...seedUnrelated(150), 'CD1-LATE': bookedOn('CD1-LATE', DATE, TIME) };
      useStore(createBookingStore(seed));
      const keys = [...store.data.keys()];
      store.list = (opts) => {
        store.lists += 1;
        if (opts && opts.paginate) {
          return (async function* pages() {
            yield { blobs: keys.slice(0, 100).map((key) => ({ key })) };
            throw new Error('page_two_failed');
          })();
        }
        // The old lenient scan retried here and got only the first page.
        return Promise.resolve({ blobs: keys.slice(0, 100).map((key) => ({ key })) });
      };
      assertUnverified(await createDraft(), 'mid-pagination failure');
      assert.equal(store.drafts().length, 0);
    });

    it('a listing failure returns 503 and writes nothing', async () => {
      store.list = async () => { throw new Error('blob_list_failed'); };
      assertUnverified(await createDraft(), 'list failure');
      assert.equal(store.data.size, 0);
    });

    it('a hung record read times out into 503', async () => {
      useStore(createBookingStore(seedUnrelated(2)));
      store.hanging.add('CD1-SEED0000');
      submitBooking.__test.setSlotScanTimeoutMs(40);
      const keepAlive = setInterval(() => {}, 10);
      try {
        assertUnverified(await createDraft(), 'storage timeout');
      } finally {
        clearInterval(keepAlive);
      }
      assert.equal(store.drafts().length, 0);
    });

    it('500 records reach the scan bound: treated as truncated, never complete', async () => {
      useStore(createBookingStore(seedUnrelated(500), { paginate: true }));
      assertUnverified(await createDraft(), '500 records');
      assert.equal(store.drafts().length, 0);
    });

    it('more than 500 records: truncated, fails closed without reading past the bound', async () => {
      useStore(createBookingStore(seedUnrelated(509), { paginate: true }));
      assertUnverified(await createDraft(), '509 records');
      assert.equal(store.reads, 0, 'a truncated listing is refused before any record is fetched');
      assert.equal(store.drafts().length, 0);
    });

    it('a non-paginated listing over the bound is refused the same way', async () => {
      useStore(createBookingStore(seedUnrelated(501)));
      assertUnverified(await createDraft(), '501 records, one-shot listing');
    });
  });

  describe('finalize lifecycle', () => {
    it('Review & Submit: a verification failure leaves the draft intact, sends nothing, and the retry books once', async () => {
      useStore(createBookingStore(seedUnrelated(4)));
      const draft = await createDraft();
      assert.equal(draft.status, 200, draft.body.error);
      store.failing.add('CD1-SEED0002');
      const blocked = await finalizeDraft(draft.body);
      assertUnverified(blocked, 'finalize');
      const saved = await store.get(draft.body.id);
      assert.equal(saved.isDraft, true, 'draft is not finalized');
      assert.equal(store.finalized().filter((b) => b.preferredDate === DATE).length, 0);
      assert.equal(submitBooking.__test.notificationAttempts(), 0, 'no customer notification');
      assert.equal(saved.paymentStatus === 'paid' || saved.paymentStatus === 'partially_paid', false);

      store.failing.clear();
      const retry = await finalizeDraft(draft.body);
      assert.equal(retry.status, 200, retry.body.error);
      assert.equal(store.finalized().filter((b) => b.preferredDate === DATE).length, 1);
    });

    it('a finalized booking replayed is idempotent and never re-scanned into a duplicate', async () => {
      const draft = await createDraft();
      const final = await finalizeDraft(draft.body);
      assert.equal(final.status, 200, final.body.error);
      const replay = await finalizeDraft({ id: final.body.id, draftSaveToken: 'replay' });
      assert.equal(replay.status, 200, replay.body.error);
      assert.equal(replay.body.idempotent, true);
      assert.equal(store.finalized().length, 1);
    });

    it('concurrent finalizes of one draft create one booking', async () => {
      const draft = await createDraft();
      assert.equal(draft.status, 200, draft.body.error);
      const results = await Promise.all([finalizeDraft(draft.body), finalizeDraft(draft.body)]);
      assert.ok(results.some((r) => r.status === 200), JSON.stringify(results.map((r) => r.body.error)));
      for (const r of results) assert.ok([200, 409, 503].includes(r.status), String(r.status));
      assert.equal(store.finalized().length, 1);
    });

    it('concurrent submissions while verification is down: none books, none holds', async () => {
      useStore(createBookingStore(seedUnrelated(2)));
      store.failing.add('CD1-SEED0000');
      const results = await Promise.all([
        createDraft(),
        createDraft({ phone: phoneFor(2), email: emailFor(2) }),
        createDraft({ phone: phoneFor(3), email: emailFor(3) }),
      ]);
      for (const r of results) assertUnverified(r, 'concurrent');
      assert.equal(store.drafts().length, 0);
      assert.equal(store.finalized().filter((b) => b.preferredDate === DATE).length, 0);
    });
  });

  describe('schedule rules stay in force', () => {
    it('alternate date: an unverifiable alternate window fails closed too', async () => {
      useStore(createBookingStore({ 'CD1-ALT': bookedOn('CD1-ALT', OTHER_DATE, TIME) }));
      store.failing.add('CD1-ALT');
      const res = await createDraft({
        alternateDate: OTHER_DATE,
        alternateTime: TIME,
        alternateArrivalWindow: '',
      });
      assertUnverified(res, 'alternate date');
      assert.equal(store.drafts().length, 0);
    });

    it('an opened Sunday books with a complete scan and fails closed on an incomplete one', async () => {
      assert.equal(isoWeekday(SUNDAY), 0);
      availability.useDefaultAvailabilityStore({
        version: 1,
        dateOverrides: { [SUNDAY]: { enabled: true, arrivalWindows: ['8:00 AM', TIME] } },
      });
      useStore(createBookingStore(seedUnrelated(2)));
      const ok = await createDraft({ preferredDate: SUNDAY });
      assert.equal(ok.status, 200, ok.body.error);
      store.failing.add('CD1-SEED0001');
      assertUnverified(await createDraft({ preferredDate: SUNDAY, phone: phoneFor(4), email: emailFor(4) }), 'opened Sunday');
    });

    it('a plain Sunday, an explicitly closed date and a holiday are refused regardless of occupancy', async () => {
      availability.useDefaultAvailabilityStore({
        version: 1,
        dateOverrides: { [CLOSED_TUESDAY]: { enabled: false } },
      });
      for (const date of [PLAIN_SUNDAY, CLOSED_TUESDAY, '2099-12-25']) {
        useStore(createBookingStore());
        const res = await createDraft({ preferredDate: date });
        assert.notEqual(res.status, 200, `${date} must not book`);
        assert.equal(store.drafts().length, 0, `${date} writes no hold`);
      }
    });
  });

  describe('public booking entry points', () => {
    const PAGES = [
      'index.html', 'bergen-county-hub.html', 'hudson-county-hub.html', 'essex-county-hub.html',
      'passaic-county-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html', 'pennsylvania-hub.html',
      'new-jersey-hub.html', 'newark-mobile-detailing.html', 'trenton-mobile-detailing.html',
      'westchester-mobile-detailing.html', 'template-city.html',
    ];

    it('all 13 pages submit through the runtime that treats the 503 as retryable, nothing booked', () => {
      const runtime = fs.readFileSync(path.join(ROOT, 'assets/booking-review-runtime.js'), 'utf8');
      assert.match(runtime, /RETRYABLE_FINALIZE_CODES = \{\s*booking_verification_unavailable: true/);
      assert.match(runtime, /booking_verification_unavailable: 'We could not verify whether this time is still available\. Nothing was booked\./);
      for (const page of PAGES) {
        const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
        assert.match(html, /booking-review-runtime\.js/, `${page} loads the shared submit runtime`);
      }
    });
  });

  describe('single strict authority', () => {
    it('submit-booking reuses ops-db listBookingsForSlotLockStrict and keeps no lenient scan', () => {
      const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/submit-booking.js'), 'utf8');
      assert.match(src, /listBookingsForSlotLockStrict\(\{ store: scoped \}\)\.catch/);
      assert.doesNotMatch(src, /\blistBookingsForSlotLock\(/);
      assert.doesNotMatch(src, /fetchBlobRecords\(/);
      assert.doesNotMatch(src, /listRequestStoreBlobs/);
    });

    it('the strict reader accepts the caller store and enforces the same bound', async () => {
      const small = createBookingStore({ 'CD1-X': bookedOn('CD1-X', DATE, TIME) });
      const rows = await opsDb.listBookingsForSlotLockStrict({ store: small });
      assert.deepEqual(rows.map((b) => b.id), ['CD1-X']);
      const big = createBookingStore(seedUnrelated(opsDb.BLOB_UNION_MAX_KEYS), { paginate: true });
      await assert.rejects(opsDb.listBookingsForSlotLockStrict({ store: big }), /booking_store_listing_truncated/);
    });
  });
});
