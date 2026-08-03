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

/**
 * Display-ready Admin vehicle itemization from persisted booking data.
 * Reuses Customer Portal field shape (dollars for vehicle money).
 * Does not expose ledger rows, Stripe IDs, or payment secrets.
 */
function projectVehicleForAdmin(v) {
  const { projectVehicleForCustomer } = require('./ops-schema');
  return projectVehicleForCustomer(v);
}

function hasUsableAdminVehicles(list) {
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((v) => {
    if (!v || typeof v !== 'object') return false;
    return !!(v.vehicleId || v.vehicleLabel || v.packageName || v.pkgName
      || v.packageId || v.pkgId || v.year || v.make || v.model
      || v.category || v.cat || v.subtotal != null || v.basePrice != null
      || v.lengthFt);
  });
}

/**
 * Resolve and project all persisted vehicles for Admin Ops.
 * Prefer material.service.vehicles → top-level vehicles → service.vehicles.
 * When none are usable, synthesize a single legacy primary-vehicle row.
 */
function projectVehiclesForAdmin(b) {
  const { resolveCustomerVehicles } = require('./ops-schema');
  let material = null;
  try {
    const { materialProjection } = require('./booking-aggregate');
    material = materialProjection(b);
  } catch {
    material = null;
  }
  const raw = resolveCustomerVehicles(b || {}, material || {});
  const projected = raw.map(projectVehicleForAdmin).filter(Boolean);
  if (hasUsableAdminVehicles(projected)) return projected;

  // Legacy primary-vehicle fallback — preserve top-level compatibility fields.
  const legacy = projectVehicleForAdmin({
    vehicleId: (b && b.vehicleId) || 'primary',
    year: b && b.vehicleYear,
    make: b && (b.vehicleMake || b.make),
    model: b && (b.vehicleModel || b.model),
    vehicleLabel: (b && (b.vehicleLabel || b.vehicle || b.vehicleCategory)) || '',
    category: (b && (b.vehicleCategory || b.cat)) || '',
    packageId: (b && (b.packageId || b.pkgId)) || '',
    packageName: (b && (b.package || b.service)) || '',
    tierKey: (b && b.tierKey) || '',
    tierLabel: (b && (b.tierLabel || b.tier)) || '',
    lengthFt: (b && (b.vehicleLengthFt || b.lengthFt)) || 0,
    basePrice: null,
    addonTotal: 0,
    subtotal: null,
    addons: Array.isArray(b && b.addons) ? b.addons : [],
  });
  return legacy ? [legacy] : [];
}

/**
 * Concise vehicle summary for Jobs table / search — no vehicle objects or add-ons.
 */
function listVehicleSummary(b) {
  const raw = Array.isArray(b && b.vehicles) ? b.vehicles.filter((v) => v && typeof v === 'object') : [];
  let vehicleCount = raw.length;
  if (!vehicleCount && (b && (b.vehicleLabel || b.vehicle || b.vehicleCategory))) {
    vehicleCount = 1;
  }
  let vehicleLabel = '';
  if (vehicleCount > 1) {
    vehicleLabel = vehicleCount + ' vehicles';
  } else if (raw.length === 1) {
    vehicleLabel = String(
      raw[0].vehicleLabel
      || [raw[0].year, raw[0].make, raw[0].model].filter(Boolean).join(' ').trim()
      || (b && (b.vehicleLabel || b.vehicle))
      || ''
    );
  } else {
    vehicleLabel = String((b && (b.vehicleLabel || b.vehicle || b.vehicleCategory)) || '');
  }
  return {
    vehicleCount,
    vehicleLabel,
    vehicle: vehicleLabel,
  };
}

/**
 * Pending-request count for Jobs badges without embedding full request records.
 * Counts open booking.changeRequests (incl. vehicle_remove_request) + legacy flags.
 */
function listPendingRequestSummary(b) {
  const { isOpenStatus } = require('./admin-change-request-projection');
  const rows = Array.isArray(b && b.changeRequests) ? b.changeRequests : [];
  let pendingChangeRequestCount = 0;
  let hasPendingVehicleRemoval = false;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || !isOpenStatus(r.status)) continue;
    pendingChangeRequestCount += 1;
    const t = String(r.requestType || r.type || '');
    if (t === 'vehicle_remove_request') hasPendingVehicleRemoval = true;
  }
  if (pendingChangeRequestCount === 0) {
    if (b && b.cancellationRequestStatus === 'requested') pendingChangeRequestCount += 1;
    if (b && b.rescheduledByClient) pendingChangeRequestCount += 1;
    if (b && (b.addressChangedByClient || b.requestedAddress)) pendingChangeRequestCount += 1;
  }
  const customerChangePending = pendingChangeRequestCount > 0 || !!(b && b.customerChangePending);
  return {
    pendingChangeRequestCount,
    customerChangePending,
    hasPendingVehicleRemoval,
  };
}

/**
 * Authoritative money summary for Jobs list rows.
 * Reuses financialProjection — does not invent a second ledger.
 */
