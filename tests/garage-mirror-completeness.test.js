'use strict';

/**
 * R8 — a capped Postgres mirror must not hide a submitted booking that still
 * lives only in Blobs, and must not invent a second copy of one that lives in
 * both. A true draft stays out of My Garage. A failed blob read stays incomplete
 * so a cold portal load can tell a short list from a finished one.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const ROOT = path.resolve(__dirname, '..');
const PRISMA_PATH = require.resolve('../netlify/lib/prisma');
const HISTORY_PATH = require.resolve('../netlify/lib/booking-history');
const MIRROR_PATH = require.resolve('../netlify/lib/booking-prisma-mirror');
const OPS_PATH = require.resolve('../netlify/lib/ops-db');
const SESSION_PATH = require.resolve('../netlify/lib/customer-session');
const RATE_PATH = require.resolve('../netlify/lib/public-rate-limit');
const PORTAL_PATH = require.resolve('../netlify/functions/customer-portal-data');

const PHONE = '2015550148';
const EMAIL = 'garage-mirror@example.com';
const SESSION_SECRET = 'test-customer-session-secret-32chars!!';

const MIRROR = {
  id: 'CD1-MIRROR',
  sourceTag: 'mirror',
  isDraft: false,
  kind: 'booking',
  phone: '(201) 555-0148',
  email: EMAIL,
  status: 'Confirmed',
  jobStatus: 'confirmed',
  package: 'Mirror Newer Detail',
  preferredDate: '2026-09-20',
  confirmedDate: '2026-09-20',
  finalizedAt: '2026-09-01T15:00:00.000Z',
  bookingVersion: 2,
  appointmentPublicRef: 'aptr_mirrornewermirror',
  updatedAt: '2026-09-01T15:00:00.000Z',
};

const MIRROR_BLOB = {
  ...MIRROR,
  sourceTag: 'blob',
};

const BLOB_ONLY = {
  id: 'CD1-BLOBONLY',
  isDraft: false,
  kind: 'booking',
  phone: '(201) 555-0148',
  email: EMAIL,
  status: 'Paid',
  jobStatus: 'completed_paid',
  paymentStatus: 'paid',
  package: 'Blob Older Detail',
  preferredDate: '2026-05-02',
  confirmedDate: '2026-05-02',
  finalizedAt: '2026-05-01T15:00:00.000Z',
  bookingVersion: 1,
  appointmentPublicRef: 'aptr_blobolderblobolder',
  updatedAt: '2026-05-02T15:00:00.000Z',
  totalPrice: 215,
  approvedFinalAmount: 215,
  amountPaid: 215,
};

const DRAFT = {
  id: 'CD1-DRAFT',
  isDraft: true,
  kind: 'draft',
  phone: '(201) 555-0148',
  email: EMAIL,
  package: 'Draft Should Hide',
  preferredDate: '2026-06-01',
};

const FOREIGN = {
  id: 'CD1-FOREIGN',
  isDraft: false,
  kind: 'booking',
  phone: '(212) 555-0199',
  email: 'other@example.com',
  status: 'Paid',
  jobStatus: 'completed_paid',
  package: 'Someone Else Detail',
  preferredDate: '2026-04-01',
  finalizedAt: '2026-04-01T15:00:00.000Z',
  bookingVersion: 1,
  appointmentPublicRef: 'aptr_foreignforeignforeign',
};

const SAME_PHONE_OTHER_EMAIL = {
  id: 'CD1-OTHERACCT',
  isDraft: false,
  kind: 'booking',
  phone: '(201) 555-0148',
  email: 'other-account@example.com',
  status: 'Confirmed',
  jobStatus: 'confirmed',
  package: 'Same Phone Other Email',
  preferredDate: '2026-03-01',
  finalizedAt: '2026-03-01T15:00:00.000Z',
  bookingVersion: 1,
  appointmentPublicRef: 'aptr_samephoneotheremail',
  customerAccountId: 'acct_other_phone',
};

const SAME_EMAIL_OTHER_PHONE = {
  id: 'CD1-OTHEREMAIL',
  isDraft: false,
  kind: 'booking',
  phone: '(212) 555-0100',
  email: EMAIL,
  status: 'Confirmed',
  jobStatus: 'confirmed',
  package: 'Same Email Other Phone',
  preferredDate: '2026-03-02',
  finalizedAt: '2026-03-02T15:00:00.000Z',
  bookingVersion: 1,
  appointmentPublicRef: 'aptr_sameemailotherphone',
  customerAccountId: 'acct_other_email',
};

const SAME_PHONE_OTHER_ACCOUNT = {
  id: 'CD1-PHONEACCT',
  isDraft: false,
  kind: 'booking',
  phone: '(201) 555-0148',
  email: EMAIL,
  status: 'Confirmed',
  jobStatus: 'confirmed',
  package: 'Same Phone Other Account',
  preferredDate: '2026-03-03',
  finalizedAt: '2026-03-03T15:00:00.000Z',
  bookingVersion: 1,
  appointmentPublicRef: 'aptr_samephoneotheracct',
  customerAccountId: 'acct_not_session',
};

const SAME_EMAIL_OTHER_ACCOUNT = {
  id: 'CD1-EMAILACCT',
  isDraft: false,
  kind: 'booking',
  phone: '(201) 555-0148',
  email: EMAIL,
  status: 'Confirmed',
  jobStatus: 'confirmed',
  package: 'Same Email Other Account',
  preferredDate: '2026-03-04',
  finalizedAt: '2026-03-04T15:00:00.000Z',
  bookingVersion: 1,
  appointmentPublicRef: 'aptr_sameemailotheracct',
  customerAccountId: 'acct_not_session',
};

const OWN_ACCOUNT_MATCH = {
  id: 'CD1-OWNACCT',
  isDraft: false,
  kind: 'booking',
  phone: '201-555-0148',
  email: '  Garage-Mirror@example.com ',
  status: 'Confirmed',
  jobStatus: 'confirmed',
  package: 'Own Account Match',
  preferredDate: '2026-03-05',
  finalizedAt: '2026-03-05T15:00:00.000Z',
  bookingVersion: 1,
  appointmentPublicRef: 'aptr_ownaccountmatchxx',
  customerAccountId: 'acct_session',
};

const ARCHIVED_TEST = {
  id: 'CD1-ARCHIVED',
  isDraft: false,
  kind: 'booking',
  phone: '(201) 555-0148',
  email: EMAIL,
  status: 'Paid',
  jobStatus: 'archived_test',
  archived: true,
  package: 'Archived Test Detail',
  preferredDate: '2026-01-01',
  finalizedAt: '2026-01-01T15:00:00.000Z',
  bookingVersion: 1,
  appointmentPublicRef: 'aptr_archivedtestdetail',
};

let originalTryGetPrisma = null;
let fakePrisma = null;

function memoryStore(seed = {}, { failList = false, maxKeys } = {}) {
  const data = new Map(Object.entries(seed).map(([key, value]) => [key, value]));
  return {
    calls: 0,
    writes: 0,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return opts && opts.type === 'json' ? structuredClone(value) : value;
    },
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return {
        data: type === 'json' ? structuredClone(value) : value,
        etag: `etag-${key}`,
        metadata: {},
      };
    },
    async setJSON(key, value) {
      this.writes += 1;
      data.set(key, structuredClone(value));
      return { modified: true, etag: `etag-${key}` };
    },
    async list() {
      this.calls += 1;
      if (failList) throw new Error('blob_list_down');
      const keys = [...data.keys()];
      const sliced = Number(maxKeys) > 0 ? keys.slice(0, maxKeys) : keys;
      return { blobs: sliced.map((key) => ({ key })) };
    },
  };
}

function rateStore() {
  const data = new Map();
  let n = 0;
  return {
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      return { data: type === 'json' ? JSON.parse(entry.value) : entry.value, etag: entry.etag, metadata: {} };
    },
    async setJSON(key, value, options = {}) {
      const exists = data.has(key);
      if (options.onlyIfNew && exists) return { modified: false };
      if (options.onlyIfMatch && (!exists || data.get(key).etag !== options.onlyIfMatch)) return { modified: false };
      const etag = `etag-${++n}`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
  };
}

function bustPortalStack() {
  for (const modulePath of [HISTORY_PATH, MIRROR_PATH, PORTAL_PATH, SESSION_PATH, RATE_PATH, OPS_PATH]) {
    delete require.cache[modulePath];
  }
}

function installPrisma() {
  const prisma = require(PRISMA_PATH);
  if (!originalTryGetPrisma) originalTryGetPrisma = prisma.tryGetPrisma;
  prisma.tryGetPrisma = () => fakePrisma;
}

beforeEach(() => {
  fakePrisma = {
    $queryRaw: async () => [{ payload: MIRROR }],
    booking: { findMany: async () => [] },
  };
  process.env.DATABASE_URL = 'postgres://stub/stub';
  process.env.CUSTOMER_SESSION_SECRET = SESSION_SECRET;
  process.env.CONTEXT = 'production';
  process.env.CD1_POSTGRES_PAYMENT = '0';
  delete process.env.PRISMA_BOOKING_READ;
  delete process.env.PRISMA_BOOKING_MIRROR;
  delete process.env.OFFER_HISTORY_FAST_LOOKUP;
  installPrisma();
  bustPortalStack();
});

afterEach(() => {
  const prisma = require(PRISMA_PATH);
  if (originalTryGetPrisma) prisma.tryGetPrisma = originalTryGetPrisma;
  try {
    const ops = require(OPS_PATH);
    ops.setOpsStoreOverride(null);
  } catch { /* reloaded below */ }
  try {
    const session = require(SESSION_PATH);
    if (session.resetCustomerSessionStoreFactory) session.resetCustomerSessionStoreFactory();
  } catch { /* ignore */ }
  try {
    const rate = require(RATE_PATH);
    if (rate.resetPublicRateLimitStoreFactory) rate.resetPublicRateLimitStoreFactory();
  } catch { /* ignore */ }
  bustPortalStack();
  delete process.env.DATABASE_URL;
  delete process.env.CD1_POSTGRES_PAYMENT;
});

