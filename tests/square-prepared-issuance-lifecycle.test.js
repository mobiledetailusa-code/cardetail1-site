'use strict';

process.env.PRISMA_BOOKING_MIRROR = '0';
process.env.PRISMA_BOOKING_READ = '0';
delete process.env.NETLIFY_SITE_ID;
delete process.env.NETLIFY_AUTH_TOKEN;
delete process.env.NETLIFY_BLOBS_CONTEXT;
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { prepareSquarePaymentLink, reconcilePreparedIssuance } = require('../netlify/lib/square-prepared-issuance');
const { setBookingStoreOverride, commitBooking } = require('../netlify/lib/booking-repository');
const { setAuditStoreOverride } = require('../netlify/lib/operations-audit');
const { upsertBookingMirror } = require('../netlify/lib/booking-prisma-mirror');

const root = path.resolve(__dirname, '..');
const BOOKING_ID = 'CD1-S2BLIFE01';
const NOW = '2026-10-30T21:00:00.000Z';

const auditLog = {
  rows: [],
  async setJSON(key, value) {
    this.rows.push({ key, value });
    return { modified: true };
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
    paymentMethodPreference: 'card_onsite',
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

function audits(action) {
  return auditLog.rows.filter((row) => row.value && row.value.action === action);
}

async function prepare(store, extra = {}) {
  return prepareSquarePaymentLink({
    store,
    bookingId: BOOKING_ID,
    body: {},
    now: NOW,
    actorId: 'ada.admin',
    ...extra,
  });
}

test('an unchanged balance replays one issuance and audits it once', async () => {
  auditLog.rows.length = 0;
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const first = await prepare(store);
  const second = await prepare(store);
  assert.equal(first.payload.replayed, false);
  assert.equal(second.payload.replayed, true);
  assert.equal(second.payload.preparation.issuanceId, first.payload.preparation.issuanceId);
  assert.equal(audits('square_payment_link_prepared').length, 1);
  assert.equal(audits('square_payment_link_prepared')[0].value.amount_cents, 25000);
  assert.equal(audits('square_payment_link_prepared')[0].value.issuance_id, first.payload.preparation.issuanceId);
  assert.equal(audits('square_payment_link_prepared')[0].value.booking_id, BOOKING_ID);
  assert.equal(audits('square_payment_link_prepared')[0].value.actor_id, 'ada.admin');
  assert.equal(audits('square_payment_link_prepared')[0].value.currency, 'USD');
});

test('full cash payment supersedes the preparation inside the cash commit', async () => {
  auditLog.rows.length = 0;
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  const created = await prepare(store);
  const { persistMutation } = require('../netlify/functions/admin-ops-jobs');
  const previous = saved(store);
  const result = await persistMutation(store, BOOKING_ID, {
    ...previous,
    cashReceivedAmount: 250,
    paymentStatus: 'paid_cash',
    paymentWorkflowStatus: 'cash_paid',
  }, previous, 'mark_cash_received', 'cash');
  assert.equal(result.ok, true);
  const row = saved(store);
  assert.equal(row.squareLinkPreparation, null);
  assert.equal(row.squareLinkPreparationHistory[0].issuanceId, created.payload.preparation.issuanceId);
  assert.equal(row.squareLinkPreparationHistory[0].amountCents, 25000);
  assert.equal(row.squareLinkPreparationHistory[0].state, 'superseded');
  assert.equal(row.squareLinkPreparationHistory[0].supersededReason, 'not_payable');
  assert.ok(row.squareLinkPreparationHistory[0].supersededAt);
  assert.equal(row.ledger.settledCents, 25000);
  assert.equal(row.ledger.entries[0].entryId, 'le_existing');
  assert.equal(row.ledger.entries.some((entry) => entry.kind === 'settlement' && entry.method === 'cash'), true);
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
  assert.equal(row.paymentMethodPreference, 'card_onsite');
  assert.equal(row.technicianNote, 'keep-me');
  assert.equal(audits('square_payment_link_superseded').length, 1);
  assert.equal(audits('square_payment_link_superseded')[0].value.amount_cents, 25000);
  const again = await prepare(store);
  assert.equal(again.payload.error, 'not_payable');
  assert.equal(saved(store).squareLinkPreparation, null);
  assert.equal(saved(store).squareLinkPreparationHistory.length, 1);
});

test('a partial card-on-site payment supersedes and does not create a replacement', async () => {
  auditLog.rows.length = 0;
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  const created = await prepare(store);
  const { persistMutation } = require('../netlify/functions/admin-ops-jobs');
  const previous = saved(store);
  const result = await persistMutation(store, BOOKING_ID, {
    ...previous,
    cardOnSiteAmount: 100,
    cardOnSiteAt: NOW,
    paymentStatus: 'paid_card_on_site',
    paymentWorkflowStatus: 'payment_succeeded',
  }, previous, 'mark_card_on_site', 'card');
  assert.equal(result.ok, true);
  const row = saved(store);
  assert.equal(row.squareLinkPreparation, null);
  assert.equal(row.squareLinkPreparationHistory[0].issuanceId, created.payload.preparation.issuanceId);
  assert.equal(row.squareLinkPreparationHistory[0].amountCents, 25000);
  assert.equal(row.squareLinkPreparationHistory[0].supersededReason, 'payable_balance_changed');
  assert.equal(row.ledger.settledCents, 10000);
  assert.equal(row.ledger.entries.some((entry) => entry.method === 'card' && entry.amountCents === 10000), true);
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
  assert.equal(audits('square_payment_link_prepared').length, 1);
});

test('full card-on-site payment leaves no current preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  await prepare(store);
  const { persistMutation } = require('../netlify/functions/admin-ops-jobs');
  const previous = saved(store);
  const result = await persistMutation(store, BOOKING_ID, {
    ...previous,
    cardOnSiteAmount: 250,
    cardOnSiteAt: NOW,
    paymentStatus: 'paid_card_on_site',
    paymentWorkflowStatus: 'payment_succeeded',
  }, previous, 'mark_card_on_site', 'card');
  assert.equal(result.ok, true);
  const row = saved(store);
  assert.equal(row.squareLinkPreparation, null);
  assert.equal(row.squareLinkPreparationHistory.length, 1);
  assert.equal(row.ledger.settledCents, 25000);
  assert.equal(row.paymentStatus, 'paid_card_on_site');
});

test('cancellation supersedes the preparation and a repeat does not append history', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  const created = await prepare(store);
  const { cancelBookingTransition } = require('../netlify/lib/booking-cancel');
  const cancelled = await cancelBookingTransition({ bookingId: BOOKING_ID, now: NOW, by: 'admin' });
  assert.equal(cancelled.ok, true);
  const row = saved(store);
  assert.equal(row.jobStatus, 'cancelled');
  assert.equal(row.squareLinkPreparation, null);
  assert.equal(row.squareLinkPreparationHistory[0].issuanceId, created.payload.preparation.issuanceId);
  assert.equal(row.squareLinkPreparationHistory[0].supersededReason, 'cancelled');
  assert.equal(row.paymentStatus, 'unpaid');
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
  const repeat = await cancelBookingTransition({ bookingId: BOOKING_ID, now: NOW, by: 'admin' });
  assert.equal(repeat.idempotent, true);
  assert.equal(saved(store).squareLinkPreparationHistory.length, 1);
  const follow = await prepare(store);
  assert.equal(follow.payload.error, 'not_payable');
  assert.equal(saved(store).squareLinkPreparation, null);
});

