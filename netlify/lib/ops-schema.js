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
  'payment_action_required', 'payment_succeeded', 'payment_failed', 'cash_paid',
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
  const vehiclesArr = Array.isArray(src.vehicles) ? src.vehicles : [];
  const addonsArr = Array.isArray(src.addons) ? src.addons : [];
  return {
    id: src.id || src.bookingId,
    bookingVersion: material.bookingVersion ?? src.bookingVersion ?? 0,
    schemaVersion: material.schemaVersion ?? src.schemaVersion ?? 0,
    quoteVersion: material.quoteVersion ?? src.quoteVersion ?? 0,
    approvedCents: material.approvedCents,
    settledCents: material.settledCents,
    remainingCents: material.remainingCents ?? remainingCents(src.ledger || {}),
    status,
    jobStatus,
    paymentWorkflowStatus,
    appointmentStatus: src.appointmentStatus || (jobStatus === 'cancelled' ? 'canceled' : jobStatus === 'confirmed' ? 'confirmed' : 'pending_review'),
    package: pack,
    service: pack,
    packageId: src.packageId || src.pkgId || '',
    packageDescription: src.packageDescription || src.pkgTag || src.packageTag || '',
    packageDuration: src.packageDuration || src.pkgDuration || '',
    vehicle: src.vehicle || src.vehicleCategory || '',
    vehicleLabel: src.vehicleLabel || src.vehicle || '',
    vehicleYear: src.vehicleYear || '',
    vehicleMake: src.vehicleMake || src.make || '',
    vehicleModel: src.vehicleModel || src.model || '',
    vehicleCategory: src.vehicleCategory || src.cat || '',
    vehicleLengthFt: src.vehicleLengthFt || src.lengthFt || 0,
    vehicles: vehiclesArr.map(v => ({
      vehicleId: v.vehicleId || '',
      pkgName: v.pkgName || '',
      vehicleLabel: v.vehicleLabel || '',
      pkgIcon: v.pkgIcon || '🚗',
      subtotal: v.subtotal || 0,
      addons: (Array.isArray(v.addons) ? v.addons : []).map(a => ({ name: a.name || '', qty: a.qty || 1, price: a.price || 0 })),
    })),
    addons: addonsArr.map(a => ({ id: a.id || '', name: a.name || '', qty: a.qty || 1, price: a.price || 0 })),
    preferredDate: src.preferredDate || '',
    preferredTime: src.preferredTime || '',
    confirmedDate: src.confirmedDate || '',
    confirmedTime: src.confirmedTime || '',
    confirmedTimeWindow: src.confirmedTimeWindow || src.confirmedWindow || '',
    address: src.address || '',
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
};
