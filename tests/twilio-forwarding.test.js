'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');

const {
  normalizeE164,
  isControlKeyword,
  smsForwardTarget,
  callForwardTarget,
  inboundSmsTwiml,
  inboundCallTwiml,
  MAX_FORWARD_BODY,
} = require('../netlify/lib/twilio-forwarding');
const { webhookPolicy, webhookUrlForKind } = require('../netlify/lib/twilio-runtime-policy');
const { providerWritePlan, VOICE_URL } = require('../scripts/twilio-netlify-activate');

// Fictional 201-555-02xx fixtures — must not match Netlify env secrets (TWILIO_FORWARD_*).
const PERSONAL = '+12015550201';
const BUSINESS = '+12015550202';
const CUSTOMER = '+12015550203';

describe('twilio-forwarding targets', () => {
  it('validates and resolves E.164 destinations with a shared fallback', () => {
    assert.equal(normalizeE164('+12015550201'), '+12015550201');
    assert.equal(normalizeE164('2015550201'), '');
    assert.equal(normalizeE164('+1 201 555 0201'), '');
    assert.equal(smsForwardTarget({ TWILIO_FORWARD_SMS_TO: PERSONAL }), PERSONAL);
    assert.equal(callForwardTarget({ TWILIO_FORWARD_CALLS_TO: PERSONAL }), PERSONAL);
    assert.equal(smsForwardTarget({ TWILIO_PERSONAL_NUMBER: PERSONAL }), PERSONAL);
    assert.equal(callForwardTarget({ TWILIO_PERSONAL_NUMBER: PERSONAL }), PERSONAL);
    assert.equal(smsForwardTarget({ TWILIO_FORWARD_SMS_TO: 'not-a-number' }), '');
    assert.equal(smsForwardTarget({}), '');
  });

  it('treats opt-out keywords as control, not relayable content', () => {
    for (const word of ['STOP', 'stop', ' Help ', 'UNSUBSCRIBE', 'start']) {
      assert.equal(isControlKeyword(word), true, word);
    }
    assert.equal(isControlKeyword('I need a detail quote'), false);
  });
});

describe('inbound SMS relay TwiML', () => {
  it('returns empty TwiML when no destination is configured', () => {
    const relay = inboundSmsTwiml({ From: CUSTOMER, Body: 'hello' }, {});
    assert.equal(relay.forwarded, false);
    assert.match(relay.body, /<Response><\/Response>/);
  });

  it('never relays control keywords even when configured', () => {
    const env = { TWILIO_FORWARD_SMS_TO: PERSONAL };
    const relay = inboundSmsTwiml({ From: CUSTOMER, Body: 'STOP' }, env);
    assert.equal(relay.forwarded, false);
    assert.equal(relay.reason, 'control_keyword');
    assert.match(relay.body, /<Response><\/Response>/);
  });

  it('relays a customer message to the personal number with sender attribution', () => {
    const env = { TWILIO_FORWARD_SMS_TO: PERSONAL };
    const relay = inboundSmsTwiml({ From: CUSTOMER, Body: 'Can you detail my truck Saturday?' }, env);
    assert.equal(relay.forwarded, true);
    assert.equal(relay.target, PERSONAL);
    assert.match(relay.body, new RegExp(`<Message to="\\${PERSONAL}">`));
    assert.match(relay.body, /Cardetail1 fwd from \+12015550203: Can you detail my truck Saturday\?/);
  });

  it('escapes XML metacharacters in the forwarded body', () => {
    const env = { TWILIO_PERSONAL_NUMBER: PERSONAL };
    const relay = inboundSmsTwiml({ From: CUSTOMER, Body: '<Hangup/> & "drop" \'tables\'' }, env);
    assert.equal(relay.forwarded, true);
    assert.doesNotMatch(relay.body.replace(/<Message[^>]*>|<\/Message>|<Response>|<\/Response>|<\?xml[^>]*\?>/g, ''), /<Hangup\/>/);
    assert.match(relay.body, /&lt;Hangup\/&gt; &amp; &quot;drop&quot; &apos;tables&apos;/);
  });

  it('caps very long inbound bodies before relaying', () => {
    const env = { TWILIO_PERSONAL_NUMBER: PERSONAL };
    const huge = 'x'.repeat(MAX_FORWARD_BODY + 500);
    const relay = inboundSmsTwiml({ From: CUSTOMER, Body: huge }, env);
    assert.equal(relay.forwarded, true);
    // Count only the relayed content run (the "<?xml" declaration also has an x).
    const run = (relay.body.match(/x+/g) || []).sort((a, b) => b.length - a.length)[0] || '';
    assert.ok(run.length <= MAX_FORWARD_BODY, `expected <= ${MAX_FORWARD_BODY}, got ${run.length}`);
    assert.equal(run.length, MAX_FORWARD_BODY);
    assert.match(relay.body, /…/);
  });
});

