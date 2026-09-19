'use strict';

const {
  TOKEN_PREFIX,
  looksLikeToken,
  loadTechQuickOpsToken,
  createTechQuickOpsSession,
  loadTechQuickOpsSession,
  sessionCookieHeader,
  isLocalDev,
  verifyTechQuickOpsCsrf,
} = require('../lib/tech-quick-ops-token');
const {
  loadProjectedBooking,
  updateTechFieldStatus,
  completeTechJob,
  prepareTechMoney,
  completeIfReady,
  mintPaymentLink,
  textCustomer,
  recordOnSitePayment,
  reloadBooking,
} = require('../lib/tech-quick-ops-actions');
const { neutralExpiredPage, techQuickOpsPage } = require('../lib/tech-quick-ops-html');

const FIELD_ACTIONS = {
  accept: 'accepted',
  en_route: 'en_route',
  arrived: 'arrived',
  in_progress: 'in_progress',
  paused: 'paused',
  issue_reported: 'issue_reported',
};

const FIELD_MESSAGES = {
  accepted: 'Job accepted',
  en_route: 'En route',
  arrived: 'Arrived on site',
  in_progress: 'Job started',
  paused: 'Job paused',
  issue_reported: 'Issue reported',
};

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function pathFrom(event) {
  try {
    if (event.rawUrl) return new URL(event.rawUrl).pathname;
  } catch { /* ignore */ }
  return String(event.path || '');
}

