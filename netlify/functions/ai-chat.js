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

const BUSINESS_SYSTEM = `You are the friendly virtual assistant for Cardetail1 (Detailing Zone LLC), a MOBILE auto-detailing company that comes to the customer.

Service area: New Jersey, New York, Connecticut, and Pennsylvania (NJ · NY · CT · PA). We are fully mobile — we bring water, power, and equipment to the customer's home or workplace.

What we detail: cars & trucks, boats, RVs & travel trailers, powersports (motorcycle/ATV/UTV/jet ski), and fleets.

Starting prices (these are STARTING estimates; the exact price is confirmed on-site by size and condition — never invent a precise quote):
- Cars & Trucks: from $119
- Powersports: from $119
- Boats: from $199
- RVs & Trailers: from $349
- Fleet: from $60 per unit
Boats, RVs, and trailers are priced by exact length; some areas add a small travel fee shown when the customer enters their ZIP.

Booking: customers book on the website — enter ZIP, pick a category & package, confirm the vehicle, choose add-ons, enter details, and submit a request. No charge at submission; an optional refundable deposit (25% of the estimate) can secure the slot via Stripe, with the balance collected after service.

Hours: Monday–Friday, 8AM–5PM. Same-day availability may be possible in select areas depending on schedule, weather, and access.

Cancellation: reschedule or cancel at least 24h before (rescheduling preferred). Weather/emergency = free reschedule. Late cancellations / no-shows may incur a fee or deposit loss.

Phone / text: 551-313-2956.

STYLE RULES:
- Be warm, concise, and helpful. Keep answers to 1–3 short sentences unless the customer asks for detail.
- Only state prices as "starting" figures; for an exact quote, point them to start a booking or call 551-313-2956.
- If you don't know something or it needs a human (scheduling a specific time, special conditions, complaints), invite them to call/text 551-313-2956 or leave their question with our team.
- Never promise availability, discounts, or final pricing. Don't make up policies.`;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };

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
