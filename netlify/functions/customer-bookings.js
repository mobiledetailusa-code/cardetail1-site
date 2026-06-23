// Customer cloud lookup — list bookings by verified phone or email (no admin auth).
const { jsonCors } = require('../lib/tech-security');
const { listRawBookings, normalizePhone, phonesMatch } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const phone = normalizePhone(body.phone || '');
  const email = String(body.email || '').trim().toLowerCase();

  if (!phone || phone.length < 7) {
    return jsonCors(400, { ok: false, error: 'phone_required' });
  }

  try {
    const all = await listRawBookings();
    let matches = all.filter(b => !b.archived && !b.isTest && b.jobStatus !== 'archived_test');
    matches = matches.filter(b => phonesMatch(phone, normalizePhone(b.phone || b.customerPhone || '')));
    if (email.includes('@')) {
      matches = matches.filter(b => String(b.email || '').toLowerCase() === email);
    }

    matches.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const bookings = matches.map(projectBookingForCustomer);

    return jsonCors(200, { ok: true, count: bookings.length, bookings });
  } catch {
    return jsonCors(500, { ok: false, error: 'lookup_failed' });
  }
};
