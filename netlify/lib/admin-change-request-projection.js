/**
 * Admin-facing change-request projection.
 * Booking.changeRequests is authority; blob index is a rebuildable cache.
 */

const { asArray, dollarsToCents } = require('./historical-adapter');

const OPEN_STATUSES = new Set([
  'pending',
  'pending_approval',
  'needs_clarification',
  'awaiting_admin',
]);

function isOpenStatus(status) {
  return OPEN_STATUSES.has(String(status || '').toLowerCase());
}

function moneyFromCents(cents) {
  if (cents == null || cents === '') return null;
  const n = Math.round(Number(cents));
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/**
 * Normalize one change request for Admin UI (appointment + global tab).
 */
function projectChangeRequestForAdmin(raw, booking = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const requestId = String(raw.requestId || raw.id || '').trim();
  if (!requestId) return null;
  const requestType = String(raw.requestType || raw.type || '').trim();
  const status = String(raw.status || 'pending').trim();
  const delta = (raw.delta && typeof raw.delta === 'object') ? raw.delta : {};
  const target = (raw.target && typeof raw.target === 'object') ? raw.target : {};
  const previousState = (raw.previousState && typeof raw.previousState === 'object')
    ? raw.previousState
    : {};
  const requestedState = (raw.requestedState && typeof raw.requestedState === 'object')
    ? raw.requestedState
    : { ...delta, target };

  const vehicleSnapshot = requestedState.vehicleSnapshot
    || delta.vehicleSnapshot
    || previousState.vehicle
    || {};
  const vehicleId = String(
    target.vehicleId
    || requestedState.target?.vehicleId
    || vehicleSnapshot.vehicleId
    || ''
  ).trim();

  const proposedApprovedCents = raw.proposedApprovedCents != null
    ? Math.round(Number(raw.proposedApprovedCents))
    : (requestedState.proposedApprovedCents != null
      ? Math.round(Number(requestedState.proposedApprovedCents))
      : (requestedState.proposedTotal != null
        ? dollarsToCents(requestedState.proposedTotal)
        : null));

  const currentApprovedCents = requestedState.currentApprovedCents != null
    ? Math.round(Number(requestedState.currentApprovedCents))
    : (delta.currentApprovedCents != null
      ? Math.round(Number(delta.currentApprovedCents))
      : Math.round(Number(booking.ledger?.approvedCents)
        || dollarsToCents(booking.approvedFinalAmount || booking.totalPrice || 0)
        || 0));

  const settledCents = Math.max(0, Math.round(Number(booking.ledger?.settledCents) || 0));
  const paymentImpact = settledCents > 0
    ? 'payment_adjustment_required'
    : 'none';

  const enrichedPrevious = {
    ...previousState,
    bookingVersion: previousState.bookingVersion != null
      ? previousState.bookingVersion
      : (raw.baseBookingVersion != null ? raw.baseBookingVersion : booking.bookingVersion),
    vehicle: previousState.vehicle || vehicleSnapshot,
    vehicleSubtotal: previousState.vehicleSubtotal != null
      ? previousState.vehicleSubtotal
      : vehicleSnapshot.subtotal,
    packageName: previousState.packageName || vehicleSnapshot.packageName,
    addons: previousState.addons || vehicleSnapshot.addons || [],
    approvedFinalAmount: previousState.approvedFinalAmount != null
      ? previousState.approvedFinalAmount
      : moneyFromCents(currentApprovedCents),
    paidAmount: previousState.paidAmount != null
      ? previousState.paidAmount
      : moneyFromCents(settledCents),
    remainingBalance: previousState.remainingBalance != null
      ? previousState.remainingBalance
      : moneyFromCents(Math.max(0, currentApprovedCents - settledCents)),
  };

  const enrichedRequested = {
    ...requestedState,
    target: { ...target, vehicleId: vehicleId || target.vehicleId },
    vehicleSnapshot,
    proposedTotal: requestedState.proposedTotal != null
      ? requestedState.proposedTotal
      : moneyFromCents(proposedApprovedCents),
    proposedApprovedCents,
    currentApprovedCents,
    priceDifference: requestedState.priceDifference != null
      ? requestedState.priceDifference
      : (proposedApprovedCents != null
        ? moneyFromCents(proposedApprovedCents - currentApprovedCents)
        : null),
    paymentImpact,
  };

  return {
    id: requestId,
    requestId,
    bookingId: String(raw.bookingId || booking.id || booking.bookingId || '').trim(),
    requestType,
    type: requestType,
    typeLabel: null,
    status,
    createdAt: raw.createdAt || raw.submittedAt || '',
    submittedAt: raw.submittedAt || raw.createdAt || '',
    submittedBy: raw.submittedBy || raw.authorizedRef || 'customer',
    customerIdentity: raw.submittedBy || raw.authorizedRef || 'customer',
    target: { vehicleId: vehicleId || undefined, ...target },
    vehicleId: vehicleId || null,
    expectedBookingVersion: raw.baseBookingVersion != null
      ? raw.baseBookingVersion
      : (raw.embeddedBookingVersion != null ? raw.embeddedBookingVersion - 1 : null),
    baseBookingVersion: raw.baseBookingVersion ?? null,
    embeddedBookingVersion: raw.embeddedBookingVersion ?? null,
    quoteVersion: raw.quoteVersion ?? null,
    proposedApprovedCents,
    previousState: enrichedPrevious,
    requestedState: enrichedRequested,
    delta,
    paymentImpact,
    customerVisibleResult: raw.customerVisibleResult || '',
    adminNote: raw.adminNote || '',
    shortId: requestId.length > 12 ? `${requestId.slice(0, 8)}…` : requestId,
  };
}

function projectChangeRequestsForAdmin(booking) {
  const list = asArray(booking?.changeRequests)
    .map((r) => projectChangeRequestForAdmin(r, booking))
    .filter(Boolean);
  const pending = list.filter((r) => isOpenStatus(r.status));
  return {
    changeRequests: list,
    pendingChangeRequests: pending,
    pendingChangeRequestCount: pending.length,
    customerChangePending: pending.length > 0 || !!booking?.customerChangePending,
  };
}

/**
 * Merge blob-index rows with booking-authority rows (booking wins on status).
 */
function mergeAdminRequestLists(indexRows, bookingRows) {
  const byId = new Map();
  for (const r of asArray(indexRows)) {
    const id = String(r?.id || r?.requestId || '').trim();
    if (!id) continue;
    byId.set(id, { ...r, id, requestId: id });
  }
  for (const r of asArray(bookingRows)) {
    const id = String(r?.id || r?.requestId || '').trim();
    if (!id) continue;
    const prev = byId.get(id) || {};
    byId.set(id, {
      ...prev,
      ...r,
      id,
      requestId: id,
      previousState: r.previousState || prev.previousState,
      requestedState: r.requestedState || prev.requestedState,
    });
  }
  return [...byId.values()];
}

module.exports = {
  OPEN_STATUSES,
  isOpenStatus,
  projectChangeRequestForAdmin,
  projectChangeRequestsForAdmin,
  mergeAdminRequestLists,
};
