'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');
const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const {
  suppressPhone,
  clearSuppression,
  readPhoneSuppression,
  setSuppressionReadOverride,
} = require('../netlify/lib/sms-suppression');
const { processClaimedSms, claimSmsById } = require('../netlify/lib/sms-outbox');
const { createTwilioProvider } = require('../netlify/lib/twilio-provider');
const { handleInboundSms } = require('../netlify/lib/twilio-inbound-handler');
const { validateTwilioWebhook } = require('../netlify/lib/twilio-webhook');
const worker = require('../netlify/functions/twilio-outbox-worker');
const { setPublicRateLimitStoreFactory, resetPublicRateLimitStoreFactory } = require('../netlify/lib/public-rate-limit');

const PHONE = '+12015550199';
const SECRET = 'worker-secret-test-only';
const NEXT_RUN = '2026-10-14T18:00:00.000Z';
const SEND_ENV = {
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  TWILIO_OUTBOX_ENABLED: 'true',
  TWILIO_ENABLED: 'true',
  TWILIO_PRODUCTION_SENDS_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_API_KEY: 'SK00000000000000000000000000000000',
  TWILIO_API_SECRET: 'test-only-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MG00000000000000000000000000000000',
  TWILIO_STATUS_CALLBACK_URL: 'https://cardetail1.com/.netlify/functions/twilio-status-callback',
  TWILIO_WORKER_SECRET: SECRET,
};

function claimedRow(templateKey, templateData = {}) {
  const row = {
    id: `sms-${templateKey}`,
    status: 'accepted',
    toE164: PHONE,
    templateKey,
    templateData,
    attemptCount: 1,
    maxAttempts: 5,
    providerMessageSid: null,
  };
  const prisma = {
    smsOutbox: {
      update: async ({ data }) => {
        Object.assign(row, data);
        return { ...row };
      },
    },
  };
  return { row, prisma };
}

function providerSpy() {
  const calls = [];
  return {
    calls,
    ok: true,
    async send(payload) {
      calls.push(payload);
      return { sid: `SM${'a'.repeat(32)}`, status: 'queued' };
    },
  };
}

function applyEnv(env) {
  const prior = {};
  for (const [key, value] of Object.entries(env)) {
    prior[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const key of Object.keys(env)) {
      if (prior[key] == null) delete process.env[key];
      else process.env[key] = prior[key];
    }
  };
}