test('approved amount changes supersede without creating a new preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  await prepare(store);
  const { persistMutation } = require('../netlify/functions/admin-ops-jobs');
  const upFrom = saved(store);
  const increased = await persistMutation(store, BOOKING_ID, {
    ...upFrom,
    approvedFinalAmount: 310,
    totalPrice: 310,
    ledger: { ...upFrom.ledger, approvedCents: 31000 },
  }, upFrom, 'set_approved_final_amount', 'increase');
  assert.equal(increased.ok, true);
  let row = saved(store);
  assert.equal(row.ledger.approvedCents, 31000);
  assert.equal(row.squareLinkPreparation, null);
  assert.equal(row.squareLinkPreparationHistory.length, 1);
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
  const downFrom = saved(store);
  const decreased = await persistMutation(store, BOOKING_ID, {
    ...downFrom,
    approvedFinalAmount: 200,
    totalPrice: 200,
    ledger: { ...downFrom.ledger, approvedCents: 20000 },
  }, downFrom, 'set_approved_final_amount', 'decrease');
  assert.equal(decreased.ok, true);
  row = saved(store);
  assert.equal(row.ledger.approvedCents, 20000);
  assert.equal(row.squareLinkPreparation, null);
  assert.equal(row.squareLinkPreparationHistory.length, 1);
  assert.equal(row.ledger.entries[0].entryId, 'le_existing');
});

