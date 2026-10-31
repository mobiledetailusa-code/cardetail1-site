'use strict';

process.env.PRISMA_BOOKING_MIRROR = '0';
process.env.PRISMA_BOOKING_READ = '0';
process.env.CD1_POSTGRES_PAYMENT = '0';
delete process.env.NETLIFY_SITE_ID;
delete process.env.NETLIFY_AUTH_TOKEN;
delete process.env.NETLIFY_BLOBS_CONTEXT;
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { squareAuthorityEnv } = require('./helpers/square-preparation-authority');
const {
  prepareSquarePaymentLink,
  operationIdentity,
} = require('../netlify/lib/square-prepared-issuance');
const { setAuditStoreOverride } = require('../netlify/lib/operations-audit');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

const root = path.resolve(__dirname, '..');
const BOOKING_ID = 'CD1-S2D1AUTH1';
const NOW = '2026-10-30T23:00:00.000Z';
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';

setAuditStoreOverride({
  async setJSON() {
    return { modified: true, etag: 'audit-etag' };
  },
});

global.fetch = () => {
  throw new Error('network_forbidden');
};

function booking(overrides = {}) {
  return {
    id: BOOKING_ID,
    bookingVersion: 4,
    quoteVersion: 1,
    schemaVersion: 1,
    kind: 'booking',
    jobStatus: 'confirmed',
    paymentWorkflowStatus: 'pending_admin_review',
    paymentStatus: 'unpaid',
    manualPayLink: 'https://pay.example.test/manual',
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

function snapshot(overrides = {}) {
  return {
    quoteVersion: 1,
    approvedCents: 25000,
    grossSettledCents: 0,
    refundedCents: 0,
    settledCents: 0,
    ...overrides,
  };
}

function prepared(amountCents = 25000, financial = snapshot(), issuanceId = OLD_ID) {
  return {
    bookingId: BOOKING_ID,
    issuanceId,
    state: 'prepared',
    amountCents,
    currency: 'USD',
    ...financial,
    correlationReference: issuanceId,
    preparedAt: '2026-10-30T20:00:00.000Z',
    operationId: operationIdentity({
      issuanceId,
      bookingId: BOOKING_ID,
      amountCents,
      currency: 'USD',
    }),
  };
}

function projection(overrides = {}, wrapper = {}) {
  const financial = snapshot();
  return {
    ok: true,
    authority: 'postgres',
    bookingId: BOOKING_ID,
    projection: {
      bookingId: BOOKING_ID,
      authority: 'postgres',
      remainingCents: 25000,
      currency: 'usd',
      ...financial,
      ...overrides,
    },
    ...wrapper,
  };
}

function saved(store) {
  return JSON.parse(store._data.get(BOOKING_ID).value);
}

function assertInactive(payload) {
  assert.equal(payload.paid, false);
  assert.equal(payload.financiallySettled, false);
  assert.equal(payload.authoritative, false);
  assert.equal(payload.providerCalled, false);
  assert.equal(payload.createsPayment, false);
  assert.equal(payload.createsPaymentLink, false);
  assert.equal(payload.remoteLinkCancelled, false);
}

async function prepare(store, {
  reader = projection(),
  env = squareAuthorityEnv,
  createIssuanceId = () => NEW_ID,
  body = {},
} = {}) {
  let reads = 0;
  const result = await prepareSquarePaymentLink({
    store,
    bookingId: BOOKING_ID,
    body,
    now: NOW,
    env,
    createIssuanceId,
    readFinancialProjection: async () => {
      reads += 1;
      return typeof reader === 'function' ? reader(reads) : reader;
    },
  });
  return { result, reads };
}

test('configured PostgreSQL authority stores the financial snapshot', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result, reads } = await prepare(store, { createIssuanceId: () => OLD_ID });
  assert.equal(result.statusCode, 200);
  assert.equal(reads, 1);
  assert.equal(result.payload.preparation.quoteVersion, 1);
  assert.equal(result.payload.preparation.approvedCents, 25000);
  assert.equal(result.payload.preparation.amountCents, 25000);
  assert.equal(result.payload.preparation.grossSettledCents, 0);
  assert.equal(result.payload.preparation.refundedCents, 0);
  assert.equal(result.payload.preparation.settledCents, 0);
  assertInactive(result.payload);
  const row = saved(store);
  assert.equal(row.squareLinkPreparation.quoteVersion, 1);
  assert.equal(row.squareLinkPreparation.grossSettledCents, 0);
  assert.equal(row.ledger.entries[0].entryId, 'le_existing');
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
  assert.equal(row.paymentStatus, 'unpaid');
});

test('a missing DATABASE_URL refuses preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result, reads } = await prepare(store, {
    env: { CD1_POSTGRES_PAYMENT: '1' },
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(reads, 0);
  assert.equal(result.payload.error, 'financial_authority_unconfigured');
  assert.equal(result.payload.preparation, undefined);
  assert.equal(saved(store).squareLinkPreparation, undefined);
  assertInactive(result.payload);
});

