// Exchange opaque appointment access tokens for a normal Customer Portal session.
// GET  ?token=...  → validate, session cookie, redirect to /my-garage?appointment=<focusRef>
// POST { action:'resend', token } → supersede token + re-send notification (anti-enumeration)

'use strict';

const crypto = require('crypto');
const { jsonCors, blobsStore } = require('../lib/tech-security');
const { BOOKINGS_STORE } = require('../lib/ops-schema');
const {
  loadTokenRecord,
  consumeAppointmentAccessToken,
  ensureAppointmentPublicRef,
  buildPortalFocusUrl,
  PURPOSE_APPOINTMENT_ACCESS,
} = require('../lib/appointment-access-token');
const {
  createAccountSession,
  sessionCookieHeader,
  validateCustomerSession,
  normalizeUsPhoneDigits,
} = require('../lib/customer-session');
const {
  resolveOrCreateCustomerAccount,
  linkBookingToAccount,
  backfillBookingsOnLogin,
  listBookingIdsForAccount,
} = require('../lib/customer-account-service');
const {
  emitBookingNotification,
  EVENT_REQUEST_RECEIVED,
  EVENT_CONFIRMED,
  EVENT_ACTION_REQUIRED,
} = require('../lib/booking-transactional-notifications');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

function correlationId() {
  return `caa_${crypto.randomBytes(6).toString('hex')}`;
}

