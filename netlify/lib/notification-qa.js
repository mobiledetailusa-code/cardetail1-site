'use strict';

/**
 * Owner-only notification QA helpers.
 * Never creates bookings, payments, or customer records.
 * Never accepts arbitrary public recipients.
 */

const { enabled, smsOutboxPolicy, outboundTwilioPolicy, runtimeIdentity } = require('./twilio-runtime-policy');
const { renderSmsTemplate, TEMPLATE_KEYS } = require('./sms-templates');
const { normalizeUsPhoneE164 } = require('./phone-auth');

const QA_EVENT_PREFIX = 'qa.notification';
const LEGACY_GMAIL = 'mobiledetailusa@gmail.com';
const FRONTEND_MAILTO_GMAIL = 'magnojuniorusa93@gmail.com';

function clean(value) {
  return String(value || '').trim();
}

function maskEmail(email) {
  const s = clean(email);
  if (!s) return null;
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return `${s[0]}***@${s.slice(at + 1)}`;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return phone ? '***' : null;
  return `***${digits.slice(-4)}`;
}

function parseFromAddress(fromRaw) {
  const raw = clean(fromRaw);
  if (!raw) return { display: null, address: null };
  const angle = raw.match(/<([^>]+)>/);
  if (angle) {
    return { display: clean(raw.replace(angle[0], '')), address: clean(angle[1]).toLowerCase() };
  }
  return { display: null, address: raw.toLowerCase() };
}

function classifyGmailRole({ adminEmail, resendFrom }) {
  const admin = clean(adminEmail).toLowerCase();
  const from = parseFromAddress(resendFrom).address;
  const hits = [];
  if (admin === LEGACY_GMAIL) hits.push('recipient');
  if (from === LEGACY_GMAIL) hits.push('sender');
  if (!hits.length) return { role: 'unrelated_or_forwarding', detail: 'not_present_in_ADMIN_EMAIL_or_RESEND_FROM' };
  if (hits.length === 2) return { role: 'both', detail: hits.join('+') };
  if (hits[0] === 'sender') return { role: 'sender_only', detail: 'RESEND_FROM' };
  return { role: 'recipient', detail: 'ADMIN_EMAIL' };
}

function envPresence(env = process.env) {
  const keys = [
    'TWILIO_ENABLED',
    'TWILIO_OUTBOX_ENABLED',
    'TWILIO_PRODUCTION_SENDS_ENABLED',
    'CUSTOMER_TRANSACTIONAL_SMS_ENABLED',
    'ADMIN_SMS_CONSENT_GRANTED',
    'NOTIFICATION_QA_ENABLED',
  ];
  const booleans = {};
  for (const key of keys) {
    const raw = clean(env[key]);
    booleans[key] = raw === '' ? null : enabled(raw);
  }
  const configured = (key, pattern) => {
    const v = clean(env[key]);
    if (!v) return false;
    if (pattern && !pattern.test(v)) return 'invalid_shape';
    return true;
  };
  return {
    booleans,
    provider: {
      TWILIO_ACCOUNT_SID: configured('TWILIO_ACCOUNT_SID', /^AC[a-zA-Z0-9]{8,}$/) || configured('TWILIO_SID', /^AC[a-zA-Z0-9]{8,}$/),
      TWILIO_AUTH_TOKEN: !!(clean(env.TWILIO_AUTH_TOKEN) || clean(env.TWILIO_TOKEN)),
      TWILIO_API_KEY: configured('TWILIO_API_KEY', /^SK[a-zA-Z0-9]{8,}$/),
      TWILIO_API_SECRET: !!clean(env.TWILIO_API_SECRET),
      TWILIO_MESSAGING_SERVICE_SID: configured('TWILIO_MESSAGING_SERVICE_SID', /^MG[a-zA-Z0-9]{8,}$/),
      TWILIO_FROM: !!clean(env.TWILIO_FROM),
      TWILIO_STATUS_CALLBACK_URL: !!clean(env.TWILIO_STATUS_CALLBACK_URL),
      TWILIO_INBOUND_WEBHOOK_URL: !!clean(env.TWILIO_INBOUND_WEBHOOK_URL),
      TWILIO_WORKER_SECRET: clean(env.TWILIO_WORKER_SECRET).length >= 32,
      ADMIN_SMS: !!normalizeUsPhoneE164(env.ADMIN_SMS || ''),
      ADMIN_EMAIL: !!clean(env.ADMIN_EMAIL),
      RESEND_API_KEY: !!clean(env.RESEND_API_KEY),
      RESEND_FROM: !!clean(env.RESEND_FROM),
    },
    identity: runtimeIdentity(env),
    outboxPolicy: smsOutboxPolicy(env),
    sendPolicy: outboundTwilioPolicy(env),
  };
}

