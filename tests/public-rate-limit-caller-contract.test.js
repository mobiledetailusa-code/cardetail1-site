// Caller contract for enforcePublicRateLimit.
//
// `revenue-event` and `revenue-resume-link` both called the helper with its
// OBSOLETE POSITIONAL signature and then branched on a property the helper does
// not return:
//
//     const rate = await enforcePublicRateLimit(event, 'revenue-event', 'track');
//     if (!rate.ok) { return 429; }
//
// Two independent defects compounded. The string was destructured as the options
// object, so `endpoint` arrived undefined and the configured bucket was never
// consulted. And the helper returns `{ blocked, allowed, ... }` with no `ok`, so
// `rate.ok` was always undefined and `!rate.ok` was always true — every request
// returned 429, including when the limiter explicitly allowed the request or
// failed open with storage unavailable.
//
// It was invisible for two reasons worth pinning: the response of a public
// analytics beacon is never inspected client-side, and a signature change is not
// visible at the call site. This file guards the whole defect class statically,
// then proves the two repaired handlers behave correctly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(root, 'netlify', 'functions');

const HELPER_PATH = require.resolve('../netlify/lib/public-rate-limit');
const ADMIN_SECURITY_PATH = require.resolve('../netlify/lib/admin-security');
const REVENUE_STORE_PATH = require.resolve('../netlify/lib/revenue-store');
const REVENUE_RESUME_PATH = require.resolve('../netlify/lib/revenue-resume');

function functionFiles() {
  return fs.readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith('.js')).sort();
}

/**
 * Source with comments removed, quote-aware.
 *
 * Necessary, not cosmetic: the first version of this file scanned raw text and
 * reported `revenue-event.js` and `revenue-resume-link.js` as offenders because
 * the comments explaining the repaired contract mention `rate.ok`. A guard that
 * reads prose is the same defect class this file exists to prevent.
 */
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i], next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

const functionCode = (file) => stripComments(fs.readFileSync(path.join(FUNCTIONS_DIR, file), 'utf8'));

// ── Static contract, across every function ───────────────────────────────────

test('the helper still returns blocked/allowed and never an `ok` decision field', () => {
  const src = fs.readFileSync(HELPER_PATH, 'utf8');

  // Guard the premise this whole file rests on. If the helper ever grows an `ok`
  // field, the assertions below stop meaning what they say and must be revisited.
  const returnsOk = /return\s*\{[^}]*\bok\s*:/s.test(src.replace(/buildRateLimitedResponse[\s\S]*?\n}/, ''));
  assert.equal(returnsOk, false, 'enforcePublicRateLimit now returns an `ok` field — this contract test must be re-derived');

  const { enforcePublicRateLimit } = require('../netlify/lib/public-rate-limit');
  assert.equal(typeof enforcePublicRateLimit, 'function');
});