test('a blank DATABASE_URL refuses preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result, reads } = await prepare(store, {
    env: { CD1_POSTGRES_PAYMENT: '1', DATABASE_URL: '   ' },
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(reads, 0);
  assert.equal(result.payload.error, 'financial_authority_unconfigured');
  assert.equal(saved(store).bookingVersion, 4);
});

test('explicitly disabled PostgreSQL mode refuses preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result, reads } = await prepare(store, {
    env: { CD1_POSTGRES_PAYMENT: '0', DATABASE_URL: 'postgres://fixture-not-contacted' },
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(reads, 0);
  assert.equal(result.payload.error, 'financial_authority_disabled');
  assert.equal(saved(store).squareLinkPreparation, undefined);
});

test('inconsistent PostgreSQL configuration refuses preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const result = await prepareSquarePaymentLink({
    store,
    bookingId: BOOKING_ID,
    body: {},
    now: NOW,
    env: squareAuthorityEnv,
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_authority_inconsistent');
  assert.equal(saved(store).squareLinkPreparation, undefined);
  assertInactive(result.payload);
});

test('an unavailable projection and a Blob fallback refuse preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const missing = await prepare(store, { reader: null });
  assert.equal(missing.result.payload.error, 'financial_authority_unavailable');
  const fallback = await prepare(store, {
    reader: { ok: false, authority: 'blob', error: 'projection_unavailable' },
  });
  assert.equal(fallback.result.payload.error, 'financial_blob_fallback_rejected');
  assert.equal(saved(store).squareLinkPreparation, undefined);
});

test('an unknown projection source and malformed amounts refuse preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const unknown = await prepare(store, {
    reader: projection({}, { authority: 'blob' }),
  });
  assert.equal(unknown.result.payload.error, 'financial_source_unverified');
  const malformed = await prepare(store, {
    reader: projection({ grossSettledCents: 10.5 }),
  });
  assert.equal(malformed.result.payload.error, 'financial_amount_invalid');
  assert.equal(saved(store).paymentStatus, 'unpaid');
});

test('an unchanged financial snapshot replays the same issuance', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: prepared() }),
  });
  const { result } = await prepare(store, {
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.replayed, true);
  assert.equal(result.payload.preparation.issuanceId, OLD_ID);
  assert.equal(result.payload.preparation.grossSettledCents, 0);
  assert.equal(saved(store).bookingVersion, 4);
  assertInactive(result.payload);
});

test('a partial settlement blocks replay of the old issuance', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: prepared() }),
  });
  const { result } = await prepare(store, {
    reader: projection({ remainingCents: 15000, grossSettledCents: 10000, settledCents: 10000 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_balance_mismatch');
  assert.equal(result.payload.preparation, undefined);
  assert.equal(saved(store).squareLinkPreparation.issuanceId, OLD_ID);
  assert.equal(saved(store).bookingVersion, 4);
});

test('a refund that restores the remaining balance does not replay the old issuance', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: prepared() }),
  });
  const { result } = await prepare(store, {
    reader: projection({
      remainingCents: 25000,
      grossSettledCents: 25000,
      refundedCents: 25000,
      settledCents: 0,
    }),
  });
  assert.equal(result.payload.replayed, false);
  assert.equal(result.payload.preparation.issuanceId, NEW_ID);
  assert.equal(result.payload.preparation.grossSettledCents, 25000);
  assert.equal(result.payload.preparation.refundedCents, 25000);
  assertInactive(result.payload);
  const row = saved(store);
  assert.equal(row.squareLinkPreparationHistory[0].issuanceId, OLD_ID);
  assert.equal(row.squareLinkPreparationHistory[0].supersededReason, 'financial_gross_settled_changed');
  assert.equal(row.paymentStatus, 'unpaid');
  assert.equal(row.ledger.approvedCents, 25000);
});

test('a changed quote version does not replay the old issuance', async () => {
  const initial = booking({ quoteVersion: 2 });
  initial.squareLinkPreparation = prepared();
  const store = createCasMemoryStore({ [BOOKING_ID]: initial });
  const { result } = await prepare(store, {
    reader: projection({ quoteVersion: 2 }),
  });
  assert.notEqual(result.payload.preparation.issuanceId, OLD_ID);
  assert.equal(result.payload.preparation.quoteVersion, 2);
  assert.equal(saved(store).squareLinkPreparationHistory[0].supersededReason, 'financial_quote_version_changed');
});

