const {
  TECH_STORE, SESSION_STORE, SESSION_TTL_MS, blobStore, normalizeEmail,
  tokenHash, randomToken, hashPassword, verifyPassword, publicTech,
  findTechByEmail, validateTechSession,
} = require('../lib/tech-security');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-tech-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }
  const action = String(body.action || '').trim();

  try {
    if (action === 'login') {
      const tech = await findTechByEmail(normalizeEmail(body.email));
      if (!tech || !tech.passwordHash || !(await verifyPassword(String(body.password || ''), tech.passwordHash))) {
        return json(401, { ok: false, error: 'invalid_credentials' });
      }
      if (tech.active === false) return json(403, { ok: false, error: 'technician_inactive' });
      const token = randomToken();
      const key = tokenHash(token);
      const now = new Date();
      const session = {
        tokenHash: key, techId: tech.techId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      };
      const sessions = await blobStore(SESSION_STORE);
      await sessions.setJSON(key, session);
      tech.lastLoginAt = now.toISOString();
      tech.updatedAt = now.toISOString();
      await (await blobStore(TECH_STORE)).setJSON(tech.techId, tech);
      return json(200, { ok: true, token, expiresAt: session.expiresAt, technician: publicTech(tech) });
    }

    if (action === 'set_password') {
      const inviteToken = String(body.inviteToken || '');
      const password = String(body.password || '');
      if (!inviteToken || password.length < 10) return json(400, { ok: false, error: 'valid_invite_and_password_required' });
      const store = await blobStore(TECH_STORE);
      const listing = await store.list();
      const techs = (await Promise.all((listing.blobs || []).map(i => store.get(i.key, { type: 'json' })))).filter(Boolean);
      const inviteHash = tokenHash(inviteToken);
      const tech = techs.find(t => t.inviteTokenHash && t.inviteTokenHash === inviteHash);
      if (!tech) return json(400, { ok: false, error: 'invalid_or_used_invite' });
      if (Date.parse(tech.inviteExpiresAt) <= Date.now()) return json(400, { ok: false, error: 'invite_expired' });
      if (tech.active === false) return json(403, { ok: false, error: 'technician_inactive' });
      tech.passwordHash = await hashPassword(password);
      tech.inviteTokenHash = '';
      tech.inviteExpiresAt = '';
      tech.updatedAt = new Date().toISOString();
      await store.setJSON(tech.techId, tech);
      return json(200, { ok: true });
    }

    const auth = await validateTechSession(event);
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
    if (action === 'validate') return json(200, { ok: true, technician: publicTech(auth.tech), expiresAt: auth.session.expiresAt });
    if (action === 'logout') {
      await (await blobStore(SESSION_STORE)).delete(auth.sessionKey);
      return json(200, { ok: true });
    }
    return json(400, { ok: false, error: 'invalid_action' });
  } catch (error) {
    console.error('[tech-auth]', error.message);
    return json(500, { ok: false, error: 'server_error' });
  }
};