test('no function calls enforcePublicRateLimit with the obsolete positional signature', () => {
  const offenders = [];
  for (const file of functionFiles()) {
    const src = functionCode(file);
    // Second argument must be an object literal or an identifier, never a string.
    for (const m of src.matchAll(/enforcePublicRateLimit\(\s*[A-Za-z_$][\w$]*\s*,\s*(.)/g)) {
      const nextChar = m[1];
      if (nextChar === "'" || nextChar === '"' || nextChar === '`') {
        offenders.push(`${file}: passes a string as the options object`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'enforcePublicRateLimit takes ({ endpoint, action, cors }). A string is destructured into an ' +
      'object with no endpoint, so the configured bucket is silently never consulted:\n  ' + offenders.join('\n  '),
  );
});

test('no function branches on a rate-limit property the helper does not return', () => {
  const offenders = [];
  for (const file of functionFiles()) {
    const src = functionCode(file);
    // Find what each caller binds the decision to, then look for `<name>.ok`.
    for (const m of src.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+(?:[\w$]+\.)?enforcePublicRateLimit\(/g)) {
      const binding = m[1];
      const usesOk = new RegExp(`\\b${binding}\\s*(?:&&\\s*)?\\.\\s*ok\\b|!\\s*${binding}\\.ok\\b|\\b${binding}\\.ok\\b`).test(src);
      if (usesOk) {
        offenders.push(`${file}: branches on \`${binding}.ok\`, which is always undefined`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'The decision object exposes `blocked` and `allowed`. Reading `.ok` yields undefined, so ' +
      '`if (!rate.ok)` rejects unconditionally:\n  ' + offenders.join('\n  '),
  );
});

test('the two repaired endpoints name their configured buckets', () => {
  // NOTE ON SCOPE. An earlier version of this test asserted that EVERY caller
  // names a configured bucket. That assertion was false: getLimitConfig falls
  // back to { max: 60, windowMs: DEFAULT_WINDOW_MS } for any unlisted bucket, by
  // design, and six endpoints legitimately run on that generic default. Asserting
  // otherwise would have failed on correct code.
  //
  // What matters here is narrower and true: the point of this hotfix is that the
  // two repaired callers reach their OWN tuned buckets, which the positional form
  // silently bypassed by leaving `endpoint` undefined.
  const { DEFAULT_LIMITS } = require('../netlify/lib/public-rate-limit');

  for (const [file, bucket] of [
    ['revenue-event.js', 'revenue-event:track'],
    ['revenue-resume-link.js', 'revenue-resume-link:validate'],
  ]) {
    assert.ok(DEFAULT_LIMITS[bucket], `${bucket} must stay configured — it is the limit this hotfix restores`);

    const src = functionCode(file);
    const m = /enforcePublicRateLimit\(\s*[\w$]+\s*,\s*\{([^}]*)\}/s.exec(src);
    assert.ok(m, `${file} must call enforcePublicRateLimit with an options object`);
    const endpoint = /endpoint\s*:\s*'([^']+)'/.exec(m[1])?.[1];
    const action = /action\s*:\s*'([^']*)'/.exec(m[1])?.[1] || '';
    assert.equal(
      action ? `${endpoint}:${action}` : endpoint, bucket,
      `${file} must name ${bucket}; under the positional call endpoint was undefined and this bucket was never consulted`,
    );
  }
});

// ── Behaviour of the two repaired handlers ───────────────────────────────────

function loadWithMemoryStore() {
  for (const p of [HELPER_PATH, ADMIN_SECURITY_PATH]) delete require.cache[p];
  const rl = require('../netlify/lib/public-rate-limit');
  const data = new Map();
  let etag = 0;
  rl.setPublicRateLimitStoreFactory(() => ({
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const e = data.get(key);
      return { data: type === 'json' ? JSON.parse(e.value) : e.value, etag: e.etag, metadata: {} };
    },
    async setJSON(key, value) {
      data.set(key, { value: JSON.stringify(value), etag: String(++etag) });
    },
  }));
  return rl;
}

function loadHandler(name) {
  const p = require.resolve(`../netlify/functions/${name}`);
  delete require.cache[p];
  return require(`../netlify/functions/${name}`).handler;
}

test('revenue-event accepts a request the limiter allows', async () => {
  loadWithMemoryStore();
  const handler = loadHandler('revenue-event');
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.10', 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  assert.notEqual(
    res.statusCode, 429,
    'the first analytics event of a clean session must not be rate limited — this is the exact symptom of the obsolete caller contract',
  );
});

test('revenue-resume-link accepts a request the limiter allows', async () => {
  loadWithMemoryStore();
  const handler = loadHandler('revenue-resume-link');
  const res = await handler({
    httpMethod: 'GET',
    headers: { 'x-nf-client-connection-ip': '203.0.113.11' },
    queryStringParameters: { token: 'not-a-real-token' },
  });

  assert.notEqual(
    res.statusCode, 429,
    'a resume link must reach token validation. Under the defect resume.html read ok:false and told the customer a valid link was "invalid or expired"',
  );
  // It must fail on the token, not on the limiter — proving the request got through.
  assert.equal(res.statusCode, 400);
  assert.notEqual(JSON.parse(res.body).error, 'rate_limited');
});

test('both handlers still return 429 when the limiter genuinely blocks', async () => {
  for (const [name, event] of [
    ['revenue-event', { httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.12' }, body: '{}' }],
    ['revenue-resume-link', { httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '203.0.113.13' }, queryStringParameters: { token: 't' } }],
  ]) {
    const rl = loadWithMemoryStore();
    const real = rl.enforcePublicRateLimit;
    rl.enforcePublicRateLimit = async () => ({ blocked: true, allowed: false, retryAfterSec: 42 });
    try {
      const res = await loadHandler(name)(event);
      assert.equal(res.statusCode, 429, `${name} must still reject when the limiter blocks`);
      assert.equal(JSON.parse(res.body).error, 'rate_limited');
      assert.equal(res.headers['Retry-After'], '42', `${name} must surface the helper's retryAfterSec, not a property it does not return`);
    } finally {
      rl.enforcePublicRateLimit = real;
    }
  }
});

function validRevenueEvent(eventId = 'evt_contract_1') {
  return {
    event: 'page_view',
    event_id: eventId,
    anonymous_session_id: 'sess_contract_1',
    properties: { timestamp: '2026-08-18T12:00:00.000Z', page_type: 'home' },
  };
}

function loadRevenueEventHarness({
  rateDecision = { blocked: false, allowed: true },
  existing = null,
  failWrite = false,
} = {}) {
  const rl = require(HELPER_PATH);
  const revenueStore = require(REVENUE_STORE_PATH);
  const originalRateLimit = rl.enforcePublicRateLimit;
  const originalStore = {
    getRevenueStore: revenueStore.getRevenueStore,
    blobGetJson: revenueStore.blobGetJson,
    blobSetJson: revenueStore.blobSetJson,
  };
  const writes = [];

  rl.enforcePublicRateLimit = async () => rateDecision;
  revenueStore.getRevenueStore = async (name) => ({ name });
  revenueStore.blobGetJson = async () => existing;
  revenueStore.blobSetJson = async (store, key, value) => {
    if (failWrite) throw new Error('synthetic_storage_failure');
    writes.push({ store: store.name, key, value });
  };

  const handler = loadHandler('revenue-event');
  rl.enforcePublicRateLimit = originalRateLimit;
  Object.assign(revenueStore, originalStore);
  return { handler, writes };
}

test('revenue-event allowed request reaches validation and both persistence writes', async () => {
  const { handler, writes } = loadRevenueEventHarness();
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.20' },
    body: JSON.stringify(validRevenueEvent()),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].store, 'events');
  assert.match(writes[0].key, /\/evt_contract_1$/);
  assert.equal(writes[1].store, 'eventIdempotency');
  assert.equal(writes[1].key, 'evt:evt_contract_1');
});

