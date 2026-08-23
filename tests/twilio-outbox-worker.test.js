'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isScheduledInvocation,
  isIsoNextRun,
  secretMatches,
  handler,
} = require('../netlify/functions/twilio-outbox-worker');

const NEXT_RUN = '2026-08-23T18:12:00.000Z';
const SWITCH_KEYS = [
  'TWILIO_OUTBOX_ENABLED',
  'TWILIO_ENABLED',
  'TWILIO_PRODUCTION_SENDS_ENABLED',
  'TWILIO_WORKER_SECRET',
  'CONTEXT',
  'BRANCH',
  'URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_STATUS_CALLBACK_URL',
];
const priorEnv = {};

test.before(() => {
  for (const key of SWITCH_KEYS) priorEnv[key] = process.env[key];
});

test.after(() => {
  for (const key of SWITCH_KEYS) {
    if (priorEnv[key] == null) delete process.env[key];
    else process.env[key] = priorEnv[key];
  }
});

test.beforeEach(() => {
  for (const key of SWITCH_KEYS) delete process.env[key];
});

test('ISO next_run matches Netlify scheduled-function timestamps', () => {
  assert.equal(isIsoNextRun(NEXT_RUN), true);
  assert.equal(isIsoNextRun('2026-08-23T18:12:00Z'), true);
  assert.equal(isIsoNextRun('schedule'), false);
  assert.equal(isIsoNextRun(''), false);
});

test('recognizes next_run on the event and on the documented JSON body', () => {
  assert.equal(isScheduledInvocation({ next_run: NEXT_RUN }), true);
  assert.equal(isScheduledInvocation({ body: JSON.stringify({ next_run: NEXT_RUN }) }), true);
  assert.equal(isScheduledInvocation({
    isBase64Encoded: true,
    body: Buffer.from(JSON.stringify({ next_run: NEXT_RUN }), 'utf8').toString('base64'),
  }), true);
  assert.equal(isScheduledInvocation({
    httpMethod: 'POST',
    headers: { 'x-netlify-event': 'schedule' },
  }), false);
  assert.equal(isScheduledInvocation({ body: JSON.stringify({ next_run: 'not-a-date' }) }), false);
});

test('forged scheduler header without next_run is unauthorized', async () => {
  process.env.TWILIO_OUTBOX_ENABLED = 'true';
  process.env.TWILIO_ENABLED = 'true';
  process.env.TWILIO_PRODUCTION_SENDS_ENABLED = 'true';
  process.env.TWILIO_WORKER_SECRET = 'worker-secret-test-only';
  process.env.CONTEXT = 'production';
  process.env.BRANCH = 'master';
  process.env.URL = 'https://cardetail1.com';
  process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
  process.env.TWILIO_API_KEY = 'SK00000000000000000000000000000000';
  process.env.TWILIO_API_SECRET = 'test-only-secret';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG00000000000000000000000000000000';
  process.env.TWILIO_STATUS_CALLBACK_URL = 'https://cardetail1.com/.netlify/functions/twilio-status-callback';

  const forged = await handler({
    httpMethod: 'POST',
    headers: { 'x-netlify-event': 'schedule' },
  });
  assert.equal(forged.statusCode, 401);
  assert.equal(secretMatches('worker-secret-test-only', 'wrong-secret'), false);
});

test('body next_run is treated as a scheduled invocation, not 401', async () => {
  const result = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ next_run: NEXT_RUN }),
  });
  assert.equal(result.statusCode, 200);
  const payload = JSON.parse(result.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.disabled, true);
  assert.equal(payload.processed, 0);
});
