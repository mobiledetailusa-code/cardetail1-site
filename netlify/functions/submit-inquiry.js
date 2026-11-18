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
  persistInquiry,
  recordNotificationOutcome,
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
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
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

  // Stored before notifying so the request survives an email/SMS outage.
  // A storage failure does not block the notifications (existing behavior).
  const persisted = await persistInquiry(q, { dedupeKey: built.dedupeKey });

  // A retry or concurrent duplicate of a request already stored: no second
  // record and no second email/SMS. Report what happened to the original.
  if (persisted.duplicate) {
    const notified = persisted.notification && persisted.notification.state === 'failed' ? false : true;
    return notified
      ? json(200, { ok: true, id: persisted.id, stored: true, duplicate: true })
      : json(202, savedNotNotifiedBody(persisted.id, { duplicate: true }));
  }

  const [email, sms] = await Promise.all([
    sendEmail(q).catch(e => ({ sent: false, reason: e.message })),
    sendSms(q).catch(e => ({ sent: false, reason: e.message })),
  ]);
  const notified = Boolean(email.sent || sms.accepted);

  await recordNotificationOutcome(persisted, q, {
    state: notified ? 'sent' : 'failed',
    email: email.sent ? 'sent' : (email.reason === 'email not configured' ? 'not_configured' : 'failed'),
    sms: sms.accepted ? 'queued' : (sms.skipped ? 'skipped' : 'failed'),
    at: new Date().toISOString(),
  });

  // Nothing stored and nothing delivered: tell the customer to call instead of
  // showing a success message for a request nobody will ever see.
  if (!persisted.stored && !notified) {
    return json(503, { ok: false, error: 'inquiry_not_delivered', stored: false, email, sms });
  }

  // Saved but neither channel reached the team: not a normal success. The
  // request is in the admin Quote requests list; the customer must not resend.
  if (!notified) return json(202, savedNotNotifiedBody(q.id, { email, sms }));

  return json(200, { ok: true, id: q.id, stored: persisted.stored, notified: true, email, sms });
};

function savedNotNotifiedBody(id, extra = {}) {
  return {
    ok: true,
    id,
    stored: true,
    notified: false,
    status: 'saved_not_notified',
    message: 'Your request is saved. Our team has not been alerted yet, so a reply may take longer. There is no need to send it again.',
    ...extra,
  };
}
