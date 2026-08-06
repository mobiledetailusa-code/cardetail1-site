// Draft save token — HMAC ownership tokens for create-setup-intent.
const { test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TOKEN_PATH = require.resolve('../netlify/lib/draft-save-token');
const SETUP_PATH = require.resolve('../netlify/functions/create-setup-intent');
const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');

const TEST_SECRET = 'd'.repeat(32);
const ENV_KEYS = ['DRAFT_TOKEN_SECRET', 'ADMIN_SESSION_SECRET', 'CONTEXT', 'NETLIFY_DEV'];

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
  delete require.cache[TOKEN_PATH];
  delete require.cache[SETUP_PATH];
  delete require.cache[SUBMIT_PATH];
}

function loadTokenLib() {
  delete require.cache[TOKEN_PATH];
  return require('../netlify/lib/draft-save-token');
}

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    data,
    async get(key, { type } = {}) {
      if (!data.has(key)) return null;
      const raw = data.get(key);
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) {
      data.set(key, JSON.stringify(value));
    },
  };
}

let envSnap;

beforeEach(() => {
  envSnap = snapshotEnv();
  process.env.DRAFT_TOKEN_SECRET = TEST_SECRET;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.NETLIFY_DEV;
  process.env.CONTEXT = 'production';
});

afterEach(() => {
  restoreEnv(envSnap);
});

test('valid token verifies', () => {
  const lib = loadTokenLib();
  const now = 1_700_000_000_000;
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-ABC', phone: '(551) 313-2956', now });
  assert.equal(issued.ok, true);
  const verified = lib.verifyDraftSaveToken({
    token: issued.token,
    bookingId: 'CD1-ABC',
    phone: '5513132956',
    now,
  });
  assert.equal(verified.ok, true);
});

test('wrong bookingId fails', () => {
  const lib = loadTokenLib();
  const now = 1_700_000_000_000;
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-ABC', phone: '5513132956', now });
  const verified = lib.verifyDraftSaveToken({
    token: issued.token,
    bookingId: 'CD1-OTHER',
    phone: '5513132956',
    now,
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.error, 'invalid_draft_token');
});

test('wrong phone fails', () => {
  const lib = loadTokenLib();
  const now = 1_700_000_000_000;
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-ABC', phone: '5513132956', now });
  const verified = lib.verifyDraftSaveToken({
    token: issued.token,
    bookingId: 'CD1-ABC',
    phone: '2015551212',
    now,
  });
  assert.equal(verified.ok, false);
});

test('tampered signature fails', () => {
  const lib = loadTokenLib();
  const now = 1_700_000_000_000;
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-ABC', phone: '5513132956', now });
  const parts = issued.token.split('.');
  const tampered = `${parts[0]}.${parts[1]}.AAAA${parts[2].slice(4)}`;
  const verified = lib.verifyDraftSaveToken({
    token: tampered,
    bookingId: 'CD1-ABC',
    phone: '5513132956',
    now,
  });
  assert.equal(verified.ok, false);
});

test('expired token fails', () => {
  const lib = loadTokenLib();
  const now = 1_700_000_000_000;
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-ABC', phone: '5513132956', now });
  const verified = lib.verifyDraftSaveToken({
    token: issued.token,
    bookingId: 'CD1-ABC',
    phone: '5513132956',
    now: now + lib.TOKEN_TTL_MS + 1000,
  });
  assert.equal(verified.ok, false);
});

test('malformed token fails', () => {
  const lib = loadTokenLib();
  assert.equal(lib.verifyDraftSaveToken({ token: 'bad', bookingId: 'CD1', phone: '5513132956' }).ok, false);
  assert.equal(lib.verifyDraftSaveToken({ token: 'v1.onlysig', bookingId: 'CD1', phone: '5513132956' }).ok, false);
});

test('unsupported version fails', () => {
  const lib = loadTokenLib();
  const verified = lib.verifyDraftSaveToken({
    token: 'v2.9999999.fake',
    bookingId: 'CD1-ABC',
    phone: '5513132956',
    now: Date.now(),
  });
  assert.equal(verified.ok, false);
});

test('future expiry outside allowed TTL fails', () => {
  const lib = loadTokenLib();
  const now = 1_700_000_000_000;
  const farFuture = Math.floor((now + lib.TOKEN_TTL_MS + 120_000) / 1000);
  const payload = lib.signingPayload({ bookingId: 'CD1-ABC', phone: '5513132956', expiryUnixSeconds: farFuture });
  const sig = require('crypto').createHmac('sha256', TEST_SECRET).update(payload).digest('base64url');
  const token = `v1.${farFuture}.${sig}`;
  const verified = lib.verifyDraftSaveToken({
    token,
    bookingId: 'CD1-ABC',
    phone: '5513132956',
    now,
  });
  assert.equal(verified.ok, false);
});

test('secret missing in production fails safely', () => {
  delete process.env.DRAFT_TOKEN_SECRET;
  const lib = loadTokenLib();
  const status = lib.getDraftTokenSecretStatus();
  assert.equal(status.ok, false);
  assert.equal(status.error, 'missing_draft_token_secret');
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-ABC', phone: '5513132956' });
  assert.equal(issued.ok, false);
});

test('timing-safe comparison path is used', () => {
  const lib = loadTokenLib();
  const src = require('fs').readFileSync(TOKEN_PATH, 'utf8');
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /timingSafeString/);
});

