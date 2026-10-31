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
const {
  prepareSquarePaymentLink,
  operationIdentity,
} = require('../netlify/lib/square-prepared-issuance');
const { setAuditStoreOverride } = require('../netlify/lib/operations-audit');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

const root = path.resolve(__dirname, '..');
const BOOKING_ID = 'CD1-S2DGUARD1';
const NOW = '2026-10-30T22:00:00.000Z';
const ISSUANCE_ID = '11111111-1111-4111-8111-111111111111';
const POSTGRES_ENV = {
  CD1_POSTGRES_PAYMENT: '1',
  DATABASE_URL: 'postgres://fixture-not-contacted',
};

const auditLog = {
  rows: [],
  async setJSON(key, value) {
    this.rows.push({ key, value });
    return { modified: true, etag: 'audit-etag' };
  },
};
setAuditStoreOverride(auditLog);

global.fetch = () => {
  throw new Error('network_forbidden');
};

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

function preparedRecord(amountCents = 25000, issuanceId = ISSUANCE_ID) {
  return {
    bookingId: BOOKING_ID,
    issuanceId,
    state: 'prepared',
    amountCents,
    currency: 'USD',
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
  return {
    ok: true,
    authority: 'postgres',
    bookingId: BOOKING_ID,
    projection: {
      bookingId: BOOKING_ID,
      authority: 'postgres',
      quoteVersion: 1,
      approvedCents: 25000,
      remainingCents: 25000,
      grossSettledCents: 0,
      refundedCents: 0,
      settledCents: 0,
      currency: 'usd',
      ...overrides,
    },
    ...wrapper,
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

function preparationAudits() {
  return auditLog.rows.filter((row) => row.value && row.value.action === 'square_payment_link_prepared');
}

async function prepareGuarded(store, {
  reader = projection(),
  env = POSTGRES_ENV,
  createIssuanceId = () => ISSUANCE_ID,
  body = {},
} = {}) {
  auditLog.rows.length = 0;
  let reads = 0;
  const result = await prepareSquarePaymentLink({
    store,
    bookingId: BOOKING_ID,
    body,
    now: NOW,
    env,
    createIssuanceId,
    actorId: 'ada.admin',
    readFinancialProjection: async () => {
      reads += 1;
      if (typeof reader === 'function') return reader(reads);
      return reader;
    },
  });
  return { result, reads };
}

test('PostgreSQL and Blob with the same positive balance can prepare', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result, reads } = await prepareGuarded(store);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.preparation.amountCents, 25000);
  assert.equal(result.payload.preparation.state, 'prepared');
  assertInactive(result.payload);
  assert.equal(reads, 1);
  assert.equal(preparationAudits().length, 1);
  const row = saved(store);
  assert.equal(row.paymentStatus, 'unpaid');
  assert.equal(row.jobStatus, 'confirmed');
  assert.equal(row.ledger.approvedCents, 25000);
  assert.equal(row.ledger.settledCents, 0);
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
});

test('PostgreSQL zero and a positive Blob refuse preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: projection({ remainingCents: 0 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, 'financial_balance_mismatch');
  assert.equal(result.payload.preparation, undefined);
  assertInactive(result.payload);
  assert.equal(preparationAudits().length, 0);
  assert.equal(saved(store).bookingVersion, 3);
  assert.equal(saved(store).squareLinkPreparation, undefined);
});

test('PostgreSQL positive and a zero Blob refuse preparation', async () => {
  const initial = booking({
    ledger: {
      currency: 'usd',
      approvedCents: 25000,
      settledCents: 25000,
      creditedCents: 0,
      pendingCents: 0,
      entries: [],
    },
    squareLinkPreparation: preparedRecord(),
  });
  const store = createCasMemoryStore({ [BOOKING_ID]: initial });
  const { result } = await prepareGuarded(store, {
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_balance_mismatch');
  assert.equal(result.payload.preparation, undefined);
  assertInactive(result.payload);
  assert.equal(saved(store).squareLinkPreparation.issuanceId, ISSUANCE_ID);
  assert.equal(saved(store).bookingVersion, 3);
  assert.equal(preparationAudits().length, 0);
});

test('different positive balances refuse preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: projection({ remainingCents: 15000 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_balance_mismatch');
  assert.equal(saved(store).paymentStatus, 'unpaid');
  assert.equal(saved(store).squareLinkPreparation, undefined);
});

