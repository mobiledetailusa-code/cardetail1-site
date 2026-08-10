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

const RECEIPT_FOOTER = 'Thank you for choosing Detailing Zone.';

function asArray(v) { return Array.isArray(v) ? v : []; }

/**
 * Cash is recognised from whichever marker the settling path left behind:
 * the Blob ledger writes `method`, the Postgres authority writes
 * `providerObjectId: 'cash'`, and both name the actor. A settlement that
 * carries none of them was taken by card.
 */
function settlementMethodLabel(entry) {
  if (!entry) return 'Card';
  const method = String(entry.method || '').toLowerCase();
  if (method === 'cash') return 'Cash';
  if (method) return 'Card';
  if (String(entry.providerObjectId || '').toLowerCase() === 'cash') return 'Cash';
  if (/cash/i.test(String(entry.actor || ''))) return 'Cash';
  return 'Card';
}

function centsToAmount(cents) {
  const n = Math.round(Number(cents) || 0);
  return { cents: n, display: `$${(n / 100).toFixed(2)}` };
}

function dollarsToCents(dollars) {
  return Math.round((Number(dollars) || 0) * 100);
}

function safeProviderReference(value) {
  const text = String(value || '').trim();
  if (!/^(pi|re)_[A-Za-z0-9]+$/.test(text)) return '';
  const prefix = text.slice(0, 3);
  return `${prefix}••••${text.slice(-6)}`;
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : parsed.toISOString().slice(0, 10);
}

/**
 * Settled payments only. Open, creating, failed, cancelled and pending attempts
 * are never counted toward "amount received".
 */
function settledPayments(booking, opts = {}) {
  const out = [];
  const seen = new Set();
  const authoritativeEntries = asArray(opts.ledgerEntries);
  const entries = authoritativeEntries.length
    ? authoritativeEntries
    : asArray(booking && booking.ledger && booking.ledger.entries);

  for (const entry of entries) {
    if (!entry || entry.kind !== 'settlement') continue;
    const cents = Math.round(Number(entry.amountCents != null ? entry.amountCents : entry.cents) || 0);
    if (cents <= 0) continue;
    // Replayed webhooks reuse providerObjectId — count each settlement once.
    const key = String(entry.providerObjectId || entry.entryId || entry.recordedAt || '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({
      date: dateOnly(entry.recordedAt || entry.settledAt),
      amount: centsToAmount(cents),
      method: settlementMethodLabel(entry),
      reference: safeProviderReference(entry.providerObjectId),
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
        date: dateOnly(a.settledAt),
        amount: centsToAmount(cents),
        method: 'Card',
      });
    }
  }

  return out;
}

function refundedPayments(booking, opts = {}) {
  const entries = asArray(opts.ledgerEntries).length
    ? asArray(opts.ledgerEntries)
    : asArray(booking && booking.ledger && booking.ledger.entries);
  return entries
    .filter((entry) => entry && entry.kind === 'refund' && Number(entry.amountCents) > 0)
    .map((entry) => ({
      date: dateOnly(entry.recordedAt || entry.occurredAt),
      amount: centsToAmount(entry.amountCents),
      method: 'Original payment method',
      reference: safeProviderReference(entry.providerObjectId),
    }));
}

/**
 * Truthful payment method type. Brand and last four digits are never captured
 * server-side (they exist only in transient browser checkout state), so the
 * receipt states the method type rather than inventing masked digits.
 */
