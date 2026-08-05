/**
 * Admin payment operations and post-service experience.
 *
 * Covers the controls repaired in this change: the cash confirmation email,
 * receipt truthfulness, operational reopen, payment-method rules, price
 * adjustment authority, review eligibility and the 48-hour issue window.
 *
 * Every assertion is deterministic — no Stripe call, no database, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const notifications = require('../netlify/lib/booking-transactional-notifications');
const receipts = require('../netlify/lib/receipt-projection');
const lifecycle = require('../netlify/lib/operations-lifecycle');
const mutations = require('../netlify/lib/admin-booking-mutations');
const methodPolicy = require('../netlify/lib/payment-method-policy');
const adjustments = require('../netlify/lib/price-adjustments');
const postService = require('../netlify/lib/post-service-experience');
const { financialProjection } = require('../netlify/lib/payment-service');

const HOUR = 60 * 60 * 1000;

function bookingFixture(overrides = {}) {
  const approvedCents = overrides.approvedCents != null ? overrides.approvedCents : 31000;
  const settledCents = overrides.settledCents != null ? overrides.settledCents : 0;
  return {
    id: 'CD1-OPS-TEST',
    kind: 'booking',
    schemaVersion: 1,
    bookingVersion: 4,
    quoteVersion: 2,
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '2015550123',
    email: 'ada@example.com',
    jobStatus: 'confirmed',
    serviceStatus: 'confirmed',
    paymentMethodPreference: 'card_on_file',
    approvedFinalAmount: approvedCents / 100,
    totalPrice: approvedCents / 100,
    ledger: {
      currency: 'usd',
      approvedCents,
      settledCents,
      creditedCents: 0,
      pendingCents: 0,
      entries: overrides.entries || [],
    },
    ...overrides,
  };
}

function cashEntry(amountCents) {
  return {
    entryId: 'le_cash_1',
    kind: 'settlement',
    method: 'cash',
    amountCents,
    currency: 'usd',
    recordedAt: '2026-08-01T12:00:00.000Z',
    actor: 'admin_mark_cash_received',
  };
}

// ── Cash confirmation email ────────────────────────────────────────────────

test('cash payment email carries every required figure and no marketing', () => {
  const content = notifications.buildEmailContent(
    notifications.EVENT_PAYMENT_RECEIVED,
    {
      id: 'CD1-ABC-123',
      firstName: 'Ada',
      __paymentEvent: {
        method: 'cash',
        amountCents: 12500,
        approvedCents: 31000,
        remainingCents: 18500,
        recordedAt: '2026-08-04T10:00:00.000Z',
        receiptUrl: 'https://example.com/receipt.html?bookingId=CD1-ABC-123',
      },
    },
    'https://example.com/my-garage.html?t=tok'
  );

  assert.equal(content.subject, 'Payment received for your Detailing Zone appointment');
  assert.match(content.text, /Booking reference: CD1-ABC-123/);
  assert.match(content.text, /Amount received: \$125\.00/);
  assert.match(content.text, /Payment method: Cash/);
  assert.match(content.text, /Total: \$310\.00/);
  assert.match(content.text, /Remaining balance: \$185\.00/);
  assert.match(content.text, /Date recorded: 2026-08-04/);
  assert.match(content.text, /Receipt: https:\/\/example\.com\/receipt\.html/);
  assert.match(content.text, /Thank you for choosing Detailing Zone\./);
  assert.match(content.html, /Thank you for choosing Detailing Zone\./);
  // Transactional only.
  assert.doesNotMatch(content.text, /off\b|discount|subscribe|deal|offer/i);
});

test('cash email omits the receipt line when no receipt exists yet', () => {
  const content = notifications.buildEmailContent(
    notifications.EVENT_PAYMENT_RECEIVED,
    { id: 'CD1-X', firstName: 'Ada', __paymentEvent: { method: 'cash', amountCents: 5000, approvedCents: 5000, remainingCents: 0 } },
    ''
  );
  assert.doesNotMatch(content.text, /Receipt:/);
  assert.match(content.text, /Remaining balance: \$0\.00/);
  assert.doesNotMatch(content.text, /still outstanding/);
});

test('payment email idempotency key follows the settlement, not the clock', () => {
  const a = notifications.eventStateKey(notifications.EVENT_PAYMENT_RECEIVED, {
    id: 'CD1-A', bookingVersion: 3, __paymentEvent: { settlementId: 'CD1-A:31000:cash' },
  });
  const b = notifications.eventStateKey(notifications.EVENT_PAYMENT_RECEIVED, {
    id: 'CD1-A', bookingVersion: 9, __paymentEvent: { settlementId: 'CD1-A:31000:cash' },
  });
  const c = notifications.eventStateKey(notifications.EVENT_PAYMENT_RECEIVED, {
    id: 'CD1-A', bookingVersion: 3, __paymentEvent: { settlementId: 'CD1-A:46000:cash' },
  });
  assert.equal(a, b, 'same settlement must reuse one key even across booking revisions');
  assert.notEqual(a, c, 'a different settlement must get its own key');
});

test('payment_received is email-only — no SMS spend on a receipt', async () => {
  const result = await notifications.emitPaymentReceived(
    { id: 'CD1-NO-SMS', firstName: 'Ada', phone: '2015550123' },
    { method: 'cash', amountCents: 1000, approvedCents: 1000, remainingCents: 0 }
  );
  assert.ok(result.ok || result.error, 'emit must resolve rather than throw');
  if (result.delivery) {
    assert.equal(result.delivery.sms.sent, false);
    assert.equal(result.delivery.sms.reason, 'sms_not_enabled_for_event');
  }
});

test('emitPaymentReceived never persists its transient payment context', async () => {
  const result = await notifications.emitPaymentReceived(
    { id: 'CD1-CLEAN', firstName: 'Ada', email: 'a@b.co' },
    { method: 'cash', amountCents: 1000, approvedCents: 1000, remainingCents: 0 }
  );
  if (result.booking) {
    assert.equal(result.booking.__paymentEvent, undefined);
  }
});

// ── Receipt ────────────────────────────────────────────────────────────────

test('a cash settlement reads as Cash on the receipt, not Card', () => {
  const booking = bookingFixture({
    settledCents: 31000,
    entries: [cashEntry(31000)],
    completedAt: '2026-08-01T12:00:00.000Z',
    jobStatus: 'completed_paid',
  });
  const result = receipts.buildReceiptProjection(booking, 'payment');
  assert.equal(result.ok, true);
  assert.equal(result.receipt.paymentMethod, 'Cash');
  assert.equal(result.receipt.payments[0].method, 'Cash');
  // No Stripe vocabulary anywhere in a cash receipt.
  assert.doesNotMatch(JSON.stringify(result.receipt), /stripe|checkout session|card ending/i);
});

test('cash is recognised from the Postgres marker too', () => {
  assert.equal(receipts.settlementMethodLabel({ providerObjectId: 'cash' }), 'Cash');
  assert.equal(receipts.settlementMethodLabel({ actor: 'admin_mark_cash_received' }), 'Cash');
  assert.equal(receipts.settlementMethodLabel({ providerObjectId: 'cs_test_123' }), 'Card');
  assert.equal(receipts.settlementMethodLabel({ method: 'cash' }), 'Cash');
});

test('a part-paid receipt never claims to be paid', () => {
  const booking = bookingFixture({ settledCents: 12500, entries: [cashEntry(12500)] });
  const result = receipts.buildReceiptProjection(booking, 'payment');
  assert.equal(result.ok, true);
  assert.equal(result.receipt.balanceStatus, 'Balance outstanding');
  assert.equal(result.receipt.paidInFull, false);
  assert.equal(result.receipt.financialSummary.remainingBalance.cents, 18500);
  assert.equal(result.receipt.footer, 'Thank you for choosing Detailing Zone.');
  assert.ok(result.receipt.receiptId);
  assert.equal(result.receipt.paymentDate, '2026-08-01');
});

test('a booking settled by both methods claims neither alone', () => {
  const booking = bookingFixture({
    settledCents: 31000,
    entries: [
      cashEntry(10000),
      { entryId: 'le_card', kind: 'settlement', amountCents: 21000, providerObjectId: 'cs_x', recordedAt: '2026-08-02T00:00:00.000Z' },
    ],
  });
  assert.equal(receipts.paymentMethodLabel(booking, financialProjection(booking)), 'Cash and card');
});

// ── Reopen ─────────────────────────────────────────────────────────────────

test('reopened survives syncLegacyFields instead of collapsing to in_progress', () => {
  const synced = lifecycle.syncLegacyFields({ serviceStatus: 'reopened', jobStatus: 'reopened' });
  assert.equal(synced.serviceStatus, 'reopened');
  assert.equal(synced.jobStatus, 'reopened');
});

test('reopen requires a reason', () => {
  const booking = bookingFixture({ jobStatus: 'completed_paid', serviceStatus: 'closed' });
  const result = mutations.reopenAppointment(booking, { reason: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reason_required');
});

test('reopen refuses a job that was never completed', () => {
  const result = mutations.reopenAppointment(bookingFixture(), { reason: 'customer called back' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_transition');
  assert.equal(result.statusCode, 409);
});

test('reopening a paid job leaves every financial fact untouched', () => {
  const booking = bookingFixture({
    settledCents: 31000,
    entries: [cashEntry(31000)],
    jobStatus: 'completed_paid',
    serviceStatus: 'closed',
    paymentStatus: 'paid_cash',
    paymentWorkflowStatus: 'cash_paid',
    completedAt: '2026-08-01T12:00:00.000Z',
    paymentAttempts: [{ attemptId: 'pa_1', providerObjectId: 'pi_settled', status: 'settled', amountCents: 31000 }],
  });
  const before = financialProjection(booking);

  const result = mutations.reopenAppointment(booking, { reason: 'swirl marks on hood' });
  assert.equal(result.ok, true);

  const after = financialProjection(result.booking);
  assert.equal(after.settledCents, before.settledCents);
  assert.equal(after.remainingCents, before.remainingCents);
  assert.equal(after.remainingCents, 0, 'reopen must not restore the original balance');
  assert.equal(after.approvedCents, before.approvedCents);
  assert.deepEqual(result.booking.ledger.entries, booking.ledger.entries);
  assert.deepEqual(result.booking.paymentAttempts, booking.paymentAttempts);
  assert.equal(result.booking.paymentStatus, 'paid_cash');

  // Operational state moved; proof of completion did not.
  assert.equal(result.booking.jobStatus, 'reopened');
  assert.equal(result.booking.serviceStatus, 'reopened');
  assert.equal(result.booking.completedAt, '2026-08-01T12:00:00.000Z');
  assert.equal(result.booking.previousCompletedAt, '2026-08-01T12:00:00.000Z');
  assert.ok(result.booking.reopenedAt);
  assert.equal(result.booking.reopenCount, 1);
  assert.equal(result.booking.reopenHistory.length, 1);
  assert.equal(result.booking.reopenHistory[0].reason, 'swirl marks on hood');
});

test('reopening an unpaid job leaves the balance owed exactly as it was', () => {
  const booking = bookingFixture({
    jobStatus: 'completed_pending_payment',
    serviceStatus: 'awaiting_customer_action',
    completedAt: '2026-08-01T12:00:00.000Z',
  });
  const result = mutations.reopenAppointment(booking, { reason: 'return visit' });
  assert.equal(result.ok, true);
  assert.equal(financialProjection(result.booking).remainingCents, 31000);
});

test('reopen does not erase review or issue history', () => {
  const booking = bookingFixture({
    jobStatus: 'completed_paid',
    serviceStatus: 'closed',
    completedAt: '2026-08-01T12:00:00.000Z',
    review: { reviewId: 'REV-1', stars: 5, submittedAt: '2026-08-01T13:00:00.000Z' },
    serviceIssues: [{ issueId: 'iss_1', category: 'quality', description: 'x', createdAt: '2026-08-01T14:00:00.000Z', status: 'open' }],
  });
  const result = mutations.reopenAppointment(booking, { reason: 'fix' });
  assert.equal(result.booking.review.reviewId, 'REV-1');
  assert.equal(result.booking.serviceIssues.length, 1);
});

// ── Payment method ─────────────────────────────────────────────────────────

test('no payment recorded — the intended method changes freely', () => {
  const booking = bookingFixture();
  const cap = methodPolicy.paymentMethodCapability(booking);
  assert.equal(cap.canChange, true);
  assert.equal(cap.scope, 'intended');

  const result = methodPolicy.resolvePaymentMethodChange(booking, {
    paymentMethodPreference: 'cash_on_site',
    reason: 'customer prefers cash',
    expectedBookingVersion: 4,
  });
  assert.equal(result.ok, true);
  assert.equal(result.patch.paymentMethodPreference, 'cash_on_site');
  assert.equal(result.patch.paymentMethodHistory[0].from, 'card_on_file');
  assert.equal(result.patch.paymentMethodHistory[0].reason, 'customer prefers cash');
});

test('partial payment — history is frozen, only the remainder is redirected', () => {
  const booking = bookingFixture({ settledCents: 10000, entries: [cashEntry(10000)] });
  const cap = methodPolicy.paymentMethodCapability(booking);
  assert.equal(cap.canChange, true);
  assert.equal(cap.scope, 'remaining_only');

  const result = methodPolicy.resolvePaymentMethodChange(booking, {
    paymentMethodPreference: 'card_on_site',
    reason: 'card for the rest',
    expectedBookingVersion: 4,
  });
  assert.equal(result.ok, true);
  assert.equal(result.patch.remainingBalanceMethod, 'card_on_site');
  // The settled cash entry is not part of the patch at all.
  assert.equal(result.patch.ledger, undefined);
});

test('fully paid — the ordinary method change is refused', () => {
  const booking = bookingFixture({ settledCents: 31000, entries: [cashEntry(31000)] });
  const cap = methodPolicy.paymentMethodCapability(booking);
  assert.equal(cap.canChange, false);
  assert.equal(cap.scope, 'locked');
  assert.equal(cap.correctionAvailable, true);

  const result = methodPolicy.resolvePaymentMethodChange(booking, {
    paymentMethodPreference: 'card_on_site',
    reason: 'tidy up',
    expectedBookingVersion: 4,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'payment_method_locked');
  assert.equal(result.statusCode, 409);
});

test('every method change carries reason, identity and expected version', () => {
  const booking = bookingFixture();
  assert.equal(
    methodPolicy.resolvePaymentMethodChange(booking, { paymentMethodPreference: 'cash_on_site', expectedBookingVersion: 4 }).error,
    'reason_required'
  );
  assert.equal(
    methodPolicy.resolvePaymentMethodChange(booking, { paymentMethodPreference: 'cash_on_site', reason: 'x' }).error,
    'expected_version_required'
  );
  assert.equal(
    methodPolicy.resolvePaymentMethodChange(booking, { paymentMethodPreference: 'cash_on_site', reason: 'x', expectedBookingVersion: 1 }).error,
    'version_conflict'
  );
  assert.equal(
    methodPolicy.resolvePaymentMethodChange(booking, { paymentMethodPreference: 'bitcoin', reason: 'x', expectedBookingVersion: 4 }).error,
    'invalid_preference'
  );
});

test('correcting a recorded method needs evidence and never edits the ledger', () => {
  const booking = bookingFixture({ settledCents: 31000, entries: [cashEntry(31000)] });
  assert.equal(
    methodPolicy.resolvePaymentMethodCorrection(booking, { correctedMethod: 'card_on_site', reason: 'mis-keyed', expectedBookingVersion: 4 }).error,
    'evidence_required'
  );

  const ok = methodPolicy.resolvePaymentMethodCorrection(booking, {
    correctedMethod: 'card_on_site',
    reason: 'mis-keyed at the door',
    evidence: 'Square receipt 8841-22',
    expectedBookingVersion: 4,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.patch.ledger, undefined, 'a correction must never rewrite ledger history');
  assert.equal(ok.patch.paymentMethodCorrections[0].recordedMethod, 'card_on_file');
  assert.equal(ok.patch.paymentMethodCorrections[0].correctedMethod, 'card_on_site');
  assert.equal(ok.patch.paymentMethodCorrections[0].evidence, 'Square receipt 8841-22');
});

// ── Price adjustments ──────────────────────────────────────────────────────

test('a direct total rewrite is blocked once money has settled', () => {
  const settled = bookingFixture({ settledCents: 10000, entries: [cashEntry(10000)] });
  const guard = adjustments.guardDirectTotalMutation(settled, {});
  assert.equal(guard.ok, false);
  assert.equal(guard.error, 'adjustment_required');

  // Nothing settled — the legacy path stays open.
  assert.equal(adjustments.guardDirectTotalMutation(bookingFixture(), {}).ok, true);
});

test('increase before payment simply revises the total', () => {
  const booking = bookingFixture();
  const created = adjustments.createAdjustment(booking, {
    type: 'increase', amountCents: 5000, reason: 'extra vehicle', expectedBookingVersion: 4,
    customerApprovalRequired: false,
  });
  assert.equal(created.ok, true);
  assert.equal(created.adjustment.status, 'approved');
  assert.equal(created.adjustment.projectedOutcome, 'total_revised');

  const withAdj = { ...booking, ...created.patch };
  const applied = adjustments.applyAdjustment(withAdj, { adjustmentId: created.adjustment.adjustmentId });
  assert.equal(applied.ok, true);
  assert.equal(applied.approvedCents, 36000);
  assert.equal(applied.remainingCents, 36000);
  assert.equal(applied.outcome, 'total_revised');
});

test('an increase defaults to needing the customer to accept it', () => {
  const created = adjustments.createAdjustment(bookingFixture(), {
    type: 'increase', amountCents: 5000, reason: 'extra vehicle', expectedBookingVersion: 4,
  });
  assert.equal(created.adjustment.customerApprovalRequired, true);
  assert.equal(created.adjustment.status, 'pending_customer');

  const withAdj = { ...bookingFixture(), ...created.patch };
  const blocked = adjustments.applyAdjustment(withAdj, { adjustmentId: created.adjustment.adjustmentId });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'customer_approval_required');

  const decided = adjustments.decideAdjustment(withAdj, {
    adjustmentId: created.adjustment.adjustmentId, decision: 'approve', actorId: 'customer',
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.adjustment.status, 'approved');
});

test('increase after full payment creates a new balance, not a rewritten one', () => {
  const paid = bookingFixture({ settledCents: 31000, entries: [cashEntry(31000)] });
  const created = adjustments.createAdjustment(paid, {
    type: 'increase', amountCents: 4000, reason: 'engine bay add-on', expectedBookingVersion: 4,
    customerApprovalRequired: false,
  });
  assert.equal(created.adjustment.projectedOutcome, 'supplemental_balance_due');

  const withAdj = { ...paid, ...created.patch };
  const applied = adjustments.applyAdjustment(withAdj, { adjustmentId: created.adjustment.adjustmentId });
  assert.equal(applied.outcome, 'supplemental_balance_due');
  assert.equal(applied.approvedCents, 35000);
  assert.equal(applied.remainingCents, 4000);
  assert.equal(applied.supplementalDueCents, 4000);
  // The original credit is intact.
  assert.equal(applied.patch.ledger, undefined);
});

test('decrease after full payment opens a refund review and pays nothing', () => {
  const paid = bookingFixture({ settledCents: 31000, entries: [cashEntry(31000)] });
  const created = adjustments.createAdjustment(paid, {
    type: 'decrease', amountCents: 4000, reason: 'goodwill for late arrival', expectedBookingVersion: 4,
    customerApprovalRequired: false,
  });
  const withAdj = { ...paid, ...created.patch };
  const applied = adjustments.applyAdjustment(withAdj, { adjustmentId: created.adjustment.adjustmentId });

  assert.equal(applied.outcome, 'refund_or_credit_review');
  assert.equal(applied.patch.refundReview.status, 'pending_review');
  assert.equal(applied.patch.refundReview.amountCents, 4000);
  assert.equal(applied.patch.ledger, undefined, 'no automatic refund and no ledger rewrite');
  assert.deepEqual(withAdj.ledger.entries, paid.ledger.entries);
});

test('applying the same adjustment twice does not move the price twice', () => {
  const booking = bookingFixture();
  const created = adjustments.createAdjustment(booking, {
    type: 'increase', amountCents: 5000, reason: 'x', expectedBookingVersion: 4, customerApprovalRequired: false,
  });
  const withAdj = { ...booking, ...created.patch };
  const first = adjustments.applyAdjustment(withAdj, { adjustmentId: created.adjustment.adjustmentId });
  const afterFirst = { ...withAdj, ...first.patch };
  const second = adjustments.applyAdjustment(afterFirst, { adjustmentId: created.adjustment.adjustmentId });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyApplied, true);
  assert.deepEqual(second.patch, {});
});

test('the customer statement shows original, adjustment, revised, paid and remaining', () => {
  const paid = bookingFixture({ settledCents: 31000, entries: [cashEntry(31000)] });
  const created = adjustments.createAdjustment(paid, {
    type: 'increase', amountCents: 4000, reason: 'engine bay add-on', expectedBookingVersion: 4,
    customerApprovalRequired: false,
  });
  const withAdj = { ...paid, ...created.patch };
  const applied = adjustments.applyAdjustment(withAdj, { adjustmentId: created.adjustment.adjustmentId });
  const after = {
    ...withAdj,
    ...applied.patch,
    ledger: { ...withAdj.ledger, approvedCents: applied.approvedCents },
  };
  const statement = adjustments.adjustmentStatement(after);
  assert.equal(statement.originalTotalCents, 31000);
  assert.equal(statement.adjustmentCents, 4000);
  assert.equal(statement.revisedTotalCents, 35000);
  assert.equal(statement.paidCents, 31000);
  assert.equal(statement.remainingCents, 4000);
  assert.equal(statement.adjustmentReason, 'engine bay add-on');
});

test('a decrease cannot exceed the approved total', () => {
  const result = adjustments.createAdjustment(bookingFixture(), {
    type: 'decrease', amountCents: 99999, reason: 'x', expectedBookingVersion: 4,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'decrease_exceeds_approved');
});

// ── Completion, review and the 48-hour window ──────────────────────────────

function completedBooking(completedAt, overrides = {}) {
  return bookingFixture({
    jobStatus: 'completed_paid',
    serviceStatus: 'closed',
    settledCents: 31000,
    entries: [cashEntry(31000)],
    completedAt,
    ...overrides,
  });
}

test('completion exposes both the review and the issue action', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');
  const state = postService.postServiceState(completedBooking('2026-08-04T10:00:00.000Z'), now);
  assert.equal(state.completed, true);
  assert.equal(state.review.available, true);
  assert.equal(state.review.label, 'Leave a review');
  assert.equal(state.serviceIssue.available, true);
  assert.equal(state.serviceIssue.label, 'Report a service issue');
  assert.equal(state.customerResolutionStatus, 'issue_window_open');
});

test('an incomplete job exposes neither action', () => {
  const state = postService.postServiceState(bookingFixture());
  assert.equal(state.completed, false);
  assert.equal(state.review.available, false);
  assert.equal(state.serviceIssue.available, false);
  assert.equal(state.customerResolutionStatus, 'none');
});

test('an issue at 47h59m is accepted and at 48h01m is refused', () => {
  const completedAt = '2026-08-01T00:00:00.000Z';
  const base = Date.parse(completedAt);
  const booking = completedBooking(completedAt);

  const inside = postService.evaluateIssueSubmission(
    booking,
    { category: 'quality', description: 'Swirls remain on the hood.' },
    base + (47 * HOUR) + (59 * 60 * 1000)
  );
  assert.equal(inside.ok, true);

  const outside = postService.evaluateIssueSubmission(
    booking,
    { category: 'quality', description: 'Swirls remain on the hood.' },
    base + (48 * HOUR) + (1 * 60 * 1000)
  );
  assert.equal(outside.ok, false);
  assert.equal(outside.error, 'issue_window_closed');
  assert.equal(
    outside.message,
    'The online service issue window has closed. Please contact support for further assistance.'
  );
});

test('exactly 48h is still inside the window', () => {
  const completedAt = '2026-08-01T00:00:00.000Z';
  const base = Date.parse(completedAt);
  const result = postService.evaluateIssueSubmission(
    completedBooking(completedAt),
    { category: 'damage', description: 'Scratch on the rear bumper.' },
    base + (48 * HOUR)
  );
  assert.equal(result.ok, true);
});

test('the window is measured from the server clock, not a caller-supplied one', () => {
  const completedAt = '2026-08-01T00:00:00.000Z';
  const booking = completedBooking(completedAt);
  // A caller cannot pass completedAt or "now" through the submission payload.
  const attempt = postService.evaluateIssueSubmission(
    booking,
    { category: 'quality', description: 'x'.repeat(20), completedAt: '2030-01-01T00:00:00.000Z', now: '2026-08-01T01:00:00.000Z' },
    Date.parse(completedAt) + (72 * HOUR)
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error, 'issue_window_closed');
});

test('an issue needs a real category and a real description', () => {
  const booking = completedBooking('2026-08-04T10:00:00.000Z');
  const now = Date.parse('2026-08-04T11:00:00.000Z');
  assert.equal(
    postService.evaluateIssueSubmission(booking, { category: 'nonsense', description: 'x'.repeat(20) }, now).error,
    'invalid_category'
  );
  assert.equal(
    postService.evaluateIssueSubmission(booking, { category: 'quality', description: 'short' }, now).error,
    'description_required'
  );
});

test('a review is one per completed booking', () => {
  const booking = completedBooking('2026-08-04T10:00:00.000Z');
  const now = Date.parse('2026-08-04T11:00:00.000Z');

  const first = postService.evaluateReviewSubmission(booking, { stars: 5, comment: 'Great' }, now);
  assert.equal(first.ok, true);
  assert.equal(first.stars, 5);

  const reviewed = { ...booking, review: { reviewId: 'REV-1', stars: 5, submittedAt: '2026-08-04T10:30:00.000Z' } };
  const second = postService.evaluateReviewSubmission(reviewed, { stars: 1, comment: 'Changed my mind' }, now);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'review_already_submitted');
});

test('a legacy reviewLeft flag still blocks a second review', () => {
  const booking = completedBooking('2026-08-04T10:00:00.000Z', { reviewLeft: true, reviewId: 'REV-OLD' });
  const result = postService.evaluateReviewSubmission(booking, { stars: 4 }, Date.parse('2026-08-04T11:00:00.000Z'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'review_already_submitted');
});

test('a review needs a rating between 1 and 5', () => {
  const booking = completedBooking('2026-08-04T10:00:00.000Z');
  const now = Date.parse('2026-08-04T11:00:00.000Z');
  assert.equal(postService.evaluateReviewSubmission(booking, { stars: 0 }, now).error, 'invalid_rating');
  assert.equal(postService.evaluateReviewSubmission(booking, { stars: 6 }, now).error, 'invalid_rating');
  assert.equal(postService.evaluateReviewSubmission(booking, { stars: 'x' }, now).error, 'invalid_rating');
});

test('a review stays available after the issue window closes', () => {
  const completedAt = '2026-08-01T00:00:00.000Z';
  const state = postService.postServiceState(completedBooking(completedAt), Date.parse(completedAt) + (200 * HOUR));
  assert.equal(state.review.available, true);
  assert.equal(state.serviceIssue.available, false);
  assert.equal(state.customerResolutionStatus, 'review_available');
  assert.equal(
    state.serviceIssue.closedMessage,
    'The online service issue window has closed. Please contact support for further assistance.'
  );
});

test('a submitted issue shows as issue_submitted to both portals', () => {
  const completedAt = '2026-08-04T10:00:00.000Z';
  const booking = completedBooking(completedAt, {
    serviceIssues: [{ issueId: 'iss_1', category: 'quality', description: 'x', createdAt: completedAt, status: 'open' }],
  });
  const state = postService.postServiceState(booking, Date.parse(completedAt) + HOUR);
  assert.equal(state.customerResolutionStatus, 'issue_submitted');
  assert.equal(state.serviceIssue.submitted, true);
  assert.equal(state.serviceIssue.count, 1);
});

test('reopening after completion does not hand out a second issue window', () => {
  const completedAt = '2026-08-01T00:00:00.000Z';
  const booking = completedBooking(completedAt);
  const reopened = mutations.reopenAppointment(booking, { reason: 'return visit' }).booking;
  const state = postService.postServiceState(reopened, Date.parse(completedAt) + (60 * HOUR));
  assert.equal(state.completedAt, completedAt);
  assert.equal(state.serviceIssue.windowOpen, false);
});

// ── Admin drawer rendering ─────────────────────────────────────────────────
//
// The new controls are built by string concatenation inside a 200 KB HTML file,
// where a missing field renders as "undefined" rather than failing. These cases
// drive the real page function with the real server projection so a broken
// capability state is caught here and not in the Admin's browser.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { adminOperationalControls } = require('../netlify/functions/admin-ops-jobs');

const ADMIN_OPS = fs.readFileSync(path.join(__dirname, '..', 'admin-ops.html'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `admin-ops.html no longer defines ${name}()`);
  let depth = 0;
  let open = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; open = true; } else if (source[i] === '}') {
      depth -= 1;
      if (open && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

function renderControls(booking) {
  const inline = ADMIN_OPS.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];
  const sandbox = {
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    )),
    drawerControls: adminOperationalControls(booking),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(inline, 'money')}\n${extractFunction(inline, 'operationalControlsHtml')}`, sandbox);
  return vm.runInContext('operationalControlsHtml()', sandbox);
}

test('admin-ops.html inline script parses', () => {
  const blocks = [...ADMIN_OPS.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    assert.doesNotThrow(() => new vm.Script(block));
  }
});

test('every capability state renders real controls with no leaked placeholders', () => {
  const states = {
    unpaid: bookingFixture(),
    partPaid: bookingFixture({ settledCents: 10000, entries: [cashEntry(10000)] }),
    paidAndCompleted: bookingFixture({
      settledCents: 31000,
      entries: [cashEntry(31000)],
      jobStatus: 'completed_paid',
      serviceStatus: 'closed',
      paymentWorkflowStatus: 'cash_paid',
      completedAt: new Date().toISOString(),
    }),
    // A record missing almost everything must degrade, not throw or render junk.
    malformed: { id: 'CD1-EMPTY' },
  };

  for (const [name, booking] of Object.entries(states)) {
    const html = renderControls(booking);
    const doc = new JSDOM(`<div id="root">${html}</div>`).window.document;
    assert.ok(doc.querySelector('#root').children.length > 0, `${name} rendered nothing`);
    assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/, `${name} leaked a placeholder`);
  }
});

test('the drawer offers the method control only when the server allows a change', () => {
  const unpaid = new JSDOM(`<div>${renderControls(bookingFixture())}</div>`).window.document;
  assert.ok(unpaid.querySelector('#dSavePayMethod'), 'unpaid must offer a method change');
  assert.ok(unpaid.querySelector('#dPayMethodReason'), 'a reason field is mandatory');
  assert.equal(unpaid.querySelector('#dCorrectMethodBtn'), null);

  const paid = bookingFixture({ settledCents: 31000, entries: [cashEntry(31000)] });
  const paidDoc = new JSDOM(`<div>${renderControls(paid)}</div>`).window.document;
  assert.equal(paidDoc.querySelector('#dSavePayMethod'), null, 'paid must not offer an ordinary change');
  assert.ok(paidDoc.querySelector('#dCorrectMethodBtn'), 'paid must offer the evidence-backed correction');
  assert.ok(paidDoc.querySelector('#dCorrectEvidence'));
  assert.ok(paidDoc.querySelector('button[disabled]'), 'the blocked action stays visible but disabled');
});

test('a disabled control always carries the server’s reason', () => {
  const unpaid = adminOperationalControls(bookingFixture());
  assert.equal(unpaid.reopen.enabled, false);
  assert.match(unpaid.reopen.explanation, /only a completed, closed or disputed job/i);

  const paid = adminOperationalControls(
    bookingFixture({ settledCents: 31000, entries: [cashEntry(31000)] })
  );
  assert.equal(paid.recordCash.enabled, false);
  assert.match(paid.recordCash.explanation, /no remaining balance/i);
  assert.equal(paid.paymentMethod.canChange, false);
  assert.match(paid.paymentMethod.explanation, /paid in full/i);
});

test('the cash control states the exact amount the server will accept', () => {
  const controls = adminOperationalControls(bookingFixture({ settledCents: 10000, entries: [cashEntry(10000)] }));
  assert.equal(controls.recordCash.enabled, true);
  assert.equal(controls.recordCash.expectedAmountCents, 21000);
  assert.equal(controls.recordCash.partialSupported, false);
  assert.match(controls.recordCash.explanation, /full remaining balance of 210\.00/);
});

test('completing a job twice does not move the completion anchor', () => {
  const first = mutations.adminTechStatus(
    bookingFixture({ jobStatus: 'in_progress', serviceStatus: 'in_progress' }),
    { statusAction: 'complete_service' }
  );
  assert.equal(first.ok, true);
  assert.ok(first.booking.completedAt);

  const second = mutations.adminTechStatus(first.booking, { statusAction: 'complete_service' });
  assert.equal(second.booking.completedAt, first.booking.completedAt);
});