test('repeated reconciliation does not grow history', () => {
  const once = reconcilePreparedIssuance({
    id: BOOKING_ID,
    jobStatus: 'cancelled',
    ledger: { currency: 'usd', approvedCents: 25000, settledCents: 0, creditedCents: 0 },
    squareLinkPreparation: {
      bookingId: BOOKING_ID,
      issuanceId: '55555555-5555-4555-8555-555555555555',
      state: 'prepared',
      amountCents: 25000,
      currency: 'USD',
      operationId: 'ignored',
    },
    squareLinkPreparationHistory: [],
  }, NOW);
  const twice = reconcilePreparedIssuance(once.booking, NOW);
  assert.equal(twice.superseded, null);
  assert.equal(once.booking.squareLinkPreparationHistory.length, 1);
  assert.equal(twice.booking.squareLinkPreparationHistory.length, 1);
});

test('a missing etag refuses the preparation write', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let writes = 0;
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    writes += 1;
    return original(...args);
  };
  store.getWithMetadata = async (key) => {
    if (!store._data.has(key)) return null;
    return { data: JSON.parse(store._data.get(key).value), etag: null };
  };
  const result = await prepare(store);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error, 'cas_precondition_missing');
  assert.equal(writes, 0);
  assert.equal(saved(store).squareLinkPreparation, undefined);
});

test('an empty storage acknowledgement is not a confirmed preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const original = store.setJSON.bind(store);
  store.setJSON = async () => undefined;
  const missing = await prepare(store);
  assert.equal(missing.payload.ok, false);
  assert.equal(missing.payload.error, 'write_outcome_unknown');
  assert.equal(missing.payload.writeAcknowledged, false);
  assert.equal(saved(store).squareLinkPreparation, undefined);
  store.setJSON = async (...args) => {
    await original(...args);
    return undefined;
  };
  const ambiguous = await prepare(store);
  assert.equal(ambiguous.payload.ok, true);
  assert.equal(ambiguous.payload.writeAcknowledged, false);
  assert.equal(ambiguous.payload.recoveredFromDurableState, true);
  assert.equal(saved(store).squareLinkPreparation.state, 'prepared');
});

test('a stale etag conflicts and the retry keeps one issuance', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let calls = 0;
  const original = store.setJSON.bind(store);
  store.setJSON = async (key, value, options = {}) => {
    calls += 1;
    if (calls === 1) return { modified: false };
    return original(key, value, options);
  };
  const result = await prepare(store);
  assert.equal(result.payload.ok, true);
  assert.equal(calls, 2);
  assert.equal(saved(store).squareLinkPreparation.state, 'prepared');
});

