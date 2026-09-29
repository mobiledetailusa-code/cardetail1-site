// Customer completion / action link verification and actions (booking-scoped token or portal auth).
const crypto = require('crypto');
const { jsonCors, blobsStore } = require('../lib/tech-security');
const { getBookingRecord, commitBooking } = require('../lib/booking-repository');
const { buildNextAggregate } = require('../lib/booking-aggregate');
const { evaluateIssueSubmission, postServiceState } = require('../lib/post-service-experience');
const { syncLegacyFields, portalLabel } = require('../lib/operations-lifecycle');
const { auditEntry, appendAudit } = require('../lib/operations-audit');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { checkPublicRateLimit } = require('../lib/public-rate-limit');
const { verifyActionToken } = require('../lib/customer-completion-link');
const { authorizeBookingAccess } = require('../lib/booking-customer-auth');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
const { getBooking } = require('../lib/ops-db');
const { extraProposalPage } = require('../lib/quick-ops-html');
const { findAdjustment } = require('../lib/price-adjustments');
const { dollarsFromCents } = require('../lib/admin-quick-ops-view');
const { respondToCustomerExtra } = require('../lib/quick-ops-price');

async function resolveContext(event, body, action) {
  const token = String(body.token || '').trim();
  if (token) {
    const record = await verifyActionToken(token);
    if (!record) return { err: jsonCors(401, { ok: false, error: 'invalid_or_expired_token' }) };
    const booking = await getBooking(record.bookingId);
    if (!booking || !isVisibleSubmittedBooking(booking)) {
      return { err: jsonCors(404, { ok: false, error: 'booking_not_found' }) };
    }
    return { booking, bookingId: record.bookingId, actorId: 'action_link' };
  }

  if (action === 'view') {
    return { err: jsonCors(400, { ok: false, error: 'token_required' }) };
  }

  const auth = await authorizeBookingAccess(event, {
    bookingId: body.bookingId,
    phone: body.phone,
  });
  if (!auth.ok) {
    const code = auth.statusCode && auth.statusCode !== 200 ? auth.statusCode : 403;
    return {
      err: jsonCors(code, {
        ok: false,
        error: auth.error,
        message: auth.message,
      }),
    };
  }
  const bookingId = auth.booking.id || auth.booking.bookingId;
  return {
    booking: auth.booking,
    bookingId,
    actorId: auth.scope === 'session' ? 'session' : 'booking_lookup',
  };
}

function proposalTokenFromEvent(event) {
  const query = event && event.queryStringParameters;
  if (query && query.token) return String(query.token).trim();
  try {
    if (event && event.rawUrl) return new URL(event.rawUrl).searchParams.get('token') || '';
  } catch { /* ignore */ }
  return '';
}

function extraPublicFields(booking, adjustment) {
  return {
    adjustmentId: adjustment.adjustmentId,
    amountCents: adjustment.amountCents,
    amountLabel: dollarsFromCents(adjustment.amountCents),
    description: String(adjustment.reason || ''),
    status: adjustment.status,
    approvedCents: Math.max(0, Math.round(Number(booking.ledger && booking.ledger.approvedCents) || 0)),
  };
}

async function loadExtraProposal(token) {
  const record = await verifyActionToken(token);
  if (!record || record.purpose !== 'extra_approval' || !record.adjustmentId) return null;
  const rec = await getBookingRecord(record.bookingId);
  if (!rec.exists || !rec.booking) return { missing: true };
  const adjustment = findAdjustment(rec.booking, record.adjustmentId);
  if (!adjustment) return { missing: true };
  return { booking: rec.booking, adjustment };
}

async function handleExtraProposalGet(event) {
  const loaded = await loadExtraProposal(proposalTokenFromEvent(event));
  if (!loaded || loaded.missing) {
    return extraProposalPage({ status: 'missing' });
  }
  const fields = extraPublicFields(loaded.booking, loaded.adjustment);
  return extraProposalPage({
    amountLabel: fields.amountLabel,
    reason: fields.description,
    status: fields.status,
    token: proposalTokenFromEvent(event),
  });
}

