// netlify/functions/techs.js
// Stores the technician roster (name + phone) centrally in Netlify Blobs so the
// auction can SMS techs when a job is posted. Admin-protected save/list.
//
// Env: ADMIN_DASH_PASSWORD (to save/list).
//
//   POST {action:'save', techs:[{id,name,phone}]}  (x-admin-key)  → save roster
//   GET  ?action=list                              (x-admin-key)  → list roster

const {
  cleanText,
  json: secureJson,
  rateLimit,
  requireAdmin,
} = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body, {
  allowMethods: 'GET, POST, OPTIONS',
});

async function rosterStore() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name: 'cd1-techs', siteID, token }) : getStore('cd1-techs');
}

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const rl = await rateLimit(event, 'techs-admin', 60, 60);
  if (!rl.ok) return json(rl.status, rl.body);
  const admin = requireAdmin(event);
  if (!admin.ok) return json(admin.status, admin.body);

  try {
    const s = await rosterStore();
    if (event.httpMethod === 'POST') {
      const p = JSON.parse(event.body || '{}');
      const techs = (Array.isArray(p.techs) ? p.techs : [])
        .filter(t => t && t.phone)
        .map(t => ({
          id: cleanText(t.id || ('TECH-' + (t.phone || '').replace(/\D/g, '')), 80),
          name: cleanText(t.name || 'Technician', 120),
          phone: String(t.phone || '').replace(/\D/g, '').slice(0, 15),
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
