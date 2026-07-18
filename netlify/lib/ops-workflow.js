// Job + payment workflow constants and safe projections.
const {
  JOB_STATUSES, PAYMENT_WORKFLOW_STATUSES, normalizeJobStatus, normalizePaymentWorkflowStatus,
} = require('./ops-schema');
const { matchPackFromBooking } = require('./customer-catalog');
const { techEquipmentHintsForSiteAccess } = require('./site-access');

const TECH_STATUS_UPDATES = new Set([
  'accepted', 'en_route', 'arrived', 'in_progress', 'paused', 'issue_reported',
]);

const STRIPE_SENSITIVE = new Set([
  'stripeCustomerId', 'stripePaymentMethodId', 'setupIntentId', 'paymentIntentId',
  'amountAuthorizedCents', 'amountCapturedCents', 'cardOnFileStatus', 'cardOnFileSavedAt',
]);

function suggestEquipmentForJob(b) {
  const pkg = String(b.package || b.service || '').toLowerCase();
  const veh = String(b.vehicle || b.vehicleLabel || b.vehicleCategory || '').toLowerCase();
  const hay = pkg + ' ' + veh;
  const hints = [];
  if (/boat|marine|yacht/.test(hay)) hints.push('Own ladder (required)', 'Marine-safe products', 'Shade or dock access');
  if (/rv|motorhome|trailer|camper/.test(hay)) hints.push('Own ladder 12ft+', 'Extension cord if no shore power');
  if (/compound|correction|swirl|polish/.test(hay)) hints.push('DA polisher', 'Compound + finishing polish', 'Paint depth gauge recommended');
  if (/extract|stain|deep.?clean|shampoo/.test(hay)) hints.push('Hot water extractor', 'Brush attachments');
  if (/ceramic|coating|ppf/.test(hay)) hints.push('Prep wash + iron decon', 'IR lamp optional');
  if (/interior|full/.test(pkg)) hints.push('Vacuum + steam cleaner', 'Microfiber towels');
  if (!hints.length) hints.push('Standard detail kit', 'Microfiber towels', 'Pressure washer if exterior');
  hints.push(...techEquipmentHintsForSiteAccess(b));
  return [...new Set(hints)];
}

function appendEventLog(booking, entry) {
  const eventLog = Array.isArray(booking.eventLog) ? [...booking.eventLog] : [];
  eventLog.push({ ...entry, at: entry.at || new Date().toISOString() });
  return eventLog;
}

function projectJobForAdmin(b) {
  const safe = { ...b };
  delete safe.passwordHash;
  safe.jobStatus = normalizeJobStatus(safe);
  // Release A: Admin + Customer share financialProjection for money parity.
  try {
    const { materialProjection } = require('./booking-aggregate');
    const { computeDue } = require('./portal-money-sync');
    const { financialProjection } = require('./payment-service');
    const material = materialProjection(safe);
    const money = financialProjection(safe);
    if (material) {
      safe.bookingVersion = material.bookingVersion;
      safe.quoteVersion = material.quoteVersion;
      safe.schemaVersion = material.schemaVersion;
    }
    safe.approvedCents = money.approvedCents;
    safe.settledCents = money.settledCents;
    safe.remainingCents = money.remainingCents;
    safe.amountDueApproved = money.remainingCents / 100;
    safe.amountPaid = (money.settledCents || 0) / 100;
    if (safe.approvedFinalAmount == null && money.approvedCents != null) {
      safe.approvedFinalAmount = money.approvedCents / 100;
    }
    // Keep computeDue for diagnostics; never override zero remaining when paid.
    if (money.paymentStatus !== 'paid') {
      safe.amountDueApproved = computeDue(safe);
    }
    safe.invoicePaid = money.invoicePaid;
    safe.paymentWorkflowStatus = money.paymentWorkflowStatus;
    safe.financialPaymentStatus = money.paymentStatus;
    safe.canGeneratePayLink = money.canGeneratePayLink;
    safe.stripeCheckoutSessionIdPrefix = money.stripeCheckoutSessionIdPrefix;
    safe.paymentIntentIdPrefix = money.paymentIntentIdPrefix;
  } catch {
    safe.paymentWorkflowStatus = normalizePaymentWorkflowStatus(safe);
  }
  return safe;
}