test('an unavailable PostgreSQL projection fails closed', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: null,
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_authority_unavailable');
  assertInactive(result.payload);
  assert.equal(preparationAudits().length, 0);
});

test('a PostgreSQL projection error fails closed without database text', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: { ok: false, error: 'database_unavailable', authority: 'none' },
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_authority_unavailable');
  assert.equal(JSON.stringify(result.payload).includes('database_unavailable'), false);
  assert.equal(saved(store).bookingVersion, 3);
});

test('a Blob fallback is not PostgreSQL evidence', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: { ok: false, error: 'projection_unavailable', authority: 'blob' },
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_blob_fallback_rejected');
  assert.equal(result.payload.preparation, undefined);
  assert.equal(saved(store).squareLinkPreparation, undefined);
});

test('a projection whose source is not PostgreSQL fails closed', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: projection({}, { authority: 'unknown' }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_source_unverified');
  assertInactive(result.payload);
});

test('a malformed remaining amount fails closed', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: projection({ remainingCents: 25000.5 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_amount_invalid');
  assert.equal(saved(store).bookingVersion, 3);
});

test('a currency mismatch fails closed', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: projection({ currency: 'eur' }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_currency_unsupported');
  assert.equal(saved(store).ledger.currency, 'usd');
  assert.equal(saved(store).squareLinkPreparation, undefined);
});

test('a booking identity mismatch fails closed', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: projection({ bookingId: 'CD1-OTHER' }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_booking_mismatch');
  assert.equal(saved(store).bookingVersion, 3);
});

test('a financial version mismatch fails closed', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const { result } = await prepareGuarded(store, {
    reader: projection({ quoteVersion: 2 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_quote_version_mismatch');
  assert.equal(saved(store).quoteVersion, 1);
  assert.equal(saved(store).squareLinkPreparation, undefined);
});

test('a legacy preparation without a financial snapshot is not replayed', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: preparedRecord() }),
  });
  const { result } = await prepareGuarded(store, {
    createIssuanceId: () => '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.replayed, false);
  assert.equal(result.payload.preparation.issuanceId, '33333333-3333-4333-8333-333333333333');
  assert.notEqual(result.payload.preparation.issuanceId, ISSUANCE_ID);
  assertInactive(result.payload);
  const row = saved(store);
  assert.equal(row.squareLinkPreparationHistory[0].issuanceId, ISSUANCE_ID);
  assert.equal(row.squareLinkPreparationHistory[0].supersededReason, 'financial_snapshot_missing');
  assert.equal(row.paymentStatus, 'unpaid');
});

test('an existing preparation is not usable after PostgreSQL full settlement', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: preparedRecord() }),
  });
  const { result } = await prepareGuarded(store, {
    reader: projection({ remainingCents: 0 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, 'financial_balance_mismatch');
  assert.equal(result.payload.preparation, undefined);
  assertInactive(result.payload);
  assert.equal(saved(store).squareLinkPreparation.state, 'prepared');
  assert.equal(saved(store).squareLinkPreparation.issuanceId, ISSUANCE_ID);
  assert.equal(saved(store).bookingVersion, 3);
  assert.equal(preparationAudits().length, 0);
});

test('an existing preparation is not usable after a partial PostgreSQL settlement', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: preparedRecord() }),
  });
  const { result } = await prepareGuarded(store, {
    reader: projection({ remainingCents: 15000 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.error, 'financial_balance_mismatch');
  assert.equal(result.payload.preparation, undefined);
  assert.equal(saved(store).squareLinkPreparation.amountCents, 25000);
  assert.equal(saved(store).paymentStatus, 'unpaid');
  assert.equal(preparationAudits().length, 0);
});

test('an agreed cancellation does not leave a current preparation', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({
      jobStatus: 'cancelled',
      squareLinkPreparation: preparedRecord(),
    }),
  });
  const { result } = await prepareGuarded(store, {
    reader: projection({ remainingCents: 0 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, 'not_payable');
  assert.equal(result.payload.preparation, undefined);
  assertInactive(result.payload);
  const row = saved(store);
  assert.equal(row.squareLinkPreparation, null);
  assert.equal(row.squareLinkPreparationHistory[0].state, 'superseded');
  assert.equal(row.squareLinkPreparationHistory[0].supersededReason, 'cancelled');
  assert.equal(row.paymentStatus, 'unpaid');
  assert.equal(row.jobStatus, 'cancelled');
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
  assert.equal(preparationAudits().length, 0);
});

test('an invalid amount snapshot is not replayed when the authorities agree', async () => {
  const store = createCasMemoryStore({
    [BOOKING_ID]: booking({ squareLinkPreparation: preparedRecord(99999) }),
  });
  const { result } = await prepareGuarded(store, {
    createIssuanceId: () => '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.preparation.amountCents, 25000);
  assert.equal(result.payload.preparation.issuanceId, '22222222-2222-4222-8222-222222222222');
  assertInactive(result.payload);
  const row = saved(store);
  assert.equal(row.squareLinkPreparation.amountCents, 25000);
  assert.equal(row.squareLinkPreparationHistory[0].issuanceId, ISSUANCE_ID);
  assert.equal(row.squareLinkPreparationHistory[0].state, 'superseded');
  assert.equal(row.paymentStatus, 'unpaid');
  assert.equal(row.ledger.approvedCents, 25000);
});

test('a CAS conflict reads the PostgreSQL projection again', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const original = store.setJSON.bind(store);
  let writes = 0;
  store.setJSON = async (...args) => {
    writes += 1;
    if (writes === 1) return { modified: false };
    return original(...args);
  };
  const { result, reads } = await prepareGuarded(store);
  assert.equal(result.payload.ok, true);
  assert.equal(reads, 2);
  assert.equal(result.payload.preparation.amountCents, 25000);
  assertInactive(result.payload);
});

test('a projection change between retries does not reuse the first check', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const original = store.setJSON.bind(store);
  let writes = 0;
  store.setJSON = async (...args) => {
    writes += 1;
    if (writes === 1) return { modified: false };
    return original(...args);
  };
  let minted = 0;
  const { result, reads } = await prepareGuarded(store, {
    reader: (attempt) => (attempt === 1 ? projection() : projection({ remainingCents: 10000 })),
    createIssuanceId: () => {
      minted += 1;
      return ISSUANCE_ID;
    },
  });
  assert.equal(result.payload.error, 'financial_balance_mismatch');
  assert.equal(reads, 2);
  assert.equal(minted, 1);
  assert.equal(saved(store).squareLinkPreparation, undefined);
  assert.equal(saved(store).bookingVersion, 3);
  assert.equal(preparationAudits().length, 0);
});

test('a settlement after a successful check is not prevented by this guard', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let settledAfterCheck = false;
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    settledAfterCheck = true;
    return original(...args);
  };
  const { result, reads } = await prepareGuarded(store, {
    reader: () => {
      assert.equal(settledAfterCheck, false);
      return projection();
    },
  });
  assert.equal(settledAfterCheck, true);
  assert.equal(reads, 1);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.financiallySettled, false);
  assert.equal(result.payload.paid, false);
  assert.equal(result.payload.authoritative, false);
  assert.equal(result.payload.createsPaymentLink, false);
});

