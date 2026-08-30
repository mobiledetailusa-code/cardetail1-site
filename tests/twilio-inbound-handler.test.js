'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  complianceKeyword,
  buildInboundAutoReply,
  twimlMessage,
  inboundAdminIdempotencyKey,
  handleInboundSms,
} = require('../netlify/lib/twilio-inbound-handler');
const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');

test('compliance keywords still recognize STOP and HELP', () => {
  assert.equal(complianceKeyword({ Body: 'STOP', OptOutType: 'STOP' }), 'STOP');
  assert.equal(complianceKeyword({ Body: 'HELP', OptOutType: 'HELP' }), 'HELP');
  assert.equal(complianceKeyword({ Body: 'How much for an SUV?' }), '');
});

test('general inbound auto-reply includes booking guidance', () => {
  const reply = buildInboundAutoReply({ PUBLIC_SITE_URL: 'https://cardetail1.com' });
  assert.match(reply, /Cardetail1:/);
  assert.match(reply, /cardetail1\.com/);
  assert.match(reply, /Reply STOP to opt out/i);
});

test('twimlMessage escapes XML characters', () => {
  const xml = twimlMessage('A & B <test>');
  assert.match(xml, /&amp;/);
  assert.match(xml, /&lt;test&gt;/);
});

test('inbound admin idempotency prefers Twilio MessageSid', () => {
  assert.equal(
    inboundAdminIdempotencyKey({ MessageSid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', From: '+12015550100', Body: 'Hi' }),
    'admin.inbound-sms:SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
});

test('general inbound replies to customer and notifies admin', async () => {
  const calls = [];
  const result = await handleInboundSms({
    From: '+12015550100',
    Body: 'Do you service Westchester?',
    MessageSid: 'SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }, {
    env: {
      PUBLIC_SITE_URL: 'https://cardetail1.com',
      ADMIN_SMS_CONSENT_GRANTED: 'true',
      ADMIN_SMS: '+12015550999',
      TWILIO_OUTBOX_ENABLED: 'true',
      TWILIO_ENABLED: 'true',
      CONTEXT: 'production',
      BRANCH: 'master',
      URL: 'https://cardetail1.com',
    },
    awaitAdminNotify: true,
    revokeConsent: async () => ({ ok: true }),
    prisma: {
      smsOutbox: {
        findUnique: async () => null,
        create: async ({ data }) => {
          calls.push(data);
          return { id: 'out-1', ...data };
        },
      },
    },
  });

  assert.equal(result.action, 'auto_reply');
  assert.match(result.twiml, /<Message>/);
  assert.match(result.twiml, /Book mobile detailing/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].audience, 'admin');
  assert.equal(calls[0].templateKey, TEMPLATE_KEYS.ADMIN_INBOUND_SMS);
  assert.equal(calls[0].toE164, '+12015550999');
  assert.equal(calls[0].templateData.message, 'Do you service Westchester?');
});

test('STOP still revokes consent and returns empty TwiML', async () => {
  let revoked = false;
  const result = await handleInboundSms({ From: '+12015550100', Body: 'STOP', OptOutType: 'STOP' }, {
    revokeConsent: async () => {
      revoked = true;
      return { ok: true };
    },
  });
  assert.equal(revoked, true);
  assert.equal(result.action, 'stop');
  assert.match(result.twiml, /<Response><\/Response>/);
  assert.doesNotMatch(result.twiml, /<Message>/);
});

test('HELP returns empty TwiML so Advanced Opt-Out can respond', async () => {
  const result = await handleInboundSms({ From: '+12015550100', Body: 'HELP', OptOutType: 'HELP' }, {
    revokeConsent: async () => ({ ok: false }),
  });
  assert.equal(result.action, 'help');
  assert.match(result.twiml, /<Response><\/Response>/);
  assert.doesNotMatch(result.twiml, /<Message>/);
});
