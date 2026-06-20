// netlify/functions/recent-work-admin.js
// Admin-only CRUD for the Recent Work gallery.
// Auth: x-admin-key header must match ADMIN_DASH_PASSWORD env var (constant-time compare).
//
// GET                             → { ok, items }  all items including hidden
// POST { action:'save',   item }  → add or update by id
// POST { action:'delete', id   }  → remove item
// POST { action:'reorder', ids }  → reorder by id array position
//
// TODO: future PR — add image upload to Netlify Blobs (currently imageUrl only).

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

const VALID_CATEGORIES   = ['interior','exterior','premium','marine','rv','powersports','other'];
const VALID_BEFORE_AFTER = ['final','before','after','both'];
const IG_HOST_RE         = /^(www\.)?instagram\.com$/;

function sanitizeText(v, max = 500) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))
    .trim()
    .slice(0, max);
}

function validHttpUrl(v) {
  if (!v || typeof v !== 'string') return '';
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return v.trim().slice(0, 512);
  } catch { return ''; }
}

function validInstagramUrl(v) {
  if (!v || typeof v !== 'string') return '';
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!IG_HOST_RE.test(u.hostname)) return '';
    return v.trim().slice(0, 512);
  } catch { return ''; }
}

async function openStore() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token)
    ? getStore({ name: 'cd1-recent-work', siteID, token })
    : getStore('cd1-recent-work');
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const ao = (a.displayOrder != null) ? a.displayOrder : 9999;
    const bo = (b.displayOrder != null) ? b.displayOrder : 9999;
    if (ao !== bo) return ao - bo;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  const expected = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!expected) return json(503, { ok: false, error: 'admin_password_not_configured' });

  const provided = (
    (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || ''
  ).trim();
  if (!provided) return json(401, { ok: false, error: 'missing_key' });

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  try {
    const store = await openStore();

    if (event.httpMethod === 'GET') {
      const raw   = await store.get('items', { type: 'json' }).catch(() => null);
      const items = Array.isArray(raw) ? raw : [];
      return json(200, { ok: true, items: sortItems(items) });
    }

    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { ok: false, error: 'invalid_json' }); }

    const raw   = await store.get('items', { type: 'json' }).catch(() => null);
    let   items = Array.isArray(raw) ? raw : [];

    const { action } = body;

    // ── SAVE (add or update) ───────────────────────────────────────────────
    if (action === 'save') {
      const src   = body.item || {};
      const exist = src.id ? items.find(i => i.id === src.id) : null;
      const id    = src.id || `rw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // On update, only overwrite fields explicitly present in src (partial-update safe).
      // This lets toggleGalleryVisibility send just { id, showOnHomepage } without
      // clearing vehicle, imageUrl, etc.
      const has = k => Object.prototype.hasOwnProperty.call(src, k);
      const item = {
        id,
        imageUrl:       has('imageUrl')       ? validHttpUrl(src.imageUrl)                                       : (exist ? exist.imageUrl       : ''),
        vehicle:        has('vehicle')        ? sanitizeText(src.vehicle, 120)                                   : (exist ? exist.vehicle        : ''),
        servicePackage: has('servicePackage') ? sanitizeText(src.servicePackage, 120)                            : (exist ? exist.servicePackage : ''),
        addOns:         has('addOns')         ? sanitizeText(src.addOns, 200)                                    : (exist ? exist.addOns         : ''),
        caption:        has('caption')        ? sanitizeText(src.caption, 300)                                   : (exist ? exist.caption        : ''),
        category:       has('category')       ? (VALID_CATEGORIES.includes(src.category) ? src.category:'other') : (exist ? exist.category       : 'other'),
        locationArea:   has('locationArea')   ? sanitizeText(src.locationArea, 100)                              : (exist ? exist.locationArea   : ''),
        instagramUrl:   has('instagramUrl')   ? validInstagramUrl(src.instagramUrl)                              : (exist ? exist.instagramUrl   : ''),
        beforeAfter:    has('beforeAfter')    ? (VALID_BEFORE_AFTER.includes(src.beforeAfter)?src.beforeAfter:'final') : (exist ? exist.beforeAfter : 'final'),
        showOnHomepage: has('showOnHomepage') ? (src.showOnHomepage===true||src.showOnHomepage==='true')          : (exist ? !!exist.showOnHomepage : false),
        displayOrder:   has('displayOrder')   ? (typeof src.displayOrder==='number'?src.displayOrder:null)        : (exist ? exist.displayOrder   : null),
        createdAt:      exist ? (exist.createdAt || new Date().toISOString()) : new Date().toISOString(),
        updatedAt:      new Date().toISOString(),
      };

      if (!exist) {
        items.push(item);
      } else {
        items = items.map(i => i.id === id ? item : i);
      }

      await store.setJSON('items', items);
      return json(200, { ok: true, id, action: exist ? 'updated' : 'added', item });
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    if (action === 'delete') {
      const { id } = body;
      if (!id || typeof id !== 'string') return json(400, { ok: false, error: 'missing_id' });
      const before = items.length;
      items = items.filter(i => i.id !== id);
      if (items.length === before) return json(404, { ok: false, error: 'item_not_found' });
      await store.setJSON('items', items);
      return json(200, { ok: true, id, action: 'deleted' });
    }

    // ── REORDER ────────────────────────────────────────────────────────────
    if (action === 'reorder') {
      const { ids } = body;
      if (!Array.isArray(ids)) return json(400, { ok: false, error: 'ids_must_be_array' });
      const idMap = new Map(items.map(i => [i.id, i]));
      ids.forEach((id, idx) => {
        const item = idMap.get(id);
        if (item) item.displayOrder = idx;
      });
      await store.setJSON('items', items);
      return json(200, { ok: true, action: 'reordered' });
    }

    return json(400, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
