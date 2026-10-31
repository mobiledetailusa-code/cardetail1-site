const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ui = require('../netlify/lib/admin-square-receipt-ui');
const {
  evaluateSquareDashboardReceipt,
  isOnSiteSettlementEntry,
  squareDashboardProviderEventId,
} = require('../netlify/lib/db/payment-authority-service');
const {
  manualSquareCollectionEnabled,
  onSiteSettlementManualCollectionConflict,
} = require('../netlify/lib/db/manual-collection');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin-ops.html'), 'utf8');
const jobs = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'admin-ops-jobs.js'), 'utf8');
const reportAt = html.indexOf("const dReportMc = $('#dReportManualPayment')");
const receiptAt = html.indexOf("const dReceiptMc = $('#dRecordSquareReceipt')");
const closeAt = html.indexOf("const dCloseMc = $('#dCloseManualCollection')");
const reportSlice = html.slice(reportAt, receiptAt);
const receiptSlice = html.slice(receiptAt, html.indexOf("const dgpl = $('#dGenPayLink')"));
const closeSlice = html.slice(closeAt, reportAt);

function recordedBooking() {
  return {
    id: 'bk-ui',
    manualCollectionState: 'recorded',
    manualCollectionOperationId: 'op-1',
    manualCollectionUrl: 'https://square.example/pay',
    manualCollectionDetail: {},
  };
}

delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.MANUAL_SQUARE_COLLECTION_ENABLED;

test('report payment does not create a ledger request', () => {
  const built = ui.buildPaymentReportedRequest({
    bookingId: 'bk-ui',
    operationId: 'op-1',
    reason: 'saw a completed total',
    evidence: 'note only',
  });
  assert.equal(built.ok, true);
  assert.equal(built.body.action, 'close_manual_collection');
  assert.equal(built.body.outcome, 'payment_reported');
  assert.equal(Object.hasOwn(built.body, 'amountCents'), false);
  assert.equal(Object.hasOwn(built.body, 'kind'), false);
  assert.equal(reportSlice.includes("outcome:'payment_reported'") || reportSlice.includes('buildPaymentReportedRequest'), true);
  assert.equal(reportSlice.includes('record_square_dashboard_receipt'), false);
  assert.equal(reportSlice.includes('LedgerEntry'), false);
});

test('report payment keeps the restriction language', () => {
  assert.match(reportSlice, /does not write a ledger receipt/);
  assert.match(reportSlice, /does not mark the booking paid/);
  assert.doesNotMatch(reportSlice, /Payment completed|Booking paid/);
});

