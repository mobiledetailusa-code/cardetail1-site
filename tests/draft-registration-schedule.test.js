// Draft registration schedule guard — reproduces empty preferredTime failure.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
const SETUP_PATH = require.resolve('../netlify/functions/create-setup-intent');
const {
  MIN_ADVANCE_DAYS,
  addLocalDays,
  findNearbyOpenings,
  slotsForDate,
  toIsoLocal,
  validateBookingSchedule,
} = require('../netlify/lib/operational-availability');

// Keep downstream handler tests comfortably beyond the live minimum-date gate,
// then let the canonical scheduling contract choose an actually open day/slot.
// The extra week prevents a test that crosses midnight from expiring mid-run.
const FIXTURE_MARGIN_DAYS = 7;

function validDraftSchedule(now = new Date()) {
  const searchFrom = toIsoLocal(addLocalDays(now, MIN_ADVANCE_DAYS + FIXTURE_MARGIN_DAYS));
  const [opening] = findNearbyOpenings(searchFrom, null, {
    now,
    limit: 1,
    horizonDays: 21,
  });
  assert.ok(opening, `expected an open booking slot on or after ${searchFrom}`);
  return {
    preferredDate: opening.preferredDate,
    preferredTime: opening.preferredTime,
  };
}

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

const ENV_KEYS = [
  'DRAFT_TOKEN_SECRET',
  'ADMIN_SESSION_SECRET',
  'CONTEXT',
  'NETLIFY_DEV',
  'STRIPE_SECRET_KEY',
];

let envSnap;

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
  delete require.cache[SUBMIT_PATH];
  delete require.cache[SETUP_PATH];
  delete require.cache[require.resolve('../netlify/lib/public-rate-limit')];
}

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    data,
    async get(key, { type } = {}) {
      if (!data.has(key)) return null;
      const raw = data.get(key);
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) {
      data.set(key, JSON.stringify(value));
    },
  };
}

function validDraftBody(overrides = {}) {
  const schedule = validDraftSchedule();
  return {
    isDraft: true,
    firstName: 'Schedule',
    lastName: 'Test',
    phone: '5513132956',
    email: 'schedule@example.com',
    zipCode: '07650',
    address: '100 Test St',
    paymentMethodPreference: 'card_onsite',
    acceptedCardOnFilePolicy: true,
    preferredDate: schedule.preferredDate,
    preferredTime: schedule.preferredTime,
    vehicleCategory: 'cars',
    vehicle: 'Small Car',
    package: 'Premium Full Detail',
    vehicles: [{
      cat: 'cars',
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      tierKey: 'small',
      tierLabel: 'Small Car',
      vehicleLabel: 'Small Car',
      basePrice: 285,
      subtotal: 285,
      addons: [],
      addonTotal: 0,
    }],
    ...overrides,
  };
}

beforeEach(() => {
  envSnap = snapshotEnv();
  process.env.DRAFT_TOKEN_SECRET = 'd'.repeat(32);
  process.env.CONTEXT = 'dev';
  process.env.NETLIFY_DEV = 'true';
});

afterEach(() => {
  restoreEnv(envSnap);
  try {
    const { __test } = require('../netlify/functions/submit-booking');
    __test.setBlobsStoreOverride(null);
  } catch { /* ignore */ }
  try {
    const { __test } = require('../netlify/functions/create-setup-intent');
    __test.setBlobsStoreOverride(null);
  } catch { /* ignore */ }
});

test('submit-booking draft with invalid phone returns invalid_phone', async () => {
  delete require.cache[SUBMIT_PATH];
  const { handler, __test } = require('../netlify/functions/submit-booking');
  __test.setBlobsStoreOverride(() => createMemoryStore());
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.79' },
    body: JSON.stringify(validDraftBody({ phone: 'honda' })),
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'invalid_phone' });
});

test('derived draft schedule remains valid across calendar dates and midnight rollover', () => {
  for (const now of [
    new Date(2026, 7, 18, 23, 59, 59),
    new Date(2031, 11, 30, 23, 59, 59),
  ]) {
    const schedule = validDraftSchedule(now);
    assert.equal(
      validateBookingSchedule(schedule.preferredDate, schedule.preferredTime, { now }).ok,
      true,
    );

    const afterMidnight = new Date(now.getTime() + (36 * 60 * 60 * 1000));
    assert.equal(
      validateBookingSchedule(schedule.preferredDate, schedule.preferredTime, { now: afterMidnight }).ok,
      true,
    );
  }
});

test('schedule validation still rejects an otherwise open date inside the advance window', () => {
  const now = new Date(2026, 6, 16, 12, 0, 0);
  const insideAdvanceWindow = toIsoLocal(addLocalDays(now, MIN_ADVANCE_DAYS - 1));
  assert.ok(slotsForDate(insideAdvanceWindow, null, now).includes('8:00 AM'));
  assert.deepEqual(
    validateBookingSchedule(insideAdvanceWindow, '8:00 AM', { now }),
    { ok: false, error: 'booking_date_unavailable' },
  );
});

test('submit-booking draft with empty preferredTime returns booking_time_unavailable', async () => {
  delete require.cache[SUBMIT_PATH];
  const { handler, __test } = require('../netlify/functions/submit-booking');
  __test.setBlobsStoreOverride(() => createMemoryStore());
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.80' },
    body: JSON.stringify(validDraftBody({ preferredTime: '' })),
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.bookingCreated, false);
  assert.equal(body.error, 'booking_time_unavailable');
  assert.match(String(body.userMessage || ''), /unavailable/i);
});