describe('inbound call bridge TwiML', () => {
  it('plays an unavailable message when no destination is configured', () => {
    const relay = inboundCallTwiml({ From: CUSTOMER, To: BUSINESS }, {});
    assert.equal(relay.forwarded, false);
    assert.match(relay.body, /<Say[^>]*>.*Cardetail1.*<\/Say>/);
    assert.match(relay.body, /<Hangup\/>/);
  });

  it('dials the personal number using the business line as caller ID', () => {
    const env = { TWILIO_FORWARD_CALLS_TO: PERSONAL };
    const relay = inboundCallTwiml({ From: CUSTOMER, To: BUSINESS }, env);
    assert.equal(relay.forwarded, true);
    assert.equal(relay.target, PERSONAL);
    assert.equal(relay.callerId, BUSINESS);
    assert.match(relay.body, new RegExp(`callerId="\\${BUSINESS}"`));
    assert.match(relay.body, new RegExp(`<Number>\\${PERSONAL}</Number>`));
    assert.match(relay.body, /answerOnBridge="true"/);
  });

  it('fails closed (no dial) when the business caller ID is not valid E.164', () => {
    const env = { TWILIO_PERSONAL_NUMBER: PERSONAL };
    const relay = inboundCallTwiml({ From: CUSTOMER, To: 'sip:foo@bar' }, env);
    assert.equal(relay.forwarded, false);
    assert.equal(relay.reason, 'no_business_caller_id');
    assert.doesNotMatch(relay.body, /<Dial/);
    assert.match(relay.body, /<Hangup\/>/);
    // Never use the personal number as caller ID.
    assert.doesNotMatch(relay.body, new RegExp(`callerId="\\${PERSONAL}"`));
  });
});

describe('adversarial: relay-loop protection', () => {
  it('does not relay an SMS whose sender is the forwarding destination', () => {
    const env = { TWILIO_FORWARD_SMS_TO: PERSONAL };
    const relay = inboundSmsTwiml({ From: PERSONAL, To: BUSINESS, Body: 'owner replying' }, env);
    assert.equal(relay.forwarded, false);
    assert.equal(relay.reason, 'loop_guard');
    assert.match(relay.body, /<Response><\/Response>/);
  });

  it('does not dial when the caller is the forwarding destination', () => {
    const env = { TWILIO_FORWARD_CALLS_TO: PERSONAL };
    const relay = inboundCallTwiml({ From: PERSONAL, To: BUSINESS }, env);
    assert.equal(relay.forwarded, false);
    assert.equal(relay.reason, 'loop_guard');
    assert.doesNotMatch(relay.body, /<Dial/);
  });
});

describe('adversarial: booking access-token containment', () => {
  it('redacts appointment-access tokens and access URLs before relaying', () => {
    const env = { TWILIO_FORWARD_SMS_TO: PERSONAL };
    const body = 'my link https://cardetail1.com/a?t=aat_SUPERSECRETTOKEN123 and token aat_ANOTHERONE456';
    const relay = inboundSmsTwiml({ From: CUSTOMER, To: BUSINESS, Body: body }, env);
    assert.equal(relay.forwarded, true);
    assert.doesNotMatch(relay.body, /aat_SUPERSECRETTOKEN123/);
    assert.doesNotMatch(relay.body, /aat_ANOTHERONE456/);
    assert.match(relay.body, /\[redacted-token\]/);
    assert.match(relay.body, /t=\[redacted\]/);
  });
});

describe('adversarial: destination cannot be injected from request params', () => {
  it('ignores attacker-controlled destination fields and uses only env', () => {
    const attacker = '+19995550000';
    // No env target configured; attacker tries to smuggle a destination.
    const relay = inboundSmsTwiml(
      { From: CUSTOMER, To: BUSINESS, Body: 'hi', ForwardTo: attacker, to: attacker },
      {},
    );
    assert.equal(relay.forwarded, false);
    assert.doesNotMatch(relay.body, new RegExp(attacker.replace('+', '\\+')));
    // With env configured, the destination is the env value, not the request.
    const relay2 = inboundSmsTwiml(
      { From: CUSTOMER, To: BUSINESS, Body: 'hi', ForwardTo: attacker },
      { TWILIO_FORWARD_SMS_TO: PERSONAL },
    );
    assert.equal(relay2.target, PERSONAL);
    assert.doesNotMatch(relay2.body, new RegExp(attacker.replace('+', '\\+')));
  });
});

