// netlify/functions/create-payment-link.js
// Gera um link de pagamento seguro (Stripe Checkout Session) e, se houver e-mail,
// envia o link ao cliente via Resend. Sem dependências npm.
//
// Variáveis de ambiente (Netlify):
//   STRIPE_SECRET_KEY   sk_test_... / sk_live_...
//   SITE_URL            (opcional) base p/ success/cancel, ex: https://seu-site.netlify.app
//   ADMIN_EMAIL + RESEND_API_KEY (opcional) → envia o link por e-mail ao cliente
//
// Body (JSON): { amountCents, bookingId, email, sendPref }

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function emailLink(to, url, bookingId) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!to || !RESEND_API_KEY) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [to],
        subject: `Your Cardetail1 secure payment link${bookingId ? ' · ' + bookingId : ''}`,
        text: `Secure your appointment with a refundable deposit:\n\n${url}\n\nThis link is processed securely by Stripe.`,
      }),
    });
    return res.ok;
  } catch { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(500, { ok: false, error: 'Stripe not configured on server' });

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const amount = Math.round(Number(p.amountCents) || 0);
  if (amount < 50) return json(400, { ok: false, error: 'Invalid amount' });

  const base = process.env.SITE_URL || (event.headers && `https://${event.headers.host}`) || '';

  // Stripe Checkout Session (one-off deposit).
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': `Cardetail1 deposit${p.bookingId ? ' · ' + p.bookingId : ''}`,
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][quantity]': '1',
    success_url: `${base}/?paid=1`,
    cancel_url: `${base}/?canceled=1`,
  });
  if (p.bookingId) form.append('metadata[booking_id]', p.bookingId);
  if (p.email) form.append('customer_email', p.email);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const sess = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(res.status, { ok: false, error: (sess.error && sess.error.message) || `Stripe ${res.status}` });
  }

  let emailed = false;
  if (p.email && p.sendPref && /email/i.test(p.sendPref)) {
    emailed = await emailLink(p.email, sess.url, p.bookingId);
  }

  return json(200, { ok: true, url: sess.url, id: sess.id, emailed });
};
