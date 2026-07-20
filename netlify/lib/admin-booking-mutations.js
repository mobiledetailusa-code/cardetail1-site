// Admin booking mutations — server-authoritative pricing, lifecycle, audit helpers.
const crypto = require('crypto');
const { sanitizeText } = require('./tech-security');
const { appendEventLog } = require('./ops-workflow');
const { applyServerTravelAndTotal } = require('./travel-fee');
const { validateAndRecalculateBookingPricing } = require('./booking-price-catalog');
const {
  syncLegacyFields,
  canTransitionService,
  normalizeServiceStatus,
  evaluateTechAdjustment,
  getApprovedAmountCents,
} = require('./operations-lifecycle');
const { applyServerOffersToBooking } = require('./booking-offers');
const { createCompletionLink, buildCompletionUrl } = require('./customer-completion-link');
const { normalizePhone } = require('./ops-db');

function generateId() {
  return 'CD1-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function newUniqueId(store) {
  for (let i = 0; i < 5; i++) {
    const id = generateId();
    const existing = await store.get(id, { type: 'json' }).catch(() => null);
    if (!existing) return id;
  }
  return generateId();
}

function isQaFixture(body) {
  return body.qaFixture === true || String(body.id || '').startsWith('QA-OPSCORE');
}

async function createAdminAppointment(store, body) {
  const firstName = sanitizeText(body.firstName, 80);
  const phone = normalizePhone(body.phone || '');
  const zipCode = String(body.zipCode || body.zip || '').replace(/\D/g, '').slice(0, 5);
  if (!firstName || phone.length < 7) return { ok: false, error: 'customer_required' };
  if (zipCode.length < 5) return { ok: false, error: 'zip_required' };

  const now = new Date().toISOString();
  const id = body.qaFixture === true && body.id
    ? sanitizeText(body.id, 48)
    : await newUniqueId(store);

  const draft = {
    firstName,
    lastName: sanitizeText(body.lastName, 80),
    phone,
    email: sanitizeText(body.email, 120),
    address: sanitizeText(body.address, 300),
    zipCode,
    vehicleCategory: sanitizeText(body.vehicleCategory || 'cars', 32),
    packageId: sanitizeText(body.packageId || body.pkgId, 32),
    package: sanitizeText(body.package, 120),
    vehicle: sanitizeText(body.vehicle, 120),
    vehicleLabel: sanitizeText(body.vehicleLabel, 120),
    vehicleTier: sanitizeText(body.vehicleTier, 80),
    vehicles: Array.isArray(body.vehicles) ? body.vehicles : [],
    preferredDate: sanitizeText(body.preferredDate, 32),
    preferredTime: sanitizeText(body.preferredTime, 64),
    addons: Array.isArray(body.addons) ? body.addons : [],
    paymentMethodPreference: sanitizeText(body.paymentMethodPreference, 64) || 'cash_onsite',
    qaFixture: body.qaFixture === true,
    createdByAdmin: true,
  };

  const travel = applyServerTravelAndTotal(draft, { skipMismatchCheck: true });
  if (!travel.ok) return { ok: false, error: travel.error || 'invalid_booking' };

  await applyServerOffersToBooking(draft, {
    serviceSubtotal: travel.serviceSubtotal,
    travelFee: draft.travelFeeAmount || 0,
    sourceTrigger: 'admin_create',
  }).catch(() => null);

  const booking = syncLegacyFields({
    ...draft,
    id,
    isDraft: false,
    kind: 'booking',
    createdAt: now,
    updatedAt: now,
    finalizedAt: now,
    portalReleasedAt: now,
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    serviceStatus: 'under_review',
    paymentStatus: 'not_due',
    customerApprovalStatus: 'not_required',
    cardOnFileRequired: false,
    cardOnFileStatus: 'waived_admin',
    paymentWorkflowStatus: 'no_payment_required_yet',
    adminCreated: true,
    bookingVersion: Math.max(1, Math.round(Number(draft.bookingVersion) || 1)),
    schemaVersion: 1,
    eventLog: [{ action: 'admin_create_appointment', by: 'admin', at: now }],
  });

  await store.setJSON(id, booking);
  return { ok: true, bookingId: id, booking };
}

