#!/usr/bin/env node
'use strict';

/**
 * Cheap read-only Production notification ops status (masked).
 *
 *   NETLIFY_AUTH_TOKEN=… node scripts/notification-ops-status.js
 *
 * Uses Netlify config token if present (~/.config/netlify/config.json).
 * Never prints full secrets. Does not send email/SMS or mutate bookings.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const ACCOUNT_ID = '6a2802ed5070702e9f45913b';

const REQUIRED_TRUE = [
  'TWILIO_ENABLED',
  'TWILIO_OUTBOX_ENABLED',
  'TWILIO_PRODUCTION_SENDS_ENABLED',
  'CUSTOMER_TRANSACTIONAL_SMS_ENABLED',
  'ADMIN_SMS_CONSENT_GRANTED',
];

const REQUIRED_PRESENT = [
  'ADMIN_EMAIL',
  'ADMIN_SMS',
  'RESEND_FROM',
  'RESEND_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_MESSAGING_SERVICE_SID',
];

function loadToken() {
  if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN.trim();
  const cfgPath = path.join(os.homedir(), '.config', 'netlify', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const users = cfg.users || {};
    const first = Object.values(users)[0];
    return (first && first.auth && first.auth.token) || '';
  } catch {
    return '';
  }
}

function maskEmail(v) {
  const s = String(v || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? 'SET' : 'ABSENT';
  return `${s[0]}***@${s.slice(at + 1)}`;
}

function maskPhone(v) {
  const s = String(v || '');
  if (s.length < 6) return s ? 'SET' : 'ABSENT';
  return `${s.slice(0, 2)}***${s.slice(-4)}`;
}

function prodValue(item) {
  const vals = item.values || [];
  return (
    vals.find((x) => x.context === 'production') ||
    vals.find((x) => x.context === 'all') ||
    null
  );
}

function isTruthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || '').trim());
}

async function main() {
  const token = loadToken();
  if (!token) {
    console.error('NETLIFY_AUTH_TOKEN missing (and no ~/.config/netlify auth).');
    process.exit(2);
  }

  const res = await fetch(
    `https://api.netlify.com/api/v1/accounts/${ACCOUNT_ID}/env?site_id=${SITE_ID}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    console.error('netlify_env_fetch_failed', res.status);
    process.exit(2);
  }
  const items = await res.json();
  const map = {};
  for (const item of items) {
    const hit = prodValue(item);
    if (hit) map[item.key] = { value: hit.value, context: hit.context };
  }

  const report = {
    site: 'cardetail1',
    context: 'production',
    email: {
      ADMIN_EMAIL: map.ADMIN_EMAIL ? maskEmail(map.ADMIN_EMAIL.value) : 'ABSENT',
      RESEND_FROM: map.RESEND_FROM ? String(map.RESEND_FROM.value) : 'ABSENT',
      RESEND_API_KEY: map.RESEND_API_KEY ? 'SET' : 'ABSENT',
    },
    sms: {
      ADMIN_SMS: map.ADMIN_SMS ? maskPhone(map.ADMIN_SMS.value) : 'ABSENT',
      ADMIN_SMS_CONSENT_GRANTED: map.ADMIN_SMS_CONSENT_GRANTED
        ? String(map.ADMIN_SMS_CONSENT_GRANTED.value)
        : 'ABSENT',
      TWILIO_FROM: map.TWILIO_FROM ? 'SET (prefer Messaging Service only)' : 'ABSENT_OK',
      TWILIO_MESSAGING_SERVICE_SID: map.TWILIO_MESSAGING_SERVICE_SID ? 'SET' : 'ABSENT',
      note: 'One Messaging Service DID sends all SMS; ADMIN_SMS is recipient only — not a second Twilio buy.',
    },
    gates: {},
    missing: [],
    ok: true,
  };

  for (const k of REQUIRED_TRUE) {
    const raw = map[k] && map[k].value;
    const ok = isTruthy(raw);
    report.gates[k] = ok ? 'true' : raw == null ? 'ABSENT' : String(raw);
    if (!ok) {
      report.ok = false;
      report.missing.push(k);
    }
  }
  for (const k of REQUIRED_PRESENT) {
    if (!map[k] || !String(map[k].value || '').trim()) {
      report.ok = false;
      report.missing.push(k);
    }
  }

  if (map.ADMIN_EMAIL && !/@cardetail1\.com$/i.test(String(map.ADMIN_EMAIL.value).trim())) {
    report.warnings = report.warnings || [];
    report.warnings.push('ADMIN_EMAIL is not @cardetail1.com — confirm intentional');
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(2);
});
