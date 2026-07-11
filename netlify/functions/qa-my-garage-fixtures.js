// Temporary branch-only QA fixture harness for My Garage E2E (disabled in production).

const { jsonCors } = require('../lib/tech-security');
const { verifyAdminRequest } = require('../lib/admin-security');
const {
  isHarnessEnabled,
  isAllowedQaBookingId,
  isAllowedQaBooking,
  seedFixtures,
  inspectFixtures,
  cleanupFixtures,
} = require('../lib/qa-my-garage-fixtures');

function disabledResponse() {
  return jsonCors(404, { ok: false, error: 'not_found' });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return disabledResponse();
  if (!isHarnessEnabled()) return disabledResponse();

  const admin = await verifyAdminRequest(event.headers || {});
  if (!admin.ok) return jsonCors(401, { ok: false, error: 'unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error' }); }

  const action = String(body.action || '').toLowerCase();
  const targetId = String(body.bookingId || body.id || '').trim().toUpperCase();

  if (targetId && !isAllowedQaBookingId(targetId)) {
    return jsonCors(403, { ok: false, error: 'forbidden', message: 'Only QA-MYGARAGE-* fixtures are allowed.' });
  }

  if (action === 'seed') {
    const result = await seedFixtures();
    if (!result.ok) return jsonCors(result.error === 'validation_error' ? 400 : 503, result);
    return jsonCors(200, result);
  }

  if (action === 'inspect') {
    if (targetId) {
      const { getBooking } = require('../lib/ops-db');
      const booking = await getBooking(targetId);
      if (!isAllowedQaBooking(booking)) {
        return jsonCors(404, { ok: false, error: 'not_found' });
      }
      return jsonCors(200, {
        ok: true,
        booking: {
          id: booking.id,
          status: booking.status,
          qaFixture: true,
          qaExpiresAt: booking.qaExpiresAt,
          qaInertPayLink: !!booking.qaInertPayLink,
        },
      });
    }
    const result = await inspectFixtures();
    return jsonCors(200, result);
  }

  if (action === 'cleanup') {
    const result = await cleanupFixtures();
    return jsonCors(200, result);
  }

  return jsonCors(400, { ok: false, error: 'validation_error' });
};