function projectJobForTech(b) {
  const first = b.firstName || '';
  const last = b.lastName || '';
  const customerName = [first, last].filter(Boolean).join(' ') || 'Customer';
  const pack = matchPackFromBooking(b);
  const vehicles = Array.isArray(b.vehicles) && b.vehicles.length
    ? b.vehicles
    : [{
      vehicleLabel: b.vehicleLabel || b.vehicle || b.vehicleCategory || '',
      pkgName: b.package || b.service || '',
      addons: b.addons || [],
    }];
  return {
    id: b.id,
    customerName,
    phone: b.phone || '',
    email: b.email ? '[on file]' : '',
    address: b.address || '',
    zipCode: b.zipCode || '',
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    confirmedDate: b.confirmedDate || '',
    confirmedTime: b.confirmedTime || '',
    confirmedTimeWindow: b.confirmedTimeWindow || '',
    vehicle: b.vehicleLabel || b.vehicle || b.vehicleCategory || '',
    vehicles: vehicles.map(v => ({
      vehicleLabel: v.vehicleLabel || v.vehicle || '',
      pkgName: v.pkgName || b.package || '',
      addons: (v.addons || []).map(a => ({ name: a.name, qty: a.qty || 1 })),
    })),
    package: b.package || b.service || '',
    packageDescription: pack ? pack.description : '',
    packageChecklist: pack ? pack.feats : [],
    packageDuration: pack ? pack.duration : '',
    addons: (b.addons || []).map(a => ({ name: a.name, qty: a.qty || 1 })),
    customerNote: b.customerNote || '',
    notes: b.customerNote || b.notes || '',
    adminNotes: b.adminNotes || b.opsNotes || '',
    waterAvailable: b.waterAvailable || '',
    electricityAvailable: b.electricityAvailable || '',
    serviceLocation: b.serviceLocation || '',
    accessNotes: b.accessNotes || '',
    jobStatus: normalizeJobStatus(b),
    serviceStatus: b.serviceStatus || '',
    paymentStatus: b.paymentStatus || '',
    customerApprovalStatus: b.customerApprovalStatus || '',
    assignedTechId: b.assignedTechId || b.assignedTech || '',
    assignedTechName: b.assignedTechName || '',
    techNotes: b.techNotes || '',
    zone: b.zone || '',
    approvedAmount: b.approvedFinalAmount != null ? b.approvedFinalAmount : (b.totalPrice != null ? b.totalPrice : null),
    finalAmount: b.finalAmount != null ? b.finalAmount : (b.totalPrice != null ? b.totalPrice : null),
    techPayoutAmount: b.techPayoutAmount != null ? b.techPayoutAmount : null,
    completionSubmitted: !!b.completionSubmitted,
    equipmentHints: suggestEquipmentForJob(b),
    photosRequired: true,
    photosBefore: b.photosBefore || [],
    photosAfter: b.photosAfter || [],
    adjustmentStatus: b.adjustmentStatus || 'none',
  };
}

function projectTechAccountForAdmin(t) {
  const { passwordHash, inviteToken, ...safe } = t;
  const ob = t.onboarding || {};
  return {
    ...safe,
    techId: t.techId || t.id,
    fullName: t.fullName || t.name || '',
    hasPassword: !!passwordHash,
    hasInviteToken: !!inviteToken,
    inviteExpired: t.inviteExpiresAt ? new Date(t.inviteExpiresAt) < new Date() : false,
    onboardingComplete: !!ob.completed,
    ratingAverage: t.ratingAverage || null,
    ratingCount: t.ratingCount || 0,
    insuranceCarrier: ob.insuranceCarrier || '',
    insuranceExpiresAt: ob.insuranceExpiresAt || '',
    workVehicle: ob.workVehicle || '',
  };
}

module.exports = {
  JOB_STATUSES,
  PAYMENT_WORKFLOW_STATUSES,
  TECH_STATUS_UPDATES,
  STRIPE_SENSITIVE,
  appendEventLog,
  normalizeJobStatus,
  normalizePaymentWorkflowStatus,
  suggestEquipmentForJob,
  projectJobForAdmin,
  projectJobForTech,
  projectTechAccountForAdmin,
};