test('an unknown Blob write is not financial success when the fresh projection disagrees', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    await original(...args);
    return { modified: true, etag: '' };
  };
  const { result, reads } = await prepareGuarded(store, {
    reader: (attempt) => (attempt === 1 ? projection() : projection({ remainingCents: 0 })),
  });
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, 'financial_balance_mismatch');
  assert.equal(result.payload.preparation, undefined);
  assert.equal(result.payload.writeAcknowledged, false);
  assertInactive(result.payload);
  assert.equal(reads, 2);
  assert.equal(preparationAudits().length, 0);
  assert.equal(saved(store).squareLinkPreparation.state, 'prepared');

  const again = await prepareGuarded(store, {
    reader: projection({ remainingCents: 0 }),
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
  });
  assert.equal(again.result.payload.preparation, undefined);
  assert.equal(again.result.payload.error, 'financial_balance_mismatch');
});

test('disabled PostgreSQL settlement does not authorize Blob preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let reads = 0;
  const result = await prepareSquarePaymentLink({
    store,
    bookingId: BOOKING_ID,
    body: {},
    now: NOW,
    env: { CD1_POSTGRES_PAYMENT: '0', DATABASE_URL: 'postgres://fixture-not-contacted' },
    createIssuanceId: () => { throw new Error('issuance_not_allowed'); },
    readFinancialProjection: async () => {
      reads += 1;
      throw new Error('postgres_must_not_be_read');
    },
  });
  assert.equal(reads, 0);
  assert.equal(result.statusCode, 409);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, 'financial_authority_disabled');
  assert.equal(result.payload.preparation, undefined);
  assertInactive(result.payload);
  assert.equal(saved(store).squareLinkPreparation, undefined);
  assert.equal(saved(store).bookingVersion, 3);
});

