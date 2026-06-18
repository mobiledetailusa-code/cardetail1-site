// netlify/functions/gallery.js
// Admin-managed photo gallery for Cardetail1 job results.
// Store: cd1-gallery (Netlify Blobs)
//
// Public (no auth):
//   GET  ?action=list              → published items only
//
// Admin (x-admin-key required):
//   GET  ?action=list&all=1        → all items (draft + published + hidden)
//   POST { action:'save',  item }  → create or update a gallery item
//   POST { action:'delete', id }   → delete a gallery item
//
// Gallery item schema:
//   { id, title, service, imageUrl, beforeImageUrl, afterImageUrl,
//     locationLabel, notes, status, createdAt, updatedAt }
//
// Image URLs are owner-provided public URLs (e.g. Google Drive, Cloudinary).
// This function stores metadata only — images are served from their source host.
//
// Env: ADMIN_DASH_PASSWORD, NETLIFY_SITE_ID, NETLIFY_AUTH_TOKEN

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

async function blobsStore() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token)
    ? getStore({ name: 'cd1-gallery', siteID, token })
    : getStore('cd1-gallery');
}

function isAdmin(event) {
  const expected = process.env.ADMIN_DASH_PASSWORD || '';
  if (!expected) return false;
  const provided =
    (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) ||
    (event.queryStringParameters && event.queryStringParameters.key) || '';
  return provided === expected;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  const admin = isAdmin(event);
  const qs = event.queryStringParameters || {};

  // ── GET: list gallery items ───────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const action = qs.action || 'list';
    if (action !== 'list') return json(400, { ok: false, error: 'Unknown action' });
    try {
      const store = await blobsStore();
      const listing = await store.list();
      const blobs = (listing && listing.blobs) || [];
      const all = (await Promise.all(
        blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
      )).filter(Boolean);

      // Admin with ?all=1 sees every status; public sees published only.
      const items = (admin && qs.all === '1')
        ? all
        : all.filter(g => g.status === 'published');

      items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return json(200, { ok: true, count: items.length, items });
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
  }

  // ── POST: save or delete (admin only) ────────────────────────────────
  if (event.httpMethod === 'POST') {
    if (!admin) return json(401, { ok: false, error: 'unauthorized' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

    const { action } = body;

    if (action === 'save') {
      const item = body.item;
      if (!item || !String(item.title || '').trim()) {
        return json(400, { ok: false, error: 'item.title is required' });
      }
      const now = new Date().toISOString();
      const id = String(item.id || '').trim() || ('gal-' + Date.now());
      const VALID_STATUS = ['draft', 'published', 'hidden'];
      const record = {
        id,
        title:          String(item.title || '').trim().slice(0, 120),
        service:        String(item.service || '').trim().slice(0, 60),
        imageUrl:       String(item.imageUrl || '').trim(),
        beforeImageUrl: String(item.beforeImageUrl || '').trim(),
        afterImageUrl:  String(item.afterImageUrl || '').trim(),
        locationLabel:  String(item.locationLabel || '').trim().slice(0, 80),
        notes:          String(item.notes || '').trim().slice(0, 500),
        status:         VALID_STATUS.includes(item.status) ? item.status : 'draft',
        createdAt:      item.createdAt || now,
        updatedAt:      now,
      };
      try {
        const store = await blobsStore();
        await store.setJSON(id, record);
        return json(200, { ok: true, id, record });
      } catch (e) {
        return json(500, { ok: false, error: e.message });
      }
    }

    if (action === 'delete') {
      const id = String(body.id || '').trim();
      if (!id) return json(400, { ok: false, error: 'id is required' });
      try {
        const store = await blobsStore();
        await store.delete(id);
        return json(200, { ok: true, deleted: id });
      } catch (e) {
        return json(500, { ok: false, error: e.message });
      }
    }

    return json(400, { ok: false, error: 'Unknown action' });
  }

  return json(405, { ok: false, error: 'Method not allowed' });
};