test('receipt action sends the backend contract', () => {
  const built = ui.buildDashboardReceiptRequest({
    bookingId: 'bk-ui',
    operationId: 'op-1',
    squareTransactionRef: 'sq_txn_1001',
    amountText: '$150.00',
    currency: 'USD',
    dashboardObserved: true,
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.body, {
    action: 'record_square_dashboard_receipt',
    bookingId: 'bk-ui',
    operationId: 'op-1',
    squareTransactionRef: 'sq_txn_1001',
    amountCents: 15000,
    currency: 'usd',
    dashboardObserved: true,
  });
  assert.equal(receiptSlice.includes('buildDashboardReceiptRequest'), true);
  assert.equal(receiptSlice.includes('built.body'), true);
});

test('required receipt details are validated before a request', () => {
  assert.equal(ui.buildDashboardReceiptRequest({
    bookingId: 'bk-ui', operationId: 'op-1', squareTransactionRef: '', amountText: '150.00', currency: 'usd', dashboardObserved: true,
  }).ok, false);
  assert.equal(ui.buildDashboardReceiptRequest({
    bookingId: 'bk-ui', operationId: 'op-1', squareTransactionRef: 'sq_txn_1001', amountText: 'nope', currency: 'usd', dashboardObserved: true,
  }).ok, false);
  assert.equal(ui.buildDashboardReceiptRequest({
    bookingId: 'bk-ui', operationId: 'op-1', squareTransactionRef: 'sq_txn_1001', amountText: '150.00', currency: 'dollars', dashboardObserved: true,
  }).ok, false);
  assert.equal(ui.buildDashboardReceiptRequest({
    bookingId: 'bk-ui', operationId: '', squareTransactionRef: 'sq_txn_1001', amountText: '150.00', currency: 'usd', dashboardObserved: true,
  }).ok, false);
  const body = ui.buildDashboardReceiptRequest({
    bookingId: 'bk-ui', operationId: 'op-1', squareTransactionRef: 'sq_txn_1001', amountText: '150.10', currency: 'usd', dashboardObserved: true,
  }).body;
  assert.equal(body.amountCents, 15010);
  assert.equal(Object.hasOwn(body, 'remainingCents'), false);
  assert.equal(Object.hasOwn(body, 'paymentStatus'), false);
  assert.equal(Object.hasOwn(body, 'kind'), false);
});

test('administrator authentication stays on the existing admin request', () => {
  assert.match(html, /x-admin-key': CD1AdminSession\.getToken\(\)/);
  const handlerAt = jobs.indexOf('exports.handler = async');
  const authAt = jobs.indexOf('const auth = await verifyAdminKey', handlerAt);
  const callAt = jobs.indexOf('return handleAdminAction(body', authAt);
  assert.ok(handlerAt > 0 && authAt > handlerAt && callAt > authAt);
});

test('receipt success shows attestation and refreshes server state', () => {
  const message = ui.receiptResultMessage({
    ok: true,
    paid: false,
    providerVerified: false,
    squareVerified: false,
    ledgerEntryCreated: true,
  });
  assert.match(message, /administrator attestation/);
  assert.match(message, /has not marked the booking paid/);
  assert.doesNotMatch(message, /Payment completed/);
  assert.match(receiptSlice, /receiptResultMessage\(d\)/);
  assert.match(receiptSlice, /await refreshAll\(\)/);
});

test('receipt failure does not display paid', () => {
  for (const code of [
    'square_receipt_amount_mismatch',
    'square_receipt_currency_mismatch',
    'square_reference_conflict',
    'square_receipt_review_required',
    'square_receipt_failed',
    'database_not_configured',
    'square_receipt_outcome_unknown',
  ]) {
    const message = ui.receiptFailureMessage({ data: { error: code } });
    assert.match(message, /not marked paid|not credited|unavailable|unknown/i);
    assert.doesNotMatch(message, /Payment completed|Booking paid/);
  }
});

test('duplicate receipt is an idempotent message and one settlement identity', () => {
  const message = ui.receiptResultMessage({ ok: true, idempotent: true, paid: false, ledgerEntryCreated: false });
  assert.match(message, /No second settlement/);
  const decision = evaluateSquareDashboardReceipt({
    actorId: 'admin',
    dashboardObserved: true,
    booking: recordedBooking(),
    quote: { id: 'q1', quoteVersion: 1, currency: 'usd' },
    projection: { remainingCents: 15000, pendingRefundCents: 0 },
    ledgerEntries: [],
    paymentAttempts: [],
    existingReceipt: {
      bookingId: 'bk-ui',
      amountCents: 15000,
      currency: 'usd',
      kind: 'settlement',
    },
    amountCents: 15000,
    currency: 'usd',
    squareTransactionRef: 'sq_txn_1001',
    operationId: 'op-1',
  });
  assert.equal(decision.idempotent, true);
  assert.equal(decision.write, false);
  assert.equal(decision.ledgerEntryCreated, false);
  assert.equal(decision.providerEventId, squareDashboardProviderEventId('sq_txn_1001'));
});

test('the same Square reference on another booking is rejected', () => {
  const decision = evaluateSquareDashboardReceipt({
    actorId: 'admin',
    dashboardObserved: true,
    booking: recordedBooking(),
    quote: { id: 'q1', quoteVersion: 1, currency: 'usd' },
    projection: { remainingCents: 15000, pendingRefundCents: 0 },
    ledgerEntries: [],
    paymentAttempts: [],
    existingReceipt: {
      bookingId: 'bk-other',
      amountCents: 15000,
      currency: 'usd',
      kind: 'settlement',
    },
    amountCents: 15000,
    currency: 'usd',
    squareTransactionRef: 'sq_txn_1001',
    operationId: 'op-1',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.error, 'square_reference_conflict');
  assert.match(ui.receiptFailureMessage({ data: decision }), /cannot be credited/);
});

test('a financial mismatch stays a visible error', () => {
  const decision = evaluateSquareDashboardReceipt({
    actorId: 'admin',
    dashboardObserved: true,
    booking: recordedBooking(),
    quote: { id: 'q1', quoteVersion: 1, currency: 'usd' },
    projection: { remainingCents: 15000, pendingRefundCents: 0 },
    ledgerEntries: [],
    paymentAttempts: [],
    amountCents: 14000,
    currency: 'usd',
    squareTransactionRef: 'sq_txn_1001',
    operationId: 'op-1',
  });
  assert.equal(decision.error, 'square_receipt_amount_mismatch');
  assert.match(ui.receiptFailureMessage({ data: decision }), /does not match the booking balance/);
});

test('an unknown response does not submit the receipt again', () => {
  const timeout = new Error('timeout');
  assert.equal(ui.isUncertainReceiptOutcome(timeout), true);
  assert.equal(ui.isUncertainReceiptOutcome({ data: { error: 'square_receipt_outcome_unknown' }, status: 503 }), true);
  assert.equal(ui.isUncertainReceiptOutcome({ data: { error: 'square_receipt_amount_mismatch' }, status: 409 }), false);
  assert.equal(ui.isUncertainReceiptOutcome({ message: 'Session expired — log in again at admin.html', status: 401 }), false);
  const calls = receiptSlice.split('record_square_dashboard_receipt').length - 1;
  assert.equal(calls <= 2, true);
  assert.equal((receiptSlice.match(/await api\(/g) || []).length, 1);
});

test('the drawer reads collection status from the server view', () => {
  const text = ui.collectionStatusText({
    url: 'https://square.example/pay',
    externalFinancialConflicts: [{ providerEventId: 'settlement_pi_1', reviewRequired: true }],
    squareDashboardReceipt: {
      providerEventId: 'square_dashboard_receipt:sq_txn_1001',
      squareTransactionRef: 'sq_txn_1001',
      verificationMethod: 'administrator_square_dashboard',
    },
  });
  assert.match(text, /Square URL recorded/);
  assert.match(text, /Unresolved financial conflict/);
  assert.match(text, /administrator attestation/);
  assert.match(html, /collectionStatusText\(drawerControls&&drawerControls\.manualCollection\)/);
  assert.match(receiptSlice, /await refreshAll\(\)/);
});

test('unpaid link closure remains an attestation', () => {
  assert.match(closeSlice, /outcome:'unpaid_withdrawn'/);
  assert.match(closeSlice, /noCompletedPayment:true/);
  assert.match(closeSlice, /not a Square verification/);
  assert.doesNotMatch(closeSlice, /record_square_dashboard_receipt|Booking paid|Payment completed/);
});

test('financial conflicts remain visible and a receipt is not cash or card', () => {
  const entry = {
    kind: 'settlement',
    providerObjectId: 'sq_txn_1001',
    providerEventId: 'square_dashboard_receipt:sq_txn_1001',
  };
  assert.equal(isOnSiteSettlementEntry(entry), false);
  assert.match(ui.collectionStatusText({
    externalFinancialConflicts: [{ reviewRequired: true }],
  }), /Review is required/);
});

test('a missing flag blocks new collection enablement and an active reservation still blocks cash', () => {
  assert.equal(manualSquareCollectionEnabled({}), false);
  assert.equal(manualSquareCollectionEnabled({ MANUAL_SQUARE_COLLECTION_ENABLED: 'false' }), false);
  assert.equal(manualSquareCollectionEnabled({ MANUAL_SQUARE_COLLECTION_ENABLED: 'true' }), true);
  const blocked = onSiteSettlementManualCollectionConflict({
    manualCollectionState: 'recorded',
    manualCollectionOperationId: 'op-1',
  });
  assert.equal(blocked.error, 'manual_collection_active');
});

test('the drawer and helper do not call Square or Stripe', () => {
  const helper = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'lib', 'admin-square-receipt-ui.js'), 'utf8');
  assert.equal(helper.includes('api.squareup.com'), false);
  assert.equal(helper.includes('api.stripe.com'), false);
  assert.equal(helper.includes('fetch('), false);
  assert.equal(receiptSlice.includes('api.squareup.com'), false);
  assert.equal(receiptSlice.includes('api.stripe.com'), false);
  assert.equal(reportSlice.includes('api.squareup.com'), false);
});