test('token does not expose raw phone', () => {
  const lib = loadTokenLib();
  const phone = '5513132956';
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-ABC', phone, now: 1_700_000_000_000 });
  assert.doesNotMatch(issued.token, /5513132956/);
  assert.doesNotMatch(issued.token, /3132956/);
  const parts = issued.token.split('.');
  assert.equal(parts.length, 3);
  assert.match(parts[2], /^[A-Za-z0-9_-]+$/);
});

test('token TTL is approximately 2 hours', () => {
  const lib = loadTokenLib();
  assert.equal(lib.TOKEN_TTL_MS, 2 * 60 * 60 * 1000);
  const now = 1_700_000_000_000;
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-ABC', phone: '5513132956', now });
  const delta = issued.draftSaveTokenExp - Math.floor(now / 1000);
  assert.ok(delta >= 7199 && delta <= 7200);
});

test('phone signing reuses ops-db normalizePhone last 10 digits', () => {
  const lib = loadTokenLib();
  const { normalizePhone } = require('../netlify/lib/ops-db');
  assert.equal(lib.phoneSigningKey('+1 (551) 313-2956'), normalizePhone('+1 (551) 313-2956').slice(-10));
});

test('create-setup-intent without token returns 403 invalid_draft_token', async () => {
  delete require.cache[SETUP_PATH];
  const { handler, __test } = require('../netlify/functions/create-setup-intent');
  __test.setBlobsStoreOverride(() => createMemoryStore({
    'CD1-1': { id: 'CD1-1', isDraft: true, phone: '5513132956', cardOnFileRequired: true, cardOnFileStatus: 'pending' },
  }));
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.1' },
    body: JSON.stringify({ bookingId: 'CD1-1' }),
  });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'invalid_draft_token' });
});

test('create-setup-intent wrong token returns 403', async () => {
  delete require.cache[SETUP_PATH];
  const { handler, __test } = require('../netlify/functions/create-setup-intent');
  __test.setBlobsStoreOverride(() => createMemoryStore({
    'CD1-2': { id: 'CD1-2', isDraft: true, phone: '5513132956', cardOnFileRequired: true, cardOnFileStatus: 'pending' },
  }));
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.2' },
    body: JSON.stringify({ bookingId: 'CD1-2', draftSaveToken: 'v1.9999999999.badtoken' }),
  });
  assert.equal(res.statusCode, 403);
});

test('create-setup-intent expired token returns 403', async () => {
  const lib = loadTokenLib();
  const issued = lib.issueDraftSaveToken({
    bookingId: 'CD1-3',
    phone: '5513132956',
    now: Date.now() - (3 * 60 * 60 * 1000),
  });
  delete require.cache[SETUP_PATH];
  const { handler, __test } = require('../netlify/functions/create-setup-intent');
  __test.setBlobsStoreOverride(() => createMemoryStore({
    'CD1-3': { id: 'CD1-3', isDraft: true, phone: '5513132956', cardOnFileRequired: true, cardOnFileStatus: 'pending' },
  }));
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.3' },
    body: JSON.stringify({ bookingId: 'CD1-3', draftSaveToken: issued.token }),
  });
  assert.equal(res.statusCode, 403);
});

