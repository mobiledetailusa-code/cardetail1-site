'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isIsoNextRun,
  handler,
  __test,
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

test('a forged scheduler header does not authenticate and does not send outside production', async () => {
  const runs = [];
  __test.setProcessOverride(async () => {
    runs.push('run');
    return { ok: true, processed: 1 };
  });
  const forged = await handler({
    httpMethod: 'POST',
    headers: {
      'x-nf-event': 'schedule',
      'x-netlify-event': 'schedule',
      'user-agent': 'Netlify Clockwork',
      host: 'evil.example',
    },
    body: JSON.stringify({ next_run: NEXT_RUN }),
  });
  assert.equal(forged.statusCode, 200);
  assert.equal(JSON.parse(forged.body).disabled, true);
  assert.equal(JSON.parse(forged.body).processed, 0);
  assert.equal(runs.length, 0);
  __test.setProcessOverride(null);
});

test('an invalid next_run is rejected before the processor', async () => {
  const runs = [];
  __test.setProcessOverride(async () => {
    runs.push('run');
    return { ok: true, processed: 1 };
  });
  const result = await handler({
    httpMethod: 'POST',
    headers: { 'x-nf-event': 'schedule', 'user-agent': 'Netlify Clockwork' },
    body: JSON.stringify({ next_run: 'not-a-date' }),
  });
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).processed, 0);
  assert.equal(runs.length, 0);
  __test.setProcessOverride(null);
});

test('body-only next_run is a format check and still does not send outside production', async () => {
  const result = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ next_run: NEXT_RUN }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).disabled, true);
  assert.equal(JSON.parse(result.body).processed, 0);
});