test('overlapping preparation and cash payment end with no current issuance', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  const previous = booking();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    writes += 1;
    if (writes === 1) await gate;
    else release();
    return original(...args);
  };
  const { persistMutation } = require('../netlify/functions/admin-ops-jobs');
  const cashPatch = {
    ...previous,
    cashReceivedAmount: 250,
    paymentStatus: 'paid_cash',
    paymentWorkflowStatus: 'cash_paid',
  };
  const [prep, cash] = await Promise.all([
    prepare(store),
    persistMutation(store, BOOKING_ID, cashPatch, previous, 'mark_cash_received', 'cash'),
  ]);
  if (!cash.ok) {
    store.setJSON = original;
    const fresh = saved(store);
    const retry = await persistMutation(store, BOOKING_ID, {
      ...fresh,
      cashReceivedAmount: 250,
      paymentStatus: 'paid_cash',
      paymentWorkflowStatus: 'cash_paid',
    }, fresh, 'mark_cash_received', 'cash');
    assert.equal(retry.ok, true);
  }
  if (!prep.payload.ok) assert.equal(prep.payload.error, 'not_payable');
  const row = saved(store);
  assert.notEqual(row.squareLinkPreparation && row.squareLinkPreparation.state, 'prepared');
  assert.equal(row.ledger.settledCents, 25000);
  assert.equal(row.paymentStatus, 'paid_cash');
  assert.equal(row.ledger.entries.some((entry) => entry.entryId === 'le_existing'), true);
  const cashHistory = row.squareLinkPreparationHistory || [];
  if (cashHistory.length) {
    assert.equal(cashHistory[0].state, 'superseded');
    assert.equal(cashHistory[0].amountCents, 25000);
  }
});

test('overlapping preparation and cancellation end cancelled and not current', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  setBookingStoreOverride(store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    writes += 1;
    if (writes === 1) await gate;
    else release();
    return original(...args);
  };
  const { cancelBookingTransition } = require('../netlify/lib/booking-cancel');
  const [prep, cancelled] = await Promise.all([
    prepare(store),
    cancelBookingTransition({ bookingId: BOOKING_ID, now: NOW, by: 'admin' }),
  ]);
  if (!cancelled.ok) {
    store.setJSON = original;
    const retry = await cancelBookingTransition({ bookingId: BOOKING_ID, now: NOW, by: 'admin' });
    assert.equal(retry.ok, true);
  }
  if (!prep.payload.ok) assert.equal(prep.payload.error, 'not_payable');
  const row = saved(store);
  assert.equal(row.jobStatus, 'cancelled');
  assert.notEqual(row.squareLinkPreparation && row.squareLinkPreparation.state, 'prepared');
  assert.equal(row.paymentStatus, 'unpaid');
  assert.equal(row.manualPayLink, 'https://pay.example.test/manual');
  const cancelHistory = row.squareLinkPreparationHistory || [];
  if (cancelHistory.length) {
    assert.equal(cancelHistory[0].state, 'superseded');
    assert.equal(cancelHistory[0].supersededReason, 'cancelled');
  }
});

test('an audit-feed failure does not roll back the booking preparation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const prior = { value: { action: 'older_admin_note', booking_id: BOOKING_ID } };
  auditLog.rows.length = 0;
  auditLog.rows.push(prior);
  auditLog.setJSON = async () => {
    throw new Error('audit_store_down');
  };
  try {
    const result = await prepare(store);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.auditRecorded, false);
    assert.equal(result.payload.paid, false);
    const row = saved(store);
    assert.equal(row.squareLinkPreparation.state, 'prepared');
    assert.equal(row.paymentStatus, 'unpaid');
    assert.equal(auditLog.rows[0], prior);
  } finally {
    auditLog.setJSON = async function setJSON(key, value) {
      this.rows.push({ key, value });
      return { modified: true };
    };
  }
});

test('the prisma mirror is not a version-checked authority and stays disconnected', async () => {
  const mirror = fs.readFileSync(path.join(root, 'netlify/lib/booking-prisma-mirror.js'), 'utf8');
  const upsert = mirror.slice(mirror.indexOf('prisma.bookingRecord.upsert'), mirror.indexOf('return { ok: true }'));
  const whereBlock = upsert.slice(upsert.indexOf('where:'), upsert.indexOf('create:'));
  assert.match(whereBlock, /where:\s*\{\s*id:\s*row\.id\s*\}/);
  assert.doesNotMatch(whereBlock, /bookingVersion/);
  const skipped = await upsertBookingMirror({
    id: BOOKING_ID,
    bookingVersion: 2,
    squareLinkPreparation: { state: 'prepared', amountCents: 25000 },
  });
  assert.equal(skipped.skipped, true);
});
