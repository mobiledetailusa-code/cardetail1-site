// Cardetail1 operational data model — single source of truth for job + payment state.
// Mirrors mobile-detailing ops platforms (dispatch → field → complete → pay → review).

const BOOKINGS_STORE = 'cd1-bookings';
const TECH_ACCOUNTS_STORE = 'cd1-tech-accounts';
const TECH_SESSIONS_STORE = 'cd1-tech-sessions';

const JOB_STATUSES = [
  'pending_review', 'confirmed', 'assigned', 'accepted', 'en_route', 'arrived',
  'in_progress', 'issue_reported', 'completed_pending_admin_review',
  'completed_pending_payment', 'completed_paid', 'reopened', 'cancelled', 'archived_test',
];

const PAYMENT_WORKFLOW_STATUSES = [
  'no_payment_required_yet', 'pending_admin_review', 'awaiting_customer_payment',
  'payment_action_required', 'payment_succeeded', 'payment_failed', 'cash_paid', 'refunded',
];

const LEGACY_STATUS_TO_JOB = {
  'Pending Review': 'pending_review',
  'Confirmed': 'confirmed',
  'Scheduled': 'assigned',
  'Assigned': 'assigned',
  'En Route': 'en_route',
  'In Progress': 'in_progress',
  'Problem': 'issue_reported',
  'Completed': 'completed_pending_admin_review',
  'Paid': 'completed_paid',
  'Closed': 'completed_paid',
  'Cancelled': 'cancelled',
  'Canceled': 'cancelled',
  'Cancellation Requested': 'pending_review',
  'Rescheduled': 'confirmed',
  'No-Show': 'cancelled',
  'archived_test': 'archived_test',
};

const JOB_TO_LEGACY_DISPLAY = {
  pending_review: 'Pending Review',
  confirmed: 'Confirmed',
  assigned: 'Scheduled',
  accepted: 'Scheduled',
  en_route: 'En Route',
  arrived: 'In Progress',
  in_progress: 'In Progress',
  issue_reported: 'Problem',
  completed_pending_admin_review: 'Completed',
  completed_pending_payment: 'Completed',
  completed_paid: 'Paid',
  reopened: 'In Progress',
  cancelled: 'Cancelled',
  archived_test: 'Cancelled',
};

function normalizeJobStatus(booking) {
  const b = booking || {};
  const js = String(b.jobStatus || '').toLowerCase();
  if (js === 'not_started' || js === 'open') return 'pending_review';
  if (JOB_STATUSES.includes(js)) return js;
  if (b.appointmentStatus === 'canceled' || b.appointmentStatus === 'cancelled') return 'cancelled';
  if (b.archived || b.isTest) return 'archived_test';
  const legacy = LEGACY_STATUS_TO_JOB[b.status];
  if (legacy) return legacy;
  return 'pending_review';
}

function normalizePaymentWorkflowStatus(booking) {
  const b = booking || {};
  // Authoritative money projection beats a stale stored workflow label.
  try {
    const { financialProjection } = require('./payment-service');
    const fp = financialProjection(b);
    if (fp.paymentStatus === 'refunded') return 'refunded';
    if (fp.paymentStatus === 'paid') {
      return b.paymentWorkflowStatus === 'cash_paid' ? 'cash_paid' : 'payment_succeeded';
    }
    if (fp.paymentStatus === 'failed') return 'payment_failed';
    if (fp.paymentStatus === 'processing' || fp.paymentStatus === 'due') {
      return fp.paymentWorkflowStatus || 'awaiting_customer_payment';
    }
  } catch { /* fall through for non-aggregate records */ }

  if (b.paymentWorkflowStatus) return b.paymentWorkflowStatus;
  const js = normalizeJobStatus(b);
  if (js === 'completed_pending_admin_review') return 'pending_admin_review';
  if (js === 'completed_pending_payment') return 'payment_action_required';
  if (js === 'completed_paid' || b.paymentStatus === 'paid') return 'payment_succeeded';
  if (b.paymentStatus === 'failed') return 'payment_failed';
  return 'no_payment_required_yet';
}

function legacyDisplayStatus(booking) {
  const js = normalizeJobStatus(booking);
  return JOB_TO_LEGACY_DISPLAY[js] || booking.status || 'Pending Review';
}

/**
 * Project one persisted booking vehicle for Customer Portal itemization.
 * Monetary fields (basePrice, packagePrice, addonTotal, subtotal, addon.price)
 * are server dollars — same units as booking-price-catalog / quoteService inputs.
 * Do not mix with ledger *Cents fields.
 */
