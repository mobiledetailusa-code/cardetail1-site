'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');
const { complianceKeyword, handleInboundSms } = require('../netlify/lib/twilio-inbound-handler');
const { validateTwilioWebhook } = require('../netlify/lib/twilio-webhook');
const {
  suppressPhone,
  clearSuppression,
  readPhoneSuppression,
  setSuppressionReadOverride,
} = require('../netlify/lib/sms-suppression');
const { assertCustomerSmsConsent } = require('../netlify/lib/sms-consent-service');
const { processClaimedSms, claimSmsById, normalizeProviderStatus } = require('../netlify/lib/sms-outbox');
const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const inbound = require('../netlify/functions/twilio-inbound');

const PHONE = '+12015550188';
const OTHER = '+12015550177';
const AUTH = 'test-auth-token-for-signatures';
const INBOUND_URL = 'https://cardetail1.com/.netlify/functions/twilio-inbound';
const WEBHOOK_ENV = {
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  TWILIO_AUTH_TOKEN: AUTH,
  TWILIO_INBOUND_WEBHOOK_URL: INBOUND_URL,
};

function sid(char) {
  return `SM${char.repeat(32)}`;
}

function signedEvent(params, { url = INBOUND_URL, rawQuery = '', contentType } = {}) {
  const signature = twilio.getExpectedTwilioSignature(AUTH, rawQuery ? `${new URL(url).origin}${new URL(url).pathname}?${rawQuery}` : url, params);
  return {
    httpMethod: 'POST',
    rawQuery,
    headers: {
      'x-twilio-signature': signature,
      ...(contentType ? { 'content-type': contentType } : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    body: new URLSearchParams(params).toString(),
  };
}

describe('SMS consent channel', { concurrency: 1 }, () => {
  afterEach(async () => {
    setSuppressionReadOverride(null);
    await clearSuppression(PHONE);
    await clearSuppression(OTHER);
    await clearSuppression('2015550188');
  });

  test('keywords are exact, case-insensitive, and ignore YES', () => {
    for (const word of ['stop', ' STOP ', 'STOPALL', 'unsubscribe', 'Cancel', 'end', 'quit', 'revoke', 'optout']) {
      assert.equal(complianceKeyword({ Body: word }), 'STOP', word);
    }
    for (const word of ['start', ' UNSTOP ']) {
      assert.equal(complianceKeyword({ Body: word }), 'START', word);
    }
    assert.equal(complianceKeyword({ Body: 'YES' }), '');
    assert.equal(complianceKeyword({ Body: 'please stop texting' }), '');
    assert.equal(complianceKeyword({ OptOutType: 'STOP', Body: 'hello' }), 'STOP');
    assert.equal(complianceKeyword({ OptOutType: 'START', Body: 'YES' }), 'START');
  });

  test('STOP and START are idempotent by MessageSid and do not cross numbers', async () => {
    const stopSid = sid('a');
    const first = await handleInboundSms({
      From: '2015550188',
      Body: 'stop',
      MessageSid: stopSid,
    }, { revokeConsent: async () => ({ ok: true, revoked: 0 }) });
    assert.equal(first.action, 'stop');
    assert.doesNotMatch(first.twiml, /<Message>/);
    assert.equal((await readPhoneSuppression(PHONE)).suppressed, true);
    assert.equal((await readPhoneSuppression(OTHER)).suppressed, false);
    const replay = await handleInboundSms({
      From: PHONE,
      Body: 'START',
      MessageSid: stopSid,
    }, { revokeConsent: async () => ({ ok: true }) });
    assert.equal(replay.action, 'duplicate');
    assert.equal((await readPhoneSuppression(PHONE)).suppressed, true);
    const started = await handleInboundSms({
      From: PHONE,
      Body: 'UNSTOP',
      MessageSid: sid('b'),
    });
    assert.equal(started.action, 'start');
    assert.equal((await readPhoneSuppression(PHONE)).suppressed, false);
    await suppressPhone(PHONE);
    const yes = await handleInboundSms({ From: PHONE, Body: 'YES', MessageSid: sid('c') });
    assert.notEqual(yes.action, 'start');
    assert.equal((await readPhoneSuppression(PHONE)).suppressed, true);
  });

  test('a signed webhook can stop and an unsigned or mismatched webhook cannot', async () => {
    const prior = {};
    for (const [key, value] of Object.entries(WEBHOOK_ENV)) {
      prior[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const params = { From: PHONE, To: '+12015550999', Body: 'STOP', MessageSid: sid('d') };
      const missing = await inbound.handler({
        httpMethod: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
      assert.equal(missing.statusCode, 403);
      assert.equal((await readPhoneSuppression(PHONE)).suppressed, false);

      const bad = await inbound.handler({
        ...signedEvent(params),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' },
      });
      assert.equal(bad.statusCode, 403);
      assert.equal((await readPhoneSuppression(PHONE)).suppressed, false);

      const tampered = signedEvent(params);
      tampered.body = new URLSearchParams({ ...params, Body: 'START' }).toString();
      const tamperedResult = await inbound.handler(tampered);
      assert.equal(tamperedResult.statusCode, 403);

      const mismatched = signedEvent(params);
      mismatched.rawQuery = 'extra=1';
      const otherUrl = validateTwilioWebhook(mismatched, 'inbound', WEBHOOK_ENV);
      assert.equal(otherUrl.ok, false);
      const matched = validateTwilioWebhook(signedEvent(params, { rawQuery: 'extra=1' }), 'inbound', WEBHOOK_ENV);
      assert.equal(matched.ok, true);

      const json = validateTwilioWebhook({
        httpMethod: 'POST',
        headers: { 'content-type': 'application/json', 'x-twilio-signature': 'abc' },
        body: JSON.stringify(params),
      }, 'inbound', WEBHOOK_ENV);
      assert.equal(json.ok, false);
      assert.equal(json.statusCode, 403);

      const ok = await inbound.handler(signedEvent(params));
      assert.equal(ok.statusCode, 200);
      assert.doesNotMatch(ok.body, /<Message>/);
      assert.equal((await readPhoneSuppression(PHONE)).suppressed, true);
      const replay = await inbound.handler(signedEvent(params));
      assert.equal(replay.statusCode, 200);
      assert.equal((await readPhoneSuppression(PHONE)).suppressed, true);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('a new booking checkbox does not clear STOP', async () => {
    await suppressPhone(PHONE);
    const decision = await assertCustomerSmsConsent({
      toE164: PHONE,
      booking: {
        phone: PHONE,
        transactionalSmsConsentAccepted: true,
        transactionalSmsConsent: {
          granted: true,
          textVersion: 'cd1-txn-sms-v3-2026-08-28',
          source: 'public_booking_checkbox',
          method: 'booking_checkbox',
          programName: 'Cardetail1',
          recordedAt: new Date().toISOString(),
          phoneE164: PHONE,
        },
      },
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'sms_suppressed');
    assert.equal((await readPhoneSuppression(PHONE)).suppressed, true);
  });

  test('carrier opt-out codes suppress and do not retry', async () => {
    const row = {
      id: 'sms-optout',
      status: 'accepted',
      toE164: PHONE,
      templateKey: TEMPLATE_KEYS.TECH_ARRIVED,
      templateData: {},
      attemptCount: 1,
      maxAttempts: 5,
      providerMessageSid: null,
      lastErrorCode: null,
    };
    const prisma = {
      smsOutbox: {
        update: async ({ data }) => {
          Object.assign(row, data);
          return { ...row };
        },
      },
    };
    let sends = 0;
    const provider = {
      ok: true,
      async send() {
        sends += 1;
        const error = new Error('opted out');
        error.code = 21610;
        throw error;
      },
    };
    const result = await processClaimedSms(row, { prisma, provider, env: process.env });
    assert.equal(result.reason, 'suppressed');
    assert.equal(sends, 1);
    assert.equal(row.status, 'failed');
    assert.equal(row.lastErrorCode, 'suppressed');
    assert.equal((await readPhoneSuppression(PHONE)).suppressed, true);
    const again = await processClaimedSms(row, { prisma, provider, env: process.env });
    assert.equal(again.skipped, true);
    assert.equal(sends, 1);
    assert.equal(normalizeProviderStatus('queued'), 'accepted');
    assert.equal(normalizeProviderStatus('delivered'), 'delivered');
  });

  test('an expired lease can be claimed once and a live lease cannot', async () => {
    const row = {
      id: 'sms-lease',
      status: 'accepted',
      providerMessageSid: null,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attemptCount: 0,
    };
    const prisma = {
      smsOutbox: {
        updateMany: async ({ where }) => {
          const leaseOpen = !row.leaseExpiresAt || row.leaseExpiresAt < where.OR[1].leaseExpiresAt.lt;
          if (!leaseOpen || row.status !== 'accepted' || row.providerMessageSid) return { count: 0 };
          row.leaseExpiresAt = new Date(Date.now() + 60_000);
          row.attemptCount += 1;
          return { count: 1 };
        },
        findUnique: async () => ({ ...row }),
      },
    };
    assert.equal(await claimSmsById(prisma, row.id), null);
    row.leaseExpiresAt = new Date(Date.now() - 1000);
    const claimed = await claimSmsById(prisma, row.id);
    assert.ok(claimed);
    assert.equal(claimed.attemptCount, 1);
  });
});
