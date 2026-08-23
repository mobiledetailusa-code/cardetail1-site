#!/usr/bin/env node
'use strict';

/**
 * Twilio + Netlify Production activation helper.
 *
 * Default: read-only public probe (no secrets). Does not send SMS.
 * Writes never enable TWILIO_PRODUCTION_SENDS_ENABLED.
 * Netlify provider vars are Production-context only (never Preview).
 *
 *   node scripts/twilio-netlify-activate.js
 *   node scripts/twilio-netlify-activate.js --configure-twilio --confirm-twilio-webhooks
 *   node scripts/twilio-netlify-activate.js --ensure-number +1XXXXXXXXXX --confirm-twilio-webhooks
 *   node scripts/twilio-netlify-activate.js --write-netlify-provider --confirm-production-provider-write
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const NETLIFY_ACCOUNT = '6a2802ed5070702e9f45913b';
const PUBLIC_SITE = 'https://cardetail1.com';
const INBOUND_URL = `${PUBLIC_SITE}/.netlify/functions/twilio-inbound`;
const STATUS_URL = `${PUBLIC_SITE}/.netlify/functions/twilio-status-callback`;
const WORKER_URL = `${PUBLIC_SITE}/.netlify/functions/twilio-outbox-worker`;
const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';

const UNCONDITIONAL_SMS_COPY = /we(?:['’]ll| will)? text you(?! if you opted in)|then text you|then text or call|Appointment updates by text|Booking confirmed by text|confirming by text|confirmed by text/i;

const SEND_SWITCH_KEYS = [
  'TWILIO_OUTBOX_ENABLED',
  'TWILIO_ENABLED',
  'TWILIO_PRODUCTION_SENDS_ENABLED',
];

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function parseArgs(argv = process.argv) {
  const out = {
    inspect: true,
    configureTwilio: false,
    confirmTwilio: false,
    ensureNumber: '',
    writeNetlify: false,
    confirmNetlify: false,
    enableCustomerSms: false,
    enableProductionSends: false,
    envFile: path.join(__dirname, '..', '.env.twilio-activate'),
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--configure-twilio') out.configureTwilio = true;
    else if (a === '--confirm-twilio-webhooks') out.confirmTwilio = true;
    else if (a === '--ensure-number') out.ensureNumber = String(argv[++i] || '').trim();
    else if (a === '--write-netlify-provider') out.writeNetlify = true;
    else if (a === '--confirm-production-provider-write') out.confirmNetlify = true;
    else if (a === '--enable-customer-sms') out.enableCustomerSms = true;
    else if (a === '--env-file') out.envFile = String(argv[++i] || '').trim();
    else if (a === '--enable-production-sends' || a === '--enable-sends') {
      out.enableProductionSends = true;
    }
  }
  return out;
}

function publicCopyBlocksCustomerSms(html) {
  return UNCONDITIONAL_SMS_COPY.test(String(html || ''));
}

function netlifyProductionOnlyPayload(key, value) {
  return {
    key,
    scopes: ['builds', 'functions', 'runtime', 'post-processing'],
    values: [{ context: 'production', value: String(value) }],
  };
}

function assertNoProductionSends(envMap = {}) {
  for (const key of SEND_SWITCH_KEYS) {
    if (String(envMap[key] || '').trim().toLowerCase() === 'true') {
      return { ok: false, error: 'production_sends_forbidden', key };
    }
  }
  if (envMap.TWILIO_FROM) {
    return { ok: false, error: 'legacy_from_number_forbidden' };
  }
  return { ok: true };
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).replace(/^["']|["']$/g, '');
  }
  return out;
}

function mergedSecrets(fileEnv = {}, processEnv = process.env) {
  const keys = [
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY', 'TWILIO_API_SECRET',
    'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_WORKER_SECRET', 'NETLIFY_AUTH_TOKEN',
    'TWILIO_SID', 'TWILIO_TOKEN',
  ];
  const out = { ...fileEnv };
  for (const key of keys) {
    if (!out[key] && processEnv[key]) out[key] = processEnv[key];
  }
  if (!out.TWILIO_ACCOUNT_SID && out.TWILIO_SID) out.TWILIO_ACCOUNT_SID = out.TWILIO_SID;
  if (!out.TWILIO_AUTH_TOKEN && out.TWILIO_TOKEN) out.TWILIO_AUTH_TOKEN = out.TWILIO_TOKEN;
  return out;
}

function providerWritePlan(input, { enableCustomerSms = false } = {}) {
  const sends = assertNoProductionSends(input);
  if (!sends.ok) return sends;
  const accountSid = String(input.TWILIO_ACCOUNT_SID || '').trim();
  const apiKey = String(input.TWILIO_API_KEY || '').trim();
  const apiSecret = String(input.TWILIO_API_SECRET || '').trim();
  const messagingServiceSid = String(input.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  const authToken = String(input.TWILIO_AUTH_TOKEN || '').trim();
  const workerSecret = String(input.TWILIO_WORKER_SECRET || '').trim();
  if (!/^AC[a-zA-Z0-9]{8,}$/.test(accountSid)) return { ok: false, error: 'account_sid_missing' };
  if (!/^SK[a-zA-Z0-9]{8,}$/.test(apiKey) || !apiSecret) return { ok: false, error: 'api_key_missing' };
  if (!/^MG[a-zA-Z0-9]{8,}$/.test(messagingServiceSid)) return { ok: false, error: 'messaging_service_missing' };
  if (!authToken) return { ok: false, error: 'auth_token_missing' };
  if (workerSecret.length < 32) return { ok: false, error: 'worker_secret_too_short' };
  return {
    ok: true,
    vars: {
      TWILIO_ACCOUNT_SID: accountSid,
      TWILIO_API_KEY: apiKey,
      TWILIO_API_SECRET: apiSecret,
      TWILIO_MESSAGING_SERVICE_SID: messagingServiceSid,
      TWILIO_AUTH_TOKEN: authToken,
      TWILIO_WORKER_SECRET: workerSecret,
      TWILIO_STATUS_CALLBACK_URL: STATUS_URL,
      TWILIO_INBOUND_WEBHOOK_URL: INBOUND_URL,
      TWILIO_ALLOWED_BRANCH: 'master',
      TWILIO_ALLOWED_HOST: 'cardetail1.com',
      TWILIO_OUTBOX_ENABLED: 'false',
      TWILIO_ENABLED: 'false',
      TWILIO_PRODUCTION_SENDS_ENABLED: 'false',
      CUSTOMER_TRANSACTIONAL_SMS_ENABLED: enableCustomerSms ? 'true' : 'false',
    },
  };
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, { redirect: 'follow', ...options });
  const body = await res.text();
  return { status: res.status, body, contentType: res.headers.get('content-type') || '' };
}

async function publicProbe() {
  const homepage = await fetchText(PUBLIC_SITE + '/');
  const inbound = await fetchText(INBOUND_URL);
  const status = await fetchText(STATUS_URL);
  const worker = await fetchText(WORKER_URL);
  let workerJson = null;
  try { workerJson = JSON.parse(worker.body); } catch { workerJson = null; }
  const copyBlocks = publicCopyBlocksCustomerSms(homepage.body);
  return {
    ok: true,
    mode: 'inspect',
    site: PUBLIC_SITE,
    functions: {
      inbound: { status: inbound.status, expect: 405 },
      statusCallback: { status: status.status, expect: 405 },
      worker: {
        status: worker.status,
        disabled: !!(workerJson && workerJson.disabled),
        reason: workerJson && workerJson.reason ? workerJson.reason : null,
      },
    },
    publicCopy: {
      blocksCustomerSmsEnable: copyBlocks,
      hasOptInQualifier: /If you opted in for SMS/.test(homepage.body),
      hasSmsCheckbox: /id="sms-consent-ok"/.test(homepage.body),
    },
    next: copyBlocks
      ? 'Merge and deploy A2P public copy (PR #204) before enabling customer SMS.'
      : 'Provide Twilio/Netlify secrets in .env.twilio-activate and rerun with --configure-twilio / --write-netlify-provider.',
  };
}

function twilioClient(secrets) {
  const twilio = require('twilio');
  if (secrets.TWILIO_API_KEY && secrets.TWILIO_API_SECRET && secrets.TWILIO_ACCOUNT_SID) {
    return twilio(secrets.TWILIO_API_KEY, secrets.TWILIO_API_SECRET, {
      accountSid: secrets.TWILIO_ACCOUNT_SID,
    });
  }
  return twilio(secrets.TWILIO_ACCOUNT_SID, secrets.TWILIO_AUTH_TOKEN);
}

async function configureMessagingService(client, messagingServiceSid) {
  const service = await client.messaging.v1.services(messagingServiceSid).update({
    inboundRequestUrl: INBOUND_URL,
    inboundMethod: 'POST',
    statusCallback: STATUS_URL,
    useInboundWebhookOnNumber: false,
    stickySender: true,
  });
  return {
    sid: service.sid,
    inboundRequestUrl: service.inboundRequestUrl,
    statusCallback: service.statusCallback,
  };
}

async function ensureNumberOnService(client, messagingServiceSid, e164) {
  const want = String(e164 || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(want)) {
    throw new Error('invalid_e164');
  }
  const owned = await client.incomingPhoneNumbers.list({ limit: 100 });
  const match = owned.find((n) => n.phoneNumber === want);
  if (!match) throw new Error('number_not_in_account');
  const pool = await client.messaging.v1.services(messagingServiceSid).phoneNumbers.list({ limit: 100 });
  if (pool.some((n) => n.phoneNumber === want || n.sid === match.sid)) {
    return { sid: match.sid, phoneNumber: want, alreadyInPool: true };
  }
  const added = await client.messaging.v1.services(messagingServiceSid).phoneNumbers.create({
    phoneNumberSid: match.sid,
  });
  return { sid: added.sid, phoneNumber: want, alreadyInPool: false };
}

function readNetlifyToken(secrets) {
  if (secrets.NETLIFY_AUTH_TOKEN) return secrets.NETLIFY_AUTH_TOKEN;
  const candidates = [
    path.join(os.homedir(), '.config', 'netlify', 'config.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'netlify', 'Config', 'config.json'),
  ];
  for (const cfgPath of candidates) {
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const token = Object.values(cfg.users || {})[0]?.auth?.token;
      if (token) return token;
    } catch {
      /* ignore */
    }
  }
  throw new Error('netlify_token_missing');
}

