/**
 * Customer receipt projection.
 *
 * Read-only. This module never mutates a booking, never touches Stripe and never
 * re-prices from the live catalog — every money figure comes from
 * financialProjection() and every service line from the booking's own stored
 * vehicle records, so a historical receipt cannot drift when the catalog changes.
 *
 * Output is an explicit allowlist. financialProjection() carries Stripe ids, so
 * this module must never spread it into a response.
 */

const crypto = require('crypto');

const { financialProjection } = require('./payment-service');
const { projectBookingForCustomer } = require('./ops-schema');
const { normalizeBookingId } = require('./booking-customer-auth');

const BUSINESS = Object.freeze({
  name: 'Detailing Zone L.L.C.',
  phone: '551-313-2956',
  site: 'cardetail1.com',
});

const RECEIPT_TYPES = Object.freeze(['payment', 'final']);

const UNAVAILABLE = Object.freeze({
  payment: 'A payment receipt is available once a payment has been received.',
  final: 'The final receipt is available once the service is completed and the balance is paid in full.',
});

function asArray(v) { return Array.isArray(v) ? v : []; }

function centsToAmount(cents) {
  const n = Math.round(Number(cents) || 0);
  return { cents: n, display: `$${(n / 100).toFixed(2)}` };
}

function dollarsToCents(dollars) {
  return Math.round((Number(dollars) || 0) * 100);
}

/**
 * Settled payments only. Open, creating, failed, cancelled and pending attempts
 * are never counted toward "amount received".
 */
function settledPayments(booking) {
  const out = [];
  const seen = new Set();

  for (const entry of asArray(booking && booking.ledger && booking.ledger.entries)) {
    if (!entry || entry.kind !== 'settlement') continue;
    const cents = Math.round(Number(entry.amountCents != null ? entry.amountCents : entry.cents) || 0);
    if (cents <= 0) continue;
    // Replayed webhooks reuse providerObjectId — count each settlement once.
    const key = String(entry.providerObjectId || entry.entryId || entry.recordedAt || '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({
      date: String(entry.recordedAt || entry.settledAt || '').slice(0, 10),
      amount: centsToAmount(cents),
      method: entry.method === 'cash' ? 'Cash' : 'Card',
    });
  }

  if (!out.length) {
    for (const a of asArray(booking && booking.paymentAttempts)) {
      if (!a || a.status !== 'settled') continue;
      const cents = Math.round(Number(a.amountCents != null ? a.amountCents : a.cents) || 0);
      if (cents <= 0) continue;
      const key = String(a.providerObjectId || a.attemptId || '');
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push({
        date: String(a.settledAt || '').slice(0, 10),
        amount: centsToAmount(cents),
        method: 'Card',
      });
    }
  }

  return out;
}

/**
 * Truthful payment method type. Brand and last four digits are never captured
 * server-side (they exist only in transient browser checkout state), so the
 * receipt states the method type rather than inventing masked digits.
 */
function paymentMethodLabel(booking, fin) {
  const pwf = String((fin && fin.paymentWorkflowStatus) || (booking && booking.paymentWorkflowStatus) || '').toLowerCase();
  if (pwf === 'cash_paid') return 'Cash';
  const payments = settledPayments(booking);
  if (payments.length && payments.every((p) => p.method === 'Cash')) return 'Cash';
  if (payments.length) return 'Card';
  return '';
}

