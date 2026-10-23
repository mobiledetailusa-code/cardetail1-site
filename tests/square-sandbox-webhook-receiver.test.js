'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DisabledPaymentProvider,
  activePaymentProviderId,
  getActivePaymentProvider,
} = require('../netlify/lib/payment-provider-adapter');
const { customerPaymentsPolicy } = require('../netlify/lib/stripe-customer-payments');
const { legacyStripeRefundsEnabled } = require('../netlify/lib/stripe-legacy-refunds');
const { PRODUCTION_SITE_ID, STAGING_SITE_ID } = require('../sandbox/square-webhook/lib/square-sandbox-webhook-gate');
const { INSERT_EVENT_SQL } = require('../sandbox/square-webhook/lib/square-sandbox-webhook-store');
const { __test } = require('../sandbox/square-webhook/netlify/functions/square-sandbox-webhook');

const ROOT = path.join(__dirname, '..');
const URL = 'https://cardetail1-square-sandbox.netlify.app/.netlify/functions/square-sandbox-webhook';
const KEY = 'sandbox-webhook-test-key';
const MERCHANT = 'MERCHANT_SANDBOX';
const SITE = '11111111-2222-4333-8444-555555555555';
const DB = 'postgres://sandbox_webhook@127.0.0.1:5432/square_sandbox_webhook';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function sign(body, url = URL, key = KEY) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.from(url), raw])).digest('base64');
}

function baseEnv(extra = {}) {
  return {
    SITE_ID: SITE,
    SQUARE_SANDBOX_ALLOWED_SITE_ID: SITE,
    SQUARE_SANDBOX_WEBHOOK_CONFIRMATION: 'square-sandbox',
    SQUARE_SANDBOX_MERCHANT_ID: MERCHANT,
    SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL: URL,
    SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: KEY,
    SQUARE_SANDBOX_WEBHOOK_DATABASE_URL: DB,
    ...extra,
  };
}

function paymentBody(overrides = {}) {
  const paymentId = overrides.paymentId || 'pay-1';
  const payload = {
    merchant_id: Object.prototype.hasOwnProperty.call(overrides, 'merchantId') ? overrides.merchantId : MERCHANT,
    type: overrides.type || 'payment.updated',
    created_at: overrides.createdAt || '2026-01-02T00:00:00.000Z',
    data: {
      type: 'payment',
      id: paymentId,
      object: {
        payment: {
          id: paymentId,
          status: overrides.status || 'COMPLETED',
          amount_money: { amount: 100, currency: 'USD' },
          card_details: { card: { fingerprint: 'fp-secret-must-not-leak' } },
        },
      },
    },
  };
  if (Object.prototype.hasOwnProperty.call(overrides, 'eventId') ? overrides.eventId !== undefined : true) {
    payload.event_id = Object.prototype.hasOwnProperty.call(overrides, 'eventId') ? overrides.eventId : 'evt-1';
  }
  return JSON.stringify(payload);
}

function memoryDb() {
  const rows = new Map();
  let tail = Promise.resolve();
  return {
    rows,
    query(_sql, params) {
      const run = tail.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        const eventId = params[0];
        if (rows.has(eventId)) return { rowCount: 0, rows: [] };
        rows.set(eventId, params.slice());
        return { rowCount: 1, rows: [{ event_id: eventId }] };
      });
      tail = run.then(() => {}, () => {});
      return run;
    },
  };
}

function eventFor(body, extra = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = {
    'x-square-hmacsha256-signature': extra.signature === undefined ? sign(raw, extra.url, extra.key) : extra.signature,
    ...extra.headers,
  };
  return {
    httpMethod: extra.method || 'POST',
    headers,
    body: extra.isBase64Encoded ? raw.toString('base64') : raw.toString('utf8'),
    isBase64Encoded: extra.isBase64Encoded === true,
  };
}

async function post(body, extra = {}) {
  const db = extra.db || memoryDb();
  const response = await __test.handleSquareSandboxWebhook(eventFor(body, extra), {
    env: extra.env || baseEnv(extra.envExtra),
    query: extra.query === undefined ? db.query.bind(db) : extra.query,
    connectImpl: extra.connectImpl,
  });
  return { response, db, body: JSON.parse(response.body) };
}

test('a valid signature is stored once and does not confirm a commercial payment', async () => {
  const { response, db, body } = await post(paymentBody());
  assert.equal(response.statusCode, 200);
  assert.equal(body.result, 'stored');
  assert.equal(body.duplicate, false);
  assert.equal(body.paymentConfirmed, false);
  assert.equal(body.financialEffect, 'none');
  assert.equal(db.rows.size, 1);
  assert.equal(db.rows.get('evt-1')[4], 'COMPLETED');
  assert.equal(JSON.stringify(body).includes(KEY), false);
  assert.equal(JSON.stringify(body).includes('fp-secret-must-not-leak'), false);
});

