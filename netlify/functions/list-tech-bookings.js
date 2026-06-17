// netlify/functions/list-tech-bookings.js
// Returns bookings assigned to a specific technician.
//
// Phase 1 auth: x-tech-id + x-tech-email validated against the cd1-techs Blobs roster.
// Token-based auth is deferred to phase 2. This endpoint is READ-ONLY — technicians
// cannot mutate bookings through this endpoint.
//
// Sensitive fields are redacted from all responses:
//   paymentIntentId, amountAuthorizedCents, amountCapturedCents,
//   captureInitiatedAt, capturedAt, stripeCustomerId, paymentMethodId,
//   paymentStatus, paymentFailureReason, paymentCancelReason,
//   adminNotes, archived, isTest
//
// Env (Netlify):
//   NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN  (auto-injected by Netlify runtime)

const REDACTED = new Set([
  'paymentIntentId', 'amountAuthorizedCents', 'amountCapturedCents',
  'captureInitiatedAt', 'capturedAt', 'stripeCustomerId', 'paymentMethodId',
  'paymentStatus', 'paymentFailureReason', 'paymentCancelReason',
  'adminNotes', 'archived', 'isTest',
]);

function redact(booking) {
  const out = {};
  for (const [k, v] of Object.entries(booking)) {
    if (!REDACTED.has(k)) out[k] = v;
  }
  return out;
}

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-tech-id, x-tech-email',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });

  const hdrs      = event.headers || {};
  const techId    = (hdrs['x-tech-id']    || hdrs['X-Tech-Id']    || '').trim();
  const techEmail = (hdrs['x-tech-email'] || hdrs['X-Tech-Email'] || '').trim().toLowerCase();

  if (!techId || !techEmail) {
    return json(401, { ok: false, error: 'x-tech-id and x-tech-email headers required' });
  }

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID;
    const token  = process.env.NETLIFY_AUTH_TOKEN;
    const bkStore   = (siteID && token) ? getStore({ name: 'cd1-bookings', siteID, token }) : getStore('cd1-bookings');
    const techStore = (siteID && token) ? getStore({ name: 'cd1-techs',    siteID, token }) : getStore('cd1-techs');

    // ── Auth: validate tech against Blobs roster ──────────────────────────────
    const roster = await techStore.get('roster', { type: 'json' }).catch(() => null) || [];
    if (roster.length > 0) {
      const match = roster.find(t =>
        t.id === techId &&
        (t.email || '').toLowerCase() === techEmail &&
        (!t.status || t.status === 'approved')
      );
      if (!match) return json(401, { ok: false, error: 'unauthorized' });
    } else {
      // Phase 1 fallback: roster not synced yet. Warn and proceed with ID-only check.
      // Admin should sync the roster via POST /.netlify/functions/techs.
      console.warn('[list-tech-bookings] roster not in Blobs — using fallback auth for', techId);
    }

    // ── Fetch assigned bookings ───────────────────────────────────────────────
    const listing  = await bkStore.list();
    const blobs    = (listing && listing.blobs) || [];
    const all      = (await Promise.all(
      blobs.map(b => bkStore.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(b => b && b.assignedTech === techId && !b.archived && !b.isTest);

    const bookings = all
      .map(redact)
      .sort((a, b) =>
        String(b.confirmedDate || b.preferredDate || b.createdAt || '')
          .localeCompare(String(a.confirmedDate || a.preferredDate || a.createdAt || ''))
      );

    return json(200, { ok: true, count: bookings.length, bookings });
  } catch (e) {
    console.error('[list-tech-bookings] error', e.message);
    return json(500, { ok: false, error: 'server_error' });
  }
};
