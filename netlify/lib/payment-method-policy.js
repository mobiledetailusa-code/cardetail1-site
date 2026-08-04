/**
 * Payment-method change policy.
 *
 * The rule this module exists to enforce: a method change is a statement about
 * money that has *not* been collected yet. Money already settled carries the
 * method it was actually taken with, forever. Nothing here rewrites a ledger
 * entry to make a screen look tidy — a genuinely mis-keyed method goes through
 * the correction path, which records evidence alongside the original instead of
 * replacing it.
 *
 * Scope is derived from the ledger, never from a status flag:
 *
 *   settled == 0            → `intended`        (free choice, nothing collected)
 *   0 < settled, remaining>0→ `remaining_only`  (history frozen, remainder open)
 *   remaining == 0, settled>0 → locked          (correction workflow only)
 */

const { financialProjection } = require('./payment-service');

const SUPPORTED_METHODS = ['cash_on_site', 'card_on_site', 'online_after_service', 'card_on_file'];

const METHOD_LABELS = Object.freeze({
  cash_on_site: 'Cash on site',
  card_on_site: 'Card on site',
  online_after_service: 'Online after service',
  card_on_file: 'Card on file',
});

const LOCKED_MESSAGE =
  'This appointment is paid in full. The method recorded against a completed payment cannot be changed here — use Correct recorded payment method with supporting evidence.';

const NO_BALANCE_MESSAGE =
  'There is no remaining balance to collect, so there is no payment method left to choose.';

function normalizeMethod(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * What the Admin UI is allowed to offer for this booking right now.
 * Returned verbatim to the client so a button can never claim a capability the
 * server would reject.
 */
function paymentMethodCapability(booking, opts = {}) {
  const projection = opts.authoritativeProjection || financialProjection(booking);
  const settledCents = Math.max(0, Math.round(Number(projection.settledCents) || 0));
  const remainingCents = Math.max(0, Math.round(Number(projection.remainingCents) || 0));
  const current = normalizeMethod(booking && booking.paymentMethodPreference);

  if (settledCents > 0 && remainingCents === 0) {
    return {
      canChange: false,
      scope: 'locked',
      reasonCode: 'paid_in_full',
      explanation: LOCKED_MESSAGE,
      correctionAvailable: true,
      currentMethod: current,
      settledCents,
      remainingCents,
    };
  }
  if (settledCents === 0 && remainingCents === 0) {
    return {
      canChange: false,
      scope: 'none',
      reasonCode: 'no_balance',
      explanation: NO_BALANCE_MESSAGE,
      correctionAvailable: false,
      currentMethod: current,
      settledCents,
      remainingCents,
    };
  }
  const partial = settledCents > 0;
  return {
    canChange: true,
    scope: partial ? 'remaining_only' : 'intended',
    reasonCode: partial ? 'partial_payment' : 'no_payment_recorded',
    explanation: partial
      ? 'Payments already recorded keep the method they were taken with. This changes the method intended for the remaining balance only.'
      : 'No payment has been recorded yet, so the intended method can be changed freely.',
    correctionAvailable: true,
    currentMethod: current,
    settledCents,
    remainingCents,
    supportedMethods: SUPPORTED_METHODS,
  };
}

/**
 * Validate a requested change. Returns the patch to apply — never a mutation.
 * `expectedBookingVersion` is required so two Admins cannot both "win" a change
 * against the same revision.
 */
function resolvePaymentMethodChange(booking, body = {}, opts = {}) {
  const method = normalizeMethod(body.paymentMethodPreference || body.method);
  const reason = String(body.reason || '').trim();
  const actor = String(body.actorId || opts.actorId || 'admin').trim() || 'admin';

  if (!SUPPORTED_METHODS.includes(method)) {
    return { ok: false, error: 'invalid_preference', statusCode: 400, supportedMethods: SUPPORTED_METHODS };
  }
  if (!reason) {
    return { ok: false, error: 'reason_required', statusCode: 400 };
  }

  const expected = body.expectedBookingVersion;
  if (expected == null || expected === '') {
    return { ok: false, error: 'expected_version_required', statusCode: 400 };
  }
  const expectedVersion = Math.round(Number(expected));
  const actualVersion = Math.round(Number(booking && booking.bookingVersion) || 0);
  if (!Number.isFinite(expectedVersion) || expectedVersion !== actualVersion) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: expectedVersion,
      actualBookingVersion: actualVersion,
    };
  }

  const capability = paymentMethodCapability(booking, opts);
  if (!capability.canChange) {
    return {
      ok: false,
      error: capability.scope === 'locked' ? 'payment_method_locked' : 'no_remaining_balance',
      statusCode: 409,
      message: capability.explanation,
      capability,
    };
  }

  const now = new Date().toISOString();
  const previous = capability.currentMethod;
  const history = Array.isArray(booking && booking.paymentMethodHistory)
    ? booking.paymentMethodHistory
    : [];

  return {
    ok: true,
    capability,
    method,
    scope: capability.scope,
    patch: {
      paymentMethodPreference: method,
      // Explicit: this is what we intend to collect the *remaining* balance with.
      remainingBalanceMethod: method,
      paymentPreferenceUpdatedAt: now,
      paymentPreferenceUpdatedBy: actor,
      paymentPreferenceUpdateReason: reason.slice(0, 500),
      paymentMethodHistory: [
        ...history,
        {
          from: previous || null,
          to: method,
          scope: capability.scope,
          reason: reason.slice(0, 500),
          actor,
          settledCentsAtChange: capability.settledCents,
          remainingCentsAtChange: capability.remainingCents,
          at: now,
        },
      ].slice(-50),
    },
  };
}