test('a changed approved amount does not replay the old issuance', async () => {
  const initial = booking({
    ledger: {
      currency: 'usd',
      approvedCents: 30000,
      settledCents: 5000,
      creditedCents: 0,
      pendingCents: 0,
      entries: [],
    },
  });
  initial.squareLinkPreparation = prepared();
  const store = createCasMemoryStore({ [BOOKING_ID]: initial });
  const { result } = await prepare(store, {
    reader: projection({
      approvedCents: 30000,
      remainingCents: 25000,
      grossSettledCents: 5000,
      settledCents: 5000,
    }),
  });
  assert.notEqual(result.payload.preparation.issuanceId, OLD_ID);
  assert.equal(result.payload.preparation.approvedCents, 30000);
  assert.equal(saved(store).squareLinkPreparationHistory[0].supersededReason, 'financial_approved_amount_changed');
  assert.equal(saved(store).manualPayLink, 'https://pay.example.test/manual');
});

test('changed settled and refunded totals do not replay the old issuance', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: prepared() }),
  });
  const settled = await prepare(store, {
    reader: projection({ grossSettledCents: 4000, settledCents: 4000, remainingCents: 21000 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(settled.result.payload.error, 'financial_balance_mismatch');
  const refundedOnly = await prepare(store, {
    reader: projection({ refundedCents: 1000, settledCents: -1 }),
  });
  assert.equal(refundedOnly.result.payload.error, 'financial_amount_invalid');
  const refunded = await prepare(store, {
    reader: projection({ refundedCents: 1000, settledCents: 0, remainingCents: 25000 }),
  });
  assert.equal(refunded.result.payload.preparation.refundedCents, 1000);
  assert.notEqual(refunded.result.payload.preparation.issuanceId, OLD_ID);
  assert.equal(saved(store).squareLinkPreparationHistory[0].supersededReason, 'financial_refunded_changed');
});

test('a legacy preparation without a snapshot is not returned as current', async () => {
  const legacy = prepared();
  delete legacy.quoteVersion;
  delete legacy.approvedCents;
  delete legacy.grossSettledCents;
  delete legacy.refundedCents;
  delete legacy.settledCents;
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: legacy }),
  });
  const { result } = await prepare(store);
  assert.equal(result.payload.preparation.issuanceId, NEW_ID);
  assert.equal(result.payload.preparation.quoteVersion, 1);
  assert.equal(saved(store).squareLinkPreparationHistory[0].issuanceId, OLD_ID);
  assert.equal(saved(store).squareLinkPreparationHistory[0].supersededReason, 'financial_snapshot_missing');
  assert.equal(saved(store).squareLinkPreparationHistory[0].amountCents, 25000);
});

test('a malformed stored snapshot is not treated as a match', async () => {
  const broken = prepared();
  broken.grossSettledCents = 12.5;
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: broken }),
  });
  const { result } = await prepare(store);
  assert.notEqual(result.payload.preparation.issuanceId, OLD_ID);
  assert.equal(saved(store).squareLinkPreparationHistory[0].supersededReason, 'financial_snapshot_invalid');
});

test('a lost response retries the same issuance when the snapshot is unchanged', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    await original(...args);
    return { modified: true, etag: '' };
  };
  const first = await prepare(store, { createIssuanceId: () => OLD_ID });
  assert.equal(first.result.payload.ok, true);
  assert.equal(first.result.payload.writeAcknowledged, false);
  assert.equal(first.result.payload.preparation.issuanceId, OLD_ID);
  assertInactive(first.result.payload);
  store.setJSON = original;
  const second = await prepare(store, {
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(second.result.payload.replayed, true);
  assert.equal(second.result.payload.preparation.issuanceId, OLD_ID);
  assert.deepEqual(saved(store).squareLinkPreparationHistory, []);
});

test('a CAS conflict checks the fresh snapshot before another issuance is kept', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const original = store.setJSON.bind(store);
  let writes = 0;
  store.setJSON = async (...args) => {
    writes += 1;
    if (writes === 1) return { modified: false };
    return original(...args);
  };
  const { result, reads } = await prepare(store, {
    reader: (attempt) => (attempt === 1
      ? projection()
      : projection({ grossSettledCents: 100, settledCents: 100 })),
  });
  assert.equal(reads, 2);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.preparation.grossSettledCents, 100);
  assert.equal(saved(store).squareLinkPreparation.grossSettledCents, 100);
});

test('client financial snapshot fields are rejected', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepare(store, {
    body: { quoteVersion: 9, grossSettledCents: 1 },
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'client_financial_input_rejected');
  assert.equal(saved(store).bookingVersion, 4);
});

test('the authority gate stays off Square, Stripe, and Phase 7F.1', () => {
  const helper = fs.readFileSync(path.join(root, 'netlify/lib/square-prepared-issuance.js'), 'utf8');
  assert.match(helper, /financial_authority_unconfigured/);
  assert.match(helper, /financial_authority_disabled/);
  assert.match(helper, /grossSettledCents/);
  assert.match(helper, /financial_snapshot_missing/);
  assert.doesNotMatch(helper, /squareup|square-persistence|api\.stripe\.com|require\s*\(\s*['"]pg['"]/);
  assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
  const env = fs.readFileSync(path.join(root, 'netlify/lib/deploy-runtime-env.generated.js'), 'utf8');
  assert.match(env, /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/);
});
