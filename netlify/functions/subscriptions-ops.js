// Maintenance / recurring customer plans — cd1-subscriptions blob store.
const { blobsStore, jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const { MAINTENANCE_PLAN_TEMPLATES } = require('../lib/ops-config');
const { listRawBookings, normalizePhone, phonesMatch } = require('../lib/ops-db');

const SUBS_STORE = 'cd1-subscriptions';

function subId() {
  return 'SUB-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function listSubscriptions() {
  const store = await blobsStore(SUBS_STORE);
  const listing = await store.list().catch(() => ({ blobs: [] }));
  const subs = (await Promise.all(
    ((listing && listing.blobs) || []).map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(Boolean);
  subs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return subs;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '');

  if (action === 'list_templates') {
    return jsonCors(200, { ok: true, templates: MAINTENANCE_PLAN_TEMPLATES });
  }

  if (action === 'customer_signup') {
    const email = sanitizeText(body.email, 200).toLowerCase();
    const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15);
    const customerName = sanitizeText(body.customerName, 120);
    const planId = sanitizeText(body.planId, 48);
    const tpl = MAINTENANCE_PLAN_TEMPLATES.find(p => p.id === planId);
    if (!tpl) return jsonCors(400, { ok: false, error: 'invalid_plan' });
    if (!email.includes('@')) return jsonCors(400, { ok: false, error: 'valid_email_required' });
    if (!phone || phone.length < 7) return jsonCors(400, { ok: false, error: 'phone_required' });

    const bookings = await listRawBookings().catch(() => []);
    const verified = bookings.some(bk =>
      !bk.isDraft && !bk.archived && bk.jobStatus !== 'archived_test' &&
      String(bk.email || '').toLowerCase() === email &&
      phonesMatch(phone, normalizePhone(bk.phone || bk.customerPhone || ''))
    );
    if (!verified) {
      return jsonCors(403, { ok: false, error: 'no_verified_booking', message: 'Complete a booking with this email and phone before subscribing.' });
    }

    const intervalMonths = tpl.intervalMonths || 1;
    const price = tpl.suggestedPrice || 0;

    const store = await blobsStore(SUBS_STORE);
    const now = new Date().toISOString();
    const id = subId();
    const sub = {
      id,
      customerName,
      email,
      phone,
      planId: planId || 'custom',
      planName: sanitizeText(body.planName || (tpl && tpl.name) || 'Maintenance', 80),
      intervalMonths,
      price,
      billingCycle: sanitizeText(body.billingCycle || 'monthly', 16),
      status: 'pending_activation',
      maxDetailsPerMonth: 1,
      address: sanitizeText(body.address, 300),
      vehicle: sanitizeText(body.vehicle, 120),
      nextVisitDate: sanitizeText(body.nextVisitDate, 32),
      notes: 'Customer portal signup — pending admin activation',
      createdAt: now,
      updatedAt: now,
    };
    await store.setJSON(id, sub);
    return jsonCors(200, { ok: true, subscription: { id: sub.id, planName: sub.planName, status: sub.status } });
  }

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(auth.error === 'missing_admin_password_config' ? 503 : 401, { ok: false, error: auth.error });

  const store = await blobsStore(SUBS_STORE);

  if (action === 'list') {
    const subs = await listSubscriptions();
    return jsonCors(200, { ok: true, count: subs.length, subscriptions: subs });
  }

  if (action === 'create') {
    const email = sanitizeText(body.email, 200).toLowerCase();
    const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15);
    const customerName = sanitizeText(body.customerName, 120);
    const planId = sanitizeText(body.planId, 48);
    const tpl = MAINTENANCE_PLAN_TEMPLATES.find(p => p.id === planId);
    const intervalMonths = Number(body.intervalMonths) || (tpl && tpl.intervalMonths) || 1;
    const price = Number(body.price) || (tpl && tpl.suggestedPrice) || 0;
    if (!email.includes('@')) return jsonCors(400, { ok: false, error: 'valid_email_required' });

    const now = new Date().toISOString();
    const id = subId();
    const sub = {
      id,
      customerName,
      email,
      phone,
      planId: planId || 'custom',
      planName: sanitizeText(body.planName || (tpl && tpl.name) || 'Maintenance', 80),
      intervalMonths,
      price,
      status: 'active',
      address: sanitizeText(body.address, 300),
      vehicle: sanitizeText(body.vehicle, 120),
      assignedTechId: sanitizeText(body.assignedTechId, 48),
      nextVisitDate: sanitizeText(body.nextVisitDate, 32),
      notes: sanitizeText(body.notes, 500),
      createdAt: now,
      updatedAt: now,
    };
    await store.setJSON(id, sub);
    return jsonCors(200, { ok: true, subscription: sub });
  }

  if (action === 'update') {
    const id = sanitizeText(body.id, 48);
    const sub = await store.get(id, { type: 'json' }).catch(() => null);
    if (!sub) return jsonCors(404, { ok: false, error: 'not_found' });
    const ALLOWED = ['customerName', 'email', 'phone', 'planName', 'intervalMonths', 'price',
      'status', 'address', 'vehicle', 'assignedTechId', 'nextVisitDate', 'notes'];
    for (const k of ALLOWED) {
      if (body[k] !== undefined) {
        if (k === 'phone') sub.phone = String(body.phone).replace(/\D/g, '').slice(0, 15);
        else if (k === 'email') sub.email = sanitizeText(body.email, 200).toLowerCase();
        else if (k === 'intervalMonths' || k === 'price') sub[k] = Number(body[k]);
        else sub[k] = sanitizeText(body[k], k === 'notes' ? 500 : 200);
      }
    }
    sub.updatedAt = new Date().toISOString();
    await store.setJSON(id, sub);
    return jsonCors(200, { ok: true, subscription: sub });
  }

  if (action === 'cancel') {
    const id = sanitizeText(body.id, 48);
    const sub = await store.get(id, { type: 'json' }).catch(() => null);
    if (!sub) return jsonCors(404, { ok: false, error: 'not_found' });
    sub.status = 'cancelled';
    sub.cancelledAt = new Date().toISOString();
    sub.updatedAt = sub.cancelledAt;
    await store.setJSON(id, sub);
    return jsonCors(200, { ok: true });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
