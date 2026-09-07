// Exchange opaque appointment access tokens for a normal Customer Portal session.
// GET  ?token=... or ?t=... → validate only (prefetch-safe confirm page, or re-entry)
// POST { action:'exchange', token } → consume + session cookie + redirect
// POST { action:'resend', token } → supersede token + re-send notification (anti-enumeration)
// Spent unexpired SMS links mint a new session when the visitor has none, so a
// second tap (in-app browser / no cookie) still opens the appointment.

'use strict';

const crypto = require('crypto');
const { jsonCors } = require('../lib/tech-security');
const { getBookingRecord } = require('../lib/booking-repository');
const { patchBooking } = require('../lib/ops-db');
const {
  linkBookingToAccountDurably,
  allocateResendGeneration,
  LINK_RESULT,
} = require('../lib/appointment-booking-linkage');
const {
  loadTokenRecord,
  consumeAppointmentAccessToken,
  ensureAppointmentPublicRef,
  buildPortalFocusPath,
  PURPOSE_APPOINTMENT_ACCESS,
  CONSUME_RESULT,
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
const { enforcePublicRateLimit, hashRateLimitSubject } = require('../lib/public-rate-limit');
const { isActionRequiredState } = require('../lib/booking-customer-status');

function correlationId() {
  return `caa_${crypto.randomBytes(6).toString('hex')}`;
}

function htmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function htmlPage({ title, bodyHtml, statusCode = 200 }) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
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

function resendForm(token) {
  return `
<form method="POST" action="/.netlify/functions/customer-appointment-access" style="display:inline">
  <input type="hidden" name="action" value="resend"/>
  <input type="hidden" name="token" value="${htmlAttr(token)}"/>
  <button class="btn" type="submit">Send me a new link</button>
</form>`;
}

/** Email magic-link is the customer login. Appointment-code lookup is support-only. */
function emailSignInLink({ primary = false } = {}) {
  const cls = primary ? 'btn' : 'btn ghost';
  return `<a class="${cls}" href="/my-garage#account-access">Email me a sign-in link</a>`;
}

function returnToPortalLink({ primary = false } = {}) {
  const cls = primary ? 'btn' : 'btn ghost';
  return `<a class="${cls}" href="/my-garage#account-access">Return to portal sign in</a>`;
}

function lookupSupportLink() {
  return `<a class="btn ghost" href="/my-garage#lookup">Have an appointment code from support?</a>`;
}

function invalidLinkPage(cid) {
  return htmlPage({
    title: 'Invalid link',
    statusCode: 400,
    bodyHtml: `
<h1>This secure link is invalid</h1>
<p>The appointment link could not be used. It may be incorrect or no longer valid. Sign in with the email on your booking — you do not need an appointment code.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  ${emailSignInLink({ primary: true })}
  ${lookupSupportLink()}
</div>`,
  });
}

function expiredLinkPage(token, cid) {
  return htmlPage({
    title: 'Link expired',
    statusCode: 410,
    bodyHtml: `
<h1>This secure link has expired</h1>
<p>For your security, appointment links expire after a limited time. Request a new link below, or sign in with the email on your booking.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  ${resendForm(token)}
  ${emailSignInLink()}
  ${lookupSupportLink()}
</div>`,
  });
}

/**
 * Spent (consumed) link without a matching device session.
 * Distinct from TTL expiry so customers are not told a fresh link "expired".
 */
function usedLinkPage(token, cid) {
  return htmlPage({
    title: 'Link already used',
    statusCode: 410,
    bodyHtml: `
<h1>This secure link was already used</h1>
<p>For your security, each appointment link opens once. After the first successful open, return via My Garage on this device, email yourself a sign-in link, or request a new appointment link below.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  ${resendForm(token)}
  ${emailSignInLink()}
  ${lookupSupportLink()}
</div>`,
  });
}

/**
 * Prefetch-safe gate: GET never consumes. Real humans POST from this form.
 * Email scanners that only fetch the URL leave the token usable.
 * Exchange then lands on /my-garage?appointment= (portal home, signed in).
 */
function confirmOpenPage(token, cid) {
  return htmlPage({
    title: 'Open your portal',
    statusCode: 200,
    bodyHtml: `
<h1>Open your detailing portal</h1>
<p>Confirm below to sign in. You will land on your portal with this appointment in focus — next service, balance, and rebook. This extra step protects your link from automatic email scanners.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  <form method="POST" action="/.netlify/functions/customer-appointment-access" style="display:inline">
    <input type="hidden" name="action" value="exchange"/>
    <input type="hidden" name="token" value="${htmlAttr(token)}"/>
    <button class="btn" type="submit">Open my portal</button>
  </form>
  ${returnToPortalLink()}
</div>`,
  });
}

function temporaryUnavailablePage(cid) {
  return htmlPage({
    title: 'Temporarily unavailable',
    statusCode: 503,
    bodyHtml: `
<h1>Please try again</h1>
<p>We could not open this appointment link right now. Your link was not used up — try again in a moment, or sign in with the email on your booking.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  ${returnToPortalLink({ primary: true })}
</div>`
  });
}

function sessionFailedPage(token, cid) {
  return htmlPage({
    title: 'Could not open portal',
    statusCode: 503,
    bodyHtml: `
<h1>Could not open your portal</h1>
<p>Something went wrong while signing you in. Request a new secure link below, or email yourself a sign-in link.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  ${resendForm(token)}
  ${emailSignInLink()}
</div>`,
  });
}

async function loadBooking(bookingId) {
  const id = String(bookingId || '').trim();
  if (!id) return null;
  const record = await getBookingRecord(id).catch(() => null);
  return record && record.exists ? record.booking : null;
}

/**
 * Persist a booking patch through the versioned repository. Never an
 * unconditional set — a lost update here would drop admin/ops state.
 */
async function patchBookingFields(bookingId, patches, eventEntry) {
  const id = String(bookingId || '').trim();
  if (!id) return null;
  return patchBooking(id, patches, eventEntry).catch(() => null);
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

/**
 * Same-device re-entry for a spent or expired link.
 *
 * The raw token stays single-use — no session is minted here. A customer who
 * still holds a valid session that owns this booking is simply sent to the
 * appointment; everyone else gets the matching recovery page.
 */
async function redirectSpentWithSession(event, booking, tokenRecord, cid, rawToken, { reason }) {
  const session = await validateCustomerSession(event);
  const bookingAccountId = String(booking.customerAccountId || '').trim() || null;
  // A booking that has since been claimed by another account must not be
  // reachable through an old token, however valid the visitor's own session is.
  const ownerMismatch = session.ok
    && bookingAccountId
    && session.customerAccountId
    && session.customerAccountId !== bookingAccountId;
  const sameAccount = session.ok
    && !ownerMismatch
    && tokenRecord.customerAccountId
    && session.customerAccountId === tokenRecord.customerAccountId;
  const sameBooking = session.ok
    && !ownerMismatch
    && Array.isArray(session.bookingIds)
    && session.bookingIds.map(String).includes(String(tokenRecord.bookingId));
  if (sameAccount || sameBooking) {
    const refResult = await ensureAppointmentPublicRef(booking);
    if (refResult.created) {
      await patchBookingFields(booking.id || booking.bookingId, {
        appointmentPublicRef: refResult.booking.appointmentPublicRef,
        appointmentPublicRefAt: refResult.booking.appointmentPublicRefAt,
      });
    }
    return {
      statusCode: 302,
      headers: {
        Location: buildPortalFocusPath(refResult.focusRef),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
      body: '',
    };
  }
  return reason === 'expired'
    ? expiredLinkPage(rawToken, cid)
    : usedLinkPage(rawToken, cid);
}

/**
 * Mint a portal session for this booking. Used after the first consume, and
 * again for later taps of the same unexpired SMS link (iMessage previews and
 * in-app browsers otherwise show "already used").
 */
async function issueAppointmentSession(booking, tokenRecord, cid, rawToken) {
  const phoneDigits = normalizeUsPhoneDigits(booking.phone || booking.customerPhone || '')
    || tokenRecord.phoneDigits
    || null;
  const email = String(booking.email || '').trim().toLowerCase() || null;
  const bookingId = booking.id || booking.bookingId;
  const existingBookingAccountId = String(booking.customerAccountId || '').trim() || null;

  if (
    tokenRecord.customerAccountId
    && existingBookingAccountId
    && tokenRecord.customerAccountId !== existingBookingAccountId
  ) {
    return invalidLinkPage(cid);
  }

  let customerAccountId = tokenRecord.customerAccountId || existingBookingAccountId;
  try {
    const resolution = await resolveOrCreateCustomerAccount({
      verifiedEmail: email,
      email,
      verifiedPhone: phoneDigits,
      phone: phoneDigits,
      bookingIds: [bookingId],
      stripeCustomerId: booking.stripeCustomerId || null,
    }, {
      allowPhoneOnly: !email && !!phoneDigits,
      createIfMissing: true,
      trustSessionAccountId: false,
      acceptBrowserAccountId: false,
    });
    if (resolution.ok && resolution.customerAccountId) {
      if (
        tokenRecord.customerAccountId
        && tokenRecord.customerAccountId !== resolution.customerAccountId
      ) {
        return invalidLinkPage(cid);
      }
      customerAccountId = resolution.customerAccountId;
      try {
        const { tryGetPrisma } = require('../lib/prisma');
        const prisma = tryGetPrisma();
        if (prisma) {
          await linkBookingToAccount(prisma, {
            bookingId,
            customerAccountId,
          }).catch(() => null);
        }
      } catch { /* ignore */ }
      await backfillBookingsOnLogin({
        customerAccountId,
        verifiedEmail: email,
        verifiedPhone: phoneDigits,
        bookingIds: [bookingId],
        blobBookings: [booking],
      }).catch(() => null);
    }
  } catch {
    // Session can still be created from booking contact when Prisma is unavailable.
  }

  if (customerAccountId) {
    const linkage = await linkBookingToAccountDurably({
      bookingId,
      customerAccountId,
    });
    if (!linkage.ok && linkage.result === LINK_RESULT.OWNED_BY_OTHER_ACCOUNT) {
      console.warn('[customer-appointment-access] link refused', {
        correlationId: cid,
        bookingIdPrefix: String(bookingId).slice(0, 12),
        reason: linkage.result,
      });
      return invalidLinkPage(cid);
    }
  }

  let bookingIds = [bookingId].filter(Boolean);
  if (customerAccountId) {
    try {
      const linked = await listBookingIdsForAccount(customerAccountId);
      if (Array.isArray(linked) && linked.length) {
        bookingIds = [...new Set([...bookingIds, ...linked])].slice(0, 50);
      }
    } catch { /* ignore */ }
  }

  let sessionToken;
  try {
    ({ token: sessionToken } = await createAccountSession({
      phoneDigits,
      email,
      bookingIds,
      customerAccountId,
    }));
  } catch (e) {
    console.warn('[customer-appointment-access] session create failed', {
      correlationId: cid,
      error: String(e && e.message || e).slice(0, 160),
    });
    return sessionFailedPage(rawToken, cid);
  }

  const refResult = await ensureAppointmentPublicRef(await loadBooking(bookingId) || booking);
  if (refResult.created) {
    await patchBookingFields(bookingId, {
      appointmentPublicRef: refResult.booking.appointmentPublicRef,
      appointmentPublicRefAt: refResult.booking.appointmentPublicRefAt,
    });
  }

  return redirectWithSession(buildPortalFocusPath(refResult.focusRef), sessionToken);
}

/**
 * Spent unexpired SMS links stay usable until TTL. A live session for a
 * different account still cannot ride the token.
 */
async function resumeSpentAppointmentLink(event, booking, tokenRecord, cid, rawToken, { reason }) {
  const spent = await redirectSpentWithSession(
    event,
    booking,
    tokenRecord,
    cid,
    rawToken,
    { reason }
  );
  if (spent.statusCode === 302 || reason === 'expired') return spent;
  const session = await validateCustomerSession(event);
  if (session.ok) return spent;
  return issueAppointmentSession(booking, tokenRecord, cid, rawToken);
}

/**
 * GET entry: never consume. Live tokens get a confirm form; spent/expired
 * tokens may still re-enter on the same device session.
 *
 * Observational only: must not create, enqueue, or repair booking-created
 * admin/customer notifications. Those fire from submit-booking persist.
 */
async function beginAccess(rawToken, event) {
  const cid = correlationId();
  const loaded = await loadTokenRecord(rawToken, { allowExpired: true, allowConsumed: true });
  if (!loaded.record || loaded.classification === CONSUME_RESULT.INVALID) {
    return invalidLinkPage(cid);
  }

  if (loaded.classification === CONSUME_RESULT.EXPIRED || (loaded.expired && !loaded.consumed)) {
    const expiredBooking = loaded.record.purpose === PURPOSE_APPOINTMENT_ACCESS
      ? await loadBooking(loaded.record.bookingId)
      : null;
    if (!expiredBooking) return expiredLinkPage(rawToken, cid);
    return redirectSpentWithSession(
      event,
      expiredBooking,
      loaded.record,
      cid,
      rawToken,
      { reason: 'expired' }
    );
  }

  const booking = await loadBooking(loaded.record.bookingId);
  if (!booking || loaded.record.purpose !== PURPOSE_APPOINTMENT_ACCESS) {
    return invalidLinkPage(cid);
  }

  if (loaded.consumed || loaded.classification === CONSUME_RESULT.ALREADY_CONSUMED) {
    return resumeSpentAppointmentLink(
      event,
      booking,
      loaded.record,
      cid,
      rawToken,
      { reason: 'used' }
    );
  }

  return confirmOpenPage(rawToken, cid);
}

/**
 * POST exchange: ownership checks first, then atomic consume, then session.
 * Consume stays the concurrency gate so two POSTs cannot mint two sessions.
 *
 * Observational only: token consumption and session minting must not emit
 * booking.request_received / admin booking-alert notifications.
 */
async function exchangeToken(rawToken, event) {
  const cid = correlationId();
  const loaded = await loadTokenRecord(rawToken, { allowExpired: true, allowConsumed: true });
  if (!loaded.record || loaded.classification === CONSUME_RESULT.INVALID) {
    return invalidLinkPage(cid);
  }
  if (loaded.classification === CONSUME_RESULT.EXPIRED || (loaded.expired && !loaded.consumed)) {
    const expiredBooking = loaded.record.purpose === PURPOSE_APPOINTMENT_ACCESS
      ? await loadBooking(loaded.record.bookingId)
      : null;
    if (!expiredBooking) return expiredLinkPage(rawToken, cid);
    return redirectSpentWithSession(
      event,
      expiredBooking,
      loaded.record,
      cid,
      rawToken,
      { reason: 'expired' }
    );
  }

  const booking = await loadBooking(loaded.record.bookingId);
  if (!booking) {
    return invalidLinkPage(cid);
  }

  if (loaded.record.purpose !== PURPOSE_APPOINTMENT_ACCESS) {
    return invalidLinkPage(cid);
  }

  // Already consumed — reuse until TTL when the visitor is not on another account.
  if (loaded.consumed || loaded.classification === CONSUME_RESULT.ALREADY_CONSUMED) {
    return resumeSpentAppointmentLink(
      event,
      booking,
      loaded.record,
      cid,
      rawToken,
      { reason: 'used' }
    );
  }

  const tokenRecord = loaded.record;
  const phoneDigits = normalizeUsPhoneDigits(booking.phone || booking.customerPhone || '')
    || tokenRecord.phoneDigits
    || null;
  const email = String(booking.email || '').trim().toLowerCase() || null;

  const bookingId = booking.id || booking.bookingId;
  const existingBookingAccountId = String(booking.customerAccountId || '').trim() || null;

  // Ownership binding BEFORE consume so a refused exchange does not burn the link.
  if (
    tokenRecord.customerAccountId
    && existingBookingAccountId
    && tokenRecord.customerAccountId !== existingBookingAccountId
  ) {
    return invalidLinkPage(cid);
  }

  let customerAccountId = tokenRecord.customerAccountId || existingBookingAccountId;
  try {
    const resolution = await resolveOrCreateCustomerAccount({
      verifiedEmail: email,
      email,
      verifiedPhone: phoneDigits,
      phone: phoneDigits,
      bookingIds: [bookingId],
      stripeCustomerId: booking.stripeCustomerId || null,
    }, {
      allowPhoneOnly: !email && !!phoneDigits,
      createIfMissing: true,
      trustSessionAccountId: false,
      acceptBrowserAccountId: false,
    });
    if (resolution.ok && resolution.customerAccountId) {
      if (
        tokenRecord.customerAccountId
        && tokenRecord.customerAccountId !== resolution.customerAccountId
      ) {
        return invalidLinkPage(cid);
      }
      customerAccountId = resolution.customerAccountId;
      try {
        const { tryGetPrisma } = require('../lib/prisma');
        const prisma = tryGetPrisma();
        if (prisma) {
          await linkBookingToAccount(prisma, {
            bookingId,
            customerAccountId,
          }).catch(() => null);
        }
      } catch { /* ignore */ }
      await backfillBookingsOnLogin({
        customerAccountId,
        verifiedEmail: email,
        verifiedPhone: phoneDigits,
        bookingIds: [bookingId],
        blobBookings: [booking],
      }).catch(() => null);
    }
  } catch {
    // Session can still be created from booking contact when Prisma is unavailable.
  }

  // Durable ownership before consume — refused links must remain reusable.
  if (customerAccountId) {
    const linkage = await linkBookingToAccountDurably({
      bookingId,
      customerAccountId,
    });
    if (!linkage.ok && linkage.result === LINK_RESULT.OWNED_BY_OTHER_ACCOUNT) {
      console.warn('[customer-appointment-access] link refused', {
        correlationId: cid,
        bookingIdPrefix: String(bookingId).slice(0, 12),
        reason: linkage.result,
      });
      return invalidLinkPage(cid);
    }
  }

  let bookingIds = [bookingId].filter(Boolean);
  if (customerAccountId) {
    try {
      const linked = await listBookingIdsForAccount(customerAccountId);
      if (Array.isArray(linked) && linked.length) {
        bookingIds = [...new Set([...bookingIds, ...linked])].slice(0, 50);
      }
    } catch { /* ignore */ }
  }

  // Atomic consume gate — only the CAS winner may establish a new session.
  const consumed = await consumeAppointmentAccessToken(rawToken);
  if (consumed.classification === CONSUME_RESULT.STORAGE_UNAVAILABLE) {
    return temporaryUnavailablePage(cid);
  }
  if (consumed.classification === CONSUME_RESULT.EXPIRED) {
    return expiredLinkPage(rawToken, cid);
  }
  if (consumed.classification === CONSUME_RESULT.ALREADY_CONSUMED) {
    return resumeSpentAppointmentLink(
      event,
      booking,
      consumed.record || loaded.record,
      cid,
      rawToken,
      { reason: 'used' }
    );
  }
  if (consumed.classification !== CONSUME_RESULT.CONSUMED_SUCCESSFULLY || !consumed.ok) {
    return invalidLinkPage(cid);
  }

  let sessionToken;
  try {
    ({ token: sessionToken } = await createAccountSession({
      phoneDigits,
      email,
      bookingIds,
      customerAccountId,
    }));
  } catch (e) {
    console.warn('[customer-appointment-access] session create failed after consume', {
      correlationId: cid,
      error: String(e && e.message || e).slice(0, 160),
    });
    return sessionFailedPage(rawToken, cid);
  }

  const refResult = await ensureAppointmentPublicRef(await loadBooking(bookingId) || booking);
  if (refResult.created) {
    await patchBookingFields(bookingId, {
      appointmentPublicRef: refResult.booking.appointmentPublicRef,
      appointmentPublicRefAt: refResult.booking.appointmentPublicRefAt,
    });
  }

  return redirectWithSession(buildPortalFocusPath(refResult.focusRef), sessionToken);
}

const RESEND_GENERIC_MESSAGE =
  'If this link was valid, a new secure link has been sent when contact details are on file.';

function wantsHtmlResponse(event) {
  const accept = String(event.headers?.accept || event.headers?.Accept || '');
  const ctype = String(event.headers?.['content-type'] || event.headers?.['Content-Type'] || '');
  return accept.includes('text/html') || ctype.includes('application/x-www-form-urlencoded');
}

function resendGenericResponse(event, cid) {
  if (wantsHtmlResponse(event)) {
    return htmlPage({
      title: 'New link sent',
      bodyHtml: `
<h1>Check your messages</h1>
<p>If this appointment link was valid, a new secure link has been sent when contact details are on file. You can also sign in with the email on your booking.</p>
<div class="actions">
  ${returnToPortalLink({ primary: true })}
  ${lookupSupportLink()}
</div>
<p class="sub">Ref: ${cid}</p>`,
    });
  }
  return jsonCors(200, { ok: true, message: RESEND_GENERIC_MESSAGE, correlationId: cid });
}

/**
 * Event type for the resend body. Derived from the same customer-facing status
 * the portal renders, so a resent link never contradicts what the portal shows.
 */
function resendEventTypeFor(booking) {
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  const js = String(booking.jobStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  if (appt === 'confirmed' || js === 'confirmed' || st === 'confirmed') {
    return EVENT_CONFIRMED;
  }
  if (isActionRequiredState(booking)) {
    return EVENT_ACTION_REQUIRED;
  }
  return EVENT_REQUEST_RECEIVED;
}

/**
 * Resend a secure appointment link.
 *
 * Proof of ownership is required — either a token record we issued (expired or
 * consumed is fine) or an authenticated session for the same account/booking.
 * Raw booking IDs and email addresses from the browser are never accepted, and
 * every outcome returns the same generic copy.
 */
async function resendFromToken(rawToken, event) {
  const cid = correlationId();

  const loaded = await loadTokenRecord(rawToken, { allowExpired: true, allowConsumed: true });
  const tokenRecord = loaded.record && loaded.record.bookingId ? loaded.record : null;

  const session = await validateCustomerSession(event);
  const sessionProof = tokenRecord && session.ok && (
    (tokenRecord.customerAccountId && session.customerAccountId === tokenRecord.customerAccountId)
    || (Array.isArray(session.bookingIds)
      && session.bookingIds.map(String).includes(String(tokenRecord.bookingId)))
  );

  if (!tokenRecord) {
    console.log('[appointment-access-resend]', {
      correlationId: cid,
      proof: 'none',
      outcome: 'generic_no_proof',
    });
    return resendGenericResponse(event, cid);
  }

  // Abuse controls beyond the endpoint-level IP limit: bind attempts to the
  // token/booking and to the account/contact fingerprint.
  const bookingFingerprint = hashRateLimitSubject('appointment-resend-booking', tokenRecord.bookingId);
  const contactFingerprint = hashRateLimitSubject(
    'appointment-resend-contact',
    tokenRecord.customerAccountId || '',
    tokenRecord.emailHash || '',
    tokenRecord.phoneDigits || ''
  );
  for (const subject of [bookingFingerprint, contactFingerprint]) {
    if (!subject) continue;
    const limited = await enforcePublicRateLimit(event, {
      endpoint: 'customer-appointment-access',
      action: 'resend',
      cors: true,
      subject,
      // Fingerprint buckets must survive IP rotation; the endpoint-level check
      // above already covers per-source-IP abuse.
      ipScoped: false,
    });
    if (limited.blocked) {
      console.log('[appointment-access-resend]', {
        correlationId: cid,
        proof: sessionProof ? 'token+session' : 'token',
        outcome: 'rate_limited',
      });
      return resendGenericResponse(event, cid);
    }
  }

  const booking = await loadBooking(tokenRecord.bookingId);
  if (!booking) {
    console.log('[appointment-access-resend]', {
      correlationId: cid,
      proof: 'token',
      outcome: 'generic_no_booking',
    });
    return resendGenericResponse(event, cid);
  }

  // A booking claimed by another account must not be re-notified through a
  // stale token.
  const bookingAccountId = String(booking.customerAccountId || '').trim() || null;
  if (
    tokenRecord.customerAccountId
    && bookingAccountId
    && tokenRecord.customerAccountId !== bookingAccountId
  ) {
    console.log('[appointment-access-resend]', {
      correlationId: cid,
      proof: 'token',
      outcome: 'generic_ownership_mismatch',
    });
    return resendGenericResponse(event, cid);
  }

  const allocation = await allocateResendGeneration({ bookingId: tokenRecord.bookingId });
  if (!allocation.ok || !allocation.generation) {
    console.log('[appointment-access-resend]', {
      correlationId: cid,
      proof: sessionProof ? 'token+session' : 'token',
      outcome: 'generation_unavailable',
    });
    return resendGenericResponse(event, cid);
  }

  const working = allocation.booking || booking;
  const eventType = resendEventTypeFor(working);
  const result = await emitBookingNotification(working, eventType, {
    event,
    source: 'appointment_access_resend',
    resendGeneration: allocation.generation,
  });

  if (result.ok && result.booking) {
    await patchBookingFields(tokenRecord.bookingId, {
      transactionalNotifications: result.booking.transactionalNotifications,
      lastTransactionalNotificationAt: result.booking.lastTransactionalNotificationAt,
      lastTransactionalNotificationEvent: result.booking.lastTransactionalNotificationEvent,
      appointmentPublicRef: result.booking.appointmentPublicRef,
    });
  }

  console.log('[appointment-access-resend]', {
    correlationId: cid,
    proof: sessionProof ? 'token+session' : 'token',
    eventType,
    resendGeneration: allocation.generation,
    generationReused: allocation.reused === true,
    tokenIssued: !!result.accessToken,
    emailOutcome: result.delivery?.email?.sent
      ? 'sent'
      : (result.delivery?.email?.reason || (result.skipped ? result.reason : 'not_attempted')),
    outcome: 'processed',
  });

  return resendGenericResponse(event, cid);
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

function firstNonEmpty(...values) {
  for (const value of values) {
    const s = String(value == null ? '' : value).trim();
    if (s) return s;
  }
  return '';
}

/** Accept ?token= (legacy SMS) and ?t= (short /a?t= SMS). */
function accessTokenFromEvent(event, body = null) {
  const qs = event.queryStringParameters || {};
  const rawQuery = new URLSearchParams(event.rawQuery || '');
  return firstNonEmpty(
    body && body.token,
    body && body.t,
    qs.token,
    qs.t,
    rawQuery.get('token'),
    rawQuery.get('t')
  );
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
      const token = accessTokenFromEvent(event);
      if (!token) return invalidLinkPage(cid);
      return beginAccess(token, event);
    }

    if (event.httpMethod === 'POST') {
      const body = parseBody(event);
      const action = String(body.action || 'exchange').toLowerCase();
      const token = accessTokenFromEvent(event, body);
      if (action === 'resend') {
        return resendFromToken(token, event);
      }
      if (action === 'exchange' && token) {
        return exchangeToken(token, event);
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
<p>Please try again, or sign in with the email on your booking. You do not need an appointment code.</p>
<p class="sub">Ref: ${cid}</p>
<div class="actions">
  ${returnToPortalLink({ primary: true })}
</div>`,
    });
  }
};

// Test seam
exports.__test = {
  beginAccess,
  exchangeToken,
  resendFromToken,
  invalidLinkPage,
  expiredLinkPage,
  usedLinkPage,
  confirmOpenPage,
  temporaryUnavailablePage,
  sessionFailedPage,
};
