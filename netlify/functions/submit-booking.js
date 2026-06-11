// netlify/functions/submit-booking.js
// Recebe um booking do site e dispara notificação por e-mail (Resend) e SMS (Twilio).
// Não usa dependências npm — só fetch nativo do Node 18 da Netlify.
//
// Variáveis de ambiente (Netlify → Site settings → Environment variables):
//   ADMIN_EMAIL       e-mail que RECEBE os bookings (obrigatório p/ e-mail)
//   RESEND_API_KEY    chave do https://resend.com (obrigatório p/ e-mail)
//   RESEND_FROM       remetente verificado, ex: "Cardetail1 <bookings@seudominio.com>"
//   TWILIO_SID        (opcional) p/ SMS
//   TWILIO_TOKEN      (opcional)
//   TWILIO_FROM       (opcional) número Twilio, ex: +1XXXXXXXXXX
//   ADMIN_SMS         (opcional) número que recebe o SMS, ex: +1XXXXXXXXXX

const crypto = require('crypto');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function signBid(jobId, techId, secret) {
  return crypto.createHmac('sha256', secret).update(String(jobId) + '|' + String(techId)).digest('hex');
}

// On a confirmed booking: create the auction in Blobs and SMS each tech a magic
// bid link (lowest bid wins). Degrades gracefully if BID_SECRET/Twilio missing.
async function postAuction(b) {
  const secret = process.env.BID_SECRET;
  if (!secret) return { posted: false, reason: 'BID_SECRET not set' };
  const st = String(b.status || '').toLowerCase();
  if (!['confirmed', 'accepted', 'scheduled'].includes(st)) return { posted: false, reason: 'status not auctionable' };
  try {
    const { getStore } = await import('@netlify/blobs');
    const roster = (await getStore('cd1-techs').get('roster', { type: 'json' })) || [];
    const job = {
      customer: `${b.firstName || ''} ${b.lastName || ''}`.trim(),
      vehicle: b.vehicle || b.vehicleCategory || '',
      package: b.package || '',
      date: b.preferredDate || '', time: b.preferredTime || '',
      area: b.zone || b.zipCode || '', address: b.address || '',
      total: b.totalPrice || 0,
    };
    await getStore('cd1-auctions').setJSON(b.id, {
      jobId: b.id, status: 'open', job, bids: [], winner: null, createdAt: new Date().toISOString(),
    });
    const base = process.env.SITE_URL || '';
    const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
    let notified = 0;
    if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && base && roster.length) {
      const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
      await Promise.all(roster.map(t => {
        const sig = signBid(b.id, t.id, secret);
        const link = `${base}/bid.html?job=${encodeURIComponent(b.id)}&tech=${encodeURIComponent(t.id)}&sig=${sig}`;
        const body = new URLSearchParams({
          To: t.phone, From: TWILIO_FROM,
          Body: `New Cardetail1 job: ${job.package} · ${job.date} · ${job.area}. Place your bid (lowest wins): ${link}`,
        });
        return fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
          method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
        }).then(r => { if (r.ok) notified++; }).catch(() => {});
      }));
    }
    return { posted: true, techs: roster.length, notified };
  } catch (e) {
    return { posted: false, reason: e.message };
  }
}

function bookingText(b) {
  const vehicles = (b.vehicles || [])
    .map(v => `  • ${v.vehicleLabel || v.vehicle || 'Vehicle'} — ${v.pkgName || ''} ($${v.subtotal || 0})`)
    .join('\n');
  return [
    `NEW BOOKING — ${b.id}`,
    `Status: ${b.status || 'Pending Review'}`,
    ``,
    `Customer: ${b.firstName || ''} ${b.lastName || ''}`,
    `Phone:    ${b.phone || ''}`,
    `Email:    ${b.email || ''}`,
    `Address:  ${b.address || ''}`,
    `ZIP/Zone: ${b.zipCode || ''} ${b.zone ? '· ' + b.zone : ''}`,
    `Date:     ${b.preferredDate || ''} ${b.preferredTime || ''}`,
    ``,
    `Service:  ${b.package || b.service || ''}`,
    vehicles ? `Vehicles:\n${vehicles}` : '',
    `Add-ons:  ${(b.addons || []).map(a => a.name).join(', ') || 'None'}`,
    `TOTAL:    $${b.totalPrice || 0}`,
    ``,
    `Notes:    ${b.notes || '—'}`,
    `Card:     ${b.cardPolicyAccepted ? 'Policy accepted' : 'Not accepted'} · ${b.cardholderName || 'N/A'}`,
  ].filter(Boolean).join('\n');
}

async function sendEmail(b) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return { sent: false, reason: 'email not configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [ADMIN_EMAIL],
      reply_to: b.email || undefined,
      subject: `New Cardetail1 Booking ${b.id} — ${b.firstName || ''} ${b.lastName || ''} ($${b.totalPrice || 0})`,
      text: bookingText(b),
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `resend ${res.status}: ${err}` };
  }
  return { sent: true };
}

async function sendSms(b) {
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, ADMIN_SMS } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !ADMIN_SMS) return { sent: false, reason: 'sms not configured' };
  const body = new URLSearchParams({
    To: ADMIN_SMS,
    From: TWILIO_FROM,
    Body: `New booking ${b.id}: ${b.firstName || ''} ${b.lastName || ''} · ${b.package || b.service || ''} · $${b.totalPrice || 0} · ${b.preferredDate || ''} · ${b.phone || ''}`,
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
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  if (!b.firstName || !b.phone) return json(400, { ok: false, error: 'Missing customer name or phone' });
  if (!b.id) b.id = 'CD1-' + Date.now().toString(36).toUpperCase();

  // Central storage (Netlify Blobs) so the admin sees EVERY booking, not just the
  // ones made in its own browser. Degrades gracefully if Blobs is unavailable.
  let stored = { saved: false };
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('cd1-bookings');
    await store.setJSON(b.id, b);
    stored = { saved: true };
  } catch (e) {
    stored = { saved: false, reason: e.message };
  }

  const [email, sms, auction] = await Promise.all([
    sendEmail(b).catch(e => ({ sent: false, reason: e.message })),
    sendSms(b).catch(e => ({ sent: false, reason: e.message })),
    postAuction(b).catch(e => ({ posted: false, reason: e.message })),
  ]);

  // Mesmo se notificação/armazenamento falhar, confirmamos o recebimento do request.
  return json(200, { ok: true, id: b.id, status: b.status || 'Pending Review', stored, email, sms, auction });
};