/**
 * Correction path for a method that was recorded incorrectly against money that
 * is already settled. It appends evidence; it never edits the settled entry.
 */
function resolvePaymentMethodCorrection(booking, body = {}, opts = {}) {
  const method = normalizeMethod(body.correctedMethod || body.method);
  const reason = String(body.reason || '').trim();
  const evidence = String(body.evidence || '').trim();
  const actor = String(body.actorId || opts.actorId || 'admin').trim() || 'admin';

  if (!SUPPORTED_METHODS.includes(method)) {
    return { ok: false, error: 'invalid_preference', statusCode: 400, supportedMethods: SUPPORTED_METHODS };
  }
  if (!reason) return { ok: false, error: 'reason_required', statusCode: 400 };
  if (evidence.length < 10) {
    return {
      ok: false,
      error: 'evidence_required',
      statusCode: 400,
      message: 'Record what proves the original method was wrong (receipt number, deposit reference, or ticket).',
    };
  }

  const expected = body.expectedBookingVersion;
  if (expected == null || expected === '') {
    return { ok: false, error: 'expected_version_required', statusCode: 400 };
  }
  const expectedVersion = Math.round(Number(expected));
  const actualVersion = Math.round(Number(booking && booking.bookingVersion) || 0);
  if (!Number.isFinite(expectedVersion) || expectedVersion !== actualVersion) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: expectedVersion,
      actualBookingVersion: actualVersion,
    };
  }

  const projection = opts.authoritativeProjection || financialProjection(booking);
  const now = new Date().toISOString();
  const corrections = Array.isArray(booking && booking.paymentMethodCorrections)
    ? booking.paymentMethodCorrections
    : [];

  return {
    ok: true,
    method,
    patch: {
      // Original ledger entries are untouched by design; this is an overlay that
      // Admin sees alongside them, with the evidence that justified it.
      paymentMethodCorrections: [
        ...corrections,
        {
          correctionId: `pmc_${Date.now().toString(36)}`,
          recordedMethod: normalizeMethod(booking && booking.paymentMethodPreference),
          correctedMethod: method,
          reason: reason.slice(0, 500),
          evidence: evidence.slice(0, 1000),
          actor,
          settledCentsAtCorrection: Math.max(0, Math.round(Number(projection.settledCents) || 0)),
          at: now,
        },
      ].slice(-50),
      paymentMethodCorrectedAt: now,
      paymentMethodCorrectedBy: actor,
    },
  };
}

module.exports = {
  SUPPORTED_METHODS,
  METHOD_LABELS,
  LOCKED_MESSAGE,
  NO_BALANCE_MESSAGE,
  normalizeMethod,
  paymentMethodCapability,
  resolvePaymentMethodChange,
  resolvePaymentMethodCorrection,
};
