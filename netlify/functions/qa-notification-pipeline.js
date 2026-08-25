// Owner-only notification QA / inspect endpoint.
// Fail-closed unless NOTIFICATION_QA_ENABLED=true.
// Never creates bookings/payments. Never accepts arbitrary recipients.
// Modes:
//   inspect (default) — boolean env/policy snapshot + email contract (masked)
//   email_send        — one Resend to process.env.ADMIN_EMAIL only
//   sms_prepare       — render owner SMS preview; DOES NOT enqueue or send

'use strict';

const { verifyAdminKey, jsonCors } = require('../lib/tech-security');
const {
  qaHarnessAllowed,
  envPresence,
  emailContractSnapshot,
  sendSyntheticAdminEmail,
  prepareControlledOwnerSms,
} = require('../lib/notification-qa');

function parseBody(event) {
  if (!event?.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch { return {}; }
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(401, { ok: false, error: 'unauthorized' });

  const gate = qaHarnessAllowed(process.env);
  if (!gate.ok) {
    return jsonCors(403, { ok: false, error: gate.reason || 'notification_qa_disabled' });
  }

  const body = parseBody(event);
  const mode = String(body.mode || event.queryStringParameters?.mode || 'inspect')
    .trim()
    .toLowerCase();

  if (mode === 'inspect') {
    return jsonCors(200, {
      ok: true,
      mode: 'inspect',
      emailContract: emailContractSnapshot(process.env),
      twilio: envPresence(process.env),
      adminSmsFeature: 'implemented',
      customerSmsFeature: 'implemented_gated',
    });
  }

  if (mode === 'email_send') {
    const result = await sendSyntheticAdminEmail({ env: process.env });
    if (!result.ok) {
      return jsonCors(502, {
        ok: false,
        mode: 'email_send',
        error: result.error,
        meta: result.meta || null,
      });
    }
    return jsonCors(200, {
      ok: true,
      mode: 'email_send',
      providerAccepted: result.providerAccepted,
      providerMessageId: result.providerMessageId,
      meta: result.meta,
      realBookingChanged: false,
      customerContacted: false,
      realSmsSent: false,
    });
  }

  if (mode === 'sms_prepare') {
    const prepared = prepareControlledOwnerSms({ env: process.env });
    if (!prepared.ok) {
      return jsonCors(400, { ok: false, mode: 'sms_prepare', error: prepared.error });
    }
    return jsonCors(200, {
      ok: true,
      mode: 'sms_prepare',
      ...prepared,
      realSmsSent: false,
    });
  }

  return jsonCors(400, {
    ok: false,
    error: 'unsupported_mode',
    allowed: ['inspect', 'email_send', 'sms_prepare'],
  });
};

exports.__test = { parseBody };