describe('voice webhook policy', () => {
  const PROD = {
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
    TWILIO_AUTH_TOKEN: 'auth-token-value',
  };

  it('resolves the voice webhook URL per kind', () => {
    const env = {
      TWILIO_INBOUND_WEBHOOK_URL: 'https://cardetail1.com/.netlify/functions/twilio-inbound',
      TWILIO_STATUS_CALLBACK_URL: 'https://cardetail1.com/.netlify/functions/twilio-status-callback',
      TWILIO_VOICE_WEBHOOK_URL: VOICE_URL,
    };
    assert.equal(webhookUrlForKind('voice', env), env.TWILIO_VOICE_WEBHOOK_URL);
    assert.equal(webhookUrlForKind('inbound', env), env.TWILIO_INBOUND_WEBHOOK_URL);
    assert.equal(webhookUrlForKind('status', env), env.TWILIO_STATUS_CALLBACK_URL);
  });

  it('accepts a valid voice URL and fails closed when it is missing', () => {
    const ok = webhookPolicy('voice', {
      ...PROD,
      TWILIO_VOICE_WEBHOOK_URL: VOICE_URL,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.url, VOICE_URL);
    const missing = webhookPolicy('voice', { ...PROD });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'webhook_url_invalid');
  });
});

describe('inbound + voice handlers end-to-end (signed)', () => {
  const authToken = 'e2e-auth-token-for-signatures';
  const inboundUrl = 'https://cardetail1.com/.netlify/functions/twilio-inbound';
  const voiceUrl = VOICE_URL;

  function withEnv(extra, fn) {
    const base = {
      CONTEXT: 'production',
      BRANCH: 'master',
      URL: 'https://cardetail1.com',
      TWILIO_AUTH_TOKEN: authToken,
      TWILIO_INBOUND_WEBHOOK_URL: inboundUrl,
      TWILIO_VOICE_WEBHOOK_URL: voiceUrl,
      ...extra,
    };
    const prior = {};
    for (const [k, v] of Object.entries(base)) {
      prior[k] = process.env[k];
      process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
      for (const k of Object.keys(base)) {
        if (prior[k] == null) delete process.env[k];
        else process.env[k] = prior[k];
      }
    });
  }

  function signed(url, params) {
    const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
    return {
      httpMethod: 'POST',
      headers: { 'x-twilio-signature': signature },
      body: new URLSearchParams(params).toString(),
    };
  }

  it('inbound handler relays a normal customer SMS to the personal number', async () => {
    await withEnv({ TWILIO_FORWARD_SMS_TO: PERSONAL }, async () => {
      const inbound = require('../netlify/functions/twilio-inbound');
      const params = { From: CUSTOMER, To: BUSINESS, Body: 'Need a quote please' };
      const res = await inbound.handler(signed(inboundUrl, params));
      assert.equal(res.statusCode, 200);
      assert.match(res.body, new RegExp(`<Message to="\\${PERSONAL}">`));
      assert.match(res.body, /Need a quote please/);
    });
  });

  it('inbound handler keeps HELP as empty TwiML (no relay)', async () => {
    await withEnv({ TWILIO_FORWARD_SMS_TO: PERSONAL }, async () => {
      const inbound = require('../netlify/functions/twilio-inbound');
      const params = { From: CUSTOMER, To: BUSINESS, Body: 'HELP', OptOutType: 'HELP' };
      const res = await inbound.handler(signed(inboundUrl, params));
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /<Response><\/Response>/);
    });
  });

  it('inbound handler rejects an invalid signature', async () => {
    await withEnv({ TWILIO_FORWARD_SMS_TO: PERSONAL }, async () => {
      const inbound = require('../netlify/functions/twilio-inbound');
      const res = await inbound.handler({
        httpMethod: 'POST',
        headers: { 'x-twilio-signature': 'nope' },
        body: new URLSearchParams({ From: CUSTOMER, Body: 'x' }).toString(),
      });
      assert.equal(res.statusCode, 403);
    });
  });

  it('voice handler bridges an inbound call to the personal number', async () => {
    await withEnv({ TWILIO_FORWARD_CALLS_TO: PERSONAL }, async () => {
      const voice = require('../netlify/functions/twilio-voice');
      const params = { From: CUSTOMER, To: BUSINESS, CallSid: 'CA00000000000000000000000000000001' };
      const res = await voice.handler(signed(voiceUrl, params));
      assert.equal(res.statusCode, 200);
      assert.match(res.body, new RegExp(`<Number>\\${PERSONAL}</Number>`));
      assert.match(res.body, new RegExp(`callerId="\\${BUSINESS}"`));
    });
  });

  it('voice handler returns 405 for non-POST and 403 for bad signatures', async () => {
    await withEnv({ TWILIO_FORWARD_CALLS_TO: PERSONAL }, async () => {
      const voice = require('../netlify/functions/twilio-voice');
      assert.equal((await voice.handler({ httpMethod: 'GET' })).statusCode, 405);
      const bad = await voice.handler({
        httpMethod: 'POST',
        headers: { 'x-twilio-signature': 'bad' },
        body: new URLSearchParams({ From: CUSTOMER, To: BUSINESS }).toString(),
      });
      assert.equal(bad.statusCode, 403);
    });
  });
});

