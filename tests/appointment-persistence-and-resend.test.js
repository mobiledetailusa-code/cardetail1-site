'use strict';

/**
 * Customer appointment persistence + access-link resend.
 *
 * Proves the direct-access exchange durably links a booking to its
 * CustomerAccount (so a portal refresh keeps showing it), that appointment
 * selection is deterministic without hiding owned bookings, and that resend is
 * a distinct, rate-limited, anti-enumerating notification generation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { createIdentityMemoryPrisma } = require('./helpers/identity-memory-prisma');

const ROOT = path.resolve(__dirname, '..');

const MODULES = [
  'netlify/lib/prisma',
  'netlify/lib/tech-security',
  'netlify/lib/ops-db',
  'netlify/lib/booking-repository',
  'netlify/lib/booking-prisma-mirror',
  'netlify/lib/appointment-access-token',
  'netlify/lib/appointment-booking-linkage',
  'netlify/lib/booking-transactional-notifications',
  'netlify/lib/customer-session',
  'netlify/lib/public-rate-limit',
  'netlify/lib/customer-account-service',
  'netlify/functions/customer-appointment-access',
  'netlify/functions/customer-portal-data',
];

function bust() {
  for (const rel of MODULES) {
    delete require.cache[require.resolve(path.join(ROOT, rel))];
  }
}

function listableStore(seed = {}) {
  const store = createCasMemoryStore(seed);
  store.list = async () => ({ blobs: [...store._data.keys()].map((key) => ({ key })) });
  return store;
}

function baseBooking(overrides = {}) {
  return {
    isDraft: false,
    firstName: 'Owner',
    lastName: 'Example',
    email: 'owner@example.com',
    phone: '2015550143',
    package: 'Interior Detail',
    preferredTime: '10:00 AM',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    bookingVersion: 1,
    totalPrice: 199,
    ...overrides,
  };
}

/**
 * Boot the real functions against in-memory Blobs + Prisma.
 * Modules are re-required after the seams are installed because several of
 * them destructure their dependencies at load time.
 */
function harness({ bookings = {}, emailFails = false } = {}) {
  bust();

  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = '';
  delete process.env.PUBLIC_RATE_LIMIT_CUSTOMER_APPOINTMENT_ACCESS_RESEND_MAX;
  delete process.env.DEPLOY_URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.BRANCH;

  const bookingsStore = listableStore(bookings);
  const tokenStore = createCasMemoryStore();
  const focusStore = createCasMemoryStore();
  const claimStore = createCasMemoryStore();
  const sessionStore = createCasMemoryStore();
  const rateStore = createCasMemoryStore();
  const prisma = createIdentityMemoryPrisma();

  const techSecurity = require(path.join(ROOT, 'netlify/lib/tech-security'));
  techSecurity.blobsStore = async (name) => {
    if (name === 'cd1-bookings') return bookingsStore;
    if (name === 'cd1-appointment-access-tokens') return tokenStore;
    if (name === 'cd1-appointment-focus-refs') return focusStore;
    if (name === 'cd1-notification-claims') return claimStore;
    return createCasMemoryStore();
  };

  const prismaMod = require(path.join(ROOT, 'netlify/lib/prisma'));
  prismaMod.tryGetPrisma = () => prisma;

  const opsDb = require(path.join(ROOT, 'netlify/lib/ops-db'));
  opsDb.setOpsStoreOverride(bookingsStore);
  const repo = require(path.join(ROOT, 'netlify/lib/booking-repository'));
  repo.setBookingStoreOverride(bookingsStore);

  const accessToken = require(path.join(ROOT, 'netlify/lib/appointment-access-token'));
  accessToken.setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => focusStore,
  });

  const notif = require(path.join(ROOT, 'netlify/lib/booking-transactional-notifications'));
  notif.setNotificationClaimStoreFactory(() => claimStore);

  const cs = require(path.join(ROOT, 'netlify/lib/customer-session'));
  cs.setCustomerSessionStoreFactory(() => sessionStore);

  const rl = require(path.join(ROOT, 'netlify/lib/public-rate-limit'));
  rl.setPublicRateLimitStoreFactory(() => rateStore);

  const emails = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (!String(url).includes('api.resend.com')) throw new Error('unexpected_fetch');
    if (emailFails) {
      return { ok: false, status: 500, text: async () => 'provider down' };
    }
    emails.push({ at: Date.now() });
    return { ok: true, status: 200, json: async () => ({ id: `email_${emails.length}` }) };
  };

  return {
    prisma,
    emails,
    bookingsStore,
    tokenStore,
    accessToken,
    notif,
    cs,
    accountService: require(path.join(ROOT, 'netlify/lib/customer-account-service')),
    linkage: require(path.join(ROOT, 'netlify/lib/appointment-booking-linkage')),
    accessFn: require(path.join(ROOT, 'netlify/functions/customer-appointment-access')),
    portalFn: require(path.join(ROOT, 'netlify/functions/customer-portal-data')),
    restore() {
      global.fetch = originalFetch;
      opsDb.setOpsStoreOverride(null);
      repo.setBookingStoreOverride(null);
      accessToken.resetAppointmentAccessStoreFactories();
      notif.resetNotificationClaimStoreFactory();
      cs.resetCustomerSessionStoreFactory();
      rl.resetPublicRateLimitStoreFactory();
      bust();
    },
  };
}