async function putProductionVar(token, siteId, key, value) {
  const payload = netlifyProductionOnlyPayload(key, value);
  const res = await fetch(
    `https://api.netlify.com/api/v1/accounts/${NETLIFY_ACCOUNT}/env/${encodeURIComponent(key)}?site_id=${siteId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  if (res.ok) return { ok: true, status: res.status, method: 'PUT' };
  const create = await fetch(
    `https://api.netlify.com/api/v1/accounts/${NETLIFY_ACCOUNT}/env?site_id=${siteId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([payload]),
    },
  );
  return { ok: create.ok, status: create.status, method: 'POST' };
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(JSON.stringify({
      usage: [
        'node scripts/twilio-netlify-activate.js',
        'node scripts/twilio-netlify-activate.js --configure-twilio --confirm-twilio-webhooks [--ensure-number +1...]',
        'node scripts/twilio-netlify-activate.js --write-netlify-provider --confirm-production-provider-write',
      ],
      never: ['TWILIO_PRODUCTION_SENDS_ENABLED=true', 'Preview/context=all secrets', 'legacy TWILIO_FROM'],
    }, null, 2));
    return 0;
  }
  if (args.enableProductionSends) {
    console.error(JSON.stringify({
      ok: false,
      error: 'production_sends_not_in_this_step',
      message: 'This script never enables TWILIO_PRODUCTION_SENDS_ENABLED. Configure provider + webhooks first.',
    }));
    return 1;
  }

  const probe = await publicProbe();
  const secrets = mergedSecrets(readEnvFile(args.envFile));

  if (!args.configureTwilio && !args.writeNetlify) {
    console.log(JSON.stringify({
      ...probe,
      secretsPresent: {
        twilioAccount: !!secrets.TWILIO_ACCOUNT_SID,
        twilioAuth: !!secrets.TWILIO_AUTH_TOKEN,
        twilioApiKey: !!secrets.TWILIO_API_KEY,
        messagingService: !!secrets.TWILIO_MESSAGING_SERVICE_SID,
        netlifyToken: !!secrets.NETLIFY_AUTH_TOKEN,
      },
    }, null, 2));
    return 0;
  }

  const report = { ok: true, probe, actions: [] };

  if (args.configureTwilio) {
    if (!args.confirmTwilio) {
      console.error(JSON.stringify({ ok: false, error: 'confirmation_required', need: '--confirm-twilio-webhooks' }));
      return 1;
    }
    if (!secrets.TWILIO_ACCOUNT_SID || !(secrets.TWILIO_AUTH_TOKEN || (secrets.TWILIO_API_KEY && secrets.TWILIO_API_SECRET))) {
      console.error(JSON.stringify({ ok: false, error: 'twilio_credentials_missing' }));
      return 1;
    }
    if (!/^MG[a-zA-Z0-9]{8,}$/.test(String(secrets.TWILIO_MESSAGING_SERVICE_SID || ''))) {
      console.error(JSON.stringify({ ok: false, error: 'messaging_service_missing' }));
      return 1;
    }
    const client = twilioClient(secrets);
    const updated = await configureMessagingService(client, secrets.TWILIO_MESSAGING_SERVICE_SID);
    report.actions.push({ configureMessagingService: updated });
    if (args.ensureNumber) {
      const added = await ensureNumberOnService(client, secrets.TWILIO_MESSAGING_SERVICE_SID, args.ensureNumber);
      report.actions.push({ ensureNumber: { ...added, phoneFingerprint: sha12(added.phoneNumber) } });
    }
  }

  if (args.writeNetlify) {
    if (!args.confirmNetlify) {
      console.error(JSON.stringify({ ok: false, error: 'confirmation_required', need: '--confirm-production-provider-write' }));
      return 1;
    }
    if (args.enableCustomerSms && probe.publicCopy.blocksCustomerSmsEnable) {
      console.error(JSON.stringify({
        ok: false,
        error: 'public_copy_blocks_sms',
        message: 'Production homepage still promises SMS unconditionally. Deploy PR #204 first.',
      }));
      return 1;
    }
    const plan = providerWritePlan(secrets, { enableCustomerSms: args.enableCustomerSms });
    if (!plan.ok) {
      console.error(JSON.stringify({ ok: false, error: plan.error }));
      return 1;
    }
    const token = readNetlifyToken(secrets);
    const siteId = PRODUCTION_SITE_ID;
    if (siteId === STAGING_SITE_ID) {
      console.error(JSON.stringify({ ok: false, error: 'refusing_staging_site' }));
      return 1;
    }
    const wrote = [];
    for (const [key, value] of Object.entries(plan.vars)) {
      const res = await putProductionVar(token, siteId, key, value);
      if (!res.ok) {
        console.error(JSON.stringify({ ok: false, error: 'netlify_set_failed', key, status: res.status }));
        return 1;
      }
      wrote.push(key);
    }
    report.actions.push({
      netlifyProductionProvider: {
        siteIdFingerprint: sha12(siteId),
        context: 'production',
        keys: wrote,
        sendSwitches: 'false',
        customerSms: plan.vars.CUSTOMER_TRANSACTIONAL_SMS_ENABLED,
      },
    });
  }

  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message || String(err) }));
    process.exit(1);
  });
}

module.exports = {
  PRODUCTION_SITE_ID,
  INBOUND_URL,
  STATUS_URL,
  UNCONDITIONAL_SMS_COPY,
  publicCopyBlocksCustomerSms,
  netlifyProductionOnlyPayload,
  assertNoProductionSends,
  providerWritePlan,
  parseArgs,
  main,
};
