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
const { loadProjectedBooking, mintPaymentLink, textCustomer } = require('../lib/admin-quick-ops-actions');
const { projectTechQuickOpsBooking } = require('../lib/tech-quick-ops-view');
const { neutralExpiredPage, techQuickOpsPage } = require('../lib/quick-ops-html');
const { dollarsFromCents } = require('../lib/admin-quick-ops-view');

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
    const consumed = await consumeTechQuickOpsToken(token);
    if (!consumed.ok) {
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
    if (!actions.increase || String(body.type || 'increase') !== 'increase') {
      return json(400, { ok: false, error: 'increase_only', message: 'You can add an extra to the payment link' });
    }
    const { adjustQuickOpsPrice } = require('../lib/quick-ops-price');
    const result = await adjustQuickOpsPrice(booking, {
      type: 'increase',
      amountDollars: body.amountDollars,
      amountCents: body.amountCents,
      reason: body.reason,
      actorId: 'tech_quick_ops',
      payoutMode: 'add',
    });
    if (!result.ok) {
      return json(result.statusCode || 409, {
        ok: false,
        error: result.error,
        message: result.message || 'Could not add the extra',
      });
    }
    let delivery = { ok: false, queued: false, payUrl: null };
    try {
      delivery = await textCustomer(result.booking, { kind: 'payment' });
    } catch {
      delivery = { ok: false, queued: false, payUrl: null };
    }
    if (!delivery.payUrl) {
      try {
        const link = await mintPaymentLink(result.booking);
        if (link && link.ok) delivery.payUrl = link.payUrl;
      } catch { /* link can be sent again from the page */ }
    }
    const extra = dollarsFromCents(result.addedCents);
    const yourPayLabel = result.payout && result.payout.afterCents != null
      ? dollarsFromCents(result.payout.afterCents)
      : '';
    const payLine = yourPayLabel ? ` Your pay is ${yourPayLabel}.` : ' Your pay has not been set yet.';
    const sent = delivery.queued
      ? ' Updated payment link sent.'
      : (delivery.payUrl ? ' Updated payment link ready to forward.' : ' Send the payment link again in a moment.');
    return json(200, {
      ok: true,
      queued: !!delivery.queued,
      payUrl: delivery.payUrl || null,
      bookingVersion: result.bookingVersion,
      yourPayLabel: yourPayLabel || null,
      message: `Added ${extra}.${payLine}${sent}`,
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
