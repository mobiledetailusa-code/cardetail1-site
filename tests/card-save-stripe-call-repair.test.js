// Regression cover for the card-on-file Stripe call broken by the versioned
// financial-invariants change. Two independent dead-ends are pinned here:
//   1. a draft carrying explicit consent but no consent timestamp was rejected
//      with a permanent 409 card_on_file_consent_required;
//   2. the SetupIntent idempotency key was fixed per booking, so once Stripe
//      cached a terminal SetupIntent every later attempt replayed it and the
//      customer could never save a card.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SETUP_PATH = require.resolve('../netlify/functions/create-setup-intent');
const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
const TOKEN_PATH = require.resolve('../netlify/lib/draft-save-token');
const TEST_SECRET = 'card-save-repair-secret-value-0123456789';

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

function stubStripe(calls, setupIntentId = 'seti_repair') {
  return async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body, headers: opts && opts.headers });
    if (String(url).includes('/v1/customers')) {
      return { ok: true, json: async () => ({ id: 'cus_repair' }) };
    }
    if (String(url).includes('/v1/setup_intents')) {
      return {
        ok: true,
        json: async () => ({
          id: setupIntentId,
          customer: 'cus_repair',
          client_secret: `${setupIntentId}_secret`,
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function baseDraft(overrides = {}) {
  return {
    id: 'CD1-REPAIR',
    isDraft: true,
    phone: '5513132956',
    cardOnFileRequired: true,
    cardOnFileStatus: 'pending',
    bookingVersion: 0,
    acceptedCardOnFilePolicy: true,
    policyVersion: 'card-on-file-policy-v1',
    firstName: 'Test',
    email: 'test@example.com',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function withCardSaveEnv(fn) {
  return async (t) => {
    const envSnap = { ...process.env };
    const originalFetch = global.fetch;
    process.env.DRAFT_TOKEN_SECRET = TEST_SECRET;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.CONTEXT = 'production';
    delete process.env.NETLIFY_DEV;
    try {
      await fn(t);
    } finally {
      global.fetch = originalFetch;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, envSnap);
    }
  };
}

function loadSetupIntent(store) {
  delete require.cache[SETUP_PATH];
  const mod = require('../netlify/functions/create-setup-intent');
  mod.__test.setBlobsStoreOverride(() => store);
  return mod.handler;
}

function issueToken(bookingId, phone) {
  delete require.cache[TOKEN_PATH];
  return require('../netlify/lib/draft-save-token')
    .issueDraftSaveToken({ bookingId, phone, now: Date.now() });
}

function post(bookingId, token, expectedBookingVersion) {
  return {
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.44' },
    body: JSON.stringify({ bookingId, draftSaveToken: token, expectedBookingVersion }),
  };
}

test('draft with explicit consent but no timestamp still reaches Stripe', withCardSaveEnv(async () => {
  const issued = issueToken('CD1-REPAIR', '5513132956');
  // acceptedCardOnFilePolicyAt deliberately absent — the shape every draft
  // pre-registered before the timestamp existed still carries.
  const store = createMemoryStore({ 'CD1-REPAIR': baseDraft() });
  const calls = [];
  global.fetch = stubStripe(calls);

  const handler = loadSetupIntent(store);
  const res = await handler(post('CD1-REPAIR', issued.token, 0));

  assert.equal(res.statusCode, 200, 'missing consent evidence must not block card save');
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.clientSecret, 'seti_repair_secret');
  assert.ok(calls.some((c) => c.url.includes('/v1/setup_intents')), 'Stripe must be called');

  // The derived stamp is persisted so the evidence exists from here on.
  const saved = await store.get('CD1-REPAIR', { type: 'json' });
  assert.ok(saved.acceptedCardOnFilePolicyAt, 'consent timestamp must be backfilled');
  assert.equal(saved.cardOnFileConsentGrantedAt, saved.acceptedCardOnFilePolicyAt);
}));

test('withheld consent is still rejected', withCardSaveEnv(async () => {
  const issued = issueToken('CD1-REPAIR', '5513132956');
  const store = createMemoryStore({
    'CD1-REPAIR': baseDraft({ acceptedCardOnFilePolicy: false }),
  });
  const calls = [];
  global.fetch = stubStripe(calls);

  const handler = loadSetupIntent(store);
  const res = await handler(post('CD1-REPAIR', issued.token, 0));

  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, 'card_on_file_consent_required');
  assert.equal(calls.length, 0, 'Stripe must never be called without consent');
}));

test('a later attempt uses a fresh idempotency key instead of replaying', withCardSaveEnv(async () => {
  const issued = issueToken('CD1-REPAIR', '5513132956');
  const store = createMemoryStore({
    'CD1-REPAIR': baseDraft({ acceptedCardOnFilePolicyAt: '2026-08-01T10:00:00.000Z' }),
  });
  const calls = [];
  global.fetch = stubStripe(calls);
  const handler = loadSetupIntent(store);

  const first = await handler(post('CD1-REPAIR', issued.token, 0));
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).bookingVersion, 1);

  // Customer re-enters the card step; the draft is now at version 1.
  const second = await handler(post('CD1-REPAIR', issued.token, 1));
  assert.equal(second.statusCode, 200);

  const siKeys = calls
    .filter((c) => c.url.includes('/v1/setup_intents'))
    .map((c) => c.headers['Idempotency-Key']);
  assert.equal(siKeys.length, 2);
  assert.equal(siKeys[0], 'setup_intent_CD1-REPAIR_card-on-file-policy-v1_v0');
  assert.equal(siKeys[1], 'setup_intent_CD1-REPAIR_card-on-file-policy-v1_v1');
  assert.notEqual(siKeys[0], siKeys[1], 'a new attempt must not replay a cached SetupIntent');
}));

test('an idempotent retry re-keys to the prior attempt and reuses its SetupIntent', withCardSaveEnv(async () => {
  const issued = issueToken('CD1-REPAIR', '5513132956');
  const store = createMemoryStore({
    'CD1-REPAIR': baseDraft({ acceptedCardOnFilePolicyAt: '2026-08-01T10:00:00.000Z' }),
  });
  const calls = [];
  global.fetch = stubStripe(calls);
  const handler = loadSetupIntent(store);

  await handler(post('CD1-REPAIR', issued.token, 0));
  // Response lost in flight: the client retries on the version it still holds.
  const retry = await handler(post('CD1-REPAIR', issued.token, 0));

  assert.equal(retry.statusCode, 200);
  const body = JSON.parse(retry.body);
  assert.equal(body.reused, true);
  assert.equal(body.bookingVersion, 1, 'idempotent retry must not bump the version');

  const siKeys = calls
    .filter((c) => c.url.includes('/v1/setup_intents'))
    .map((c) => c.headers['Idempotency-Key']);
  assert.deepEqual(siKeys, [
    'setup_intent_CD1-REPAIR_card-on-file-policy-v1_v0',
    'setup_intent_CD1-REPAIR_card-on-file-policy-v1_v0',
  ]);
}));

test('a genuinely stale version still reports actualBookingVersion for resync', withCardSaveEnv(async () => {
  const issued = issueToken('CD1-REPAIR', '5513132956');
  const store = createMemoryStore({
    'CD1-REPAIR': baseDraft({
      bookingVersion: 4,
      setupIntentId: 'seti_repair',
      acceptedCardOnFilePolicyAt: '2026-08-01T10:00:00.000Z',
    }),
  });
  const calls = [];
  global.fetch = stubStripe(calls);
  const handler = loadSetupIntent(store);

  const res = await handler(post('CD1-REPAIR', issued.token, 1));

  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'version_conflict');
  assert.equal(body.actualBookingVersion, 4, 'client needs the real version to resync');
  assert.equal(calls.length, 0);
}));