test('revenue-event preserves malformed, duplicate, and storage-error contracts', async () => {
  const malformed = loadRevenueEventHarness();
  const malformedRes = await malformed.handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.21' },
    body: '{',
  });
  assert.equal(malformedRes.statusCode, 400);
  assert.equal(JSON.parse(malformedRes.body).error, 'invalid_json');
  assert.equal(malformed.writes.length, 0);

  const duplicate = loadRevenueEventHarness({ existing: { eventId: 'evt_contract_dup' } });
  const duplicateRes = await duplicate.handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.22' },
    body: JSON.stringify(validRevenueEvent('evt_contract_dup')),
  });
  assert.equal(duplicateRes.statusCode, 200);
  assert.deepEqual(JSON.parse(duplicateRes.body), { ok: true, duplicate: true });
  assert.equal(duplicate.writes.length, 0);

  const failed = loadRevenueEventHarness({ failWrite: true });
  const failedRes = await failed.handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.23' },
    body: JSON.stringify(validRevenueEvent('evt_contract_failure')),
  });
  assert.equal(failedRes.statusCode, 503);
  assert.equal(JSON.parse(failedRes.body).error, 'storage_unavailable');
});

test('missing client IP follows the helper fail-open contract and reaches the handler', async () => {
  const rl = loadWithMemoryStore();
  const decision = await rl.enforcePublicRateLimit(
    { httpMethod: 'POST', headers: {} },
    { endpoint: 'revenue-event', action: 'track' },
  );
  assert.equal(decision.blocked, false);
  assert.equal(decision.allowed, true);
  assert.equal(decision.failOpen, true);
  assert.equal(decision.reason, 'missing_client_ip');

  const { handler } = loadRevenueEventHarness({ rateDecision: decision });
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify(validRevenueEvent('evt_contract_fail_open')),
  });
  assert.equal(res.statusCode, 200);
});

