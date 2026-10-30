'use strict';

process.env.PRISMA_BOOKING_MIRROR = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { squareAuthorityEnv, projectionForBooking } = require('./helpers/square-preparation-authority');
const {
  prepareSquarePaymentLink,
  operationIdentity,
  createIssuanceId,
} = require('../netlify/lib/square-prepared-issuance');
process.env.PRISMA_BOOKING_READ = '0';
delete process.env.NETLIFY_SITE_ID;
delete process.env.NETLIFY_AUTH_TOKEN;
delete process.env.NETLIFY_BLOBS_CONTEXT;
delete process.env.DATABASE_URL;

const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const { setAuditStoreOverride } = require('../netlify/lib/operations-audit');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

setAuditStoreOverride({
  async setJSON() { return { modified: true }; },
});

const root = path.resolve(__dirname, '..');
const BOOKING_ID = 'CD1-S2BPREP01';
const NOW = '2026-10-30T21:00:00.000Z';

function booking(overrides = {}) {
  return {
    id: BOOKING_ID,
    bookingVersion: 3,
    quoteVersion: 1,
    schemaVersion: 1,
    kind: 'booking',
    jobStatus: 'confirmed',
    paymentWorkflowStatus: 'pending_admin_review',
    paymentStatus: 'unpaid',
    paymentMethodPreference: 'online_after_service',
    manualPayLink: 'https://pay.example.test/manual',
    manualPayLinkAt: '2026-10-01T00:00:00.000Z',
    technicianNote: 'keep-me',
    ledger: {
      currency: 'usd',
      approvedCents: 25000,
      settledCents: 0,
      creditedCents: 0,
      pendingCents: 0,
      entries: [{ entryId: 'le_existing', kind: 'quote', amountCents: 25000, currency: 'usd' }],
    },
    ...overrides,
  };
}

function saved(store, id = BOOKING_ID) {
  return JSON.parse(store._data.get(id).value);
}

function assertInactive(payload) {
  assert.equal(payload.authoritative, false);
  assert.equal(payload.paid, false);
  assert.equal(payload.financiallySettled, false);
  assert.equal(payload.providerCalled, false);
  assert.equal(payload.createsPayment, false);
  assert.equal(payload.createsPaymentLink, false);
  assert.equal(payload.remoteLinkCancelled, false);
}

async function prepare(store, body = {}, extra = {}) {
  return prepareSquarePaymentLink({
    store,
    bookingId: BOOKING_ID,
    body,
    now: NOW,
    env: squareAuthorityEnv,
    readFinancialProjection: (current) => projectionForBooking(current),
    ...extra,
  });
}

test('an unauthenticated request does not create a preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  try {
    const { handler } = require('../netlify/functions/admin-ops-jobs');
    const res = await handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'prepare_square_payment_link', bookingId: BOOKING_ID }),
    });
    const payload = JSON.parse(res.body);
    assert.ok(res.statusCode === 401 || res.statusCode === 503);
    assert.equal(payload.ok, false);
    assert.equal(saved(store).squareLinkPreparation, undefined);
    assert.equal(saved(store).bookingVersion, 3);
  } finally {
    setBookingStoreOverride(null);
  }
});

test('an authenticated action prepares the server-side balance', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  try {
    const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
    const res = await handleAdminAction({
      action: 'prepare_square_payment_link',
      bookingId: BOOKING_ID,
      paid: true,
    }, {
      now: NOW,
      createIssuanceId: () => '11111111-1111-4111-8111-111111111111',
      env: squareAuthorityEnv,
      readFinancialProjection: (current) => projectionForBooking(current),
    });
    const payload = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(payload.ok, true);
    assertInactive(payload);
    assert.equal(payload.preparation.issuanceId, '11111111-1111-4111-8111-111111111111');
    assert.equal(payload.preparation.amountCents, 25000);
    assert.equal(payload.preparation.state, 'prepared');
    const row = saved(store);
    assert.equal(row.paymentStatus, 'unpaid');
    assert.equal(row.paymentWorkflowStatus, 'pending_admin_review');
    assert.equal(row.paymentMethodPreference, 'online_after_service');
  } finally {
    setBookingStoreOverride(null);
  }
});