function listMoneySummary(b) {
  try {
    const { materialProjection } = require('./booking-aggregate');
    const { computeDue } = require('./portal-money-sync');
    const { financialProjection } = require('./payment-service');
    const material = materialProjection(b);
    const money = financialProjection(b);
    let amountDueApproved = money.remainingCents / 100;
    if (money.paymentStatus !== 'paid') {
      amountDueApproved = computeDue(b);
    }
    return {
      bookingVersion: material ? material.bookingVersion : (b && b.bookingVersion),
      quoteVersion: material ? material.quoteVersion : (b && b.quoteVersion),
      approvedCents: money.approvedCents,
      settledCents: money.settledCents,
      remainingCents: money.remainingCents,
      amountDueApproved,
      amountPaid: (money.settledCents || 0) / 100,
      approvedFinalAmount: money.approvedCents != null ? money.approvedCents / 100 : null,
      invoicePaid: money.invoicePaid,
      paymentWorkflowStatus: money.paymentWorkflowStatus,
      financialPaymentStatus: money.paymentStatus,
    };
  } catch {
    return {
      bookingVersion: b && b.bookingVersion,
      quoteVersion: b && b.quoteVersion,
      approvedCents: null,
      settledCents: null,
      remainingCents: null,
      amountDueApproved: null,
      amountPaid: null,
      approvedFinalAmount: b && b.approvedFinalAmount != null ? b.approvedFinalAmount : null,
      invoicePaid: false,
      paymentWorkflowStatus: normalizePaymentWorkflowStatus(b || {}),
      financialPaymentStatus: null,
    };
  }
}

/**
 * Lightweight Admin Jobs list/poll row.
 * Full appointment detail remains projectJobForAdmin via get_job.
 */
function projectJobForAdminList(b) {
  if (!b || typeof b !== 'object') {
    return {
      id: 'unknown',
      jobStatus: 'pending_review',
      paymentWorkflowStatus: 'no_payment_required_yet',
      _projection: 'admin_list',
      _malformed: true,
    };
  }
  const money = listMoneySummary(b);
  const vehicles = listVehicleSummary(b);
  const requests = listPendingRequestSummary(b);
  const techId = String(b.assignedTechId || b.assignedTech || '');
  return {
    id: String(b.id || b.bookingId || ''),
    bookingId: String(b.bookingId || b.id || ''),
    bookingVersion: money.bookingVersion != null ? money.bookingVersion : b.bookingVersion,
    quoteVersion: money.quoteVersion != null ? money.quoteVersion : b.quoteVersion,
    createdAt: b.createdAt || '',
    updatedAt: b.updatedAt || '',
    firstName: b.firstName || '',
    lastName: b.lastName || '',
    email: b.email || '',
    phone: b.phone || '',
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    confirmedDate: b.confirmedDate || '',
    confirmedTime: b.confirmedTime || '',
    confirmedTimeWindow: b.confirmedTimeWindow || '',
    jobStatus: normalizeJobStatus(b),
    package: b.package || b.service || '',
    vehicleCount: vehicles.vehicleCount,
    vehicleLabel: vehicles.vehicleLabel,
    vehicle: vehicles.vehicle,
    approvedCents: money.approvedCents,
    settledCents: money.settledCents,
    remainingCents: money.remainingCents,
    amountDueApproved: money.amountDueApproved,
    amountPaid: money.amountPaid,
    approvedFinalAmount: money.approvedFinalAmount,
    invoicePaid: money.invoicePaid,
    paymentWorkflowStatus: money.paymentWorkflowStatus,
    financialPaymentStatus: money.financialPaymentStatus,
    assignedTechId: techId,
    assignedTech: techId,
    assignedTechName: b.assignedTechName || '',
    pendingChangeRequestCount: requests.pendingChangeRequestCount,
    customerChangePending: requests.customerChangePending,
    hasPendingVehicleRemoval: requests.hasPendingVehicleRemoval,
    cancellationRequestStatus: b.cancellationRequestStatus || '',
    rescheduledByClient: !!b.rescheduledByClient,
    addressChangedByClient: !!b.addressChangedByClient,
    requestedAddress: b.requestedAddress ? String(b.requestedAddress).slice(0, 200) : '',
    issueNotes: b.issueNotes ? String(b.issueNotes).slice(0, 240) : '',
    completedAt: b.completedAt || '',
    isTest: !!b.isTest,
    archived: !!b.archived,
    _projection: 'admin_list',
  };
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
  // Multi-vehicle display projection — server dollars; keep top-level primary fields.
  safe.vehicles = projectVehiclesForAdmin(safe);
  // Canonical change-request projection so Admin appointment + badges see
  // vehicle_remove_request (and peers), not only legacy reschedule/address flags.
  try {
    const {
      projectChangeRequestsForAdmin,
    } = require('./admin-change-request-projection');
    const cr = projectChangeRequestsForAdmin(safe);
    safe.changeRequests = cr.changeRequests;
    safe.pendingChangeRequests = cr.pendingChangeRequests;
    safe.pendingChangeRequestCount = cr.pendingChangeRequestCount;
    if (cr.pendingChangeRequestCount > 0) safe.customerChangePending = true;
  } catch {
    safe.pendingChangeRequests = [];
    safe.pendingChangeRequestCount = 0;
  }
  safe._projection = 'admin_full';
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

/** Lightweight Assign dropdown row — no PII beyond display name. */
function projectTechAssignOption(t) {
  if (!t || typeof t !== 'object') {
    return { techId: '', fullName: '', active: false };
  }
  return {
    techId: String(t.techId || t.id || ''),
    fullName: String(t.fullName || t.name || ''),
    active: t.active !== false,
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
  projectVehicleForAdmin,
  projectVehiclesForAdmin,
  listVehicleSummary,
  listPendingRequestSummary,
  listMoneySummary,
  projectJobForAdminList,
  projectJobForAdmin,
  projectJobForTech,
  projectTechAccountForAdmin,
  projectTechAssignOption,
};
