// netlify/functions/submit-inquiry.js
// Recebe uma dúvida do chat flutuante (handoff p/ humano) e notifica por e-mail
// (Resend) e SMS (Twilio). Mesmo padrão do submit-booking.js — sem deps npm.
//
// Reaproveita as MESMAS variáveis de ambiente do submit-booking:
//   ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM, TWILIO_SID, TWILIO_TOKEN,
//   TWILIO_FROM, ADMIN_SMS

const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

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
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, ADMIN_SMS } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !ADMIN_SMS) return { sent: false, reason: 'sms not configured' };
  const body = new URLSearchParams({
    To: ADMIN_SMS,
    From: TWILIO_FROM,
    Body: `New question from ${q.name || 'customer'} (${q.phone || ''}): ${(q.message || '').slice(0, 240)}`,
  });
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      // Never return raw Twilio response bodies to API clients or store them.
      await res.text().catch(() => '');
      const status = Number(res.status) || 0;
      return {
        sent: false,
        reason: status ? `twilio_http_${status}` : 'twilio_http_error',
        httpStatus: status || null,
      };
    }
    const payload = await res.json().catch(() => ({}));
    const sid = typeof payload.sid === 'string' ? payload.sid : '';
    return { sent: true, correlationId: sid ? `SM${sid.slice(-8)}` : null };
  } catch (_e) {
    return { sent: false, reason: 'twilio_network_error' };
  }
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