function htmlPage({ title, bodyHtml, statusCode = 200 }) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
body{font-family:Georgia,serif;background:#f6f3ee;color:#14201c;margin:0;padding:32px 18px}
.card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #d7d0c4;border-radius:12px;padding:28px}
h1{font-size:1.35rem;margin:0 0 12px}
p{line-height:1.5;margin:0 0 14px}
a.btn,button.btn{display:inline-block;background:#0b3d2e;color:#fff;text-decoration:none;border:0;padding:12px 16px;border-radius:8px;font:inherit;cursor:pointer;margin:4px 6px 4px 0}
a.ghost,button.ghost{background:transparent;color:#0b3d2e;border:1px solid #0b3d2e}
.actions{margin-top:18px}
.sub{font-size:.92rem;color:#4a5852}
</style>
</head><body><div class="card">${bodyHtml}</div></body></html>`;
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
    body: html,
  };
}

function invalidLinkPage(cid) {
  return htmlPage({
    title: 'Invalid link',
    statusCode: 400,
    bodyHtml: `
<h1>This secure link is invalid</h1>
<p>The appointment link could not be used. It may be incorrect or no longer valid.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  <a class="btn" href="/my-garage">Return to portal sign in</a>
  <a class="btn ghost" href="/my-garage#lookup">Find appointment using code and phone</a>
</div>`,
  });
}

function expiredLinkPage(token, cid) {
  const safeAttr = String(token || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  return htmlPage({
    title: 'Link expired',
    statusCode: 410,
    bodyHtml: `
<h1>This secure link has expired</h1>
<p>For your security, appointment links expire after a limited time.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  <form method="POST" action="/.netlify/functions/customer-appointment-access" style="display:inline">
    <input type="hidden" name="action" value="resend"/>
    <input type="hidden" name="token" value="${safeAttr}"/>
    <button class="btn" type="submit">Send me a new link</button>
  </form>
  <a class="btn ghost" href="/my-garage#lookup">Find appointment using code and phone</a>
  <a class="btn ghost" href="/my-garage">Return to portal sign in</a>
</div>`,
  });
}

async function loadBooking(bookingId) {
  const store = await blobsStore(BOOKINGS_STORE);
  const id = String(bookingId || '').trim();
  if (!id) return null;
  return store.get(id, { type: 'json' }).catch(() => null);
}

async function persistBooking(booking) {
  const store = await blobsStore(BOOKINGS_STORE);
  const id = booking.id || booking.bookingId;
  if (!id) return;
  await store.setJSON(id, booking);
}

function redirectWithSession(location, sessionToken) {
  return {
    statusCode: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': sessionCookieHeader(sessionToken),
    },
    body: '',
  };
}

async function exchangeToken(rawToken, event) {
  const cid = correlationId();
  const loaded = await loadTokenRecord(rawToken, { allowExpired: true, allowConsumed: true });
  if (!loaded.ok && loaded.error === 'invalid_token') {
    return invalidLinkPage(cid);
  }
  if (loaded.expired && !loaded.consumed) {
    return expiredLinkPage(rawToken, cid);
  }

  const booking = await loadBooking(loaded.record?.bookingId);
  if (!booking) {
    return invalidLinkPage(cid);
  }

  // Already consumed: try existing session for the same account/booking, else offer resend.
  if (loaded.consumed) {
    const session = await validateCustomerSession(event);
    const sameAccount = session.ok
      && loaded.record.customerAccountId
      && session.customerAccountId === loaded.record.customerAccountId;
    const sameBooking = session.ok
      && Array.isArray(session.bookingIds)
      && session.bookingIds.map(String).includes(String(loaded.record.bookingId));
    if (sameAccount || sameBooking) {
      const refResult = await ensureAppointmentPublicRef(booking);
      if (refResult.created) await persistBooking(refResult.booking);
      const focusUrl = buildPortalFocusUrl(refResult.focusRef, event);
      return {
        statusCode: 302,
        headers: { Location: focusUrl, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
        body: '',
      };
    }
    return expiredLinkPage(rawToken, cid);
  }

  if (!loaded.ok) {
    return invalidLinkPage(cid);
  }

  if (loaded.record.purpose !== PURPOSE_APPOINTMENT_ACCESS) {
    return invalidLinkPage(cid);
  }

  // Ownership: resolve account from verified booking contact; do not trust browser ids.
  const phoneDigits = normalizeUsPhoneDigits(booking.phone || booking.customerPhone || '')
    || loaded.record.phoneDigits
    || null;
  const email = String(booking.email || '').trim().toLowerCase() || null;

  let customerAccountId = loaded.record.customerAccountId || booking.customerAccountId || null;
  try {
    const resolution = await resolveOrCreateCustomerAccount({
      verifiedEmail: email,
      email,
      verifiedPhone: phoneDigits,
      phone: phoneDigits,
      bookingIds: [booking.id || booking.bookingId],
      stripeCustomerId: booking.stripeCustomerId || null,
    }, {
      allowPhoneOnly: !email && !!phoneDigits,
      createIfMissing: true,
      trustSessionAccountId: false,
      acceptBrowserAccountId: false,
    });
    if (resolution.ok && resolution.customerAccountId) {
      // If token was bound to a different account, refuse (cross-account).
      if (
        loaded.record.customerAccountId
        && loaded.record.customerAccountId !== resolution.customerAccountId
      ) {
        return invalidLinkPage(cid);
      }
      customerAccountId = resolution.customerAccountId;
      try {
        const { tryGetPrisma } = require('../lib/prisma');
        const prisma = tryGetPrisma();
        if (prisma) {
          await linkBookingToAccount(prisma, {
            bookingId: booking.id || booking.bookingId,
            customerAccountId,
          }).catch(() => null);
        }
      } catch { /* ignore */ }
      await backfillBookingsOnLogin({
        customerAccountId,
        verifiedEmail: email,
        verifiedPhone: phoneDigits,
        bookingIds: [booking.id || booking.bookingId],
        blobBookings: [booking],
      }).catch(() => null);
    }
  } catch {
    // Session can still be created from booking contact when Prisma is unavailable.
  }

  const consumed = await consumeAppointmentAccessToken(rawToken);
  if (!consumed.ok) {
    if (consumed.error === 'expired_token') return expiredLinkPage(rawToken, cid);
    return invalidLinkPage(cid);
  }

  let bookingIds = [booking.id || booking.bookingId].filter(Boolean);
  if (customerAccountId) {
    try {
      const linked = await listBookingIdsForAccount(customerAccountId);
      if (Array.isArray(linked) && linked.length) {
        bookingIds = [...new Set([...bookingIds, ...linked])].slice(0, 50);
      }
    } catch { /* ignore */ }
  }

  const { token: sessionToken } = await createAccountSession({
    phoneDigits,
    email,
    bookingIds,
    customerAccountId,
  });

  const refResult = await ensureAppointmentPublicRef({
    ...booking,
    customerAccountId: customerAccountId || booking.customerAccountId || null,
  });
  if (refResult.created || customerAccountId) {
    await persistBooking({
      ...refResult.booking,
      customerAccountId: customerAccountId || refResult.booking.customerAccountId || null,
    }).catch(() => {});
  }

  const focusUrl = buildPortalFocusUrl(refResult.focusRef, event);
  return redirectWithSession(focusUrl, sessionToken);
}

async function resendFromToken(rawToken, event) {
  const cid = correlationId();
  // Anti-enumeration: always return a generic success-shaped response for API callers.
  const genericOk = {
    ok: true,
    message: 'If this link was valid, a new secure link has been sent when contact details are on file.',
    correlationId: cid,
  };

  const loaded = await loadTokenRecord(rawToken, { allowExpired: true, allowConsumed: true });
  if (!loaded.record || !loaded.record.bookingId) {
    return jsonCors(200, genericOk);
  }

  const booking = await loadBooking(loaded.record.bookingId);
  if (!booking) return jsonCors(200, genericOk);

  // Choose event type based on current authoritative status.
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  const js = String(booking.jobStatus || '').toLowerCase();
  let eventType = EVENT_REQUEST_RECEIVED;
  if (appt === 'confirmed' || js === 'confirmed' || String(booking.status || '').toLowerCase() === 'confirmed') {
    eventType = EVENT_CONFIRMED;
  } else if (
    String(booking.paymentWorkflowStatus || '').includes('customer')
    || booking.customerApprovalStatus === 'pending'
  ) {
    eventType = EVENT_ACTION_REQUIRED;
  }

  const result = await emitBookingNotification(booking, eventType, { event });
  if (result.ok && result.booking) {
    await persistBooking(result.booking).catch(() => {});
  }

  // HTML form posts get a friendly confirmation page.
  const accept = String(event.headers?.accept || event.headers?.Accept || '');
  if (accept.includes('text/html') || String(event.headers?.['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    return htmlPage({
      title: 'New link sent',
      bodyHtml: `
<h1>Check your messages</h1>
<p>If this appointment link was valid, a new secure link has been sent when contact details are on file.</p>
<div class="actions">
  <a class="btn" href="/my-garage">Return to portal sign in</a>
  <a class="btn ghost" href="/my-garage#lookup">Find appointment using code and phone</a>
</div>
<p class="sub">Ref: ${cid}</p>`,
    });
  }
  return jsonCors(200, genericOk);
}

function parseBody(event) {
  const raw = event.body || '';
  const ctype = String(event.headers?.['content-type'] || event.headers?.['Content-Type'] || '');
  if (ctype.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }
  try { return JSON.parse(raw || '{}'); }
  catch { return {}; }
}

exports.handler = async (event) => {
  const cid = correlationId();
  try {
    if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});

    const rateLimit = await enforcePublicRateLimit(event, {
      endpoint: 'customer-appointment-access',
      cors: true,
    });
    if (rateLimit.blocked) return rateLimit.response;

    if (event.httpMethod === 'GET') {
      const token = event.queryStringParameters?.token
        || new URLSearchParams(event.rawQuery || '').get('token');
      if (!token) return invalidLinkPage(cid);
      return exchangeToken(token, event);
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      const action = String(body.action || 'exchange').toLowerCase();
      if (action === 'resend') {
        return resendFromToken(body.token, event);
      }
      if (action === 'exchange' && body.token) {
        return exchangeToken(body.token, event);
      }
      return jsonCors(400, { ok: false, error: 'validation_error', correlationId: cid });
    }

    return jsonCors(405, { ok: false, error: 'method_not_allowed', correlationId: cid });
  } catch (e) {
    console.warn('[customer-appointment-access] error', { correlationId: cid, error: e.message });
    return htmlPage({
      title: 'Something went wrong',
      statusCode: 500,
      bodyHtml: `
<h1>Something went wrong</h1>
<p>Please try again or find your appointment using your code and phone.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  <a class="btn" href="/my-garage">Return to portal sign in</a>
</div>`,
    });
  }
};

// Test seam
exports.__test = {
  exchangeToken,
  resendFromToken,
  invalidLinkPage,
  expiredLinkPage,
};