function updateCustomerContact(booking, body) {
  const now = new Date().toISOString();
  const patched = {
    ...booking,
    ...(body.firstName != null ? { firstName: sanitizeText(body.firstName, 80) } : {}),
    ...(body.lastName != null ? { lastName: sanitizeText(body.lastName, 80) } : {}),
    ...(body.phone != null ? { phone: normalizePhone(body.phone) } : {}),
    ...(body.email != null ? { email: sanitizeText(body.email, 120) } : {}),
    customerContactUpdatedByAdmin: true,
    customerContactUpdatedAt: now,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'admin_update_customer', by: 'admin' }),
  };
  return { ok: true, booking: patched };
}

function mutateVehicles(booking, body) {
  const op = sanitizeText(body.vehicleOp, 32);
  const now = new Date().toISOString();
  let vehicles = Array.isArray(booking.vehicles) ? [...booking.vehicles] : [];
  if (!vehicles.length && booking.vehicleCategory) {
    vehicles = [{
      cat: booking.vehicleCategory,
      pkgId: booking.packageId,
      pkgName: booking.package,
      vehicleLabel: booking.vehicleLabel || booking.vehicle,
    }];
  }

  if (op === 'add') {
    const v = body.vehicle || {};
    vehicles.push({
      cat: sanitizeText(v.cat || booking.vehicleCategory, 32),
      pkgId: sanitizeText(v.pkgId || v.packageId, 32),
      pkgName: sanitizeText(v.pkgName || v.package, 120),
      tierKey: sanitizeText(v.tierKey, 32),
      tierLabel: sanitizeText(v.tierLabel, 80),
      vehicleLabel: sanitizeText(v.vehicleLabel || v.label, 120),
      addons: Array.isArray(v.addons) ? v.addons : [],
    });
  } else if (op === 'update') {
    const idx = Number(body.vehicleIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx >= vehicles.length) {
      return { ok: false, error: 'invalid_vehicle_index' };
    }
    const v = body.vehicle || {};
    vehicles[idx] = { ...vehicles[idx], ...v };
  } else if (op === 'remove') {
    const idx = Number(body.vehicleIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx >= vehicles.length) {
      return { ok: false, error: 'invalid_vehicle_index' };
    }
    vehicles.splice(idx, 1);
  } else if (op === 'replace') {
  const idx = Number(body.vehicleIndex) || 0;
    const v = body.vehicle || {};
    if (vehicles[idx]) vehicles[idx] = { ...vehicles[idx], ...v };
    else vehicles.push(v);
  } else {
    return { ok: false, error: 'invalid_vehicle_op' };
  }

  const working = { ...booking, vehicles };
  const pricing = validateAndRecalculateBookingPricing(working);
  if (!pricing.ok) return { ok: false, error: pricing.error || 'invalid_pricing' };
  const travel = applyServerTravelAndTotal({ ...working, vehicles: pricing.vehicles }, { skipMismatchCheck: true });
  if (!travel.ok) return { ok: false, error: travel.error };

  const patched = syncLegacyFields({
    ...working,
    vehicles: pricing.vehicles,
    totalPrice: travel.serverTotal,
    approvedFinalAmount: travel.serverTotal,
    serviceSubtotal: travel.serviceSubtotal,
    vehiclesUpdatedByAdminAt: now,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'admin_update_vehicles', by: 'admin', op }),
  });
  return { ok: true, booking: patched };
}

async function updateServicePackage(booking, body) {
  const now = new Date().toISOString();
  const working = { ...booking };
  if (body.packageId || body.pkgId) {
    working.packageId = sanitizeText(body.packageId || body.pkgId, 32);
  }
  if (body.package) working.package = sanitizeText(body.package, 120);
  if (Array.isArray(body.addons)) working.addons = body.addons;
  if (body.addonOp === 'add' && body.addon) {
    const addons = Array.isArray(working.addons) ? [...working.addons] : [];
    addons.push(body.addon);
    working.addons = addons;
  }
  if (body.addonOp === 'remove' && body.addonId) {
    working.addons = (working.addons || []).filter((a) => a.id !== body.addonId);
  }
  if (body.vehicleIndex != null && Array.isArray(working.vehicles)) {
    const idx = Number(body.vehicleIndex);
    const v = working.vehicles[idx];
    if (v) {
      if (body.packageId) v.pkgId = sanitizeText(body.packageId, 32);
      if (body.package) v.pkgName = sanitizeText(body.package, 120);
      if (Array.isArray(body.addons)) v.addons = body.addons;
    }
  }

  const pricing = validateAndRecalculateBookingPricing(working);
  if (!pricing.ok) return { ok: false, error: pricing.error || 'invalid_pricing' };
  const travel = applyServerTravelAndTotal(
    { ...working, vehicles: pricing.vehicles },
    { skipMismatchCheck: true }
  );
  if (!travel.ok) return { ok: false, error: travel.error };

  let patched = {
    ...working,
    vehicles: pricing.vehicles,
    totalPrice: travel.serverTotal,
    serviceSubtotal: travel.serviceSubtotal,
    packageUpdatedByAdminAt: now,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'admin_update_service', by: 'admin' }),
  };

  const offerApplied = await applyServerOffersToBooking(patched, {
    serviceSubtotal: travel.serviceSubtotal,
    travelFee: patched.travelFeeAmount || 0,
    sourceTrigger: 'admin_reprice',
  }).catch(() => null);
  if (offerApplied) {
    patched = { ...patched, approvedFinalAmount: patched.totalPrice };
  } else {
    patched.approvedFinalAmount = travel.serverTotal;
  }

  return { ok: true, booking: syncLegacyFields(patched) };
}