function projectVehicleForCustomer(v) {
  if (!v || typeof v !== 'object') return null;
  const year = v.year != null && v.year !== '' ? String(v.year) : (v.vehicleYear != null && v.vehicleYear !== '' ? String(v.vehicleYear) : '');
  const make = v.make || v.vehicleMake || '';
  const model = v.model || v.vehicleModel || '';
  const category = v.category || v.cat || '';
  const packageId = v.packageId || v.pkgId || '';
  const packageName = v.pkgName || v.packageName || '';
  const tierKey = v.tierKey || '';
  const tierLabel = v.tierLabel || v.tier || '';
  const lengthFt = Number(v.lengthFt != null ? v.lengthFt : v.vehicleLengthFt) || 0;
  const composedLabel = [year, make, model].filter(Boolean).join(' ').trim();
  const vehicleLabel = v.vehicleLabel || v.label || composedLabel || '';
  const baseRaw = v.basePrice != null ? v.basePrice : v.packagePrice;
  const basePrice = Number.isFinite(Number(baseRaw)) ? Number(baseRaw) : 0;
  const addonTotal = Number.isFinite(Number(v.addonTotal)) ? Number(v.addonTotal) : 0;
  const subtotalRaw = v.subtotal != null ? v.subtotal : (basePrice + addonTotal);
  const subtotal = Number.isFinite(Number(subtotalRaw)) ? Number(subtotalRaw) : 0;
  const addons = (Array.isArray(v.addons) ? v.addons : []).map((a) => {
    const qty = Number(a && a.qty) > 0 ? Number(a.qty) : 1;
    const price = Number.isFinite(Number(a && a.price)) ? Number(a.price) : 0;
    return {
      id: (a && (a.id || a.addonId)) || '',
      name: (a && a.name) || '',
      qty,
      price,
    };
  });
  return {
    vehicleId: v.vehicleId || '',
    year,
    make,
    model,
    vehicleLabel,
    category,
    cat: category,
    packageId,
    pkgId: packageId,
    packageName,
    pkgName: packageName,
    tierKey,
    tierLabel,
    tier: tierLabel || tierKey,
    lengthFt,
    // Dollars (not cents) — authoritative package/base and vehicle totals from persisted quote pricing
    basePrice,
    packagePrice: basePrice,
    addonTotal,
    subtotal,
    pkgIcon: v.pkgIcon || '🚗',
    addons,
  };
}

function resolveCustomerVehicles(src, material) {
  const materialVehicles = material && material.service && Array.isArray(material.service.vehicles)
    ? material.service.vehicles
    : [];
  if (materialVehicles.length) return materialVehicles;
  const top = Array.isArray(src.vehicles) ? src.vehicles : [];
  if (top.length) return top;
  if (src.service && typeof src.service === 'object' && Array.isArray(src.service.vehicles)) {
    return src.service.vehicles;
  }
  return [];
}

