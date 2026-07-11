// Anonymous prospect vs identified lead — pipeline and communications gates.

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e.includes('@') ? e : '';
}

function hasApprovedContact(input) {
  const ctx = input || {};
  const phone = normalizePhone(ctx.phone || ctx._private?.phone);
  const email = normalizeEmail(ctx.email || ctx._private?.email);
  const name = String(ctx.name || ctx._private?.name || '').trim();
  return !!(name && phone && (email || phone));
}

function isIdentifiedLead(input) {
  const ctx = input || {};
  if (ctx.leadId) return true;
  if (ctx.isIdentified === true) return true;
  return hasApprovedContact(ctx);
}

function validateLeadCreation(input) {
  if (!hasApprovedContact(input)) {
    return { ok: false, error: 'anonymous_not_identified', leadId: null };
  }
  if (!input.transactionalConsent && input.requireTransactionalConsent !== false) {
    return { ok: false, error: 'transactional_consent_required', leadId: null };
  }
  return { ok: true };
}

function canEnterRecoveryQueue(input) {
  if (!isIdentifiedLead(input)) return { ok: false, reason: 'anonymous_abandonment' };
  if (!input.transactionalConsent) return { ok: false, reason: 'no_transactional_consent' };
  if (!input.leadId) return { ok: false, reason: 'missing_lead_id' };
  return { ok: true };
}

function canSyncCrm(input) {
  if (!isIdentifiedLead(input)) return { ok: false, error: 'anonymous_not_synced' };
  const email = normalizeEmail(input.email || input._private?.email);
  const phone = normalizePhone(input.phone || input._private?.phone);
  if (!email && !phone) return { ok: false, error: 'anonymous_not_synced' };
  return { ok: true };
}

function canReceiveCommunication(input) {
  if (!isIdentifiedLead(input)) return { ok: false, reason: 'anonymous_no_communications' };
  if (!input.transactionalConsent && !input.marketingConsent) {
    return { ok: false, reason: 'no_consent' };
  }
  return { ok: true };
}

function anonymousProspectRecord(sessionId, data) {
  return {
    type: 'anonymous_prospect',
    anonymous_session_id: String(sessionId || '').trim(),
    segmentHypothesis: data.segment || null,
    intentScore: Number(data.intentScore || 0) || 0,
    leadTemperature: data.leadTemperature || null,
    updatedAt: new Date().toISOString(),
    leadId: null,
    identified: false,
  };
}

module.exports = {
  normalizePhone,
  normalizeEmail,
  hasApprovedContact,
  isIdentifiedLead,
  validateLeadCreation,
  canEnterRecoveryQueue,
  canSyncCrm,
  canReceiveCommunication,
  anonymousProspectRecord,
};