test('a missing booking is rejected', async () => {
  const store = createCasMemoryStore({});
  const result = await prepare(store);
  assert.equal(result.statusCode, 404);
  assert.equal(result.payload.error, 'booking_not_found');
  assertInactive(result.payload);
  assert.equal(store._data.has(BOOKING_ID), false);
});

test('the first preparation stores a server issuance and leaves money untouched', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const result = await prepare(store, {}, {
    createIssuanceId: () => '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.replayed, false);
  assertInactive(result.payload);
  const prep = result.payload.preparation;
  assert.equal(prep.state, 'prepared');
  assert.equal(prep.amountCents, 25000);
  assert.equal(prep.currency, 'USD');
  assert.equal(prep.correlationReference, prep.issuanceId);
  assert.equal(prep.preparedAt, NOW);
  assert.equal(prep.locationId, undefined);
  assert.equal(prep.paymentLinkId, undefined);
  assert.equal(prep.orderId, undefined);
  assert.equal(prep.paymentId, undefined);
  assert.equal(prep.paymentLinkUrl, undefined);
  assert.equal(prep.operationId, operationIdentity({
    issuanceId: prep.issuanceId,
    bookingId: BOOKING_ID,
    amountCents: 25000,
    currency: 'USD',
  }));
  const row = saved(store);
  assert.equal(row.squareLinkPreparation.issuanceId, prep.issuanceId);
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
  assert.equal(row.manualPayLinkAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(row.ledger.entries, booking().ledger.entries);
  assert.equal(row.ledger.approvedCents, 25000);
  assert.equal(row.ledger.settledCents, 0);
  assert.equal(row.paymentMethodPreference, 'online_after_service');
  assert.equal(row.paymentStatus, 'unpaid');
  assert.equal(row.paymentWorkflowStatus, 'pending_admin_review');
  assert.equal(row.jobStatus, 'confirmed');
  assert.equal(row.technicianNote, 'keep-me');
  assert.equal(row.bookingVersion, 4);
  assert.equal(row.eventLog.some((event) => event.action === 'square_payment_link_prepared'), true);
});

test('client amount, currency, location and issuance id are not authoritative', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const amount = await prepare(store, { amountCents: 100, currency: 'EUR', locationId: 'LFAKE' });
  assert.equal(amount.statusCode, 400);
  assert.equal(amount.payload.error, 'client_financial_input_rejected');
  assert.equal(saved(store).squareLinkPreparation, undefined);

  const issued = await prepare(store, { issuanceId: 'client-made-id' });
  assert.equal(issued.statusCode, 400);
  assert.equal(issued.payload.error, 'client_issuance_rejected');
  assert.equal(saved(store).bookingVersion, 3);
});

test('a caller paid marker does not change the preparation or the booking', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const result = await prepare(store, {
    paid: true,
    financiallySettled: true,
    paymentStatus: 'COMPLETED',
  }, { createIssuanceId: () => '33333333-3333-4333-8333-333333333333' });
  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.error, 'client_financial_input_rejected');
  assertInactive(result.payload);
  const row = saved(store);
  assert.equal(row.paymentStatus, 'unpaid');
  assert.equal(row.squareLinkPreparation, undefined);
  assert.equal(row.bookingVersion, 3);
});