test('an invalid signature, a missing signature, a changed body, and a changed URL do not write', async () => {
  const db = memoryDb();
  const invalid = await post(paymentBody(), { db, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  const missing = await post(paymentBody(), { db, signature: '' });
  const changedBody = await post(paymentBody({ eventId: 'evt-body' }), {
    db,
    signature: sign(paymentBody({ eventId: 'evt-other' })),
  });
  const changedUrl = await post(paymentBody({ eventId: 'evt-url' }), {
    db,
    url: 'https://cardetail1-square-sandbox.netlify.app/other',
    env: baseEnv(),
  });
  assert.equal(invalid.response.statusCode, 403);
  assert.equal(missing.response.statusCode, 403);
  assert.equal(missing.body.error, 'square_webhook_signature_missing');
  assert.equal(changedBody.response.statusCode, 403);
  assert.equal(changedUrl.response.statusCode, 403);
  assert.equal(db.rows.size, 0);
});

test('the correct merchant is stored and a different merchant is rejected without a new charge', async () => {
  const db = memoryDb();
  const ok = await post(paymentBody({ eventId: 'evt-merchant-ok' }), { db });
  const wrong = await post(paymentBody({ eventId: 'evt-merchant-no', merchantId: 'MERCHANT_OTHER' }), { db });
  assert.equal(ok.body.result, 'stored');
  assert.equal(wrong.response.statusCode, 200);
  assert.equal(wrong.body.result, 'rejected_merchant');
  assert.equal(wrong.body.paymentConfirmed, false);
  assert.equal(db.rows.get('evt-merchant-no')[7], 'rejected_merchant');
});

test('a signed event without event_id is refused and no identifier is invented', async () => {
  const db = memoryDb();
  const { response, body } = await post(paymentBody({ eventId: undefined }), { db });
  assert.equal(response.statusCode, 400);
  assert.equal(body.error, 'square_sandbox_webhook_event_id_missing');
  assert.equal(db.rows.size, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'eventId'), false);
});

test('payment.created, payment.updated, COMPLETED, and PENDING stay representations', async () => {
  const db = memoryDb();
  const created = await post(paymentBody({
    type: 'payment.created',
    eventId: 'evt-created',
    status: 'APPROVED',
    createdAt: '2026-01-01T00:00:00.000Z',
  }), { db });
  const pending = await post(paymentBody({
    type: 'payment.updated',
    eventId: 'evt-pending',
    status: 'PENDING',
    createdAt: '2026-01-03T00:00:00.000Z',
  }), { db });
  const completed = await post(paymentBody({
    type: 'payment.updated',
    eventId: 'evt-completed',
    status: 'COMPLETED',
    createdAt: '2026-01-02T00:00:00.000Z',
  }), { db });
  assert.equal(created.body.result, 'stored');
  assert.equal(created.body.paymentConfirmed, false);
  assert.equal(db.rows.get('evt-created')[2], 'payment.created');
  assert.equal(pending.body.result, 'stored');
  assert.equal(db.rows.get('evt-pending')[4], 'PENDING');
  assert.equal(completed.body.result, 'stored');
  assert.equal(db.rows.get('evt-completed')[4], 'COMPLETED');
  assert.equal(db.rows.get('evt-completed')[3], 'pay-1');
  assert.equal(db.rows.get('evt-pending')[3], 'pay-1');
});

test('an unsupported event is stored as unsupported', async () => {
  const body = JSON.stringify({
    merchant_id: MERCHANT,
    type: 'refund.created',
    event_id: 'evt-unknown',
    created_at: '2026-01-02T00:00:00.000Z',
  });
  const { response, db, body: json } = await post(body);
  assert.equal(response.statusCode, 200);
  assert.equal(json.result, 'unsupported');
  assert.equal(json.paymentConfirmed, false);
  assert.equal(db.rows.get('evt-unknown')[7], 'unsupported');
});

test('a duplicate event id does not change the stored row', async () => {
  const db = memoryDb();
  const first = await post(paymentBody({ status: 'COMPLETED' }), { db });
  const second = await post(paymentBody({ status: 'FAILED', eventId: 'evt-1' }), { db });
  assert.equal(first.body.result, 'stored');
  assert.equal(second.response.statusCode, 200);
  assert.equal(second.body.result, 'duplicate');
  assert.equal(second.body.duplicate, true);
  assert.equal(db.rows.size, 1);
  assert.equal(db.rows.get('evt-1')[4], 'COMPLETED');
});

test('two simultaneous inserts of the same event id leave one row', async () => {
  const db = memoryDb();
  const body = paymentBody({ eventId: 'evt-race' });
  const [left, right] = await Promise.all([
    post(body, { db }),
    post(body, { db }),
  ]);
  const results = [left.body.result, right.body.result].sort();
  assert.deepEqual(results, ['duplicate', 'stored']);
  assert.equal(db.rows.size, 1);
});

test('an older event stored after a newer one does not replace it', async () => {
  const db = memoryDb();
  const newer = await post(paymentBody({
    eventId: 'evt-new',
    status: 'COMPLETED',
    createdAt: '2026-01-03T00:00:00.000Z',
  }), { db });
  const older = await post(paymentBody({
    eventId: 'evt-old',
    status: 'PENDING',
    createdAt: '2026-01-01T00:00:00.000Z',
  }), { db });
  assert.equal(newer.body.result, 'stored');
  assert.equal(older.body.result, 'stored');
  assert.equal(db.rows.size, 2);
  assert.equal(db.rows.get('evt-new')[4], 'COMPLETED');
  assert.equal(db.rows.get('evt-old')[4], 'PENDING');
  assert.match(INSERT_EVENT_SQL, /ON CONFLICT \(event_id\) DO NOTHING/);
  assert.doesNotMatch(read('sandbox/square-webhook/schema.sql'), /payment_id TEXT UNIQUE|UNIQUE \(payment_id\)/);
});

test('a database connection failure and an insert failure return 503 and do not echo the URL', async () => {
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    const connect = await post(paymentBody({ eventId: 'evt-connect' }), {
      query: null,
      connectImpl() {
        return Promise.reject(new Error('connect failed postgres://secret-db.example/commercial'));
      },
    });
    const inserted = await post(paymentBody({ eventId: 'evt-insert' }), {
      query() {
        return Promise.reject(new Error('insert failed postgres://secret-db.example/commercial'));
      },
    });
    assert.equal(connect.response.statusCode, 503);
    assert.equal(inserted.response.statusCode, 503);
    assert.equal(connect.body.error, 'square_sandbox_webhook_persistence_unavailable');
    const joined = logs.join('\n');
    assert.equal(joined.includes('secret-db'), false);
    assert.equal(joined.includes(DB), false);
    assert.equal(joined.includes(KEY), false);
  } finally {
    console.log = original;
  }
});