function paymentMethodLabel(booking, fin, opts = {}) {
  const pwf = String((fin && fin.paymentWorkflowStatus) || (booking && booking.paymentWorkflowStatus) || '').toLowerCase();
  if (pwf === 'cash_paid') return 'Cash';
  const payments = settledPayments(booking, opts);
  if (!payments.length) return '';
  const cash = payments.filter((p) => p.method === 'Cash').length;
  if (cash === payments.length) return 'Cash';
  if (cash === 0) return 'Card';
  // A booking settled across both methods must not claim to be either one.
  return 'Cash and card';
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
function receiptEligibility(booking, opts = {}) {
  const fin = opts.projection || financialProjection(booking) || {};
  const settled = settledPayments(booking, opts);
  const refunds = refundedPayments(booking, opts);
  const totalSettledCents = settled.reduce((s, p) => s + p.amount.cents, 0);
  const compatibilityRefundedCents = Math.max(
    0,
    Math.round(Number(booking?.ledger?.refundedCents) || 0)
  );
  // PostgreSQL projections expose grossSettledCents explicitly. Legacy Blob
  // projections expose only net settledCents, while the compatibility ledger
  // carries refundedCents separately. Reconstruct gross only for that legacy
  // shape so a paid delta is not lost and a refund is not subtracted twice.
  const projectedGrossCents = fin.grossSettledCents != null
    ? Math.max(0, Math.round(Number(fin.grossSettledCents) || 0))
    : Math.max(0, Math.round(Number(fin.settledCents) || 0)) + compatibilityRefundedCents;
  const grossPaidCents = Math.max(projectedGrossCents, totalSettledCents);
  const refundedCents = Math.max(
    Number(fin.refundedCents) || 0,
    compatibilityRefundedCents,
    refunds.reduce((sum, row) => sum + row.amount.cents, 0)
  );
  const paidCents = Math.max(0, grossPaidCents - refundedCents);
  const remaining = Math.max(0, Number(fin.remainingCents) || 0);
  const completed = isServiceCompleted(booking);

  // A technician tip rides on the same PaymentIntent but is deliberately kept
  // out of the invoice: it is ledgered as kind:'fee' with providerEventId
  // tip_<pi>, so it never reaches approvedCents, settledCents or remaining.
  // The customer was still charged it, so the receipt has to say so — matched
  // on the tip_ prefix rather than on kind alone, so a future fee of another
  // nature cannot silently be relabelled as a tip.
  const tipFromLedger = asArray(opts.ledgerEntries)
    .filter((entry) => entry
      && entry.kind === 'fee'
      && String(entry.providerEventId || '').startsWith('tip_'))
    .reduce((sum, entry) => sum + Math.max(0, Math.round(Number(entry.amountCents) || 0)), 0);
  // Blob mirror fallback for bookings read without authoritative ledger rows.
  const tipFromBooking = Math.max(
    0,
    Math.round(Number(booking?.technicianTipCents ?? booking?.tipCents ?? 0) || 0)
  );
  const technicianTipCents = tipFromLedger > 0 ? tipFromLedger : tipFromBooking;

  return {
    payment: grossPaidCents > 0,
    final: completed && remaining === 0 && grossPaidCents > 0,
    completed,
    paidCents,
    grossPaidCents,
    refundedCents,
    remainingCents: remaining,
    approvedCents: Math.max(0, Number(fin.approvedCents) || 0),
    technicianTipCents,
    fin,
    settled,
    refunds,
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

function projectVehicles(booking, { includeMoney = true } = {}) {
  const projected = projectBookingForCustomer(booking) || {};
  return asArray(projected.vehicles).map((v) => {
    const addons = asArray(v.addons)
      .filter((a) => a && a.name)
      .map((a) => {
        const addon = {
          name: String(a.name),
          qty: Number(a.qty) > 0 ? Number(a.qty) : 1,
        };
        if (includeMoney) addon.price = centsToAmount(dollarsToCents(a.price));
        return addon;
      });
    const vehicle = {
      label: String(v.vehicleLabel || [v.year, v.make, v.model].filter(Boolean).join(' ')).trim(),
      package: {
        name: String(v.packageName || v.package || ''),
      },
      addons,
    };
    if (includeMoney) {
      vehicle.package.price = centsToAmount(dollarsToCents(v.basePrice));
      vehicle.subtotal = centsToAmount(dollarsToCents(v.subtotal));
    }
    return vehicle;
  });
}

/**
 * Build the customer-safe receipt. Returns { ok: false, error } when the
 * requested receipt is not yet available — the caller maps that to a safe
 * business-level response, never a 500.
 */
function buildReceiptProjection(booking, requestedType, opts = {}) {
  const type = String(requestedType || '').toLowerCase();
  if (!RECEIPT_TYPES.includes(type)) {
    return { ok: false, error: 'invalid_receipt_type', message: 'Unknown receipt type.', statusCode: 400 };
  }
  if (!booking) {
    return { ok: false, error: 'booking_not_found', message: 'No booking found.', statusCode: 404 };
  }

  const el = receiptEligibility(booking, opts);
  if (!el[type]) {
    return { ok: false, error: 'receipt_unavailable', message: UNAVAILABLE[type], statusCode: 200 };
  }

  const approvedCents = el.approvedCents;
  const quote = opts.quote || null;
  const quoteLines = asArray(quote && quote.items).map((item) => ({
    kind: String(item.kind || 'service').toLowerCase(),
    name: String(item.label || 'Service'),
    amount: centsToAmount(item.amountCents),
  }));
  const hasAuthoritativeLines = !!quote && quoteLines.length > 0;
  // Vehicle labels/package names remain useful customer context, but once the
  // approved PostgreSQL quote is present none of the Blob-stored vehicle prices
  // are returned. Every displayed dollar then comes from QuoteItem or ledger.
  const vehicles = projectVehicles(booking, { includeMoney: !hasAuthoritativeLines });
  const storedLineTotalCents = vehicles.reduce((sum, vehicle) => (
    sum + Math.round(Number(vehicle.subtotal?.cents) || 0)
  ), 0);
  const nonServiceKinds = new Set([
    'travel', 'travel_fee', 'discount', 'offer', 'tax', 'taxes', 'adjustment',
    'adjustment_increase', 'adjustment_decrease', 'credit',
  ]);
  const quoteLineTotalCents = quoteLines.reduce((sum, item) => sum + item.amount.cents, 0);
  const serviceLineTotalCents = hasAuthoritativeLines
    ? quoteLines
      .filter((item) => !nonServiceKinds.has(item.kind))
      .reduce((sum, item) => sum + item.amount.cents, 0)
    : storedLineTotalCents;

  let adjustments;
  if (hasAuthoritativeLines) {
    adjustments = quoteLines
      .filter((item) => nonServiceKinds.has(item.kind))
      .map((item) => ({ name: item.name, amount: item.amount }));
    // A malformed historical quote must never be silently forced to match.
    const residual = approvedCents - quoteLineTotalCents;
    if (residual !== 0) {
      adjustments.push({ name: 'Approved quote residual', amount: centsToAmount(residual) });
    }
  } else {
    const travelCents = dollarsToCents(booking.travelFeeAmount ?? booking.zoneSurcharge ?? 0);
    const discountCents = dollarsToCents(booking.discountAmount ?? booking.offer?.discountAmount ?? 0);
    const taxCents = Math.round(Number(booking.taxCents) || dollarsToCents(booking.taxAmount || 0));
    adjustments = [];
    if (travelCents) adjustments.push({ name: 'Travel fee', amount: centsToAmount(travelCents) });
    if (discountCents) adjustments.push({ name: 'Discount', amount: centsToAmount(-discountCents) });
    if (taxCents) adjustments.push({ name: 'Taxes', amount: centsToAmount(taxCents) });
    const namedCents = travelCents - discountCents + taxCents;
    const adjustmentCents = approvedCents - storedLineTotalCents - namedCents;
    if (vehicles.length && adjustmentCents !== 0) {
      adjustments.push({ name: 'Approved price adjustment', amount: centsToAmount(adjustmentCents) });
    }
  }

  const anchor = el.settled.length || el.refunds.length
    ? [...el.settled, ...el.refunds].map((p) => `${p.date}:${p.amount.cents}:${p.reference || ''}`).join(',')
    : String(el.grossPaidCents);

  const projectedBooking = projectBookingForCustomer(booking) || {};
  const receiptId = receiptNumber(booking.id || booking.bookingId, type, anchor);
  const lastPayment = el.settled[el.settled.length - 1] || null;

  return {
    ok: true,
    receipt: {
      receiptType: type,
      receiptNumber: receiptId,
      receiptId,
      bookingReference: String(booking.id || booking.bookingId || ''),
      business: { ...BUSINESS },
      customer: {
        name: [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim() || 'Customer',
      },
      serviceAddress: type === 'final' ? String(booking.address || booking.serviceLocation || '') : '',
      serviceDate: String(booking.confirmedDate || booking.preferredDate || '').slice(0, 10),
      completionDate: type === 'final' ? String(booking.completedAt || '').slice(0, 10) : '',
      vehicles,
      quoteVersion: Number(quote?.quoteVersion || el.fin.quoteVersion || 0) || null,
      lineItems: quoteLines,
      adjustments,
      financialSummary: {
        approvedTotal: centsToAmount(approvedCents),
        amountPaid: centsToAmount(el.grossPaidCents),
        amountRefunded: centsToAmount(el.refundedCents),
        netPaid: centsToAmount(el.paidCents),
        remainingBalance: centsToAmount(el.remainingCents),
        creditDue: centsToAmount(el.fin.outstandingCreditCents),
        refundPending: centsToAmount(el.fin.pendingRefundCents),
        serviceLinesTotal: centsToAmount(serviceLineTotalCents),
        // Charged on the same card, held outside the invoice. Shown separately
        // so approvedTotal + technicianTip is what actually left the customer's
        // account — otherwise the receipt understates the charge.
        technicianTip: centsToAmount(el.technicianTipCents),
        totalCharged: centsToAmount(el.grossPaidCents + el.technicianTipCents),
      },
      payments: el.settled,
      refunds: el.refunds,
      paymentMethod: paymentMethodLabel(booking, el.fin, opts),
      paymentDate: lastPayment ? lastPayment.date : '',
      status: el.refundedCents >= el.grossPaidCents && el.grossPaidCents > 0
        ? 'Refunded'
        : (el.remainingCents > 0 ? 'Partially Paid' : 'Paid'),
      // Never let a receipt for a part-payment read as settled.
      balanceStatus: Number(el.fin.pendingRefundCents) > 0
        ? 'Refund pending'
        : (Number(el.fin.outstandingCreditCents) > 0
          ? 'Credit/refund due'
          : (el.remainingCents > 0 ? 'Balance outstanding' : 'Paid in full')),
      paidInFull: el.remainingCents === 0,
      footer: RECEIPT_FOOTER,
      terms: 'Payments and refunds are recorded only after provider confirmation.',
      issuedAt: dateOnly(quote?.updatedAt || projectedBooking.updatedAt || booking.updatedAt || lastPayment?.date),
    },
  };
}

module.exports = {
  BUSINESS,
  RECEIPT_TYPES,
  RECEIPT_FOOTER,
  UNAVAILABLE,
  settlementMethodLabel,
  settledPayments,
  refundedPayments,
  safeProviderReference,
  paymentMethodLabel,
  isServiceCompleted,
  receiptEligibility,
  receiptNumber,
  buildReceiptProjection,
};