function loadResumeMemoryHarness() {
  const previousSecret = process.env.RESUME_TOKEN_SECRET;
  process.env.RESUME_TOKEN_SECRET = 'contract-test-secret-at-least-32-bytes-long';

  const revenueStore = require(REVENUE_STORE_PATH);
  const originalStore = {
    getRevenueStore: revenueStore.getRevenueStore,
    blobGetJson: revenueStore.blobGetJson,
    blobSetJson: revenueStore.blobSetJson,
  };
  const records = new Map();
  revenueStore.getRevenueStore = async () => ({ name: 'resumeTokens' });
  revenueStore.blobGetJson = async (_store, key) => records.get(key) || null;
  revenueStore.blobSetJson = async (_store, key, value) => records.set(key, { ...value });

  delete require.cache[REVENUE_RESUME_PATH];
  const resumeApi = require(REVENUE_RESUME_PATH);
  Object.assign(revenueStore, originalStore);

  const rl = require(HELPER_PATH);
  const originalRateLimit = rl.enforcePublicRateLimit;
  rl.enforcePublicRateLimit = async () => ({ blocked: false, allowed: true });
  const handler = loadHandler('revenue-resume-link');
  rl.enforcePublicRateLimit = originalRateLimit;

  return {
    handler,
    resumeApi,
    records,
    restore() {
      if (previousSecret === undefined) delete process.env.RESUME_TOKEN_SECRET;
      else process.env.RESUME_TOKEN_SECRET = previousSecret;
    },
  };
}

test('resume-link malformed, invalid, and expired requests remain rejected after rate limiting', async () => {
  const h = loadResumeMemoryHarness();
  try {
    const missing = await h.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    assert.equal(missing.statusCode, 400);
    assert.equal(JSON.parse(missing.body).error, 'missing_token');

    const invalid = await h.handler({
      httpMethod: 'GET', headers: {}, queryStringParameters: { token: 'rs.not-valid' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(JSON.parse(invalid.body).error, 'invalid_token');

    const created = await h.resumeApi.createResumeToken({ bookingId: 'bk_expired', bookingStep: 2 });
    const record = [...h.records.values()].find((r) => r.bookingId === 'bk_expired');
    record.expiresAt = '2000-01-01T00:00:00.000Z';
    const expired = await h.handler({
      httpMethod: 'GET', headers: {}, queryStringParameters: { token: created.token },
    });
    assert.equal(expired.statusCode, 400);
    assert.equal(JSON.parse(expired.body).error, 'expired');
  } finally {
    h.restore();
  }
});

test('valid opaque resume tokens resolve only their own stored customer recovery record', async () => {
  const h = loadResumeMemoryHarness();
  try {
    const a = await h.resumeApi.createResumeToken({
      leadId: 'lead_a', householdId: 'house_a', bookingId: 'booking_a', bookingStep: 3, garagePlanId: 'plan_a',
    });
    const b = await h.resumeApi.createResumeToken({
      leadId: 'lead_b', householdId: 'house_b', bookingId: 'booking_b', bookingStep: 5, garagePlanId: 'plan_b',
    });

    const aRes = await h.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: a.token } });
    const bRes = await h.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: b.token } });
    assert.equal(aRes.statusCode, 200);
    assert.equal(bRes.statusCode, 200);
    assert.equal(JSON.parse(aRes.body).bookingId, 'booking_a');
    assert.equal(JSON.parse(aRes.body).garagePlanId, 'plan_a');
    assert.equal(JSON.parse(bRes.body).bookingId, 'booking_b');
    assert.equal(JSON.parse(bRes.body).garagePlanId, 'plan_b');

    const tampered = `${a.token.slice(0, -1)}${a.token.endsWith('x') ? 'y' : 'x'}`;
    const tamperedRes = await h.handler({
      httpMethod: 'GET', headers: {}, queryStringParameters: { token: tampered },
    });
    assert.equal(tamperedRes.statusCode, 400);
    assert.equal(JSON.parse(tamperedRes.body).error, 'invalid_token');
  } finally {
    h.restore();
  }
});
