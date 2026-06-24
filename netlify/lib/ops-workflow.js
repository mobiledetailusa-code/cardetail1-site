// Job + payment workflow constants and safe projections.
const {
  JOB_STATUSES, PAYMENT_WORKFLOW_STATUSES, normalizeJobStatus, normalizePaymentWorkflowStatus,
} = require('./ops-schema');
const { matchServicePackage } = require('./ops-config');

const TECH_STATUS_UPDATES = new Set([
  'accepted', 'en_route', 'arrived', 'in_progress', 'issue_reported',
]);

const STRIPE_SENSITIVE = new Set([
  'stripeCustomerId', 'stripePaymentMethodId', 'setupIntentId', 'paymentIntentId',
  'amountAuthorizedCents', 'amountCapturedCents', 'cardOnFileStatus', 'cardOnFileSavedAt',
]);

function suggestEquipmentForJob(b) {
  const pkgName = String(b.package || b.service || '');
  const veh = String(b.vehicle || b.vehicleLabel || b.vehicleCategory || '').toLowerCase();
  const hay = (pkgName + ' ' + veh).toLowerCase();
  const hints = [];
  const matched = matchServicePackage(pkgName);

  if (matched && matched.equipment) {
    hints.push(...matched.equipment);
  }

  if (/boat|marine|yacht/.test(hay)) {
    hints.push('Own ladder (required for hull/deck access)', 'Marine-safe wash products', 'Shade or dock access plan');
  }
  if (/rv|motorhome|trailer|camper/.test(hay)) {
    hints.push('Own ladder 12ft+ for roof/upper panels', 'Extension cord if no shore power');
  }
  if (!matched && /compound|correction|swirl|polish|enhancement/.test(hay)) {
    hints.push('DA polisher with cutting/finishing pads', 'Compound + finishing polish', 'Paint depth gauge recommended');
  }
  if (!matched && /extract|stain|deep.?clean|shampoo|interior detail/.test(hay)) {
    hints.push('Hot water extractor', 'Steam cleaner + brush attachments');
  }
  if (!matched && /ceramic|coating|ppf/.test(hay)) {
    hints.push('Prep wash + iron decon', 'Coating applicators + IPA towels', 'IR lamp optional');
  }
  if (!matched && /interior|full detail|premium detail/.test(hay)) {
    hints.push('Shop vacuum + steam cleaner', 'Microfiber towels for all surfaces');
  }
  if (!hints.length) {
    hints.push('Standard mobile detail kit', 'Microfiber towels', 'Pressure washer if exterior work');
  }
  return [...new Set(hints)];
}

function resolvePackageInfo(b) {
  const name = String(b.package || b.service || '').trim();
  const matched = matchServicePackage(name);
  return {
    packageName: name || (matched && matched.name) || '',
    packageDescription: matched ? matched.description : '',
  };
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
  safe.paymentWorkflowStatus = normalizePaymentWorkflowStatus(safe);
  return safe;
}

function projectJobForTech(b) {
  const first = b.firstName || '';
  const last = b.lastName || '';
  const customerName = [first, last].filter(Boolean).join(' ') || 'Customer';
  const pkgInfo = resolvePackageInfo(b);
  return {
    id: b.id,
    customerName,
    phone: b.phone || '',
    address: b.address || '',
    zipCode: b.zipCode || '',
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    confirmedDate: b.confirmedDate || '',
    confirmedTime: b.confirmedTime || '',
    confirmedTimeWindow: b.confirmedTimeWindow || '',
    vehicle: b.vehicleLabel || b.vehicle || b.vehicleCategory || '',
    package: pkgInfo.packageName || b.package || b.service || '',
    packageDescription: pkgInfo.packageDescription || '',
    addons: (b.addons || []).map(a => ({ name: a.name, qty: a.qty || 1 })),
    customerNote: b.customerNote || '',
    jobStatus: normalizeJobStatus(b),
    assignedTechId: b.assignedTechId || b.assignedTech || '',
    assignedTechName: b.assignedTechName || '',
    techNotes: b.techNotes || '',
    zone: b.zone || '',
    finalAmount: b.finalAmount != null ? b.finalAmount : (b.totalPrice != null ? b.totalPrice : null),
    techPayoutAmount: b.techPayoutAmount != null ? b.techPayoutAmount : null,
    completionSubmitted: !!b.completionSubmitted,
    equipmentHints: suggestEquipmentForJob(b),
    photosRequired: true,
    photosBefore: b.photosBefore || [],
    photosAfter: b.photosAfter || [],
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
  resolvePackageInfo,
  projectJobForAdmin,
  projectJobForTech,
  projectTechAccountForAdmin,
};
