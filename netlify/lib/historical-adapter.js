/**
 * Non-destructive historical-read adapter for schemaVersion 0 / legacy records.
 */

const CURRENT_SCHEMA_VERSION = 1;

const LEGACY_PAID_CLOSED = new Set(['paid', 'closed']);

function asArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function dollarsToCents(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

function centsToDollars(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

function normalizeId(booking) {
  return String(booking.id || booking.bookingId || '').trim();
}

function normalizePhone(booking) {
  return String(
    booking.phone || booking.customerPhone || booking.phoneNumber || ''
  ).trim();
}

function isLegacyPaidOrClosed(booking) {
  const status = String(booking.status || '').trim().toLowerCase();
  const paymentStatus = String(booking.paymentStatus || '').trim().toLowerCase();
  const jobStatus = String(booking.jobStatus || '').trim().toLowerCase();
  if (LEGACY_PAID_CLOSED.has(status)) return true;
  if (status === 'closed') return true;
  if (paymentStatus === 'paid' && !booking.approvedFinalAmount && booking.amountPaid == null) {
    // Ambiguous modern unpaid with paymentStatus paid is handled elsewhere;
    // legacy Paid display status is covered by status check.
  }
  if (jobStatus === 'completed_paid') return true;
  if (String(booking.status || '') === 'Closed') return true;
  if (String(booking.status || '') === 'Paid') return true;
  return LEGACY_PAID_CLOSED.has(status);
}

/**
 * Adapt a raw blob record for safe reads. Never mutates the original blob authority.
 * Returns { ok, booking, quarantined, reason }.
 */
function adaptHistoricalBooking(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, quarantined: true, reason: 'not_an_object', booking: null };
  }

  try {
    const schemaVersion = Number(raw.schemaVersion);
    const version = Number.isFinite(schemaVersion) ? schemaVersion : 0;

    const booking = { ...raw };
    booking.schemaVersion = version === 0 ? 0 : version;
    booking.id = normalizeId(raw) || raw.id;
    if (!booking.bookingId && booking.id) booking.bookingId = booking.id;
    booking.phone = normalizePhone(raw) || booking.phone;

    booking.vehicles = asArray(raw.vehicles);
    booking.addons = asArray(raw.addons);
    booking.eventLog = asArray(raw.eventLog);
    booking.changeRequests = asArray(raw.changeRequests);
    booking.paymentAttempts = asArray(raw.paymentAttempts);

    const paidOrClosed = isLegacyPaidOrClosed(raw);
    if (paidOrClosed) {
      booking.jobStatus = 'completed_paid';
      booking.status = 'Paid';
      booking.appointmentStatus = booking.appointmentStatus || 'completed';
      booking.paymentWorkflowStatus = 'payment_succeeded';
      booking.paymentStatus = 'paid';
      booking._historicalPaidClosed = true;

      const approvedCents = resolveApprovedCents(raw);
      const settledHint = dollarsToCents(raw.amountPaid || raw.paidAmount);
      const settledCents = settledHint > 0 ? settledHint : approvedCents;
      booking.ledger = {
        currency: 'usd',
        approvedCents,
        settledCents,
        creditedCents: Number(raw.ledger?.creditedCents) || 0,
        pendingCents: 0,
        entries: asArray(raw.ledger?.entries),
      };
      // Compatibility projections: zero payable
      booking.amountPaid = centsToDollars(settledCents);
      booking.paidAmount = booking.amountPaid;
      booking.approvedFinalAmount = centsToDollars(approvedCents);
      booking.totalPrice = booking.approvedFinalAmount;
      booking.amountDueApproved = 0;
      booking.balanceDue = 0;
    }

    return { ok: true, quarantined: false, booking, reason: null };
  } catch (err) {
    return {
      ok: false,
      quarantined: true,
      reason: err && err.message ? err.message : 'adapt_failed',
      booking: null,
    };
  }
}

function resolveApprovedCents(raw) {
  if (raw.ledger && raw.ledger.approvedCents != null) {
    return Math.max(0, Math.round(Number(raw.ledger.approvedCents) || 0));
  }
  const dollars = Number(
    raw.approvedFinalAmount != null
      ? raw.approvedFinalAmount
      : (raw.totalPrice != null ? raw.totalPrice : (raw.finalAmount || 0))
  );
  return dollarsToCents(dollars);
}

function adaptMany(records) {
  const out = [];
  const quarantined = [];
  for (const raw of records || []) {
    const adapted = adaptHistoricalBooking(raw);
    if (adapted.ok && adapted.booking) out.push(adapted.booking);
    else quarantined.push({ reason: adapted.reason, id: raw && (raw.id || raw.bookingId) });
  }
  return { bookings: out, quarantined };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  asArray,
  dollarsToCents,
  centsToDollars,
  isLegacyPaidOrClosed,
  adaptHistoricalBooking,
  adaptMany,
  resolveApprovedCents,
};
