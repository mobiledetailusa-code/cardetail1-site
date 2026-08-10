'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PRISMA_PATH = require.resolve('../netlify/lib/prisma');

let fakePrisma = null;
let capturedQuery = null;

require.cache[PRISMA_PATH] = {
  id: PRISMA_PATH,
  filename: PRISMA_PATH,
  loaded: true,
  exports: {
    prismaConfigured: () => !!fakePrisma,
    tryGetPrisma: () => fakePrisma,
    getPrisma: () => fakePrisma,
  },
};

const { listBookingsForIdentity, normalizeIdentity } = require('../netlify/lib/booking-history');
const { setOpsStoreOverride } = require('../netlify/lib/ops-db');

const EMAIL = 'customer@example.com';
const EMAIL_HASH = crypto.createHash('sha256').update(EMAIL).digest('base64url');

const OWNED = {
  id: 'CD1-OWNED',
  phone: '(201) 555-0147',
  email: EMAIL,
  status: 'Paid',
  paymentStatus: 'paid',
  finalizedAt: '2026-02-01T10:00:00.000Z',
};

function queryRawReturning(rows) {
  return (strings, ...values) => {
    capturedQuery = { sql: strings.join('?'), values };
    return Promise.resolve(rows.map((payload) => ({ payload })));
  };
}

function fakeStore(records) {
  const byKey = new Map(records.map((r) => [r.id, r]));
  return {
    calls: 0,
    list(opts) {
      this.calls += 1;
      const blobs = [...byKey.keys()].map((key) => ({ key }));
      if (opts && opts.paginate) return (async function* pages() { yield { blobs }; })();
      return Promise.resolve({ blobs });
    },
    get(key) { return Promise.resolve(byKey.get(key) || null); },
  };
}

beforeEach(() => {
  fakePrisma = null;
  capturedQuery = null;
  delete process.env.OFFER_HISTORY_FAST_LOOKUP;
  delete process.env.PRISMA_BOOKING_READ;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  setOpsStoreOverride(null);
});

afterEach(() => {
  setOpsStoreOverride(null);
  delete process.env.DATABASE_URL;
});

describe('identity normalisation', () => {
  it('accepts phone, plain email and email hash', () => {
    assert.deepEqual(
      normalizeIdentity({ phone: '+1 (201) 555-0147', email: '  Customer@Example.COM ', emailHash: ` ${EMAIL_HASH} ` }),
      { phone: '2015550147', email: EMAIL, emailHash: EMAIL_HASH }
    );
  });

  it('is empty when nothing identifies the customer', () => {
    assert.deepEqual(normalizeIdentity({}), { phone: '', email: '', emailHash: '' });
  });
});

describe('listBookingsForIdentity', () => {
  it('scopes by email hash without ever holding the address', async () => {
    fakePrisma = { $queryRaw: queryRawReturning([OWNED]) };
    const store = fakeStore([OWNED]);
    setOpsStoreOverride(store);

    const result = await listBookingsForIdentity({ emailHash: EMAIL_HASH });

    assert.equal(result.source, 'mirror');
    assert.deepEqual(result.bookings.map((b) => b.id), ['CD1-OWNED']);
    assert.equal(store.calls, 0);
    assert.ok(capturedQuery.values.includes(EMAIL_HASH));
    assert.ok(
      !capturedQuery.values.includes(EMAIL),
      'a hash-only session must not put the address in the query'
    );
  });

  it('reproduces the session hash format in SQL', () => {
    // Guards the expression against drift from customer-session's digest:
    // sha256 -> base64 -> base64url (+/ => -_) -> strip padding.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'netlify', 'lib', 'booking-history.js'),
      'utf8'
    );
    assert.match(src, /sha256\(convert_to\(lower\(trim\(coalesce\(email, ''\)\)\), 'UTF8'\)\)/);
    assert.match(src, /translate\(encode\([\s\S]*?, 'base64'\), '\+\/', '-_'\)/);
    assert.match(src, /rtrim\([\s\S]*?, '='\)/);
    const digest = fs.readFileSync(
      path.join(__dirname, '..', 'netlify', 'lib', 'customer-session.js'),
      'utf8'
    );
    assert.match(digest, /createHash\('sha256'\)[\s\S]*?digest\('base64url'\)/);
  });

  it('falls back to the scan when the mirror cannot answer', async () => {
    fakePrisma = null;
    const store = fakeStore([OWNED]);
    setOpsStoreOverride(store);

    const result = await listBookingsForIdentity({ phone: '2015550147' });

    assert.equal(result.source, 'blobs');
    assert.equal(store.calls, 1);
  });

  it('returns nothing — and scans nothing — without an identity', async () => {
    const store = fakeStore([OWNED]);
    setOpsStoreOverride(store);
    const result = await listBookingsForIdentity({});
    assert.equal(result.source, 'no_identity');
    assert.deepEqual(result.bookings, []);
    assert.equal(store.calls, 0);
  });
});

describe('group 1 call sites no longer hydrate the store', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  for (const file of [
    'netlify/functions/customer-portal-auth.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/functions/customer-subscription-checkout.js',
  ]) {
    it(`${path.basename(file)} asks for a customer-scoped set`, () => {
      const src = read(file);
      assert.match(src, /listBookingsForIdentity/);
      assert.doesNotMatch(src, /listRawBookings/);
    });
  }

  it('portal-data still unions the ids the session already carries', () => {
    const src = read('netlify/functions/customer-portal-data.js');
    assert.match(src, /getBookingsByIds/);
    assert.match(src, /sessionBookingIds/);
    assert.match(src, /linkedAccountBookingIds/);
  });

  it('portal-data keeps the ownership filter it always had', () => {
    const src = read('netlify/functions/customer-portal-data.js');
    assert.match(src, /contactMatchesSession/);
    assert.match(src, /ownerAccountId === session\.customerAccountId/);
  });

  it('portal-data scopes by hash, never by a plaintext address it does not have', () => {
    const src = read('netlify/functions/customer-portal-data.js');
    assert.match(src, /emailHash: session\.emailHash/);
    assert.doesNotMatch(src, /email: session\.email\b/);
  });
});
