// Technician job completion — no mandatory signatures; payment channel paths.
const {
  blobsStore, jsonCors, validateTechSession, bookingAssignedToTech, sanitizeText,
} = require('../lib/tech-security');
const { appendEventLog } = require('../lib/ops-workflow');
const {
  syncLegacyFields, evaluateTechAdjustment, getApprovedAmountCents, makeRequestId,
} = require('../lib/operations-lifecycle');
const { auditEntry, appendAudit } = require('../lib/operations-audit');
const { createCompletionLink, buildCompletionUrl } = require('../lib/customer-completion-link');
const { commitBooking } = require('../lib/booking-repository');
const { buildNextAggregate, normalizeAggregate, remainingCents } = require('../lib/booking-aggregate');
const { dollarsToCents, centsToDollars } = require('../lib/historical-adapter');

const PAYMENT_CHANNELS = new Set(['online', 'cash', 'card_on_site', 'customer_unavailable']);
const AUTH_TEXT_VERSION = 'completion-auth-v1';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const session = await validateTechSession(event.headers || {});
  if (!session) return jsonCors(401, { ok: false, error: 'unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const bookingId = sanitizeText(body.bookingId, 48);
  const requestId = sanitizeText(body.requestId, 64) || makeRequestId();
  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });

  const store = await blobsStore('cd1-bookings');
  const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });
  if (!bookingAssignedToTech(booking, session.techId, session.techName)) {
    return jsonCors(403, { ok: false, error: 'not_assigned_to_you' });
  }

  const alreadyDone = booking.completionSubmitted &&
    ['service_completed', 'awaiting_customer_action', 'closed'].includes(
      syncLegacyFields(booking).serviceStatus
    );
  if (alreadyDone && body.idempotent !== true) {
    return jsonCors(200, {
      ok: true,
      idempotent: true,
      bookingId,
      serviceStatus: syncLegacyFields(booking).serviceStatus,
      paymentStatus: syncLegacyFields(booking).paymentStatus,
    });
  }

  const checklist = body.checklist || {};
  const issueReported = !!checklist.issue_reported || booking.jobStatus === 'issue_reported';
  const paymentChannel = sanitizeText(body.paymentChannel, 40).toLowerCase() || 'customer_unavailable';
  if (!PAYMENT_CHANNELS.has(paymentChannel)) {
    return jsonCors(400, { ok: false, error: 'invalid_payment_channel' });
  }

  const requiredChecks = issueReported
    ? ['issue_reported']
    : ['service_completed', 'work_documented'];

  for (const key of requiredChecks) {
    if (!checklist[key]) {
      return jsonCors(400, { ok: false, error: 'checklist_incomplete', field: key });
    }
  }

  const technicianConfirmation = body.technicianConfirmation === true;
  if (!technicianConfirmation) {
    return jsonCors(400, { ok: false, error: 'technician_confirmation_required' });
  }

  const technicianPrintedName = sanitizeText(body.technicianPrintedName, 120) || session.techName;
  const customerPrintedName = sanitizeText(body.customerPrintedName, 120);
  const customerPresent = body.customerPresent === true;
  const customerSignature = sanitizeText(body.customerSignature, 120000);
  const technicianSignature = sanitizeText(body.technicianSignature, 120000);
  const completionNotes = sanitizeText(body.completionNotes, 2000);
  const customerVisibleNotes = sanitizeText(body.customerVisibleNotes, 2000);
  const internalNotes = sanitizeText(body.internalNotes, 2000);
  const issueNotes = sanitizeText(body.issueNotes, 2000);
  const adjustmentReason = sanitizeText(body.adjustmentReason, 500);

  const originalCents = getApprovedAmountCents(booking);
  let proposedCents = originalCents;
  if (body.proposedFinalAmount != null) {
    proposedCents = Math.max(0, Math.round(Number(body.proposedFinalAmount) * 100));
    if (!Number.isFinite(proposedCents)) {
      return jsonCors(400, { ok: false, error: 'invalid_proposed_amount' });
    }
  }

  const adjustmentEval = evaluateTechAdjustment(originalCents, proposedCents);
  if (proposedCents !== originalCents && !adjustmentReason) {
    return jsonCors(400, { ok: false, error: 'adjustment_reason_required' });
  }

  const photosBefore = Array.isArray(booking.photosBefore) ? booking.photosBefore : [];
  const photosAfter = Array.isArray(booking.photosAfter) ? booking.photosAfter : [];
  if (photosBefore.length < 1) {
    return jsonCors(400, { ok: false, error: 'photos_before_required' });
  }
  if (!issueReported && photosAfter.length < 1) {
    return jsonCors(400, { ok: false, error: 'photos_after_required' });
  }

  const now = new Date().toISOString();
  const prev = { ...booking };

  let serviceStatus = issueReported ? 'disputed' : 'service_completed';
  let paymentStatus = 'pending';
  let customerApprovalStatus = 'pending';
  let adjustmentStatus = 'none';

  if (proposedCents !== originalCents) {
    adjustmentStatus = adjustmentEval.requiresAdmin ? 'pending_admin' : 'approved';
  }

  let cashCollectedCents = null;
  if (paymentChannel === 'cash') {
    cashCollectedCents = Math.max(0, Math.round(Number(body.cashCollectedAmount) * 100));
    if (!Number.isFinite(cashCollectedCents) || cashCollectedCents < 1) {
      return jsonCors(400, { ok: false, error: 'cash_amount_required' });
    }
    const approved = adjustmentStatus === 'pending_admin' ? originalCents : proposedCents;
    if (cashCollectedCents !== approved) {
      return jsonCors(400, { ok: false, error: 'cash_amount_mismatch' });
    }
    paymentStatus = 'paid_cash';
    customerApprovalStatus = 'approved';
    serviceStatus = 'closed';
  } else if (paymentChannel === 'card_on_site') {
    const ref = sanitizeText(body.cardOnSiteReference, 120);
    if (!ref) return jsonCors(400, { ok: false, error: 'card_on_site_reference_required' });
    paymentStatus = 'paid_card_on_site';
    customerApprovalStatus = 'approved';
    serviceStatus = 'closed';
  } else if (paymentChannel === 'online' || paymentChannel === 'customer_unavailable') {
    serviceStatus = adjustmentStatus === 'pending_admin' ? 'service_completed' : 'awaiting_customer_action';
    paymentStatus = adjustmentStatus === 'pending_admin' ? 'pending' : 'link_pending';
    customerApprovalStatus = 'pending';
  }

  let completionActionUrl = booking.completionActionUrl || '';
  if (['link_pending', 'pending'].includes(paymentStatus) && adjustmentStatus !== 'pending_admin') {
    try {
      const link = await createCompletionLink(bookingId, 'completion_review');
      completionActionUrl = buildCompletionUrl(process.env.DEPLOY_PRIME_URL || process.env.URL, link.token);
    } catch (_) {
      completionActionUrl = '';
    }
  }

  const patched = syncLegacyFields({
    ...booking,
    serviceStatus,
    paymentStatus,
    customerApprovalStatus,
    completedAt: now,
    completedByTechId: session.techId,
    completedByTechName: session.techName,
    technicianPrintedName,
    technicianConfirmation: true,
    technicianConfirmedAt: now,
    customerPrintedName: customerPresent ? customerPrintedName : '',
    customerPresent,
    customerSignature: customerSignature || '',
    technicianSignature: technicianSignature || '',
    customerAuthorizationAccepted: customerPresent,
    customerAuthorizationTextVersion: customerPresent ? AUTH_TEXT_VERSION : '',
    completionNotes,
    customerVisibleNotes,
    internalNotes,
    issueNotes,
    completionChecklist: checklist,
    completionSubmitted: true,
    adminReviewRequired: adjustmentStatus === 'pending_admin' || issueReported,
    photosBefore,
    photosAfter,
    proposedFinalAmount: proposedCents / 100,
    approvedFinalAmount: adjustmentStatus === 'pending_admin' ? booking.approvedFinalAmount : proposedCents / 100,
    adjustmentStatus,
    adjustmentReason,
    adjustmentRequestedAt: proposedCents !== originalCents ? now : booking.adjustmentRequestedAt,
    cashCollectedAmount: cashCollectedCents != null ? cashCollectedCents / 100 : booking.cashCollectedAmount,
    cardOnSiteReference: sanitizeText(body.cardOnSiteReference, 120),
    completionPaymentChannel: paymentChannel,
    completionActionUrl,
    completionRequestId: requestId,
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'job_completion_submitted',
      by: 'technician',
      technicianId: session.techId,
      serviceStatus,
      paymentChannel,
      requestId,
    }),
  });

  if (adjustmentStatus === 'pending_admin' || issueReported) {
    patched.paymentWorkflowStatus = 'pending_admin_review';
    patched.jobStatus = 'completed_pending_admin_review';
  } else if (paymentStatus === 'paid_cash' || paymentStatus === 'paid_card_on_site') {
    patched.paymentWorkflowStatus = paymentStatus === 'paid_cash' ? 'cash_paid' : 'payment_succeeded';
    patched.jobStatus = 'completed_paid';
  } else if (serviceStatus === 'awaiting_customer_action') {
    patched.paymentWorkflowStatus = 'payment_action_required';
    patched.jobStatus = 'completed_pending_payment';
  } else if (serviceStatus === 'service_completed') {
    patched.paymentWorkflowStatus = 'pending_admin_review';
    patched.jobStatus = 'completed_pending_admin_review';
  }

  // Cash / card-on-site collected in the field must hit the authoritative
  // ledger, not just a status label — otherwise remainingCents/parity with
  // Admin and Customer silently disagree with what the technician actually
  // collected. Never a bare status flip.
  if (paymentStatus === 'paid_cash' || paymentStatus === 'paid_card_on_site') {
    const { ok: normOk, aggregate: normBooking } = normalizeAggregate(booking, { allowDraft: false });
    const base = normOk ? normBooking : booking;
    const approvedCents = dollarsToCents(
      patched.approvedFinalAmount != null ? patched.approvedFinalAmount : patched.totalPrice
    );
    const collectedCents = paymentStatus === 'paid_cash'
      ? Math.max(0, cashCollectedCents || 0)
      : approvedCents;
    const remaining = remainingCents(base.ledger);
    const credit = Math.min(Math.max(0, collectedCents), remaining);
    if (credit > 0) {
      const ledger = {
        ...(base.ledger || {}),
        currency: 'usd',
        settledCents: Math.max(0, Math.round(Number(base.ledger?.settledCents) || 0) + credit),
        entries: [
          ...(Array.isArray(base.ledger?.entries) ? base.ledger.entries : []),
          {
            entryId: `le_tech_${paymentChannel}_${Date.now()}`,
            kind: 'settlement',
            amountCents: credit,
            currency: 'usd',
            quoteVersion: Math.round(Number(base.quoteVersion) || 0),
            bookingVersion: Math.round(Number(base.bookingVersion) || 0),
            occurredAt: now,
            recordedAt: now,
            actor: `technician_${paymentChannel}`,
          },
        ],
      };
      const dueCents = Math.max(0, dollarsToCents(patched.approvedFinalAmount) - ledger.settledCents);
      patched.ledger = ledger;
      patched.amountPaid = centsToDollars(ledger.settledCents);
      patched.paidAmount = centsToDollars(ledger.settledCents);
      patched.amountDueApproved = centsToDollars(dueCents);
      patched.balanceDue = centsToDollars(dueCents);
    }
    const next = buildNextAggregate(base, patched);
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: Math.round(Number(base.bookingVersion) || 0),
      nextAggregate: next,
    });
    if (!committed.ok) {
      return jsonCors(committed.statusCode || 409, { ok: false, error: committed.error || 'version_conflict' });
    }
  } else {
    await store.setJSON(bookingId, patched);
  }
  await appendAudit(auditEntry({
    bookingId,
    actorType: 'technician',
    actorId: session.techId,
    action: 'complete_service',
    requestId,
    previousState: prev,
    resultingState: patched,
    reason: adjustmentReason || paymentChannel,
    approvalStatus: adjustmentStatus,
    sourcePortal: 'technician',
  }));

  return jsonCors(200, {
    ok: true,
    bookingId,
    requestId,
    serviceStatus: patched.serviceStatus,
    paymentStatus: patched.paymentStatus,
    customerApprovalStatus: patched.customerApprovalStatus,
    adjustmentStatus,
    requiresAdminApproval: adjustmentStatus === 'pending_admin',
    completionActionUrl: completionActionUrl ? '[generated]' : '',
    completedAt: now,
  });
};
