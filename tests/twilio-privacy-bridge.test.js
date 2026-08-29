'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');
const { renderSmsTemplate, TEMPLATE_KEYS, ADMIN_TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const {
  parseOwnerReply,
  last4FromE164,
  handleInboundSms,
  handleMissedCall,
  inboundPreview,
} = require('../netlify/lib/sms-bridge');
const { inboundDialResponse } = require('../netlify/functions/twilio-voice');

const CUSTOMER = '+12015550111';
const OWNER = '+12015550999';
const TWILIO_NUMBER = '+12015550888';
const VOICE_URL = 'https://cardetail1.com/.netlify/functions/twilio-voice';
const ENV = {
  ADMIN_SMS: OWNER,
  ADMIN_SMS_CONSENT_GRANTED: 'true',
};

function memoryPrisma() {
  const threads = new Map();
  const messages = [];
  const calls = new Map();
  const consents = new Map();
  let seq = 0;
  const id = () => `br_${++seq}`;
  return {
    _threads: threads,
    _messages: messages,
    _calls: calls,
    customerProfile: {
      async findMany() { return []; },
    },
    customerConsent: {
      async findFirst() { return null; },
    },
    smsBridgeThread: {
      async upsert({ where, create, update }) {
        const key = where.customerE164;
        const existing = threads.get(key);
        if (!existing) {
          const row = { id: id(), ...create };
          threads.set(key, row);
          return row;
        }
        Object.assign(existing, update);
        return existing;
      },
      async findFirst({ where, orderBy }) {
        let rows = [...threads.values()];
        if (where.last4) rows = rows.filter((row) => row.last4 === where.last4);
        if (where.lastInboundAt?.gte) {
          const since = where.lastInboundAt.gte;
          rows = rows.filter((row) => row.lastInboundAt >= since);
        }
        rows.sort((a, b) => b.lastInboundAt - a.lastInboundAt);
        if (orderBy?.lastInboundAt === 'desc') return rows[0] || null;
        return rows[0] || null;
      },
      async update({ where, data }) {
        const row = [...threads.values()].find((item) => item.id === where.id);
        if (!row) throw new Error('missing_thread');
        Object.assign(row, data);
        return row;
      },
    },
    smsBridgeMessage: {
      async create({ data }) {
        if (data.providerSid && messages.some((row) => row.providerSid === data.providerSid)) {
          const err = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: id(), ...data };
        messages.push(row);
        return row;
      },
    },
    voiceBridgeCall: {
      async create({ data }) {
        if (calls.has(data.callSid)) {
          const err = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: id(), ...data };
        calls.set(data.callSid, row);
        return row;
      },
      async findUnique({ where }) {
        return calls.get(where.callSid) || null;
      },
      async updateMany({ where, data }) {
        const row = calls.get(where.callSid);
        if (!row) return { count: 0 };
        if (where.notified === false && row.notified) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    _revoke(phone) {
      consents.set(phone, 'revoked');
    },
  };
}

function captureEnqueue() {
  const sent = [];
  return {
    sent,
    async enqueueSms(input) {
      const row = { id: `ob_${sent.length + 1}`, ...input };
      sent.push(row);
      return { ok: true, queued: true, outbox: row };
    },
    async kickSmsOutboxByIds() {
      return { ok: true, processed: sent.length };
    },
  };
}

describe('privacy SMS/voice bridge helpers', () => {
  it('masks to last 4 and parses an optional last-4 owner prefix', () => {
    assert.equal(last4FromE164(CUSTOMER), '0111');
    assert.deepEqual(parseOwnerReply('2pm works'), { last4: '', body: '2pm works' });
    assert.equal(parseOwnerReply('0111 see you then').last4, '0111');
    assert.equal(parseOwnerReply('0111 see you then').body, 'see you then');
  });

  it('admin inbound and missed-call templates never include a full customer number', () => {
    const inbound = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_INBOUND_SMS, {
      last4: '0111',
      body: 'Can I change my appointment to 2pm?',
    });
    assert.equal(inbound.ok, true);
    assert.match(inbound.body, /^Cardetail1 Admin:/);
    assert.match(inbound.body, /\*\*\*-0111/);
    assert.doesNotMatch(inbound.body, /2015550111|\+12015550111/);
    assert.match(inbound.body, /Reply to this Cardetail1 number/);
    const missed = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_MISSED_CALL, { last4: '0111' });
    assert.match(missed.body, /^Cardetail1 Admin:/);
    assert.doesNotMatch(missed.body, /2015550111/);
    const reply = renderSmsTemplate(TEMPLATE_KEYS.CUSTOMER_BRIDGE_REPLY, { body: 'Yes, 2pm works' });
    assert.match(reply.body, /^Cardetail1:/);
    assert.doesNotMatch(reply.body, /2015550999|\+12015550999/);
    assert.equal(ADMIN_TEMPLATE_KEYS.has(TEMPLATE_KEYS.ADMIN_INBOUND_SMS), true);
    assert.equal(ADMIN_TEMPLATE_KEYS.has(TEMPLATE_KEYS.CUSTOMER_BRIDGE_REPLY), false);
  });

  it('voice Dial uses the Cardetail1 Twilio number as caller ID, never the customer', () => {
    const res = inboundDialResponse({
      From: CUSTOMER,
      To: TWILIO_NUMBER,
    }, VOICE_URL, ENV);
    assert.match(res.body, /callerId="\+12015550888"/);
    assert.match(res.body, /<Number>\+12015550999<\/Number>/);
    assert.doesNotMatch(res.body, /callerId="\+12015550111"/);
    const loop = inboundDialResponse({ From: OWNER, To: TWILIO_NUMBER }, VOICE_URL, ENV);
    assert.match(loop.body, /<Say/);
    assert.doesNotMatch(loop.body, /<Dial/);
  });
});

describe('inbound SMS bridge routing', () => {
  it('forwards ordinary customer text to ADMIN_SMS and not back to the customer', async () => {
    const prisma = memoryPrisma();
    const capture = captureEnqueue();
    const result = await handleInboundSms({
      From: CUSTOMER,
      To: TWILIO_NUMBER,
      Body: 'Can I change my appointment to 2pm?',
      MessageSid: 'SM00000000000000000000000000000001',
    }, { prisma, env: ENV, enqueueSms: capture.enqueueSms, kickSmsOutboxByIds: capture.kickSmsOutboxByIds });
    assert.equal(result.ok, true);
    assert.equal(result.role, 'customer');
    assert.equal(capture.sent.length, 1);
    assert.equal(capture.sent[0].audience, 'admin');
    assert.equal(capture.sent[0].toE164, OWNER);
    assert.equal(capture.sent[0].templateKey, TEMPLATE_KEYS.ADMIN_INBOUND_SMS);
    assert.equal(capture.sent[0].templateData.last4, '0111');
    assert.doesNotMatch(JSON.stringify(capture.sent[0].templateData), /\+12015550111/);
  });

  it('routes an owner reply on the Twilio number back to the last customer', async () => {
    const prisma = memoryPrisma();
    const capture = captureEnqueue();
    const opts = { prisma, env: ENV, enqueueSms: capture.enqueueSms, kickSmsOutboxByIds: capture.kickSmsOutboxByIds };
    await handleInboundSms({
      From: CUSTOMER,
      To: TWILIO_NUMBER,
      Body: 'Can I change to 2pm?',
      MessageSid: 'SM00000000000000000000000000000002',
    }, opts);
    capture.sent.length = 0;
    const result = await handleInboundSms({
      From: OWNER,
      To: TWILIO_NUMBER,
      Body: 'Yes, 2pm is fine',
      MessageSid: 'SM00000000000000000000000000000003',
    }, opts);
    assert.equal(result.ok, true);
    assert.equal(result.role, 'owner');
    assert.equal(capture.sent.length, 1);
    assert.equal(capture.sent[0].audience, 'bridge');
    assert.equal(capture.sent[0].toE164, CUSTOMER);
    assert.equal(capture.sent[0].templateData.body, 'Yes, 2pm is fine');
    assert.equal(capture.sent.some((row) => row.audience === 'admin'), false);
  });

  it('does not create a customer thread or admin alert when the owner texts first', async () => {
    const prisma = memoryPrisma();
    const capture = captureEnqueue();
    const result = await handleInboundSms({
      From: OWNER,
      To: TWILIO_NUMBER,
      Body: 'hello',
      MessageSid: 'SM00000000000000000000000000000004',
    }, { prisma, env: ENV, enqueueSms: capture.enqueueSms, kickSmsOutboxByIds: capture.kickSmsOutboxByIds });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_active_thread');
    assert.equal(capture.sent.length, 0);
    assert.equal(prisma._threads.size, 0);
  });

  it('MMS without text still notifies the owner', async () => {
    const prisma = memoryPrisma();
    const capture = captureEnqueue();
    const result = await handleInboundSms({
      From: CUSTOMER,
      To: TWILIO_NUMBER,
      Body: '',
      NumMedia: '1',
      MessageSid: 'SM00000000000000000000000000000005',
    }, { prisma, env: ENV, enqueueSms: capture.enqueueSms, kickSmsOutboxByIds: capture.kickSmsOutboxByIds });
    assert.equal(result.ok, true);
    assert.match(capture.sent[0].templateData.body, /MMS|photo/i);
  });
});

describe('missed-call notify', () => {
  it('alerts ADMIN_SMS on no-answer and is idempotent on CallSid', async () => {
    const prisma = memoryPrisma();
    const capture = captureEnqueue();
    const opts = { prisma, env: ENV, enqueueSms: capture.enqueueSms, kickSmsOutboxByIds: capture.kickSmsOutboxByIds };
    const params = {
      CallSid: 'CA00000000000000000000000000000001',
      From: CUSTOMER,
      DialCallStatus: 'no-answer',
    };
    const first = await handleMissedCall(params, opts);
    const second = await handleMissedCall(params, opts);
    assert.equal(first.ok, true);
    assert.equal(capture.sent.length, 1);
    assert.equal(capture.sent[0].templateKey, TEMPLATE_KEYS.ADMIN_MISSED_CALL);
    assert.equal(capture.sent[0].templateData.last4, '0111');
    assert.equal(second.skipped, true);
  });

  it('does not alert when the owner answered', async () => {
    const prisma = memoryPrisma();
    const capture = captureEnqueue();
    const result = await handleMissedCall({
      CallSid: 'CA00000000000000000000000000000002',
      From: CUSTOMER,
      DialCallStatus: 'completed',
    }, { prisma, env: ENV, enqueueSms: capture.enqueueSms, kickSmsOutboxByIds: capture.kickSmsOutboxByIds });
    assert.equal(result.skipped, true);
    assert.equal(capture.sent.length, 0);
  });
});

describe('signed voice webhook rejects unsigned requests', () => {
  it('returns 403 without a valid Twilio signature', async () => {
    const prior = {};
    const env = {
      CONTEXT: 'production',
      BRANCH: 'master',
      URL: 'https://cardetail1.com',
      TWILIO_AUTH_TOKEN: 'test-auth-token-for-signatures',
      TWILIO_VOICE_WEBHOOK_URL: VOICE_URL,
      ADMIN_SMS: OWNER,
      ADMIN_SMS_CONSENT_GRANTED: 'true',
    };
    for (const [key, value] of Object.entries(env)) {
      prior[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const voice = require('../netlify/functions/twilio-voice');
      const denied = await voice.handler({
        httpMethod: 'POST',
        headers: { 'x-twilio-signature': 'invalid' },
        body: new URLSearchParams({ From: CUSTOMER, To: TWILIO_NUMBER }).toString(),
      });
      assert.equal(denied.statusCode, 403);
      const signature = twilio.getExpectedTwilioSignature(
        env.TWILIO_AUTH_TOKEN,
        VOICE_URL,
        { From: CUSTOMER, To: TWILIO_NUMBER },
      );
      const ok = await voice.handler({
        httpMethod: 'POST',
        headers: { 'x-twilio-signature': signature },
        body: new URLSearchParams({ From: CUSTOMER, To: TWILIO_NUMBER }).toString(),
      });
      assert.equal(ok.statusCode, 200);
      assert.match(ok.body, /<Dial callerId="\+12015550888"/);
    } finally {
      for (const key of Object.keys(env)) {
        if (prior[key] == null) delete process.env[key];
        else process.env[key] = prior[key];
      }
    }
  });
});

describe('preview helper', () => {
  it('does not invent body text for blank SMS', () => {
    assert.equal(inboundPreview('', 0), '');
    assert.match(inboundPreview('', 2), /photo or video/i);
  });
});
