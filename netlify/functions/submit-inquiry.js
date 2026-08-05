// netlify/functions/submit-inquiry.js
// Recebe uma dúvida do chat flutuante (handoff p/ humano) e notifica por e-mail
// (Resend) e SMS (Twilio). Mesmo padrão do submit-booking.js — sem deps npm.
//
// Reaproveita as MESMAS variáveis de ambiente do submit-booking:
//   ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM, TWILIO_SID, TWILIO_TOKEN,
//   TWILIO_FROM, ADMIN_SMS

const crypto = require('crypto');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { enqueueSms } = require('../lib/sms-outbox');
const { TEMPLATE_KEYS } = require('../lib/sms-templates');
const { enabled } = require('../lib/twilio-runtime-policy');

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
  return [
    `NEW CUSTOMER QUESTION — ${q.id}`,
    `Source: ${q.source || 'Chat widget'}`,
    ``,
    `Name:  ${q.name || ''}`,
    `Phone: ${q.phone || ''}`,
    `Email: ${q.email || '—'}`,
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
      subject: `New Cardetail1 question — ${q.name || 'Customer'} (${q.phone || ''})`,
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
      message: q.message || '',
    },
  });
  if (!queued.ok) return { sent: false, reason: queued.error || 'sms_outbox_failed' };
  if (!queued.queued) return { sent: false, skipped: true, reason: queued.reason || 'sms_not_queued' };
  return { sent: false, accepted: true, queued: true, outboxId: queued.outbox?.id || null };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'submit-inquiry',
    cors: true,
  });
  if (rateLimit.blocked) return rateLimit.response;

  let q;
  try { q = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  if (!q.name || !q.phone) return json(400, { ok: false, error: 'Missing name or phone' });
  if (!q.id) q.id = 'INQ-' + Date.now().toString(36).toUpperCase();

  const [email, sms] = await Promise.all([
    sendEmail(q).catch(e => ({ sent: false, reason: e.message })),
    sendSms(q).catch(e => ({ sent: false, reason: e.message })),
  ]);

  return json(200, { ok: true, id: q.id, email, sms });
};
