/**
 * Admin moderation for the Cardetail1 homepage review channel.
 *
 * GET  → pending queue + cards currently on the homepage
 * POST { action: 'publish', id } → move a pending review onto the homepage
 * POST { action: 'hide', id }    → take a published card off the homepage
 *
 * Customer words are never edited. Phone/email are never returned.
 */

const { blobsStore, jsonCors, verifyAdminKey } = require('../lib/tech-security');
const {
  REVIEWS_STORE,
  readHomepageIndex,
  publishToHomepage,
  hideFromHomepage,
  dequeueModeration,
  toPublicCard,
  publicCommentEligible,
} = require('../lib/first-party-reviews');

let storeOverride = null;
let verifyOverride = null;

async function openStore() {
  if (typeof storeOverride === 'function') return storeOverride();
  return blobsStore(REVIEWS_STORE);
}

async function authorize(headers) {
  if (typeof verifyOverride === 'function') return verifyOverride(headers);
  return verifyAdminKey(headers);
}

function adminView(review, extra = {}) {
  if (!review) return null;
  return {
    id: review.id,
    status: review.status || '',
    stars: Number(review.stars) || 0,
    comment: review.comment || '',
    displayName: review.displayName || review.customerName || '',
    service: review.service || '',
    location: review.location || '',
    createdAt: review.createdAt || '',
    bookingId: review.bookingId || '',
    source: review.source || 'customer_portal',
    ...extra,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});

  const auth = await authorize(event.headers || {});
  if (!auth.ok) {
    const status = auth.error === 'missing_admin_config' || auth.error === 'missing_admin_session_secret'
      ? 503
      : 401;
    return jsonCors(status, { ok: false, error: auth.error || 'unauthorized' });
  }

  const store = await openStore();

  if (event.httpMethod === 'GET') {
    const published = await readHomepageIndex(store);
    const queueIds = await store.get('moderation-queue', { type: 'json' }).catch(() => []);
    const ids = Array.isArray(queueIds) ? queueIds : [];
    const pending = [];
    for (const id of ids.slice(0, 50)) {
      const row = await store.get(String(id), { type: 'json' }).catch(() => null);
      if (row && row.status !== 'approved') pending.push(adminView(row));
    }
    return jsonCors(200, { ok: true, pending, published });
  }

  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const id = String(body.id || '').trim();
  const action = String(body.action || '').trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return jsonCors(400, { ok: false, error: 'invalid_id' });
  }
  if (action !== 'publish' && action !== 'hide') {
    return jsonCors(400, { ok: false, error: 'invalid_action' });
  }

  const review = await store.get(id, { type: 'json' }).catch(() => null);
  if (!review || !review.id) {
    return jsonCors(404, { ok: false, error: 'review_not_found' });
  }

  if (action === 'hide') {
    review.status = 'hidden';
    await store.setJSON(id, review);
    await hideFromHomepage(store, id);
    await dequeueModeration(store, id);
    return jsonCors(200, { ok: true, id, status: 'hidden' });
  }

  if (!publicCommentEligible(review.comment)) {
    return jsonCors(409, {
      ok: false,
      error: 'comment_too_short',
      message: 'A homepage card needs a written comment.',
    });
  }

  review.status = 'approved';
  await store.setJSON(id, review);
  const card = toPublicCard({
    id: review.id,
    comment: review.comment,
    stars: review.stars,
    displayName: review.displayName || review.customerName,
    location: review.location,
    service: review.service,
    createdAt: review.createdAt,
  });
  if (card) await publishToHomepage(store, card);
  await dequeueModeration(store, id);
  return jsonCors(200, { ok: true, id, status: 'approved', published: !!card });
};

exports.__test = {
  setStoreOverride(fn) { storeOverride = fn; },
  setVerifyOverride(fn) { verifyOverride = fn; },
};
