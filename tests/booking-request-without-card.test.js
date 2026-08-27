const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const submitBooking = require('../netlify/functions/submit-booking');
const { isVisibleSubmittedBooking } = require('../netlify/lib/booking-visibility');
const { projectJobForAdmin } = require('../netlify/lib/ops-workflow');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const { sessionBookingAllowed } = require('../netlify/lib/booking-customer-auth');

function createMemoryStore() {
  const data = new Map();
  return {
    data,
    async get(key) {
      const value = data.get(key);
      return value == null ? null : structuredClone(value);
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value));
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function requestPayload(overrides = {}) {
  return {
    firstName: 'No Card',
    lastName: 'Customer',
    phone: '5513132956',
    email: 'no-card@example.com',
    address: '1 Main St, Newark, NJ',
    zipCode: '07102',
    preferredDate: '2099-06-16',
    preferredTime: '10:00 AM',
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
    }],
    totalPrice: 240,
    travelFeeAmount: 0,
    zoneSurcharge: 0,
    paymentMethod: '',
    paymentMethodPreference: '',
    cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false,
    acceptedCardOnFilePolicyAt: null,
    acceptedBookingPolicy: true,
    policyVersion: '2026-08-booking-request',
    ...overrides,
  };
}

async function post(body) {
  const response = await submitBooking.handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.41' },
    body: JSON.stringify(body),
  });
  return { response, body: JSON.parse(response.body) };
}

describe('initial booking request without card collection', () => {
  const store = createMemoryStore();
  const originalFetch = globalThis.fetch;
  const env = {};
  const envKeys = [
    'DRAFT_TOKEN_SECRET', 'ADMIN_EMAIL', 'RESEND_API_KEY', 'TWILIO_SEND_ENABLED',
    'CONTEXT', 'NETLIFY_DEV', 'STRIPE_SECRET_KEY',
  ];
  const externalCalls = [];

  before(() => {
    for (const key of envKeys) env[key] = process.env[key];
    process.env.DRAFT_TOKEN_SECRET = 'n'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.TWILIO_SEND_ENABLED = 'false';
    process.env.CONTEXT = 'deploy-preview';
    delete process.env.NETLIFY_DEV;
    delete process.env.STRIPE_SECRET_KEY;
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    globalThis.fetch = async (url) => {
      externalCalls.push(String(url));
      throw new Error('unexpected_external_call');
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    submitBooking.__test.setBlobsStoreOverride(null);
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  it('rejects invalid identity, ZIP, and schedule before persistence', async () => {
    const invalidPhone = await post(requestPayload({ isDraft: true, phone: '123' }));
    assert.equal(invalidPhone.response.statusCode, 400);
    assert.equal(invalidPhone.body.error, 'invalid_phone');

    const invalidZip = await post(requestPayload({ isDraft: true, zipCode: '' }));
    assert.equal(invalidZip.response.statusCode, 400);
    assert.equal(invalidZip.body.error, 'zip_required');

    const invalidSchedule = await post(requestPayload({ isDraft: true, preferredDate: '', preferredTime: '' }));
    assert.equal(invalidSchedule.response.statusCode, 400);
    assert.match(invalidSchedule.body.error, /booking_(date|time)_unavailable/);
    assert.equal(store.data.size, 0);
  });

  it('persists and finalizes a no-card request without touching Stripe or a ledger', async () => {
    const draft = await post(requestPayload({ isDraft: true }));
    assert.equal(draft.response.statusCode, 200);
    assert.equal(draft.body.ok, true);
    assert.equal(draft.body.bookingCreated, false);
    assert.match(draft.body.draftSaveToken, /^v1\./);

    const draftRecord = await store.get(draft.body.id);
    assert.equal(draftRecord.isDraft, true);
    assert.equal(draftRecord.cardOnFileRequired, false);
    assert.equal(draftRecord.cardOnFileStatus, 'not_collected');
    assert.equal(draftRecord.paymentMethodPreference, '');
    assert.equal(draftRecord.acceptedCardOnFilePolicy, false);
    assert.equal(isVisibleSubmittedBooking(draftRecord), false);

    const final = await post(requestPayload({
      draftBookingId: draft.body.id,
      draftSaveToken: draft.body.draftSaveToken,
    }));
    assert.equal(final.response.statusCode, 200);
    assert.equal(final.body.ok, true);
    assert.equal(final.body.bookingCreated, true);
    assert.equal(final.body.id, draft.body.id);
    assert.equal(final.body.status, 'Pending Review');
    assert.equal(final.body.paymentStatus, 'no_payment_required_yet');
    assert.equal(final.body.appointmentStatus, 'pending_review');
    assert.equal(final.body.cardOnFileStatus, 'not_collected');

    const saved = await store.get(final.body.id);
    assert.equal(saved.isDraft, false);
    assert.equal(saved.kind, 'booking');
    assert.equal(saved.cardOnFileRequired, false);
    assert.equal(saved.cardOnFileStatus, 'not_collected');
    assert.equal(saved.paymentMethod, '');
    assert.equal(saved.paymentMethodPreference, '');
    assert.equal(saved.paymentStatus, 'no_payment_required_yet');
    assert.equal(saved.paymentWorkflowStatus, 'no_payment_required_yet');
    assert.equal(saved.status, 'Pending Review');
    assert.equal(saved.appointmentStatus, 'pending_review');
    assert.equal(saved.jobStatus, 'pending_review');
    assert.equal(saved.policyVersion, '2026-08-booking-request');
    assert.equal(saved.acceptedBookingPolicy, true);
    assert.equal(saved.acceptedCardOnFilePolicy, false);
    assert.equal('setupIntentId' in saved, false);
    assert.equal('paymentIntentId' in saved, false);
    assert.equal('stripeCustomerId' in saved, false);
    assert.equal('stripePaymentMethodId' in saved, false);
    assert.equal('ledger' in saved, false);
    assert.equal(externalCalls.some((url) => url.includes('stripe.com')), false);

    assert.equal(isVisibleSubmittedBooking(saved), true);
    assert.equal(projectJobForAdmin(saved).id, saved.id);
    assert.equal(projectBookingForCustomer(saved).id, saved.id);
    assert.equal(sessionBookingAllowed({ bookingIds: [saved.id] }, saved), true);
    assert.equal(!!sessionBookingAllowed({ bookingIds: ['CD1-OTHER'] }, saved), false);
  });

  it('replays finalization idempotently and rejects token or payment-field abuse', async () => {
    const [saved] = [...store.data.values()].filter((booking) => booking.isDraft === false);
    assert.ok(saved);

    const replay = await post(requestPayload({
      draftBookingId: saved.id,
      draftSaveToken: 'the-finalized-path-does-not-reissue-this-token',
    }));
    assert.equal(replay.response.statusCode, 200);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.id, saved.id);

    const fresh = await post(requestPayload({ isDraft: true, phone: '2015550100' }));
    const badToken = await post(requestPayload({
      phone: '2015550100',
      draftBookingId: fresh.body.id,
      draftSaveToken: 'v1.9999999999.invalid',
    }));
    assert.equal(badToken.response.statusCode, 401);
    assert.equal(badToken.body.error, 'draft_token_invalid');

    const paymentField = await post(requestPayload({
      isDraft: true,
      phone: '2015550199',
      paymentMethodPreference: 'not_a_real_method',
    }));
    assert.equal(paymentField.response.statusCode, 400);
    assert.equal(paymentField.body.error, 'invalid_payment_preference');
  });
});
