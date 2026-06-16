// netlify/functions/create-payment-intent.js
// Cria um PaymentIntent no Stripe para um booking do Cardetail1.
// Sem dependências npm — chama a REST API do Stripe direto via fetch.
//
// Variáveis de ambiente (Netlify → Environment variables):
//   STRIPE_SECRET_KEY   chave secreta (sk_test_... ou sk_live_...)
//
// Body esperado (JSON):
//   { amountCents: 5000, bookingId: "CD1-...", email: "cliente@x.com",
//     capture: "manual" }   // "manual" = autoriza/segura (default); "auto" = captura já
//
// Retorna: { ok, clientSecret, id, captureMethod, mode }
//   mode: "test" | "live" — reflects the key in use; front-end uses this to
//   show a test-mode banner and avoid charging real cards during validation.

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

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(503, { ok: false, error: 'Stripe not configured on server' });
  const mode = secret.startsWith('sk_test_') ? 'test' : 'live';
  if (mode === 'live') {
    console.warn('[create-payment-intent] WARNING: using live Stripe key — no real charges should occur during validation');
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const amount = Math.round(Number(p.amountCents) || 0);
  if (amount < 50) return json(400, { ok: false, error: 'Amount too low (min 50 cents)' });

  // capture_method: manual = autoriza e segura o valor (ideal p/ preço final variável
  // de barco/RV — captura o valor exato depois do serviço). auto = cobra na hora.
  const captureMethod = p.capture === 'auto' ? 'automatic' : 'manual';

  const form = new URLSearchParams({
    amount: String(amount),
    currency: 'usd',
    capture_method: captureMethod,
    'automatic_payment_methods[enabled]': 'true',
    description: `Cardetail1 booking ${p.bookingId || ''}`.trim(),
  });
  if (p.bookingId) form.append('metadata[booking_id]', p.bookingId);
  if (p.email)     form.append('receipt_email', p.email);

  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const pi = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(res.status, { ok: false, error: (pi.error && pi.error.message) || `Stripe ${res.status}` });
  }

  return json(200, {
    ok: true,
    clientSecret: pi.client_secret,
    id: pi.id,
    captureMethod,
    mode,
  });
};