async function exchange(h, token, ip = '203.0.113.10') {
  return h.accessFn.handler({
    httpMethod: 'GET',
    headers: { 'x-nf-client-connection-ip': ip },
    queryStringParameters: { token },
  });
}

function sessionTokenFrom(response) {
  const setCookie = String(response.headers?.['Set-Cookie'] || '');
  if (!setCookie) return null;
  return setCookie.split(';')[0].split('=').slice(1).join('=');
}

async function portal(h, sessionToken, body = {}, ip = '203.0.113.10') {
  const res = await h.portalFn.handler({
    httpMethod: 'POST',
    headers: {
      cookie: `cd1_customer_session=${sessionToken}`,
      'content-type': 'application/json',
      'x-nf-client-connection-ip': ip,
    },
    body: JSON.stringify({ mode: 'account', ...body }),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

async function resend(h, token, ip = '203.0.113.11') {
  return h.accessFn.handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': ip },
    body: JSON.stringify({ action: 'resend', token }),
  });
}

async function mint(h, bookingId, extra = {}) {
  return h.accessToken.createAppointmentAccessToken({
    bookingId,
    email: 'owner@example.com',
    phoneDigits: '2015550143',
    eventType: 'booking.request_received',
    ...extra,
  });
}

test('1. direct-link exchange durably links the booking to a CustomerAccount', async (t) => {
  const h = harness({
    bookings: { 'CD1-LINK00001': baseBooking({ id: 'CD1-LINK00001', preferredDate: '2099-05-01' }) },
  });
  t.after(() => h.restore());

  const before = await h.bookingsStore.get('CD1-LINK00001', { type: 'json' });
  assert.equal(before.customerAccountId, undefined);

  const minted = await mint(h, 'CD1-LINK00001');
  const res = await exchange(h, minted.token);
  assert.equal(res.statusCode, 302);

  const after = await h.bookingsStore.get('CD1-LINK00001', { type: 'json' });
  assert.ok(after.customerAccountId, 'blob aggregate carries the account link');
  assert.ok(after.bookingVersion > before.bookingVersion, 'link is a versioned write');

  const row = await h.prisma.booking.findUnique({
    where: { id: 'CD1-LINK00001' },
    select: { customerAccountId: true },
  });
  assert.equal(row.customerAccountId, after.customerAccountId);
});

test('2/3/4. refresh returns the new booking, keeps the old one, and selects deterministically', async (t) => {
  const h = harness({
    bookings: {
      'CD1-OLD000001': baseBooking({
        id: 'CD1-OLD000001',
        preferredDate: '2020-01-10',
        createdAt: '2020-01-01T10:00:00.000Z',
      }),
      'CD1-NEW000002': baseBooking({
        id: 'CD1-NEW000002',
        preferredDate: '2099-09-20',
        createdAt: '2099-01-01T10:00:00.000Z',
        package: 'Premium Detail',
      }),
    },
  });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-NEW000002');
  const res = await exchange(h, minted.token);
  const sessionToken = sessionTokenFrom(res);
  const focusRef = decodeURIComponent(String(res.headers.Location).split('appointment=')[1]);

  const focused = await portal(h, sessionToken, { appointment: focusRef });
  assert.equal(focused.body.upcoming.id, 'CD1-NEW000002');
  assert.equal(focused.body.focusError, null);

  // Refresh without the focus parameter.
  const refreshed = await portal(h, sessionToken);
  const ids = refreshed.body.bookings.map((b) => b.id);
  assert.ok(ids.includes('CD1-NEW000002'), 'new booking survives refresh');
  assert.ok(ids.includes('CD1-OLD000001'), 'older booking remains accessible');
  assert.equal(refreshed.body.upcoming.id, 'CD1-NEW000002', 'nearest future appointment is selected');

  // Selection is stable across repeated reads.
  const again = await portal(h, sessionToken);
  assert.equal(again.body.upcoming.id, refreshed.body.upcoming.id);
});

test('4b. selection prefers an actionable appointment over a nearer future one', async (t) => {
  const h = harness({
    bookings: {
      'CD1-ACTION001': baseBooking({
        id: 'CD1-ACTION001',
        preferredDate: '2099-12-31',
        jobStatus: 'completed_pending_payment',
        appointmentStatus: 'completed_pending_payment',
      }),
      'CD1-FUTURE002': baseBooking({ id: 'CD1-FUTURE002', preferredDate: '2099-01-05' }),
    },
  });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-FUTURE002');
  const sessionToken = sessionTokenFrom(await exchange(h, minted.token));
  const refreshed = await portal(h, sessionToken);
  assert.equal(refreshed.body.upcoming.id, 'CD1-ACTION001');
  assert.equal(refreshed.body.bookings.length, 2);
});

test('4c. only completed history still yields the most recent appointment', async (t) => {
  const h = harness({
    bookings: {
      'CD1-DONE00001': baseBooking({
        id: 'CD1-DONE00001',
        preferredDate: '2020-01-10',
        status: 'Completed',
        jobStatus: 'completed_paid',
        appointmentStatus: 'completed',
      }),
      'CD1-DONE00002': baseBooking({
        id: 'CD1-DONE00002',
        preferredDate: '2021-06-10',
        status: 'Completed',
        jobStatus: 'completed_paid',
        appointmentStatus: 'completed',
      }),
    },
  });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-DONE00001');
  const sessionToken = sessionTokenFrom(await exchange(h, minted.token));
  const refreshed = await portal(h, sessionToken);
  assert.equal(refreshed.body.upcoming.id, 'CD1-DONE00002');
});

test("5. another customer's booking never appears", async (t) => {
  const h = harness({
    bookings: {
      'CD1-MINE00001': baseBooking({ id: 'CD1-MINE00001', preferredDate: '2099-05-01' }),
      'CD1-THEIR0002': baseBooking({
        id: 'CD1-THEIR0002',
        preferredDate: '2099-05-02',
        email: 'stranger@example.com',
        phone: '2015550999',
      }),
    },
  });
  t.after(() => h.restore());

  const strangerToken = await mint(h, 'CD1-THEIR0002', {
    email: 'stranger@example.com',
    phoneDigits: '2015550999',
  });
  await exchange(h, strangerToken.token, '203.0.113.50');

  const mineToken = await mint(h, 'CD1-MINE00001');
  const sessionToken = sessionTokenFrom(await exchange(h, mineToken.token));
  const refreshed = await portal(h, sessionToken);
  const ids = refreshed.body.bookings.map((b) => b.id);
  assert.deepEqual(ids, ['CD1-MINE00001']);
});

test('6. the same verified email resolves the existing account without duplication', async (t) => {
  const h = harness({
    bookings: {
      'CD1-SAME00001': baseBooking({ id: 'CD1-SAME00001', preferredDate: '2099-05-01' }),
      'CD1-SAME00002': baseBooking({ id: 'CD1-SAME00002', preferredDate: '2099-06-01' }),
    },
  });
  t.after(() => h.restore());

  const first = await mint(h, 'CD1-SAME00001');
  const sessionA = sessionTokenFrom(await exchange(h, first.token));
  const second = await mint(h, 'CD1-SAME00002');
  const sessionB = sessionTokenFrom(await exchange(h, second.token, '203.0.113.12'));

  assert.equal(await h.prisma.customerAccount.count({}), 1);

  const a = await h.bookingsStore.get('CD1-SAME00001', { type: 'json' });
  const b = await h.bookingsStore.get('CD1-SAME00002', { type: 'json' });
  assert.equal(a.customerAccountId, b.customerAccountId);

  const view = await portal(h, sessionB);
  assert.deepEqual(view.body.bookings.map((x) => x.id).sort(), ['CD1-SAME00001', 'CD1-SAME00002']);
  assert.ok(sessionA);
});

test('7. verified phone discovers unlinked legacy bookings but never claimed ones', async (t) => {
  const h = harness({
    bookings: {
      'CD1-CURRENT01': baseBooking({ id: 'CD1-CURRENT01', preferredDate: '2099-05-01' }),
      'CD1-LEGACY002': baseBooking({
        id: 'CD1-LEGACY002',
        preferredDate: '2020-05-01',
        email: '',
      }),
      'CD1-CLAIMED03': baseBooking({
        id: 'CD1-CLAIMED03',
        preferredDate: '2020-06-01',
        email: '',
        customerAccountId: 'acct_other_owner',
      }),
    },
  });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-CURRENT01');
  const sessionToken = sessionTokenFrom(await exchange(h, minted.token));
  const view = await portal(h, sessionToken);
  const ids = view.body.bookings.map((b) => b.id).sort();
  assert.deepEqual(ids, ['CD1-CURRENT01', 'CD1-LEGACY002']);
});

test('8. a booking already linked to another account cannot be reassigned', async (t) => {
  const h = harness({
    bookings: {
      'CD1-OWNED0001': baseBooking({
        id: 'CD1-OWNED0001',
        preferredDate: '2099-05-01',
        customerAccountId: 'acct_existing_owner',
      }),
    },
  });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-OWNED0001');
  const res = await exchange(h, minted.token);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /secure link is invalid/i);
  assert.equal(res.headers['Set-Cookie'], undefined);

  const after = await h.bookingsStore.get('CD1-OWNED0001', { type: 'json' });
  assert.equal(after.customerAccountId, 'acct_existing_owner');

  // Direct linkage is idempotent and refuses cross-account writes.
  const same = await h.linkage.linkBookingToAccountDurably({
    bookingId: 'CD1-OWNED0001',
    customerAccountId: 'acct_existing_owner',
  });
  assert.equal(same.ok, true);
  assert.equal(same.result, h.linkage.LINK_RESULT.ALREADY_LINKED);

  const other = await h.linkage.linkBookingToAccountDurably({
    bookingId: 'CD1-OWNED0001',
    customerAccountId: 'acct_intruder',
  });
  assert.equal(other.ok, false);
  assert.equal(other.result, h.linkage.LINK_RESULT.OWNED_BY_OTHER_ACCOUNT);
});

