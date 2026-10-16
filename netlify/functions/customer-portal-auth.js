// Customer portal authentication — email magic link / OTP (SMS optional).

const crypto = require('crypto');
const { jsonCors } = require('../lib/tech-security');
const { refuseSharedWrite } = require('../lib/preview-write-guard');
const { phonesMatch, normalizeUsPhoneDigits } = require('../lib/phone-auth');
const {
  hashToken,
  createAccountSession,
  storeAuthChallenge,
  consumeAuthChallenge,
  invalidateAuthChallenge,
  resolveChallengeStore,
  authChallengeStoreIsIsolated,
  validateCustomerSession,
  revokeCustomerSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  resendConfigured,
  twilioOtpEnabled,
  MAGIC_LINK_TTL_MS,
} = require('../lib/customer-session');
const { enforcePublicRateLimit, hashRateLimitSubject } = require('../lib/public-rate-limit');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
const {
  resolveOrCreateCustomerAccount,
  backfillBookingsOnLogin,
} = require('../lib/customer-account-service');

async function sendMagicLinkEmail(email, linkUrl) {
  const { RESEND_API_KEY, RESEND_FROM, ADMIN_EMAIL } = process.env;
  if (!RESEND_API_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [email],
      subject: 'Your Cardetail1 My Garage sign-in link',
      text: `Sign in to My Garage:\n\n${linkUrl}\n\nThis link expires in 15 minutes and can only be used once.\n\nIf you did not request this, ignore this email.`,
      reply_to: ADMIN_EMAIL || undefined,
    }),
  });
  return res.ok;
}

/**
 * A booking is attached to a magic link only when its email is the address the
 * link is sent to. Phone alone never matches. When the customer also typed a
 * phone, that phone has to belong to the same booking. Bookings with no email
 * fail closed.
 */
function bookingMatchesVerifiedContact(booking, { email, phoneDigits } = {}) {
  const emailNorm = String(email || '').trim().toLowerCase();
  const phone = normalizeUsPhoneDigits(phoneDigits || '');
  const bEmail = String(booking && (booking.email || '')).trim().toLowerCase();
  const bPhone = normalizeUsPhoneDigits((booking && (booking.phone || booking.customerPhone)) || '');
  if (!emailNorm || !bEmail || bEmail !== emailNorm) return false;
  if (phone && (!bPhone || !phonesMatch(phone, bPhone))) return false;
  return true;
}

function bookingsForContact({ email, phoneDigits }) {
  const emailNorm = String(email || '').trim().toLowerCase();
  // The mirror lookup is a superset (phone OR email). Attach only AND-safe rows
  // that are still a live submitted booking. Drafts and archived rows do not
  // authorize a sign-in link.
  const { listBookingsForIdentity } = require('../lib/booking-history');
  return listBookingsForIdentity({ email: emailNorm, phone: phoneDigits }).then(({ bookings: all }) =>
    all.filter((b) =>
      isVisibleSubmittedBooking(b)
      && bookingMatchesVerifiedContact(b, { email: emailNorm, phoneDigits })
    )
  );
}

function genericStartOk() {
  return jsonCors(200, {
    ok: true,
    delivery: 'email',
    expiresInSec: Math.floor(MAGIC_LINK_TTL_MS / 1000),
    smsOtpAvailable: twilioOtpEnabled(),
  });
}

function authUnavailable() {
  return jsonCors(503, {
    ok: false,
    error: 'service_unavailable',
    message: 'Full account access is temporarily unavailable. Use booking lookup or call/text (551) 389-3986.',
    fallback: 'call_text',
  });
}

function magicLinkUrl(challengeId, rawToken) {
  const { trustedSiteOrigin } = require('../lib/trusted-site-origin');
  const base = trustedSiteOrigin();
  return `${base}/my-garage.html?auth=${encodeURIComponent(challengeId)}&t=${encodeURIComponent(rawToken)}`;
}

