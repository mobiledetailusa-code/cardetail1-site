// netlify/functions/ai-chat.js
// AI assistant for the floating customer chat. Calls the Anthropic API (Claude).
// No npm deps — uses Node 18 global fetch. If ANTHROPIC_API_KEY is not set, it
// returns {ok:false, reason:'ai_not_configured'} so the front-end falls back to
// its local knowledge-base assistant automatically.
//
// Netlify env vars (Site settings → Environment):
//   ANTHROPIC_API_KEY   (required to enable real AI)   — sk-ant-...
//   CHAT_MODEL          (optional)  default 'claude-haiku-4-5' (fast/cheap for a
//                        public FAQ widget; set 'claude-opus-4-8' for max quality)

const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

const BUSINESS_SYSTEM = `You are the Booking Assistant for Cardetail1 Team. Your ONLY goal is to provide quick answers and guide the customer to book an appointment.

STRICT RULES:

NEVER say you are an AI. You are a member of the Cardetail1 local team in NJ.

SHORT ANSWERS ONLY: Maximum 2 to 3 short sentences per reply. No long paragraphs.

NO REPETITION: Never repeat 'We come to you' or 'We are mobile' unless specifically asked how the service works.

PRICING: If asked about general starting prices, use Cars from $190 (Interior Detail), Boats from $170, RVs & trailers from $295, Powersports from $100. Fleet and commercial jobs are quote-only — never quote a flat per-unit fleet price. Maintenance Detail from $150 is a separate upkeep option in booking; mention it only when maintenance or budget is asked, not as the general Cars starting price. Then ask: 'Would you like me to send the link to check our packages?'

PAYMENT/TRUST: If asked about payment or if it's safe, say: 'We require a card to secure the spot, but it is just a $0 security hold. You only pay after our team finishes the job and you inspect the results.'

ESCALATION: If the user asks a complex question, complains, or asks something you don't know, say: 'Our lead technicians can answer that perfectly. Could you leave your phone number so Magno or someone from the team can text you shortly?'

Do not offer ZIP code checks unprompted. Wait for the user to ask a question, answer it directly, and smoothly offer the booking link.`;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'ai-chat', cors: true });
  if (rateLimit.blocked) return rateLimit.response;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Graceful degradation — front-end falls back to the local assistant.
  if (!apiKey) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, reason: 'ai_not_configured' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'bad_json' }) }; }

  // Build the message list from the conversation history (last user turn included).
  const history = Array.isArray(payload.history) ? payload.history : [];
  let messages = history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!messages.length && typeof payload.message === 'string' && payload.message.trim()) {
    messages = [{ role: 'user', content: payload.message.slice(0, 2000) }];
  }
  // The Anthropic API requires the conversation to start with a user turn.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'no_message' }) };

  const model = process.env.CHAT_MODEL || 'claude-haiku-4-5';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        system: BUSINESS_SYSTEM,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Anthropic API error', res.status, errText);
      // Tell the front-end to fall back rather than showing an error.
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, reason: 'ai_error' }) };
    }

    const data = await res.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!reply) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, reason: 'empty' }) };
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, reply }) };
  } catch (e) {
    console.error('ai-chat fetch failed', e);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, reason: 'ai_unreachable' }) };
  }
};