test('9/10/11/14. consumed-link resend mints a new token, sends once, and supersedes prior tokens', async (t) => {
  const h = harness({
    bookings: { 'CD1-RESEND001': baseBooking({ id: 'CD1-RESEND001', preferredDate: '2099-05-01' }) },
  });
  t.after(() => h.restore());

  // Mirror production: the request-received notification mints the first link.
  const seeded = await h.bookingsStore.get('CD1-RESEND001', { type: 'json' });
  const original = await h.notif.emitBookingNotification(
    seeded,
    h.notif.EVENT_REQUEST_RECEIVED,
    {}
  );
  await h.bookingsStore.setJSON('CD1-RESEND001', original.booking);
  assert.equal(h.emails.length, 1, 'original request-received email sent');

  const minted = { token: original.accessToken };
  await exchange(h, minted.token);
  const tokensBefore = [...h.tokenStore._data.keys()].filter((k) => k.startsWith('tok_')).length;

  const res = await resend(h, minted.token);
  assert.equal(res.statusCode, 200);
  assert.equal(h.emails.length, 2, 'terminal request-received ledger does not suppress resend');

  const tokensAfter = [...h.tokenStore._data.keys()].filter((k) => k.startsWith('tok_')).length;
  assert.ok(tokensAfter > tokensBefore, 'resend created a new access token');

  const records = [...h.tokenStore._data.entries()]
    .filter(([key]) => key.startsWith('tok_'))
    .map(([, entry]) => JSON.parse(entry.value));
  assert.equal(records.filter((r) => !r.consumedAt && !r.revokedAt).length, 1, 'one active token');
  assert.ok(records.some((r) => r.consumedAt), 'consumed token stays consumed');

  const booking = await h.bookingsStore.get('CD1-RESEND001', { type: 'json' });
  const keys = Object.keys(booking.transactionalNotifications || {});
  assert.ok(
    keys.some((k) => k === 'appointment_access.resend:CD1-RESEND001:1:email'),
    'resend uses a dedicated generation-scoped idempotency key'
  );
  assert.equal(booking.appointmentAccessResendGeneration, 1);
});

