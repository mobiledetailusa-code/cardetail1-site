// netlify/functions/recent-work.js
// Public endpoint — returns showOnHomepage:true gallery items only.
// No auth required. Fields returned are limited to public-safe subset.
//
// GET /.netlify/functions/recent-work
// 200 { ok: true, items: [...] }

const PUBLIC_FIELDS = [
  'id','imageUrl','vehicle','servicePackage','addOns','caption',
  'category','locationArea','instagramUrl','beforeAfter','createdAt','displayOrder'
];

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET')     return json(405, { ok: false });

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID;
    const token  = process.env.NETLIFY_AUTH_TOKEN;
    const store  = (siteID && token)
      ? getStore({ name: 'cd1-recent-work', siteID, token })
      : getStore('cd1-recent-work');

    const raw  = await store.get('items', { type: 'json' }).catch(() => null);
    const all  = Array.isArray(raw) ? raw : [];

    const items = all
      .filter(item => item && item.showOnHomepage === true)
      .map(item => {
        const pub = {};
        PUBLIC_FIELDS.forEach(k => { if (item[k] !== undefined) pub[k] = item[k]; });
        return pub;
      })
      .sort((a, b) => {
        const ao = (a.displayOrder != null) ? a.displayOrder : 9999;
        const bo = (b.displayOrder != null) ? b.displayOrder : 9999;
        if (ao !== bo) return ao - bo;
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      });

    return json(200, { ok: true, items });
  } catch (e) {
    return json(500, { ok: false, error: 'storage_error' });
  }
};
