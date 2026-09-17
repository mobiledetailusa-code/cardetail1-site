'use strict';

const {
  TOKEN_PREFIX,
  looksLikeToken,
  loadQuickOpsToken,
  createQuickOpsSession,
  loadQuickOpsSession,
  sessionCookieHeader,
  isLocalDev,
  verifyQuickOpsCsrf,
} = require('../lib/admin-quick-ops-token');
const {
  loadProjectedBooking,
  confirmQuickOps,
  cancelQuickOps,
  decideQuickOps,
  mintPaymentLink,
  textCustomer,
  recordOnSitePayment,
} = require('../lib/admin-quick-ops-actions');
const { neutralExpiredPage, quickOpsPage } = require('../lib/quick-ops-html');

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
    const loaded = await loadQuickOpsToken(token);
    if (!loaded.ok) {
      return wantsJson(event)
        ? json(loaded.statusCode || 400, { ok: false, error: 'invalid' })
        : neutralExpiredPage('ops');
    }
    const session = await createQuickOpsSession({ bookingId: loaded.bookingId });
    if (!session.ok) {
      return wantsJson(event)
        ? json(503, { ok: false, error: 'session_unavailable' })
        : neutralExpiredPage('ops');
    }
    const cookie = sessionCookieHeader(session.sessionId, { secure: !isLocalDev(event) });
    return {
      statusCode: 302,
      headers: {
        Location: '/ops/q',
        'Set-Cookie': cookie,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
      body: '',
    };
  }

  const session = await loadQuickOpsSession(event);
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
  return quickOpsPage(projected.view, session.csrfToken);
}

async function handlePost(event) {
  const session = await loadQuickOpsSession(event);
  if (!session.ok) return json(401, { ok: false, error: 'invalid' });
  if (!verifyQuickOpsCsrf(event, session)) {
    return json(403, { ok: false, error: 'csrf' });
  }
  const body = parseBody(event);
  const action = String(body.action || '').trim();
  const loaded = await loadProjectedBooking(session.bookingId);
  if (!loaded.ok) return json(400, { ok: false, error: 'invalid' });
  const booking = loaded.booking;
  const view = loaded.view || {};
  const actions = view.actions || {};

  if (action === 'confirm') {
    if (view.paid || view.completed || view.locked) {
      return json(409, { ok: false, error: 'locked', message: 'Paid / completed — locked' });
    }
    const result = await confirmQuickOps(session.bookingId, { event });
    return json(result.ok ? 200 : (result.statusCode || 409), {
      ok: !!result.ok,
      idempotent: !!result.idempotent,
      reload: true,
      message: result.ok ? (result.idempotent ? 'Already confirmed' : 'Appointment confirmed') : (result.error || 'confirm_failed'),
    });
  }
  if (action === 'cancel') {
    if (view.paid || view.completed || view.locked) {
      return json(409, { ok: false, error: 'locked', message: 'Paid / completed — locked' });
    }
    const result = await cancelQuickOps(session.bookingId, { event });
    return json(result.ok ? 200 : (result.statusCode || 409), {
      ok: !!result.ok,
      idempotent: !!result.idempotent,
      reload: true,
      message: result.ok ? (result.idempotent ? 'Already canceled' : 'Appointment canceled') : (result.error || 'cancel_failed'),
    });
  }
  if (action === 'approve' || action === 'reject') {
    if (view.paid || view.completed || view.locked) {
      return json(409, { ok: false, error: 'locked', message: 'Paid / completed — locked' });
    }
    const result = await decideQuickOps(booking, action, { event });
    return json(result.ok ? 200 : (result.statusCode || 409), {
      ok: !!result.ok,
      idempotent: !!result.idempotent,
      reload: true,
      message: result.ok ? (result.idempotent ? 'Already decided' : `Request ${action}d`) : (result.error || 'decide_failed'),
    });
  }
  if (action === 'record_cash' || action === 'record_card') {
    const allowed = action === 'record_cash' ? actions.cash : actions.card;
    if (!allowed) {
      return json(409, {
        ok: false,
        error: view.paid || view.locked ? 'zero_balance' : 'locked',
        message: 'Paid / No balance due',
      });
    }
    const result = await recordOnSitePayment(booking, {
      method: action === 'record_cash' ? 'cash' : 'card_on_site',
      expectedBookingVersion: body.bookingVersion != null ? body.bookingVersion : booking.bookingVersion,
    });
    if (!result.ok) {
      const message = result.error === 'postgres_payment_disabled'
        ? 'On-site payment recording is unavailable'
        : result.error === 'zero_balance' || result.error === 'already_paid'
          ? 'Paid / No balance due'
          : result.error === 'version_conflict'
            ? 'Booking changed — reload and try again'
            : 'Could not record payment';
      return json(result.statusCode || 409, {
        ok: false,
        error: result.error,
        message,
      });
    }
    return json(200, {
      ok: true,
      reload: true,
      method: action === 'record_cash' ? 'cash' : 'card',
      message: action === 'record_cash' ? 'Cash recorded' : 'Card recorded',
    });
  }
  if (action === 'copy_pay') {
    const result = await mintPaymentLink(booking);
    if (!result.ok) {
      return json(result.statusCode || 409, {
        ok: false,
        error: result.error,
        message: result.error === 'zero_balance' ? 'Paid / No balance due' : 'Payment link unavailable',
      });
    }
    return json(200, { ok: true, payUrl: result.payUrl, reused: result.reused, message: 'Payment link ready' });
  }
  if (action === 'text_pay') {
    const result = await textCustomer(booking, { kind: 'payment' });
    return json(result.ok ? 200 : (result.statusCode || 400), {
      ok: !!result.ok,
      queued: !!result.queued,
      idempotent: !!result.idempotent,
      payUrl: result.payUrl || null,
      message: result.queued || result.idempotent
        ? 'Payment link texted'
        : (result.reason === 'booking_sms_consent_required' ? 'Customer SMS consent required' : (result.reason || result.error || 'not sent')),
    });
  }
  if (action === 'text') {
    const result = await textCustomer(booking, { kind: 'followup' });
    return json(result.ok ? 200 : (result.statusCode || 400), {
      ok: !!result.ok,
      queued: !!result.queued,
      idempotent: !!result.idempotent,
      message: result.queued || result.idempotent
        ? 'Follow-up text queued'
        : (result.reason === 'booking_sms_consent_required' ? 'Customer SMS consent required' : (result.reason || result.error || 'not sent')),
    });
  }
  return json(400, { ok: false, error: 'unknown_action' });
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
