// netlify/functions/submit-authorization.js
// Receives a signed payment authorization (name + amount + signature PNG) from
// authorize.html and emails it to the owner (Resend), with the signature image
// attached. Also stores it centrally in Blobs. No npm deps beyond @netlify/blobs.
//
// Env: ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM (optional)

const {
  cleanBookingId,
  cleanText,
  clampNumber,
  json: secureJson,
  rateLimit,
} = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body, { allowHeaders: 'Content-Type' });

const MAX_SIGNATURE_BASE64 = 600 * 1024;

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const rl = await rateLimit(event, 'submit-authorization', 6, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
  const signature = String(p.signature || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) return json(400, { ok: false, error: 'invalid_signature' });
  const b64 = signature.replace(/^data:image\/png;base64,/, '');
  if (b64.length > MAX_SIGNATURE_BASE64) return json(400, { ok: false, error: 'signature_too_large' });

  p = {
    job: cleanBookingId(p.job),
    name: cleanText(p.name, 120),
    amount: clampNumber(p.amount, 1, 50000, 0),
    signature,
    date: cleanText(p.date, 64) || new Date().toISOString(),
  };
  if (!p.name || !(p.amount > 0) || !p.signature) return json(400, { ok: false, error: 'Missing name, amount or signature' });

  const id = 'AUTH-' + Date.now().toString(36).toUpperCase();
  const record = { id, job: p.job || '', name: p.name, amount: p.amount, date: p.date };

  // Store centrally (signature included) — best effort.
  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const authStore = (siteID && token) ? getStore({ name: 'cd1-authorizations', siteID, token }) : getStore('cd1-authorizations');
    await authStore.setJSON(id, Object.assign({}, record, { signature: p.signature }));
  } catch (e) { /* ignore */ }

  // Email to owner with the signature PNG attached.
  let emailed = false, reason = '';
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (ADMIN_EMAIL && RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
          to: [ADMIN_EMAIL],
          subject: `Payment authorization · ${record.name} · $${record.amount}${record.job ? ' · ' + record.job : ''}`,
          text: `Signed payment authorization\n\nID: ${id}\nBooking: ${record.job || '—'}\nCustomer: ${record.name}\nAmount authorized: $${record.amount}\nDate: ${record.date}\n\nSignature image attached.`,
          attachments: [{ filename: `signature-${id}.png`, content: b64 }],
        }),
      });
      emailed = res.ok;
      if (!res.ok) reason = 'resend ' + res.status;
    } catch (e) { reason = e.message; }
  } else { reason = 'email not configured'; }

  return json(200, { ok: true, id, emailed, reason });
};
