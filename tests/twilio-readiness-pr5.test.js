'use strict';

require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');
const { getPrisma, prismaConfigured } = require('../netlify/lib/prisma');

const RUN_ID = `PR5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
const ACCOUNT_ID = `${RUN_ID}-ACCOUNT`;
const PHONE = '+12015550123';
const BASE_ENV = Object.freeze({
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  TWILIO_OUTBOX_ENABLED: 'true',
  TWILIO_ENABLED: 'true',
});
const SEND_ENV = Object.freeze({
  ...BASE_ENV,
  TWILIO_PRODUCTION_SENDS_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_API_KEY: 'SK00000000000000000000000000000000',
  TWILIO_API_SECRET: 'test-only-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MG00000000000000000000000000000000',
  TWILIO_STATUS_CALLBACK_URL: 'https://cardetail1.com/.netlify/functions/twilio-status-callback',
});

let prisma;

async function consentStatus() {
  return prisma.customerConsent.findUnique({
    where: { customerAccountId_channel: { customerAccountId: ACCOUNT_ID, channel: 'sms_transactional' } },
  });
}

async function accountVersion() {
  return (await prisma.customerAccount.findUnique({ where: { id: ACCOUNT_ID } })).version;
}

before(async () => {
  assert.equal(prismaConfigured(), true, 'PostgreSQL 16 is required for PR5 outbox tests');
  prisma = getPrisma();
  await prisma.smsOutbox.deleteMany({ where: { idempotencyKey: { startsWith: RUN_ID } } });
  await prisma.customerAccount.deleteMany({ where: { id: ACCOUNT_ID } });
  await prisma.customerAccount.create({
    data: {
      id: ACCOUNT_ID,
      status: 'active',
      version: 1,
      profile: {
        create: {
          firstName: 'PR5',
          lastName: 'Customer',
          phone: '2015550123',
          normalizedPhone: '2015550123',
        },
      },
    },
  });
});

after(async () => {
  await prisma.smsOutbox.deleteMany({ where: { idempotencyKey: { startsWith: RUN_ID } } });
  await prisma.customerAccount.deleteMany({ where: { id: ACCOUNT_ID } });
});

describe('PR5 fail-closed runtime policy', () => {
  it('is disabled by default and makes deploy previews incapable of sending', () => {
    const { smsOutboxPolicy, outboundTwilioPolicy } = require('../netlify/lib/twilio-runtime-policy');
    assert.equal(smsOutboxPolicy({}).ok, false);
    assert.equal(outboundTwilioPolicy({ ...SEND_ENV, CONTEXT: 'deploy-preview' }).ok, false);
    assert.equal(outboundTwilioPolicy({ ...SEND_ENV, BRANCH: 'feature/test' }).ok, false);
    assert.equal(outboundTwilioPolicy({ ...SEND_ENV, URL: 'https://preview--cardetail1.netlify.app' }).ok, false);
    assert.equal(outboundTwilioPolicy(SEND_ENV).ok, true);
  });

  it('requires a Messaging Service, API key and explicit production send switch', () => {
    const { outboundTwilioPolicy } = require('../netlify/lib/twilio-runtime-policy');
    assert.equal(outboundTwilioPolicy(BASE_ENV).reason, 'production_sends_disabled');
    assert.equal(outboundTwilioPolicy({ ...SEND_ENV, TWILIO_MESSAGING_SERVICE_SID: '' }).reason, 'messaging_service_missing');
    assert.equal(outboundTwilioPolicy({ ...SEND_ENV, TWILIO_API_KEY: '' }).reason, 'api_key_missing');
  });

  it('does not trust a caller-controlled scheduler header', async () => {
    const configured = { ...SEND_ENV, TWILIO_WORKER_SECRET: 'worker-secret-test-only' };
    const prior = {};
    for (const [key, value] of Object.entries(configured)) {
      prior[key] = process.env[key];
      process.env[key] = value;
    }
    const worker = require('../netlify/functions/twilio-outbox-worker');
    try {
      const forged = await worker.handler({
        httpMethod: 'POST',
        headers: { 'x-netlify-event': 'schedule' },
      });
      assert.equal(forged.statusCode, 401);
      assert.equal(worker.secretMatches('worker-secret-test-only', 'wrong-secret'), false);
    } finally {
      for (const key of Object.keys(configured)) {
        if (prior[key] == null) delete process.env[key];
        else process.env[key] = prior[key];
      }
    }
  });
});

describe('PR5 templates and consent', () => {
  it('uses one brand and includes STOP/HELP disclosure in every template', () => {
    const { BRAND, TEMPLATE_KEYS, renderSmsTemplate } = require('../netlify/lib/sms-templates');
    assert.equal(BRAND, 'Cardetail1');
    const { ADMIN_TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
    for (const key of Object.values(TEMPLATE_KEYS)) {
      const rendered = renderSmsTemplate(key, {
        when: 'August 10',
        url: 'https://cardetail1.com/my-garage.html',
        service: 'Interior Detail',
        date: 'August 10',
        area: '07102',
        bookingRef: 'CD1-TEST',
        customerName: 'Customer',
        customerPhone: '2015550123',
        message: 'Your requested follow-up is ready.',
      });
      assert.equal(rendered.ok, true, key);
      if (ADMIN_TEMPLATE_KEYS.has(key)) {
        assert.match(rendered.body, /^Cardetail1 Admin:/, key);
      } else {
        assert.match(rendered.body, /^Cardetail1:/, key);
      }
      assert.match(rendered.body, /STOP/i, key);
      assert.match(rendered.body, /HELP/i, key);
      assert.ok(rendered.body.length <= 600, key);
    }
  });

  it('grants and revokes explicit transactional SMS consent with account versioning', async () => {
    const { updateSmsConsent, CONSENT_TEXT_VERSION } = require('../netlify/lib/sms-consent-service');
    const granted = await updateSmsConsent({
      customerAccountId: ACCOUNT_ID,
      expectedVersion: 1,
      granted: true,
      requestId: `${RUN_ID}-CONSENT-GRANT`,
    }, { prisma });
    assert.equal(granted.ok, true, granted.error);
    assert.equal(granted.accountVersion, 2);
    assert.equal((await consentStatus()).status, 'granted');
    assert.equal((await consentStatus()).consentTextVersion, CONSENT_TEXT_VERSION);

    const conflict = await updateSmsConsent({
      customerAccountId: ACCOUNT_ID,
      expectedVersion: 1,
      granted: false,
    }, { prisma });
    assert.equal(conflict.error, 'version_conflict');
  });
});

describe('PR5 post-commit outbox, deduplication and retries', () => {
  it('enqueues once after consent and rejects same-key payload drift', async () => {
    const { enqueueSms } = require('../netlify/lib/sms-outbox');
    const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
    const input = {
      idempotencyKey: `${RUN_ID}.customer.confirmed.1`,
      audience: 'customer',
      customerAccountId: ACCOUNT_ID,
      bookingId: `${RUN_ID}-BOOKING`,
      toE164: PHONE,
      templateKey: TEMPLATE_KEYS.CONFIRMED,
      templateData: { when: 'August 10', url: 'https://cardetail1.com/my-garage.html' },
    };
    const first = await enqueueSms(input, { prisma, env: BASE_ENV });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.queued, true);
    assert.equal(first.outbox.status, 'accepted');
    assert.equal(first.outbox.attemptCount, 0);

    const duplicate = await enqueueSms(input, { prisma, env: BASE_ENV });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.outbox.id, first.outbox.id);

    const conflict = await enqueueSms({
      ...input,
      templateData: { when: 'August 11', url: 'https://cardetail1.com/my-garage.html' },
    }, { prisma, env: BASE_ENV });
    assert.equal(conflict.error, 'sms_idempotency_conflict');
    assert.equal(conflict.statusCode, 409);
  });

  it('moves accepted → sent → delivered from signed-callback-compatible states', async () => {
    const { processSmsOutbox, applyStatusCallback } = require('../netlify/lib/sms-outbox');
    const provider = {
      ok: true,
      async send() {
        return { sid: 'SM00000000000000000000000000000001', status: 'accepted' };
      },
    };
    const processed = await processSmsOutbox({ prisma, env: SEND_ENV, provider, limit: 1 });
    assert.equal(processed.ok, true);
    assert.equal(processed.processed, 1);
    let row = await prisma.smsOutbox.findUnique({
      where: { providerMessageSid: 'SM00000000000000000000000000000001' },
    });
    assert.equal(row.status, 'accepted');
    assert.equal(row.attemptCount, 1);

    row = (await applyStatusCallback({
      providerMessageSid: row.providerMessageSid,
      providerStatus: 'sent',
    }, { prisma })).outbox;
    assert.equal(row.status, 'sent');
    row = (await applyStatusCallback({
      providerMessageSid: row.providerMessageSid,
      providerStatus: 'delivered',
    }, { prisma })).outbox;
    assert.equal(row.status, 'delivered');
    const stale = await applyStatusCallback({
      providerMessageSid: row.providerMessageSid,
      providerStatus: 'sent',
    }, { prisma });
    assert.equal(stale.unchanged, true);
    assert.equal(stale.outbox.status, 'delivered');
  });

  it('keeps concurrent status callbacks monotonic', async () => {
    const { enqueueSms, processSmsOutbox, applyStatusCallback } = require('../netlify/lib/sms-outbox');
    const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
    const key = `${RUN_ID}.admin.callback-race.1`;
    await enqueueSms({
      idempotencyKey: key,
      audience: 'admin',
      consentGranted: true,
      toE164: PHONE,
      templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
      templateData: { bookingRef: 'CD1-CALLBACK-RACE', customerName: 'Customer' },
    }, { prisma, env: BASE_ENV });
    const sid = 'SM00000000000000000000000000000004';
    await processSmsOutbox({
      prisma,
      env: SEND_ENV,
      provider: { ok: true, async send() { return { sid, status: 'accepted' }; } },
      limit: 1,
    });
    await Promise.all([
      applyStatusCallback({ providerMessageSid: sid, providerStatus: 'delivered' }, { prisma }),
      applyStatusCallback({ providerMessageSid: sid, providerStatus: 'sent' }, { prisma }),
    ]);
    const row = await prisma.smsOutbox.findUnique({ where: { providerMessageSid: sid } });
    assert.equal(row.status, 'delivered');
  });

  it('retries explicit provider rejection but never retries an ambiguous network result', async () => {
    const { enqueueSms, claimSmsById, processClaimedSms } = require('../netlify/lib/sms-outbox');
    const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
    const retryKey = `${RUN_ID}.admin.retry.1`;
    const queued = await enqueueSms({
      idempotencyKey: retryKey,
      audience: 'admin',
      consentGranted: true,
      toE164: PHONE,
      templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
      templateData: { bookingRef: 'CD1-RETRY', customerName: 'Customer' },
      maxAttempts: 3,
    }, { prisma, env: BASE_ENV });
    assert.equal(queued.ok, true, queued.error);
    const rejected = { ok: true, async send() { const err = new Error('rate_limited'); err.status = 429; throw err; } };
    const claimed = await claimSmsById(prisma, queued.outbox.id);
    assert.ok(claimed, 'retry row must be claimable');
    const first = await processClaimedSms(claimed, { prisma, env: SEND_ENV, provider: rejected });
    assert.equal(first.retryable, true);
    let retryRow = await prisma.smsOutbox.findUnique({ where: { idempotencyKey: retryKey } });
    assert.equal(retryRow.status, 'accepted');
    assert.ok(retryRow.availableAt > retryRow.createdAt);
    await prisma.smsOutbox.update({ where: { id: retryRow.id }, data: { availableAt: new Date(0) } });
    const accepted = {
      ok: true,
      async send() { return { sid: 'SM00000000000000000000000000000002', status: 'sent' }; },
    };
    const claimedRetry = await claimSmsById(prisma, retryRow.id);
    assert.ok(claimedRetry, 'backoff row must be claimable after availableAt reset');
    await processClaimedSms(claimedRetry, { prisma, env: SEND_ENV, provider: accepted });
    retryRow = await prisma.smsOutbox.findUnique({ where: { idempotencyKey: retryKey } });
    assert.equal(retryRow.status, 'sent');
    assert.equal(retryRow.attemptCount, 2);

    const ambiguousKey = `${RUN_ID}.admin.ambiguous.1`;
    const ambiguousQueued = await enqueueSms({
      idempotencyKey: ambiguousKey,
      audience: 'admin',
      consentGranted: true,
      toE164: PHONE,
      templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
      templateData: { bookingRef: 'CD1-AMBIGUOUS', customerName: 'Customer' },
    }, { prisma, env: BASE_ENV });
    const ambiguous = { ok: true, async send() { throw new Error('socket_closed_after_write'); } };
    const claimedAmbiguous = await claimSmsById(prisma, ambiguousQueued.outbox.id);
    const result = await processClaimedSms(claimedAmbiguous, { prisma, env: SEND_ENV, provider: ambiguous });
    assert.equal(result.retryable, false);
    const ambiguousRow = await prisma.smsOutbox.findUnique({ where: { idempotencyKey: ambiguousKey } });
    assert.equal(ambiguousRow.status, 'failed');
    assert.equal(ambiguousRow.attemptCount, 1);
  });
});

describe('PR5 signed webhooks and STOP/HELP', () => {
  const authToken = 'test-auth-token-for-signatures';
  const inboundUrl = 'https://cardetail1.com/.netlify/functions/twilio-inbound';
  const statusUrl = SEND_ENV.TWILIO_STATUS_CALLBACK_URL;
  const webhookEnv = {
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_INBOUND_WEBHOOK_URL: inboundUrl,
    TWILIO_STATUS_CALLBACK_URL: statusUrl,
  };

  function signedEvent(url, params, envUrlKey) {
    const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
    return {
      httpMethod: 'POST',
      headers: { 'x-twilio-signature': signature },
      body: new URLSearchParams(params).toString(),
      _envUrlKey: envUrlKey,
    };
  }

  it('accepts a valid evolving form payload and rejects an invalid signature', () => {
    const { validateTwilioWebhook } = require('../netlify/lib/twilio-webhook');
    const params = { MessageSid: 'SM00000000000000000000000000000003', MessageStatus: 'sent', FutureField: 'kept' };
    const valid = validateTwilioWebhook(signedEvent(statusUrl, params), 'status', webhookEnv);
    assert.equal(valid.ok, true);
    assert.equal(valid.params.FutureField, 'kept');
    const invalid = validateTwilioWebhook({
      httpMethod: 'POST',
      headers: { 'x-twilio-signature': 'invalid' },
      body: new URLSearchParams(params).toString(),
    }, 'status', webhookEnv);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.statusCode, 403);
  });

  it('STOP revokes consent, HELP does not change it, and neither creates a reply SMS', async () => {
    const oldEnv = {};
    for (const [key, value] of Object.entries(webhookEnv)) {
      oldEnv[key] = process.env[key];
      process.env[key] = value;
    }
    const inbound = require('../netlify/functions/twilio-inbound');
    try {
      const stopParams = { From: PHONE, To: '+12015550999', Body: 'STOP', OptOutType: 'STOP' };
      const stopped = await inbound.handler(signedEvent(inboundUrl, stopParams));
      assert.equal(stopped.statusCode, 200);
      assert.match(stopped.body, /<Response><\/Response>/);
      assert.equal((await consentStatus()).status, 'revoked');

      const version = await accountVersion();
      const repeated = await inbound.handler(signedEvent(inboundUrl, stopParams));
      assert.equal(repeated.statusCode, 200);
      assert.equal(await accountVersion(), version, 'replayed STOP must not churn account version');
      const { updateSmsConsent } = require('../netlify/lib/sms-consent-service');
      const regranted = await updateSmsConsent({
        customerAccountId: ACCOUNT_ID,
        expectedVersion: version,
        granted: true,
      }, { prisma });
      assert.equal(regranted.ok, true);
      const helpParams = { From: PHONE, To: '+12015550999', Body: 'HELP', OptOutType: 'HELP' };
      const helped = await inbound.handler(signedEvent(inboundUrl, helpParams));
      assert.equal(helped.statusCode, 200);
      assert.equal((await consentStatus()).status, 'granted');
    } finally {
      for (const key of Object.keys(webhookEnv)) {
        if (oldEnv[key] == null) delete process.env[key];
        else process.env[key] = oldEnv[key];
      }
    }
  });

  it('maps a signed callback with malformed SID to 400', async () => {
    const oldEnv = {};
    for (const [key, value] of Object.entries(webhookEnv)) {
      oldEnv[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const statusHandler = require('../netlify/functions/twilio-status-callback');
      const result = await statusHandler.handler(signedEvent(statusUrl, {
        MessageSid: 'invalid',
        MessageStatus: 'sent',
      }));
      assert.equal(result.statusCode, 400);
    } finally {
      for (const key of Object.keys(webhookEnv)) {
        if (oldEnv[key] == null) delete process.env[key];
        else process.env[key] = oldEnv[key];
      }
    }
  });
});

describe('PR5 source containment and sanitized logs', () => {
  it('keeps the provider call in one adapter and removes direct Twilio calls from financial paths', () => {
    const root = path.join(__dirname, '..', 'netlify');
    const files = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:js|ts)$/.test(entry.name)) files.push(full);
      }
    }
    walk(root);
    const direct = files.filter((file) => /api\.twilio\.com|messages\.create\(/.test(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(direct.map((file) => path.relative(root, file).replace(/\\/g, '/')), ['lib/twilio-provider.js']);
    for (const file of ['functions/stripe-webhook.js', 'lib/db/payment-authority-service.js']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.doesNotMatch(source, /messages\.create\(|api\.twilio\.com/);
    }
  });

  it('sanitizes provider failures before persistence or logging', async () => {
    const { enqueueSms, processSmsOutbox, safeProviderErrorCode } = require('../netlify/lib/sms-outbox');
    const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
    const sensitiveError = new Error(`recipient=${PHONE} body=PRIVATE_CUSTOMER_TEXT`);
    assert.equal(safeProviderErrorCode(sensitiveError), 'provider_error');
    const logs = [];
    const originalInfo = console.info;
    console.info = (...args) => logs.push(JSON.stringify(args));
    try {
      await enqueueSms({
        idempotencyKey: `${RUN_ID}.admin.sanitized-log.1`,
        audience: 'admin',
        consentGranted: true,
        toE164: PHONE,
        templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
        templateData: { bookingRef: 'PRIVATE_CUSTOMER_TEXT', customerName: 'Private Customer' },
      }, { prisma, env: BASE_ENV });
      await processSmsOutbox({
        prisma,
        env: SEND_ENV,
        provider: { ok: true, async send() { throw sensitiveError; } },
        limit: 1,
      });
    } finally {
      console.info = originalInfo;
    }
    const output = logs.join('\n');
    assert.equal(output.includes(PHONE), false);
    assert.doesNotMatch(output, /PRIVATE_CUSTOMER_TEXT|Private Customer/);
  });

  it('ships consent UI and never embeds live credentials', () => {
    const root = path.join(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'my-garage.html'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'assets/my-garage.js'), 'utf8');
    assert.match(html, /transactional SMS from Cardetail1/);
    assert.match(html, /Reply STOP to opt out or HELP for help/);
    assert.match(js, /update_sms_consent/);
    const adminHtml = fs.readFileSync(path.join(root, 'admin-ops.html'), 'utf8');
    const techAccounts = fs.readFileSync(path.join(root, 'netlify/functions/tech-accounts.js'), 'utf8');
    assert.match(adminHtml, /Technician explicitly agreed to receive job-related SMS/);
    assert.match(techAccounts, /smsConsentSource: smsConsent \? 'admin_attestation' : null/);
    const changedSources = [
      'netlify/lib/twilio-runtime-policy.js',
      'netlify/lib/twilio-provider.js',
      'netlify/lib/sms-outbox.js',
      'netlify/functions/twilio-inbound.js',
      'netlify/functions/twilio-status-callback.js',
    ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    assert.doesNotMatch(changedSources, /AC[a-f0-9]{32}|SK[a-f0-9]{32}|MG[a-f0-9]{32}/i);
  });
});
