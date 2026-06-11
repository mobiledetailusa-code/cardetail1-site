// netlify/functions/stripe-webhook.js
// Recebe e VALIDA eventos do Stripe (assinatura), depois confirma o pagamento.
// Sem dependências npm — usa crypto nativo p/ verificar a assinatura.
//
// Variáveis de ambiente (Netlify):
//   STRIPE_WEBHOOK_SECRET   whsec_... (criado ao registrar o webhook no Stripe)
//   ADMIN_EMAIL + RESEND_API_KEY (opcional) → e-mail de aviso de pagamento
//
// Configurar no Stripe: Developers → Webhooks → Add endpoint
//   URL: https://SEU-SITE.netlify.app/.netlify/functions/stripe-webhook
//   Eventos: payment_intent.succeeded, payment_intent.amount_capturable_updated,
//            payment_intent.payment_failed

const crypto = require('crypto');

// Verifica a assinatura do Stripe sem o SDK (HMAC-SHA256, tolerância 5 min).
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  sigHeader.split(',').forEach(kv => { const [k, v] = kv.split('='); parts[k] = v; });
  if (!parts.t || !parts.v1) return false;

  // Rejeita eventos com mais de 5 minutos (anti-replay).
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (age > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function notifyAdmin(subject, text) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [ADMIN_EMAIL],
        subject,
        text,
      }),
    });
  } catch (e) { console.warn('[webhook] email error:', e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  // O Stripe assina o corpo CRU — não fazer JSON.parse antes de validar.
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  if (!verifyStripeSignature(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let evt;
  try { evt = JSON.parse(raw); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const pi = evt.data && evt.data.object ? evt.data.object : {};
  const bookingId = (pi.metadata && pi.metadata.booking_id) || '—';
  const dollars = pi.amount != null ? (pi.amount / 100).toFixed(2) : '?';

  switch (evt.type) {
    case 'payment_intent.amount_capturable_updated':
      // capture_method=manual → o valor está AUTORIZADO/segurado, aguardando captura.
      await notifyAdmin(
        `Cardetail1 — card authorized for ${bookingId} ($${dollars})`,
        `Card authorized (hold) for booking ${bookingId}. Capture the final amount after service in the Stripe dashboard.`
      );
      break;
    case 'payment_intent.succeeded':
      await notifyAdmin(
        `Cardetail1 — payment captured for ${bookingId} ($${dollars})`,
        `Payment of $${dollars} captured for booking ${bookingId}.`
      );
      break;
    case 'payment_intent.payment_failed':
      await notifyAdmin(
        `Cardetail1 — payment FAILED for ${bookingId}`,
        `Payment failed for booking ${bookingId}. ${pi.last_payment_error?.message || ''}`
      );
      break;
    default:
      break; // ignora outros eventos
  }

  // NOTA: o status do booking vive no localStorage (cliente). Para persistir o
  // "Pago" de forma confiável, conectar um DB (Firebase já referenciado no site).
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
