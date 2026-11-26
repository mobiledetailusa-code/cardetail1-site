// netlify/functions/submit-inquiry.js
// Recebe uma dúvida do chat flutuante (handoff p/ humano) e notifica por e-mail
// (Resend) e SMS (Twilio). Mesmo padrão do submit-booking.js — sem deps npm.
// Also accepts structured vehicle quote requests (body.vehicle) for vehicles the
// online booking does not price. Every inquiry is validated and stored in the
// revenue-inquiries blob store (netlify/lib/vehicle-inquiry.js).
//
// Reaproveita as MESMAS variáveis de ambiente do submit-booking:
//   ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM, TWILIO_SID, TWILIO_TOKEN,
//   TWILIO_FROM, ADMIN_SMS

const crypto = require('crypto');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { refuseSharedWrite } = require('../lib/preview-write-guard');
// Loaded lazily at the call site: the SMS outbox pulls Prisma and the Twilio
// dependency graph, and a cold-start failure there returns a non-JSON 500 that
// the checkout cannot parse. Notifications must never gate the booking itself.
function smsOutbox() {
  return {
    enqueueSms: require('../lib/sms-outbox').enqueueSms,
    TEMPLATE_KEYS: require('../lib/sms-templates').TEMPLATE_KEYS,
  };
}
const { enabled } = require('../lib/twilio-runtime-policy');
const {
  buildInquiryRecord,
  processInquiry,
  vehicleSummaryLines,
} = require('../lib/vehicle-inquiry');

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  },
  body: JSON.stringify(body),
});

function inquiryText(q) {
  const vehicleLines = q.vehicle ? ['', 'Vehicle details:', ...vehicleSummaryLines(q.vehicle)] : [];
  return [
    `${q.vehicle ? 'NEW VEHICLE QUOTE REQUEST' : 'NEW CUSTOMER QUESTION'} — ${q.id}`,
    `Source: ${q.source || 'Chat widget'}`,
    ``,
    `Name:  ${q.name || ''}`,
    `Phone: ${q.phone || ''}`,
    `Email: ${q.email || '—'}`,
    ...(q.zip ? [`ZIP:   ${q.zip}`] : []),
    ...vehicleLines,
    ``,
    `Question:`,
    `${q.message || '(none)'}`,
  ].join('\n');
}

async function sendEmail(q) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return { sent: false, reason: 'email not configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // Defense in depth only: recovery never relies on it to resend.
      'Idempotency-Key': `inquiry-${q.id}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [ADMIN_EMAIL],
      reply_to: q.email || undefined,
      subject: `New Cardetail1 ${q.vehicle ? 'quote request' : 'question'} — ${q.name || 'Customer'} (${q.phone || ''})`,
      text: inquiryText(q),
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `resend ${res.status}: ${err}` };
  }
  return { sent: true };
}

async function sendSms(q) {
  const { enqueueSms, TEMPLATE_KEYS } = smsOutbox();
  const inquiryKey = crypto.createHash('sha256').update(String(q.id || '')).digest('hex').slice(0, 40);
  const queued = await enqueueSms({
    idempotencyKey: `admin.inquiry:${inquiryKey}`,
    audience: 'admin',
    consentGranted: enabled(process.env.ADMIN_SMS_CONSENT_GRANTED),
    toE164: process.env.ADMIN_SMS,
    templateKey: TEMPLATE_KEYS.ADMIN_INQUIRY,
    templateData: {
      customerName: q.name || 'Customer',
      customerPhone: q.phone || '',
      message: q.vehicle ? vehicleSummaryLines(q.vehicle).slice(0, 3).join('; ') : (q.message || ''),
    },
  });
  if (!queued.ok) return { sent: false, reason: queued.error || 'sms_outbox_failed' };
  if (!queued.queued) return { sent: false, skipped: true, reason: queued.reason || 'sms_not_queued' };
  return { sent: false, accepted: true, queued: true, outboxId: queued.outbox?.id || null };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const previewRefusal = refuseSharedWrite('inquiry');
  if (previewRefusal) return previewRefusal;

  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'submit-inquiry',
    cors: true,
  });
  if (rateLimit.blocked) return rateLimit.response;

  let raw;
  try { raw = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  // Allowlisted, sanitized record. Price, tier and payment fields are never read.
  const built = buildInquiryRecord(raw);
  if (!built.ok) return json(400, { ok: false, error: built.error, fields: built.fields });
  const q = built.record;

  // Stored (deduplicated) before notifying; the team is alerted at most once.
  // A storage failure does not block the notifications (existing behavior).
  const outcome = await processInquiry(q, { dedupeKey: built.dedupeKey, notify: notifyTeam });
  return respond(outcome);
};

/** Email + SMS to the team. Never throws; provider details stay server-side. */
async function notifyTeam(q) {
  const [email, sms] = await Promise.all([
    sendEmail(q).catch(e => ({ sent: false, reason: e.message })),
    sendSms(q).catch(e => ({ sent: false, reason: e.message })),
  ]);
  if (!email.sent && email.reason !== 'email not configured') console.warn('[submit-inquiry] email:', email.reason);
  if (!sms.accepted && !sms.skipped) console.warn('[submit-inquiry] sms:', sms.reason);
  return {
    delivered: Boolean(email.sent || sms.accepted),
    email: email.sent ? 'sent' : (email.reason === 'email not configured' ? 'not_configured' : 'failed'),
    sms: sms.accepted ? 'queued' : (sms.skipped ? 'skipped' : 'failed'),
  };
}

const CUSTOMER_MESSAGES = {
  saved_not_notified: 'Your request is saved. Our team was not alerted right away, so a reply may take longer. There is no need to send it again.',
  saved_alert_unconfirmed: 'Your request is saved. We could not confirm our team was alerted, so a reply may take longer. There is no need to send it again.',
  processing: 'We are still confirming your request. Please try again in a moment; it will not create a duplicate.',
  retry: 'We could not confirm your request just now. Please try again in a moment; it will not create a duplicate.',
};

/** Minimal, customer-safe response: status + inquiry id only. */
function respond(o) {
  const base = { status: o.status, ...(o.id ? { id: o.id } : {}), ...(o.duplicate ? { duplicate: true } : {}) };
  switch (o.status) {
    case 'sent':
      return json(200, { ok: true, ...base });
    case 'saved_not_notified':
    case 'saved_alert_unconfirmed':
      // Saved and visible in admin Quote requests, but not a normal success.
      return json(202, { ok: true, ...base, message: CUSTOMER_MESSAGES[o.status] });
    case 'processing':
      return json(409, { ok: false, ...base, retryable: true, message: CUSTOMER_MESSAGES.processing });
    case 'retry':
      return json(503, { ok: false, ...base, retryable: true, message: CUSTOMER_MESSAGES.retry });
    default:
      // Nothing stored and nothing delivered: the page shows the phone number.
      return json(503, { ok: false, status: 'not_delivered', error: 'inquiry_not_delivered' });
  }
}