function bookingIds(list) {
  return (list || []).map((booking) => booking.id).sort();
}

async function portalFor(store, {
  sessionOpts = {},
  body = { mode: 'account' },
  expectStatus = 200,
} = {}) {
  const { setOpsStoreOverride } = require(OPS_PATH);
  setOpsStoreOverride(store);
  const session = require(SESSION_PATH);
  const sessions = memoryStore();
  session.setCustomerSessionStoreFactory(() => sessions);
  const rate = require(RATE_PATH);
  rate.setPublicRateLimitStoreFactory(() => rateStore());
  const { token } = await session.createAccountSession({
    phoneDigits: PHONE,
    email: EMAIL,
    bookingIds: ['CD1-MIRROR'],
    ...sessionOpts,
  });
  const { handler } = require(PORTAL_PATH);
  const response = await handler({
    httpMethod: 'POST',
    headers: {
      cookie: `cd1_customer_session=${encodeURIComponent(token)}`,
      'x-nf-client-connection-ip': '203.0.113.40',
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.statusCode, expectStatus);
  return JSON.parse(response.body);
}

describe('partial mirror lookup', () => {
  it('stops before the blob scan and marks the short list incomplete', async () => {
    const store = memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
      'CD1-DRAFT': DRAFT,
    });
    const { setOpsStoreOverride } = require(OPS_PATH);
    setOpsStoreOverride(store);
    const { listBookingsForIdentity } = require(HISTORY_PATH);

    const result = await listBookingsForIdentity({ phone: PHONE, email: EMAIL });

    assert.equal(result.source, 'mirror');
    assert.equal(result.complete, false);
    assert.deepEqual(result.bookings.map((booking) => booking.id), ['CD1-MIRROR']);
    assert.equal(store.calls, 0);
  });

  it('unions the blob store once, keeps the submitted sibling, and drops the draft', async () => {
    const store = memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
      'CD1-DRAFT': DRAFT,
      'CD1-FOREIGN': FOREIGN,
    });
    const { setOpsStoreOverride } = require(OPS_PATH);
    setOpsStoreOverride(store);
    const { listBookingsForIdentity } = require(HISTORY_PATH);

    const result = await listBookingsForIdentity(
      { phone: PHONE, email: EMAIL },
      { completeWithBlobs: true }
    );

    assert.equal(result.source, 'mirror+blobs');
    assert.equal(result.complete, true);
    assert.ok(store.calls > 0);
    const ids = bookingIds(result.bookings);
    assert.deepEqual(ids, ['CD1-BLOBONLY', 'CD1-MIRROR']);
    assert.equal(result.bookings.filter((booking) => booking.id === 'CD1-MIRROR').length, 1);
    const mirror = result.bookings.find((booking) => booking.id === 'CD1-MIRROR');
    assert.equal(mirror.sourceTag, 'mirror');
    assert.equal(mirror.sourceAuthority, 'postgres');
    assert.equal(result.bookings.find((booking) => booking.id === 'CD1-BLOBONLY').sourceAuthority, 'blob');
    assert.equal(result.bookings.some((booking) => booking.id === 'CD1-DRAFT'), false);
    assert.equal(result.bookings.some((booking) => booking.id === 'CD1-FOREIGN'), false);
  });

  it('keeps the short mirror list incomplete when the blob store cannot be listed', async () => {
    const store = memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
    }, { failList: true });
    const { setOpsStoreOverride } = require(OPS_PATH);
    setOpsStoreOverride(store);
    const { listBookingsForIdentity } = require(HISTORY_PATH);

    const result = await listBookingsForIdentity(
      { phone: PHONE, email: EMAIL },
      { completeWithBlobs: true }
    );

    assert.equal(result.source, 'mirror');
    assert.equal(result.complete, false);
    assert.deepEqual(result.bookings.map((booking) => booking.id), ['CD1-MIRROR']);
  });
});

