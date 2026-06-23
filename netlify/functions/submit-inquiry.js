// netlify/functions/submit-inquiry.js
// Recebe uma dúvida do chat flutuante (handoff p/ humano) e notifica por e-mail
// (Resend) e SMS (Twilio). Mesmo padrão do submit-booking.js — sem deps npm.
//
// Reaproveita as MESMAS variáveis de ambiente do submit-booking:
//   ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM, TWILIO_SID, TWILIO_TOKEN,
//   TWILIO_FROM, ADMIN_SMS

const {
  cleanEmail,
  cleanText,
  json: secureJson,
  normalizePhone,
  rateLimit,
} = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body, { allowHeaders: 'Content-Type' });

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
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, ADMIN_SMS } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !ADMIN_SMS) return { sent: false, reason: 'sms not configured' };
  const body = new URLSearchParams({
    To: ADMIN_SMS,
    From: TWILIO_FROM,
    Body: `New question from ${q.name || 'customer'} (${q.phone || ''}): ${(q.message || '').slice(0, 240)}`,
  });
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `twilio ${res.status}: ${err}` };
  }
  return { sent: true };
}

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const rl = await rateLimit(event, 'submit-inquiry', 8, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  let q;
  try { q = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  q = {
    id: cleanText(q.id, 48),
    name: cleanText(q.name, 100),
    phone: normalizePhone(q.phone),
    email: cleanEmail(q.email),
    message: cleanText(q.message, 1500),
    source: cleanText(q.source, 120) || 'Chat widget',
  };

  if (!q.name || !q.phone || q.phone.length < 7) return json(400, { ok: false, error: 'Missing name or phone' });
  if (!q.id) q.id = 'INQ-' + Date.now().toString(36).toUpperCase();

  const [email, sms] = await Promise.all([
    sendEmail(q).catch(e => ({ sent: false, reason: e.message })),
    sendSms(q).catch(e => ({ sent: false, reason: e.message })),
  ]);

  return json(200, { ok: true, id: q.id, email, sms });
};
