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

// Legacy Square endpoint — disabled (use Stripe card-on-file flow).
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }
  return json(403, { ok: false, error: 'endpoint_disabled' });
};