describe('adversarial: Production-only containment (preview cannot forward)', () => {
  const authToken = 'e2e-auth-token-for-signatures';
  const inboundUrl = 'https://cardetail1.com/.netlify/functions/twilio-inbound';
  const voiceUrl = VOICE_URL;

  function run(extra, fn) {
    const base = {
      TWILIO_AUTH_TOKEN: authToken,
      TWILIO_INBOUND_WEBHOOK_URL: inboundUrl,
      TWILIO_VOICE_WEBHOOK_URL: voiceUrl,
      TWILIO_FORWARD_SMS_TO: PERSONAL,
      TWILIO_FORWARD_CALLS_TO: PERSONAL,
      ...extra,
    };
    const prior = {};
    for (const [k, v] of Object.entries(base)) { prior[k] = process.env[k]; process.env[k] = v; }
    // Ensure any ambient production identity does not leak in.
    for (const k of ['CONTEXT', 'BRANCH', 'URL', 'DEPLOY_CONTEXT', 'HEAD', 'PUBLIC_SITE_URL']) {
      if (!(k in base)) { prior[k] = process.env[k]; delete process.env[k]; }
    }
    return Promise.resolve(fn()).finally(() => {
      for (const k of Object.keys(prior)) {
        if (prior[k] == null) delete process.env[k];
        else process.env[k] = prior[k];
      }
    });
  }

  function signed(url, params) {
    const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
    return { httpMethod: 'POST', headers: { 'x-twilio-signature': signature }, body: new URLSearchParams(params).toString() };
  }

  it('a validly-signed inbound SMS in a deploy-preview context is rejected 503', async () => {
    await run({ CONTEXT: 'deploy-preview', BRANCH: 'cursor/twilio-sms-call-forwarding-f5c4', URL: 'https://cardetail1.com' }, async () => {
      const inbound = require('../netlify/functions/twilio-inbound');
      const res = await inbound.handler(signed(inboundUrl, { From: CUSTOMER, To: BUSINESS, Body: 'forward me' }));
      assert.equal(res.statusCode, 503);
      assert.equal(res.body, '');
    });
  });

  it('a validly-signed inbound call on a non-master branch is rejected 503', async () => {
    await run({ CONTEXT: 'production', BRANCH: 'feature/x', URL: 'https://cardetail1.com' }, async () => {
      const voice = require('../netlify/functions/twilio-voice');
      const res = await voice.handler(signed(voiceUrl, { From: CUSTOMER, To: BUSINESS }));
      assert.equal(res.statusCode, 503);
    });
  });
});

describe('activation write plan pins voice webhook + forward targets', () => {
  const base = {
    TWILIO_ACCOUNT_SID: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_API_KEY: 'SKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_API_SECRET: 'super-secret',
    TWILIO_MESSAGING_SERVICE_SID: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_AUTH_TOKEN: 'auth-token-value',
    TWILIO_WORKER_SECRET: 'w'.repeat(32),
  };

  it('always pins the voice webhook URL and includes valid forward targets', () => {
    const plan = providerWritePlan({
      ...base,
      TWILIO_FORWARD_SMS_TO: PERSONAL,
      TWILIO_FORWARD_CALLS_TO: PERSONAL,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.vars.TWILIO_VOICE_WEBHOOK_URL, VOICE_URL);
    assert.equal(plan.vars.TWILIO_FORWARD_SMS_TO, PERSONAL);
    assert.equal(plan.vars.TWILIO_FORWARD_CALLS_TO, PERSONAL);
    // Send switches remain off — forwarding must not enable outbound sends.
    assert.equal(plan.vars.TWILIO_PRODUCTION_SENDS_ENABLED, 'false');
    assert.equal(plan.vars.TWILIO_ENABLED, 'false');
  });

  it('omits unset forward targets and rejects an invalid one', () => {
    const plan = providerWritePlan(base);
    assert.equal(plan.ok, true);
    assert.equal(plan.vars.TWILIO_FORWARD_SMS_TO, undefined);
    assert.equal(plan.vars.TWILIO_VOICE_WEBHOOK_URL, VOICE_URL);
    const bad = providerWritePlan({ ...base, TWILIO_FORWARD_CALLS_TO: '5551234' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'forward_number_invalid');
  });
});