test('no outstanding balance and a cancelled booking are not prepared', async () => {
  const paidStore = createCasMemoryStore({
    [BOOKING_ID]: booking({
      ledger: {
        currency: 'usd',
        approvedCents: 25000,
        settledCents: 25000,
        creditedCents: 0,
        pendingCents: 0,
        entries: [{ entryId: 'le_existing', kind: 'settlement', amountCents: 25000, currency: 'usd' }],
      },
    }),
  });
  const paid = await prepare(paidStore);
  assert.equal(paid.statusCode, 409);
  assert.equal(paid.payload.error, 'not_payable');
  assert.equal(saved(paidStore).squareLinkPreparation, undefined);

  const cancelledStore = createCasMemoryStore({
    [BOOKING_ID]: booking({ jobStatus: 'cancelled' }),
  });
  const cancelled = await prepare(cancelledStore);
  assert.equal(cancelled.statusCode, 409);
  assert.equal(cancelled.payload.error, 'not_payable');
  assert.equal(cancelled.payload.reason, 'cancelled');
  assert.equal(saved(cancelledStore).squareLinkPreparation, undefined);
});

test('a repeated preparation and a lost response reuse the same issuance', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const first = await prepare(store);
  const second = await prepare(store);
  assert.equal(second.statusCode, 200);
  assert.equal(second.payload.replayed, true);
  assert.equal(second.payload.preparation.issuanceId, first.payload.preparation.issuanceId);
  assert.equal(second.payload.preparation.operationId, first.payload.preparation.operationId);
  assert.equal(saved(store).bookingVersion, 4);
  assert.equal(saved(store).squareLinkPreparationHistory.length, 0);
});

test('an explicit new issuance is not authorized', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  await prepare(store);
  const again = await prepare(store, { newIssuance: true });
  assert.equal(again.statusCode, 409);
  assert.equal(again.payload.error, 'new_issuance_not_authorized');
  assert.equal(saved(store).bookingVersion, 4);
});

test('two concurrent preparations persist one issuance', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let writes = 0;
  let releaseFirst;
  const firstWaiting = new Promise((resolve) => { releaseFirst = resolve; });
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    writes += 1;
    if (writes === 1) await firstWaiting;
    else releaseFirst();
    return original(...args);
  };

  const [left, right] = await Promise.all([prepare(store), prepare(store)]);
  assert.equal(left.payload.ok, true);
  assert.equal(right.payload.ok, true);
  assert.equal(left.payload.preparation.issuanceId, right.payload.preparation.issuanceId);
  assert.equal(saved(store).squareLinkPreparation.state, 'prepared');
  assert.equal(saved(store).squareLinkPreparationHistory.length, 0);
  assert.equal(saved(store).bookingVersion, 4);
});

test('a conditional-write conflict is retried and then succeeds once', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let calls = 0;
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    calls += 1;
    if (calls === 1) return { modified: false };
    return original(...args);
  };
  const result = await prepare(store);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.replayed, false);
  assert.equal(calls, 2);
  assert.equal(saved(store).squareLinkPreparation.state, 'prepared');
  assert.equal(saved(store).bookingVersion, 4);
});

test('bounded conflict retries fail closed without a preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let calls = 0;
  store.setJSON = async () => {
    calls += 1;
    return { modified: false };
  };
  const result = await prepare(store, {}, { maxAttempts: 3 });
  assert.equal(result.statusCode, 409);
  assert.equal(result.payload.error, 'version_conflict');
  assertInactive(result.payload);
  assert.equal(calls, 3);
  assert.equal(saved(store).squareLinkPreparation, undefined);
  assert.equal(saved(store).bookingVersion, 3);
});

