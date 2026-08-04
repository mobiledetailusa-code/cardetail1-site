/**
 * Card-on-file finalize flow — handler/store fixtures, intercepted Stripe.
 * Covers delayed webhook, token/draft identity failures, and idempotent resubmit.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { issueDraftSaveToken } = require('../netlify/lib/draft-save-token');

const ROOT = path.join(__dirname, '..');

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
    id: 'CD1-COF-1',
    isDraft: true,
    cardOnFileRequired: true,
    cardOnFileStatus: 'pending',
    paymentMethodPreference: 'card_onsite',
    paymentMethod: 'card_onsite',
    acceptedCardOnFilePolicy: true,
    acceptedCardOnFilePolicyAt: '2026-07-17T12:00:00.000Z',
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
      addons: [],
    }],
    totalPrice: 230,
    travelFeeAmount: 0,
    zoneSurcharge: 0,
    setupIntentId: 'seti_test_succeeded_001',
    stripeCustomerId: 'cus_test_001',
    createdAt: '2026-07-17T12:00:00.000Z',
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

describe('Card-on-file finalize flow', () => {
  const submitBooking = require('../netlify/functions/submit-booking');
  const { reconcileCardOnFileFromStripe } = require('../netlify/lib/card-on-file');
  let origFetch;
  let stripeCalls;

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
    delete process.env.CD1_FORCE_LOCAL_STRIPE_GUARD;
  });

  beforeEach(() => {
    stripeCalls = [];
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      stripeCalls.push({ url: u, method: opts.method || 'GET' });
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
              metadata: { bookingId: 'CD1-COF-1' },
            };
          },
        };
      }
      if (u.includes('/setup_intents/')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { id: 'seti_other', status: 'requires_payment_method', metadata: {} };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    };
  });

  it('frontend payload includes draftSaveToken on finalize', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(index, /draftBookingId:ST\.bookingId,draftSaveToken:ST\.draftSaveToken/);
    const confirm = index.slice(
      index.indexOf('async function confirmSetupIntent'),
      index.indexOf('async function recheckCardStatus')
    );
    assert.match(confirm, /setupIntent\.status!=='succeeded'/);
    assert.doesNotMatch(
      confirm.split("setupIntent.status!=='succeeded'")[0],
      /ST\.cardOnFileSaved\s*=\s*true/
    );
    const submit = index.slice(
      index.indexOf('async function submitBooking'),
      index.indexOf('function readSiteAccessFields')
    );
    assert.match(submit, /draft_token_invalid/);
    assert.match(submit, /booking_policy_required/);
    assert.match(submit, /stripe_test_mode_required/);
  });

  it('succeeded SetupIntent + delayed webhook reconciles on finalize', async () => {
    const draft = baseDraft({ cardOnFileStatus: 'pending' });
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    const issued = issueDraftSaveToken({ bookingId: draft.id, phone: draft.phone });
    assert.equal(issued.ok, true);

    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, issued.token)),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.cardOnFileStatus, 'saved');
    const saved = await store.get(draft.id);
    assert.equal(saved.isDraft, false);
    assert.equal(saved.cardOnFileStatus, 'saved');
    assert.equal(saved.stripePaymentMethodId, 'pm_test_001');
    assert.ok(stripeCalls.some((c) => c.url.includes('setup_intents/seti_test_succeeded_001')));
  });

  it('succeeded SetupIntent + webhook already applied skips Stripe lookup path', async () => {
    const draft = baseDraft({
      cardOnFileStatus: 'saved',
      stripePaymentMethodId: 'pm_already',
      cardOnFileSavedAt: '2026-07-17T12:05:00.000Z',
    });
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    const issued = issueDraftSaveToken({ bookingId: draft.id, phone: draft.phone });
    const beforeCalls = stripeCalls.length;
    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, issued.token)),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(stripeCalls.length, beforeCalls);
    const saved = await store.get(draft.id);
    assert.equal(saved.stripePaymentMethodId, 'pm_already');
  });

  it('lost or changed draft ID fails closed', async () => {
    const draft = baseDraft();
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    const issued = issueDraftSaveToken({ bookingId: draft.id, phone: draft.phone });
    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, issued.token, { draftBookingId: 'CD1-OTHER' })),
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Draft booking not found');
  });

  it('invalid draft token is rejected', async () => {
    const draft = baseDraft({ cardOnFileStatus: 'saved' });
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(finalizeBody(draft, 'v1.9999999999.badtoken')),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'draft_token_invalid');
  });

  it('missing draftSaveToken is rejected (Release A regression)', async () => {
    const draft = baseDraft({ cardOnFileStatus: 'saved' });
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    const body = finalizeBody(draft, 'unused');
    delete body.draftSaveToken;
    const res = await submitBooking.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify(body),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'draft_token_invalid');
  });

  it('idempotent resubmission after finalize returns same booking', async () => {
    const draft = baseDraft({ cardOnFileStatus: 'saved', stripePaymentMethodId: 'pm_x' });
    const store = createMemoryStore({ [draft.id]: draft });
    submitBooking.__test.setBlobsStoreOverride(async () => store);
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
    assert.equal(body.idempotent, true);
    assert.equal(body.id, draft.id);
  });

  it('draft overwrite preserves setupIntent and stripe customer fields', () => {
    const existing = baseDraft({
      setupIntentId: 'seti_keep',
      stripeCustomerId: 'cus_keep',
      stripePaymentMethodId: 'pm_keep',
      cardOnFileStatus: 'pending',
    });
    const next = submitBooking.__test.buildDraftRecord(
      {
        paymentMethodPreference: 'card_onsite',
        firstName: 'Updated',
        lastName: 'Name',
        phone: '5513132956',
        totalPrice: 210,
      },
      existing.id,
      new Date().toISOString(),
      existing
    );
    assert.equal(next.setupIntentId, 'seti_keep');
    assert.equal(next.stripeCustomerId, 'cus_keep');
    assert.equal(next.stripePaymentMethodId, 'pm_keep');
    assert.equal(next.cardOnFileStatus, 'pending');
    assert.equal(next.firstName, 'Updated');
  });

  it('reconcile rejects over mismatched metadata booking id', async () => {
    const draft = baseDraft({ id: 'CD1-OTHER', setupIntentId: 'seti_test_succeeded_001' });
    const store = createMemoryStore({ [draft.id]: draft });
    const out = await reconcileCardOnFileFromStripe(store, draft);
    assert.equal(out.cardOnFileStatus, 'pending');
  });

  it('hub pages include draftSaveToken on finalize payload', () => {
    const hubs = [
      'new-jersey-hub.html',
      'bergen-county-hub.html',
      'ny-metro-hub.html',
      'westchester-mobile-detailing.html',
    ];
    for (const hub of hubs) {
      const html = fs.readFileSync(path.join(ROOT, hub), 'utf8');
      assert.match(html, /draftBookingId:ST\.bookingId,draftSaveToken:ST\.draftSaveToken/, hub);
      assert.match(html, /setupIntent\.status!=='succeeded'/, hub);
    }
  });
});