test('12/13. concurrent resend clicks send once; a later resend may send again', async (t) => {
  const h = harness({
    bookings: { 'CD1-GENER0001': baseBooking({ id: 'CD1-GENER0001', preferredDate: '2099-05-01' }) },
  });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-GENER0001');
  await exchange(h, minted.token);

  await Promise.all([resend(h, minted.token), resend(h, minted.token)]);
  assert.equal(h.emails.length, 1, 'concurrent clicks collapse to a single delivery');

  const booking = await h.bookingsStore.get('CD1-GENER0001', { type: 'json' });
  assert.equal(booking.appointmentAccessResendGeneration, 1);

  // Age the request marker past the cooldown so a new generation is allocated.
  await h.bookingsStore.setJSON('CD1-GENER0001', {
    ...booking,
    appointmentAccessResendRequestedAt: new Date(
      Date.now() - h.linkage.RESEND_GENERATION_COOLDOWN_MS - 5_000
    ).toISOString(),
  });

  await resend(h, minted.token, '203.0.113.13');
  assert.equal(h.emails.length, 2, 'a later legitimate resend delivers again');

  const later = await h.bookingsStore.get('CD1-GENER0001', { type: 'json' });
  assert.equal(later.appointmentAccessResendGeneration, 2);
});

test('15. a failed resend delivery stays retryable within the same generation', async (t) => {
  const h = harness({
    bookings: { 'CD1-RETRY0001': baseBooking({ id: 'CD1-RETRY0001', preferredDate: '2099-05-01' }) },
    emailFails: true,
  });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-RETRY0001');
  await exchange(h, minted.token);

  await resend(h, minted.token);
  const failed = await h.bookingsStore.get('CD1-RETRY0001', { type: 'json' });
  const key = 'appointment_access.resend:CD1-RETRY0001:1:email';
  assert.equal(failed.transactionalNotifications[key].status, 'failed');
  assert.equal(failed.transactionalNotifications[key].retryable, true);
  assert.equal(h.emails.length, 0);

  // Provider recovers; the same generation is retried and now succeeds.
  global.fetch = async (url) => {
    if (!String(url).includes('api.resend.com')) throw new Error('unexpected_fetch');
    h.emails.push({ at: Date.now() });
    return { ok: true, status: 200, json: async () => ({ id: 'email_retry' }) };
  };
  await resend(h, minted.token);
  assert.equal(h.emails.length, 1, 'failed delivery is retried');

  const recovered = await h.bookingsStore.get('CD1-RETRY0001', { type: 'json' });
  assert.equal(recovered.transactionalNotifications[key].status, 'sent');
  assert.equal(recovered.appointmentAccessResendGeneration, 1);
});