describe('My Garage composition', () => {
  function fullStore() {
    return memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
      'CD1-DRAFT': DRAFT,
      'CD1-FOREIGN': FOREIGN,
    });
  }

  it('returns the blob-only submitted booking once and leaves the draft and the other customer out', async () => {
    const store = fullStore();
    const body = await portalFor(store);
    const ids = bookingIds(body.bookings);
    assert.equal(body.bookingsComplete, true);
    assert.deepEqual(ids, ['CD1-BLOBONLY', 'CD1-MIRROR']);
    assert.equal(body.bookings.filter((booking) => booking.id === 'CD1-MIRROR').length, 1);
    assert.equal(JSON.stringify(body).includes('Draft Should Hide'), false);
    assert.equal(JSON.stringify(body).includes('Someone Else Detail'), false);
    assert.equal(JSON.stringify(body).includes('Blob Older Detail'), true);
    assert.equal(store.writes, 0);
  });

  it('does not let the same phone discover another account, and hides archived_test', async () => {
    const body = await portalFor(memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
      'CD1-OTHERACCT': SAME_PHONE_OTHER_EMAIL,
      'CD1-ARCHIVED': ARCHIVED_TEST,
    }));
    const ids = bookingIds(body.bookings);
    assert.deepEqual(ids, ['CD1-BLOBONLY', 'CD1-MIRROR']);
    assert.equal(JSON.stringify(body).includes('Same Phone Other Email'), false);
    assert.equal(JSON.stringify(body).includes('Archived Test Detail'), false);
  });

  it('does not present a blob-only paid flag as settlement when Postgres is the money authority', async () => {
    process.env.CD1_POSTGRES_PAYMENT = '1';
    const body = await portalFor(fullStore());
    const older = body.bookings.find((booking) => booking.id === 'CD1-BLOBONLY');
    const mirror = body.bookings.find((booking) => booking.id === 'CD1-MIRROR');
    assert.ok(older);
    assert.equal(Number(older.amountPaid || 0), 0);
    assert.equal(Number(older.settledCents || 0), 0);
    assert.notEqual(String(older.paymentStatus || '').toLowerCase(), 'paid');
    assert.equal(older.paymentStatus, 'unverified');
    assert.equal(older.paymentWorkflowStatus, 'manual_review');
    assert.equal(Number(older.remainingCents || 0), 0);
    assert.equal(Number(older.amountDueApproved || 0), 0);
    assert.equal(older.payLink || '', '');
    assert.equal(mirror.package, 'Mirror Newer Detail');
  });

  it('a. hides a blob-only sibling with the same phone, different email and account', async () => {
    const body = await portalFor(memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-OTHERACCT': SAME_PHONE_OTHER_EMAIL,
    }), { sessionOpts: { customerAccountId: 'acct_session' } });
    assert.equal(JSON.stringify(body).includes('Same Phone Other Email'), false);
    assert.deepEqual(bookingIds(body.bookings), ['CD1-MIRROR']);
  });

  it('b. hides a blob-only sibling with the same email, different phone and account', async () => {
    const body = await portalFor(memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-OTHEREMAIL': SAME_EMAIL_OTHER_PHONE,
    }), { sessionOpts: { customerAccountId: 'acct_session' } });
    assert.equal(JSON.stringify(body).includes('Same Email Other Phone'), false);
    assert.deepEqual(bookingIds(body.bookings), ['CD1-MIRROR']);
  });

  it('c. hides a blob-only sibling with the same phone and a different customerAccountId', async () => {
    const body = await portalFor(memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-PHONEACCT': SAME_PHONE_OTHER_ACCOUNT,
    }), { sessionOpts: { customerAccountId: 'acct_session' } });
    assert.equal(JSON.stringify(body).includes('Same Phone Other Account'), false);
    assert.deepEqual(bookingIds(body.bookings), ['CD1-MIRROR']);
  });

  it('d. hides a blob-only sibling with the same email and a different customerAccountId', async () => {
    const body = await portalFor(memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-EMAILACCT': SAME_EMAIL_OTHER_ACCOUNT,
    }), { sessionOpts: { customerAccountId: 'acct_session' } });
    assert.equal(JSON.stringify(body).includes('Same Email Other Account'), false);
    assert.deepEqual(bookingIds(body.bookings), ['CD1-MIRROR']);
  });

  it('e. shows a blob-only sibling on the same account with normalized email and phone', async () => {
    const store = memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-OWNACCT': OWN_ACCOUNT_MATCH,
    });
    const body = await portalFor(store, { sessionOpts: { customerAccountId: 'acct_session' } });
    assert.equal(JSON.stringify(body).includes('Own Account Match'), true);
    assert.ok(bookingIds(body.bookings).includes('CD1-OWNACCT'));
    assert.equal(store.writes, 0);
  });

  it('f. ignores body attempts to swap accountId, email, or phone', async () => {
    const body = await portalFor(memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-OTHERACCT': SAME_PHONE_OTHER_EMAIL,
      'CD1-OTHEREMAIL': SAME_EMAIL_OTHER_PHONE,
      'CD1-PHONEACCT': SAME_PHONE_OTHER_ACCOUNT,
    }), {
      sessionOpts: { customerAccountId: 'acct_session' },
      body: {
        mode: 'account',
        customerAccountId: 'acct_not_session',
        browserCustomerAccountId: 'acct_not_session',
        phone: '2125550100',
        email: 'other-account@example.com',
        emailHash: 'forged',
        bookingIds: ['CD1-OTHERACCT', 'CD1-PHONEACCT'],
      },
    });
    const ids = bookingIds(body.bookings);
    assert.deepEqual(ids, ['CD1-MIRROR']);
    assert.equal(body.customerAccountId, 'acct_session');
  });

  it('g. an incomplete session does not gain scan access to extra blob-only rows', async () => {
    const store = memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
      'CD1-OTHERACCT': SAME_PHONE_OTHER_EMAIL,
    });
    const phoneOnly = await portalFor(store, {
      sessionOpts: { phoneDigits: PHONE, email: '', customerAccountId: 'acct_session' },
    });
    assert.equal(phoneOnly.bookings.some((booking) => booking.id === 'CD1-BLOBONLY'), false);
    assert.equal(JSON.stringify(phoneOnly).includes('Same Phone Other Email'), false);

    const emailOnly = await portalFor(store, {
      sessionOpts: { phoneDigits: '', email: EMAIL, customerAccountId: 'acct_session' },
    });
    assert.equal(emailOnly.bookings.some((booking) => booking.id === 'CD1-BLOBONLY'), false);
  });

  it('marks the account list incomplete and omits the unseen submitted booking when blobs cannot be read', async () => {
    const body = await portalFor(memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
      'CD1-DRAFT': DRAFT,
    }, { failList: true }));
    assert.equal(body.bookingsComplete, false);
    assert.deepEqual(bookingIds(body.bookings), ['CD1-MIRROR']);
    assert.equal(JSON.stringify(body).includes('Blob Older Detail'), false);
    assert.equal(JSON.stringify(body).includes('Draft Should Hide'), false);
  });
});

