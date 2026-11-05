'use strict';

// Production releases can publish prebuilt function zips, which carry no
// build metadata. A v2 (`export default`) function shipped that way is invoked
// as a v1 Lambda and returns 502, which turned GA4 off in production on
// 2026-11-04 (deploy 6aeb3120). The public GA4 lookup must stay a classic
// handler, and no new v2 function may slip in unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN_DIR = path.join(ROOT, 'netlify', 'functions');
const fnPath = path.join(FN_DIR, 'analytics-public-config.js');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test('analytics-public-config is a classic v1 handler', () => {
  assert.ok(fs.existsSync(fnPath), 'analytics-public-config.js must exist');
  assert.ok(!fs.existsSync(path.join(FN_DIR, 'analytics-public-config.mjs')), 'the v2 .mjs variant must be gone');
  const src = fs.readFileSync(fnPath, 'utf8');
  assert.match(src, /exports\.handler\s*=/);
  assert.doesNotMatch(src, /export\s+default|new Response\(|Netlify\.env/);
  delete require.cache[require.resolve(fnPath)];
  assert.equal(typeof require(fnPath).handler, 'function');
});

test('GET returns the configured GA4 id as JSON with no-store', () => withEnv({ GA4_MEASUREMENT_ID: 'G-TEST12345', CD1_GA4_MEASUREMENT_ID: null }, async () => {
  const { handler } = require(fnPath);
  const res = await handler({ httpMethod: 'GET', headers: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(typeof res.body, 'string');
  const body = JSON.parse(res.body);
  assert.equal(body.ga4MeasurementId, 'G-TEST12345');
  assert.deepEqual(body.configured, { ga4: true });
}));

test('missing or malformed id leaves GA4 off', () => withEnv({ GA4_MEASUREMENT_ID: 'not-an-id', CD1_GA4_MEASUREMENT_ID: null }, async () => {
  const { handler } = require(fnPath);
  const body = JSON.parse((await handler({ httpMethod: 'GET' })).body);
  assert.equal(body.ga4MeasurementId, null);
  assert.deepEqual(body.configured, { ga4: false });
}));

test('CD1_GA4_MEASUREMENT_ID is the fallback', () => withEnv({ GA4_MEASUREMENT_ID: null, CD1_GA4_MEASUREMENT_ID: 'G-FALLBACK1' }, async () => {
  const { handler } = require(fnPath);
  assert.equal(JSON.parse((await handler({ httpMethod: 'GET' })).body).ga4MeasurementId, 'G-FALLBACK1');
}));

test('HEAD is 200 with empty body; other methods are 405', async () => {
  const { handler } = require(fnPath);
  const head = await handler({ httpMethod: 'HEAD' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  const post = await handler({ httpMethod: 'POST', body: '{}' });
  assert.equal(post.statusCode, 405);
  assert.equal(JSON.parse(post.body).error, 'method_not_allowed');
});

test('only the known, uncalled upload function uses the v2 runtime', () => {
  const v2 = fs.readdirSync(FN_DIR)
    .filter((n) => /\.(m?[jt]s|cjs)$/.test(n))
    .filter((n) => /^\s*export\s+default\b/m.test(fs.readFileSync(path.join(FN_DIR, n), 'utf8')))
    .sort();
  assert.deepEqual(v2, ['upload.mts', 'upload.ts'],
    'New v2 functions break when prebuilt zips are deployed; use exports.handler or update the release procedure first.');
});
