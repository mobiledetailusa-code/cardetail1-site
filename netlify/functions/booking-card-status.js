// Returns only the card-on-file state for a pre-registered booking draft.
// The browser waits for the verified Stripe webhook before final submission.
// No Stripe IDs, customer data, or client secrets are exposed.

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_request' }); }

  const bookingId = String(body.bookingId || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 48);
  if (!bookingId) return json(400, { ok: false, error: 'bookingId_required' });

  try {
    const booking = await (await blobsStore('cd1-bookings')).get(bookingId, { type: 'json' });
    if (!booking) return json(404, { ok: false, error: 'booking_not_found' });
    const status = ['pending', 'saved', 'failed'].includes(booking.cardOnFileStatus)
      ? booking.cardOnFileStatus
      : 'pending';
    return json(200, { ok: true, cardOnFileStatus: status });
  } catch {
    return json(503, { ok: false, error: 'status_unavailable' });
  }
};