test('create-setup-intent token for another booking returns 403', async () => {
  const lib = loadTokenLib();
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-A', phone: '5513132956', now: Date.now() });
  delete require.cache[SETUP_PATH];
  const { handler, __test } = require('../netlify/functions/create-setup-intent');
  __test.setBlobsStoreOverride(() => createMemoryStore({
    'CD1-B': { id: 'CD1-B', isDraft: true, phone: '5513132956', cardOnFileRequired: true, cardOnFileStatus: 'pending' },
  }));
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.4' },
    body: JSON.stringify({ bookingId: 'CD1-B', draftSaveToken: issued.token }),
  });
  assert.equal(res.statusCode, 403);
});

test('create-setup-intent missing production secret returns 503', async () => {
  delete process.env.DRAFT_TOKEN_SECRET;
  delete require.cache[SETUP_PATH];
  const { handler } = require('../netlify/functions/create-setup-intent');
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.5' },
    body: JSON.stringify({ bookingId: 'CD1-1', draftSaveToken: 'v1.1.x' }),
  });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'missing_draft_token_secret' });
});

test('create-setup-intent preserves rate limiting hook', () => {
  const src = require('fs').readFileSync(SETUP_PATH, 'utf8');
  assert.match(src, /enforcePublicRateLimit/);
  assert.match(src, /create-setup-intent/);
});

test('create-setup-intent preserves Stripe SetupIntent parameters', () => {
  const src = require('fs').readFileSync(SETUP_PATH, 'utf8');
  assert.match(src, /usage:\s+'off_session'/);
  // Release A: card-only contract (matches my-garage-portal.test.js) — no automatic_payment_methods
  assert.match(src, /payment_method_types\[0\]/);
  assert.doesNotMatch(src, /automatic_payment_methods/);
  assert.match(src, /metadata\[bookingId\]/);
  assert.doesNotMatch(src, /\/v1\/payment_intents/);
});

