/**
 * Post-release hardening — smoke harness gate + session fallback warning.
 * Does not exercise live Production secrets.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SMOKE_PATH = require.resolve('../netlify/functions/qa-customer-identity-smoke');
const SESSION_PATH = require.resolve('../netlify/lib/customer-session');

describe('post-release auth smoke and session architecture', () => {
  let envSnap;

  beforeEach(() => {
    envSnap = {
      CUSTOMER_IDENTITY_SMOKE_SECRET: process.env.CUSTOMER_IDENTITY_SMOKE_SECRET,
      CUSTOMER_SESSION_SECRET: process.env.CUSTOMER_SESSION_SECRET,
      ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
      CONTEXT: process.env.CONTEXT,
      BID_SECRET: process.env.BID_SECRET,
      ADMIN_DASH_PASSWORD: process.env.ADMIN_DASH_PASSWORD,
    };
    delete require.cache[SMOKE_PATH];
    delete require.cache[SESSION_PATH];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[SMOKE_PATH];
    delete require.cache[SESSION_PATH];
  });

  it('smoke harness returns 404 when secret unset (disabled by default)', async () => {
    delete process.env.CUSTOMER_IDENTITY_SMOKE_SECRET;
    const { handler } = require('../netlify/functions/qa-customer-identity-smoke');
    const res = await handler({
      httpMethod: 'POST',
      headers: {},
      body: '{}',
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'not_found');
  });

  it('smoke harness returns 404 for wrong secret (no oracle)', async () => {
    process.env.CUSTOMER_IDENTITY_SMOKE_SECRET = 'x'.repeat(32);
    delete require.cache[SMOKE_PATH];
    const { handler } = require('../netlify/functions/qa-customer-identity-smoke');
    const res = await handler({
      httpMethod: 'POST',
      headers: { 'x-cd1-smoke-secret': 'y'.repeat(32) },
      body: '{}',
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'not_found');
  });

  it('timing-safe compare rejects length-mismatched secrets', () => {
    process.env.CUSTOMER_IDENTITY_SMOKE_SECRET = 'a'.repeat(32);
    delete require.cache[SMOKE_PATH];
    const mod = require('../netlify/functions/qa-customer-identity-smoke');
    assert.equal(mod._test.secretsMatch('short', 'a'.repeat(32)), false);
    assert.equal(mod._test.secretsMatch('a'.repeat(32), 'a'.repeat(32)), true);
  });

  it('customer session prefers CUSTOMER_SESSION_SECRET over admin', () => {
    process.env.CONTEXT = 'production';
    process.env.CUSTOMER_SESSION_SECRET = 'c'.repeat(32);
    process.env.ADMIN_SESSION_SECRET = 'a'.repeat(32);
    delete require.cache[SESSION_PATH];
    const session = require('../netlify/lib/customer-session');
    // signSessionPayload throws if secret missing; success proves a secret resolved.
    const token = session.signSessionPayload({ sid: 's1', exp: Date.now() + 10000 });
    assert.equal(typeof token, 'string');
    assert.match(token, /\./);
    // Verify with customer secret still works after clearing admin.
    delete process.env.ADMIN_SESSION_SECRET;
    delete require.cache[SESSION_PATH];
    const session2 = require('../netlify/lib/customer-session');
    const payload = session2.verifySessionToken(token);
    assert.ok(payload);
    assert.equal(payload.sid, 's1');
  });

  it('docs and scripts for ops hardening are present', () => {
    assert.match(read('docs/ops/customer-session-secrets.md'), /CUSTOMER_SESSION_SECRET/);
    assert.match(read('docs/ops/customer-session-secrets.md'), /ADMIN_SESSION_SECRET/);
    assert.match(read('docs/ops/customer-identity-production-smoke.md'), /qa-customer-identity-smoke/);
    assert.match(read('docs/ops/netlify-production-autodeploy.md'), /stop_builds/);
    assert.match(read('.env.example'), /CUSTOMER_SESSION_SECRET/);
    assert.match(read('.env.example'), /CUSTOMER_IDENTITY_SMOKE_SECRET/);
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/prod-customer-identity-smoke.mjs')));
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/check-customer-session-architecture.mjs')));
  });

  it('payment authority module is untouched by hardening docs/smoke', () => {
    const pay = read('netlify/lib/db/payment-authority-service.js');
    assert.match(pay, /function|exports/);
    assert.doesNotMatch(read('netlify/functions/qa-customer-identity-smoke.js'), /PaymentAttempt|LedgerEntry|capture/);
  });
});
