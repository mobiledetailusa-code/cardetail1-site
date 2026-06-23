// Job + payment workflow constants and safe projections.
const {
  JOB_STATUSES, PAYMENT_WORKFLOW_STATUSES, normalizeJobStatus, normalizePaymentWorkflowStatus,
} = require('./ops-schema');

const TECH_STATUS_UPDATES = new Set([
  'accepted', 'en_route', 'arrived', 'in_progress', 'issue_reported',
]);

const STRIPE_SENSITIVE = new Set([
  'stripeCustomerId', 'stripePaymentMethodId', 'setupIntentId', 'paymentIntentId',
  'amountAuthorizedCents', 'amountCapturedCents', 'cardOnFileStatus', 'cardOnFileSavedAt',
]);

function appendEventLog(booking, entry) {
  const eventLog = Array.isArray(booking.eventLog) ? [...booking.eventLog] : [];
  eventLog.push({ ...entry, at: entry.at || new Date().toISOString() });
  return eventLog;
}

function projectJobForAdmin(b) {
  const safe = { ...b };
  delete safe.passwordHash;
  safe.jobStatus = normalizeJobStatus(safe);
  safe.paymentWorkflowStatus = normalizePaymentWorkflowStatus(safe);
  return safe;
}

function projectJobForTech(b) {
  const first = b.firstName || '';
  const lastInitial = (b.lastName || '').charAt(0);
  return {
    id: b.id,
    customerName: lastInitial ? `${first} ${lastInitial}.` : first,
    phone: b.phone || '',
    address: b.address || '',
    zipCode: b.zipCode || '',
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    confirmedDate: b.confirmedDate || '',
    confirmedTime: b.confirmedTime || '',
    confirmedTimeWindow: b.confirmedTimeWindow || '',
    vehicle: b.vehicleLabel || b.vehicle || b.vehicleCategory || '',
    package: b.package || b.service || '',
    addons: (b.addons || []).map(a => ({ name: a.name, qty: a.qty || 1 })),
    customerNote: b.customerNote || '',
    jobStatus: normalizeJobStatus(b),
    assignedTechId: b.assignedTechId || b.assignedTech || '',
    assignedTechName: b.assignedTechName || '',
    techNotes: b.techNotes || '',
    zone: b.zone || '',
    finalAmount: b.finalAmount != null ? b.finalAmount : (b.totalPrice != null ? b.totalPrice : null),
    completionSubmitted: !!b.completionSubmitted,
  };
}

function projectTechAccountForAdmin(t) {
  const { passwordHash, inviteToken, ...safe } = t;
  return {
    ...safe,
    techId: t.techId || t.id,
    fullName: t.fullName || t.name || '',
    hasPassword: !!passwordHash,
    hasInviteToken: !!inviteToken,
    inviteExpired: t.inviteExpiresAt ? new Date(t.inviteExpiresAt) < new Date() : false,
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
  projectJobForAdmin,
  projectJobForTech,
  projectTechAccountForAdmin,
};