function emailContractSnapshot(env = process.env) {
  const adminTo = clean(env.ADMIN_EMAIL);
  const fromRaw = clean(env.RESEND_FROM) || 'Cardetail1 <onboarding@resend.dev>';
  const from = parseFromAddress(fromRaw);
  const gmail = classifyGmailRole({ adminEmail: adminTo, resendFrom: fromRaw });
  return {
    ADMIN_RECIPIENT: adminTo || null,
    ADMIN_RECIPIENT_MASKED: maskEmail(adminTo),
    ADMIN_FROM: fromRaw,
    ADMIN_FROM_ADDRESS: from.address,
    REPLY_TO_ON_BOOKING: 'customer_email_when_present',
    legacyGmailRole: gmail,
    frontendMailtoFallback: FRONTEND_MAILTO_GMAIL,
    notes: [
      'Booking admin email uses process.env.ADMIN_EMAIL as TO and process.env.RESEND_FROM as FROM.',
      'Frontend ADMIN_EMAIL constants are mailto fallback only; they do not drive Resend.',
      'Do not treat verbal admin@cardtel1.com as canonical without provider/domain verification.',
    ],
  };
}

function qaHarnessAllowed(env = process.env) {
  if (!enabled(env.NOTIFICATION_QA_ENABLED)) {
    return { ok: false, reason: 'notification_qa_disabled' };
  }
  return { ok: true };
}

function buildSyntheticAdminEmail({ env = process.env, correlationId } = {}) {
  const to = clean(env.ADMIN_EMAIL);
  const from = clean(env.RESEND_FROM) || 'Cardetail1 <onboarding@resend.dev>';
  if (!to) return { ok: false, error: 'admin_email_missing' };
  if (!clean(env.RESEND_API_KEY)) return { ok: false, error: 'resend_api_key_missing' };
  const id = clean(correlationId) || `QA-${Date.now().toString(36).toUpperCase()}`;
  const subject = `Detailing Zone QA — notification system test ${id}`;
  const text = [
    'Detailing Zone QA: Notification system test.',
    'No customer booking was created or changed.',
    `Correlation: ${id}`,
    `Event: ${QA_EVENT_PREFIX}.admin_email`,
    `GeneratedAt: ${new Date().toISOString()}`,
    '',
    'If you received this at the intended admin inbox, admin email routing is healthy.',
  ].join('\n');
  return {
    ok: true,
    payload: {
      from,
      to: [to],
      subject,
      text,
    },
    meta: {
      correlationId: id,
      toMasked: maskEmail(to),
      fromAddress: parseFromAddress(from).address,
    },
  };
}

async function sendSyntheticAdminEmail({ env = process.env, fetchImpl = fetch, correlationId } = {}) {
  const built = buildSyntheticAdminEmail({ env, correlationId });
  if (!built.ok) return built;
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clean(env.RESEND_API_KEY)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(built.payload),
  });
  const bodyText = await res.text().catch(() => '');
  let providerId = null;
  try {
    const parsed = JSON.parse(bodyText);
    providerId = parsed.id || null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `resend_${res.status}`,
      meta: built.meta,
      providerAccepted: false,
    };
  }
  return {
    ok: true,
    meta: built.meta,
    providerAccepted: true,
    providerMessageId: providerId,
  };
}

function prepareControlledOwnerSms({ env = process.env } = {}) {
  const toE164 = normalizeUsPhoneE164(env.ADMIN_SMS || '');
  if (!toE164) return { ok: false, error: 'admin_sms_missing' };
  const rendered = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_BOOKING, {
    bookingRef: 'QA-NOTIFY',
    customerName: 'Notification QA',
    customerPhone: '',
  });
  // Override body for explicit QA semantics (still STOP/HELP compliant via template helper).
  const qaBody = renderSmsTemplate(TEMPLATE_KEYS.RECOVERY, {
    message: 'Notification system test. No customer booking was changed.',
  });
  const body = qaBody.ok ? qaBody.body : (rendered.ok ? rendered.body : null);
  if (!body) return { ok: false, error: 'sms_template_failed' };
  return {
    ok: true,
    ready: true,
    sent: false,
    destinationMasked: maskPhone(toE164),
    templateKey: TEMPLATE_KEYS.RECOVERY,
    bodyPreview: body.slice(0, 120),
    gates: envPresence(env),
    note: 'READY FOR CONTROLLED OWNER SMS TEST — human authorization required before send.',
  };
}

module.exports = {
  QA_EVENT_PREFIX,
  LEGACY_GMAIL,
  FRONTEND_MAILTO_GMAIL,
  maskEmail,
  maskPhone,
  parseFromAddress,
  classifyGmailRole,
  envPresence,
  emailContractSnapshot,
  qaHarnessAllowed,
  buildSyntheticAdminEmail,
  sendSyntheticAdminEmail,
  prepareControlledOwnerSms,
};