test('16. unknown token and unknown booking receive the same generic response', async (t) => {
  const h = harness({
    bookings: { 'CD1-KNOWN0001': baseBooking({ id: 'CD1-KNOWN0001', preferredDate: '2099-05-01' }) },
  });
  t.after(() => h.restore());

  const known = await mint(h, 'CD1-KNOWN0001');
  await exchange(h, known.token);
  const realResend = await resend(h, known.token);

  const unknown = await resend(h, `aat_${'z'.repeat(43)}`, '203.0.113.20');
  const malformed = await resend(h, 'not-a-token', '203.0.113.21');

  assert.equal(unknown.statusCode, realResend.statusCode);
  assert.equal(malformed.statusCode, realResend.statusCode);
  assert.deepEqual(JSON.parse(unknown.body), {
    ...JSON.parse(unknown.body),
    ok: true,
  });
  const realMsg = JSON.parse(realResend.body).message;
  assert.equal(JSON.parse(unknown.body).message, realMsg);
  assert.equal(JSON.parse(malformed.body).message, realMsg);

  // Browser-supplied booking ids and emails are not an accepted proof path.
  const forged = await h.accessFn.handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': '203.0.113.22' },
    body: JSON.stringify({
      action: 'resend',
      bookingId: 'CD1-KNOWN0001',
      email: 'owner@example.com',
    }),
  });
  assert.equal(JSON.parse(forged.body).message, realMsg);
  assert.equal(h.emails.length, 1, 'only the proven resend delivered');
});

