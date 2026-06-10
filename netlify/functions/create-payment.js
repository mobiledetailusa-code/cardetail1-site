// netlify/functions/create-payment.js
// Cobra (ou pré-autoriza) o cartão tokenizado pelo Square Web Payments SDK.
// Sem dependências npm — chama a REST API do Square direto.
//
// Variáveis de ambiente (Netlify → Environment variables):
//   SQUARE_ACCESS_TOKEN   token de acesso (Sandbox OU Production)
//   SQUARE_ENV            "sandbox" (padrão) ou "production"
//   SQUARE_LOCATION_ID    Location ID do Square
//
// Body esperado (JSON):
//   { sourceId: "<card token>", amountCents: 5000, bookingId: "CD1-...",
//     autocomplete: false }   // false = só pré-autoriza (segura o valor); true = captura já

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const { SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENV } = process.env;
  if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
    return json(500, { ok: false, error: 'Square not configured on server' });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  if (!p.sourceId) return json(400, { ok: false, error: 'Missing card token (sourceId)' });
  const amount = Math.round(Number(p.amountCents) || 0);
  if (amount <= 0) return json(400, { ok: false, error: 'Invalid amount' });

  const base = (SQUARE_ENV === 'production')
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  const res = await fetch(`${base}/v2/payments`, {
    method: 'POST',
    headers: {
      'Square-Version': '2024-12-18',
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      idempotency_key: (p.bookingId || 'cd1') + '-' + Date.now(),
      source_id: p.sourceId,
      location_id: SQUARE_LOCATION_ID,
      autocomplete: p.autocomplete === true, // false = pré-autorização (deposit hold)
      amount_money: { amount, currency: 'USD' },
      note: `Cardetail1 booking ${p.bookingId || ''}`.trim(),
      reference_id: p.bookingId || undefined,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.errors && data.errors[0] && data.errors[0].detail) || `Square ${res.status}`;
    return json(res.status, { ok: false, error: msg, errors: data.errors });
  }

  const pay = data.payment || {};
  return json(200, {
    ok: true,
    paymentId: pay.id,
    status: pay.status,            // APPROVED (hold) ou COMPLETED (captured)
    amount: pay.amount_money,
    receiptUrl: pay.receipt_url || null,
  });
};
