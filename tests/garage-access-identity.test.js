/**
 * My Garage sign-in must not let a known phone or email choose a new inbox,
 * and a token or session for one customer must not open another customer's bookings.
 * Providers and stores here are in-memory. Nothing is sent.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'test-customer-session-secret-32chars!!';
const VICTIM_EMAIL = 'ada@example.com';
const ATTACKER_EMAIL = 'attacker@example.com';
const VICTIM_PHONE = '2015550177';
const ATTACKER_PHONE = '2125550147';

function createJsonStore() {
  const data = new Map();
  let n = 0;
  let failReads = false;
  let failWrites = false;
  return {
    setFailReads(v) { failReads = v; },
    setFailWrites(v) { failWrites = v; },
    async get(key, opts) {
      if (failReads) throw new Error('challenge_read_failed');
      if (!data.has(key)) return null;
      const value = JSON.parse(data.get(key).value);
      return opts && opts.type === 'json' ? value : value;
    },
    async getWithMetadata(key, { type } = {}) {
      if (failReads) throw new Error('challenge_read_failed');
      if (!data.has(key)) return null;
      const entry = data.get(key);
      return { data: type === 'json' ? JSON.parse(entry.value) : entry.value, etag: entry.etag };
    },
    async setJSON(key, value, options = {}) {
      if (failWrites) throw new Error('challenge_write_failed');
      const exists = data.has(key);
      if (options.onlyIfNew && exists) return { modified: false };
      if (options.onlyIfMatch && (!exists || data.get(key).etag !== options.onlyIfMatch)) {
        return { modified: false };
      }
      const etag = `c-${++n}`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
    put(key, value) {
      const etag = `c-${++n}`;
      data.set(key, { value: JSON.stringify(value), etag });
    },
    dump() {
      return [...data.entries()].map(([key, entry]) => ({ key, value: JSON.parse(entry.value) }));
    },
  };
}

function createRateStore() {
  const data = new Map();
  let n = 0;
  return {
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      return { data: type === 'json' ? JSON.parse(entry.value) : entry.value, etag: entry.etag };
    },
    async setJSON(key, value, options = {}) {
      const exists = data.has(key);
      if (options.onlyIfNew && exists) return { modified: false };
      if (options.onlyIfMatch && (!exists || data.get(key).etag !== options.onlyIfMatch)) {
        return { modified: false };
      }
      const etag = `r-${++n}`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
  };
}

function booking(overrides) {
  return {
    id: 'CD1-ADA0001',
    isDraft: false,
    status: 'Confirmed',
    jobStatus: 'confirmed',
    phone: VICTIM_PHONE,
    email: VICTIM_EMAIL,
    firstName: 'Ada',
    customerAccountId: 'acct-ada',
    totalPrice: 180,
    ...overrides,
  };
}

describe('garage access identity', { concurrency: 1 }, () => {
  const envSnap = {};
  let bookings;
  let challenges;
  let sessions;
  let sent;
  let emailDown;
  let previousFetch;
  let logs;

  function installBookings(map) {
    bookings = createJsonStore();
    for (const [key, value] of Object.entries(map)) bookings.put(key, value);
    const ops = require('../netlify/lib/ops-db');
    ops.setOpsStoreOverride(bookings);
  }

  function eventFor(body, { ip = '203.0.113.90', host = '' } = {}) {
    const headers = { 'x-nf-client-connection-ip': ip };
    if (host) headers['x-forwarded-host'] = host;
    return { httpMethod: 'POST', headers, body: JSON.stringify(body || {}) };
  }

  async function start(body, opts) {
    const auth = require('../netlify/functions/customer-portal-auth');
    return auth.handler(eventFor({ action: 'start', ...body }, opts));
  }

  async function verify(challengeId, token, extra = {}) {
    const auth = require('../netlify/functions/customer-portal-auth');
    return auth.handler(eventFor({ action: 'verify', challengeId, token, ...extra }));
  }

  function publicStart(res) {
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  function cookieToken(res) {
    const raw = String(res.headers && res.headers['Set-Cookie'] || '');
    if (!raw.startsWith('cd1_customer_session=')) return '';
    return decodeURIComponent(raw.split(';')[0].slice('cd1_customer_session='.length));
  }

  function sessionPayload(res) {
    const token = cookieToken(res);
    if (!token) return null;
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  }

  function linkFrom(message) {
    const text = String(message.text || '');
    const match = text.match(/https?:\/\/\S+/);
    return match ? match[0] : '';
  }

  beforeEach(() => {
    for (const key of [
      'CUSTOMER_SESSION_SECRET', 'RESEND_API_KEY', 'RESEND_FROM', 'ADMIN_EMAIL',
      'CONTEXT', 'URL', 'PUBLIC_SITE_URL', 'TRUSTED_PUBLIC_SITE_ORIGIN',
      'PRISMA_BOOKING_MIRROR', 'PUBLIC_RATE_LIMIT_CUSTOMER_PORTAL_AUTH_START_MAX',
      'PUBLIC_RATE_LIMIT_CUSTOMER_PORTAL_AUTH_VERIFY_MAX',
    ]) envSnap[key] = process.env[key];

    process.env.CUSTOMER_SESSION_SECRET = SECRET;
    process.env.RESEND_API_KEY = 're_test_not_live';
    process.env.RESEND_FROM = 'Cardetail1 <garage-test@example.com>';
    delete process.env.ADMIN_EMAIL;
    process.env.PRISMA_BOOKING_MIRROR = '0';
    process.env.CONTEXT = 'dev';
    process.env.URL = 'https://cardetail1.com';
    delete process.env.PUBLIC_SITE_URL;
    delete process.env.TRUSTED_PUBLIC_SITE_ORIGIN;

    challenges = createJsonStore();
    sessions = createJsonStore();
    sent = [];
    emailDown = false;
    logs = [];
    installBookings({
      'CD1-ADA0001': booking({}),
      'CD1-ADA0002': booking({ id: 'CD1-ADA0002', totalPrice: 90 }),
      'CD1-BEA0001': booking({
        id: 'CD1-BEA0001',
        email: 'bea@example.com',
        phone: ATTACKER_PHONE,
        firstName: 'Bea',
        customerAccountId: 'acct-bea',
      }),
    });

    const session = require('../netlify/lib/customer-session');
    session.setAuthChallengeStoreFactory(() => challenges);
    session.setCustomerSessionStoreFactory(() => sessions);
    const rl = require('../netlify/lib/public-rate-limit');
    const rateStore = createRateStore();
    rl.setPublicRateLimitStoreFactory(() => rateStore);

    previousFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const target = String(url);
      if (/twilio|api\.twilio/.test(target)) throw new Error('sms_must_not_be_called');
      if (!target.includes('api.resend.com')) throw new Error(`unexpected_fetch:${target}`);
      const payload = JSON.parse(opts.body || '{}');
      sent.push(payload);
      if (emailDown) return { ok: false, status: 500, text: async () => 'down' };
      return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
    };
    const origInfo = console.info;
    console.info = (...args) => {
      logs.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
      origInfo.apply(console, args);
    };
    console.info._orig = origInfo;
  });

  afterEach(() => {
    const ops = require('../netlify/lib/ops-db');
    ops.setOpsStoreOverride(null);
    const session = require('../netlify/lib/customer-session');
    session.resetAuthChallengeStoreFactory();
    session.resetCustomerSessionStoreFactory();
    const rl = require('../netlify/lib/public-rate-limit');
    rl.resetPublicRateLimitStoreFactory();
    global.fetch = previousFetch;
    if (console.info._orig) console.info = console.info._orig;
    for (const [key, value] of Object.entries(envSnap)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('known phone plus attacker email does not deliver that garage', async () => {
    const unknown = publicStart(await start({ email: 'nobody@example.com', phone: '4155550133' }));
    const stolen = publicStart(await start({ email: ATTACKER_EMAIL, phone: VICTIM_PHONE }));
    assert.deepEqual(stolen, unknown);
    assert.equal(stolen.status, 200);
    assert.equal(stolen.body.ok, true);
    assert.equal(stolen.body.customerAccountId, undefined);
    assert.equal(stolen.body.bookingCount, undefined);
    assert.equal(sent.length, 0);
    assert.equal(challenges.dump().some((row) => row.key.startsWith('auth_')), false);
    const raw = JSON.stringify(stolen.body);
    assert.equal(raw.includes('Ada'), false);
    assert.equal(raw.includes(VICTIM_EMAIL), false);
    assert.equal(raw.includes('acct-ada'), false);
  });

  it('known email plus attacker phone does not send or attach the other phone', async () => {
    const res = publicStart(await start({ email: VICTIM_EMAIL, phone: ATTACKER_PHONE }));
    const unknown = publicStart(await start(
      { email: 'nobody@example.com', phone: ATTACKER_PHONE },
      { ip: '203.0.113.91' }
    ));
    assert.deepEqual(res, unknown);
    assert.equal(sent.length, 0);
  });

  it('email of one account and phone of another does not send', async () => {
    const res = publicStart(await start({ email: VICTIM_EMAIL, phone: ATTACKER_PHONE }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(sent.length, 0);
  });

  it('sends the link only to the email already stored on the booking', async () => {
    const res = await start({
      email: '  Ada@Example.com ',
      phone: '+1 (201) 555-0177',
    }, { host: 'evil.example' });
    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [VICTIM_EMAIL]);
    const link = linkFrom(sent[0]);
    assert.match(link, /^https:\/\/cardetail1\.com\/my-garage\.html\?/);
    assert.equal(link.includes('evil.example'), false);
    const url = new URL(link);
    const verified = await verify(url.searchParams.get('auth'), url.searchParams.get('t'), {
      customerAccountId: 'acct-bea',
      email: ATTACKER_EMAIL,
      phone: ATTACKER_PHONE,
      bookingId: 'CD1-BEA0001',
    });
    const payload = sessionPayload(verified);
    assert.equal(verified.statusCode, 200);
    assert.ok(payload.bookingIds.includes('CD1-ADA0001'));
    assert.ok(payload.bookingIds.includes('CD1-ADA0002'));
    assert.equal(payload.bookingIds.includes('CD1-BEA0001'), false);
    assert.notEqual(payload.customerAccountId, 'acct-bea');
    const again = await verify(url.searchParams.get('auth'), url.searchParams.get('t'));
    assert.equal(JSON.parse(again.body).ok, false);
    assert.equal(cookieToken(again), '');
  });

  it('accepts national and E.164 forms of the stored phone', async () => {
    await start({ email: VICTIM_EMAIL, phone: '2015550177' }, { ip: '203.0.113.92' });
    await start({ email: VICTIM_EMAIL, phone: '+12015550177' }, { ip: '203.0.113.93' });
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].to, [VICTIM_EMAIL]);
    assert.deepEqual(sent[1].to, [VICTIM_EMAIL]);
  });

  it('empty identifiers do not send and do not reveal a customer', async () => {
    const empty = publicStart(await start({ email: '   ', phone: '' }));
    const missing = publicStart(await start({ phone: VICTIM_PHONE }, { ip: '203.0.113.94' }));
    assert.equal(empty.status, 400);
    assert.equal(missing.status, 400);
    assert.equal(empty.body.error, 'validation_error');
    assert.deepEqual(empty.body, missing.body);
    assert.equal(sent.length, 0);
  });

  it('missing email and missing phone share the generic start body', async () => {
    const noEmail = publicStart(await start({ email: 'missing@example.com' }, { ip: '198.51.100.10' }));
    const noPhone = publicStart(await start({ email: 'missing@example.com', phone: '' }, { ip: '198.51.100.11' }));
    assert.deepEqual(noEmail, noPhone);
    assert.equal(sent.length, 0);
  });

  it('an account with no live bookings gets the same response and no token', async () => {
    const archivedOnly = publicStart(await start({
      email: 'archived@example.com',
      phone: '2015550199',
    }, { ip: '198.51.100.12' }));
    installBookings({
      'CD1-ARCH0001': booking({
        id: 'CD1-ARCH0001',
        email: 'archived@example.com',
        phone: '2015550199',
        firstName: 'Arch',
        archived: true,
        customerAccountId: 'acct-arch',
      }),
    });
    const archived = publicStart(await start({
      email: 'archived@example.com',
      phone: '2015550199',
    }, { ip: '198.51.100.13' }));
    assert.deepEqual(archived, archivedOnly);
    assert.equal(sent.length, 0);
    assert.equal(JSON.stringify(archived.body).includes('Arch'), false);
  });

  it('rate limit counts the normalized subject and fails closed when the counter store is down', async () => {
    process.env.PUBLIC_RATE_LIMIT_CUSTOMER_PORTAL_AUTH_START_MAX = '2';
    const within = [];
    for (let i = 0; i < 2; i += 1) {
      within.push(publicStart(await start({ email: 'nobody@example.com', phone: '4155550100' })));
    }
    assert.equal(within[0].status, 200);
    assert.deepEqual(within[1], within[0]);
    const blocked = publicStart(await start({ email: 'nobody@example.com', phone: '(415) 555-0100' }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, 'rate_limited');
    const sameWindowOtherPerson = publicStart(await start(
      { email: VICTIM_EMAIL, phone: VICTIM_PHONE },
      { ip: '203.0.113.90' }
    ));
    assert.equal(sameWindowOtherPerson.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [VICTIM_EMAIL]);

    const rl = require('../netlify/lib/public-rate-limit');
    rl.setPublicRateLimitStoreFactory(() => { throw new Error('rate_store_down'); });
    const down = publicStart(await start(
      { email: VICTIM_EMAIL, phone: VICTIM_PHONE },
      { ip: '198.51.100.20' }
    ));
    assert.equal(down.status, 503);
    assert.equal(down.body.error, 'service_unavailable');
    assert.equal(sent.length, 1);
  });

  it('two concurrent starts still address only the stored inbox', async () => {
    const [a, b] = await Promise.all([
      start({ email: VICTIM_EMAIL, phone: VICTIM_PHONE }, { ip: '198.51.100.30' }),
      start({ email: ATTACKER_EMAIL, phone: VICTIM_PHONE }, { ip: '198.51.100.30' }),
    ]);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [VICTIM_EMAIL]);
  });

  it('challenge read failure and write failure do not send', async () => {
    challenges.setFailReads(true);
    const unread = publicStart(await start({ email: VICTIM_EMAIL, phone: VICTIM_PHONE }));
    assert.equal(unread.status, 503);
    assert.equal(sent.length, 0);
    challenges.setFailReads(false);
    challenges.setFailWrites(true);
    const unwritten = publicStart(await start(
      { email: VICTIM_EMAIL, phone: VICTIM_PHONE },
      { ip: '198.51.100.40' }
    ));
    const unknown = publicStart(await start(
      { email: 'nobody@example.com', phone: '4155550166' },
      { ip: '198.51.100.41' }
    ));
    assert.equal(unwritten.status, 200);
    assert.deepEqual(unwritten.body, unknown.body);
    assert.equal(sent.length, 0);
  });

  it('email provider failure burns the token and matches the generic response', async () => {
    emailDown = true;
    const failed = publicStart(await start({ email: VICTIM_EMAIL, phone: VICTIM_PHONE }));
    emailDown = false;
    const unknown = publicStart(await start(
      { email: 'nobody@example.com' },
      { ip: '198.51.100.42' }
    ));
    assert.deepEqual(failed, unknown);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [VICTIM_EMAIL]);
    const link = linkFrom(sent[0]);
    const url = new URL(link);
    const verified = await verify(url.searchParams.get('auth'), url.searchParams.get('t'));
    assert.equal(JSON.parse(verified.body).ok, false);
    assert.equal(cookieToken(verified), '');
  });

  it('does not call an SMS provider for a phone-only or mismatched request', async () => {
    await start({ email: ATTACKER_EMAIL, phone: VICTIM_PHONE }, { ip: '198.51.100.43' });
    await start({ email: VICTIM_EMAIL, phone: VICTIM_PHONE }, { ip: '198.51.100.44' });
    assert.equal(sent.every((message) => message.to[0] === VICTIM_EMAIL), true);
    assert.equal(logs.join('\n').includes(VICTIM_EMAIL), false);
    assert.equal(logs.join('\n').includes('auth_'), false);
  });

  it('rejects expired, invalid, tampered, foreign-purpose, and foreign-environment tokens', async () => {
    await start({ email: VICTIM_EMAIL, phone: VICTIM_PHONE }, { ip: '198.51.100.50' });
    const url = new URL(linkFrom(sent[0]));
    const id = url.searchParams.get('auth');
    const token = url.searchParams.get('t');
    const bad = await verify(id, `${token}x`);
    assert.equal(JSON.parse(bad.body).ok, false);
    assert.equal(cookieToken(bad), '');

    const stored = (await challenges.getWithMetadata(id, { type: 'json' })).data;
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    await challenges.setJSON(id, stored);
    const expired = await verify(id, token);
    assert.equal(JSON.parse(expired.body).error, 'authentication_failed');
    assert.equal(cookieToken(expired), '');

    stored.expiresAt = new Date(Date.now() + 60_000).toISOString();
    stored.type = 'otp';
    await challenges.setJSON(id, stored);
    const otherPurpose = await verify(id, token);
    assert.equal(JSON.parse(otherPurpose.body).ok, false);

    stored.type = 'magic_link';
    stored.envBinding = 'production';
    await challenges.setJSON(id, stored);
    const foreignEnv = await verify(id, token);
    assert.equal(JSON.parse(foreignEnv.body).ok, false);
    assert.equal(cookieToken(foreignEnv), '');
  });

  it('a valid session opens only its own bookings', async () => {
    const auth = require('../netlify/lib/booking-customer-auth');
    const sessionLib = require('../netlify/lib/customer-session');
    const { token } = await sessionLib.createAccountSession({
      phoneDigits: VICTIM_PHONE,
      email: ATTACKER_EMAIL,
      bookingIds: ['CD1-BEA0001'],
      customerAccountId: 'acct-attacker',
    });
    const unlinkedVictim = booking({ customerAccountId: null, id: 'CD1-ADA0001' });
    installBookings({ 'CD1-ADA0001': unlinkedVictim });
    const cross = await auth.authorizeBookingAccess(
      { headers: { cookie: `cd1_customer_session=${encodeURIComponent(token)}` } },
      { bookingId: 'CD1-ADA0001', phone: ATTACKER_PHONE, customerAccountId: 'acct-ada' }
    );
    assert.equal(cross.ok, false);

    const own = await sessionLib.createAccountSession({
      phoneDigits: VICTIM_PHONE,
      email: VICTIM_EMAIL,
      bookingIds: ['CD1-ADA0001', 'CD1-ADA0002'],
      customerAccountId: 'acct-ada',
    });
    installBookings({
      'CD1-ADA0001': booking({}),
      'CD1-BEA0001': booking({
        id: 'CD1-BEA0001',
        email: 'bea@example.com',
        phone: VICTIM_PHONE,
        customerAccountId: 'acct-bea',
        firstName: 'Bea',
      }),
    });
    const allowed = await auth.authorizeBookingAccess(
      { headers: { cookie: `cd1_customer_session=${encodeURIComponent(own.token)}` } },
      { bookingId: 'CD1-ADA0001', phone: ATTACKER_PHONE, email: ATTACKER_EMAIL }
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.booking.id, 'CD1-ADA0001');
    const denied = await auth.authorizeBookingAccess(
      { headers: { cookie: `cd1_customer_session=${encodeURIComponent(own.token)}` } },
      {
        bookingId: 'CD1-BEA0001',
        phone: VICTIM_PHONE,
        email: ATTACKER_EMAIL,
        customerAccountId: 'acct-bea',
      }
    );
    assert.equal(denied.ok, false);
  });

  it('preview and branch deploys do not mint a token or send mail on the shared store', async () => {
    const session = require('../netlify/lib/customer-session');
    session.resetAuthChallengeStoreFactory();
    process.env.CONTEXT = 'deploy-preview';
    const preview = publicStart(await start({ email: VICTIM_EMAIL, phone: VICTIM_PHONE }));
    process.env.CONTEXT = 'branch-deploy';
    process.env.BRANCH = 'cursor/garage-uniform-lookup-62a8';
    const branch = publicStart(await start(
      { email: VICTIM_EMAIL, phone: VICTIM_PHONE },
      { ip: '198.51.100.60' }
    ));
    assert.equal(preview.status, 403);
    assert.equal(preview.body.error, 'preview_writes_disabled');
    assert.equal(preview.body.sent, false);
    assert.deepEqual(preview.body, branch.body);
    assert.equal(sent.length, 0);
  });

  it('limited lookup still requires the booking phone and hides an archived record', async () => {
    installBookings({
      'CD1-ADA0001': booking({}),
      'CD1-ARCH0001': booking({
        id: 'CD1-ARCH0001',
        archived: true,
        firstName: 'Arch',
        email: 'arch@example.com',
      }),
    });
    const lookup = require('../netlify/functions/lookup-booking');
    const opened = await lookup.handler(eventFor({
      bookingId: 'CD1-ADA0001',
      phone: VICTIM_PHONE,
      email: ATTACKER_EMAIL,
    }));
    const openedBody = JSON.parse(opened.body);
    assert.equal(openedBody.ok, true);
    assert.equal(openedBody.booking.id, 'CD1-ADA0001');
    assert.equal(JSON.stringify(openedBody).includes(ATTACKER_EMAIL), false);

    const archived = await lookup.handler(eventFor({
      bookingId: 'CD1-ARCH0001',
      phone: VICTIM_PHONE,
      email: ATTACKER_EMAIL,
    }, { ip: '198.51.100.70' }));
    const archivedBody = JSON.parse(archived.body);
    assert.equal(archived.statusCode, 200);
    assert.equal(archivedBody.ok, false);
    assert.equal(archivedBody.booking, undefined);
    assert.equal(JSON.stringify(archivedBody).includes('Arch'), false);
  });
});