describe('My Garage cold load', { skip: JSDOM ? false : 'jsdom unavailable' }, () => {
  const garageHtml = fs.readFileSync(path.join(ROOT, 'my-garage.html'), 'utf8');
  const garageJs = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');

  function shell(booking, overrides = {}) {
    return {
      ok: true,
      notModified: false,
      scope: 'account',
      customerAccountId: 'acct_alpha',
      customer: null,
      bookings: [booking],
      bookingsComplete: false,
      upcoming: booking,
      focusedAppointment: null,
      focusError: null,
      payment: { state: 'none', canPay: false },
      catalog: { packages: [], addons: [], addonsByCategory: {} },
      packageCatalog: { source: 'booking-price-catalog', vehicles: [], packageCatalogByVehicle: {} },
      packageCatalogByVehicle: {},
      changeRequests: [],
      postService: null,
      priceAdjustments: null,
      postServiceByBooking: {},
      sections: { appointments: true, history: false, maintenancePlans: false, payments: false, communicationPreferences: false },
      syncVersion: 'sync_partial',
      serverTime: '2026-09-14T16:00:00.000Z',
      ...overrides,
    };
  }

  async function boot(initial) {
    let current = initial;
    const dom = new JSDOM(garageHtml, {
      url: 'https://example.test/my-garage.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    const NativeDate = window.Date;
    const fixedNow = new NativeDate(2026, 8, 14, 12, 0, 0).getTime();
    window.Date = class FixedDate extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedNow]));
      }

      static now() {
        return fixedNow;
      }
    };
    window.scrollTo = () => {};
    window.alert = () => {};
    if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = () => {};
    window.fetch = async (url) => {
      const fn = String(url).split('/').pop();
      if (fn === 'customer-portal-data') {
        return { ok: true, status: 200, json: async () => current, headers: { get: () => null } };
      }
      if (fn === 'customer-portal-auth') {
        return { ok: true, status: 200, json: async () => ({ ok: true, authenticated: true }), headers: { get: () => null } };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), headers: { get: () => null } };
    };
    vm.runInContext(garageJs, dom.getInternalVMContext());
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.cd1MyGarage.state.scope = 'account';
    window.cd1MyGarage.state.session = true;
    return {
      window,
      doc: window.document,
      api: window.cd1MyGarage,
      serve: (payload) => { current = payload; },
    };
  }

  it('drops a submitted booking the incomplete payload never included', async () => {
    const mirror = {
      id: 'CD1-MIRROR',
      appointmentPublicRef: 'aptr_mirrornewermirror',
      status: 'Confirmed',
      customerStatus: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-09-20',
      confirmedDate: '2026-09-20',
      service: 'Mirror Newer Detail',
      package: 'Mirror Newer Detail',
      vehicles: [],
    };
    const { doc, api } = await boot(shell(mirror));
    assert.equal(await api.loadAccount({ managePhase: false }), true);
    assert.deepEqual(api.state.bookings.map((booking) => booking.id), ['CD1-MIRROR']);
    assert.equal(doc.body.textContent.includes('Blob Older Detail'), false);
    assert.equal(doc.body.textContent.includes('Mirror Newer Detail'), true);
    assert.equal(doc.body.textContent.includes('Draft Should Hide'), false);
  });

  it('shows the submitted sibling once the payload is the completed union', async () => {
    const mirror = {
      id: 'CD1-MIRROR',
      appointmentPublicRef: 'aptr_mirrornewermirror',
      status: 'Confirmed',
      customerStatus: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-09-20',
      confirmedDate: '2026-09-20',
      service: 'Mirror Newer Detail',
      package: 'Mirror Newer Detail',
      vehicles: [],
    };
    const older = {
      id: 'CD1-BLOBONLY',
      appointmentPublicRef: 'aptr_blobolderblobolder',
      status: 'Paid',
      customerStatus: 'Paid',
      jobStatus: 'completed_paid',
      paymentStatus: 'paid',
      preferredDate: '2026-05-02',
      confirmedDate: '2026-05-02',
      service: 'Blob Older Detail',
      package: 'Blob Older Detail',
      vehicles: [],
    };
    const { doc, api } = await boot(shell(mirror, {
      bookings: [mirror, older],
      bookingsComplete: true,
      upcoming: mirror,
      sections: { appointments: true, history: true, maintenancePlans: false, payments: false, communicationPreferences: false },
      syncVersion: 'sync_complete',
    }));
    assert.equal(await api.loadAccount({ managePhase: false }), true);
    assert.deepEqual(api.state.bookings.map((booking) => booking.id).sort(), ['CD1-BLOBONLY', 'CD1-MIRROR']);
    assert.equal(doc.body.textContent.includes('Blob Older Detail'), true);
    assert.equal(doc.body.textContent.includes('Mirror Newer Detail'), true);
    assert.equal(doc.body.textContent.includes('Draft Should Hide'), false);
    const refs = [...doc.querySelectorAll('[data-appt-ref]')].map((el) => el.getAttribute('data-appt-ref'));
    assert.deepEqual(refs.filter((ref) => ref === 'aptr_blobolderblobolder'), ['aptr_blobolderblobolder']);
    assert.equal(doc.getElementById('upcoming-panel').textContent.includes('Mirror Newer Detail'), true);
  });
});

