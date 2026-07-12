// Customer portal authentication — email magic link / OTP (SMS optional).

const crypto = require('crypto');
const { jsonCors, blobsStore } = require('../lib/tech-security');
const { listRawBookings } = require('../lib/ops-db');
const { phonesMatch, normalizeUsPhoneDigits } = require('../lib/phone-auth');
const {
  hashToken,
  createAccountSession,
  storeAuthChallenge,
  validateCustomerSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  resendConfigured,
  twilioOtpEnabled,
  MAX_AUTH_ATTEMPTS,
  MAGIC_LINK_TTL_MS,
} = require('../lib/customer-session');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

const CHALLENGE_STORE = 'cd1-customer-auth-tokens';

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

function bookingsForContact({ email, phoneDigits }) {
  const emailNorm = String(email || '').trim().toLowerCase();
  return listRawBookings().then((all) =>
    all.filter((b) => {
      const bPhone = normalizeUsPhoneDigits(b.phone || b.customerPhone || '');
      const bEmail = String(b.email || '').trim().toLowerCase();
      if (phoneDigits && bPhone && phonesMatch(phoneDigits, bPhone)) return true;
      if (emailNorm && bEmail && bEmail === emailNorm) return true;
      return false;
    })
  );
}

function siteBaseUrl(event) {
  const host = event.headers?.['x-forwarded-host'] || event.headers?.Host || 'cardetail1.com';
  const proto = String(event.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error' }); }

  const action = String(body.action || 'start').toLowerCase();

  if (action === 'session') {
    const session = await validateCustomerSession(event);
    if (!session.ok) return jsonCors(200, { ok: false, authenticated: false });
    return jsonCors(200, {
      ok: true,
      authenticated: true,
      scope: session.scope,
      exp: session.exp,
    });
  }

  if (action === 'logout') {
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
    const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'customer-portal-auth', action: 'verify', cors: true });
    if (rateLimit.blocked) return rateLimit.response;

    const token = String(body.token || body.code || '').trim();
    const challengeId = String(body.challengeId || '').trim();
    if (!token || !challengeId) {
      return jsonCors(400, { ok: false, error: 'validation_error' });
    }

    const store = await blobsStore(CHALLENGE_STORE);
    const challenge = await store.get(challengeId, { type: 'json' }).catch(() => null);
    if (!challenge || challenge.used) {
      return jsonCors(200, { ok: false, error: 'authentication_failed' });
    }
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
      return jsonCors(200, { ok: false, error: 'authentication_failed', message: 'This link has expired.' });
    }
    if ((challenge.attempts || 0) >= MAX_AUTH_ATTEMPTS) {
      return jsonCors(200, { ok: false, error: 'authentication_failed', message: 'Too many attempts.' });
    }

    const tokenHash = hashToken(token);
    if (tokenHash !== challenge.hash) {
      await store.setJSON(challengeId, { ...challenge, attempts: (challenge.attempts || 0) + 1 });
      return jsonCors(200, { ok: false, error: 'authentication_failed' });
    }

    await store.setJSON(challengeId, { ...challenge, used: true, usedAt: new Date().toISOString() });

    const matches = await bookingsForContact({
      email: challenge.email,
      phoneDigits: challenge.phoneDigits,
    });
    const bookingIds = matches.map((b) => b.id || b.bookingId).filter(Boolean);
    const phoneDigits = challenge.phoneDigits || normalizeUsPhoneDigits(matches[0]?.phone || matches[0]?.customerPhone || '');

    const { token: sessionToken } = await createAccountSession({
      phoneDigits,
      email: challenge.email,
      bookingIds,
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookieHeader(sessionToken),
      },
      body: JSON.stringify({ ok: true, authenticated: true, bookingCount: bookingIds.length }),
    };
  }

  // start
  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'customer-portal-auth', action: 'start', cors: true });
  if (rateLimit.blocked) return rateLimit.response;

  const email = String(body.email || '').trim().toLowerCase();
  const phoneDigits = normalizeUsPhoneDigits(body.phone || body.customerPhone || '');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonCors(400, { ok: false, error: 'validation_error', message: 'A valid email is required.' });
  }

  if (!resendConfigured()) {
    return jsonCors(503, {
      ok: false,
      error: 'service_unavailable',
      message: 'Full account access is temporarily unavailable. Use booking lookup or call/text 551-313-2956.',
      fallback: 'call_text',
    });
  }

  const matches = await bookingsForContact({ email, phoneDigits });
  if (!matches.length) {
    return jsonCors(200, {
      ok: false,
      error: 'authentication_failed',
      message: 'We could not find an account with that email. Try booking lookup or call/text us.',
    });
  }

  const rawToken = crypto.randomBytes(24).toString('base64url');
  const challengeId = await storeAuthChallenge({
    type: 'magic_link',
    email,
    phoneDigits: phoneDigits || normalizeUsPhoneDigits(matches[0]?.phone || ''),
    codeOrTokenHash: hashToken(rawToken),
  });

  const linkUrl = `${siteBaseUrl(event)}/my-garage.html?auth=${encodeURIComponent(challengeId)}&t=${encodeURIComponent(rawToken)}`;
  const sent = await sendMagicLinkEmail(email, linkUrl);
  if (!sent) {
    return jsonCors(503, {
      ok: false,
      error: 'service_unavailable',
      message: 'Could not send sign-in email. Please call/text 551-313-2956.',
      fallback: 'call_text',
    });
  }

  return jsonCors(200, {
    ok: true,
    challengeId,
    delivery: 'email',
    expiresInSec: Math.floor(MAGIC_LINK_TTL_MS / 1000),
    smsOtpAvailable: twilioOtpEnabled(),
  });
};
