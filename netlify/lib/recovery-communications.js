// Recovery communication adapters — Resend email and Twilio SMS (dry-run by default).

const { recoveryDryRun, isOptOutMessage } = require('./revenue-recovery');
const crypto = require('crypto');
const { enqueueSms } = require('./sms-outbox');
const { TEMPLATE_KEYS } = require('./sms-templates');

async function sendRecoveryEmail({ to, subject, html, text }) {
  if (!to) return { sent: false, reason: 'missing_recipient' };
  if (recoveryDryRun()) {
    console.info('[recovery-email] dry_run', { to: '[redacted]', subject });
    return { sent: false, reason: 'dry_run', simulated: true };
  }
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!RESEND_API_KEY) return { sent: false, reason: 'resend_not_configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) return { sent: false, reason: `resend_${res.status}` };
  return { sent: true };
}

async function sendRecoverySms({ to, body, idempotencyKey, consentGranted, url = '' }) {
  if (!to) return { sent: false, reason: 'missing_recipient' };
  if (isOptOutMessage(body)) return { sent: false, reason: 'opt_out_keyword' };
  if (recoveryDryRun()) {
    console.info('[recovery-sms] dry_run', { to: '[redacted]' });
    return { sent: false, reason: 'dry_run', simulated: true };
  }
  const stableKey = idempotencyKey || `recovery:${crypto
    .createHash('sha256')
    .update(`${to}:${body}`)
    .digest('hex')
    .slice(0, 48)}`;
  const queued = await enqueueSms({
    idempotencyKey: stableKey,
    audience: 'lead',
    consentGranted: consentGranted === true,
    toE164: to,
    templateKey: TEMPLATE_KEYS.RECOVERY,
    templateData: { message: body, url },
  });
  if (!queued.ok) return { sent: false, reason: queued.error || 'sms_outbox_failed' };
  if (!queued.queued) return { sent: false, skipped: true, reason: queued.reason || 'sms_not_queued' };
  return { sent: false, accepted: true, queued: true, outboxId: queued.outbox?.id || null };
}

module.exports = {
  sendRecoveryEmail,
  sendRecoverySms,
};
