/**
 * Public Cardetail1 review channel for the homepage.
 *
 * GET /.netlify/functions/public-reviews
 * 200 { ok: true, items: [...] } — approved first-party cards only.
 *
 * Never returns phone, email, booking id, or pending/hidden reviews.
 * Storage failures return an empty list so the curated homepage still renders.
 */

const { blobsStore } = require('../lib/tech-security');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const {
  REVIEWS_STORE,
  readHomepageIndex,
  isPublicCard,
} = require('../lib/first-party-reviews');

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
    body: JSON.stringify(body),
  };
}

let storeOverride = null;

async function openStore() {
  if (typeof storeOverride === 'function') return storeOverride();
  return blobsStore(REVIEWS_STORE);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'public-reviews' });
  if (rateLimit.blocked) return rateLimit.response;

  try {
    const store = await openStore();
    const items = (await readHomepageIndex(store)).filter(isPublicCard).map((row) => ({
      id: row.id,
      name: row.name,
      rating: row.rating,
      text: row.text,
      location: row.location,
      date: row.date,
      service: row.service,
      source: 'cardetail1',
      createdAt: row.createdAt || '',
    }));
    return json(200, { ok: true, items });
  } catch (e) {
    console.warn('[public-reviews] read failed:', e && e.message);
    return json(200, { ok: true, items: [] });
  }
};

exports.__test = {
  setStoreOverride(fn) { storeOverride = fn; },
};
