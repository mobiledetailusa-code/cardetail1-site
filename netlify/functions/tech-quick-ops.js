'use strict';

const {
  looksLikeTechToken,
  loadTechQuickOpsToken,
  createTechQuickOpsSession,
  loadTechQuickOpsSession,
  sessionCookieHeader,
  isLocalDev,
  verifyTechQuickOpsCsrf,
} = require('../lib/tech-quick-ops-token');
const { loadProjectedBooking, mintPaymentLink, textCustomer, recordOnSitePayment } = require('../lib/admin-quick-ops-actions');
const { projectTechQuickOpsBooking } = require('../lib/tech-quick-ops-view');
const { neutralExpiredPage, techQuickOpsPage } = require('../lib/quick-ops-html');
const { ensureFreelanceJobClosed } = require('../lib/quick-ops-tech-close');

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
  const tIdx = parts.lastIndexOf('t');
  if (tIdx >= 0 && parts[tIdx + 1] && looksLikeTechToken(parts[tIdx + 1])) return parts[tIdx + 1];
  const last = parts[parts.length - 1] || '';
  if (looksLikeTechToken(last)) return last;
  const query = event.queryStringParameters || {};
  const raw = String(query.t || query.token || '').trim();
  return looksLikeTechToken(raw) ? raw : '';
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

function sessionMatchesBooking(session, booking) {
  if (!booking || booking.assignmentKind !== 'freelance' || booking.quickOpsTechClose !== true) return false;
  return String(booking.freelancePhone || '') === String(session.phoneE164 || '');
}

async function present(session, event) {
  const projected = await loadProjectedBooking(session.bookingId);
  if (!projected.ok || !sessionMatchesBooking(session, projected.booking)) {
    return wantsJson(event)
      ? json(401, { ok: false, error: 'invalid' })
      : neutralExpiredPage('ops');
  }
  const view = projectTechQuickOpsBooking(projected.booking, projected.shared);
  if (wantsJson(event)) {
    return json(200, { ok: true, view, csrfToken: session.csrfToken });
  }
  return techQuickOpsPage(view, session.csrfToken);
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
    const projected = await loadProjectedBooking(loaded.bookingId);
    if (!projected.ok || !sessionMatchesBooking(loaded, projected.booking)) {
      return wantsJson(event)
        ? json(401, { ok: false, error: 'invalid' })
        : neutralExpiredPage('ops');
    }
    const session = await createTechQuickOpsSession({
      bookingId: loaded.bookingId,
      phoneE164: loaded.phoneE164,
    });
    if (!session.ok) {
      return wantsJson(event)
        ? json(503, { ok: false, error: 'session_unavailable' })
        : neutralExpiredPage('ops');
    }
    const cookie = sessionCookieHeader(session.sessionId, { secure: !isLocalDev(event) });
    return {
      statusCode: 302,
      headers: {
        Location: '/ops/t',
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
  return present(session, event);
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
  if (!loaded.ok || !sessionMatchesBooking(session, loaded.booking)) {
    return json(401, { ok: false, error: 'invalid' });
  }
  const booking = loaded.booking;
  const view = projectTechQuickOpsBooking(booking, loaded.shared);
  const actions = view.actions || {};

  if (action === 'record_cash' || action === 'record_card') {
    const allowed = action === 'record_cash' ? actions.cash : actions.card;
    if (!allowed) {
      return json(409, { ok: false, error: 'zero_balance', message: 'Paid / No balance due' });
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
      return json(result.statusCode || 409, { ok: false, error: result.error, message });
    }
    await ensureFreelanceJobClosed(session.bookingId).catch(() => {});
    return json(200, {
      ok: true,
      reload: true,
      message: action === 'record_cash' ? 'Cash recorded. Job closed if the balance is paid.' : 'Card recorded. Job closed if the balance is paid.',
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
    return json(200, {
      ok: true,
      payUrl: result.payUrl,
      message: 'Payment link ready. The job closes when the customer pays.',
    });
  }
  if (action === 'text_pay') {
    const result = await textCustomer(booking, { kind: 'payment' });
    return json(result.ok ? 200 : (result.statusCode || 400), {
      ok: !!result.ok,
      queued: !!result.queued,
      message: result.queued || result.idempotent
        ? 'Payment link texted. The job closes when the customer pays.'
        : (result.reason === 'booking_sms_consent_required' ? 'Customer SMS consent required' : (result.reason || result.error || 'not sent')),
    });
  }
  if (action === 'adjust_price') {
    if (!actions.adjust) {
      return json(409, { ok: false, error: 'locked', message: 'This job cannot be repriced' });
    }
    const { adjustQuickOpsPrice } = require('../lib/quick-ops-price');
    const result = await adjustQuickOpsPrice(booking, {
      type: body.type,
      amountDollars: body.amountDollars,
      amountCents: body.amountCents,
      reason: body.reason,
      actorId: 'tech_quick_ops',
    });
    return json(result.ok ? 200 : (result.statusCode || 409), {
      ok: !!result.ok,
      reload: !!result.ok,
      message: result.message || result.error || 'Could not change the price',
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
