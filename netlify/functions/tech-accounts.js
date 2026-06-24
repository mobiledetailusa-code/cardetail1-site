// Admin-only technician account management (cd1-tech-accounts).
const {
  blobsStore, listAllBlobs, fetchBlobRecords, jsonCors, verifyAdminKey, generateInviteToken, generateTechId,
  sanitizeText, INVITE_TTL_MS, hashPassword, isWeakPassword,
} = require('../lib/tech-security');
const { projectTechAccountForAdmin } = require('../lib/ops-workflow');

async function attachAssignedJobCounts(technicians) {
  try {
    const bookings = await blobsStore('cd1-bookings');
    const blobs = await listAllBlobs(bookings, 'cd1-bookings');
    const counts = {};
    const records = await fetchBlobRecords(bookings, blobs, 25);
    for (const bk of records) {
      if (!bk || bk.isDraft) continue;
      const tid = bk.assignedTechId || bk.assignedTech;
      if (tid) counts[tid] = (counts[tid] || 0) + 1;
    }
    technicians.forEach(t => { t.assignedJobsCount = counts[t.techId] || 0; });
  } catch (e) {
    console.warn('[tech-accounts] assignedJobsCount scan skipped:', e.message);
    technicians.forEach(t => { t.assignedJobsCount = t.assignedJobsCount || 0; });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  try {
    const auth = await verifyAdminKey(event.headers || {});
    if (!auth.ok) {
      const status = auth.error === 'missing_admin_config' ? 503 : 401;
      return jsonCors(status, { ok: false, error: auth.error || 'unauthorized' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

    const action = String(body.action || '');

    async function openTechStore() {
      try {
        return await blobsStore('cd1-tech-accounts');
      } catch (e) {
        console.error('[tech-accounts] blobsStore failed:', e.message, e.stack);
        return null;
      }
    }

    const store = await openTechStore();

    async function getTech(techId) {
      if (!store) return null;
      return store.get('tech-' + techId, { type: 'json' }).catch(() => null);
    }

    async function listTechs() {
      if (!store) return [];
      const blobs = await listAllBlobs(store, 'cd1-tech-accounts');
      const techBlobs = blobs.filter(b => b.key.startsWith('tech-'));
      const records = await fetchBlobRecords(store, techBlobs, 15);
      const out = [];
      for (const t of records) {
        try { out.push(projectTechAccountForAdmin(t)); }
        catch (e) { console.warn('[tech-accounts] skip malformed tech record:', e.message); }
      }
      out.sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
      return out;
    }

    if (action === 'list') {
      const technicians = await listTechs();
      if (store) await attachAssignedJobCounts(technicians);
      return jsonCors(200, {
        ok: true,
        technicians,
        ...(store ? {} : { warning: 'tech_store_unavailable' }),
      });
    }

    if (!store) {
      return jsonCors(503, { ok: false, error: 'tech_store_unavailable' });
    }

    if (action === 'create') {
      const fullName = sanitizeText(body.fullName || body.name, 100);
      const email = sanitizeText(body.email, 200).toLowerCase();
      const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15);
      const serviceArea = sanitizeText(body.serviceArea, 200);
      const capabilities = Array.isArray(body.capabilities)
        ? body.capabilities.map(c => sanitizeText(c, 80)).filter(Boolean).slice(0, 20)
        : sanitizeText(body.capabilities, 500).split(',').map(s => s.trim()).filter(Boolean);

      if (!fullName) return jsonCors(400, { ok: false, error: 'fullName_required' });
      if (!email.includes('@')) return jsonCors(400, { ok: false, error: 'valid_email_required' });

      const existing = await listTechs();
      if (existing.some(t => t.email === email)) return jsonCors(409, { ok: false, error: 'email_already_exists' });

      const techId = generateTechId();
      const inviteToken = generateInviteToken();
      const now = new Date().toISOString();
      const technician = {
        techId, id: techId, fullName, name: fullName, email, phone,
        active: true, capabilities, serviceArea,
        passwordHash: null, inviteToken, inviteUsed: false,
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        createdAt: now, updatedAt: now, lastLoginAt: null,
      };
      await store.setJSON('tech-' + techId, technician);
      return jsonCors(200, { ok: true, technician: projectTechAccountForAdmin(technician), inviteToken });
    }

    if (action === 'update') {
      const techId = sanitizeText(body.techId, 48);
      const tech = await getTech(techId);
      if (!tech) return jsonCors(404, { ok: false, error: 'technician_not_found' });
      const updates = body.updates || {};
      const ALLOWED = ['fullName', 'name', 'email', 'phone', 'active', 'capabilities', 'serviceArea'];
      for (const [k, v] of Object.entries(updates)) {
        if (!ALLOWED.includes(k)) continue;
        if (k === 'fullName' || k === 'name') { tech.fullName = sanitizeText(v, 100); tech.name = tech.fullName; }
        else if (k === 'email') tech.email = sanitizeText(v, 200).toLowerCase();
        else if (k === 'phone') tech.phone = String(v).replace(/\D/g, '').slice(0, 15);
        else if (k === 'active') tech.active = !!v;
        else if (k === 'serviceArea') tech.serviceArea = sanitizeText(v, 200);
        else if (k === 'capabilities') {
          tech.capabilities = Array.isArray(v)
            ? v.map(c => sanitizeText(c, 80)).filter(Boolean).slice(0, 20)
            : sanitizeText(v, 500).split(',').map(s => s.trim()).filter(Boolean);
        }
      }
      tech.updatedAt = new Date().toISOString();
      await store.setJSON('tech-' + techId, tech);
      return jsonCors(200, { ok: true, technician: projectTechAccountForAdmin(tech) });
    }

    if (action === 'deactivate' || action === 'reactivate') {
      const techId = sanitizeText(body.techId, 48);
      const tech = await getTech(techId);
      if (!tech) return jsonCors(404, { ok: false, error: 'technician_not_found' });
      tech.active = action === 'reactivate';
      tech.updatedAt = new Date().toISOString();
      await store.setJSON('tech-' + techId, tech);
      return jsonCors(200, { ok: true });
    }

    if (action === 'reset_invite') {
      const techId = sanitizeText(body.techId, 48);
      const tech = await getTech(techId);
      if (!tech) return jsonCors(404, { ok: false, error: 'technician_not_found' });
      const inviteToken = generateInviteToken();
      tech.inviteToken = inviteToken;
      tech.inviteUsed = false;
      tech.passwordHash = null;
      tech.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      tech.updatedAt = new Date().toISOString();
      await store.setJSON('tech-' + techId, tech);
      return jsonCors(200, { ok: true, inviteToken });
    }

    if (action === 'set_password') {
      const techId = sanitizeText(body.techId, 48);
      const tech = await getTech(techId);
      if (!tech) return jsonCors(404, { ok: false, error: 'technician_not_found' });
      const newPassword = String(body.newPassword || '');
      const confirmPassword = String(body.confirmPassword || '');
      if (!newPassword || !confirmPassword) {
        return jsonCors(400, { ok: false, error: 'password_required' });
      }
      if (newPassword !== confirmPassword) {
        return jsonCors(400, { ok: false, error: 'passwords_do_not_match' });
      }
      const weakness = isWeakPassword(newPassword);
      if (weakness) return jsonCors(400, { ok: false, error: 'weak_password', message: weakness });
      tech.passwordHash = hashPassword(newPassword);
      tech.inviteToken = null;
      tech.inviteUsed = true;
      tech.inviteExpiresAt = null;
      tech.updatedAt = new Date().toISOString();
      await store.setJSON('tech-' + techId, tech);
      return jsonCors(200, { ok: true, techId, hasPassword: true });
    }

    return jsonCors(400, { ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[tech-accounts] unhandled:', e.message, e.stack);
    return jsonCors(500, { ok: false, error: 'server_error' });
  }
};
