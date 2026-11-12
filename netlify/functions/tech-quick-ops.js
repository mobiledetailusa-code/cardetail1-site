'use strict';

const {
  looksLikeTechToken,
  loadTechQuickOpsToken,
  consumeTechQuickOpsToken,
  createTechQuickOpsSession,
  loadTechQuickOpsSession,
  sessionCookieHeader,
  isLocalDev,
  verifyTechQuickOpsCsrf,
} = require('../lib/tech-quick-ops-token');
const {
  loadProjectedBooking,
  mintPaymentLink,
  textCustomer,
  paymentLinkMessage,
  recordTechnicianArrival,
  recordTechnicianOnTheWay,
  recordTechnicianJobDone,
  offerExtraToCustomer,
} = require('../lib/admin-quick-ops-actions');
const { projectTechQuickOpsBooking } = require('../lib/tech-quick-ops-view');
const { neutralExpiredPage, techQuickOpsPage, techOpenJobPage } = require('../lib/quick-ops-html');

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
  if (!booking || !booking.techQuickOpsTokenHash) return false;
  const phone = String(session && session.phoneE164 || '');
  if (!phone) return false;
  const kind = String(booking.assignmentKind || '');
  if (kind === 'freelance') {
    return booking.quickOpsTechClose === true && String(booking.freelancePhone || '') === phone;
  }
  if (kind === 'registered') {
    return !!booking.assignedTechId && String(booking.techLinkPhone || '') === phone;
  }
  return false;
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

async function checkToken(token) {
  const loaded = await loadTechQuickOpsToken(token);
  if (!loaded.ok) return { ok: false, statusCode: loaded.statusCode || 400 };
  const projected = await loadProjectedBooking(loaded.bookingId);
  if (!projected.ok || !sessionMatchesBooking(loaded, projected.booking)) {
    return { ok: false, statusCode: 401 };
  }
  return { ok: true, loaded };
}

/**
 * Spend the one-time link and start the technician session.
 * statusCode 302 for the JSON GET path, 303 after the HTML "Open job" form.
 */
async function openWithToken(event, token, statusCode) {
  const checked = await checkToken(token);
  if (!checked.ok) {
    return wantsJson(event)
      ? json(checked.statusCode, { ok: false, error: 'invalid' })
      : neutralExpiredPage('ops');
  }
  const { loaded } = checked;
  const consumed = await consumeTechQuickOpsToken(token);
  if (!consumed.ok) {
    return wantsJson(event)
      ? json(401, { ok: false, error: 'invalid' })
      : neutralExpiredPage('ops');
  }
  const session = await createTechQuickOpsSession({
    bookingId: loaded.bookingId,
    phoneE164: loaded.phoneE164,
    linkExpiresAt: loaded.expiresAt,
  });
  if (!session.ok) {
    return wantsJson(event)
      ? json(503, { ok: false, error: 'session_unavailable' })
      : neutralExpiredPage('ops');
  }
  const cookie = sessionCookieHeader(session.sessionId, {
    secure: !isLocalDev(event),
    expiresAt: session.expiresAt,
  });
  return {
    statusCode,
    headers: {
      Location: '/ops/t',
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
    body: '',
  };
}

async function handleGet(event) {
  const token = tokenFromEvent(event);
  if (token) {
    if (wantsJson(event)) return openWithToken(event, token, 302);
    // A browser GET only checks the link and shows an "Open job" button.
    // SMS apps fetch links for previews; spending the one-time link on a GET
    // locked technicians out before they ever tapped it.
    const checked = await checkToken(token);
    if (!checked.ok) return neutralExpiredPage('ops');
    return techOpenJobPage(token);
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
  const openToken = tokenFromEvent(event);
  if (openToken) return openWithToken(event, openToken, 303);
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
      message: 'Payment link ready. Paying does not complete the job.',
    });
  }
  if (action === 'text_pay') {
    const result = await textCustomer(booking, { kind: 'payment' });
    const failed = !result.ok || result.delivery === 'failed' || result.delivery === 'suppressed';
    return json(failed ? (result.statusCode || 409) : 200, {
      ok: !failed,
      delivery: result.delivery || (failed ? 'failed' : 'pending'),
      message: paymentLinkMessage(result),
    });
  }
  if (action === 'arrive') {
    if (!actions.arrive) {
      return json(409, { ok: false, error: 'locked', message: 'This job is closed.' });
    }
    const result = await recordTechnicianArrival(booking);
    if (!result.ok) {
      return json(result.statusCode || 409, {
        ok: false,
        error: result.error,
        message: result.message || 'Could not record arrival',
      });
    }
    const fresh = projectTechQuickOpsBooking(result.booking, loaded.shared);
    return json(200, {
      ok: true,
      delivery: result.delivery,
      idempotent: !!result.idempotent,
      bookingVersion: result.bookingVersion,
      view: fresh,
      message: result.message,
    });
  }
  if (action === 'on_the_way') {
    if (!actions.onTheWay) {
      return json(409, { ok: false, error: 'locked', message: 'On the way is already recorded or the job is closed.' });
    }
    const result = await recordTechnicianOnTheWay(booking, { etaMinutes: body.etaMinutes });
    if (!result.ok) {
      return json(result.statusCode || 409, {
        ok: false,
        error: result.error,
        message: result.message || 'Could not save on the way',
      });
    }
    return json(200, {
      ok: true,
      delivery: result.delivery,
      idempotent: !!result.idempotent,
      bookingVersion: result.bookingVersion,
      view: projectTechQuickOpsBooking(result.booking, loaded.shared),
      message: result.message,
    });
  }
  if (action === 'job_done') {
    if (!actions.done) {
      return json(409, { ok: false, error: 'locked', message: 'This job is already done or closed.' });
    }
    const result = await recordTechnicianJobDone(booking);
    if (!result.ok) {
      return json(result.statusCode || 409, {
        ok: false,
        error: result.error,
        message: result.message || 'Could not mark the job done',
      });
    }
    return json(200, {
      ok: true,
      idempotent: !!result.idempotent,
      bookingVersion: result.bookingVersion,
      view: projectTechQuickOpsBooking(result.booking, loaded.shared),
      message: result.message,
    });
  }
  if (action === 'adjust_price') {
    if (!actions.increase || String(body.type || 'increase') !== 'increase') {
      return json(400, { ok: false, error: 'increase_only', message: 'You can add an extra for customer approval' });
    }
    const { recordTechExtra } = require('../lib/quick-ops-price');
    const result = await recordTechExtra(booking, {
      amountDollars: body.amountDollars,
      amountCents: body.amountCents,
      reason: body.reason,
      actorId: 'tech_quick_ops',
    });
    if (!result.ok) {
      return json(result.statusCode || 409, {
        ok: false,
        error: result.error,
        message: result.message || 'Could not add the extra',
      });
    }
    const offer = await offerExtraToCustomer(result.booking, result.adjustment);
    return json(200, {
      ok: true,
      pending: true,
      idempotent: !!result.idempotent,
      bookingVersion: offer.bookingVersion || result.bookingVersion,
      delivery: offer.delivery || 'failed',
      yourPayLabel: view.yourPay && view.yourPay.set ? view.yourPay.label : null,
      message: offer.message || result.message,
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
