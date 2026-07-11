// Abandoned booking detection and recovery queue (automation disabled by default).

const { getRevenueStore, blobGetJson, blobSetJson, generateOpaqueId } = require('./revenue-store');

const ABANDONMENT_INACTIVITY_MS = 30 * 60 * 1000;

const ABANDONMENT_STEPS = Object.freeze([
  'after_package_selection',
  'after_zip',
  'after_contact',
  'after_vehicle',
  'after_schedule',
  'before_payment',
  'during_payment',
  'after_payment_method_save',
]);

function classifyAbandonmentStep(bookingStep, paymentStepReached, paymentMethodSaved) {
  if (paymentMethodSaved) return 'after_payment_method_save';
  if (paymentStepReached) return 'during_payment';
  if (bookingStep >= 5) return 'before_payment';
  if (bookingStep >= 4) return 'after_schedule';
  if (bookingStep >= 3) return 'after_vehicle';
  if (bookingStep >= 2) return 'after_contact';
  if (bookingStep >= 1) return 'after_package_selection';
  return 'after_zip';
}

function recoveryEnabled() {
  return String(process.env.RECOVERY_AUTOMATION_ENABLED || '').toLowerCase() === 'true';
}

function recoveryDryRun() {
  const v = String(process.env.RECOVERY_DRY_RUN ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0';
}

async function enqueueRecoveryJob(input) {
  const { canEnterRecoveryQueue } = require('./anonymous-prospect');
  const gate = canEnterRecoveryQueue(input);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  if (input.bookingSubmitted) return { ok: false, reason: 'already_submitted' };
  const store = await getRevenueStore('recovery');
  const dedupeKey = `job:${input.leadId || input.bookingId}`;
  const existing = await blobGetJson(store, dedupeKey);
  if (existing && !existing.completed && !existing.cancelled) {
    return { ok: true, jobId: existing.jobId, duplicate: true };
  }
  const jobId = generateOpaqueId('rcv');
  const job = {
    jobId,
    leadId: input.leadId,
    householdId: input.householdId,
    bookingId: input.bookingId || null,
    abandonmentStep: classifyAbandonmentStep(input.bookingStep, input.paymentStepReached, input.paymentMethodSaved),
    marketingConsent: !!input.marketingConsent,
    resumeTokenId: input.resumeTokenId || null,
    messagesSent: 0,
    promotionalSent: 0,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    automationEnabled: recoveryEnabled(),
    dryRun: recoveryDryRun(),
  };
  await blobSetJson(store, dedupeKey, job);
  await blobSetJson(store, jobId, job);
  return { ok: true, jobId, duplicate: false };
}

async function cancelRecoveryForLead(leadId, reason) {
  const store = await getRevenueStore('recovery');
  const dedupeKey = `job:${leadId}`;
  const existing = await blobGetJson(store, dedupeKey);
  if (!existing) return { ok: true, found: false };
  const updated = {
    ...existing,
    status: 'cancelled',
    cancelledReason: reason || 'booking_completed',
    cancelledAt: new Date().toISOString(),
  };
  await blobSetJson(store, dedupeKey, updated);
  if (existing.jobId) await blobSetJson(store, existing.jobId, updated);
  return { ok: true, found: true };
}

function isOptOutMessage(text) {
  const t = String(text || '').trim().toUpperCase();
  return ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(t);
}

module.exports = {
  ABANDONMENT_INACTIVITY_MS,
  ABANDONMENT_STEPS,
  classifyAbandonmentStep,
  recoveryEnabled,
  recoveryDryRun,
  enqueueRecoveryJob,
  cancelRecoveryForLead,
  isOptOutMessage,
};