test('17. resend is rate limited per booking fingerprint', async (t) => {
  const h = harness({
    bookings: { 'CD1-LIMIT0001': baseBooking({ id: 'CD1-LIMIT0001', preferredDate: '2099-05-01' }) },
  });
  t.after(() => {
    delete process.env.PUBLIC_RATE_LIMIT_CUSTOMER_APPOINTMENT_ACCESS_RESEND_MAX;
    h.restore();
  });
  process.env.PUBLIC_RATE_LIMIT_CUSTOMER_APPOINTMENT_ACCESS_RESEND_MAX = '1';

  const minted = await mint(h, 'CD1-LIMIT0001');
  await exchange(h, minted.token);

  await resend(h, minted.token);
  assert.equal(h.emails.length, 1);

  const booking = await h.bookingsStore.get('CD1-LIMIT0001', { type: 'json' });
  await h.bookingsStore.setJSON('CD1-LIMIT0001', {
    ...booking,
    appointmentAccessResendRequestedAt: new Date(
      Date.now() - h.linkage.RESEND_GENERATION_COOLDOWN_MS - 5_000
    ).toISOString(),
  });

  // Different source IP — the booking fingerprint still throttles the attempt.
  const blocked = await resend(h, minted.token, '203.0.113.90');
  assert.equal(blocked.statusCode, 200, 'rate limiting stays anti-enumerating');
  assert.equal(h.emails.length, 1, 'no additional delivery once throttled');

  const after = await h.bookingsStore.get('CD1-LIMIT0001', { type: 'json' });
  assert.equal(after.appointmentAccessResendGeneration, 1, 'no generation burned while throttled');
});

test('18. resend never leaks raw tokens or PII in logs or responses', async (t) => {
  const h = harness({
    bookings: { 'CD1-PRIVAT001': baseBooking({ id: 'CD1-PRIVAT001', preferredDate: '2099-05-01' }) },
  });
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  console.log = (...args) => lines.push(JSON.stringify(args));
  console.warn = (...args) => lines.push(JSON.stringify(args));
  t.after(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    h.restore();
  });

  const minted = await mint(h, 'CD1-PRIVAT001');
  await exchange(h, minted.token);
  const res = await resend(h, minted.token);

  const logged = lines.join('\n');
  const body = String(res.body);
  for (const haystack of [logged, body]) {
    assert.ok(!haystack.includes(minted.token), 'raw access token absent');
    assert.ok(!haystack.includes('owner@example.com'), 'raw email absent');
    assert.ok(!haystack.includes('2015550143'), 'raw phone absent');
    assert.ok(!haystack.includes('CD1-PRIVAT001'), 'full booking id absent');
  }
  assert.ok(/appointment-access-resend/.test(logged), 'resend trace still emits a correlation line');
  assert.match(body, /correlationId/);
});