function isServiceCompleted(booking) {
  if (!booking) return false;
  if (booking.completedAt) return true;
  const js = String(booking.jobStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  return js === 'completed' || js === 'completed_paid' || st === 'completed';
}

/**
 * Eligibility is derived server-side only. The browser never decides whether a
 * receipt exists.
 */
function receiptEligibility(booking) {
  const fin = financialProjection(booking) || {};
  const settled = settledPayments(booking);
  const totalSettledCents = settled.reduce((s, p) => s + p.amount.cents, 0);
  const paidCents = Math.max(Number(fin.settledCents) || 0, totalSettledCents);
  const remaining = Math.max(0, Number(fin.remainingCents) || 0);
  const completed = isServiceCompleted(booking);

  return {
    payment: paidCents > 0,
    final: completed && remaining === 0 && paidCents > 0,
    completed,
    paidCents,
    remainingCents: remaining,
    approvedCents: Math.max(0, Number(fin.approvedCents) || 0),
    fin,
    settled,
  };
}

/**
 * Deterministic receipt number — stable across refreshes and concurrent first
 * access without persisting anything, so no duplicate snapshot can ever be
 * created. Derived from booking id, receipt type and a settlement anchor.
 */
function receiptNumber(bookingId, type, anchor) {
  const id = normalizeBookingId(bookingId) || 'UNKNOWN';
  const digest = crypto
    .createHash('sha256')
    .update(`${id}|${type}|${anchor || ''}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `${type === 'final' ? 'FR' : 'PR'}-${id}-${digest}`;
}

function projectVehicles(booking) {
  const projected = projectBookingForCustomer(booking) || {};
  return asArray(projected.vehicles).map((v) => {
    const addons = asArray(v.addons)
      .filter((a) => a && a.name)
      .map((a) => ({
        name: String(a.name),
        qty: Number(a.qty) > 0 ? Number(a.qty) : 1,
        price: centsToAmount(dollarsToCents(a.price)),
      }));
    return {
      vehicleId: String(v.vehicleId || ''),
      label: String(v.vehicleLabel || [v.year, v.make, v.model].filter(Boolean).join(' ')).trim(),
      package: {
        name: String(v.packageName || v.package || ''),
        price: centsToAmount(dollarsToCents(v.basePrice)),
      },
      addons,
      subtotal: centsToAmount(dollarsToCents(v.subtotal)),
    };
  });
}

/**
 * Build the customer-safe receipt. Returns { ok: false, error } when the
 * requested receipt is not yet available — the caller maps that to a safe
 * business-level response, never a 500.
 */
function buildReceiptProjection(booking, requestedType) {
  const type = String(requestedType || '').toLowerCase();
  if (!RECEIPT_TYPES.includes(type)) {
    return { ok: false, error: 'invalid_receipt_type', message: 'Unknown receipt type.', statusCode: 400 };
  }
  if (!booking) {
    return { ok: false, error: 'booking_not_found', message: 'No booking found.', statusCode: 404 };
  }

  const el = receiptEligibility(booking);
  if (!el[type]) {
    return { ok: false, error: 'receipt_unavailable', message: UNAVAILABLE[type], statusCode: 200 };
  }

  const vehicles = projectVehicles(booking);
  const lineTotalCents = vehicles.reduce((s, v) => s + v.subtotal.cents, 0);
  const approvedCents = el.approvedCents;

  // Never force the total to match. When the authoritative approved total differs
  // from the sum of service lines (legitimate historical adjustments, travel fees,
  // taxes), surface the difference as a named line instead of hiding it.
  const adjustmentCents = approvedCents - lineTotalCents;
  const adjustments = (vehicles.length && adjustmentCents !== 0)
    ? [{ name: 'Adjustments, fees and taxes', amount: centsToAmount(adjustmentCents) }]
    : [];

  const anchor = el.settled.length
    ? el.settled.map((p) => `${p.date}:${p.amount.cents}`).join(',')
    : String(el.paidCents);

  const projectedBooking = projectBookingForCustomer(booking) || {};

  return {
    ok: true,
    receipt: {
      receiptType: type,
      receiptNumber: receiptNumber(booking.id || booking.bookingId, type, anchor),
      bookingReference: String(booking.id || booking.bookingId || ''),
      business: { ...BUSINESS },
      customer: {
        name: [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim() || 'Customer',
      },
      serviceAddress: type === 'final' ? String(booking.address || booking.serviceLocation || '') : '',
      serviceDate: String(booking.confirmedDate || booking.preferredDate || '').slice(0, 10),
      completionDate: type === 'final' ? String(booking.completedAt || '').slice(0, 10) : '',
      vehicles,
      adjustments,
      financialSummary: {
        approvedTotal: centsToAmount(approvedCents),
        amountPaid: centsToAmount(el.paidCents),
        remainingBalance: centsToAmount(el.remainingCents),
        serviceLinesTotal: centsToAmount(lineTotalCents),
      },
      payments: el.settled,
      paymentMethod: paymentMethodLabel(booking, el.fin),
      status: type === 'final' ? 'Paid · Service completed' : 'Payment received',
      issuedAt: String(projectedBooking.updatedAt || booking.updatedAt || '').slice(0, 10),
    },
  };
}

module.exports = {
  BUSINESS,
  RECEIPT_TYPES,
  UNAVAILABLE,
  settledPayments,
  paymentMethodLabel,
  isServiceCompleted,
  receiptEligibility,
  receiptNumber,
  buildReceiptProjection,
};