describe('SMS STOP and worker authentication', { concurrency: 1 }, () => {
afterEach(() => {
  setSuppressionReadOverride(null);
  worker.__test.setProcessOverride(null);
  resetPublicRateLimitStoreFactory();
  delete process.env.PUBLIC_RATE_LIMIT_TWILIO_OUTBOX_WORKER_RUN_MAX;
});

test('STOP blocks review, arrival, and assignment sends', async () => {
  await suppressPhone(PHONE);
  try {
    for (const templateKey of [
      TEMPLATE_KEYS.REVIEW_REQUESTED,
      TEMPLATE_KEYS.TECH_ARRIVED,
      TEMPLATE_KEYS.TECH_AUCTION,
    ]) {
      const { row, prisma } = claimedRow(templateKey, {
        url: 'https://cardetail1.com/my-garage.html',
        service: 'Interior',
        date: 'Oct 20',
        area: '07102',
      });
      const provider = providerSpy();
      const result = await processClaimedSms(row, { prisma, provider, env: SEND_ENV });
      assert.equal(result.reason, 'suppressed', templateKey);
      assert.equal(provider.calls.length, 0, templateKey);
      assert.equal(row.status, 'failed', templateKey);
      assert.equal(row.lastErrorCode, 'suppressed', templateKey);
    }
  } finally {
    await clearSuppression(PHONE);
  }
});

test('an unavailable suppression store records a retry and does not send', async () => {
  setSuppressionReadOverride(async () => {
    throw new Error('blob down');
  });
  const { row, prisma } = claimedRow(TEMPLATE_KEYS.REVIEW_REQUESTED, {
    url: 'https://cardetail1.com/my-garage.html',
  });
  const provider = providerSpy();
  const result = await processClaimedSms(row, { prisma, provider, env: SEND_ENV });
  assert.equal(result.reason, 'suppression_unavailable');
  assert.equal(result.retryable, true);
  assert.equal(provider.calls.length, 0);
  assert.equal(row.status, 'accepted');
  assert.equal(row.lastErrorCode, 'suppression_unavailable');
  assert.equal(row.leaseToken, null);
});

test('a direct provider call cannot skip suppression', async () => {
  const calls = [];
  const client = {
    messages: {
      create: async (payload) => {
        calls.push(payload);
        return { sid: `SM${'b'.repeat(32)}`, status: 'queued' };
      },
    },
  };
  await suppressPhone(PHONE);
  try {
    const provider = createTwilioProvider(SEND_ENV, { client });
    await assert.rejects(() => provider.send({ to: PHONE, body: 'Cardetail1: hello' }), /sms_suppressed/);
    assert.equal(calls.length, 0);
  } finally {
    await clearSuppression(PHONE);
  }
  setSuppressionReadOverride(async () => ({ ok: false, error: 'suppression_unavailable' }));
  const blocked = createTwilioProvider(SEND_ENV, { client });
  await assert.rejects(() => blocked.send({ to: PHONE, body: 'Cardetail1: hello' }), /suppression_unavailable/);
  assert.equal(calls.length, 0);
  const open = await readPhoneSuppression(PHONE);
  assert.equal(open.ok, false);
});

test('inbound STOP stays empty and a suppression outage does not auto-reply', async () => {
  await suppressPhone(PHONE);
  try {
    const suppressed = await handleInboundSms({
      From: PHONE,
      Body: 'Can you come tomorrow?',
    }, { env: { PUBLIC_SITE_URL: 'https://cardetail1.com' } });
    assert.equal(suppressed.action, 'suppressed');
    assert.doesNotMatch(suppressed.twiml, /<Message>/);
  } finally {
    await clearSuppression(PHONE);
  }
  setSuppressionReadOverride(async () => ({ ok: false, error: 'suppression_unavailable' }));
  const unavailable = await handleInboundSms({
    From: PHONE,
    Body: 'Can you come tomorrow?',
  }, { env: { PUBLIC_SITE_URL: 'https://cardetail1.com' } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.action, 'suppression_unavailable');
  assert.doesNotMatch(unavailable.twiml, /<Message>/);
});

test('a forged schedule header does not change the production drain', async () => {
  const restore = applyEnv(SEND_ENV);
  const runs = [];
  worker.__test.setProcessOverride(async () => {
    runs.push('claimed');
    return { ok: true, processed: 1 };
  });
  try {
    const plain = await worker.handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.10' },
      body: JSON.stringify({ next_run: NEXT_RUN }),
    });
    const forged = await worker.handler({
      httpMethod: 'POST',
      headers: {
        'x-nf-event': 'schedule',
        'x-netlify-event': 'schedule',
        'x-nf-scheduled': 'true',
        'user-agent': 'Netlify Clockwork',
        'x-nf-client-connection-ip': '203.0.113.15',
      },
      body: JSON.stringify({ next_run: NEXT_RUN }),
    });
    assert.equal(plain.statusCode, 200, plain.body);
    assert.equal(forged.statusCode, 200, forged.body);
    assert.equal(JSON.parse(plain.body).processed, 1);
    assert.equal(JSON.parse(forged.body).processed, 1);
    assert.equal(runs.length, 2);
  } finally {
    restore();
  }
});

test('a caller-supplied worker secret is ignored', async () => {
  const restore = applyEnv(SEND_ENV);
  const runs = [];
  worker.__test.setProcessOverride(async () => {
    runs.push('run');
    return { ok: true, processed: 1 };
  });
  const base = {
    httpMethod: 'POST',
    body: JSON.stringify({ next_run: NEXT_RUN }),
  };
  try {
    const missing = await worker.handler({
      ...base,
      headers: { 'x-nf-client-connection-ip': '203.0.113.11' },
    });
    const wrong = await worker.handler({
      ...base,
      headers: { 'x-nf-client-connection-ip': '203.0.113.21', 'x-worker-secret': 'wrong-secret' },
    });
    const present = await worker.handler({
      ...base,
      headers: { 'x-nf-client-connection-ip': '203.0.113.22', 'x-worker-secret': SECRET },
    });
    assert.equal(missing.statusCode, 200, missing.body);
    assert.equal(wrong.statusCode, 200, wrong.body);
    assert.equal(present.statusCode, 200, present.body);
    assert.equal(runs.length, 3);
  } finally {
    restore();
  }
});

test('preview and branch deploys do not drain even with the worker secret', async () => {
  const runs = [];
  worker.__test.setProcessOverride(async () => {
    runs.push('run');
    return { ok: true, processed: 1 };
  });
  for (const env of [
    { ...SEND_ENV, CONTEXT: 'deploy-preview' },
    { ...SEND_ENV, CONTEXT: 'branch-deploy', BRANCH: 'feature/sms' },
  ]) {
    const restore = applyEnv(env);
    try {
      const response = await worker.handler({
        httpMethod: 'POST',
        headers: {
          'x-nf-event': 'schedule',
          'x-nf-scheduled': 'true',
          'user-agent': 'Netlify Clockwork',
          'x-nf-client-connection-ip': '203.0.113.12',
        },
        body: JSON.stringify({ next_run: NEXT_RUN }),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(JSON.parse(response.body).disabled, true);
      assert.equal(JSON.parse(response.body).processed, 0);
    } finally {
      restore();
    }
  }
  assert.equal(runs.length, 0);
});

test('production Run now and the schedule share one processor', async () => {
  const restore = applyEnv(SEND_ENV);
  const runs = [];
  worker.__test.setProcessOverride(async () => {
    runs.push('run');
    return { ok: true, processed: 0 };
  });
  try {
    const response = await worker.handler({
      httpMethod: 'POST',
      headers: {
        'user-agent': 'Netlify Clockwork',
        'x-nf-client-connection-ip': '203.0.113.13',
      },
      body: JSON.stringify({ next_run: NEXT_RUN }),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).disabled, false);
    assert.equal(runs.length, 1);
  } finally {
    restore();
  }
});

test('rate limit stops a second authenticated drain and is not authentication', async () => {
  process.env.PUBLIC_RATE_LIMIT_TWILIO_OUTBOX_WORKER_RUN_MAX = '1';
  const values = new Map();
  setPublicRateLimitStoreFactory(() => ({
    async getWithMetadata(key) {
      const row = values.get(key);
      return row ? { data: row.value, etag: row.etag } : null;
    },
    async setJSON(key, value) {
      const etag = `e${values.size + 1}`;
      values.set(key, { value, etag });
      return { modified: true, etag };
    },
  }));
  const restore = applyEnv(SEND_ENV);
  const runs = [];
  worker.__test.setProcessOverride(async () => {
    runs.push('run');
    return { ok: true, processed: 1 };
  });
  const event = {
    httpMethod: 'POST',
    headers: {
      'x-nf-client-connection-ip': '203.0.113.14',
    },
  };
  try {
    const first = await worker.handler(event);
    const second = await worker.handler(event);
    const forged = await worker.handler({
      httpMethod: 'POST',
      headers: {
        'x-nf-client-connection-ip': '203.0.113.14',
        'x-nf-event': 'schedule',
        'x-nf-scheduled': 'true',
        'user-agent': 'Netlify Clockwork',
      },
      body: JSON.stringify({ next_run: NEXT_RUN }),
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 429, second.body);
    assert.equal(JSON.parse(second.body).processed, 0);
    assert.equal(forged.statusCode, 429, forged.body);
    assert.equal(runs.length, 1);
  } finally {
    restore();
  }
});

test('repeated and concurrent claims send at most once', async () => {
  let held = false;
  let sends = 0;
  const row = {
    id: 'sms-once',
    status: 'accepted',
    toE164: PHONE,
    templateKey: TEMPLATE_KEYS.TECH_ARRIVED,
    templateData: {},
    attemptCount: 0,
    maxAttempts: 5,
    providerMessageSid: null,
    leaseToken: null,
  };
  const prisma = {
    smsOutbox: {
      updateMany: async () => {
        if (held || row.providerMessageSid) return { count: 0 };
        held = true;
        row.attemptCount += 1;
        return { count: 1 };
      },
      update: async ({ data }) => {
        Object.assign(row, data);
        if (data.providerMessageSid) held = false;
        return { ...row };
      },
      findUnique: async () => ({ ...row }),
    },
  };
  const provider = {
    ok: true,
    async send() {
      sends += 1;
      return { sid: `SM${'c'.repeat(32)}`, status: 'sent' };
    },
  };
  const [first, second] = await Promise.all([
    claimSmsById(prisma, row.id),
    claimSmsById(prisma, row.id),
  ]);
  const claimed = [first, second].filter(Boolean);
  assert.equal(claimed.length, 1);
  const sent = await processClaimedSms(claimed[0], { prisma, provider, env: SEND_ENV });
  assert.equal(sent.ok, true);
  held = false;
  const replay = await claimSmsById(prisma, row.id);
  assert.equal(replay, null);
  assert.equal(sends, 1);
});

test('Twilio webhook signatures stay required', () => {
  const authToken = 'test-auth-token-for-signatures';
  const url = 'https://cardetail1.com/.netlify/functions/twilio-status-callback';
  const params = { MessageSid: `SM${'d'.repeat(32)}`, MessageStatus: 'sent' };
  const env = {
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_STATUS_CALLBACK_URL: url,
  };
  const body = new URLSearchParams(params).toString();
  const missing = validateTwilioWebhook({
    httpMethod: 'POST',
    headers: {},
    body,
  }, 'status', env);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'signature_missing');
  const wrong = validateTwilioWebhook({
    httpMethod: 'POST',
    headers: { 'x-twilio-signature': 'not-a-signature' },
    body,
  }, 'status', env);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.statusCode, 403);
  const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
  const correct = validateTwilioWebhook({
    httpMethod: 'POST',
    headers: { 'x-twilio-signature': signature },
    body,
  }, 'status', env);
  assert.equal(correct.ok, true);
});
});
