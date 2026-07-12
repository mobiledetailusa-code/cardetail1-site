// Customer garage vehicles — authenticated account writes only.

const { jsonCors } = require('../lib/tech-security');
const { validateCustomerSession } = require('../lib/customer-session');
const { addVehicle, updateVehicle, archiveVehicle, listVehiclesForOwner } = require('../lib/customer-vehicles');
const { normalizeUsPhoneDigits } = require('../lib/phone-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const session = await validateCustomerSession(event);
  if (!session.ok || session.scope !== 'account') {
    return jsonCors(401, { ok: false, error: 'authentication_failed', message: 'Account sign-in required.' });
  }

  const phoneDigits = session.phoneDigits || normalizeUsPhoneDigits('');
  if (!phoneDigits) {
    return jsonCors(401, { ok: false, error: 'authentication_failed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error' }); }

  const action = String(body.action || 'list').toLowerCase();

  if (action === 'list') {
    const vehicles = await listVehiclesForOwner(phoneDigits);
    return jsonCors(200, { ok: true, vehicles });
  }

  if (action === 'add') {
    const result = await addVehicle(phoneDigits, body.vehicle || body);
    if (!result.ok) return jsonCors(400, result);
    return jsonCors(200, result);
  }

  if (action === 'update') {
    const id = String(body.vehicleId || body.id || '').trim();
    if (!id) return jsonCors(400, { ok: false, error: 'validation_error' });
    const result = await updateVehicle(phoneDigits, id, body.vehicle || body);
    if (!result.ok) return jsonCors(result.error === 'not_found' ? 404 : 400, result);
    return jsonCors(200, result);
  }

  if (action === 'archive') {
    const id = String(body.vehicleId || body.id || '').trim();
    if (!id) return jsonCors(400, { ok: false, error: 'validation_error' });
    const result = await archiveVehicle(phoneDigits, id);
    if (!result.ok) return jsonCors(404, result);
    return jsonCors(200, result);
  }

  return jsonCors(400, { ok: false, error: 'validation_error' });
};