function assertBlobOnlyFinancialLock(row, payment) {
  assert.ok(row);
  assert.equal(row.paymentStatus, 'unverified');
  assert.equal(row.paymentWorkflowStatus, 'manual_review');
  assert.notEqual(String(row.paymentStatus || '').toLowerCase(), 'due');
  assert.notEqual(String(row.paymentStatus || '').toLowerCase(), 'paid');
  assert.notEqual(String(row.paymentStatus || '').toLowerCase(), 'partial');
  assert.equal(Number(row.amountPaid || 0), 0);
  assert.equal(Number(row.settledCents || 0), 0);
  assert.equal(Number(row.remainingCents || 0), 0);
  assert.equal(Number(row.amountDueApproved || 0), 0);
  assert.equal(row.payLink || '', '');
  if (payment) {
    assert.equal(payment.canPay, false);
    assert.equal(payment.canGeneratePayLink, false);
    assert.equal(payment.canCreatePayLink, false);
    assert.equal(payment.embeddedPayAvailable, false);
    assert.equal(payment.payLink || '', '');
    assert.equal(payment.state, 'unverified');
    assert.equal(payment.paymentStatus, 'unverified');
  }
}

describe('blob-only financial lockout', () => {
  function claim(id, paymentStatus, extras = {}) {
    return {
      ...BLOB_ONLY,
      id,
      paymentStatus,
      jobStatus: paymentStatus === 'paid' ? 'completed_paid' : 'confirmed',
      status: paymentStatus === 'paid' ? 'Paid' : 'Confirmed',
      amountPaid: paymentStatus === 'paid' ? 215 : paymentStatus === 'partial' ? 50 : 0,
      paidAmount: paymentStatus === 'paid' ? 215 : paymentStatus === 'partial' ? 50 : 0,
      totalPrice: 215,
      approvedFinalAmount: 215,
      ledger: {
        approvedCents: 21500,
        settledCents: paymentStatus === 'paid' ? 21500 : paymentStatus === 'partial' ? 5000 : 0,
      },
      payLink: 'https://pay.example/forged',
      package: `Blob ${paymentStatus}`,
      appointmentPublicRef: `aptr_${id.toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(16, 'x').slice(0, 24)}`,
      ...extras,
    };
  }

  async function portalOnlyBlob(record) {
    const store = memoryStore({ [record.id]: record });
    fakePrisma = {
      $queryRaw: async () => [],
      booking: { findMany: async () => [] },
    };
    const body = await portalFor(store, { sessionOpts: { bookingIds: [] } });
    return { store, body };
  }

  for (const status of ['paid', 'partial', 'due']) {
    it(`lists a blob-only ${status} claim in history with no payment action`, async () => {
      process.env.CD1_POSTGRES_PAYMENT = '1';
      const record = claim(`CD1-BLOB-${status.toUpperCase()}`, status);
      const { store, body } = await portalOnlyBlob(record);
      const row = body.bookings.find((booking) => booking.id === record.id);
      assert.ok(row, `expected ${record.id} in history`);
      assertBlobOnlyFinancialLock(row, body.payment);
      assert.equal(store.writes, 0);
      assert.equal(JSON.stringify(body).includes('https://pay.example/forged'), false);
    });
  }

  it('keeps the balance and closes customer pay while production payments are off', async () => {
    process.env.CD1_POSTGRES_PAYMENT = '0';
    delete process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED;
    const due = {
      id: 'CD1-PG-DUE',
      sourceAuthority: 'postgres',
      isDraft: false,
      kind: 'booking',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      paymentStatus: 'due',
      totalPrice: 200,
      approvedFinalAmount: 200,
      amountPaid: 0,
      ledger: { approvedCents: 20000, settledCents: 0, creditedCents: 0 },
      bookingVersion: 1,
    };
    const portal = require(PORTAL_PATH);
    const payment = await portal.__test.safePaymentStateAsync(due);
    assert.equal(payment.canPay, false);
    assert.equal(payment.canGeneratePayLink, false);
    assert.equal(payment.customerPaymentsUnavailable, true);
    assert.equal(payment.state, 'due');
    assert.equal(payment.paymentStatus, 'due');
    assert.ok(payment.remainingCents > 0);
    process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED = 'true';
    const reopened = await portal.__test.safePaymentStateAsync(due);
    assert.equal(reopened.canPay, true);
    assert.equal(reopened.canGeneratePayLink, true);
    delete process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED;
  });

  it('blocks saved-card charge and balance PaymentIntent for blob-only', async () => {
    process.env.CD1_POSTGRES_PAYMENT = '1';
    const blob = {
      ...claim('CD1-BLOB-CHARGE', 'due'),
      sourceAuthority: 'blob',
      paymentMethodPreference: 'online_after_service',
      cardOnFileStatus: 'saved',
      stripeCustomerId: 'cus_x',
      stripePaymentMethodId: 'pm_x',
      acceptedCardOnFilePolicy: true,
      afterServiceChargeConsentVersion: require('../netlify/lib/customer-policy').AFTER_SERVICE_CHARGE_CONSENT_VERSION,
      afterServiceChargeConsentAt: '2026-05-01T00:00:00.000Z',
    };
    const { chargeEligibility, chargeSavedCardAfterService } = require('../netlify/lib/charge-saved-card-after-service');
    const eligibility = chargeEligibility(blob, { remainingCents: 21500, paymentStatus: 'due' });
    assert.equal(eligibility.ok, false);
    assert.equal(eligibility.error, 'financial_unverified');
    const charged = await chargeSavedCardAfterService({
      booking: blob,
      projection: { remainingCents: 21500, paymentStatus: 'due' },
      confirmCharge: true,
    });
    assert.equal(charged.ok, false);
    assert.equal(charged.error, 'financial_unverified');
    assert.equal(charged.stripeCalled, false);

    const { prepareEmbeddedPayment } = require('../netlify/lib/db/operational-payment');
    const prepared = await prepareEmbeddedPayment({
      booking: blob,
      expectedQuoteVersion: 1,
      env: { ...process.env, CD1_POSTGRES_PAYMENT: '1', STRIPE_SECRET_KEY: 'sk_test_x' },
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.error, 'financial_unverified');
  });
});

describe('authority, limits, and mutations', () => {
  it('marks the garage list incomplete when Postgres cannot answer', async () => {
    fakePrisma = null;
    const store = memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
    });
    const { setOpsStoreOverride } = require(OPS_PATH);
    setOpsStoreOverride(store);
    const { listBookingsForIdentity } = require(HISTORY_PATH);
    const result = await listBookingsForIdentity(
      { phone: PHONE, email: EMAIL },
      { completeWithBlobs: true }
    );
    assert.equal(result.complete, false);
    assert.deepEqual(bookingIds(result.bookings), ['CD1-BLOBONLY', 'CD1-MIRROR']);
  });

  it('mutations of complement, identity, completeness, and settlement go red then restore', () => {
    const historyPath = path.join(ROOT, 'netlify/lib/booking-history.js');
    const portalPath = path.join(ROOT, 'netlify/functions/customer-portal-data.js');
    const historyOriginal = fs.readFileSync(historyPath, 'utf8');
    const portalOriginal = fs.readFileSync(portalPath, 'utf8');
    const lockPath = path.join(ROOT, 'netlify/lib/blob-only-financial-lock.js');
    const lockOriginal = fs.readFileSync(lockPath, 'utf8');
    const payInnerPath = path.join(ROOT, 'netlify/lib/db/operational-payment.js');
    const payInnerOriginal = fs.readFileSync(payInnerPath, 'utf8');
    const probeScript = `
      process.env.DATABASE_URL = 'postgres://stub/stub';
      process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars!!';
      process.env.CONTEXT = 'production';
      process.env.CD1_POSTGRES_PAYMENT = process.env.CD1_POSTGRES_PAYMENT || '0';
      const assert = require('node:assert/strict');
      const prisma = require('./netlify/lib/prisma');
      prisma.tryGetPrisma = () => ({
        $queryRaw: async () => [{ payload: {
          id: 'CD1-MIRROR', isDraft: false, kind: 'booking', phone: '2015550148',
          email: 'garage-mirror@example.com', status: 'Confirmed', jobStatus: 'confirmed',
          package: 'Mirror Newer Detail', sourceTag: 'mirror', preferredDate: '2026-09-20',
          appointmentPublicRef: 'aptr_mirror', updatedAt: '2026-09-01T15:00:00.000Z', bookingVersion: 2,
        } }],
        booking: { findMany: async () => [] },
      });
      const { listBookingsForIdentity } = require('./netlify/lib/booking-history');
      const { setOpsStoreOverride } = require('./netlify/lib/ops-db');
      const data = new Map([
        ['CD1-MIRROR', { id: 'CD1-MIRROR', isDraft: false, kind: 'booking', phone: '2015550148',
          email: 'garage-mirror@example.com', status: 'Paid', jobStatus: 'completed_paid',
          paymentStatus: 'paid', amountPaid: 999, sourceTag: 'blob', package: 'Blob Overwrite',
          preferredDate: '2026-09-20', bookingVersion: 2 }],
        ['CD1-BLOBONLY', { id: 'CD1-BLOBONLY', isDraft: false, kind: 'booking', phone: '2015550148',
          email: 'garage-mirror@example.com', status: 'Paid', jobStatus: 'completed_paid',
          package: 'Blob Older Detail', preferredDate: '2026-05-02', bookingVersion: 1 }],
      ]);
      setOpsStoreOverride({
        async get(key, opts) { const v = data.get(key); return v && opts && opts.type === 'json' ? { ...v } : (v || null); },
        async getWithMetadata(key, { type } = {}) {
          const v = data.get(key);
          return v ? { data: type === 'json' ? { ...v } : v, etag: 'e', metadata: {} } : null;
        },
        async list() { return { blobs: [...data.keys()].map((key) => ({ key })) }; },
      });
      (async () => {
        const r = await listBookingsForIdentity(
          { phone: '2015550148', email: 'garage-mirror@example.com' },
          { completeWithBlobs: true }
        );
        assert.equal(r.complete, true);
        assert.ok(r.bookings.some((b) => b.id === 'CD1-BLOBONLY'));
        const mirror = r.bookings.find((b) => b.id === 'CD1-MIRROR');
        assert.equal(mirror.sourceTag, 'mirror');
        assert.equal(r.bookings.filter((b) => b.id === 'CD1-MIRROR').length, 1);
      })().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
    `;
    function probe() {
      return spawnSync(process.execPath, ['-e', probeScript], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, CD1_POSTGRES_PAYMENT: '0' },
      });
    }
    try {
      fs.writeFileSync(historyPath, historyOriginal.replace(
        'if (garage) {\n          return garageUnion(rows, {',
        'if (false && garage) {\n          return garageUnion(rows, {',
      ));
      const noComplement = probe();
      assert.notEqual(noComplement.status, 0, noComplement.stdout + noComplement.stderr);

      fs.writeFileSync(historyPath, historyOriginal.replace(
        'if (!bookingMatchesLookupIdentity(booking, identity)) continue;',
        'if (false && !bookingMatchesLookupIdentity(booking, identity)) continue;',
      ));
      const skipFilter = spawnSync(process.execPath, ['-e', `
        process.env.DATABASE_URL='postgres://stub/stub';
        process.env.CONTEXT='production';
        process.env.CD1_POSTGRES_PAYMENT='0';
        const assert = require('node:assert/strict');
        const prisma = require('./netlify/lib/prisma');
        prisma.tryGetPrisma = () => ({
          $queryRaw: async () => [{ payload: { id: 'CD1-MIRROR', isDraft: false, kind: 'booking',
            phone: '2015550148', email: 'garage-mirror@example.com', status: 'Confirmed',
            jobStatus: 'confirmed', package: 'M', preferredDate: '2026-09-20', bookingVersion: 2 } }],
          booking: { findMany: async () => [] },
        });
        const { listBookingsForIdentity } = require('./netlify/lib/booking-history');
        const { setOpsStoreOverride } = require('./netlify/lib/ops-db');
        const data = new Map([
          ['CD1-MIRROR', { id: 'CD1-MIRROR', isDraft: false, kind: 'booking', phone: '2015550148',
            email: 'garage-mirror@example.com', status: 'Confirmed', jobStatus: 'confirmed',
            package: 'M', preferredDate: '2026-09-20', bookingVersion: 2 }],
          ['CD1-FOREIGN', { id: 'CD1-FOREIGN', isDraft: false, kind: 'booking', phone: '2125550199',
            email: 'other@example.com', status: 'Paid', jobStatus: 'completed_paid',
            package: 'Someone Else Detail', preferredDate: '2026-04-01', bookingVersion: 1 }],
        ]);
        setOpsStoreOverride({
          async get(key, opts) { const v = data.get(key); return v && opts && opts.type === 'json' ? { ...v } : (v || null); },
          async getWithMetadata(key, { type } = {}) {
            const v = data.get(key);
            return v ? { data: type === 'json' ? { ...v } : v, etag: 'e', metadata: {} } : null;
          },
          async list() { return { blobs: [...data.keys()].map((key) => ({ key })) }; },
        });
        (async () => {
          const r = await listBookingsForIdentity(
            { phone: '2015550148', email: 'garage-mirror@example.com' },
            { completeWithBlobs: true }
          );
          assert.equal(r.bookings.some((b) => b.id === 'CD1-FOREIGN'), false);
        })().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
      `], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
      assert.notEqual(skipFilter.status, 0, skipFilter.stdout + skipFilter.stderr);

      fs.writeFileSync(historyPath, historyOriginal.replace(
        "return { bookings: rows || [], source: 'mirror', complete: false };",
        "return { bookings: rows || [], source: 'mirror', complete: true };",
      ));
      const alwaysComplete = spawnSync(process.execPath, ['-e', `
        process.env.DATABASE_URL='postgres://stub/stub';
        process.env.CONTEXT='production';
        process.env.CD1_POSTGRES_PAYMENT='0';
        const assert = require('node:assert/strict');
        const prisma = require('./netlify/lib/prisma');
        prisma.tryGetPrisma = () => ({
          $queryRaw: async () => [{ payload: { id: 'CD1-MIRROR', isDraft: false, kind: 'booking',
            phone: '2015550148', email: 'garage-mirror@example.com', status: 'Confirmed',
            jobStatus: 'confirmed', package: 'M', preferredDate: '2026-09-20', bookingVersion: 2 } }],
          booking: { findMany: async () => [] },
        });
        const { listBookingsForIdentity } = require('./netlify/lib/booking-history');
        const { setOpsStoreOverride } = require('./netlify/lib/ops-db');
        setOpsStoreOverride({
          async list() { throw new Error('blob_list_down'); },
          async get() { return null; },
        });
        (async () => {
          const r = await listBookingsForIdentity(
            { phone: '2015550148', email: 'garage-mirror@example.com' },
            { completeWithBlobs: true }
          );
          assert.equal(r.complete, false);
        })().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
      `], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
      assert.notEqual(alwaysComplete.status, 0, alwaysComplete.stdout + alwaysComplete.stderr);

      fs.writeFileSync(historyPath, historyOriginal.replace(
        'for (const booking of mirrorBookings || []) {',
        'for (const booking of []) {',
      ));
      const blobWins = probe();
      assert.notEqual(blobWins.status, 0, blobWins.stdout + blobWins.stderr);

      fs.writeFileSync(historyPath, historyOriginal);
      fs.writeFileSync(portalPath, portalOriginal.replace(
        'return emailOk && phoneOk;',
        'return emailOk || phoneOk;',
      ));
      const orFilter = spawnSync(process.execPath, ['-e', `
        process.env.DATABASE_URL='postgres://stub/stub';
        process.env.CUSTOMER_SESSION_SECRET='test-customer-session-secret-32chars!!';
        process.env.CONTEXT='production';
        process.env.CD1_POSTGRES_PAYMENT='0';
        const assert = require('node:assert/strict');
        const prisma = require('./netlify/lib/prisma');
        prisma.tryGetPrisma = () => ({
          $queryRaw: async () => [],
          booking: { findMany: async () => [] },
        });
        const { setOpsStoreOverride } = require('./netlify/lib/ops-db');
        const session = require('./netlify/lib/customer-session');
        const rate = require('./netlify/lib/public-rate-limit');
        const data = new Map([
          ['CD1-OTHERACCT', {
            id: 'CD1-OTHERACCT', isDraft: false, kind: 'booking', phone: '2015550148',
            email: 'other-account@example.com', status: 'Confirmed', jobStatus: 'confirmed',
            package: 'Same Phone Other Email', preferredDate: '2026-03-01', bookingVersion: 1,
          }],
        ]);
        setOpsStoreOverride({
          writes: 0,
          async get(key, opts) { const v = data.get(key); return v && opts && opts.type === 'json' ? { ...v } : (v || null); },
          async getWithMetadata(key, { type } = {}) {
            const v = data.get(key);
            return v ? { data: type === 'json' ? { ...v } : v, etag: 'e', metadata: {} } : null;
          },
          async list() { return { blobs: [...data.keys()].map((key) => ({ key })) }; },
          async setJSON() { this.writes += 1; },
        });
        const sessions = new Map();
        session.setCustomerSessionStoreFactory(() => ({
          async setJSON(key, value) { sessions.set(key, structuredClone(value)); return { modified: true }; },
          async get(key, opts) {
            const value = sessions.get(key);
            if (!value) return null;
            return opts && opts.type === 'json' ? structuredClone(value) : value;
          },
        }));
        let n = 0;
        const rateData = new Map();
        rate.setPublicRateLimitStoreFactory(() => ({
          async getWithMetadata(key, { type } = {}) {
            if (!rateData.has(key)) return null;
            const entry = rateData.get(key);
            return { data: type === 'json' ? JSON.parse(entry.value) : entry.value, etag: entry.etag, metadata: {} };
          },
          async setJSON(key, value, options = {}) {
            const exists = rateData.has(key);
            if (options.onlyIfNew && exists) return { modified: false };
            const etag = 'etag-' + (++n);
            rateData.set(key, { value: JSON.stringify(value), etag });
            return { modified: true, etag };
          },
        }));
        (async () => {
          const { token } = await session.createAccountSession({
            phoneDigits: '2015550148',
            email: 'garage-mirror@example.com',
            customerAccountId: 'acct_session',
          });
          const { handler } = require('./netlify/functions/customer-portal-data');
          const response = await handler({
            httpMethod: 'POST',
            headers: { cookie: 'cd1_customer_session=' + encodeURIComponent(token), 'x-nf-client-connection-ip': '203.0.113.40' },
            body: JSON.stringify({ mode: 'account' }),
          });
          const body = JSON.parse(response.body);
          assert.equal(body.bookings.some((b) => b.id === 'CD1-OTHERACCT'), false);
        })().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
      `], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
      assert.notEqual(orFilter.status, 0, orFilter.stdout + orFilter.stderr);

      fs.writeFileSync(portalPath, portalOriginal);
      fs.writeFileSync(lockPath, lockOriginal.replace(
        'canPay: false, // blob-only-lock',
        'canPay: true, // blob-only-lock',
      ));
      const canPayMutation = spawnSync(process.execPath, ['-e', `
        process.env.DATABASE_URL='postgres://stub/stub';
        process.env.CUSTOMER_SESSION_SECRET='test-customer-session-secret-32chars!!';
        process.env.CONTEXT='production';
        process.env.CD1_POSTGRES_PAYMENT='1';
        const assert = require('node:assert/strict');
        const { blobOnlyPortalPaymentState } = require('./netlify/lib/blob-only-financial-lock');
        const pay = blobOnlyPortalPaymentState({ id: 'CD1-BLOBONLY', sourceAuthority: 'blob' });
        assert.equal(pay.canPay, false);
      `], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
      assert.notEqual(canPayMutation.status, 0, canPayMutation.stdout + canPayMutation.stderr);

      fs.writeFileSync(lockPath, lockOriginal.replace(
        'canGeneratePayLink: false, // blob-only-lock',
        'canGeneratePayLink: true, // blob-only-lock',
      ));
      const payLinkMutation = spawnSync(process.execPath, ['-e', `
        process.env.CD1_POSTGRES_PAYMENT='1';
        const assert = require('node:assert/strict');
        const { blobOnlyPortalPaymentState } = require('./netlify/lib/blob-only-financial-lock');
        const pay = blobOnlyPortalPaymentState({ id: 'CD1-BLOBONLY', sourceAuthority: 'blob' });
        assert.equal(pay.canGeneratePayLink, false);
      `], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
      assert.notEqual(payLinkMutation.status, 0, payLinkMutation.stdout + payLinkMutation.stderr);

      fs.writeFileSync(lockPath, lockOriginal);
      fs.writeFileSync(payInnerPath, payInnerOriginal.replace(
        '  if (isBlobOnlyFinancialSource(booking)) {\n    return blobOnlyPaymentRefusal(); // blob-only-intent-lock\n  }\n  const bookingId = String(booking?.id || booking?.bookingId || \'\').trim();\n  if (!(await hasAuthoritativePostgresFinancial(bookingId))) {\n    return blobOnlyPaymentRefusal(); // blob-only-intent-lock\n  }',
        '  if (false && isBlobOnlyFinancialSource(booking)) {\n    return blobOnlyPaymentRefusal(); // blob-only-intent-lock\n  }\n  const bookingId = String(booking?.id || booking?.bookingId || \'\').trim();\n  if (false && !(await hasAuthoritativePostgresFinancial(bookingId))) {\n    return blobOnlyPaymentRefusal(); // blob-only-intent-lock\n  }',
      ));
      const piMutation = spawnSync(process.execPath, ['-e', `
        process.env.DATABASE_URL='postgres://stub/stub';
        process.env.CD1_POSTGRES_PAYMENT='1';
        process.env.CONTEXT='production';
        const assert = require('node:assert/strict');
        const { prepareEmbeddedPayment } = require('./netlify/lib/db/operational-payment');
        (async () => {
          const prepared = await prepareEmbeddedPayment({
            booking: { id: 'CD1-BLOBONLY', sourceAuthority: 'blob', quoteVersion: 1, ledger: { approvedCents: 21500, settledCents: 0 } },
            expectedQuoteVersion: 1,
            env: { CD1_POSTGRES_PAYMENT: '1', STRIPE_SECRET_KEY: 'sk_test_x' },
          });
          assert.equal(prepared.ok, false);
          assert.equal(prepared.error, 'financial_unverified');
        })().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
      `], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 });
      assert.notEqual(piMutation.status, 0, piMutation.stdout + piMutation.stderr);
      fs.writeFileSync(payInnerPath, payInnerOriginal);
    } finally {
      fs.writeFileSync(historyPath, historyOriginal);
      fs.writeFileSync(portalPath, portalOriginal);
      fs.writeFileSync(lockPath, lockOriginal);
      fs.writeFileSync(payInnerPath, payInnerOriginal);
    }
  });
});