test('create-setup-intent valid token + eligible draft reaches Stripe SetupIntent path', async () => {
  const lib = loadTokenLib();
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-OK', phone: '5513132956', now: Date.now() });
  const draft = {
    id: 'CD1-OK',
    isDraft: true,
    phone: '5513132956',
    cardOnFileRequired: true,
    cardOnFileStatus: 'pending',
    bookingVersion: 0,
    acceptedCardOnFilePolicy: true,
    acceptedCardOnFilePolicyAt: new Date().toISOString(),
    policyVersion: 'card-on-file-policy-v1',
    firstName: 'Test',
    email: 'test@example.com',
  };
  const store = createMemoryStore({ 'CD1-OK': draft });
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, body: opts && opts.body, headers: opts && opts.headers });
    if (String(url).includes('/v1/customers')) {
      return { ok: true, json: async () => ({ id: 'cus_test' }) };
    }
    if (String(url).includes('/v1/setup_intents')) {
      return {
        ok: true,
        json: async () => ({
          id: 'seti_test',
          customer: 'cus_test',
          client_secret: 'seti_test_secret',
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    delete require.cache[SETUP_PATH];
    const { handler, __test } = require('../netlify/functions/create-setup-intent');
    __test.setBlobsStoreOverride(() => store);
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const res = await handler({
      httpMethod: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({
        bookingId: 'CD1-OK',
        draftSaveToken: issued.token,
        expectedBookingVersion: 0,
      }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.clientSecret, 'seti_test_secret');
    const siCall = calls.find((c) => String(c.url).includes('/v1/setup_intents'));
    assert.ok(siCall);
    assert.match(String(siCall.body), /usage=off_session/);
    assert.match(String(siCall.body), /payment_method_types%5B0%5D=card/);
    assert.doesNotMatch(String(siCall.body), /automatic_payment_methods/);
    assert.match(String(siCall.body), /metadata%5BbookingId%5D=CD1-OK/);
    const customerCall = calls.find((c) => String(c.url).includes('/v1/customers'));
    assert.equal(customerCall.headers['Idempotency-Key'], 'setup_customer_CD1-OK_card-on-file-policy-v1');
    assert.equal(siCall.headers['Idempotency-Key'], 'setup_intent_CD1-OK_card-on-file-policy-v1');

    const retry = await handler({
      httpMethod: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({
        bookingId: 'CD1-OK',
        draftSaveToken: issued.token,
        expectedBookingVersion: 0,
      }),
    });
    assert.equal(retry.statusCode, 200);
    const retryBody = JSON.parse(retry.body);
    assert.equal(retryBody.reused, true);
    assert.equal(retryBody.bookingVersion, 1);
    const afterRetry = await store.get('CD1-OK', { type: 'json' });
    assert.equal(afterRetry.bookingVersion, 1, 'idempotent retry must not bump version');
    assert.equal(afterRetry.setupIntentId, 'seti_test');
  } finally {
    global.fetch = originalFetch;
  }
});

test('create-setup-intent valid token + ineligible draft returns 409 after auth', async () => {
  const lib = loadTokenLib();
  const now = Date.now();
  const issued = lib.issueDraftSaveToken({ bookingId: 'CD1-5', phone: '5513132956', now });
  delete require.cache[SETUP_PATH];
  const { handler, __test } = require('../netlify/functions/create-setup-intent');
  __test.setBlobsStoreOverride(() => createMemoryStore({
    'CD1-5': { id: 'CD1-5', isDraft: false, phone: '5513132956', cardOnFileRequired: true, cardOnFileStatus: 'saved' },
  }));
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.6' },
    body: JSON.stringify({ bookingId: 'CD1-5', draftSaveToken: issued.token, expectedBookingVersion: 0 }),
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'booking_not_eligible_for_card_save' });
});

test('stripe webhook remains unchanged by draft token work', () => {
  const webhook = require('fs').readFileSync(require.resolve('../netlify/functions/stripe-webhook.js'), 'utf8');
  assert.doesNotMatch(webhook, /draft-save-token/);
  assert.doesNotMatch(webhook, /draftSaveToken/);
});

test('SetupIntent webhook changes only saved-card state and stale failure cannot regress success', async () => {
  const WEBHOOK_PATH = require.resolve('../netlify/functions/stripe-webhook');
  delete require.cache[WEBHOOK_PATH];
  const { __test } = require('../netlify/functions/stripe-webhook');
  const store = createMemoryStore({
    'CD1-SI': {
      id: 'CD1-SI',
      bookingVersion: 1,
      isDraft: true,
      setupIntentId: 'seti_bound',
      stripeCustomerId: 'cus_bound',
      cardOnFileStatus: 'pending',
      paymentStatus: 'no_payment_required_yet',
      paymentWorkflowStatus: 'not_due',
      appointmentStatus: 'pending_review',
      serviceStatus: 'pending_review',
      ledger: { approvedCents: 12000, settledCents: 0, entries: [] },
    },
  });
  __test.setBlobsStoreOverride(() => store);
  try {
    const saved = await __test.updateSetupIntentState(
      { id: 'evt_setup_saved' },
      {
        id: 'seti_bound',
        customer: 'cus_bound',
        payment_method: 'pm_savedcard',
        metadata: { bookingId: 'CD1-SI', purpose: 'card_on_file' },
      },
      'saved'
    );
    assert.equal(saved.updated, true);
    assert.equal(saved.duplicate, false);
    const afterSaved = await store.get('CD1-SI', { type: 'json' });
    assert.equal(afterSaved.bookingVersion, 2);
    assert.equal(afterSaved.cardOnFileStatus, 'saved');
    assert.equal(afterSaved.stripePaymentMethodId, 'pm_savedcard');
    assert.equal(afterSaved.paymentStatus, 'no_payment_required_yet');
    assert.equal(afterSaved.appointmentStatus, 'pending_review');
    assert.equal(afterSaved.serviceStatus, 'pending_review');
    assert.equal(afterSaved.ledger.approvedCents, 12000);
    assert.equal(afterSaved.ledger.settledCents, 0);
    assert.deepEqual(afterSaved.ledger.entries, []);

    const staleFailure = await __test.updateSetupIntentState(
      { id: 'evt_setup_failed_late' },
      {
        id: 'seti_bound',
        customer: 'cus_bound',
        metadata: { bookingId: 'CD1-SI', purpose: 'card_on_file' },
      },
      'failed'
    );
    assert.equal(staleFailure.updated, true);
    assert.equal(staleFailure.duplicate, true);
    const afterFailure = await store.get('CD1-SI', { type: 'json' });
    assert.equal(afterFailure.bookingVersion, 2);
    assert.equal(afterFailure.cardOnFileStatus, 'saved');

    const wrongCustomer = await __test.updateSetupIntentState(
      { id: 'evt_setup_wrong_customer' },
      {
        id: 'seti_bound',
        customer: 'cus_other',
        payment_method: 'pm_othercard',
        metadata: { bookingId: 'CD1-SI', purpose: 'card_on_file' },
      },
      'saved'
    );
    assert.equal(wrongCustomer.updated, false);
    assert.equal(wrongCustomer.retryable, false);
    assert.equal(wrongCustomer.reason, 'stripe_customer_mismatch');
  } finally {
    __test.setBlobsStoreOverride(null);
    delete require.cache[WEBHOOK_PATH];
  }
});

test('submit-booking draft response includes token fields via issue helper', () => {
  delete require.cache[SUBMIT_PATH];
  const { __test } = require('../netlify/functions/submit-booking');
  const draft = __test.buildDraftRecord({
    firstName: 'A',
    phone: '5513132956',
    paymentMethodPreference: 'card_onsite',
    totalPrice: 100,
  }, 'CD1-D', new Date().toISOString());
  const issued = __test.issueDraftSaveResponse(draft);
  assert.equal(issued.ok, true);
  assert.match(issued.body.draftSaveToken, /^v1\./);
  assert.ok(issued.body.draftSaveTokenExp > 0);
  assert.equal(issued.body.isDraft, true);
  assert.equal(issued.body.draftSaveToken.includes('551'), false);
});

test('submit-booking issueDraftSaveResponse maps invalid phone inputs to invalid_phone', () => {
  delete require.cache[SUBMIT_PATH];
  const { __test } = require('../netlify/functions/submit-booking');
  const draft = __test.buildDraftRecord({
    firstName: 'A',
    phone: 'honda',
    paymentMethodPreference: 'card_onsite',
  }, 'CD1-F', new Date().toISOString());
  const issued = __test.issueDraftSaveResponse(draft);
  assert.equal(issued.ok, false);
  assert.equal(issued.status, 400);
  assert.equal(issued.body.error, 'invalid_phone');
});

test('submit-booking missing production secret blocks draft issuance', () => {
  delete process.env.DRAFT_TOKEN_SECRET;
  delete require.cache[SUBMIT_PATH];
  const { __test } = require('../netlify/functions/submit-booking');
  const draft = __test.buildDraftRecord({
    firstName: 'A',
    phone: '5513132956',
    paymentMethodPreference: 'card_onsite',
  }, 'CD1-E', new Date().toISOString());
  const issued = __test.issueDraftSaveResponse(draft);
  assert.equal(issued.ok, false);
  assert.equal(issued.body.error, 'missing_draft_token_secret');
});

test('submit-booking draft path checks secret before write', () => {
  const src = require('fs').readFileSync(SUBMIT_PATH, 'utf8');
  assert.match(src, /getDraftTokenSecretStatus/);
  assert.match(src, /missing_draft_token_secret/);
  assert.match(src, /draftSaveToken/);
  assert.match(src, /enforcePublicRateLimit/);
});

test('draft update issues a fresh valid token', () => {
  delete require.cache[SUBMIT_PATH];
  const { __test } = require('../netlify/functions/submit-booking');
  const lib = loadTokenLib();
  const draft = __test.buildDraftRecord({
    firstName: 'A',
    phone: '5513132956',
    paymentMethodPreference: 'card_onsite',
  }, 'CD1-U', new Date().toISOString());
  const first = __test.issueDraftSaveResponse(draft);
  const second = __test.issueDraftSaveResponse(draft);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.match(first.body.draftSaveToken, /^v1\.\d+\./);
  assert.match(second.body.draftSaveToken, /^v1\.\d+\./);
  assert.equal(
    lib.verifyDraftSaveToken({
      token: second.body.draftSaveToken,
      bookingId: draft.id,
      phone: draft.phone,
    }).ok,
    true
  );
});

test('finalize requires draftSaveToken and response does not re-issue it', () => {
  // Release A (PDA-14): finalize must verify scoped draftSaveToken; success body must not re-issue one.
  const src = require('fs').readFileSync(SUBMIT_PATH, 'utf8');
  const finalizeStart = src.indexOf('// ── Draft finalization');
  const newBookingStart = src.indexOf('// ── New booking');
  assert.ok(finalizeStart >= 0 && newBookingStart > finalizeStart);
  const finalizeBlock = src.slice(finalizeStart, newBookingStart);
  assert.match(finalizeBlock, /verifyDraftSaveToken/);
  assert.match(finalizeBlock, /draft_token_invalid/);
  assert.match(finalizeBlock, /draftSaveTokenRevokedAt/);
  // Success return in finalize path must not call issueDraftSaveResponse / return draftSaveToken fields
  assert.doesNotMatch(finalizeBlock, /issueDraftSaveResponse/);
  const successReturn = finalizeBlock.match(/return json\(200,\s*\{[\s\S]*?\}\);/g) || [];
  for (const ret of successReturn) {
    assert.doesNotMatch(ret, /draftSaveToken:/);
  }
});

test('create-setup-intent verifies token against draft phone, not request phone', () => {
  const src = require('fs').readFileSync(SETUP_PATH, 'utf8');
  assert.match(src, /phone: booking\.phone \|\| booking\.customerPhone/);
  assert.doesNotMatch(src, /p\.phone/);
  assert.doesNotMatch(src, /body\.phone/);
});

test('draft token is never logged in netlify functions', () => {
  const files = [
    '../netlify/lib/draft-save-token.js',
    '../netlify/functions/create-setup-intent.js',
    '../netlify/functions/submit-booking.js',
  ];
  for (const rel of files) {
    const src = require('fs').readFileSync(require.resolve(rel), 'utf8');
    assert.doesNotMatch(src, /console\.(log|info|debug|warn|error)\([^)]*draftSaveToken/);
  }
});

test('token and bookingId from same draft response verify together', () => {
  const lib = loadTokenLib();
  delete require.cache[SUBMIT_PATH];
  const { __test } = require('../netlify/functions/submit-booking');
  const draft = __test.buildDraftRecord({
    firstName: 'A',
    phone: '5513132956',
    paymentMethodPreference: 'card_onsite',
  }, 'CD1-PAIR', new Date().toISOString());
  const issued = __test.issueDraftSaveResponse(draft);
  assert.equal(issued.ok, true);
  assert.equal(issued.body.id, 'CD1-PAIR');
  const verified = lib.verifyDraftSaveToken({
    token: issued.body.draftSaveToken,
    bookingId: issued.body.id,
    phone: draft.phone,
  });
  assert.equal(verified.ok, true);
  const cross = lib.verifyDraftSaveToken({
    token: issued.body.draftSaveToken,
    bookingId: 'CD1-OTHER',
    phone: draft.phone,
  });
  assert.equal(cross.ok, false);
});

test('old token fails after draft phone changes and new token verifies', () => {
  const lib = loadTokenLib();
  const now = Date.now();
  const oldPhone = '5513132956';
  const newPhone = '2015550100';
  const bookingId = 'CD1-PHONE';
  const oldIssued = lib.issueDraftSaveToken({ bookingId, phone: oldPhone, now });
  const newIssued = lib.issueDraftSaveToken({ bookingId, phone: newPhone, now: now + 1000 });
  assert.equal(
    lib.verifyDraftSaveToken({ token: oldIssued.token, bookingId, phone: newPhone, now: now + 1000 }).ok,
    false
  );
  assert.equal(
    lib.verifyDraftSaveToken({ token: newIssued.token, bookingId, phone: newPhone, now: now + 1000 }).ok,
    true
  );
});

test('buildBookingPayload uses draftBookingId field only as server finalize hint', () => {
  const fs = require('fs');
  const path = require('path');
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(index, /ST\.draftBookingId/);
  assert.match(index, /draftBookingId:ST\.bookingId/);
  assert.match(index, /ST\.bookingId=draftData\.id/);
});