function adminTechStatus(booking, body) {
  const statusAction = sanitizeText(body.statusAction, 32);
  const now = new Date().toISOString();
  const from = normalizeServiceStatus(booking);
  const map = {
    en_route: 'en_route',
    start: 'in_progress',
    pause: 'paused',
    resume: 'in_progress',
    complete_service: 'service_completed',
  };
  const to = map[statusAction];
  if (!to) return { ok: false, error: 'invalid_status_action' };
  if (!canTransitionService(from, to) && statusAction !== 'complete_service') {
    return { ok: false, error: 'invalid_transition', from, to };
  }

  const legacyMap = {
    en_route: 'en_route',
    start: 'in_progress',
    pause: 'paused',
    resume: 'in_progress',
    complete_service: 'completed_pending_admin_review',
  };

  const patched = syncLegacyFields({
    ...booking,
    serviceStatus: to,
    jobStatus: legacyMap[statusAction] || booking.jobStatus,
    completionSubmitted: statusAction === 'complete_service' ? true : booking.completionSubmitted,
    adminReviewRequired: statusAction === 'complete_service' ? true : booking.adminReviewRequired,
    techCompletedAt: statusAction === 'complete_service' ? now : booking.techCompletedAt,
    completedByAdminProxy: true,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'admin_tech_' + statusAction, by: 'admin' }),
  });
  return { ok: true, booking: patched };
}

function approveAdjustment(booking, body) {
  const now = new Date().toISOString();
  const proposed = body.approvedFinalAmount != null
    ? Math.round(Number(body.approvedFinalAmount) * 100) / 100
    : Math.round(Number(booking.proposedFinalAmount || booking.totalPrice) * 100) / 100;
  const patched = syncLegacyFields({
    ...booking,
    approvedFinalAmount: proposed,
    finalAmount: proposed,
    totalPrice: proposed,
    adjustmentStatus: 'approved',
    adjustmentApprovedAt: now,
    adjustmentApprovedBy: 'admin',
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'adjustment_approved', by: 'admin', amount: proposed }),
  });
  return { ok: true, booking: patched };
}

function rejectAdjustment(booking, body) {
  const reason = sanitizeText(body.reason, 500);
  const now = new Date().toISOString();
  const original = booking.preAdjustmentTotal != null ? booking.preAdjustmentTotal : booking.totalPrice;
  const patched = syncLegacyFields({
    ...booking,
    approvedFinalAmount: original,
    finalAmount: original,
    totalPrice: original,
    adjustmentStatus: 'rejected',
    adjustmentRejectedAt: now,
    adjustmentRejectedReason: reason,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'adjustment_rejected', by: 'admin', reason }),
  });
  return { ok: true, booking: patched };
}

function setApprovedFinalAmount(booking, body) {
  const amount = Math.round(Number(body.approvedFinalAmount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: 'invalid_amount' };
  const now = new Date().toISOString();
  const patched = syncLegacyFields({
    ...booking,
    approvedFinalAmount: amount,
    finalAmount: amount,
    totalPrice: amount,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'set_approved_final_amount', by: 'admin', amount }),
  });
  return { ok: true, booking: patched };
}

/**
 * Strict dollar → integer cents. Rejects malformed, non-finite, negative/zero,
 * and more-than-2-decimal-place values. Does not accept cents-unit inputs.
 */
