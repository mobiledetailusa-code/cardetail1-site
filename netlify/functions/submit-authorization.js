// netlify/functions/submit-authorization.js
// Receives a signed payment authorization (name + amount + signature PNG) from
// authorize.html and emails it to the owner (Resend), with the signature image
// attached. Also stores it centrally in Blobs. No npm deps beyond @netlify/blobs.
//
// Env: ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM (optional)

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
  if (!p.name || !(Number(p.amount) > 0) || !p.signature) return json(400, { ok: false, error: 'Missing name, amount or signature' });

  const id = 'AUTH-' + Date.now().toString(36).toUpperCase();
  const record = { id, job: p.job || '', name: p.name, amount: Number(p.amount), date: p.date || new Date().toISOString() };

  // Store centrally (signature included) — best effort.
  try {
    const { getStore } = await import('@netlify/blobs');
    await getStore('cd1-authorizations').setJSON(id, Object.assign({}, record, { signature: p.signature }));
  } catch (e) { /* ignore */ }

  // Email to owner with the signature PNG attached.
  let emailed = false, reason = '';
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (ADMIN_EMAIL && RESEND_API_KEY) {
    try {
      const b64 = String(p.signature).replace(/^data:image\/png;base64,/, '');
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