function projectBookingForCustomer(b) {
  const { adaptHistoricalBooking } = require('./historical-adapter');
  const { materialProjection, remainingCents } = require('./booking-aggregate');
  const { computeDue } = require('./portal-money-sync');
  const adapted = adaptHistoricalBooking(b);
  const src = adapted.ok && adapted.booking ? adapted.booking : b;
  const jobStatus = normalizeJobStatus(src);
  const paymentWorkflowStatus = normalizePaymentWorkflowStatus(src);
  const status = legacyDisplayStatus(src);
  const pack = src.package
    || (typeof src.service === 'string' ? src.service : '')
    || src.serviceLabel
    || '';
  const paid = Number(src.amountPaid || src.paidAmount || 0);
  const approved = Number(
    src.approvedFinalAmount != null ? src.approvedFinalAmount : (src.totalPrice || src.total_price || 0)
  );
  const amountDueApproved = computeDue(src);
  const material = materialProjection(src) || {};
  const vehiclesArr = resolveCustomerVehicles(src, material);
  const addonsArr = Array.isArray(src.addons) ? src.addons : [];
  const projectedVehicles = vehiclesArr
    .map(projectVehicleForCustomer)
    .filter(Boolean);
  const { customerFacingStatusLabel, customerFacingStatusKey } = require('./booking-customer-status');
  const customerStatusKey = customerFacingStatusKey(src);
  const customerStatus = customerFacingStatusLabel(src);
  return {
    id: src.id || src.bookingId,
    appointmentPublicRef: src.appointmentPublicRef || null,
    bookingVersion: material.bookingVersion ?? src.bookingVersion ?? 0,
    schemaVersion: material.schemaVersion ?? src.schemaVersion ?? 0,
    quoteVersion: material.quoteVersion ?? src.quoteVersion ?? 0,
    approvedCents: material.approvedCents,
    settledCents: material.settledCents,
    remainingCents: material.remainingCents ?? remainingCents(src.ledger || {}),
    status,
    customerStatus,
    customerStatusKey,
    jobStatus,
    paymentWorkflowStatus,
    appointmentStatus: src.appointmentStatus || (jobStatus === 'cancelled' ? 'canceled' : jobStatus === 'confirmed' ? 'confirmed' : 'pending_review'),
    package: pack,
    service: pack,
    packageId: src.packageId || src.pkgId
      || (projectedVehicles[0] && projectedVehicles[0].packageId) || '',
    packageDescription: src.packageDescription || src.pkgTag || src.packageTag || '',
    packageDuration: src.packageDuration || src.pkgDuration || '',
    vehicle: src.vehicle || src.vehicleCategory || '',
    vehicleLabel: src.vehicleLabel || src.vehicle || '',
    vehicleYear: src.vehicleYear || '',
    vehicleMake: src.vehicleMake || src.make || '',
    vehicleModel: src.vehicleModel || src.model || '',
    vehicleCategory: src.vehicleCategory || src.cat
      || (projectedVehicles[0] && projectedVehicles[0].category) || '',
    vehicleLengthFt: src.vehicleLengthFt || src.lengthFt
      || (projectedVehicles[0] && projectedVehicles[0].lengthFt) || 0,
    vehicles: projectedVehicles,
    addons: addonsArr.map(a => ({ id: a.id || '', name: a.name || '', qty: a.qty || 1, price: a.price || 0 })),
    preferredDate: src.preferredDate || '',
    preferredTime: src.preferredTime || '',
    preferredArrivalWindow: src.preferredArrivalWindow || '',
    alternatePreferredDate: src.alternatePreferredDate || null,
    alternateArrivalWindow: src.alternateArrivalWindow || null,
    confirmedDate: src.confirmedDate || '',
    confirmedTime: src.confirmedTime || '',
    confirmedTimeWindow: src.confirmedTimeWindow || src.confirmedWindow || '',
    address: src.address || (src.service && src.service.serviceAddress) || '',
    zipCode: src.zipCode || '',
    zone: src.zone || '',
    travelFeeMiles: src.travelFeeMiles ?? null,
    travelFeeAmount: src.travelFeeAmount ?? src.zoneSurcharge ?? 0,
    zoneSurcharge: src.zoneSurcharge ?? src.travelFeeAmount ?? 0,
    totalPrice: approved,
    approvedFinalAmount: approved,
    amountPaid: paid,
    amountDueApproved: amountDueApproved > 0 ? amountDueApproved : 0,
    tip: src.tip || 0,
    payLink: src.payLink || '',
    paymentMethodPreference: src.paymentMethodPreference || '',
    cardOnFileStatus: src.cardOnFileStatus || 'pending',
    customerApprovalStatus: src.customerApprovalStatus || '',
    customerChangePending: !!src.customerChangePending,
    cancellationRequestStatus: src.cancellationRequestStatus || '',
    cancellationRequestedAt: src.cancellationRequestedAt || '',
    rescheduledByClient: !!src.rescheduledByClient,
    rescheduleRequestedDate: src.rescheduleRequestedDate || '',
    addressChangedByClient: !!src.addressChangedByClient,
    addonsRequested: !!src.addonsRequested,
    requestedAddons: src.requestedAddons || '',
    requestedAddonIds: src.requestedAddonIds || [],
    requestedAddonTotal: src.requestedAddonTotal || 0,
    packageChangeRequested: !!src.packageChangeRequested,
    requestedPackageName: src.requestedPackageName || '',
    requestedPackageId: src.requestedPackageId || '',
    requestedPackagePrice: src.requestedPackagePrice || 0,
    proposedTotal: src.proposedTotal || 0,
    vehicleChangeRequested: !!src.vehicleChangeRequested,
    requestedVehicleLabel: src.requestedVehicleLabel || '',
    maintenanceRequested: !!src.maintenanceRequested,
    maintenanceRequestNote: src.maintenanceRequestNote || '',
    maintenancePeriod: src.maintenancePeriod || '',
    maintenancePackageId: src.maintenancePackageId || '',
    maintenancePackageName: src.maintenancePackageName || '',
    policyChargeStatus: src.policyChargeStatus || '',
    policyChargeAmount: src.policyChargeAmount || null,
    assignedTechName: src.assignedTechName || '',
    createdAt: src.createdAt || '',
    customerNote: src.customerNote || '',
    notes: src.customerNote || src.notes || '',
    waterAvailable: src.waterAvailable || '',
    electricityAvailable: src.electricityAvailable || '',
    serviceLocation: src.serviceLocation || '',
    accessNotes: src.accessNotes || '',
    scheduleFlexibility: (() => {
      try {
        const { normalizeScheduleFlexibility } = require('./schedule-flexibility');
        return normalizeScheduleFlexibility(src.scheduleFlexibility);
      } catch (_) {
        return src.scheduleFlexibility || 'exact';
      }
    })(),
    firstName: src.firstName || '',
    lastName: src.lastName || '',
    email: src.email || '',
    phone: src.phone || '',
    photosBefore: Array.isArray(src.photosBefore) ? src.photosBefore : [],
    photosAfter: Array.isArray(src.photosAfter) ? src.photosAfter : [],
    reviewLeft: !!src.reviewLeft,
    offer: src.offer || src.welcomeOffer || null,
    requestSummaries: material.requestSummaries || [],
  };
}

module.exports = {
  BOOKINGS_STORE,
  TECH_ACCOUNTS_STORE,
  TECH_SESSIONS_STORE,
  JOB_STATUSES,
  PAYMENT_WORKFLOW_STATUSES,
  LEGACY_STATUS_TO_JOB,
  JOB_TO_LEGACY_DISPLAY,
  normalizeJobStatus,
  normalizePaymentWorkflowStatus,
  legacyDisplayStatus,
  projectBookingForCustomer,
  projectVehicleForCustomer,
  resolveCustomerVehicles,
};