function parseStrictCashDollarsToCents(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: false, error: 'absent' };
  }
  if (typeof value === 'boolean' || typeof value === 'object') {
    return { ok: false, error: 'malformed', receivedAmountCents: null };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || /[eE]/.test(trimmed) || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return { ok: false, error: 'malformed', receivedAmountCents: null };
    }
    if (/\.\d{3,}$/.test(trimmed)) {
      return { ok: false, error: 'excessive_precision', receivedAmountCents: null };
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      return { ok: false, error: 'malformed', receivedAmountCents: null };
    }
    if (num <= 0) {
      return { ok: false, error: 'non_positive', receivedAmountCents: Math.round(num * 100) };
    }
    const amountCents = Math.round(num * 100);
    if (Math.abs(num * 100 - amountCents) > 1e-8) {
      return { ok: false, error: 'excessive_precision', receivedAmountCents: amountCents };
    }
    return { ok: true, amountCents };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: 'malformed', receivedAmountCents: null };
  }
  if (value <= 0) {
    return { ok: false, error: 'non_positive', receivedAmountCents: Math.round(value * 100) };
  }
  const amountCents = Math.round(value * 100);
  if (Math.abs(value * 100 - amountCents) > 1e-8) {
    return { ok: false, error: 'excessive_precision', receivedAmountCents: amountCents };
  }
  return { ok: true, amountCents };
}

const AMBIGUOUS_CASH_AMOUNT_KEYS = [
  'amountCents',
  'cashAmountCents',
  'cashCents',
  'settlementCents',
  'cashCollectedAmount',
];

/**
 * Authoritative full-balance cash settlement gate.
 * remainingCents comes from financialProjection — never settle approvedCents blindly.
 * Absent body.amount → settle exactly remainingCents.
 * Present body.amount → must equal remainingCents in cents after strict dollar parse.
 */
function resolveAdminCashSettlement(booking, body = {}) {
  const { financialProjection } = require('./payment-service');
  const projection = financialProjection(booking);
  const remainingCents = Math.max(0, Math.round(Number(projection.remainingCents) || 0));

  const ambiguousKey = AMBIGUOUS_CASH_AMOUNT_KEYS.find((key) => (
    Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined
  ));
  if (ambiguousKey) {
    return {
      ok: false,
      error: 'cash_amount_mismatch',
      statusCode: 400,
      expectedAmountCents: remainingCents,
      receivedAmountCents: null,
      projection,
      reason: 'ambiguous_amount_field',
      field: ambiguousKey,
    };
  }

  if (remainingCents <= 0) {
    const paid = projection.paymentStatus === 'paid' || projection.invoicePaid === true;
    return {
      ok: false,
      error: paid ? 'already_paid' : 'not_due',
      statusCode: 409,
      expectedAmountCents: 0,
      receivedAmountCents: body.amount != null && body.amount !== ''
        ? (parseStrictCashDollarsToCents(body.amount).amountCents ?? null)
        : null,
      projection,
    };
  }

  const amountAbsent = body.amount === undefined || body.amount === null || body.amount === '';
  if (amountAbsent) {
    return {
      ok: true,
      amountCents: remainingCents,
      amountDollars: remainingCents / 100,
      remainingCents,
      projection,
    };
  }

  const parsed = parseStrictCashDollarsToCents(body.amount);
  if (!parsed.ok) {
    return {
      ok: false,
      error: 'cash_amount_mismatch',
      statusCode: 400,
      expectedAmountCents: remainingCents,
      receivedAmountCents: parsed.receivedAmountCents != null ? parsed.receivedAmountCents : null,
      projection,
      reason: parsed.error,
    };
  }

  if (parsed.amountCents !== remainingCents) {
    return {
      ok: false,
      error: 'cash_amount_mismatch',
      statusCode: 400,
      expectedAmountCents: remainingCents,
      receivedAmountCents: parsed.amountCents,
      projection,
    };
  }

  return {
    ok: true,
    amountCents: remainingCents,
    amountDollars: remainingCents / 100,
    remainingCents,
    projection,
  };
}

function markCashReceived(booking, body) {
  const now = new Date().toISOString();
  // Prefer caller-resolved full remaining (dollars). Fallback keeps unit-test seams
  // that patch status without going through resolveAdminCashSettlement.
  const amount = body.amount != null
    ? Math.round(Number(body.amount) * 100) / 100
    : Math.round(Number(booking.approvedFinalAmount || booking.totalPrice) * 100) / 100;
  const patched = syncLegacyFields({
    ...booking,
    paymentStatus: 'paid_cash',
    paymentWorkflowStatus: 'payment_succeeded',
    jobStatus: 'completed_paid',
    serviceStatus: 'closed',
    cashReceivedAt: now,
    cashReceivedAmount: amount,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'cash_received', by: 'admin', amount }),
  });
  return { ok: true, booking: patched };
}