function tokenFromEvent(event) {
  const path = pathFrom(event);
  const parts = path.split('/').filter(Boolean);
  const qIdx = parts.lastIndexOf('q');
  if (qIdx >= 0 && parts[qIdx + 1]) return parts[qIdx + 1];
  const last = parts[parts.length - 1] || '';
  if (looksLikeToken(last)) return last;
  const query = event.queryStringParameters || {};
  const raw = String(query.t || query.token || '').trim();
  return raw || '';
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : String(event.body || '');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function wantsJson(event) {
  const accept = String(event.headers?.accept || event.headers?.Accept || '').toLowerCase();
  const xhr = String(event.headers?.['x-requested-with'] || event.headers?.['X-Requested-With'] || '');
  return accept.includes('application/json') || xhr === 'XMLHttpRequest';
}

async function handleGet(event) {
  const token = tokenFromEvent(event);
  if (token) {
    const loaded = await loadTechQuickOpsToken(token);
    if (!loaded.ok) {
      return wantsJson(event)
        ? json(loaded.statusCode || 400, { ok: false, error: 'invalid' })
        : neutralExpiredPage('ops');
    }
    const session = await createTechQuickOpsSession({ bookingId: loaded.bookingId });
    if (!session.ok) {
      return wantsJson(event)
        ? json(503, { ok: false, error: 'session_unavailable' })
        : neutralExpiredPage('ops');
    }
    const cookie = sessionCookieHeader(session.sessionId, { secure: !isLocalDev(event) });
    return {
      statusCode: 302,
      headers: {
        Location: '/tech/q',
        'Set-Cookie': cookie,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
      body: '',
    };
  }

  const session = await loadTechQuickOpsSession(event);
  if (!session.ok) {
    return wantsJson(event)
      ? json(401, { ok: false, error: 'invalid' })
      : neutralExpiredPage('ops');
  }
  const projected = await loadProjectedBooking(session.bookingId);
  if (!projected.ok) {
    return wantsJson(event)
      ? json(400, { ok: false, error: 'invalid' })
      : neutralExpiredPage('ops');
  }
  if (wantsJson(event)) {
    return json(200, {
      ok: true,
      view: projected.view,
      csrfToken: session.csrfToken,
      bookingReads: projected.reads,
    });
  }
  return techQuickOpsPage(projected.view, session.csrfToken);
}

async function handlePost(event) {
  const session = await loadTechQuickOpsSession(event);
  if (!session.ok) return json(401, { ok: false, error: 'invalid' });
  if (!verifyTechQuickOpsCsrf(event, session)) {
    return json(403, { ok: false, error: 'csrf' });
  }
  const body = parseBody(event);
  const action = String(body.action || '').trim();
  const loaded = await loadProjectedBooking(session.bookingId);
  if (!loaded.ok) return json(400, { ok: false, error: 'invalid' });
  const booking = loaded.booking;
  const view = loaded.view || {};
  const actions = view.actions || {};
  const expectedBookingVersion = body.bookingVersion != null ? body.bookingVersion : booking.bookingVersion;

  if (FIELD_ACTIONS[action]) {
    const status = FIELD_ACTIONS[action];
    if (!actions[action]) {
      return json(409, {
        ok: false,
        error: view.locked ? 'locked' : 'invalid_status_transition',
        message: view.locked ? 'Job completed — locked' : 'That field action is not available',
      });
    }
    const result = await updateTechFieldStatus(booking, status, {
      expectedBookingVersion,
      note: body.note,
    });
    return json(result.ok ? 200 : (result.statusCode || 409), {
      ok: !!result.ok,
      idempotent: !!result.idempotent,
      reload: !!result.ok,
      jobStatus: result.jobStatus || status,
      message: result.ok
        ? (result.idempotent ? 'Already updated' : (FIELD_MESSAGES[status] || 'Updated'))
        : (result.error === 'locked' ? 'Job completed — locked' : (result.error || 'update_failed')),
    });
  }

  const moneyPrelude = ['complete', 'copy_pay', 'text_pay', 'record_cash', 'record_card'];
  if (moneyPrelude.includes(action)) {
    const prepared = await prepareTechMoney(booking, {
      amountMode: body.amountMode,
      amountDollars: body.amountDollars,
      amountCents: body.amountCents,
      notes: body.notes,
      expectedBookingVersion,
    });
    if (!prepared.ok) {
      const message = prepared.error === 'notes_required'
        ? 'Notes are required to change the amount'
        : prepared.error === 'amount_required' || prepared.error === 'invalid_amount'
          ? 'Enter how much to add or reduce'
          : prepared.error === 'decrease_exceeds_approved'
            ? 'Reduce cannot be more than the approved total'
            : prepared.error === 'version_conflict'
              ? 'Booking changed — reload and try again'
              : (prepared.error || 'Could not update amount');
      return json(prepared.statusCode || 400, { ok: false, error: prepared.error, message });
    }
    const current = prepared.booking;
    const nextVersion = current.bookingVersion;

    if (action === 'complete') {
      if (!actions.complete && !projectReadyToComplete(current)) {
        return json(409, {
          ok: false,
          error: view.locked ? 'locked' : 'not_ready_to_complete',
          message: view.locked ? 'Job completed — locked' : 'Arrive or start the job first',
        });
      }
      const result = await completeTechJob(current, { expectedBookingVersion: nextVersion });
      return json(result.ok ? 200 : (result.statusCode || 409), {
        ok: !!result.ok,
        idempotent: !!result.idempotent,
        reload: !!result.ok,
        jobStatus: result.jobStatus || null,
        message: result.ok
          ? (result.idempotent ? 'Already marked done' : 'Job closed')
          : (result.error || 'complete_failed'),
      });
    }

    if (action === 'copy_pay') {
      const result = await mintPaymentLink(current);
      if (!result.ok) {
        return json(result.statusCode || 409, {
          ok: false,
          error: result.error,
          message: result.error === 'zero_balance' ? 'Paid / No balance due' : 'Payment link unavailable',
        });
      }
      return json(200, {
        ok: true,
        payUrl: result.payUrl,
        reused: result.reused,
        reload: !prepared.unchanged,
        message: 'Payment link ready',
      });
    }

    if (action === 'text_pay') {
      const result = await textCustomer(current, { kind: 'payment' });
      if (result.ok && (result.queued || result.idempotent) && projectReadyToComplete(current)) {
        await completeIfReady(current, { expectedBookingVersion: current.bookingVersion });
      }
      return json(result.ok ? 200 : (result.statusCode || 400), {
        ok: !!result.ok,
        queued: !!result.queued,
        idempotent: !!result.idempotent,
        payUrl: result.payUrl || null,
        reload: true,
        message: result.queued || result.idempotent
          ? 'Payment link texted'
          : (result.reason === 'booking_sms_consent_required' ? 'Customer SMS consent required' : (result.reason || result.error || 'not sent')),
      });
    }

    if (action === 'record_cash' || action === 'record_card') {
      const allowed = action === 'record_cash' ? (actions.cash || prepared.amountMode !== 'original') : (actions.card || prepared.amountMode !== 'original');
      if (!allowed && !(prepared.viewMoney && prepared.viewMoney.remainingCents > 0)) {
        return json(409, {
          ok: false,
          error: 'zero_balance',
          message: 'Paid / No balance due',
        });
      }
      const result = await recordOnSitePayment(current, {
        method: action === 'record_cash' ? 'cash' : 'card_on_site',
        expectedBookingVersion: current.bookingVersion,
        reason: body.notes || (action === 'record_cash' ? 'tech_quick_ops_cash' : 'tech_quick_ops_card'),
      });
      if (!result.ok) {
        const message = result.error === 'postgres_payment_disabled'
          ? 'On-site payment recording is unavailable'
          : result.error === 'zero_balance' || result.error === 'already_paid'
            ? 'Paid / No balance due'
            : result.error === 'version_conflict'
              ? 'Booking changed — reload and try again'
              : 'Could not record payment';
        return json(result.statusCode || 409, { ok: false, error: result.error, message });
      }
      const fresh = await reloadBooking(session.bookingId);
      if (fresh.ok) {
        await completeIfReady(fresh.booking, { expectedBookingVersion: fresh.booking.bookingVersion });
      }
      return json(200, {
        ok: true,
        reload: true,
        method: action === 'record_cash' ? 'cash' : 'card',
        message: action === 'record_cash' ? 'Cash recorded' : 'Card recorded',
      });
    }
  }

  return json(400, { ok: false, error: 'unknown_action' });
}

function projectReadyToComplete(booking) {
  const { projectTechQuickOpsBooking } = require('../lib/tech-quick-ops-view');
  return !!(projectTechQuickOpsBooking(booking).actions || {}).complete;
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  }
  if (event.httpMethod === 'GET') return handleGet(event);
  if (event.httpMethod === 'POST') return handlePost(event);
  return { statusCode: 405, body: '' };
};

exports.tokenFromEvent = tokenFromEvent;
exports.TOKEN_PREFIX = TOKEN_PREFIX;
