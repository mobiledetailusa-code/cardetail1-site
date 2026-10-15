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

let originalTryGetPrisma = null;
let fakePrisma = null;

function memoryStore(seed = {}, { failList = false } = {}) {
  const data = new Map(Object.entries(seed).map(([key, value]) => [key, value]));
  return {
    calls: 0,
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
      data.set(key, structuredClone(value));
      return { modified: true, etag: `etag-${key}` };
    },
    async list() {
      this.calls += 1;
      if (failList) throw new Error('blob_list_down');
      return { blobs: [...data.keys()].map((key) => ({ key })) };
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
    assert.deepEqual(ids, ['CD1-BLOBONLY', 'CD1-FOREIGN', 'CD1-MIRROR']);
    assert.equal(result.bookings.filter((booking) => booking.id === 'CD1-MIRROR').length, 1);
    const mirror = result.bookings.find((booking) => booking.id === 'CD1-MIRROR');
    assert.equal(mirror.sourceTag, 'blob');
    assert.equal(result.bookings.some((booking) => booking.id === 'CD1-DRAFT'), false);
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
  async function portalFor(store) {
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
    });
    const { handler } = require(PORTAL_PATH);
    const response = await handler({
      httpMethod: 'POST',
      headers: {
        cookie: `cd1_customer_session=${encodeURIComponent(token)}`,
        'x-nf-client-connection-ip': '203.0.113.40',
      },
      body: JSON.stringify({ mode: 'account' }),
    });
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body);
  }

  function fullStore() {
    return memoryStore({
      'CD1-MIRROR': MIRROR_BLOB,
      'CD1-BLOBONLY': BLOB_ONLY,
      'CD1-DRAFT': DRAFT,
      'CD1-FOREIGN': FOREIGN,
    });
  }

  it('returns the blob-only submitted booking once and leaves the draft and the other customer out', async () => {
    const body = await portalFor(fullStore());
    const ids = bookingIds(body.bookings);
    assert.equal(body.bookingsComplete, true);
    assert.deepEqual(ids, ['CD1-BLOBONLY', 'CD1-MIRROR']);
    assert.equal(body.bookings.filter((booking) => booking.id === 'CD1-MIRROR').length, 1);
    assert.equal(JSON.stringify(body).includes('Draft Should Hide'), false);
    assert.equal(JSON.stringify(body).includes('Someone Else Detail'), false);
    assert.equal(JSON.stringify(body).includes('Blob Older Detail'), true);
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