function markCardOnSite(booking, body) {
  const now = new Date().toISOString();
  const reference = sanitizeText(body.reference, 120);
  const amount = body.amount != null
    ? Math.round(Number(body.amount) * 100) / 100
    : Math.round(Number(booking.approvedFinalAmount || booking.totalPrice) * 100) / 100;
  const patched = syncLegacyFields({
    ...booking,
    paymentStatus: 'paid_card_on_site',
    paymentWorkflowStatus: 'payment_succeeded',
    jobStatus: 'completed_paid',
    serviceStatus: 'closed',
    cardOnSiteReference: reference,
    cardOnSiteAmount: amount,
    cardOnSiteAt: now,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'card_on_site_recorded', by: 'admin', reference, amount }),
  });
  return { ok: true, booking: patched };
}

/**
 * Records a refund against the authoritative ledger — never a bare status
 * flip. Amount is clamped to what is currently settled (can't refund more
 * than was actually paid); persistMutation derives the ledger delta from
 * refundRequestAmount, exactly like markCashReceived/markCardOnSite derive
 * theirs from cashReceivedAmount/cardOnSiteAmount.
 */
function markRefunded(booking, body) {
  const now = new Date().toISOString();
  const reason = sanitizeText(body.reason, 500);
  const settledCents = Math.max(0, Math.round(Number(booking.ledger?.settledCents) || 0));
  const creditedCents = Math.max(0, Math.round(Number(booking.ledger?.creditedCents) || 0));
  const netSettledCents = Math.max(0, settledCents - creditedCents);
  const requestedCents = body.amount != null
    ? Math.round(Number(body.amount) * 100)
    : netSettledCents;
  const amount = Math.max(0, Math.min(requestedCents, netSettledCents)) / 100;
  const patched = syncLegacyFields({
    ...booking,
    refundRequestedAt: now,
    refundRequestReason: reason || booking.refundRequestReason || '',
    refundRequestAmount: amount,
    refundStatus: 'refunded',
    refundedAt: now,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'refund_recorded', by: 'admin', reason, amount }),
  });
  return { ok: true, booking: patched, amount };
}

async function generateCustomerLinks(booking, body, siteUrl) {
  const linkType = sanitizeText(body.linkType, 32);
  const base = siteUrl || process.env.DEPLOY_PRIME_URL || process.env.URL || 'https://cardetail1.com';
  if (linkType === 'completion') {
    const link = await createCompletionLink(booking.id, 'completion_review');
    const url = buildCompletionUrl(base, link.token);
    return { ok: true, url, expiresAt: link.expiresAt, linkType: 'completion' };
  }
  if (linkType === 'my_garage') {
    const url = `${String(base).replace(/\/$/, '')}/my-garage.html?bookingId=${encodeURIComponent(booking.id)}&phone=${encodeURIComponent(booking.phone || '')}`;
    return { ok: true, url, linkType: 'my_garage' };
  }
  return { ok: false, error: 'invalid_link_type' };
}

function reopenAppointment(booking, body) {
  const reason = sanitizeText(body.reason, 500);
  const now = new Date().toISOString();
  const patched = syncLegacyFields({
    ...booking,
    jobStatus: 'reopened',
    serviceStatus: 'in_progress',
    completionSubmitted: false,
    adminReviewRequired: true,
    reopenedAt: now,
    reopenReason: reason,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'job_reopened', by: 'admin', reason }),
  });
  return { ok: true, booking: patched };
}

module.exports = {
  generateId,
  newUniqueId,
  isQaFixture,
  createAdminAppointment,
  updateCustomerContact,
  mutateVehicles,
  updateServicePackage,
  adminTechStatus,
  approveAdjustment,
  rejectAdjustment,
  setApprovedFinalAmount,
  parseStrictCashDollarsToCents,
  resolveAdminCashSettlement,
  markCashReceived,
  markCardOnSite,
  markRefunded,
  generateCustomerLinks,
  reopenAppointment,
  evaluateTechAdjustment,
  getApprovedAmountCents,
};