test('the guard does not call Square, Stripe, a database, or Phase 7F.1', () => {
  const helper = fs.readFileSync(path.join(root, 'netlify/lib/square-prepared-issuance.js'), 'utf8');
  const operational = fs.readFileSync(path.join(root, 'netlify/lib/db/operational-payment.js'), 'utf8');
  const authority = fs.readFileSync(path.join(root, 'netlify/lib/db/payment-authority-service.js'), 'utf8');
  const projectionFn = authority.slice(
    authority.indexOf('async function getFinancialProjection'),
    authority.indexOf('async function reserveAndCreatePaymentIntent')
  );
  const strictFn = operational.slice(
    operational.indexOf('async function readStrictPostgresFinancialProjection'),
    operational.indexOf('async function getSharedFinancialProjection')
  );
  const sharedFn = operational.slice(
    operational.indexOf('async function getSharedFinancialProjection'),
    operational.indexOf('async function prepareEmbeddedPayment')
  );
  assert.match(projectionFn, /currency: rawCurrency \|\| null/);
  assert.doesNotMatch(strictFn, /ensureBookingFinancial|recordFullBalanceOnSiteSettlement|authority:\s*'blob'/);
  assert.match(strictFn, /authority:\s*'postgres'/);
  assert.match(strictFn, /authority:\s*'none'/);
  assert.match(sharedFn, /strictSource === 'postgres'/);
  assert.match(sharedFn, /ensureBookingFinancial/);
  assert.match(helper, /strictSource:\s*'postgres'/);
  assert.doesNotMatch(helper.slice(0, helper.indexOf('function inactive')), /operational-payment/);
  assert.doesNotMatch(helper, /recordFullBalanceOnSiteSettlement|ensureBookingFinancial/);
  assert.doesNotMatch(helper, /squareup|square-persistence|api\.stripe\.com|require\s*\(\s*['"]pg['"]/);
  assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
  const env = fs.readFileSync(path.join(root, 'netlify/lib/deploy-runtime-env.generated.js'), 'utf8');
  assert.match(env, /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/);
});
