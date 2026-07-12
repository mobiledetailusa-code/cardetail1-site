// Temporary branch-only QA fixture harness for My Garage E2E (disabled in production).

const { jsonCors } = require('../lib/tech-security');
const { verifyAdminRequest } = require('../lib/admin-security');
const {
  isHarnessEnabledForRequest,
  isAllowedQaBookingId,
  isAllowedQaBooking,
  verifyQaHarnessAdmin,
  seedFixtures,
  inspectFixtures,
  cleanupFixtures,
  retrieveQaMagicCapture,
  startQaMagicLink,
  qaEmailsFromEnv,
} = require('../lib/qa-my-garage-fixtures');

function disabledResponse() {
  return jsonCors(404, { ok: false, error: 'not_found' });
}

async function verifyHarnessAdmin(headers) {
  const qa = verifyQaHarnessAdmin(headers || {});
  if (qa) return qa;
  return verifyAdminRequest(headers || {});
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return disabledResponse();
  if (!isHarnessEnabledForRequest(event)) return disabledResponse();

  const admin = await verifyHarnessAdmin(event.headers || {});
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

  if (action === 'capture_magic_link') {
    const slot = String(body.slot || body.email || 'a').toLowerCase();
    const { emailA, emailB } = qaEmailsFromEnv();
    const email = (slot === 'b' || slot.endsWith('-b')) ? emailB : emailA;
    if (!email) return jsonCors(400, { ok: false, error: 'validation_error' });
    const result = await retrieveQaMagicCapture(email);
    if (!result.ok) return jsonCors(404, result);
    return jsonCors(200, {
      ok: true,
      challengeId: result.challengeId,
      token: result.token,
      expiresAt: result.expiresAt,
    });
  }

  if (action === 'start_magic_link') {
    const host = event.headers?.['x-forwarded-host'] || event.headers?.Host || 'customer-my-garage-portal--cardetail1.netlify.app';
    const proto = String(event.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const baseUrl = `${proto}://${host}`;
    const result = await startQaMagicLink(body.slot || 'a', baseUrl);
    if (!result.ok) return jsonCors(result.error === 'validation_error' ? 400 : 503, result);
    return jsonCors(200, result);
  }

  return jsonCors(400, { ok: false, error: 'validation_error' });
};
