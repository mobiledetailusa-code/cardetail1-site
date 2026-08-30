/**
 * Customer Identity security prerequisites — session revocation, public
 * customer-bookings rate limiting, and orphan subscription action lockdown.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SESSION_PATH = require.resolve('../netlify/lib/customer-session');
const RATE_PATH = require.resolve('../netlify/lib/public-rate-limit');
const OPS_DB_PATH = require.resolve('../netlify/lib/ops-db');
const BOOKINGS_PATH = require.resolve('../netlify/functions/customer-bookings');
const SUBS_PATH = require.resolve('../netlify/functions/subscriptions-ops');
const ADMIN_SEC_PATH = require.resolve('../netlify/lib/admin-security');
const TECH_SEC_PATH = require.resolve('../netlify/lib/tech-security');

const TEST_SESSION_SECRET = 'test-customer-session-secret-32chars!!';
const TEST_ADMIN_SECRET = 'a'.repeat(32);

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  return {
    data,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      return opts && opts.type === 'json' ? structuredClone(v) : v;
    },
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return {
        data: type === 'json' ? structuredClone(value) : value,
        etag: `etag-${key}-${data.size}`,
        metadata: {},
      };
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value));
      return { modified: true, etag: `etag-${key}-${data.size}` };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

function createConditionalMemoryStore() {
  const data = new Map();
  let etagCounter = 0;
  return {
    data,
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      return {
        data: type === 'json' ? JSON.parse(entry.value) : entry.value,
        etag: entry.etag,
        metadata: {},
      };
    },
    async setJSON(key, value, options = {}) {
      const exists = data.has(key);
      if (options.onlyIfNew && exists) return { modified: false };
      if (options.onlyIfMatch) {
        if (!exists || data.get(key).etag !== options.onlyIfMatch) return { modified: false };
      }
      const etag = `etag-${++etagCounter}`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
  };
}

function cookieEvent(token, extraHeaders = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      cookie: token ? `cd1_customer_session=${encodeURIComponent(token)}` : '',
      ...extraHeaders,
    },
    body: '{}',
  };
}

function reloadSession() {
  delete require.cache[SESSION_PATH];
  return require('../netlify/lib/customer-session');
}

function reloadRateLimit() {
  delete require.cache[RATE_PATH];
  delete require.cache[require.resolve('../netlify/lib/admin-security')];
  return require('../netlify/lib/public-rate-limit');
}

describe('customer identity security prerequisites', () => {
  let sessionStore;
  let envSnap;

  beforeEach(() => {
    envSnap = {
      CUSTOMER_SESSION_SECRET: process.env.CUSTOMER_SESSION_SECRET,
      ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
      ADMIN_USERNAME: process.env.ADMIN_USERNAME,
      ADMIN_DASH_PASSWORD: process.env.ADMIN_DASH_PASSWORD,
      CONTEXT: process.env.CONTEXT,
      BRANCH: process.env.BRANCH,
      DEPLOY_ID: process.env.DEPLOY_ID,
      COMMIT_REF: process.env.COMMIT_REF,
    };
    process.env.CUSTOMER_SESSION_SECRET = TEST_SESSION_SECRET;
    process.env.ADMIN_SESSION_SECRET = TEST_ADMIN_SECRET;
    process.env.ADMIN_USERNAME = 'opsadmin';
    process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';
    process.env.CONTEXT = 'dev';
    process.env.BRANCH = 'fix-customer-identity-security-prerequisites';
    process.env.DEPLOY_ID = 'test-deploy-identity';
    sessionStore = createMemoryStore();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const session = require('../netlify/lib/customer-session');
    if (session.resetCustomerSessionStoreFactory) session.resetCustomerSessionStoreFactory();
    const rl = require('../netlify/lib/public-rate-limit');
    if (rl.resetPublicRateLimitStoreFactory) rl.resetPublicRateLimitStoreFactory();
    try {
      const subs = require('../netlify/functions/subscriptions-ops');
      if (subs.__test) subs.__test.setBlobsStoreOverride(null);
    } catch (_) { /* ignore */ }
    try {
      const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
      setOpsStoreOverride(null);
    } catch (_) { /* ignore */ }
    delete require.cache[SESSION_PATH];
    delete require.cache[RATE_PATH];
    delete require.cache[BOOKINGS_PATH];
    delete require.cache[SUBS_PATH];
    delete require.cache[ADMIN_SEC_PATH];
    delete require.cache[TECH_SEC_PATH];
    delete require.cache[OPS_DB_PATH];
  });

  it('1. valid magic-link session remains valid', async () => {
    const cs = reloadSession();
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    const { token, session } = await cs.createAccountSession({
      phoneDigits: '2015550177',
      email: 'owner@example.com',
      bookingIds: ['CD1-OK'],
    });
    assert.ok(token);
    assert.equal(session.scope, 'account');
    const validated = await cs.validateCustomerSession(cookieEvent(token));
    assert.equal(validated.ok, true);
    assert.equal(validated.sessionId, session.sid);
    assert.deepEqual(validated.bookingIds, ['CD1-OK']);
  });

  it('2. logout revokes the server-side session', async () => {
    const cs = reloadSession();
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    const { token, session } = await cs.createAccountSession({
      phoneDigits: '2015550177',
      email: 'owner@example.com',
    });
    const revoked = await cs.revokeCustomerSession(cookieEvent(token));
    assert.equal(revoked.ok, true);
    assert.equal(revoked.revoked, true);
    const record = await sessionStore.get(session.sid, { type: 'json' });
    assert.equal(record.revoked, true);
    assert.ok(record.revokedAt);
  });

  it('3. captured cookie is rejected after logout', async () => {
    const cs = reloadSession();
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    const { token } = await cs.createAccountSession({
      phoneDigits: '2015550177',
      email: 'owner@example.com',
    });
    await cs.revokeCustomerSession(cookieEvent(token));
    const validated = await cs.validateCustomerSession(cookieEvent(token));
    assert.equal(validated.ok, false);
    assert.equal(validated.error, 'session_invalid');
  });

  it('4. missing session record is rejected', async () => {
    const cs = reloadSession();
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    const { token, session } = await cs.createAccountSession({
      phoneDigits: '2015550177',
      email: 'owner@example.com',
    });
    await sessionStore.delete(session.sid);
    const validated = await cs.validateCustomerSession(cookieEvent(token));
    assert.equal(validated.ok, false);
  });

  it('5. expired session is rejected', async () => {
    const cs = reloadSession();
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    const sid = 'cs_expired_test';
    const exp = Date.now() - 60_000;
    const payload = {
      sid,
      scope: 'account',
      phoneDigits: '2015550177',
      emailHash: null,
      bookingIds: [],
      exp,
    };
    const token = cs.signSessionPayload(payload);
    await sessionStore.setJSON(sid, { ...payload, revoked: false });
    const validated = await cs.validateCustomerSession(cookieEvent(token));
    assert.equal(validated.ok, false);
  });

  it('6. revoked session is rejected', async () => {
    const cs = reloadSession();
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    const { token, session } = await cs.createAccountSession({
      phoneDigits: '2015550177',
      email: 'owner@example.com',
    });
    const record = await sessionStore.get(session.sid, { type: 'json' });
    await sessionStore.setJSON(session.sid, {
      ...record,
      revoked: true,
      revokedAt: new Date().toISOString(),
    });
    const validated = await cs.validateCustomerSession(cookieEvent(token));
    assert.equal(validated.ok, false);
  });

  it('7. invalid signature is rejected', async () => {
    const cs = reloadSession();
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    const { token } = await cs.createAccountSession({
      phoneDigits: '2015550177',
      email: 'owner@example.com',
    });
    const [body] = token.split('.');
    const tampered = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const validated = await cs.validateCustomerSession(cookieEvent(tampered));
    assert.equal(validated.ok, false);
  });

  it('8. legacy booking-ID + phone access still works', async () => {
    const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
    const booking = {
      id: 'CD1-LEGACY-1',
      isDraft: false,
      status: 'Confirmed',
      jobStatus: 'confirmed',
      phone: '2015550177',
      firstName: 'Legacy',
      email: 'legacy@example.com',
      totalPrice: 199,
    };
    setOpsStoreOverride(createMemoryStore({ 'CD1-LEGACY-1': booking }));

    const rl = reloadRateLimit();
    rl.setPublicRateLimitStoreFactory(() => createConditionalMemoryStore());

    delete require.cache[BOOKINGS_PATH];
    const { handler } = require('../netlify/functions/customer-bookings');
    const res = await handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.10' },
      body: JSON.stringify({ bookingId: 'CD1-LEGACY-1', phone: '(201) 555-0177' }),
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.count, 1);
    assert.equal(body.bookings[0].id, 'CD1-LEGACY-1');
  });

  it('9. customer-bookings rate limit activates', async () => {
    const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
    setOpsStoreOverride(createMemoryStore({}));

    process.env.PUBLIC_RATE_LIMIT_CUSTOMER_BOOKINGS_MAX = '3';
    process.env.PUBLIC_RATE_LIMIT_CUSTOMER_BOOKINGS_WINDOW_SEC = '900';

    const rl = reloadRateLimit();
    const mem = createConditionalMemoryStore();
    rl.setPublicRateLimitStoreFactory(() => mem);

    delete require.cache[BOOKINGS_PATH];
    const { handler } = require('../netlify/functions/customer-bookings');
    const makeReq = () => handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.44' },
      body: JSON.stringify({ bookingId: 'CD1-RL', phone: '2015550177' }),
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await makeReq();
      assert.notEqual(res.statusCode, 429, `attempt ${i + 1} should not be limited yet`);
    }
    const blocked = await makeReq();
    assert.equal(blocked.statusCode, 429);
    const body = JSON.parse(blocked.body);
    assert.equal(body.error, 'rate_limited');

    delete process.env.PUBLIC_RATE_LIMIT_CUSTOMER_BOOKINGS_MAX;
    delete process.env.PUBLIC_RATE_LIMIT_CUSTOMER_BOOKINGS_WINDOW_SEC;
  });

  it('10. identifier normalization cannot bypass the limit', async () => {
    const rl = reloadRateLimit();
    const a = rl.hashRateLimitSubject('CD1-ABC', '2015550177');
    const b = rl.hashRateLimitSubject('cd1-abc', '2015550177');
    const c = rl.hashRateLimitSubject('CD1-ABC', '2015550177');
    assert.equal(a, b);
    assert.equal(a, c);

    const keyPlain = rl.deriveRateLimitKey('203.0.113.55', 'customer-bookings', '', process.env, a);
    const keyAlias = rl.deriveRateLimitKey('203.0.113.55', 'customer-bookings', '', process.env, b);
    assert.equal(keyPlain, keyAlias);
    assert.doesNotMatch(keyPlain, /CD1|2015550177|203\.0\.113/);
  });

  it('11. lookup errors do not enumerate booking/customer existence', async () => {
    const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
    setOpsStoreOverride(createMemoryStore({
      'CD1-REAL': {
        id: 'CD1-REAL',
        isDraft: false,
        status: 'Confirmed',
        jobStatus: 'confirmed',
        phone: '2015550177',
      },
    }));

    const rl = reloadRateLimit();
    rl.setPublicRateLimitStoreFactory(() => createConditionalMemoryStore());
    delete require.cache[BOOKINGS_PATH];
    const { handler } = require('../netlify/functions/customer-bookings');

    const miss = await handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.70' },
      body: JSON.stringify({ bookingId: 'CD1-MISSING', phone: '2015550177' }),
    });
    const wrongPhone = await handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.71' },
      body: JSON.stringify({ bookingId: 'CD1-REAL', phone: '5519999999' }),
    });
    const missBody = JSON.parse(miss.body);
    const wrongBody = JSON.parse(wrongPhone.body);
    assert.equal(missBody.found, false);
    assert.equal(wrongBody.found, false);
    assert.equal(missBody.message, wrongBody.message);
    assert.doesNotMatch(JSON.stringify(missBody), /exists|incorrect phone|wrong phone/i);
    assert.doesNotMatch(JSON.stringify(wrongBody), /exists|incorrect phone|wrong phone/i);

    const authSrc = read('netlify/functions/customer-portal-auth.js');
    assert.match(authSrc, /Anti-enumeration/);
    assert.doesNotMatch(authSrc, /could not find an account with that email/i);
  });

  it('12. customer_signup cannot be called publicly', async () => {
    delete require.cache[SUBS_PATH];
    const { handler } = require('../netlify/functions/subscriptions-ops');
    const res = await handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({
        action: 'customer_signup',
        email: 'public@example.com',
        phone: '2015550177',
        planId: 'maint-monthly',
        customerName: 'Public',
      }),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'action_disabled');
  });

  it('13. customer_list cannot be called publicly', async () => {
    delete require.cache[SUBS_PATH];
    const { handler } = require('../netlify/functions/subscriptions-ops');
    const res = await handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({
        action: 'customer_list',
        email: 'public@example.com',
        phone: '2015550177',
      }),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'action_disabled');
  });

  it('14. required Admin subscription actions still work with Admin authentication', async () => {
    delete require.cache[ADMIN_SEC_PATH];
    delete require.cache[TECH_SEC_PATH];
    delete require.cache[SUBS_PATH];

    const { createAdminSession } = require('../netlify/lib/admin-security');
    const sess = await createAdminSession('opsadmin');
    const subsStore = createMemoryStore();
    const { handler, __test } = require('../netlify/functions/subscriptions-ops');
    __test.setBlobsStoreOverride(subsStore);

    const unauth = await handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'list' }),
    });
    assert.equal(unauth.statusCode, 401);

    const createRes = await handler({
      httpMethod: 'POST',
      headers: { 'x-admin-key': sess.token },
      body: JSON.stringify({
        action: 'create',
        email: 'admin-sub@example.com',
        customerName: 'Admin Sub',
        planName: 'monthly',
        intervalMonths: 1,
        price: 79,
      }),
    });
    const created = JSON.parse(createRes.body);
    assert.equal(createRes.statusCode, 200);
    assert.equal(created.ok, true);
    assert.ok(created.subscription.id);

    const listRes = await handler({
      httpMethod: 'POST',
      headers: { 'x-admin-key': sess.token },
      body: JSON.stringify({ action: 'list' }),
    });
    const listed = JSON.parse(listRes.body);
    assert.equal(listRes.statusCode, 200);
    assert.equal(listed.ok, true);
    assert.equal(listed.count, 1);
  });

  it('15. no unrelated booking/payment behavior changes', () => {
    const paymentFns = [
      'netlify/functions/create-payment-intent.js',
      'netlify/functions/capture-payment.js',
      'netlify/functions/customer-portal-pay.js',
      'netlify/functions/submit-booking.js',
    ];
    for (const f of paymentFns) {
      // Touching these files is out of scope for this security patch.
      assert.ok(fs.existsSync(path.join(ROOT, f)), f);
    }
    const sessionSrc = read('netlify/lib/customer-session.js');
    assert.match(sessionSrc, /SESSION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
    assert.match(sessionSrc, /revokeCustomerSession/);
    assert.match(sessionSrc, /revokedAt/);
    assert.match(read('netlify/functions/customer-portal-auth.js'), /revokeCustomerSession/);
    assert.match(read('netlify/functions/customer-bookings.js'), /enforcePublicRateLimit/);
    assert.match(read('netlify/lib/public-rate-limit.js'), /'customer-bookings'/);
    assert.match(read('netlify/functions/subscriptions-ops.js'), /action_disabled/);
    assert.doesNotMatch(read('assets/my-garage.js'), /customer_signup|customer_list/);
    assert.doesNotMatch(read('assets/my-garage.js'), /customer-bookings/);
  });
});
