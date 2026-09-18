/**
 * Best-effort operational alerts for stability incidents that do not roll back
 * the authoritative booking commit (index lag, payment quarantine, reconcile fail).
 *
 * Always logs a structured warning. Optionally emails ADMIN_EMAIL and/or queues
 * an admin SMS when consent + destination are configured.
 */

'use strict';

const crypto = require('crypto');

const ALERT_KINDS = Object.freeze({
  CHANGE_REQUEST_INDEX_LAG: 'change_request_index_lag',
  PAYMENT_RECONCILE_QUARANTINED: 'payment_reconcile_quarantined',
  PAYMENT_RECONCILE_FAILED: 'payment_reconcile_failed',
});

function enabled(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 48);
}

function alertSubject(kind, bookingId) {
  const ref = safeId(bookingId) || 'unknown';
  switch (kind) {
    case ALERT_KINDS.CHANGE_REQUEST_INDEX_LAG:
      return `Ops alert — change-request index lag (${ref})`;
    case ALERT_KINDS.PAYMENT_RECONCILE_QUARANTINED:
      return `Ops alert — payment reconcile quarantined (${ref})`;
    case ALERT_KINDS.PAYMENT_RECONCILE_FAILED:
      return `Ops alert — payment reconcile failed (${ref})`;
    default:
      return `Ops alert — ${safeId(kind) || 'stability'} (${ref})`;
  }
}

function alertBody(kind, bookingId, detail, meta) {
  const lines = [
    'Cardetail1 operational stability alert.',
    '',
    `Kind: ${kind}`,
    `Booking: ${safeId(bookingId) || 'n/a'}`,
    `Detail: ${String(detail || '').slice(0, 240)}`,
    `At: ${new Date().toISOString()}`,
  ];
  if (meta && typeof meta === 'object') {
    const keys = Object.keys(meta).slice(0, 8);
    for (const key of keys) {
      lines.push(`${key}: ${String(meta[key]).slice(0, 120)}`);
    }
  }
  lines.push('', 'Authoritative booking state was preserved; investigate secondary index / payment reconcile.');
  return lines.join('\n');
}

async function sendAdminEmail(kind, bookingId, detail, meta, opts = {}) {
  const env = opts.env || process.env;
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const to = String(env.ADMIN_EMAIL || '').trim();
  const from = String(env.RESEND_FROM || '').trim();
  if (!apiKey) return { sent: false, skipped: true, reason: 'email_not_configured' };
  if (!to) return { sent: false, skipped: true, reason: 'no_admin_email' };

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const subject = alertSubject(kind, bookingId);
  const text = alertBody(kind, bookingId, detail, meta);
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from || 'Detailing Zone <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) return { sent: false, reason: `provider_${res.status}` };
    return { sent: true };
  } catch {
    return { sent: false, reason: 'network_error' };
  }
}

async function enqueueAdminStabilitySms(kind, bookingId, detail, opts = {}) {
  const env = opts.env || process.env;
  if (!enabled(env.ADMIN_SMS_CONSENT_GRANTED)) {
    return { queued: false, skipped: true, reason: 'admin_sms_consent_required' };
  }
  try {
    const { normalizeUsPhoneE164 } = require('./phone-auth');
    const { enqueueSms, smsSafeIdempotencyKey } = require('./sms-outbox');
    const { TEMPLATE_KEYS } = require('./sms-templates');
    const toE164 = normalizeUsPhoneE164(env.ADMIN_SMS || '');
    if (!toE164) return { queued: false, skipped: true, reason: 'admin_sms_destination_missing' };

    const fingerprint = crypto
      .createHash('sha256')
      .update(`${kind}|${bookingId || ''}|${detail || ''}`)
      .digest('hex')
      .slice(0, 16);
    const idempotencyKey = smsSafeIdempotencyKey(
      `ops.stability:${safeId(kind)}:${safeId(bookingId)}:${fingerprint}`
    );

    return enqueueSms({
      idempotencyKey,
      audience: 'admin',
      consentGranted: true,
      toE164,
      bookingId: bookingId || null,
      templateKey: TEMPLATE_KEYS.ADMIN_STABILITY,
      templateData: {
        alertKind: kind,
        bookingRef: safeId(bookingId),
        detail: String(detail || '').slice(0, 120),
      },
    }, { prisma: opts.prisma, env });
  } catch (err) {
    return { queued: false, error: String(err && err.message || err).slice(0, 80) };
  }
}

/**
 * Report a stability incident. Never throws to callers.
 */
async function reportOpsStabilityAlert({
  kind,
  bookingId = '',
  detail = '',
  meta = null,
  email = true,
  sms = true,
} = {}, opts = {}) {
  const alertKind = String(kind || 'stability').trim() || 'stability';
  const payload = {
    kind: alertKind,
    bookingId: safeId(bookingId) || null,
    detail: String(detail || '').slice(0, 240),
    meta: meta && typeof meta === 'object' ? meta : undefined,
    at: new Date().toISOString(),
  };
  try {
    console.warn('[ops-stability-alert]', JSON.stringify(payload));
  } catch {
    console.warn('[ops-stability-alert]', alertKind, bookingId, detail);
  }

  const result = { logged: true, email: null, sms: null };
  if (email) {
    try {
      result.email = await sendAdminEmail(alertKind, bookingId, detail, meta, opts);
    } catch (err) {
      result.email = { sent: false, reason: 'email_throw', error: String(err && err.message || err).slice(0, 80) };
    }
  }
  if (sms) {
    try {
      result.sms = await enqueueAdminStabilitySms(alertKind, bookingId, detail, opts);
    } catch (err) {
      result.sms = { queued: false, error: String(err && err.message || err).slice(0, 80) };
    }
  }
  return result;
}

module.exports = {
  ALERT_KINDS,
  reportOpsStabilityAlert,
  alertSubject,
  alertBody,
};