test('a body over 1 MiB is rejected before the signature is calculated', async () => {
  const raw = Buffer.alloc(__test.MAX_BODY_BYTES + 1, 0x61);
  const event = eventFor(raw);
  const db = memoryDb();
  const original = crypto.createHmac;
  let calls = 0;
  crypto.createHmac = function createHmacSpy(...args) {
    calls += 1;
    return original.apply(crypto, args);
  };
  try {
    const response = await __test.handleSquareSandboxWebhook(event, {
      env: baseEnv(),
      query: db.query.bind(db),
    });
    assert.equal(response.statusCode, 413);
    assert.equal(db.rows.size, 0);
    assert.equal(calls, 0);
  } finally {
    crypto.createHmac = original;
  }
});

test('base64 requests are measured after decoding', async () => {
  const raw = Buffer.alloc(800000, 0x62);
  const payload = Buffer.concat([
    Buffer.from('{"event_id":"evt-b64","type":"refund.created","merchant_id":"MERCHANT_SANDBOX","pad":"'),
    raw,
    Buffer.from('"}'),
  ]);
  assert.ok(payload.toString('base64').length > __test.MAX_BODY_BYTES);
  assert.ok(payload.length < __test.MAX_BODY_BYTES);
  const db = memoryDb();
  const { response, body } = await post(payload, { db, isBase64Encoded: true });
  assert.equal(response.statusCode, 200);
  assert.equal(body.result, 'unsupported');
  assert.equal(db.rows.size, 1);
  const tooBig = Buffer.alloc(__test.MAX_BODY_BYTES + 1, 0x63);
  const blocked = await post(tooBig, { db, isBase64Encoded: true });
  assert.equal(blocked.response.statusCode, 413);
  assert.equal(db.rows.size, 1);
});

