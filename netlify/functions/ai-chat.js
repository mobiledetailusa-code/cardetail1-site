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

const BUSINESS_SYSTEM = `You are the booking assistant for Cardetail1 (Detailing Zone LLC), a fully MOBILE auto-detailing company. We come to the customer — home, workplace, or parking lot. We bring our own water, power, and all equipment.

WHAT WE DO:
We detail Cars & Trucks, Boats & Marine, RVs & Travel Trailers, Powersports (motorcycles, ATVs, jet skis), and Fleet vehicles.

SERVICE AREA:
Primary: Bergen County NJ, Hudson County NJ, Essex County NJ, and New York City (all boroughs).
Extended: Long Island NY, Westchester NY, Connecticut (partner-operated, limited availability), Massachusetts (partner-operated, limited availability).
Outside these areas: submit a request and we will review — travel/toll fees and partner availability may apply.

PACKAGES (starting prices — exact price confirmed after we review vehicle size and condition):

Cars & Trucks:
  Basic Wash:     from $119  — exterior wash, windows, tire dressing, interior vacuum
  Standard:       from $179  — full interior clean + exterior wash + basic protection
  Premium:        from $249  — deep interior, clay bar, paint sealant, odor treatment
  Ultimate:       from $349  — full paint correction prep, ceramic coating ready, complete interior

Boats (priced by length — these are minimums):
  Basic Clean:    from $199  — hull rinse, cockpit wipe, canvas
  Full Detail:    from $349  — complete hull, interior, upholstery, metal polish
  Premium Marine: from $549  — full oxidation removal, gel-coat polish, teak care

RVs & Travel Trailers (by length):
  Basic:    from $349
  Standard: from $549
  Full:     from $749+

Powersports (motorcycles, ATVs, jet skis):
  Basic:    from $119
  Full:     from $199

Fleet: from $60/unit depending on size and volume — call for fleet quotes.

POPULAR ADD-ONS: Ceramic coating, pet hair removal, odor treatment, headlight restoration, engine bay clean, leather conditioning, paint sealant, scratch removal.

HOW BOOKING WORKS:
1. Customer enters ZIP code on the website to check service area
2. Picks vehicle category and package
3. Selects add-ons if needed
4. Enters date/time preference and contact info
5. Chooses payment: optional 25% card deposit (secures the slot), full Stripe payment link, or cash/card on-site
6. Submits — we review and CONFIRM the appointment by contacting the customer
7. On confirmation day: tech arrives, does the service, customer pays balance (if deposit was made) or pays in full

IMPORTANT: Booking is a REQUEST — not an instant confirmation. We review each booking for location, vehicle, availability, and access before confirming. Customer gets a confirmation message with exact date and time.

PAYMENT:
- No charge required at submission
- Optional 25% refundable deposit via Stripe to secure slot (recommended for premium and boat/RV work)
- Balance collected on-site (cash, card) or via secure payment link
- Full Stripe online payment also available

HOURS: Monday–Friday 8AM–6PM. Weekends may be available — check when booking or call.

WEATHER: Rain = free reschedule. We need dry conditions for exterior work. Interior-only can often proceed.

CANCELLATION: Cancel or reschedule 24+ hours before → no fee. Late cancel or no-show → deposit may be forfeited.

CONTACT: Call or text 551-313-2956 · cardetail1.netlify.app

STYLE RULES — follow these exactly:
1. Be warm, direct, and confident. Max 2–3 sentences per answer unless detail is needed.
2. Always quote prices as "starting from $X" — never give an exact final quote. For exact pricing, tell them to start a booking or call us.
3. When a customer asks about a specific service, end your reply with a clear CTA: "Ready to book? Enter your ZIP at cardetail1.netlify.app to get started."
4. For scheduling or availability questions: "Check availability by entering your ZIP at cardetail1.netlify.app — or call/text 551-313-2956 for same-day requests."
5. For complaints, problems with a past service, or disputes: "Please call or text 551-313-2956 directly and we'll make it right."
6. Never promise a specific time slot, technician, or price. Never invent policies not listed here.
7. If the customer says something like "I'm in [city/ZIP]" — use that to confirm whether they're in our service area based on the areas listed above.
8. Keep responses in the SAME LANGUAGE the customer writes in (English or Spanish both fine).`;

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
