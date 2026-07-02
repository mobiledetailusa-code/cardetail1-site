// Technician job completion with signatures — no payment processing.
const {
  blobsStore, jsonCors, validateTechSession, bookingAssignedToTech, sanitizeText,
} = require('../lib/tech-security');
const { appendEventLog } = require('../lib/ops-workflow');

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
  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });

  const store = await blobsStore('cd1-bookings');
  const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });
  if (!bookingAssignedToTech(booking, session.techId, session.techName)) {
    return jsonCors(403, { ok: false, error: 'not_assigned_to_you' });
  }
  if (booking.completionSubmitted && booking.jobStatus === 'completed_pending_admin_review') {
    return jsonCors(409, { ok: false, error: 'completion_already_submitted' });
  }

  const checklist = body.checklist || {};
  const issueReported = !!checklist.issue_reported || booking.jobStatus === 'issue_reported';
  const requiredChecks = issueReported
    ? ['issue_reported']
    : ['service_completed', 'vehicle_released', 'customer_reviewed', 'no_unresolved_issue'];

  for (const key of requiredChecks) {
    if (!checklist[key]) {
      return jsonCors(400, { ok: false, error: 'checklist_incomplete', field: key });
    }
  }

  const customerPrintedName = sanitizeText(body.customerPrintedName, 120);
  const technicianPrintedName = sanitizeText(body.technicianPrintedName, 120);
  const customerSignature = sanitizeText(body.customerSignature, 120000);
  const technicianSignature = sanitizeText(body.technicianSignature, 120000);
  const completionNotes = sanitizeText(body.completionNotes, 2000);
  const issueNotes = sanitizeText(body.issueNotes, 2000);
  const customerAuthorizationAccepted = body.customerAuthorizationAccepted === true;

  if (!customerPrintedName) return jsonCors(400, { ok: false, error: 'customer_printed_name_required' });
  if (!technicianPrintedName) return jsonCors(400, { ok: false, error: 'technician_printed_name_required' });
  if (!customerSignature || customerSignature.length < 8) return jsonCors(400, { ok: false, error: 'customer_signature_required' });
  if (!technicianSignature || technicianSignature.length < 8) return jsonCors(400, { ok: false, error: 'technician_signature_required' });
  if (!customerAuthorizationAccepted) return jsonCors(400, { ok: false, error: 'customer_authorization_required' });
  if (issueNotes && !completionNotes && !issueReported) {
    return jsonCors(400, { ok: false, error: 'technician_note_required_for_issue' });
  }
  if ((issueNotes || issueReported) && !sanitizeText(body.technicianNotes || completionNotes, 2000)) {
    return jsonCors(400, { ok: false, error: 'technician_note_required' });
  }

  const photosBefore = Array.isArray(booking.photosBefore) ? booking.photosBefore : [];
  const photosAfter = Array.isArray(booking.photosAfter) ? booking.photosAfter : [];
  if (photosBefore.length < 1) {
    return jsonCors(400, {
      ok: false,
      error: 'photos_before_required',
      userMessage: 'Upload at least one BEFORE photo before submitting completion.',
    });
  }
  if (!issueReported && photosAfter.length < 1) {
    return jsonCors(400, {
      ok: false,
      error: 'photos_after_required',
      userMessage: 'Upload at least one AFTER photo before submitting completion.',
    });
  }

  const now = new Date().toISOString();
  const patched = {
    ...booking,
    jobStatus: 'completed_pending_admin_review',
    status: 'Completed',
    completedAt: now,
    completedByTechId: session.techId,
    completedByTechName: session.techName,
    technicianPrintedName,
    technicianSignature,
    customerPrintedName,
    customerSignature,
    customerAuthorizationAccepted: true,
    customerAuthorizationTextVersion: AUTH_TEXT_VERSION,
    completionNotes,
    issueNotes,
    completionChecklist: checklist,
    completionSubmitted: true,
    adminReviewRequired: true,
    photosBefore,
    photosAfter,
    paymentWorkflowStatus: 'pending_admin_review',
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'job_completion_submitted',
      by: 'technician',
      technicianId: session.techId,
      jobStatus: 'completed_pending_admin_review',
    }),
  };

  await store.setJSON(bookingId, patched);

  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (ADMIN_EMAIL && RESEND_API_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [ADMIN_EMAIL],
        subject: `Cardetail1 — job completion submitted · ${bookingId}`,
        text: `Technician ${session.techName} submitted completion for ${bookingId}.\nCustomer: ${customerPrintedName}\nReview in Admin Ops → Completed / Payment Review.`,
      }),
    }).catch(() => {});
  }

  return jsonCors(200, {
    ok: true,
    bookingId,
    jobStatus: patched.jobStatus,
    paymentWorkflowStatus: patched.paymentWorkflowStatus,
    completedAt: now,
  });
};
