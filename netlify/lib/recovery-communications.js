// Recovery communication adapters — Resend email and Twilio SMS (dry-run by default).

const { recoveryDryRun, isOptOutMessage } = require('./revenue-recovery');

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

async function sendRecoverySms({ to, body }) {
  if (!to) return { sent: false, reason: 'missing_recipient' };
  if (isOptOutMessage(body)) return { sent: false, reason: 'opt_out_keyword' };
  if (recoveryDryRun()) {
    console.info('[recovery-sms] dry_run', { to: '[redacted]' });
    return { sent: false, reason: 'dry_run', simulated: true };
  }
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    return { sent: false, reason: 'twilio_not_configured' };
  }
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) return { sent: false, reason: `twilio_${res.status}` };
  return { sent: true };
}

module.exports = {
  sendRecoveryEmail,
  sendRecoverySms,
};