test('draft re-registration stamps a consent timestamp when the draft lacks one', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'submit-booking.js'), 'utf8');
  assert.match(
    src,
    /acceptedCardOnFilePolicyAt:\s*\(existing && existing\.acceptedCardOnFilePolicyAt\) \|\| now,/,
    'an existing draft without a consent stamp must be backfilled, not propagated as undefined'
  );
  assert.doesNotMatch(
    src,
    /acceptedCardOnFilePolicyAt:\s*existing \? existing\.acceptedCardOnFilePolicyAt : now,/
  );
  assert.equal(require.resolve('../netlify/functions/submit-booking'), SUBMIT_PATH);
});

// ── Cold-start containment ────────────────────────────────────────────────────
// The checkout functions must not pull the Twilio SDK (or the SMS outbox's
// Prisma graph) at module load. A resolution failure there is not catchable by
// the handler: Netlify returns a plain-text 500 and the browser reports
// "Booking backend returned an invalid response."

const CHECKOUT_FUNCTIONS = [
  'submit-booking.js',
  'submit-inquiry.js',
  'stripe-webhook.js',
];

for (const fn of CHECKOUT_FUNCTIONS) {
  test(`${fn} does not load the SMS outbox at module scope`, () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', fn), 'utf8');
    const topLevel = src.split(/\nexports\.handler|\nasync function handler/)[0];
    assert.doesNotMatch(
      topLevel,
      /^const \{[^}]*\} = require\('\.\.\/lib\/sms-(outbox|templates)'\);/m,
      'sms-outbox must be required at the call site, not at module scope'
    );
    assert.match(src, /function smsOutbox\(\)/, 'lazy accessor must exist');
  });
}

test('twilio SDK is required lazily, behind the runtime policy gate', () => {
  const fs = require('node:fs');
  for (const lib of ['twilio-provider.js', 'twilio-webhook.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'lib', lib), 'utf8');
    assert.doesNotMatch(
      src,
      /^const twilio = require\('twilio'\);/m,
      `${lib} must not require the Twilio SDK at module scope`
    );
    assert.match(src, /require\('twilio'\)/, `${lib} still needs the SDK at call time`);
    assert.match(src, /twilio_sdk_unavailable/, `${lib} must degrade instead of throwing`);
  }
});

test('loading the checkout functions never resolves the twilio package', () => {
  // Proven by resolution, not by inspection: a stub Module._load that throws on
  // 'twilio' must not be reached while the checkout functions load.
  const Module = require('node:module');
  const originalLoad = Module._load;
  let touched = null;
  Module._load = function (request, parent, isMain) {
    if (request === 'twilio') { touched = parent && parent.filename; throw new Error('twilio loaded at cold start'); }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const fn of CHECKOUT_FUNCTIONS) {
      const p = require.resolve(`../netlify/functions/${fn.replace(/\.js$/, '')}`);
      delete require.cache[p];
      require(p);
    }
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(touched, null, `twilio was loaded at cold start by ${touched}`);
});

test('netlify.toml keeps twilio out of the function bundle', () => {
  const fs = require('node:fs');
  const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
  assert.match(toml, /external_node_modules\s*=\s*\[[^\]]*"twilio"/);
});
