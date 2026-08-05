/**
 * Production booking confirmation hotfix regressions.
 * Covers: slot lock before card save, bookingCreated success contract,
 * email failure does not hide booking, frontend success gating.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { issueDraftSaveToken } = require('../netlify/lib/draft-save-token');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
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
    _data: data,
  };
}

function baseDraft(overrides = {}) {
  return {
    id: 'CD1-HOTFIX-1',
    isDraft: true,
    cardOnFileRequired: true,
    cardOnFileStatus: 'saved',
    paymentMethodPreference: 'card_onsite',
    paymentMethod: 'card_onsite',
    acceptedCardOnFilePolicy: true,
    acceptedCardOnFilePolicyAt: '2026-07-26T12:00:00.000Z',
    firstName: 'Test',
    lastName: 'Owner',
    phone: '5513132956',
    email: 'owner@example.com',
    address: '1 Main St Newark NJ',
    zipCode: '07102',
    preferredDate: '2099-06-16',
    preferredTime: '10:00 AM',
    package: 'Premium Detail',
    packageId: 'full',
    vehicleCategory: 'cars',
    vehicles: [{
      cat: 'cars',
      pkgId: 'full',
      pkgName: 'Premium Detail',
      tierLabel: 'Small Car',
      tierKey: 'sedan',
      addons: [],
      addonTotal: 0,
      basePrice: 240,
      subtotal: 240,
    }],
    totalPrice: 240,
    travelFeeAmount: 0,
    zoneSurcharge: 0,
    setupIntentId: 'seti_test_succeeded_001',
    stripeCustomerId: 'cus_test_001',
    stripePaymentMethodId: 'pm_test_001',
    cardOnFileSavedAt: '2026-07-26T12:01:00.000Z',
    createdAt: '2026-07-26T12:00:00.000Z',
    updatedAt: '2026-07-26T12:01:00.000Z',
    ...overrides,
  };
}

function finalizeBody(draft, token, extras = {}) {
  return {
    draftBookingId: draft.id,
    draftSaveToken: token,
    paymentMethodPreference: draft.paymentMethodPreference,
    acceptedCardOnFilePolicy: true,
    acceptedBookingPolicy: true,
    firstName: draft.firstName,
    lastName: draft.lastName,
    phone: draft.phone,
    email: draft.email,
    address: draft.address,
    zipCode: draft.zipCode,
    preferredDate: draft.preferredDate,
    preferredTime: draft.preferredTime,
    package: draft.package,
    packageId: draft.packageId,
    vehicleCategory: draft.vehicleCategory,
    vehicles: draft.vehicles,
    totalPrice: draft.totalPrice,
    travelFeeAmount: draft.travelFeeAmount || 0,
    zoneSurcharge: draft.zoneSurcharge || 0,
    ...extras,
  };
}

describe('Booking confirmation hotfix — frontend contracts', () => {
  for (const page of BOOKING_PAGES) {
    it(`${page} does not show booking success from card save alone`, () => {
      const html = read(page);
      const confirm = html.slice(
        html.indexOf('async function confirmSetupIntent'),
        html.indexOf('async function recheckCardStatus')
      );
      assert.doesNotMatch(confirm, /showSuccess\(/);
      assert.doesNotMatch(confirm, /Booking Request Received/);
      assert.match(confirm, /Your appointment is not submitted yet\.|COF_SAVED_MSG/);
    });

    it(`${page} requires bookingCreated + durable id before success UI`, () => {
      const html = read(page);
      const submit = html.slice(
        html.indexOf('async function submitBooking'),
        html.indexOf('function readSiteAccessFields')
      );
      assert.match(submit, /bookingCreated===false/);
      assert.match(submit, /bookingCreated!==true/);
      assert.match(submit, /booking_not_persisted/);
      assert.match(submit, /booking_slot_unavailable/);
      assert.doesNotMatch(submit, /Card Saved — Booking Request Received|Card Saved - Booking Request Received/);
    });

    it(`${page} preserves recoverable slot-failure messaging and form state`, () => {
      const html = read(page);
      const submit = html.slice(
        html.indexOf('async function submitBooking'),
        html.indexOf('function readSiteAccessFields')
      );
      assert.match(submit, /your card stays saved/);
      assert.doesNotMatch(submit, /clearDraftRegistrationState\(\)/);
      assert.match(html, /Booking Request Received/);
      assert.doesNotMatch(
        html.slice(html.indexOf('function showSuccess'), html.indexOf('function showSuccess') + 900),
        /Card Saved — Booking Request Received|Card Saved - Booking Request Received/
      );
    });

    it(`${page} sends form phone on card-status poll`, () => {
      const html = read(page);
      assert.match(html, /document\.getElementById\('f-phone'\)\?\.value/);
      assert.doesNotMatch(
        html.slice(html.indexOf('async function waitForVerifiedCardSave'), html.indexOf('async function waitForVerifiedCardSave') + 450),
        /draftSessionToken/
      );
    });
  }

  it('Owner Studio files remain untouched by this hotfix surface', () => {
    const ownerFiles = [
      'netlify/lib/owner-studio/audit.js',
      'netlify/functions/owner-studio-status.js',
    ].filter((f) => fs.existsSync(path.join(ROOT, f)));
    for (const f of ownerFiles) {
      const src = read(f);
      assert.doesNotMatch(src, /bookingCreated/);
      assert.doesNotMatch(src, /listBookingsForSlotLock/);
    }
  });
});

describe('Booking confirmation hotfix — submit-booking persistence', () => {
  const submitBooking = require('../netlify/functions/submit-booking');
  const opsDb = require('../netlify/lib/ops-db');
  let origFetch;

  before(() => {
    process.env.DRAFT_TOKEN_SECRET = process.env.DRAFT_TOKEN_SECRET || 'a'.repeat(40);
    process.env.STRIPE_SECRET_KEY = 'sk_test_card_on_file_fixture';
    process.env.CONTEXT = 'deploy-preview';
    process.env.CD1_FORCE_LOCAL_STRIPE_GUARD = '1';
    origFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = origFetch;
    submitBooking.__test.setBlobsStoreOverride(null);
    opsDb.setOpsStoreOverride(null);
    delete process.env.CD1_FORCE_LOCAL_STRIPE_GUARD;
  });

  beforeEach(() => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/setup_intents/seti_test_succeeded_001')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: 'seti_test_succeeded_001',
              status: 'succeeded',
              customer: 'cus_test_001',
              payment_method: 'pm_test_001',
              metadata: { bookingId: 'CD1-HOTFIX-1' },
            };
          },
        };
      }
      // Resend / Twilio / other side effects: fail closed without throwing.
      return {
        ok: false,
        status: 503,
        async text() { return 'provider_unavailable'; },
        async json() { return { error: 'provider_unavailable' }; },
      };
    };
  });

  it('card setup saved + booking finalize succeeds with bookingCreated', async () => {
    const draft = baseDraft();
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    opsDb.setOpsStoreOverride(store);
    const issued = issueDraftSaveToken({ bookingId: draft.id, phone: draft.phone });
    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, issued.token)),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.bookingCreated, true);
    assert.equal(body.id, draft.id);
    const saved = await store.get(draft.id);
    assert.equal(saved.isDraft, false);
    assert.equal(saved.status, 'Pending Review');
    assert.ok(saved.finalizedAt);
  });

  it('finalize rejects taken slots after card save without persisting booking', async () => {
    const draft = baseDraft({
      preferredDate: '2099-06-16',
      preferredTime: '8:00 AM',
    });
    const blocker = {
      id: 'CD1-BLOCKER',
      isDraft: false,
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2099-06-16',
      preferredTime: '8:00 AM',
    };
    const store = createMemoryStore({ [draft.id]: draft, [blocker.id]: blocker });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    opsDb.setOpsStoreOverride(store);
    const issued = issueDraftSaveToken({ bookingId: draft.id, phone: draft.phone });
    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, issued.token)),
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.bookingCreated, false);
    assert.equal(body.error, 'booking_slot_unavailable');
    assert.match(String(body.userMessage || ''), /card was not charged|card stays saved|no longer available/i);
    const stillDraft = await store.get(draft.id);
    assert.equal(stillDraft.isDraft, true);
    assert.equal(stillDraft.finalizedAt || null, null);
  });

  it('draft creation rejects taken slots before card save', async () => {
    const blocker = {
      id: 'CD1-BLOCKER-2',
      isDraft: false,
      status: 'Pending Review',
      jobStatus: 'pending_review',
      preferredDate: '2099-06-17',
      preferredTime: '10:00 AM',
    };
    const store = createMemoryStore({ [blocker.id]: blocker });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    opsDb.setOpsStoreOverride(store);
    const draftShape = baseDraft({
      id: undefined,
      preferredDate: '2099-06-17',
      preferredTime: '10:00 AM',
      cardOnFileStatus: 'pending',
      setupIntentId: undefined,
      stripeCustomerId: undefined,
      stripePaymentMethodId: undefined,
    });
    delete draftShape.id;
    delete draftShape.setupIntentId;
    delete draftShape.stripeCustomerId;
    delete draftShape.stripePaymentMethodId;
    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({
        ...draftShape,
        isDraft: true,
        acceptedCardOnFilePolicy: true,
      }),
    });
    assert.equal(res.statusCode, 409, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.bookingCreated, false);
    assert.equal(body.error, 'booking_slot_unavailable');
  });

  it('booking persists when email provider fails and remains Admin-visible', async () => {
    const draft = baseDraft({ id: 'CD1-HOTFIX-EMAIL' });
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    opsDb.setOpsStoreOverride(store);
    const issued = issueDraftSaveToken({ bookingId: draft.id, phone: draft.phone });
    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, issued.token)),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.bookingCreated, true);
    const saved = await store.get(draft.id);
    assert.equal(saved.isDraft, false);
    assert.equal(saved.status, 'Pending Review');
    const { isVisibleSubmittedBooking } = require('../netlify/lib/booking-visibility');
    assert.equal(isVisibleSubmittedBooking(saved), true);
  });

  it('idempotent finalize returns existing booking without duplicating', async () => {
    const draft = baseDraft({ id: 'CD1-HOTFIX-IDEM' });
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    opsDb.setOpsStoreOverride(store);
    const issued = issueDraftSaveToken({ bookingId: draft.id, phone: draft.phone });
    const first = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, issued.token)),
    });
    assert.equal(first.statusCode, 200);
    const second = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, issued.token)),
    });
    assert.equal(second.statusCode, 200);
    const body = JSON.parse(second.body);
    assert.equal(body.ok, true);
    assert.equal(body.bookingCreated, true);
    assert.equal(body.idempotent, true);
    assert.equal(body.id, draft.id);
    const keys = [...store._data.keys()].filter((k) => String(k).startsWith('CD1-HOTFIX-IDEM'));
    assert.equal(keys.length, 1);
  });

  it('create-setup-intent remains SetupIntent-only (no charge path)', () => {
    const src = read('netlify/functions/create-setup-intent.js');
    assert.match(src, /setup_intents/);
    assert.doesNotMatch(src, /payment_intents/);
    assert.doesNotMatch(src, /confirm\s*\(/);
    assert.match(src, /No charge is applied|off_session/);
  });
});