test('submit-booking draft with valid schedule issues draftSaveToken', async () => {
  delete require.cache[SUBMIT_PATH];
  const { handler, __test } = require('../netlify/functions/submit-booking');
  __test.setBlobsStoreOverride(() => createMemoryStore());
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.81' },
    body: JSON.stringify(validDraftBody()),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.match(body.draftSaveToken, /^v1\./);
  assert.ok(body.draftSaveTokenExp > 0);
  assert.equal(body.isDraft, true);
});

test('submit-booking draft blob persist failure returns Failed to pre-register booking', async () => {
  delete require.cache[SUBMIT_PATH];
  const { handler, __test } = require('../netlify/functions/submit-booking');
  const failingStore = {
    async get() { return null; },
    async setJSON() {
      const err = new Error('Netlify Blobs has generated an internal error (401 status code)');
      err.name = 'BlobsInternalError';
      throw err;
    },
  };
  __test.setBlobsStoreOverride(() => failingStore);
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.83' },
    body: JSON.stringify(validDraftBody()),
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'Failed to pre-register booking' });
});

test('submit-booking uses shared tech-security blobsStore helper', () => {
  const src = read('netlify/functions/submit-booking.js');
  assert.match(src, /require\('\.\.\/lib\/tech-security'\)/);
  assert.match(src, /sharedBlobsStore/);
  assert.match(src, /draft blob persist failed/);
  assert.match(src, /stage:\s*'booking_persistence'/);
});

test('valid draft token reaches create-setup-intent eligibility check', async () => {
  delete require.cache[SUBMIT_PATH];
  const { handler: submitHandler, __test: submitTest } = require('../netlify/functions/submit-booking');
  const store = createMemoryStore();
  submitTest.setBlobsStoreOverride(() => store);

  const draftRes = await submitHandler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.82' },
    body: JSON.stringify(validDraftBody()),
  });
  const draft = JSON.parse(draftRes.body);
  assert.equal(draft.ok, true);

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/v1/customers')) {
      return { ok: true, json: async () => ({ id: 'cus_test' }) };
    }
    if (String(url).includes('/v1/setup_intents')) {
      return {
        ok: true,
        json: async () => ({
          id: 'seti_test',
          customer: 'cus_test',
          client_secret: 'seti_test_secret',
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    delete require.cache[SETUP_PATH];
    const { handler: setupHandler, __test: setupTest } = require('../netlify/functions/create-setup-intent');
    setupTest.setBlobsStoreOverride(() => store);
    process.env.STRIPE_SECRET_KEY = 'sk_test_schedule_guard';

    const setupRes = await setupHandler({
      httpMethod: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.82' },
      body: JSON.stringify({
        bookingId: draft.id,
        draftSaveToken: draft.draftSaveToken,
        expectedBookingVersion: draft.bookingVersion,
      }),
    });
    assert.equal(setupRes.statusCode, 200);
    const setupBody = JSON.parse(setupRes.body);
    assert.equal(setupBody.ok, true);
    assert.equal(setupBody.clientSecret, 'seti_test_secret');
  } finally {
    global.fetch = originalFetch;
  }
});

for (const page of BOOKING_PAGES) {
  test(`${page} validates schedule before draft registration in initCardOnFile`, () => {
    const html = read(page);
    const initBlock = html.slice(
      html.indexOf('async function initCardOnFile'),
      html.indexOf('function selectPaymentPreference')
    );
    assert.match(initBlock, /const sched=bkValidateScheduleSelection\(\)/);
    assert.match(initBlock, /if\(!sched\.ok\)/);
    assert.match(initBlock, /bkShowScheduleMsg\(sched\.message\)/);
    assert.match(initBlock, /const phone=bkValidateContactPhone\(\)/);
    assert.match(initBlock, /if\(!phone\.ok\)/);
    assert.match(initBlock, /const draftPayload=buildBookingPayload\(\)/);
    const schedIdx = initBlock.indexOf('bkValidateScheduleSelection');
    const phoneIdx = initBlock.indexOf('bkValidateContactPhone');
    const payloadIdx = initBlock.indexOf('buildBookingPayload()');
    assert.ok(schedIdx > 0 && phoneIdx > schedIdx && payloadIdx > phoneIdx);
  });

  test(`${page} maps booking_time_unavailable and invalid_phone in draftErrMap`, () => {
    const html = read(page);
    assert.match(html, /booking_time_unavailable:'That time is unavailable on the selected date/);
    assert.match(html, /invalid_phone:'Please enter a valid phone number/);
  });

  test(`${page} carries booking-version CAS into SetupIntent creation`, () => {
    const html = read(page);
    assert.match(html, /draftBookingVersion/);
    assert.match(html, /requestSetupIntentWithVersionSync\(draftSessionBookingId,draftSessionToken,draftSessionBookingVersion\)/);
    assert.match(html, /data&&data\.bookingVersion!=null/);
  });

  test(`${page} resyncs and retries once on a stale booking version`, () => {
    const html = read(page);
    const helper = html.slice(
      html.indexOf('async function requestSetupIntentWithVersionSync'),
      html.indexOf('async function initCardOnFile')
    );
    assert.ok(helper.length > 0, 'version-sync helper must be present');
    // Server reports actualBookingVersion so the client can resync — a stale
    // version must never surface a raw version_conflict to the customer.
    assert.match(helper, /attempt<2/);
    assert.match(helper, /data\.error==='version_conflict'/);
    assert.match(helper, /ST\.draftBookingVersion=expected/);
  });

  test(`${page} maps the card-save 409 codes to customer-readable copy`, () => {
    const html = read(page);
    assert.match(html, /version_conflict:'Your booking changed while this page was open/);
    assert.match(html, /card_on_file_consent_required:'Please re-accept the card-on-file authorization/);
  });
}