test('a client host header does not choose the signed URL', async () => {
  const { response, body } = await post(paymentBody({ eventId: 'evt-host' }), {
    headers: {
      host: 'cardetail1.com',
      'x-forwarded-host': 'cardetail1.com',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(body.result, 'stored');
  const wrongHost = await post(paymentBody({ eventId: 'evt-host-bad' }), {
    url: 'https://cardetail1.com/.netlify/functions/square-sandbox-webhook',
    env: baseEnv({
      SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL: 'https://cardetail1.com/.netlify/functions/square-sandbox-webhook',
    }),
    headers: { host: 'cardetail1.com' },
  });
  assert.equal(wrongHost.response.statusCode, 503);
});

test('production, staging, a missing sandbox site id, and a partial config stay closed', async () => {
  const db = memoryDb();
  const cases = [
    baseEnv({ SITE_ID: PRODUCTION_SITE_ID, SQUARE_SANDBOX_ALLOWED_SITE_ID: PRODUCTION_SITE_ID }),
    baseEnv({ SITE_ID: STAGING_SITE_ID, SQUARE_SANDBOX_ALLOWED_SITE_ID: STAGING_SITE_ID }),
    baseEnv({ SITE_ID: PRODUCTION_SITE_ID }),
    baseEnv({ SQUARE_SANDBOX_ALLOWED_SITE_ID: '' }),
    baseEnv({ SITE_ID: '', NETLIFY_SITE_ID: SITE }),
    baseEnv({ SQUARE_SANDBOX_WEBHOOK_CONFIRMATION: '' }),
    baseEnv({ SQUARE_SANDBOX_MERCHANT_ID: '' }),
    baseEnv({ DATABASE_URL: 'postgres://commercial@db.example/cardetail1' }),
    baseEnv({ SQUARE_SANDBOX_ACCESS_TOKEN: 'EAAA_not_a_webhook_key' }),
    baseEnv({ CONTEXT: 'production' }),
  ];
  for (const env of cases.slice(0, 9)) {
    const result = await post(paymentBody({ eventId: `evt-${cases.indexOf(env)}` }), { db, env });
    assert.equal(result.response.statusCode, 503, JSON.stringify(env.SITE_ID || env.DATABASE_URL || 'partial'));
  }
  const sandboxProductionContext = await post(paymentBody({ eventId: 'evt-context' }), { db, env: cases[9] });
  assert.equal(sandboxProductionContext.response.statusCode, 200);
  assert.equal(db.rows.has('evt-context'), true);
  assert.equal(db.rows.size, 1);
});

test('the receiver does not open Stripe, move the provider, or publish a root function', async () => {
  const previous = process.env.PAYMENT_PROVIDER;
  process.env.PAYMENT_PROVIDER = 'square';
  const previousFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = () => {
    network += 1;
    throw new Error('network is forbidden');
  };
  try {
    const { body } = await post(paymentBody({ eventId: 'evt-none' }));
    assert.equal(body.paymentConfirmed, false);
    assert.equal(network, 0);
    assert.equal(activePaymentProviderId(), 'none');
    assert.ok(getActivePaymentProvider() instanceof DisabledPaymentProvider);
  } finally {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previous;
  }
  assert.equal(legacyStripeRefundsEnabled({}), false);
  assert.equal(customerPaymentsPolicy({
    CONTEXT: 'production',
    STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED: 'true',
  }).enabled, false);
  assert.match(read('netlify/lib/deploy-runtime-env.generated.js'), /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/);
  const names = fs.readdirSync(path.join(ROOT, 'netlify/functions'));
  assert.equal(names.includes('square-sandbox-webhook.js'), false);
  assert.equal(names.some((name) => /square/i.test(name)), false);
  assert.doesNotMatch(read('netlify.toml'), /square-sandbox-webhook/);
  const sandboxToml = read('sandbox/square-webhook/netlify.toml');
  assert.match(sandboxToml, /!node_modules\/@prisma\/\*\*/);
  assert.match(sandboxToml, /!node_modules\/\.prisma\/\*\*/);
  assert.doesNotMatch(read('prisma/schema.prisma'), /square_sandbox_webhook_event/);
  const source = [
    'sandbox/square-webhook/netlify/functions/square-sandbox-webhook.js',
    'sandbox/square-webhook/lib/square-sandbox-webhook-gate.js',
    'sandbox/square-webhook/lib/square-sandbox-webhook-store.js',
  ].map(read).join('\n');
  assert.doesNotMatch(source, /JSON\.parse|createHmac|api\.stripe\.com|fetch\(|prisma/);
  assert.match(source, /verifySquareWebhookSignature/);
  assert.match(source, /interpretVerifiedSquareWebhook/);
  assert.doesNotMatch(source, /process\.env\.NETLIFY_SITE_ID|source\.NETLIFY_SITE_ID/);
  assert.match(source, /source\.SITE_ID/);
});