async function handleExtraDecision(body, action) {
  const loaded = await loadExtraProposal(body.token);
  if (!loaded || loaded.missing) {
    return jsonCors(401, { ok: false, error: 'invalid_or_expired_token' });
  }
  const fields = extraPublicFields(loaded.booking, loaded.adjustment);
  if (action === 'view_extra') {
    return jsonCors(200, { ok: true, proposal: fields });
  }
  const decision = action === 'approve_extra' ? 'approve' : 'decline';
  const result = await respondToCustomerExtra(loaded.booking, {
    adjustmentId: loaded.adjustment.adjustmentId,
    decision,
    actorId: 'customer',
  });
  if (!result.ok) {
    return jsonCors(result.statusCode || 409, {
      ok: false,
      error: result.error || 'decision_failed',
      message: 'Could not save your decision',
    });
  }
  return jsonCors(200, {
    ok: true,
    decision,
    declined: !!result.declined,
    idempotent: !!result.idempotent,
    approvedCents: result.approvedCents,
    remainingCents: result.remainingCents,
    amountCents: fields.amountCents,
    description: fields.description,
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  const rate = await checkPublicRateLimit(event, { endpoint: 'customer-action-link' });
  if (rate && rate.allowed === false) return jsonCors(429, { ok: false, error: 'too_many_requests' });

  if (event.httpMethod === 'GET') return handleExtraProposalGet(event);
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || 'view').toLowerCase();
  if (action === 'view_extra' || action === 'approve_extra' || action === 'decline_extra') {
    return handleExtraDecision(body, action);
  }
  const ctx = await resolveContext(event, body, action);
  if (ctx.err) return ctx.err;

  const booking = ctx.booking;
  const bookingId = ctx.bookingId;
  const synced = syncLegacyFields(booking);
  const labels = portalLabel(synced.serviceStatus, synced.paymentStatus, synced.customerApprovalStatus);

  if (action === 'view') {
    const safe = projectBookingForCustomer(synced);
    return jsonCors(200, {
      ok: true,
      booking: safe,
      labels,
      adjustmentPending: synced.adjustmentStatus === 'pending_admin',
      approvedAmount: synced.approvedFinalAmount != null ? synced.approvedFinalAmount : synced.totalPrice,
      customerVisibleNotes: synced.customerVisibleNotes || '',
      completedAt: synced.completedAt || '',
      postService: postServiceState(synced),
    });
  }

  if (action === 'approve_completion') {
    if (synced.adjustmentStatus === 'pending_admin') {
      return jsonCors(409, { ok: false, error: 'adjustment_under_review' });
    }
    const prev = { ...synced };
    const expectedBookingVersion = Math.round(Number(body.expectedBookingVersion));
    const actualBookingVersion = Math.round(Number(synced.bookingVersion) || 0);
    if (body.expectedBookingVersion == null || body.expectedBookingVersion === ''
      || !Number.isFinite(expectedBookingVersion)
      || expectedBookingVersion !== actualBookingVersion) {
      return jsonCors(409, {
        ok: false,
        error: 'version_conflict',
        expectedBookingVersion: Number.isFinite(expectedBookingVersion) ? expectedBookingVersion : null,
        actualBookingVersion,
      });
    }
    const patched = syncLegacyFields({
      ...synced,
      customerApprovalStatus: 'approved',
      // Service approval is operational. It closes the service regardless of
      // whether the independent invoice was paid before or will be paid after.
      serviceStatus: 'closed',
      updatedAt: new Date().toISOString(),
    });
    const store = await blobsStore('cd1-bookings');
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion,
      nextAggregate: buildNextAggregate(synced, patched),
      storeOverride: store,
    });
    if (!committed.ok) {
      return jsonCors(409, { ok: false, error: 'version_conflict' });
    }
    await appendAudit(auditEntry({
      bookingId,
      actorType: 'customer',
      actorId: ctx.actorId,
      action: 'approve_completion',
      requestId: body.requestId,
      previousState: prev,
      resultingState: committed.booking,
      sourcePortal: 'customer',
    }));
    return jsonCors(200, {
      ok: true,
      bookingVersion: committed.bookingVersion,
      labels: portalLabel(
        committed.booking.serviceStatus,
        committed.booking.paymentStatus,
        committed.booking.customerApprovalStatus
      ),
    });
  }

  if (action === 'report_issue') {
    // Server time is the only clock that counts here. A browser reporting an
    // issue at "47h59m" on a machine set back a day gets the same answer as
    // everyone else.
    const gate = evaluateIssueSubmission(synced, {
      category: body.category,
      description: body.description || body.note || body.message,
    });
    if (!gate.ok) {
      return jsonCors(gate.statusCode || 400, {
        ok: false,
        error: gate.error,
        message: gate.message,
        categories: gate.categories,
        postService: gate.state,
      });
    }

    const nowIso = new Date().toISOString();
    const issue = {
      issueId: `iss_${crypto.randomBytes(6).toString('hex')}`,
      bookingId,
      category: gate.category,
      description: gate.description,
      createdAt: nowIso,
      // Reporting a problem opens a conversation. It is never an instruction to
      // refund or reverse a charge — that stays a separate, authorised decision.
      status: 'open',
      submittedBy: ctx.actorId,
      completedAt: gate.state.completedAt,
      windowClosesAt: gate.state.serviceIssue.windowClosesAt,
    };

    const store = await blobsStore('cd1-bookings');
    const rec = await getBookingRecord(bookingId, { storeOverride: store });
    const current = rec.exists ? rec.booking : synced;

    // Operational and payment status are deliberately untouched: a reported
    // issue must not erase the record that the job was completed and paid.
    const next = buildNextAggregate(current, {
      serviceIssues: [...(Array.isArray(current.serviceIssues) ? current.serviceIssues : []), issue].slice(-50),
      serviceIssueOpen: true,
      lastServiceIssueAt: nowIso,
      customerIssueNote: gate.description,
      updatedAt: nowIso,
    });

    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: Math.round(Number(current.bookingVersion) || 0),
      nextAggregate: next,
      storeOverride: store,
    });
    if (!committed.ok) {
      return jsonCors(committed.statusCode || 409, {
        ok: false,
        error: committed.error || 'version_conflict',
        message: 'This appointment changed while you were writing. Reload and try again.',
      });
    }

    await appendAudit(auditEntry({
      bookingId,
      actorType: 'customer',
      actorId: ctx.actorId,
      action: 'service_issue_submitted',
      requestId: body.requestId,
      previousState: current,
      resultingState: committed.booking,
      reason: `${gate.category}: ${gate.description}`.slice(0, 500),
      sourcePortal: 'customer',
    })).catch(() => null);

    // Admin notification is best-effort — the issue is already recorded and
    // visible in Admin regardless of whether the alert email goes out.
    let adminNotified = false;
    try {
      const { notifyAdminOfServiceIssue } = require('../lib/service-issue-notifications');
      const res = await notifyAdminOfServiceIssue(committed.booking, issue);
      adminNotified = !!(res && res.sent);
    } catch (e) {
      console.warn('[customer-portal-action] admin issue notify failed:', e.message);
    }

    return jsonCors(200, {
      ok: true,
      issueId: issue.issueId,
      status: issue.status,
      adminNotified,
      bookingVersion: committed.bookingVersion,
      postService: postServiceState(committed.booking),
    });
  }

  if (action === 'post_service_state') {
    return jsonCors(200, { ok: true, bookingId, postService: postServiceState(synced) });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
