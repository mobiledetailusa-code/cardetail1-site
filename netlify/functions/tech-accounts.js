// netlify/functions/tech-accounts.js
// Admin-only CRUD for technician accounts. Stored in Netlify Blobs (cd1-tech-accounts).
//
// Auth: x-admin-token header (session token from admin-session.js).
//
// POST { action, ...params }
//   list                                → { ok, technicians }
//   create   { name, email, phone }     → { ok, technician, inviteToken }
//   update   { techId, updates }        → { ok, technician }
//   deactivate { techId }               → { ok }
//   reactivate { techId }               → { ok }
//   reset_password { techId }           → { ok, inviteToken }

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

async function getStore(name) {
  const { getStore: gs } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? gs({ name, siteID, token }) : gs(name);
}

async function securityLog(entry) {
  try {
    const store = await getStore('cd1-security-log');
    const key = 'log-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    await store.setJSON(key, { ...entry, at: new Date().toISOString() });
  } catch (_) {}
}

async function verifyAdmin(headers) {
  const h = headers || {};
  const token = (h['x-admin-token'] || h['X-Admin-Token'] || '').trim();
  if (!token || token.length < 32) return false;
  const sessionStore = await getStore('cd1-admin-sessions');
  const key = 'sess-' + token.slice(0, 16);
  const s = await sessionStore.get(key, { type: 'json' }).catch(() => null);
  if (!s || Date.now() > s.expiresAt) return false;
  return crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token));
  // NOTE: existing endpoints (list-bookings, update-booking, capture-payment, etc.)
  // still use x-admin-key. Migrate those in a future PR.
}

const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

function generateInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function generateTechId() {
  return 'TECH-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  if (!(await verifyAdmin(event.headers))) {
    await securityLog({ type: 'tech_accounts_unauthorized', ip: ((event.headers || {})['x-forwarded-for'] || '').slice(0, 45) });
    return json(401, { ok: false, error: 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '');
  const store = await getStore('cd1-tech-accounts');

  // ── LIST ──────────────────────────────────────────────────────────────
  if (action === 'list') {
    const listing = await store.list().catch(() => ({ blobs: [] }));
    const blobs = (listing && listing.blobs) || [];
    const technicians = [];
    for (const b of blobs) {
      if (!b.key.startsWith('tech-')) continue;
      const t = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (t) {
        const { passwordHash, inviteToken, ...safe } = t;
        safe.hasPassword = !!passwordHash;
        safe.hasInviteToken = !!inviteToken;
        technicians.push(safe);
      }
    }
    return json(200, { ok: true, technicians });
  }

  // ── CREATE ────────────────────────────────────────────────────────────
  if (action === 'create') {
    const name = String(body.name || '').trim().slice(0, 100);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15);

    if (!name) return json(400, { ok: false, error: 'name_required' });
    if (!email || !email.includes('@')) return json(400, { ok: false, error: 'valid_email_required' });
    if (!phone || phone.length < 7) return json(400, { ok: false, error: 'valid_phone_required' });

    // Check for duplicate email
    const listing = await store.list().catch(() => ({ blobs: [] }));
    const blobs = (listing && listing.blobs) || [];
    for (const b of blobs) {
      if (!b.key.startsWith('tech-')) continue;
      const existing = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (existing && existing.email === email) {
        return json(409, { ok: false, error: 'email_already_exists' });
      }
    }

    const techId = generateTechId();
    const inviteToken = generateInviteToken();
    const now = new Date().toISOString();
    const technician = {
      id: techId,
      name,
      email,
      phone,
      role: 'technician',
      active: true,
      passwordHash: null,
      inviteToken,
      inviteTokenCreatedAt: now,
      inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      assignedJobCount: 0,
      lastLogin: null,
      createdAt: now,
      updatedAt: now,
    };

    await store.setJSON('tech-' + techId, technician);
    await securityLog({ type: 'tech_account_created', techId, email });

    const { passwordHash, ...safe } = technician;
    return json(200, { ok: true, technician: safe, inviteToken });
  }

  // ── UPDATE ────────────────────────────────────────────────────────────
  if (action === 'update') {
    const techId = String(body.techId || '').trim();
    if (!techId) return json(400, { ok: false, error: 'techId_required' });

    const tech = await store.get('tech-' + techId, { type: 'json' }).catch(() => null);
    if (!tech) return json(404, { ok: false, error: 'technician_not_found' });

    const updates = body.updates || {};
    const ALLOWED = ['name', 'email', 'phone', 'active'];
    const patched = { ...tech, updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(updates)) {
      if (!ALLOWED.includes(k)) continue;
      if (k === 'email') patched.email = String(v).trim().toLowerCase().slice(0, 200);
      else if (k === 'phone') patched.phone = String(v).replace(/\D/g, '').slice(0, 15);
      else if (k === 'name') patched.name = String(v).trim().slice(0, 100);
      else if (k === 'active') patched.active = !!v;
    }

    await store.setJSON('tech-' + techId, patched);
    await securityLog({ type: 'tech_account_updated', techId, fields: Object.keys(updates) });

    const { passwordHash, inviteToken, inviteTokenCreatedAt, ...safe } = patched;
    safe.hasPassword = !!passwordHash;
    return json(200, { ok: true, technician: safe });
  }

  // ── DEACTIVATE ────────────────────────────────────────────────────────
  if (action === 'deactivate') {
    const techId = String(body.techId || '').trim();
    if (!techId) return json(400, { ok: false, error: 'techId_required' });

    const tech = await store.get('tech-' + techId, { type: 'json' }).catch(() => null);
    if (!tech) return json(404, { ok: false, error: 'technician_not_found' });

    tech.active = false;
    tech.updatedAt = new Date().toISOString();
    await store.setJSON('tech-' + techId, tech);

    // Destroy tech sessions
    const sessStore = await getStore('cd1-tech-sessions');
    const sessList = await sessStore.list().catch(() => ({ blobs: [] }));
    for (const b of (sessList.blobs || [])) {
      if (!b.key.startsWith('tsess-')) continue;
      const s = await sessStore.get(b.key, { type: 'json' }).catch(() => null);
      if (s && s.techId === techId) try { await sessStore.delete(b.key); } catch (_) {}
    }

    await securityLog({ type: 'tech_account_deactivated', techId });
    return json(200, { ok: true });
  }

  // ── REACTIVATE ────────────────────────────────────────────────────────
  if (action === 'reactivate') {
    const techId = String(body.techId || '').trim();
    if (!techId) return json(400, { ok: false, error: 'techId_required' });

    const tech = await store.get('tech-' + techId, { type: 'json' }).catch(() => null);
    if (!tech) return json(404, { ok: false, error: 'technician_not_found' });

    tech.active = true;
    tech.updatedAt = new Date().toISOString();
    await store.setJSON('tech-' + techId, tech);

    await securityLog({ type: 'tech_account_reactivated', techId });
    return json(200, { ok: true });
  }

  // ── RESET PASSWORD ────────────────────────────────────────────────────
  if (action === 'reset_password') {
    const techId = String(body.techId || '').trim();
    if (!techId) return json(400, { ok: false, error: 'techId_required' });

    const tech = await store.get('tech-' + techId, { type: 'json' }).catch(() => null);
    if (!tech) return json(404, { ok: false, error: 'technician_not_found' });

    const inviteToken = generateInviteToken();
    tech.passwordHash = null;
    tech.inviteToken = inviteToken;
    tech.inviteTokenCreatedAt = new Date().toISOString();
    tech.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    tech.updatedAt = new Date().toISOString();
    await store.setJSON('tech-' + techId, tech);

    // Destroy existing tech sessions
    const sessStore = await getStore('cd1-tech-sessions');
    const sessList = await sessStore.list().catch(() => ({ blobs: [] }));
    for (const b of (sessList.blobs || [])) {
      if (!b.key.startsWith('tsess-')) continue;
      const s = await sessStore.get(b.key, { type: 'json' }).catch(() => null);
      if (s && s.techId === techId) try { await sessStore.delete(b.key); } catch (_) {}
    }

    await securityLog({ type: 'tech_password_reset', techId });
    return json(200, { ok: true, inviteToken });
  }

  return json(400, { ok: false, error: 'unknown_action' });
};
