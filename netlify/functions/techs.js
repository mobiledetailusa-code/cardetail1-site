// netlify/functions/techs.js
// Stores the technician roster (name + phone) centrally in Netlify Blobs so the
// auction can SMS techs when a job is posted. Admin-protected save/list.
//
// Env: ADMIN_DASH_PASSWORD (to save/list).
//
//   POST {action:'save', techs:[{id,name,phone}]}  (x-admin-key)  → save roster
//   GET  ?action=list                              (x-admin-key)  → list roster

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

async function rosterStore() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name: 'cd1-techs', siteID, token }) : getStore('cd1-techs');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const expected = process.env.ADMIN_DASH_PASSWORD || '';
  if (!expected) return json(503, { ok: false, error: 'ADMIN_DASH_PASSWORD not set on server' });
  const key = (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) ||
    (event.queryStringParameters && event.queryStringParameters.key) || '';
  if (key !== expected) return json(401, { ok: false, error: 'unauthorized' });

  try {
    const s = await rosterStore();
    if (event.httpMethod === 'POST') {
      const p = JSON.parse(event.body || '{}');
      const techs = (Array.isArray(p.techs) ? p.techs : [])
        .filter(t => t && (t.phone || t.email || t.id))
        .map(t => ({
          id:     t.id || ('TECH-' + (t.phone || '').replace(/\D/g, '')),
          name:   t.name || 'Technician',
          phone:  String(t.phone || ''),
          email:  (t.email || '').toLowerCase().trim(),
          status: t.status || 'approved',
        }));
      await s.setJSON('roster', techs);
      return json(200, { ok: true, count: techs.length });
    }
    const roster = (await s.get('roster', { type: 'json' })) || [];
    return json(200, { ok: true, techs: roster });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
