/**
 * Limited My Garage lookup must not tell an attacker which of these failed:
 * missing booking, wrong phone, unlinked account, invalid id, or a repeat.
 * A draft is reported as not ready only after the phone already matches.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TEST_SESSION_SECRET = 'test-customer-session-secret-32chars!!';

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  return {
    async get(key, opts) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      return opts && opts.type === 'json' ? structuredClone(v) : v;
    },
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return { data: type === 'json' ? structuredClone(value) : value, etag: `etag-${key}`, metadata: {} };
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value));
      return { modified: true, etag: `etag-${key}` };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
    async delete(key) { data.delete(key); },
  };
}

function createConditionalMemoryStore() {
  const data = new Map();
  let n = 0;
  return {
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const e = data.get(key);
      return { data: type === 'json' ? JSON.parse(e.value) : e.value, etag: e.etag, metadata: {} };
    },
    async setJSON(key, value, options = {}) {
      const exists = data.has(key);
      if (options.onlyIfNew && exists) return { modified: false };
      if (options.onlyIfMatch && (!exists || data.get(key).etag !== options.onlyIfMatch)) {
        return { modified: false };
      }
      const etag = `etag-${++n}`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
  };
}

function liveBooking() {
  return {
    id: 'CD1-LIVE0001',
    isDraft: false,
    status: 'Confirmed',
    jobStatus: 'confirmed',
    phone: '2015550177',
    firstName: 'Ada',
    email: 'ada@example.com',
    customerAccountId: 'acct-live',
    totalPrice: 180,
  };
}

function otherBooking() {
  return {
    id: 'CD1-OTHER002',
    isDraft: false,
    status: 'Confirmed',
    jobStatus: 'confirmed',
    phone: '2125550147',
    firstName: 'Bea',
    email: 'bea@example.com',
    customerAccountId: 'acct-other',
    totalPrice: 240,
  };
}

function draftBooking() {
  return {
    id: 'CD1-DRAFT009',
    isDraft: true,
    status: 'saved',
    phone: '2015550177',
    firstName: 'Ada',
    email: 'ada@example.com',
    totalPrice: 90,
  };
}

function noPhoneBooking() {
  return {
    id: 'CD1-NOPHONE1',
    isDraft: false,
    status: 'Confirmed',
    jobStatus: 'confirmed',
    firstName: 'Cara',
    email: 'cara@example.com',
    totalPrice: 70,
  };
}

function eventFor(body, { token, ip = '203.0.113.40' } = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      cookie: token ? `cd1_customer_session=${encodeURIComponent(token)}` : '',
      'x-nf-client-connection-ip': ip,
    },
    body: JSON.stringify(body || {}),
  };
}

describe('limited lookup uniform response', { concurrency: 1 }, () => {
  let prevSecret;
  let sessionStore;

  beforeEach(() => {
    prevSecret = process.env.CUSTOMER_SESSION_SECRET;
    process.env.CUSTOMER_SESSION_SECRET = TEST_SESSION_SECRET;
    sessionStore = createMemoryStore();
    const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
    setOpsStoreOverride(createMemoryStore({
      'CD1-LIVE0001': liveBooking(),
      'CD1-OTHER002': otherBooking(),
      'CD1-DRAFT009': draftBooking(),
      'CD1-NOPHONE1': noPhoneBooking(),
    }));
    const session = require('../netlify/lib/customer-session');
    session.setCustomerSessionStoreFactory(() => sessionStore);
  });

  afterEach(() => {
    const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
    setOpsStoreOverride(null);
    const session = require('../netlify/lib/customer-session');
    session.resetCustomerSessionStoreFactory();
    const rl = require('../netlify/lib/public-rate-limit');
    rl.resetPublicRateLimitStoreFactory();
    delete process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX;
    delete process.env.PUBLIC_RATE_LIMIT_CUSTOMER_BOOKINGS_MAX;
    if (prevSecret == null) delete process.env.CUSTOMER_SESSION_SECRET;
    else process.env.CUSTOMER_SESSION_SECRET = prevSecret;
  });

  function publicShape(res) {
    const body = JSON.parse(res.body);
    return {
      statusCode: res.statusCode,
      keys: Object.keys(body).sort(),
      body,
    };
  }

  function assertUniformMiss(res, label) {
    const parsed = publicShape(res);
    assert.equal(parsed.statusCode, 200, label);
    assert.deepEqual(parsed.keys, ['error', 'found', 'message', 'ok'], label);
    assert.equal(parsed.body.ok, false, label);
    assert.equal(parsed.body.found, false, label);
    assert.equal(parsed.body.error, 'authentication_failed', label);
    assert.equal(
      parsed.body.message,
      'No booking found. Please check your booking ID and phone number.',
      label
    );
    const raw = JSON.stringify(parsed.body);
    assert.equal(raw.includes('2015550177'), false, label);
    assert.equal(raw.includes('2125550147'), false, label);
    assert.equal(raw.includes('ada@'), false, label);
    assert.equal(raw.includes('bea@'), false, label);
    assert.equal(raw.includes('Ada'), false, label);
    assert.equal(raw.includes('Bea'), false, label);
    assert.equal(raw.includes('Cara'), false, label);
    assert.equal(raw.includes('phone_mismatch'), false, label);
    assert.equal(raw.includes('unlinked_account'), false, label);
    assert.equal(raw.includes('booking_not_found'), false, label);
    assert.equal(raw.includes('phone_not_on_file'), false, label);
    return parsed.body;
  }

  async function sessionToken(account) {
    const session = require('../netlify/lib/customer-session');
    const { token } = await session.createAccountSession({
      phoneDigits: account.phoneDigits,
      email: account.email,
      bookingIds: account.bookingIds,
      customerAccountId: account.customerAccountId,
    });
    return token;
  }

  it('lookup-booking uses one body for missing, wrong phone, invalid id, and a repeat', async () => {
    const lookup = require('../netlify/functions/lookup-booking');
    const cases = [
      { bookingId: 'CD1-MISSING9', phone: '2015550177' },
      { bookingId: 'CD1-LIVE0001', phone: '2125550147' },
      { bookingId: 'CD1-DRAFT009', phone: '2125550147' },
      { bookingId: 'CD1-NOPHONE1', phone: '2015550177' },
      { bookingId: '', phone: '2015550177' },
      { bookingId: '!!!', phone: '2015550177' },
      { bookingId: 'CD1-LIVE0001', phone: '123' },
      { bookingId: 'CD1-LIVE0001', phone: '' },
    ];
    const bodies = [];
    for (const body of cases) {
      const res = await lookup.handler(eventFor(body, { ip: '203.0.113.41' }));
      bodies.push(assertUniformMiss(res, JSON.stringify(body)));
    }
    const again = await lookup.handler(eventFor(cases[0], { ip: '203.0.113.41' }));
    assert.deepEqual(assertUniformMiss(again, 'repeat'), bodies[0]);
    for (const body of bodies.slice(1)) assert.deepEqual(body, bodies[0]);
  });

  it('customer-bookings uses the same public miss as lookup-booking', async () => {
    const lookup = require('../netlify/functions/lookup-booking');
    const bookings = require('../netlify/functions/customer-bookings');
    const body = { bookingId: 'CD1-LIVE0001', phone: '2125550199' };
    const a = assertUniformMiss(
      await lookup.handler(eventFor(body, { ip: '203.0.113.42' })),
      'lookup'
    );
    const b = assertUniformMiss(
      await bookings.handler(eventFor(body, { ip: '203.0.113.43' })),
      'bookings'
    );
    assert.deepEqual(a, b);
    const invalid = assertUniformMiss(
      await bookings.handler(eventFor({ bookingId: 'nope', phone: '12' }, { ip: '203.0.113.43' })),
      'invalid'
    );
    assert.deepEqual(invalid, a);
  });

  it('a matching phone still opens a submitted booking and hides a draft until the phone matches', async () => {
    const lookup = require('../netlify/functions/lookup-booking');
    const bookings = require('../netlify/functions/customer-bookings');
    const opened = await lookup.handler(eventFor(
      { bookingId: 'cd1-live0001', phone: '(201) 555-0177' },
      { ip: '203.0.113.44' }
    ));
    const openedBody = JSON.parse(opened.body);
    assert.equal(opened.statusCode, 200);
    assert.equal(openedBody.ok, true);
    assert.equal(openedBody.booking.id, 'CD1-LIVE0001');

    const listed = await bookings.handler(eventFor(
      { bookingId: 'CD1-LIVE0001', phone: '2015550177' },
      { ip: '203.0.113.45' }
    ));
    const listedBody = JSON.parse(listed.body);
    assert.equal(listed.statusCode, 200);
    assert.equal(listedBody.ok, true);
    assert.equal(listedBody.count, 1);
    assert.equal(listedBody.bookings[0].id, 'CD1-LIVE0001');

    const draft = await lookup.handler(eventFor(
      { bookingId: 'CD1-DRAFT009', phone: '2015550177' },
      { ip: '203.0.113.46' }
    ));
    const draftBody = JSON.parse(draft.body);
    assert.equal(draft.statusCode, 200);
    assert.equal(draftBody.found, false);
    assert.equal(draftBody.error, 'booking_not_ready');
    assert.equal(JSON.stringify(draftBody).includes('Ada'), false);
  });

  it('portal limited mode collapses existence, phone, unlink, and invalid id', async () => {
    const portal = require('../netlify/functions/customer-portal-data');
    const token = await sessionToken({
      phoneDigits: '2015550177',
      email: 'ada@example.com',
      bookingIds: ['CD1-LIVE0001'],
      customerAccountId: 'acct-live',
    });
    const cases = [
      { body: { mode: 'limited', bookingId: 'CD1-MISSING9', phone: '2015550177' } },
      { body: { mode: 'limited', bookingId: 'CD1-LIVE0001', phone: '2125550147' } },
      { body: { mode: 'limited', bookingId: 'CD1-NOPHONE1', phone: '2015550177' } },
      { body: { mode: 'limited', bookingId: '', phone: '2015550177' } },
      { body: { mode: 'limited', bookingId: 'CD1-LIVE0001', phone: '55' } },
      {
        body: {
          mode: 'limited',
          bookingId: 'CD1-OTHER002',
          phone: '2125550147',
          customerAccountId: 'acct-other',
          browserCustomerAccountId: 'acct-other',
        },
        token,
      },
      {
        body: {
          mode: 'limited',
          bookingId: 'CD1-OTHER002',
          phone: '2015550177',
          customerAccountId: 'acct-other',
        },
      },
    ];
    const bodies = [];
    for (const item of cases) {
      const res = await portal.handler(eventFor(item.body, {
        token: item.token,
        ip: '203.0.113.47',
      }));
      bodies.push(assertUniformMiss(res, JSON.stringify(item.body)));
    }
    for (const body of bodies.slice(1)) assert.deepEqual(body, bodies[0]);

    const again = await portal.handler(eventFor(cases[0].body, { ip: '203.0.113.48' }));
    assert.deepEqual(assertUniformMiss(again, 'repeat'), bodies[0]);
  });

  it('a browser account id does not select another booking when the phone matches', async () => {
    const portal = require('../netlify/functions/customer-portal-data');
    const res = await portal.handler(eventFor({
      mode: 'limited',
      bookingId: 'CD1-LIVE0001',
      phone: '2015550177',
      customerAccountId: 'acct-other',
      browserCustomerAccountId: 'acct-other',
    }, { ip: '203.0.113.49' }));
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.booking.id, 'CD1-LIVE0001');
    assert.equal(JSON.stringify(body).includes('Bea'), false);
    assert.equal(JSON.stringify(body).includes('acct-other'), false);
  });

  it('draft with the matching phone stays not-ready on the portal', async () => {
    const portal = require('../netlify/functions/customer-portal-data');
    const res = await portal.handler(eventFor({
      mode: 'limited',
      bookingId: 'CD1-DRAFT009',
      phone: '2015550177',
    }, { ip: '203.0.113.50' }));
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'booking_not_ready');
    assert.equal(JSON.stringify(body).includes('Ada'), false);
  });

  it('account mode still asks the customer to sign in', async () => {
    const portal = require('../netlify/functions/customer-portal-data');
    const res = await portal.handler(eventFor({
      mode: 'account',
      bookingId: 'CD1-LIVE0001',
    }, { ip: '203.0.113.51' }));
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 401);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'authentication_failed');
    assert.equal(body.message, 'Sign in required.');
  });

  it('rate limit stays a distinct 429 and does not look like a miss', async () => {
    process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '1';
    process.env.PUBLIC_RATE_LIMIT_CUSTOMER_BOOKINGS_MAX = '1';
    const rl = require('../netlify/lib/public-rate-limit');
    rl.setPublicRateLimitStoreFactory(() => createConditionalMemoryStore());
    const lookup = require('../netlify/functions/lookup-booking');
    const bookings = require('../netlify/functions/customer-bookings');
    const portal = require('../netlify/functions/customer-portal-data');
    const miss = { bookingId: 'CD1-MISSING9', phone: '2015550177' };

    const firstLookup = await lookup.handler(eventFor(miss, { ip: '203.0.113.60' }));
    assertUniformMiss(firstLookup, 'lookup first');
    const blockedLookup = await lookup.handler(eventFor(miss, { ip: '203.0.113.60' }));
    assert.equal(blockedLookup.statusCode, 429);
    const blockedLookupBody = JSON.parse(blockedLookup.body);
    assert.equal(blockedLookupBody.error, 'rate_limited');
    assert.equal(blockedLookupBody.found, undefined);

    const firstBookings = await bookings.handler(eventFor(miss, { ip: '203.0.113.61' }));
    assertUniformMiss(firstBookings, 'bookings first');
    const blockedBookings = await bookings.handler(eventFor(miss, { ip: '203.0.113.61' }));
    assert.equal(blockedBookings.statusCode, 429);
    assert.equal(JSON.parse(blockedBookings.body).error, 'rate_limited');

    const firstPortal = await portal.handler(eventFor(
      { mode: 'limited', ...miss },
      { ip: '203.0.113.62' }
    ));
    assertUniformMiss(firstPortal, 'portal first');
    const blockedPortal = await portal.handler(eventFor(
      { mode: 'limited', ...miss },
      { ip: '203.0.113.62' }
    ));
    assert.equal(blockedPortal.statusCode, 429);
    assert.equal(JSON.parse(blockedPortal.body).error, 'rate_limited');
    assert.equal(JSON.parse(blockedPortal.body).message, undefined);
  });
});
