'use strict';

const crypto = require('crypto');
const { CUSTOMER_SMS_BRAND } = require('./sms-program');
const { trustedSiteOrigin } = require('./trusted-site-origin');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { enabled } = require('./twilio-runtime-policy');
const { enqueueSms } = require('./sms-outbox');
const { TEMPLATE_KEYS } = require('./sms-templates');
const {
  inboundSmsTwiml,
  twimlResponse,
  escapeXml,
  EMPTY_TWIML,
} = require('./twilio-forwarding');

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

function complianceKeyword(params = {}) {
  const advanced = String(params.OptOutType || '').trim().toUpperCase();
  if (['STOP', 'HELP', 'START'].includes(advanced)) return advanced;
  const body = String(params.Body || '').trim().toUpperCase();
  if (STOP_WORDS.has(body)) return 'STOP';
  if (HELP_WORDS.has(body)) return 'HELP';
  return '';
}

function inboundSiteHost(env = process.env) {
  const explicit = String(env.PUBLIC_SITE_URL || env.TRUSTED_PUBLIC_SITE_ORIGIN || '').trim();
  if (explicit) {
    try {
      return new URL(explicit).host.replace(/^www\./i, '');
    } catch {
      /* fall through */
    }
  }
  try {
    return new URL(trustedSiteOrigin()).host.replace(/^www\./i, '');
  } catch {
    return 'cardetail1.com';
  }
}

function buildInboundAutoReply(env = process.env) {
  const host = inboundSiteHost(env);
  return `${CUSTOMER_SMS_BRAND}: Thanks for your message! Book mobile detailing at ${host} or tell us your question here and we will follow up. Reply STOP to opt out.`;
}

function emptyTwiml() {
  return EMPTY_TWIML;
}

function twimlMessage(body) {
  return twimlResponse(`<Message>${escapeXml(body)}</Message>`);
}

function combineForwardAndReply(relayBody, autoReply) {
  const inner = String(relayBody || '')
    .replace(/^<\?xml[^>]*>\s*/i, '')
    .replace(/^<Response>/i, '')
    .replace(/<\/Response>\s*$/i, '');
  return twimlResponse(`${inner}<Message>${escapeXml(autoReply)}</Message>`);
}

function inboundAdminIdempotencyKey(params = {}) {
  const messageSid = String(params.MessageSid || params.SmsSid || '').trim();
  if (/^SM[a-zA-Z0-9]{8,}$/.test(messageSid)) {
    return `admin.inbound-sms:${messageSid}`;
  }
  const from = normalizeUsPhoneE164(params.From || '') || 'unknown';
  const body = String(params.Body || '').trim();
  const digest = crypto.createHash('sha256').update(`${from}|${body}`).digest('hex').slice(0, 40);
  return `admin.inbound-sms:${digest}`;
}

async function notifyAdminInboundSms(params = {}, opts = {}) {
  const env = opts.env || process.env;
  const from = normalizeUsPhoneE164(params.From || '');
  const body = String(params.Body || '').trim();
  if (!from || !body) return { ok: false, reason: 'missing_fields' };
  const queued = await enqueueSms({
    idempotencyKey: inboundAdminIdempotencyKey(params),
    audience: 'admin',
    consentGranted: enabled(env.ADMIN_SMS_CONSENT_GRANTED),
    toE164: env.ADMIN_SMS,
    templateKey: TEMPLATE_KEYS.ADMIN_INBOUND_SMS,
    templateData: {
      customerPhone: from,
      message: body,
    },
  }, { env, prisma: opts.prisma });
  return queued;
}

async function handleInboundSms(params = {}, opts = {}) {
  const env = opts.env || process.env;
  const type = complianceKeyword(params);
  if (type === 'STOP') {
    const revoke = opts.revokeConsent
      || require('./sms-consent-service').revokeSmsConsentByPhone;
    const result = await revoke(params.From, opts);
    if (!result.ok) return { statusCode: 503, body: '' };
    return { statusCode: 200, twiml: emptyTwiml(), action: 'stop' };
  }
  // Advanced Opt-Out sends the configured STOP/HELP response. Returning empty
  // TwiML prevents a duplicate application-generated message.
  if (type === 'HELP' || type === 'START') {
    return { statusCode: 200, twiml: emptyTwiml(), action: type.toLowerCase() };
  }

  const relay = inboundSmsTwiml(params, env);
  const autoReply = buildInboundAutoReply(env);
  let adminNotify = null;

  if (!relay.forwarded) {
    adminNotify = notifyAdminInboundSms(params, opts).catch((err) => {
      console.info('[twilio-inbound]', {
        action: 'admin_notify_failed',
        error: String(err?.message || err).slice(0, 48),
      });
      return { ok: false, reason: 'admin_notify_failed' };
    });
    if (opts.awaitAdminNotify === true) {
      await adminNotify;
    }
  }

  const twiml = relay.forwarded
    ? combineForwardAndReply(relay.body, autoReply)
    : twimlMessage(autoReply);

  return {
    statusCode: 200,
    twiml,
    action: relay.forwarded ? 'forward_and_reply' : 'auto_reply',
    forwarded: !!relay.forwarded,
    adminNotify,
  };
}

module.exports = {
  STOP_WORDS,
  HELP_WORDS,
  complianceKeyword,
  buildInboundAutoReply,
  emptyTwiml,
  twimlMessage,
  combineForwardAndReply,
  inboundAdminIdempotencyKey,
  notifyAdminInboundSms,
  handleInboundSms,
};