test('a changed approved balance supersedes the old preparation in one write', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const first = await prepare(store);
  const row = saved(store);
  row.ledger = {
    ...row.ledger,
    approvedCents: 31000,
  };
  row.approvedFinalAmount = 310;
  row.totalPrice = 310;
  row.amountDueApproved = 310;
  row.balanceDue = 310;
  await store.setJSON(BOOKING_ID, row);
  const second = await prepare(store, {}, { now: '2026-10-30T22:00:00.000Z' });
  assert.equal(second.statusCode, 200);
  assert.equal(second.payload.supersededPrevious, true);
  assert.equal(second.payload.remoteLinkCancelled, false);
  assert.notEqual(second.payload.preparation.issuanceId, first.payload.preparation.issuanceId);
  assert.equal(second.payload.preparation.amountCents, 31000);
  assert.equal(second.payload.paid, false);
  const next = saved(store);
  assert.equal(next.squareLinkPreparation.amountCents, 31000);
  assert.equal(next.squareLinkPreparation.state, 'prepared');
  assert.equal(next.squareLinkPreparationHistory.length, 1);
  assert.equal(next.squareLinkPreparationHistory[0].state, 'superseded');
  assert.equal(next.squareLinkPreparationHistory[0].issuanceId, first.payload.preparation.issuanceId);
  assert.equal(next.squareLinkPreparationHistory[0].amountCents, 25000);
  assert.equal(next.manualPayLink, 'https://pay.example.test/manual');
  assert.equal(next.ledger.entries[0].entryId, 'le_existing');
  assert.equal(next.paymentMethodPreference, 'online_after_service');
  assert.equal(next.paymentStatus, 'unpaid');
});

test('a preparation whose snapshot disagrees with the ledger is not replayed', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const first = await prepare(store);
  const row = saved(store);
  row.squareLinkPreparation = { ...row.squareLinkPreparation, amountCents: 100 };
  await store.setJSON(BOOKING_ID, row);
  const result = await prepare(store);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.supersededPrevious, true);
  assert.notEqual(result.payload.preparation.issuanceId, first.payload.preparation.issuanceId);
  assert.equal(result.payload.preparation.amountCents, 25000);
  const next = saved(store);
  assert.equal(next.squareLinkPreparation.amountCents, 25000);
  assert.equal(next.squareLinkPreparationHistory[0].amountCents, 100);
  assert.equal(next.ledger.approvedCents, 25000);
  assert.equal(next.paymentStatus, 'unpaid');
});

test('server issuance ids are unique and are not the amount tuple', () => {
  const left = createIssuanceId();
  const right = createIssuanceId();
  assert.notEqual(left, right);
  assert.match(left, /^[0-9a-f-]{36}$/i);
  const sameAmount = operationIdentity({
    issuanceId: left,
    bookingId: BOOKING_ID,
    amountCents: 25000,
    currency: 'USD',
  });
  const otherIssuance = operationIdentity({
    issuanceId: right,
    bookingId: BOOKING_ID,
    amountCents: 25000,
    currency: 'USD',
  });
  assert.notEqual(sameAmount, otherIssuance);
});

test('the implementation stays off the network, the database, and Phase 7F.1', () => {
  const helper = fs.readFileSync(path.join(root, 'netlify/lib/square-prepared-issuance.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
  const submit = fs.readFileSync(path.join(root, 'netlify/functions/submit-booking.js'), 'utf8');
  assert.doesNotMatch(helper, /\bfetch\s*\(/);
  assert.doesNotMatch(helper, /blobsStore|@netlify\/blobs|square-persistence|require\s*\(\s*['"]pg['"]/);
  assert.doesNotMatch(helper, /https:\/\/connect\.squareup/);
  assert.match(helper, /syncSlots:\s*false/);
  assert.equal(submit.includes('prepare_square_payment_link'), false);
  assert.match(admin, /verifyAdminKey/);
  const manual = admin.slice(admin.indexOf("action === 'set_payment_link'"), admin.indexOf("action === 'prepare_square_payment_link'"));
  assert.match(manual, /manualPayLink/);
  assert.match(manual, /authoritative:\s*false/);
  assert.doesNotMatch(manual, /prepareSquarePaymentLink/);
  assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
  const env = fs.readFileSync(path.join(root, 'netlify/lib/deploy-runtime-env.generated.js'), 'utf8');
  assert.match(env, /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/);
});
