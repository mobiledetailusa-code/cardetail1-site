'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRODUCTION_SITE_ID,
  INBOUND_URL,
  STATUS_URL,
  publicCopyBlocksCustomerSms,
  netlifyProductionOnlyPayload,
  assertNoProductionSends,
  providerWritePlan,
  parseArgs,
} = require('../scripts/twilio-netlify-activate');

test('default argv is inspect-only and never opts into production sends', () => {
  const args = parseArgs(['node', 'scripts/twilio-netlify-activate.js']);
  assert.equal(args.configureTwilio, false);
  assert.equal(args.writeNetlify, false);
  assert.equal(args.enableCustomerSms, false);
  assert.equal(args.enableProductionSends, false);
});

test('--enable-production-sends is parsed so the CLI can refuse it', () => {
  const args = parseArgs(['node', 'x', '--enable-production-sends']);
  assert.equal(args.enableProductionSends, true);
});

test('unconditional Production copy still blocks customer SMS enable', () => {
  assert.equal(publicCopyBlocksCustomerSms('We text you once the route is confirmed.'), true);
  assert.equal(publicCopyBlocksCustomerSms("we'll text you to confirm"), true);
  assert.equal(publicCopyBlocksCustomerSms('Appointment updates by text — no app required'), true);
});

test('opt-in qualified copy does not block', () => {
  assert.equal(
    publicCopyBlocksCustomerSms('We will contact you. If you opted in for SMS, updates may be sent by text. Reply STOP to opt out.'),
    false,
  );
});

test('Netlify payload is production-context only', () => {
  const payload = netlifyProductionOnlyPayload('TWILIO_AUTH_TOKEN', 'secret');
  assert.deepEqual(payload.values, [{ context: 'production', value: 'secret' }]);
  assert.equal(payload.values.some((v) => v.context === 'all'), false);
});

test('legacy From number and send switches cannot enter the write plan', () => {
  assert.equal(assertNoProductionSends({ TWILIO_FROM: '+15551212' }).ok, false);
  assert.equal(assertNoProductionSends({ TWILIO_PRODUCTION_SENDS_ENABLED: 'true' }).ok, false);
  assert.equal(assertNoProductionSends({ TWILIO_OUTBOX_ENABLED: 'true' }).ok, false);
});

test('provider write plan forces send switches off and pins Production webhook URLs', () => {
  const plan = providerWritePlan({
    TWILIO_ACCOUNT_SID: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_API_KEY: 'SKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_API_SECRET: 'super-secret',
    TWILIO_MESSAGING_SERVICE_SID: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_AUTH_TOKEN: 'auth-token-value',
    TWILIO_WORKER_SECRET: 'w'.repeat(32),
    TWILIO_PRODUCTION_SENDS_ENABLED: 'false',
    CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'true',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.vars.TWILIO_OUTBOX_ENABLED, 'false');
  assert.equal(plan.vars.TWILIO_ENABLED, 'false');
  assert.equal(plan.vars.TWILIO_PRODUCTION_SENDS_ENABLED, 'false');
  assert.equal(plan.vars.CUSTOMER_TRANSACTIONAL_SMS_ENABLED, 'false');
  assert.equal(plan.vars.TWILIO_INBOUND_WEBHOOK_URL, INBOUND_URL);
  assert.equal(plan.vars.TWILIO_STATUS_CALLBACK_URL, STATUS_URL);
  assert.equal(plan.vars.TWILIO_FROM, undefined);
  assert.equal(PRODUCTION_SITE_ID.startsWith('d7e5'), true);
});

test('provider write plan can enable customer SMS flag without enabling sends', () => {
  const plan = providerWritePlan({
    TWILIO_ACCOUNT_SID: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_API_KEY: 'SKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_API_SECRET: 'super-secret',
    TWILIO_MESSAGING_SERVICE_SID: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    TWILIO_AUTH_TOKEN: 'auth-token-value',
    TWILIO_WORKER_SECRET: 'w'.repeat(32),
  }, { enableCustomerSms: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.vars.CUSTOMER_TRANSACTIONAL_SMS_ENABLED, 'true');
  assert.equal(plan.vars.TWILIO_PRODUCTION_SENDS_ENABLED, 'false');
});