function sharedPreviewMustNotIssue() {
  const { deployContext } = require('../lib/trusted-site-origin');
  const ctx = deployContext();
  if (ctx !== 'deploy-preview' && ctx !== 'branch-deploy') return false;
  return !authChallengeStoreIsIsolated();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error' }); }

  const action = String(body.action || 'start').toLowerCase();

  if (action !== 'session') {
    const previewRefusal = refuseSharedWrite('customer-auth');
    if (previewRefusal) return jsonCors(previewRefusal.statusCode, JSON.parse(previewRefusal.body));
  }

  if (action === 'session') {
    const session = await validateCustomerSession(event);
    if (!session.ok) return jsonCors(200, { ok: false, authenticated: false });
    return jsonCors(200, {
      ok: true,
      authenticated: true,
      scope: session.scope,
      exp: session.exp,
      // Safe account id only — never Stripe / contact / session internals.
      customerAccountId: session.customerAccountId || null,
    });
  }

  if (action === 'logout') {
    await revokeCustomerSession(event);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Set-Cookie': clearSessionCookieHeader(),
      },
      body: JSON.stringify({ ok: true }),
    };
  }

  if (action === 'verify') {
    const rateLimit = await enforcePublicRateLimit(event, {
      endpoint: 'customer-portal-auth',
      action: 'verify',
      cors: true,
      subject: hashRateLimitSubject(String(body.challengeId || '')),
      failClosed: true,
    });
    if (rateLimit.blocked) return rateLimit.response;

    const token = String(body.token || body.code || '').trim();
    const challengeId = String(body.challengeId || '').trim();
    if (!token || !challengeId) {
      return jsonCors(400, { ok: false, error: 'validation_error' });
    }

    let consumed;
    try {
      consumed = await consumeAuthChallenge(challengeId, hashToken(token), { expectedType: 'magic_link' });
    } catch {
      return authUnavailable();
    }
    if (!consumed.ok) {
      return jsonCors(200, { ok: false, error: 'authentication_failed' });
    }
    const challenge = consumed.challenge;

    const matches = await bookingsForContact({
      email: challenge.email,
      phoneDigits: challenge.phoneDigits,
    });
    const bookingIds = matches.map((b) => b.id || b.bookingId).filter(Boolean);
    const phoneDigits = challenge.phoneDigits || null;
    void body.customerAccountId;
    void body.browserCustomerAccountId;
    void body.email;
    void body.phone;

    let customerAccountId = challenge.customerAccountId || null;
    try {
      const resolution = await resolveOrCreateCustomerAccount({
        verifiedEmail: challenge.email,
        verifiedPhone: phoneDigits,
        bookingIds,
        firstName: matches[0]?.firstName,
        lastName: matches[0]?.lastName,
        browserCustomerAccountId: null,
      }, {
        allowPhoneOnly: false,
        createIfMissing: true,
        trustSessionAccountId: false,
        acceptBrowserAccountId: false,
      });
      if (challenge.customerAccountId) {
        const resolvedId = resolution && resolution.customerAccountId;
        const identityDown = !resolution || resolution.error === 'prisma_unavailable' || resolution.status === 'unavailable';
        if (resolvedId && resolvedId !== challenge.customerAccountId) {
          return jsonCors(200, { ok: false, error: 'authentication_failed' });
        }
        customerAccountId = resolvedId || (identityDown ? challenge.customerAccountId : null);
        if (!customerAccountId) {
          return jsonCors(200, { ok: false, error: 'authentication_failed' });
        }
      } else if (resolution && resolution.ok && resolution.customerAccountId) {
        customerAccountId = resolution.customerAccountId;
      }
      if (customerAccountId) {
        await backfillBookingsOnLogin({
          customerAccountId,
          verifiedEmail: challenge.email,
          verifiedPhone: phoneDigits,
          bookingIds,
          blobBookings: matches,
        });
      }
    } catch {
      if (challenge.customerAccountId) customerAccountId = challenge.customerAccountId;
    }

    let sessionToken;
    try {
      ({ token: sessionToken } = await createAccountSession({
        phoneDigits,
        email: challenge.email,
        bookingIds,
        customerAccountId,
      }));
    } catch {
      return authUnavailable();
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookieHeader(sessionToken),
      },
      body: JSON.stringify({
        ok: true,
        authenticated: true,
        bookingCount: bookingIds.length,
        customerAccountId: customerAccountId || null,
      }),
    };
  }

  // start
  // Anti-enumeration: identical success shape whether or not a match exists.
  // Never disclose account existence; never log raw tokens or the magic link.
  const email = String(body.email || '').trim().toLowerCase();
  const phoneDigits = normalizeUsPhoneDigits(body.phone || body.customerPhone || '');
  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'customer-portal-auth',
    action: 'start',
    cors: true,
    subject: hashRateLimitSubject(email, phoneDigits || ''),
    failClosed: true,
  });
  if (rateLimit.blocked) return rateLimit.response;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonCors(400, { ok: false, error: 'validation_error', message: 'A valid email is required.' });
  }

  if (!resendConfigured()) return authUnavailable();
  if (sharedPreviewMustNotIssue()) {
    console.info('[customer-portal-auth] start', { result: 'withheld' });
    return genericStartOk();
  }

  try {
    const store = await resolveChallengeStore();
    await store.get('auth-availability-probe', { type: 'json' });
  } catch {
    console.info('[customer-portal-auth] start', { result: 'unavailable' });
    return authUnavailable();
  }

  const matches = await bookingsForContact({ email, phoneDigits });
  let destination = matches.length
    ? String(matches[0].email || '').trim().toLowerCase()
    : '';
  const destinationOwned = destination
    && destination === email
    && matches.every((b) => String(b.email || '').trim().toLowerCase() === destination);

  if (!destinationOwned) {
    console.info('[customer-portal-auth] start', { result: 'withheld' });
    return genericStartOk();
  }

  let boundAccountId = null;
  try {
    const resolution = await resolveOrCreateCustomerAccount({
      verifiedEmail: destination,
      verifiedPhone: phoneDigits || null,
      bookingIds: matches.map((b) => b.id || b.bookingId).filter(Boolean),
      browserCustomerAccountId: null,
    }, {
      allowPhoneOnly: false,
      createIfMissing: false,
      trustSessionAccountId: false,
      acceptBrowserAccountId: false,
    });
    if (resolution && (resolution.status === 'ambiguous' || resolution.ambiguity)) {
      console.info('[customer-portal-auth] start', { result: 'withheld' });
      return genericStartOk();
    }
    if (resolution && resolution.ok && resolution.customerAccountId) {
      boundAccountId = resolution.customerAccountId;
    }
  } catch {
    boundAccountId = null;
  }

  const rawToken = crypto.randomBytes(24).toString('base64url');
  let challengeId;
  try {
    challengeId = await storeAuthChallenge({
      type: 'magic_link',
      email: destination,
      phoneDigits: phoneDigits || null,
      codeOrTokenHash: hashToken(rawToken),
      customerAccountId: boundAccountId,
    });
  } catch {
    console.info('[customer-portal-auth] start', { result: 'withheld' });
    return genericStartOk();
  }

  const linkUrl = magicLinkUrl(challengeId, rawToken);
  let sent = false;
  try {
    sent = await sendMagicLinkEmail(destination, linkUrl);
  } catch {
    sent = false;
  }
  if (!sent) {
    await invalidateAuthChallenge(challengeId);
    console.info('[customer-portal-auth] start', { result: 'withheld' });
    return genericStartOk();
  }

  console.info('[customer-portal-auth] start', { result: 'sent' });
  return genericStartOk();
};

exports.bookingMatchesVerifiedContact = bookingMatchesVerifiedContact;
