// Admin-only jobs feed + admin ops actions for Admin Ops dashboard.
const { blobsStore, jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const {
  projectJobForAdmin, normalizeJobStatus, normalizePaymentWorkflowStatus, appendEventLog,
} = require('../lib/ops-workflow');

async function listJobs(q) {
  const showTest = String(q.showTest || '') === '1';
  const statusFilter = sanitizeText(q.jobStatus || q.status, 64);
  const search = sanitizeText(q.search, 120).toLowerCase();
  const store = await blobsStore('cd1-bookings');
  const listing = await store.list();
  const blobs = (listing && listing.blobs) || [];
  let jobs = (await Promise.all(
    blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(b => b && !b.isDraft);

  if (!showTest) jobs = jobs.filter(b => !b.isTest && !b.archived && b.jobStatus !== 'archived_test');
  if (statusFilter) jobs = jobs.filter(b => normalizeJobStatus(b) === statusFilter);
  if (search) {
    jobs = jobs.filter(b => {
      const hay = [
        b.id, b.firstName, b.lastName, b.phone, b.email, b.vehicle, b.vehicleLabel,
        b.package, b.assignedTechName, b.assignedTechId,
      ].join(' ').toLowerCase();
      return hay.includes(search);
    });
  }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return jobs.map(b => {
    const j = projectJobForAdmin(b);
    j.jobStatus = normalizeJobStatus(b);
    j.paymentWorkflowStatus = normalizePaymentWorkflowStatus(b);
    delete j.stripeCustomerId;
    delete j.stripePaymentMethodId;
    delete j.setupIntentId;
    delete j.paymentIntentId;
    delete j.amountAuthorizedCents;
    delete j.amountCapturedCents;
    delete j.cardOnFileStatus;
    return j;
  });
}

async function handleAdminAction(body) {
  const action = sanitizeText(body.action, 40);
  const bookingId = sanitizeText(body.bookingId, 48);
  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });

  const store = await blobsStore('cd1-bookings');
  const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });

  const now = new Date().toISOString();

  if (action === 'admin_note') {
    const note = sanitizeText(body.note, 1000);
    if (!note) return jsonCors(400, { ok: false, error: 'note_required' });
    await store.setJSON(bookingId, {
      ...booking,
      adminNotes: ((booking.adminNotes || '') + '\n[' + now.slice(0, 16) + '] ' + note).trim(),
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'admin_note', by: 'admin', note }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'approve_completion') {
    if (booking.jobStatus !== 'completed_pending_admin_review') {
      return jsonCors(409, { ok: false, error: 'not_pending_admin_review' });
    }
    const patched = {
      ...booking,
      adminReviewRequired: false,
      adminReviewedAt: now,
      adminReviewed: true,
      jobStatus: 'completed_pending_payment',
      paymentWorkflowStatus: 'payment_action_required',
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'completion_approved', by: 'admin' }),
    };
    await store.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId, jobStatus: patched.jobStatus });
  }

  if (action === 'reopen_job') {
    await store.setJSON(bookingId, {
      ...booking,
      jobStatus: 'reopened',
      completionSubmitted: false,
      adminReviewRequired: true,
      reopenedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'job_reopened', by: 'admin', reason: sanitizeText(body.reason, 500) }),
    });
    return jsonCors(200, { ok: true, bookingId, jobStatus: 'reopened' });
  }

  if (action === 'request_correction') {
    const msg = sanitizeText(body.message, 500);
    await store.setJSON(bookingId, {
      ...booking,
      jobStatus: 'in_progress',
      adminReviewRequired: true,
      correctionRequestedAt: now,
      correctionRequestNote: msg,
      completionSubmitted: false,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'correction_requested', by: 'admin', message: msg }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const auth = verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(auth.error === 'missing_admin_password_config' ? 503 : 401, { ok: false, error: auth.error });

  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }
    if (body.action && body.action !== 'list') return handleAdminAction(body);
    try {
      const jobs = await listJobs(body);
      return jsonCors(200, { ok: true, count: jobs.length, jobs });
    } catch {
      return jsonCors(500, { ok: false, error: 'failed_to_load_jobs' });
    }
  }

  try {
    const jobs = await listJobs(event.queryStringParameters || {});
    return jsonCors(200, { ok: true, count: jobs.length, jobs });
  } catch {
    return jsonCors(500, { ok: false, error: 'failed_to_load_jobs' });
  }
};
