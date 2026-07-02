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
  'no_payment_required_yet', 'card_on_file_saved', 'pending_admin_review',
  'invoice_sent', 'payment_link_sent', 'awaiting_customer_payment',
  'payment_action_required', 'payment_requires_customer_action',
  'payment_succeeded', 'payment_failed', 'cash_paid', 'refunded',
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
  const jobStatus = normalizeJobStatus(b);
  const paymentWorkflowStatus = normalizePaymentWorkflowStatus(b);
  const status = legacyDisplayStatus(b);
  return {
    id: b.id,
    status,
    jobStatus,
    paymentWorkflowStatus,
    appointmentStatus: b.appointmentStatus || (jobStatus === 'cancelled' ? 'canceled' : jobStatus === 'confirmed' ? 'confirmed' : 'pending_review'),
    package: b.package || b.service || '',
    service: b.package || b.service || '',
    vehicle: b.vehicle || b.vehicleCategory || '',
    vehicleLabel: b.vehicleLabel || b.vehicle || '',
    vehicles: (b.vehicles || []).map(v => ({
      pkgName: v.pkgName || '',
      vehicleLabel: v.vehicleLabel || '',
      pkgIcon: v.pkgIcon || '🚗',
      subtotal: v.subtotal || 0,
      addons: (v.addons || []).map(a => ({ name: a.name || '', qty: a.qty || 1 })),
    })),
    addons: (b.addons || []).map(a => ({ name: a.name || '', qty: a.qty || 1 })),
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    confirmedDate: b.confirmedDate || '',
    confirmedTime: b.confirmedTime || '',
    confirmedTimeWindow: b.confirmedTimeWindow || b.confirmedWindow || '',
    address: b.address || '',
    zipCode: b.zipCode || '',
    zone: b.zone || '',
    travelFeeMiles: b.travelFeeMiles ?? null,
    travelFeeAmount: b.travelFeeAmount ?? b.zoneSurcharge ?? 0,
    zoneSurcharge: b.zoneSurcharge ?? b.travelFeeAmount ?? 0,
    totalPrice: b.totalPrice || b.total_price || 0,
    tip: b.tip || 0,
    payLink: b.payLink || '',
    paymentMethodPreference: b.paymentMethodPreference || '',
    cardOnFileStatus: b.cardOnFileStatus || 'pending',
    cancellationRequestStatus: b.cancellationRequestStatus || '',
    cancellationRequestedAt: b.cancellationRequestedAt || '',
    rescheduledByClient: !!b.rescheduledByClient,
    rescheduleRequestedDate: b.rescheduleRequestedDate || '',
    addressChangedByClient: !!b.addressChangedByClient,
    addonsRequested: !!b.addonsRequested,
    requestedAddons: b.requestedAddons || '',
    packageChangeRequested: !!b.packageChangeRequested,
    requestedPackageName: b.requestedPackageName || '',
    requestedPackageId: b.requestedPackageId || '',
    policyChargeStatus: b.policyChargeStatus || '',
    policyChargeAmount: b.policyChargeAmount || null,
    assignedTechName: b.assignedTechName || '',
    createdAt: b.createdAt || '',
    customerNote: b.customerNote || '',
    notes: b.customerNote || b.notes || '',
    waterAvailable: b.waterAvailable || '',
    electricityAvailable: b.electricityAvailable || '',
    serviceLocation: b.serviceLocation || '',
    accessNotes: b.accessNotes || '',
    firstName: b.firstName || '',
    lastName: b.lastName || '',
    email: b.email || '',
    phone: b.phone || '',
    photosBefore: b.photosBefore || [],
    photosAfter: b.photosAfter || [],
    reviewLeft: !!b.reviewLeft,
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
