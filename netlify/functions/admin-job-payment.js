// Admin-only job payment actions — invoice, card on file, cash, retry.
const { blobsStore, jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const { executeAdminPaymentAction, JOB_PAYMENT_ACTIONS } = require('../lib/admin-job-payment');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) {
    const status = auth.error === 'missing_admin_config' ? 503 : 401;
    return jsonCors(status, { ok: false, error: auth.error || 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = sanitizeText(body.action, 40);
  const bookingId = sanitizeText(body.bookingId, 48);
  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });
  if (!JOB_PAYMENT_ACTIONS.has(action)) {
    return jsonCors(400, { ok: false, error: 'invalid_action', allowed: [...JOB_PAYMENT_ACTIONS] });
  }

  const store = await blobsStore('cd1-bookings');
  const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });

  const outcome = await executeAdminPaymentAction(
    { ...booking, id: bookingId },
    action,
    body,
    { sanitizeText }
  );

  if (outcome.patched) {
    try {
      await store.setJSON(bookingId, outcome.patched);
    } catch (e) {
      return jsonCors(500, { ok: false, error: 'booking_store_failed' });
    }
  }

  if (!outcome.ok) {
    return jsonCors(outcome.status || 400, {
      ok: false,
      error: outcome.error,
      userMessage: outcome.userMessage,
      ...(outcome.result || {}),
    });
  }

  const safe = { ...(outcome.result || {}) };
  delete safe.stripeCustomerId;
  delete safe.stripePaymentMethodId;
  delete safe.paymentIntentId;
  return jsonCors(200, { ok: true, action, bookingId, ...safe });
};
