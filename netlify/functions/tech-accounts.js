const {
  TECH_STORE, SESSION_STORE, INVITE_TTL_MS, blobStore, requireAdmin,
  normalizeEmail, normalizeId, randomToken, tokenHash, hashPassword,
  publicTech, listStore, findTechByEmail,
} = require('../lib/tech-security');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const clean = (value, max = 200) => String(value || '').trim().slice(0, max);

function issueInvite(tech) {
  const inviteToken = randomToken();
  tech.inviteTokenHash = tokenHash(inviteToken);
  tech.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  tech._inviteToken = inviteToken;
  return inviteToken;
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const admin = requireAdmin(event);
  if (!admin.ok) return json(admin.status, { ok: false, error: admin.error });

  try {
    const store = await blobStore(TECH_STORE);
    if (event.httpMethod === 'GET') {
      const technicians = (await listStore(store))
        .map(tech => publicTech(tech))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
      return json(200, { ok: true, technicians });
    }
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { ok: false, error: 'invalid_json' }); }
    const action = clean(body.action, 40);
    const now = new Date().toISOString();

    if (action === 'create') {
      const email = normalizeEmail(body.email);
      const fullName = clean(body.fullName, 120);
      if (!email || !email.includes('@') || !fullName) {
        return json(400, { ok: false, error: 'fullName_and_valid_email_required' });
      }
      if (await findTechByEmail(email)) return json(409, { ok: false, error: 'email_already_exists' });
      const techId = `TECH-${randomToken(9).replace(/[^A-Z0-9]/gi, '').toUpperCase()}`;
      const tech = {
        techId, fullName, email,
        phone: clean(body.phone, 40),
        active: true,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(v => clean(v, 80)).filter(Boolean).slice(0, 20) : [],
        serviceArea: clean(body.serviceArea, 300),
        createdAt: now, updatedAt: now, lastLoginAt: '',
        passwordHash: '',
      };
      const password = String(body.password || '');
      let inviteToken = '';
      if (password) {
        if (password.length < 10) return json(400, { ok: false, error: 'password_too_short' });
        tech.passwordHash = await hashPassword(password);
        tech.inviteTokenHash = '';
        tech.inviteExpiresAt = '';
      } else {
        inviteToken = issueInvite(tech);
      }
      delete tech._inviteToken;
      await store.setJSON(techId, tech);
      return json(201, { ok: true, technician: publicTech(tech), inviteToken });
    }

    const techId = normalizeId(body.techId);
    if (!techId) return json(400, { ok: false, error: 'techId_required' });
    const tech = await store.get(techId, { type: 'json' }).catch(() => null);
    if (!tech) return json(404, { ok: false, error: 'technician_not_found' });

    if (action === 'update') {
      if (body.fullName !== undefined) tech.fullName = clean(body.fullName, 120);
      if (body.phone !== undefined) tech.phone = clean(body.phone, 40);
      if (body.serviceArea !== undefined) tech.serviceArea = clean(body.serviceArea, 300);
      if (body.capabilities !== undefined) {
        if (!Array.isArray(body.capabilities)) return json(400, { ok: false, error: 'capabilities_must_be_array' });
        tech.capabilities = body.capabilities.map(v => clean(v, 80)).filter(Boolean).slice(0, 20);
      }
    } else if (action === 'deactivate' || action === 'reactivate') {
      tech.active = action === 'reactivate';
      if (!tech.active) {
        const sessions = await blobStore(SESSION_STORE);
        const allSessions = await listStore(sessions);
        await Promise.all(allSessions.filter(s => s.techId === techId).map(s => sessions.delete(s.tokenHash || '')));
      }
    } else if (action === 'reset_invite') {
      const inviteToken = issueInvite(tech);
      tech.passwordHash = '';
      tech.updatedAt = now;
      delete tech._inviteToken;
      await store.setJSON(techId, tech);
      return json(200, { ok: true, technician: publicTech(tech), inviteToken });
    } else {
      return json(400, { ok: false, error: 'invalid_action' });
    }

    tech.updatedAt = now;
    await store.setJSON(techId, tech);
    return json(200, { ok: true, technician: publicTech(tech) });
  } catch (error) {
    console.error('[tech-accounts]', error.message);
    return json(500, { ok: false, error: 'server_error' });
  }
};
