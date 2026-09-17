'use strict';

const { getBookingRecord } = require('../lib/booking-repository');
const { looksLikePayToken, loadPaymentResumeToken } = require('../lib/payment-resume-token');
const { moneyFromBooking, dollarsFromCents } = require('../lib/admin-quick-ops-view');
const { bookingStatus } = require('../lib/admin-quick-ops-view');
const { prepareEmbeddedPayment, getSharedFinancialProjection } = require('../lib/db/operational-payment');
const { canPayBalance } = require('../lib/appointment-status-policy');
const { chrome, neutralExpiredPage, paymentPage } = require('../lib/quick-ops-html');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
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

function tokenFromEvent(event, body = {}) {
  const path = pathFrom(event);
  const parts = path.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (looksLikePayToken(last)) return last;
  const query = event.queryStringParameters || {};
  const raw = String(body.token || query.t || query.token || '').trim();
  return looksLikePayToken(raw) ? raw : '';
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : String(event.body || '');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function authorizePay(rawToken) {
  const loaded = await loadPaymentResumeToken(rawToken);
  if (!loaded.ok) return loaded;
  const rec = await getBookingRecord(loaded.bookingId);
  if (!rec.exists || !rec.booking) return { ok: false, error: 'invalid', statusCode: 400 };
  if (bookingStatus(rec.booking) === 'cancelled') {
    return { ok: false, error: 'invalid', statusCode: 400 };
  }
  let shared = null;
  try {
    shared = await getSharedFinancialProjection(rec.booking);
  } catch {
    shared = null;
  }
  const money = moneyFromBooking(rec.booking, shared);
  if (money.quoteVersion !== loaded.quoteVersion) {
    return {
      ok: false,
      error: 'stale_quote_version',
      statusCode: 409,
      message: 'Payment details changed. Request a new payment link.',
    };
  }
  if (!(money.remainingCents > 0)) {
    return { ok: false, error: 'zero_balance', statusCode: 409, message: 'Paid / No balance due' };
  }
  const allowed = typeof canPayBalance === 'function' ? canPayBalance(rec.booking) : { ok: true };
  if (allowed && allowed.ok === false) {
    return { ok: false, error: allowed.error || 'cannot_pay', statusCode: 409 };
  }
  return { ok: true, booking: rec.booking, money, token: loaded };
}

async function handleGet(event) {
  const token = tokenFromEvent(event);
  if (!token) return neutralExpiredPage('pay');
  const auth = await authorizePay(token);
  if (!auth.ok) {
    if (auth.error === 'stale_quote_version' || auth.error === 'zero_balance') {
      return chrome({
        title: 'Payment unavailable',
        statusCode: auth.statusCode || 409,
        body: `<section class="card"><h1>${auth.error === 'zero_balance' ? 'Paid / No balance due' : 'Payment details changed'}</h1><p class="sub">${auth.message || 'Request a new payment link.'}</p></section>`,
      });
    }
    return neutralExpiredPage('pay');
  }
  return paymentPage({
    amountLabel: dollarsFromCents(auth.money.remainingCents),
  });
}

async function handlePost(event) {
  const body = parseBody(event);
  const token = tokenFromEvent(event, body);
  const auth = await authorizePay(token);
  if (!auth.ok) {
    return json(auth.statusCode || 400, {
      ok: false,
      error: auth.error || 'invalid',
      message: auth.message || 'Payment link expired or invalid',
    });
  }
  const action = String(body.action || 'intent').trim();
  if (action === 'status') {
    return json(200, {
      ok: true,
      remainingCents: auth.money.remainingCents,
      quoteVersion: auth.money.quoteVersion,
    });
  }
  if (action !== 'intent') return json(400, { ok: false, error: 'unknown_action' });
  const prepared = await prepareEmbeddedPayment({
    booking: auth.booking,
    expectedQuoteVersion: auth.token.quoteVersion,
  });
  if (!prepared.ok) {
    const stale = prepared.error === 'stale_quote_version';
    return json(prepared.statusCode || 409, {
      ok: false,
      error: prepared.error,
      message: stale
        ? 'Payment details changed. Request a new payment link.'
        : (prepared.error === 'zero_balance' || prepared.error === 'already_paid'
          ? 'Paid / No balance due'
          : 'Payment unavailable'),
    });
  }
  return json(200, {
    ok: true,
    clientSecret: prepared.clientSecret,
    customerSessionClientSecret: prepared.customerSessionClientSecret || null,
    amountCents: prepared.amountCents,
    quoteVersion: prepared.quoteVersion || auth.token.quoteVersion,
  });
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
exports.authorizePay = authorizePay;
