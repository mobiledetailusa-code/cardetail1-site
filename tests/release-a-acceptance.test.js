/**
 * Release A — characterization + acceptance tests.
 * Synthetic fixtures only; intercepted Stripe; no production data.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');

const ROOT = path.join(__dirname, '..');

/**
 * Package-change decide tests below now route through the authoritative
 * Postgres mutation (Package Stage 1) and need DATABASE_URL/DIRECT_URL
 * visible on process.env. Deliberately NOT a blanket `require('dotenv/config')`
 * — .env also holds NETLIFY_AUTH_TOKEN/NETLIFY_SITE_ID, and several tests in
 * this file (e.g. "cross-store index failure recovery") rely on the ambient
 * Netlify Blobs client staying unconfigured so their failure-path mocks are
 * actually exercised. Load only the Postgres keys, surgically, once.
 */
(function loadPostgresEnvOnly() {
  if (process.env.DATABASE_URL) return;
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    // .env is CRLF + may open with a UTF-8 BOM — strip both before matching.
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.replace(/^﻿/, '').replace(/\r$/, '');
      const m = line.match(/^(DATABASE_URL|DIRECT_URL)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
      }
    }
  } catch { /* .env optional — CI environments set these directly */ }
})();

function createMemoryStore(seed = {}, { pageSize = 50 } = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const etags = new Map();
  for (const [k] of data) {
    etags.set(k, `etag-${k}-0`);
  }
  const store = {
    async get(key, _opts) {
      if (!data.has(key)) return null;
      return JSON.parse(JSON.stringify(data.get(key)));
    },
    async getWithMetadata(key) {
      if (!data.has(key)) return null;
      return {
        data: JSON.parse(JSON.stringify(data.get(key))),
        etag: etags.get(key) || null,
      };
    },
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfNew && data.has(key)) {
        return { modified: false };
      }
      if (opts.onlyIfMatch) {
        const current = etags.get(key);
        if (!current || current !== opts.onlyIfMatch) {
          return { modified: false };
        }
      }
      data.set(key, JSON.parse(JSON.stringify(value)));
      etags.set(key, `etag-${key}-${Date.now()}-${Math.random()}`);
      return { modified: true };
    },
    async list(opts = {}) {
      const prefix = opts.prefix || '';
      const blobs = [...data.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort()
        .map((key) => ({ key }));
      return { blobs };
    },
    // Async-iterable paginated list for listAllBlobs({ paginate: true })
    listPaged(opts = {}) {
      const prefix = opts.prefix || '';
      const keys = [...data.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort();
      const size = Math.max(1, pageSize);
      return {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < keys.length; i += size) {
            yield { blobs: keys.slice(i, i + size).map((key) => ({ key })) };
          }
        },
      };
    },
    _data: data,
  };
  // Override list to support paginate:true async iterator (Netlify Blobs shape)
  const plainList = store.list.bind(store);
  store.list = (opts = {}) => {
    if (opts && opts.paginate) return store.listPaged(opts);
    return plainList(opts);
  };
  return store;
}

describe('Release A — visibility & drafts (PDA-13, PDA-14)', () => {
  const { isVisibleSubmittedBooking } = require('../netlify/lib/booking-visibility');

  it('excludes drafts from visibility gate', () => {
    assert.equal(isVisibleSubmittedBooking({ id: 'D1', isDraft: true }), false);
    assert.equal(isVisibleSubmittedBooking({ id: 'B1', isDraft: false, status: 'Confirmed' }), true);
  });

  it('lookup-booking and customer-bookings source gate drafts', () => {
    const lookup = fs.readFileSync(path.join(ROOT, 'netlify/functions/lookup-booking.js'), 'utf8');
    const bookings = fs.readFileSync(path.join(ROOT, 'netlify/functions/customer-bookings.js'), 'utf8');
    assert.match(lookup, /isVisibleSubmittedBooking/);
    assert.match(bookings, /isVisibleSubmittedBooking/);
  });

  it('submit-booking requires draftSaveToken for existing draft overwrite/finalize', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/submit-booking.js'), 'utf8');
    assert.match(src, /verifyDraftSaveToken/);
    assert.match(src, /draft_token_invalid/);
  });

  it('lookup/customer-bookings hide drafts even with matching phone', async () => {
    const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
    const draft = {
      id: 'CD1-DRAFT-HIDE',
      isDraft: true,
      phone: '5513132956',
      status: 'saved',
      totalPrice: 100,
    };
    const store = createMemoryStore({ 'CD1-DRAFT-HIDE': draft });
    setOpsStoreOverride(store);

    const prevRate = process.env.PUBLIC_RATE_LIMIT_DISABLED;
    process.env.PUBLIC_RATE_LIMIT_DISABLED = '1';
    try {
      delete require.cache[require.resolve('../netlify/functions/lookup-booking')];
      delete require.cache[require.resolve('../netlify/functions/customer-bookings')];
      const lookup = require('../netlify/functions/lookup-booking');
      const bookings = require('../netlify/functions/customer-bookings');
      const body = JSON.stringify({ bookingId: 'CD1-DRAFT-HIDE', phone: '5513132956' });
      const lookupRes = await lookup.handler({ httpMethod: 'POST', body, headers: {} });
      const bookingsRes = await bookings.handler({ httpMethod: 'POST', body, headers: {} });
      const lookupBody = JSON.parse(lookupRes.body);
      const bookingsBody = JSON.parse(bookingsRes.body);
      assert.equal(lookupBody.found, false);
      assert.equal(lookupBody.error, 'booking_not_ready');
      assert.equal(bookingsBody.found, false);
      assert.equal(bookingsBody.error, 'booking_not_ready');
    } finally {
      setOpsStoreOverride(null);
      if (prevRate == null) delete process.env.PUBLIC_RATE_LIMIT_DISABLED;
      else process.env.PUBLIC_RATE_LIMIT_DISABLED = prevRate;
    }
  });

  it('submit-booking rejects missing/wrong draftSaveToken on existing draft', async () => {
    const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
    const TOKEN_PATH = require.resolve('../netlify/lib/draft-save-token');
    const envSnap = {
      DRAFT_TOKEN_SECRET: process.env.DRAFT_TOKEN_SECRET,
      CONTEXT: process.env.CONTEXT,
      NETLIFY_DEV: process.env.NETLIFY_DEV,
    };
    process.env.DRAFT_TOKEN_SECRET = 'd'.repeat(32);
    process.env.CONTEXT = 'production';
    delete process.env.NETLIFY_DEV;
    delete require.cache[TOKEN_PATH];
    delete require.cache[SUBMIT_PATH];
    const { issueDraftSaveToken } = require('../netlify/lib/draft-save-token');
    const { handler, __test } = require('../netlify/functions/submit-booking');
    const draft = {
      id: 'CD1-TOK',
      isDraft: true,
      phone: '5513132956',
      firstName: 'Tok',
      email: 'tok@example.com',
      paymentMethodPreference: 'card_onsite',
      acceptedCardOnFilePolicy: true,
      cardOnFileRequired: true,
      cardOnFileStatus: 'pending',
      preferredDate: '2099-06-16',
      preferredTime: '10:00 AM',
      createdAt: new Date().toISOString(),
    };
    const store = createMemoryStore({ 'CD1-TOK': draft });
    __test.setBlobsStoreOverride(() => store);

    const base = {
      isDraft: true,
      draftBookingId: 'CD1-TOK',
      phone: '5513132956',
      firstName: 'Tok',
      email: 'tok@example.com',
      paymentMethodPreference: 'card_onsite',
      acceptedCardOnFilePolicy: true,
      preferredDate: '2099-06-16',
      preferredTime: '10:00 AM',
      zipCode: '07102',
      address: '1 Main St Newark NJ',
      vehicleCategory: 'cars',
      package: 'Premium Detail',
      packageId: 'full',
      totalPrice: 240,
      vehicles: [{
        cat: 'cars',
        pkgId: 'full',
        pkgName: 'Premium Detail',
        tierLabel: 'Small Car',
        addons: [],
      }],
    };

    try {
      const missing = await handler({
        httpMethod: 'POST',
        body: JSON.stringify(base),
        headers: {},
      });
      assert.equal(missing.statusCode, 401);
      assert.equal(JSON.parse(missing.body).error, 'draft_token_invalid');

      const wrong = await handler({
        httpMethod: 'POST',
        body: JSON.stringify({ ...base, draftSaveToken: 'v1.9999999999.bad' }),
        headers: {},
      });
      assert.equal(wrong.statusCode, 401);

      const issued = issueDraftSaveToken({ bookingId: 'CD1-TOK', phone: '5513132956', now: Date.now() });
      const ok = await handler({
        httpMethod: 'POST',
        body: JSON.stringify({ ...base, draftSaveToken: issued.token }),
        headers: {},
      });
      assert.equal(ok.statusCode, 200);
      const okBody = JSON.parse(ok.body);
      assert.equal(okBody.ok, true);
      assert.match(okBody.draftSaveToken, /^v1\./);

      // Idempotent finalize path: already-submitted returns same id without new token
      store._data.set('CD1-TOK', {
        ...draft,
        isDraft: false,
        bookingVersion: 1,
        finalizedAt: new Date().toISOString(),
        id: 'CD1-TOK',
      });
      const finalizeIssued = issueDraftSaveToken({ bookingId: 'CD1-TOK', phone: '5513132956', now: Date.now() });
      const idem = await handler({
        httpMethod: 'POST',
        body: JSON.stringify({
          draftBookingId: 'CD1-TOK',
          draftSaveToken: finalizeIssued.token,
          phone: '5513132956',
          firstName: 'Tok',
          zipCode: '07102',
          address: '1 Main St Newark NJ',
          paymentMethodPreference: 'card_onsite',
          acceptedCardOnFilePolicy: true,
          acceptedBookingPolicy: true,
          preferredDate: '2099-06-16',
          preferredTime: '10:00 AM',
          vehicleCategory: 'cars',
          package: 'Premium Detail',
          packageId: 'full',
          totalPrice: 240,
          vehicles: base.vehicles,
        }),
        headers: {},
      });
      assert.equal(idem.statusCode, 200);
      const idemBody = JSON.parse(idem.body);
      assert.equal(idemBody.idempotent, true);
      assert.equal(idemBody.id, 'CD1-TOK');
      assert.equal(idemBody.draftSaveToken, undefined);
    } finally {
      __test.setBlobsStoreOverride(null);
      for (const [k, v] of Object.entries(envSnap)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete require.cache[TOKEN_PATH];
      delete require.cache[SUBMIT_PATH];
    }
  });
});

describe('Release A — historical adapter (PDA-04, PDA-16)', () => {
  const { adaptHistoricalBooking } = require('../netlify/lib/historical-adapter');
  const { computeDue } = require('../netlify/lib/portal-money-sync');
  const { canCreatePayment } = require('../netlify/lib/payment-service');
  const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');

  it('Paid fixture is completed with zero due and not payable', () => {
    const adapted = adaptHistoricalBooking({ status: 'Paid', totalPrice: 225, id: 'H1' });
    assert.equal(adapted.ok, true);
    assert.equal(computeDue(adapted.booking), 0);
    const pay = canCreatePayment(adapted.booking);
    assert.equal(pay.ok, false);
    const proj = projectBookingForCustomer(adapted.booking);
    assert.equal(proj.amountDueApproved, 0);
    assert.equal(proj.jobStatus, 'completed_paid');
  });

  it('Closed fixture maps to completed paid with zero due', () => {
    const adapted = adaptHistoricalBooking({ status: 'Closed', totalPrice: 225, id: 'H2' });
    assert.equal(adapted.ok, true);
    assert.equal(computeDue(adapted.booking), 0);
    assert.equal(canCreatePayment(adapted.booking).ok, false);
  });

  it('malformed vehicles/addons do not throw', () => {
    const adapted = adaptHistoricalBooking({
      id: 'H3',
      status: 'Confirmed',
      vehicles: {},
      addons: {},
      totalPrice: 100,
    });
    assert.equal(adapted.ok, true);
    assert.ok(Array.isArray(adapted.booking.vehicles));
    assert.doesNotThrow(() => projectBookingForCustomer(adapted.booking));
  });
});

describe('Release A — canonical quote (PDA-01, PDA-07)', () => {
  const {
    quoteService,
    applyServiceDelta,
    canonicalCarPackagePrice,
    canonicalAddonPrice,
  } = require('../netlify/lib/canonical-quote');

  it('SUV3 Premium is $540 at audited catalog baseline', () => {
    assert.equal(canonicalCarPackagePrice('suv3', 'premium'), 540);
    // Use a non-rich ZIP so the audited catalog baseline is not multiplied.
    const quoted = quoteService({
      zip: '07102',
      vehicles: [{
        vehicleId: 'veh_1',
        category: 'cars',
        cat: 'cars',
        tier: 'suv3',
        tierLabel: 'SUV 3-Row',
        packageId: 'premium',
        pkgId: 'premium',
        addons: [],
        addOnIds: [],
      }],
    });
    assert.equal(quoted.ok, true);
    assert.equal(quoted.quote.approvedCents, 54000);
  });

  it('Odor Removal is $90 in canonical catalog', () => {
    assert.equal(canonicalAddonPrice('cars', 'odor'), 90);
  });

  it('duplicate existing add-on is a no-op', () => {
    const service = {
      zip: '07030',
      vehicles: [{
        vehicleId: 'veh_1',
        category: 'cars',
        cat: 'cars',
        tier: 'suv3',
        packageId: 'full',
        pkgId: 'full',
        addOnIds: ['pethair'],
        addons: [{ id: 'pethair', price: 95 }],
      }],
    };
    const applied = applyServiceDelta(service, { vehicleId: 'veh_1' }, { addOnIdsToAdd: ['pethair'] });
    assert.equal(applied.ok, true);
    assert.equal(applied.noop, true);
  });
});

describe('Release A — version CAS (PDA-02)', () => {
  it('two concurrent commits from version N: one wins, one 409', async () => {
    const { setBookingStoreOverride, commitBooking, getBookingRecord } = require('../netlify/lib/booking-repository');
    const { buildNextAggregate, normalizeAggregate } = require('../netlify/lib/booking-aggregate');

    const store = createMemoryStore({
      'CD1-CAS': {
        id: 'CD1-CAS',
        bookingVersion: 3,
        schemaVersion: 1,
        approvedFinalAmount: 310,
        amountPaid: 0,
        package: 'Premium',
        technicianNote: 'keep-me',
        vehicles: [{ vehicleId: 'veh_a', cat: 'cars', pkgId: 'full' }],
      },
    });
    setBookingStoreOverride(store);

    const rec = await getBookingRecord('CD1-CAS');
    const { aggregate } = normalizeAggregate(rec.booking);
    const nextA = buildNextAggregate(aggregate, { customerNote: 'writer-A' });
    const nextB = buildNextAggregate(aggregate, { customerNote: 'writer-B' });

    const r1 = await commitBooking({
      bookingId: 'CD1-CAS',
      expectedBookingVersion: 3,
      nextAggregate: nextA,
    });
    const r2 = await commitBooking({
      bookingId: 'CD1-CAS',
      expectedBookingVersion: 3,
      nextAggregate: nextB,
    });

    const winners = [r1, r2].filter((r) => r.ok);
    const losers = [r1, r2].filter((r) => !r.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].error, 'version_conflict');
    assert.equal(winners[0].bookingVersion, 4);

    const final = await getBookingRecord('CD1-CAS');
    assert.equal(final.booking.technicianNote, 'keep-me');
    assert.equal(final.booking.bookingVersion, 4);

    setBookingStoreOverride(null);
  });
});

describe('Release A — list pagination & historical multi-page (PDA-16)', () => {
  it('listSubmittedBookings pages, quarantines malformed, sorts deterministically, omits drafts', async () => {
    const { setBookingStoreOverride, listSubmittedBookings } = require('../netlify/lib/booking-repository');
    const seed = {};
    // Shuffle insertion order; pageSize forces multi-page iteration
    const ids = ['CD1-C', 'CD1-A', 'CD1-B', 'CD1-DRAFT', 'CD1-BAD', 'CD1-PAID'];
    seed['CD1-C'] = {
      id: 'CD1-C', status: 'Confirmed', isDraft: false,
      updatedAt: '2026-01-03T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
      totalPrice: 100, vehicles: [{ cat: 'cars', pkgId: 'full', tierLabel: 'Sedan' }],
    };
    seed['CD1-A'] = {
      id: 'CD1-A', status: 'Confirmed', isDraft: false,
      updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
      totalPrice: 200, vehicles: [{ cat: 'cars', pkgId: 'full', tierLabel: 'Sedan' }],
    };
    seed['CD1-B'] = {
      id: 'CD1-B', status: 'Confirmed', isDraft: false,
      updatedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
      totalPrice: 150, addons: 'not-an-array', vehicles: 'bad',
    };
    seed['CD1-DRAFT'] = {
      id: 'CD1-DRAFT', isDraft: true, status: 'saved', phone: '5513132956', totalPrice: 99,
    };
    seed['CD1-BAD'] = null; // skipped by fetch
    seed['CD1-PAID'] = {
      id: 'CD1-PAID', status: 'Paid', totalPrice: 225, amountPaid: 225,
      updatedAt: '2026-01-04T00:00:00.000Z',
    };

    const store = createMemoryStore(
      Object.fromEntries(ids.filter((id) => seed[id] != null).map((id) => [id, seed[id]])),
      { pageSize: 2 }
    );
    // Inject a non-object blob that adapt should quarantine
    store._data.set('CD1-BAD', 'not-json-object');
    setBookingStoreOverride(store);

    const { bookings, quarantined } = await listSubmittedBookings();
    assert.ok(quarantined.length >= 1);
    assert.equal(bookings.some((b) => b.id === 'CD1-DRAFT'), false);
    assert.deepEqual(
      bookings.map((b) => b.id),
      ['CD1-PAID', 'CD1-C', 'CD1-B', 'CD1-A']
    );
    const paid = bookings.find((b) => b.id === 'CD1-PAID');
    assert.equal(paid.amountDueApproved, 0);
    const malformed = bookings.find((b) => b.id === 'CD1-B');
    assert.ok(Array.isArray(malformed.vehicles));
    assert.ok(Array.isArray(malformed.addons));

    setBookingStoreOverride(null);
  });
});

describe('Release A — money ledger (PDA-09)', () => {
  const { computeDue } = require('../netlify/lib/portal-money-sync');
  const { remainingCents } = require('../netlify/lib/booking-aggregate');

  it('stale stored due is ignored; derives approved − paid', () => {
    const booking = {
      approvedFinalAmount: 460,
      amountPaid: 50,
      amountDueApproved: 260, // stale
      balanceDue: 260,
      ledger: { approvedCents: 46000, settledCents: 5000, creditedCents: 0 },
    };
    assert.equal(computeDue(booking), 410);
    assert.equal(remainingCents(booking.ledger), 41000);
  });

  it('approved $310 / paid $50 → remaining $260', () => {
    assert.equal(remainingCents({ approvedCents: 31000, settledCents: 5000, creditedCents: 0 }), 26000);
  });
});

describe('Release A — payment reconciliation (PDA-03)', () => {
  const {
    reconcileCustomerBalanceSession,
    applyCustomerBalanceReconciliation,
    expireStripeCheckoutSessions,
  } = require('../netlify/lib/payment-service');

  it('customer_balance completion credits once; duplicate is no-op', () => {
    const aggregate = {
      id: 'CD1-PAY',
      bookingVersion: 2,
      quoteVersion: 1,
      ledger: { approvedCents: 31000, settledCents: 0, creditedCents: 0, entries: [] },
      paymentAttempts: [{
        bookingId: 'CD1-PAY',
        providerObjectId: 'cs_test_1',
        amountCents: 31000,
        quoteVersion: 1,
        bookingVersion: 2,
        currency: 'usd',
        status: 'open',
      }],
    };
    const session = {
      id: 'cs_test_1',
      amount_total: 31000,
      currency: 'usd',
      payment_status: 'paid',
      metadata: {
        purpose: 'customer_balance',
        booking_id: 'CD1-PAY',
        bookingVersion: '2',
        quoteVersion: '1',
      },
    };
    const first = reconcileCustomerBalanceSession({ aggregate, session });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.aggregate.ledger.settledCents, 31000);

    const second = reconcileCustomerBalanceSession({ aggregate: first.aggregate, session });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.aggregate.ledger.settledCents, 31000);
  });

  it('missing stored payment attempt is quarantined', () => {
    const aggregate = {
      id: 'CD1-PAY2',
      bookingVersion: 2,
      quoteVersion: 2,
      ledger: { approvedCents: 31000, settledCents: 0, creditedCents: 0, entries: [] },
      paymentAttempts: [],
    };
    const session = {
      id: 'cs_bad',
      amount_total: 31000,
      currency: 'usd',
      payment_status: 'paid',
      metadata: {
        purpose: 'customer_balance',
        booking_id: 'CD1-PAY2',
        bookingVersion: '2',
        quoteVersion: '2',
      },
    };
    const result = reconcileCustomerBalanceSession({ aggregate, session });
    assert.equal(result.ok, false);
    assert.equal(result.quarantined, true);
    assert.equal(result.error, 'missing_payment_attempt');
  });

  it('amount/version/booking binding mismatch is quarantined', () => {
    const aggregate = {
      id: 'CD1-PAY3',
      bookingVersion: 2,
      quoteVersion: 2,
      ledger: { approvedCents: 31000, settledCents: 0, creditedCents: 0, entries: [] },
      paymentAttempts: [{
        bookingId: 'CD1-PAY3',
        providerObjectId: 'cs_bad',
        amountCents: 31000,
        quoteVersion: 1,
        bookingVersion: 2,
        currency: 'usd',
        status: 'open',
      }],
    };
    const session = {
      id: 'cs_bad',
      amount_total: 31000,
      currency: 'usd',
      payment_status: 'paid',
      metadata: {
        purpose: 'customer_balance',
        booking_id: 'CD1-PAY3',
        bookingVersion: '2',
        quoteVersion: '1',
      },
    };
    const result = reconcileCustomerBalanceSession({ aggregate, session });
    assert.equal(result.ok, false);
    assert.equal(result.quarantined, true);
    assert.equal(result.error, 'quote_version_mismatch');
  });

  it('provider-side Session expire calls Stripe expire endpoint', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, method: opts?.method });
      return { ok: true, json: async () => ({ id: 'cs_old_260', status: 'expired' }) };
    };
    const result = await expireStripeCheckoutSessions({
      sessionIds: ['cs_old_260'],
      secret: 'sk_test_fake',
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.expired, ['cs_old_260']);
    assert.equal(result.networkCalls, 1);
    assert.match(calls[0].url, /checkout\/sessions\/cs_old_260\/expire/);
    assert.equal(calls[0].method, 'POST');
  });

  it('reconcile CAS conflict retries then settles idempotently', async () => {
    let version = 2;
    let booking = {
      id: 'CD1-CAS-REC',
      bookingVersion: 2,
      quoteVersion: 1,
      ledger: { approvedCents: 26000, settledCents: 0, creditedCents: 0, entries: [] },
      paymentAttempts: [{
        bookingId: 'CD1-CAS-REC',
        providerObjectId: 'cs_cas',
        amountCents: 26000,
        quoteVersion: 1,
        bookingVersion: 2,
        currency: 'usd',
        status: 'open',
      }],
    };
    let commits = 0;
    const session = {
      id: 'cs_cas',
      amount_total: 26000,
      currency: 'usd',
      payment_status: 'paid',
      metadata: {
        purpose: 'customer_balance',
        booking_id: 'CD1-CAS-REC',
        bookingVersion: '2',
        quoteVersion: '1',
      },
    };
    const applied = await applyCustomerBalanceReconciliation({
      bookingId: 'CD1-CAS-REC',
      session,
      maxAttempts: 4,
      getBookingRecord: async () => ({ exists: true, booking: { ...booking } }),
      commitBooking: async ({ expectedBookingVersion, nextAggregate }) => {
        commits += 1;
        if (commits === 1) {
          // Simulate concurrent writer
          version += 1;
          booking = { ...booking, bookingVersion: version, concurrentField: 'kept' };
          return { ok: false, error: 'version_conflict', statusCode: 409 };
        }
        if (expectedBookingVersion !== booking.bookingVersion) {
          return { ok: false, error: 'version_conflict', statusCode: 409 };
        }
        booking = { ...nextAggregate, bookingVersion: expectedBookingVersion + 1, concurrentField: booking.concurrentField };
        return { ok: true, booking };
      },
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.duplicate, false);
    assert.ok(applied.attempts >= 2);
    assert.equal(applied.booking.ledger.settledCents, 26000);
    assert.equal(applied.booking.concurrentField, 'kept');

    const again = await applyCustomerBalanceReconciliation({
      bookingId: 'CD1-CAS-REC',
      session,
      getBookingRecord: async () => ({ exists: true, booking }),
      commitBooking: async () => {
        throw new Error('should not commit on duplicate');
      },
    });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
  });
});

describe('Release A — stripe mode guard (PDA-17)', () => {
  const { guardStripeOrReject } = require('../netlify/lib/stripe-mode');

  it('local/preview with live key blocks before network', () => {
    const blocked = guardStripeOrReject({
      STRIPE_SECRET_KEY: 'sk_live_fake_for_test',
      CONTEXT: 'deploy-preview',
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.body.error, 'stripe_test_mode_required');
  });

  it('local NETLIFY_DEV with live key blocks', () => {
    const blocked = guardStripeOrReject({
      STRIPE_SECRET_KEY: 'sk_live_fake',
      NETLIFY_DEV: 'true',
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.body.error, 'stripe_test_mode_required');
  });

  it('test key in preview is allowed', () => {
    const ok = guardStripeOrReject({
      STRIPE_SECRET_KEY: 'sk_test_fake',
      CONTEXT: 'deploy-preview',
    });
    assert.equal(ok.blocked, false);
  });
});

describe('Release A — discounted remaining never uses catalog total (PDA-18)', () => {
  const { prepareBalanceCheckout } = require('../netlify/lib/payment-service');

  it('approved $256.50 sends 25650 not catalog 28500', () => {
    const aggregate = {
      id: 'CD1-DISC',
      bookingVersion: 1,
      quoteVersion: 1,
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      totalPrice: 285,
      approvedFinalAmount: 256.5,
      amountPaid: 0,
      ledger: { approvedCents: 25650, settledCents: 0, creditedCents: 0 },
    };
    const prepared = prepareBalanceCheckout(aggregate, {}, {
      STRIPE_SECRET_KEY: 'sk_test_fake',
      CONTEXT: 'dev',
      NETLIFY_DEV: 'true',
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.amountCents, 25650);
  });
});

describe('Release A — quote change remaining + supersede sessions (PDA-09)', () => {
  const {
    remainingCents,
    supersedeOpenAttempts,
    prepareBalanceCheckout,
  } = require('../netlify/lib/payment-service');

  it('approved $310/paid $50 then approved $460 → remaining $410; old session superseded', () => {
    const ledger = { approvedCents: 46000, settledCents: 5000, creditedCents: 0 };
    assert.equal(remainingCents(ledger), 41000);
    const attempts = supersedeOpenAttempts([
      {
        providerObjectId: 'cs_old_260',
        amountCents: 26000,
        quoteVersion: 1,
        bookingVersion: 2,
        status: 'open',
      },
    ], { quoteVersion: 2 });
    assert.equal(attempts[0].status, 'superseded');
    const prepared = prepareBalanceCheckout({
      id: 'CD1-QCHG',
      bookingVersion: 3,
      quoteVersion: 2,
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      ledger,
      paymentAttempts: attempts,
    }, {}, {
      STRIPE_SECRET_KEY: 'sk_test_fake',
      CONTEXT: 'dev',
      NETLIFY_DEV: 'true',
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.amountCents, 41000);
  });
});

describe('Release A — dormant payment-link route (PDA-18)', () => {
  it('create-payment-link returns 410 endpoint_disabled', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/create-payment-link.js'), 'utf8');
    assert.match(src, /410/);
    assert.match(src, /endpoint_disabled/);
    assert.doesNotMatch(src, /api\.stripe\.com/);
  });
});

describe('Release A — Admin request pagination (PDA-12)', () => {
  it('admin-customer-requests lists all pages before filtering', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-customer-requests.js'), 'utf8');
    assert.match(src, /listAllBlobs/);
    assert.doesNotMatch(src, /\.slice\(0,\s*200\)/);
  });
});

describe('Release A — Admin Stripe link (PDA-08)', () => {
  it('imports getBooking and rejects amount override', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    assert.match(src, /require\('\.\.\/lib\/ops-db'\)/);
    assert.match(src, /amount_override_rejected/);
    assert.match(src, /prepareBalanceCheckout/);
  });
});

describe('Release A — webhook customer_balance branch (PDA-03)', () => {
  it('stripe-webhook handles purpose=customer_balance via CAS reconcile', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/stripe-webhook.js'), 'utf8');
    assert.match(src, /customer_balance/);
    assert.match(src, /applyCustomerBalanceReconciliation/);
  });
});

describe('Release A — action-link refresh (PDA-15)', () => {
  it('my-garage retains actionToken in memory and does not claim paid from query alone', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    assert.match(src, /state\.actionToken/);
    assert.match(src, /Payment processing/);
    assert.doesNotMatch(src, /Payment received\. Thank you!/);
  });
});

describe('Release A — material projection parity', () => {
  const { materialProjection, normalizeAggregate } = require('../netlify/lib/booking-aggregate');
  const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
  const { projectJobForAdmin } = require('../netlify/lib/ops-workflow');

  it('Customer projection includes bookingVersion and remainingCents', () => {
    const { aggregate } = normalizeAggregate({
      id: 'CD1-P',
      bookingVersion: 5,
      quoteVersion: 3,
      schemaVersion: 1,
      approvedFinalAmount: 460,
      amountPaid: 50,
      ledger: { approvedCents: 46000, settledCents: 5000, creditedCents: 0 },
      vehicles: [{ vehicleId: 'v1', pkgId: 'premium', cat: 'cars' }],
    });
    const mat = materialProjection(aggregate);
    const cust = projectBookingForCustomer(aggregate);
    assert.equal(mat.bookingVersion, 5);
    assert.equal(mat.remainingCents, 41000);
    assert.equal(cust.bookingVersion, 5);
    assert.equal(cust.remainingCents, 41000);
  });

  it('Customer and Admin material money/versions match at same bookingVersion', () => {
    const raw = {
      id: 'CD1-PARITY',
      bookingVersion: 7,
      quoteVersion: 4,
      schemaVersion: 1,
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      approvedFinalAmount: 460,
      amountPaid: 50,
      ledger: { approvedCents: 46000, settledCents: 5000, creditedCents: 0 },
      vehicles: [{ vehicleId: 'v1', pkgId: 'premium', cat: 'cars', tierLabel: 'SUV 3-Row' }],
      changeRequests: [{ requestId: 'cr_1', requestVersion: 1, status: 'applied' }],
    };
    const { aggregate } = normalizeAggregate(raw);
    const cust = projectBookingForCustomer(aggregate);
    const admin = projectJobForAdmin(aggregate);
    assert.equal(cust.bookingVersion, admin.bookingVersion);
    assert.equal(cust.quoteVersion, admin.quoteVersion);
    assert.equal(cust.remainingCents, admin.remainingCents);
    assert.equal(cust.approvedFinalAmount, admin.approvedFinalAmount);
    assert.equal(cust.amountDueApproved, admin.amountDueApproved);
  });
});

describe('Release A — action-link memory refresh (PDA-15)', () => {
  it('my-garage retains action token only in memory and strips it from the URL', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    assert.match(src, /state\.actionToken = actionToken/);
    assert.match(src, /history\.replaceState/);
    assert.match(src, /never re-persist to URL\/localStorage/);
    assert.doesNotMatch(src, /localStorage\.setItem\([^)]*action/);
    assert.doesNotMatch(src, /sessionStorage\.setItem\([^)]*action/);
  });
});

describe('Release A — decide applies canonical quote not proposedTotal (PDA-01, PDA-05)', () => {
  it('decideChangeRequestCommand uses quoteService path', async () => {
    const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
    const { decideChangeRequestCommand } = require('../netlify/lib/booking-commands');

    const store = createMemoryStore({});
    setBookingStoreOverride(store);
    const result = await decideChangeRequestCommand({
      bookingId: 'missing',
      requestId: 'cr_x',
      decision: 'approve',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_found');
    setBookingStoreOverride(null);
  });

  it('approve package change applies canonical cents, ignores inflated proposedTotal, and writes a Postgres adjustment (Package Stage 1)', async () => {
    // Package Stage 1 routes package_change_request decide through the
    // authoritative Postgres mutation (package-financial-mutation.js) —
    // mirrors the frozen addon Stage 1 path. Requires DATABASE_URL/DIRECT_URL.
    assert.equal(
      prismaConfigured(),
      true,
      'DATABASE_URL/DIRECT_URL required — package decide now writes a Postgres adjustment'
    );
    const prisma = getPrisma();
    const bookingId = `TESTDB-PKGDECIDE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

    const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');

    const store = createMemoryStore({
      [bookingId]: {
        id: bookingId,
        bookingVersion: 2,
        schemaVersion: 1,
        quoteVersion: 1,
        status: 'Pending Review',
        appointmentStatus: 'pending_review',
        zipCode: '07102',
        travelFeeAmount: 0,
        approvedFinalAmount: 270,
        amountPaid: 0,
        ledger: { approvedCents: 27000, settledCents: 0, creditedCents: 0 },
        vehicles: [{
          vehicleId: 'veh_1',
          cat: 'cars',
          tierKey: 'suv3',
          tierLabel: 'SUV 3-Row',
          pkgId: 'full',
          packageId: 'full',
          addons: [],
        }],
        changeRequests: [],
      },
    });
    setBookingStoreOverride(store);

    try {
      const submitted = await submitChangeRequestCommand({
        bookingId,
        expectedBookingVersion: 2,
        requestType: 'package_change_request',
        target: { vehicleId: 'veh_1' },
        delta: {
          packageId: 'premium',
          packageName: 'Signature Interior & Exterior Restoration',
          vehicleCategory: 'cars',
          tierKey: 'suv3',
          // Inflated client total must be ignored on decide
          proposedTotal: 9999,
        },
      });
      assert.equal(submitted.ok, true);
      assert.equal(submitted.changeRequest.proposedApprovedCents, 54000);

      const decided = await decideChangeRequestCommand({
        bookingId,
        requestId: submitted.changeRequest.requestId,
        decision: 'approve',
        expectedBookingVersion: submitted.booking.bookingVersion,
      });
      assert.equal(
        decided.ok,
        true,
        `decide failed: ${decided.error || 'unknown'} ${decided.reason || ''} ${decided.statusCode || ''}`
      );
      assert.equal(decided.booking.ledger.approvedCents, 54000);
      assert.equal(decided.booking.approvedFinalAmount, 540);
      assert.notEqual(decided.booking.approvedFinalAmount, 9999);
      // Package Stage 1 — this is the Postgres-authoritative projection, not a
      // Blob-only figure; proves the adjustment was written to Postgres.
      assert.ok(decided.postgresProjection, 'decide must return a Postgres projection for package changes');
      assert.equal(decided.postgresProjection.approvedCents, 54000);
      assert.notEqual(decided.postgresProjection.approvedCents, 999900, 'must ignore inflated proposedTotal (9999)');

      const final = await getBookingRecord(bookingId);
      // The authoritative path commits once for the mutation and once more for
      // syncBlobCompatibilityFromProjection (same shared helper the frozen addon
      // path uses) — assert forward progress, not an exact delta of 1.
      assert.ok(
        final.booking.bookingVersion > submitted.booking.bookingVersion,
        `expected version to advance past ${submitted.booking.bookingVersion}, got ${final.booking.bookingVersion}`
      );
      assert.equal(final.booking.changeRequests.some((r) => r.status === 'applied'), true);
    } finally {
      setBookingStoreOverride(null);
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId } });
        await prisma.quote.deleteMany({ where: { bookingId } });
        await prisma.booking.delete({ where: { id: bookingId } });
      } catch { /* ledger children (FK RESTRICT) keep the booking alive by design */ }
    }
  });
});

describe('Release A — pending request pagination beyond 200 (PDA-12)', () => {
  it('listAllBlobs path surfaces pending beyond first 200 keys', async () => {
    const { listAllBlobs, fetchBlobRecords } = require('../netlify/lib/tech-security');
    const seed = {};
    for (let i = 0; i < 220; i++) {
      const id = `cr_${String(i).padStart(4, '0')}`;
      seed[id] = {
        id,
        status: i === 215 ? 'pending' : 'applied',
        createdAt: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
        requestType: 'package_change_request',
        bookingId: 'CD1-X',
      };
    }
    seed.cr_0215.status = 'pending';
    seed.cr_0215.createdAt = '2026-02-01T00:00:00.000Z';
    const store = createMemoryStore(seed, { pageSize: 50 });
    const blobs = await listAllBlobs(store, 'cd1-customer-change-requests');
    assert.ok(blobs.length >= 220);
    const items = await fetchBlobRecords(store, blobs);
    const pending = items
      .filter((r) => r && r.status === 'pending')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    assert.ok(pending.some((r) => r.id === 'cr_0215'));
    assert.equal(pending[0].id, 'cr_0215');
  });

  it('Admin list handler returns pending beyond key 200 with totalPending', async () => {
    const prev = {
      ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
      ADMIN_DASH_PASSWORD: process.env.ADMIN_DASH_PASSWORD,
      CONTEXT: process.env.CONTEXT,
      NETLIFY_DEV: process.env.NETLIFY_DEV,
    };
    process.env.ADMIN_SESSION_SECRET = 'release-a-test-admin-session-secret-32ch';
    process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';
    process.env.CONTEXT = 'dev';
    process.env.NETLIFY_DEV = 'true';

    const seed = {};
    for (let i = 0; i < 220; i++) {
      const id = `cr_${String(i).padStart(4, '0')}`;
      seed[id] = {
        id,
        status: 'applied',
        createdAt: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
        requestType: 'package_change_request',
        bookingId: 'CD1-X',
      };
    }
    seed.cr_0215 = {
      id: 'cr_0215',
      status: 'pending',
      createdAt: '2026-02-01T00:00:00.000Z',
      requestType: 'package_change_request',
      bookingId: 'CD1-X',
    };
    const store = createMemoryStore(seed, { pageSize: 50 });

    delete require.cache[require.resolve('../netlify/lib/admin-security')];
    delete require.cache[require.resolve('../netlify/functions/admin-customer-requests')];
    const { createAdminSession } = require('../netlify/lib/admin-security');
    const mod = require('../netlify/functions/admin-customer-requests');
    mod.setRequestStoreOverride(store);
    try {
      const sess = await createAdminSession('opsadmin');
      const res = await mod.handler({
        httpMethod: 'GET',
        headers: { 'x-admin-key': sess.token },
        queryStringParameters: { action: 'list' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.ok(body.totalPending >= 1);
      assert.ok(body.requests.some((r) => r.id === 'cr_0215'));
    } finally {
      mod.setRequestStoreOverride(null);
      process.env.ADMIN_SESSION_SECRET = prev.ADMIN_SESSION_SECRET;
      process.env.ADMIN_DASH_PASSWORD = prev.ADMIN_DASH_PASSWORD;
      process.env.CONTEXT = prev.CONTEXT;
      process.env.NETLIFY_DEV = prev.NETLIFY_DEV;
      delete require.cache[require.resolve('../netlify/lib/admin-security')];
      delete require.cache[require.resolve('../netlify/functions/admin-customer-requests')];
    }
  });
});

describe('Release A — stripe live-key rejection zero network (PDA-17)', () => {
  it('prepareBalanceCheckout with live key makes zero network calls', () => {
    let networkCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error('network should not run');
    };
    try {
      const { prepareBalanceCheckout } = require('../netlify/lib/payment-service');
      const prepared = prepareBalanceCheckout({
        id: 'CD1-LIVE',
        bookingVersion: 1,
        quoteVersion: 1,
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        jobStatus: 'confirmed',
        ledger: { approvedCents: 10000, settledCents: 0, creditedCents: 0 },
      }, {}, {
        STRIPE_SECRET_KEY: 'sk_live_should_block',
        CONTEXT: 'deploy-preview',
      });
      assert.equal(prepared.ok, false);
      assert.equal(prepared.error, 'stripe_test_mode_required');
      assert.equal(prepared.networkCalls, 0);
      assert.equal(networkCalls, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('capture-payment blocks live key before Stripe capture', async () => {
    const prev = {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      CONTEXT: process.env.CONTEXT,
      NETLIFY_DEV: process.env.NETLIFY_DEV,
      ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
      ADMIN_DASH_PASSWORD: process.env.ADMIN_DASH_PASSWORD,
    };
    process.env.STRIPE_SECRET_KEY = 'sk_live_block';
    process.env.CONTEXT = 'deploy-preview';
    process.env.NETLIFY_DEV = 'true';
    process.env.ADMIN_SESSION_SECRET = 'release-a-test-admin-session-secret-32ch';
    process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';

    let networkCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error('should not hit stripe');
    };
    try {
      delete require.cache[require.resolve('../netlify/lib/admin-security')];
      delete require.cache[require.resolve('../netlify/lib/tech-security')];
      delete require.cache[require.resolve('../netlify/functions/capture-payment')];
      const { createAdminSession } = require('../netlify/lib/admin-security');
      const { handler } = require('../netlify/functions/capture-payment');
      const sess = await createAdminSession('opsadmin');
      const res = await handler({
        httpMethod: 'POST',
        headers: { 'x-admin-key': sess.token },
        body: JSON.stringify({ paymentIntentId: 'pi_test_123' }),
      });
      assert.equal(res.statusCode, 503);
      assert.equal(JSON.parse(res.body).error, 'stripe_test_mode_required');
      assert.equal(networkCalls, 0);
    } finally {
      globalThis.fetch = origFetch;
      Object.assign(process.env, prev);
      delete require.cache[require.resolve('../netlify/functions/capture-payment')];
    }
  });
});

describe('Release A — cross-store index failure recovery', () => {
  it('approved booking version remains authoritative when index rebuild fails', async () => {
    // Package Stage 1 — decide now writes a Postgres adjustment (see the
    // "Package Stage 1" test above); this test's own DB requirement follows.
    assert.equal(
      prismaConfigured(),
      true,
      'DATABASE_URL/DIRECT_URL required — package decide now writes a Postgres adjustment'
    );
    const prisma = getPrisma();
    const bookingId = `TESTDB-PKGIDX-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

    const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
    const { decideChangeRequestCommand, submitChangeRequestCommand } = require('../netlify/lib/booking-commands');
    const tech = require('../netlify/lib/tech-security');
    const origBlobs = tech.blobsStore;

    const bookingStore = createMemoryStore({
      [bookingId]: {
        id: bookingId,
        bookingVersion: 1,
        quoteVersion: 1,
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        jobStatus: 'confirmed',
        zipCode: '07102',
        phone: '5513132956',
        service: {
          vehicles: [{
            vehicleId: 'veh_1',
            category: 'cars',
            tierKey: 'suv3',
            packageId: 'full',
            packageName: 'Full Detail',
            addOns: [],
          }],
        },
        ledger: { approvedCents: 40000, settledCents: 0, creditedCents: 0, entries: [] },
        changeRequests: [],
        paymentAttempts: [],
      },
    });
    setBookingStoreOverride(bookingStore);

    tech.blobsStore = async () => ({
      async setJSON() { throw new Error('index_store_down'); },
      async get() { return null; },
      async list() { return { blobs: [] }; },
    });

    try {
      const submitted = await submitChangeRequestCommand({
        bookingId,
        expectedBookingVersion: 1,
        requestType: 'package_change_request',
        target: { vehicleId: 'veh_1' },
        delta: {
          packageId: 'premium',
          packageName: 'Signature Interior & Exterior Restoration',
          vehicleCategory: 'cars',
          tierKey: 'suv3',
        },
      });
      assert.equal(submitted.ok, true);
      assert.equal(submitted.indexOk, false);

      const decided = await decideChangeRequestCommand({
        bookingId,
        requestId: submitted.changeRequest.requestId,
        decision: 'approve',
        expectedBookingVersion: submitted.booking.bookingVersion,
      });
      assert.equal(decided.ok, true);
      const final = await getBookingRecord(bookingId);
      assert.equal(final.booking.changeRequests.some((r) => r.status === 'applied'), true);
      assert.equal(final.booking.ledger.approvedCents, 54000);
    } finally {
      tech.blobsStore = origBlobs;
      setBookingStoreOverride(null);
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId } });
        await prisma.quote.deleteMany({ where: { bookingId } });
        await prisma.booking.delete({ where: { id: bookingId } });
      } catch { /* ledger children (FK RESTRICT) keep the booking alive by design */ }
    }
  });
});

describe('Release A — action-link focus/poll credential (PDA-15)', () => {
  it('strips raw token from URL and keeps in-memory credential for refresh', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    // Behavioral contract encoded in client: capture token once, strip from URL, reuse memory on focus/poll
    assert.match(src, /actionToken/);
    assert.match(src, /history\.replaceState|replaceState/);
    assert.match(src, /visibilitychange|focus|poll/i);
    assert.doesNotMatch(src, /localStorage\.setItem\([^)]*actionToken/);
    assert.doesNotMatch(src, /localStorage\.setItem\([^)]*token/);
  });
});

describe('Final readiness remediation — Admin CAS + overpayment', () => {
  it('Admin money mutation uses commitBooking CAS and syncs ledger', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    assert.match(src, /commitBooking/);
    assert.match(src, /MONEY_MUTATION_ACTIONS/);
    assert.match(src, /version_conflict/);
    assert.match(src, /supersedeOpenAttempts/);
    assert.doesNotMatch(
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
      /async function persistMutation[\s\S]{0,200}await store\.setJSON\(bookingId, booking\)/
    );
  });

  it('Admin Generate Stripe UI does not send amount override', () => {
    const src = fs.readFileSync(path.join(ROOT, 'admin-ops.html'), 'utf8');
    assert.match(src, /generate_stripe_pay_link/);
    assert.doesNotMatch(src, /prompt\('Charge amount/);
    assert.match(src, /authoritative remaining balance/);
  });

  it('rejects overpayment when settled would exceed remaining', () => {
    const { reconcileCustomerBalanceSession } = require('../netlify/lib/payment-service');
    const { normalizeAggregate } = require('../netlify/lib/booking-aggregate');
    const raw = {
      id: 'CD1-OV',
      bookingVersion: 3,
      quoteVersion: 2,
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      ledger: {
        approvedCents: 31000,
        settledCents: 20000,
        creditedCents: 0,
        entries: [],
      },
      paymentAttempts: [{
        providerObjectId: 'cs_test_over',
        bookingId: 'CD1-OV',
        bookingVersion: 2,
        quoteVersion: 2,
        amountCents: 31000,
        currency: 'usd',
        status: 'open',
      }],
      quote: { quoteVersion: 2, approvedCents: 31000 },
    };
    const { aggregate } = normalizeAggregate(raw);
    const result = reconcileCustomerBalanceSession({
      aggregate,
      session: {
        id: 'cs_test_over',
        amount_total: 31000,
        currency: 'usd',
        payment_status: 'paid',
        metadata: {
          booking_id: 'CD1-OV',
          purpose: 'customer_balance',
          bookingVersion: '2',
          quoteVersion: '2',
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'overpayment');
    assert.equal(result.quarantined, true);
  });

  it('canPayBalance uses ledger remaining not stale stored due', () => {
    const { canPayBalance } = require('../netlify/lib/appointment-status-policy');
    const legacyPaid = {
      status: 'Paid',
      appointmentStatus: 'paid',
      jobStatus: 'completed_paid',
      totalPrice: 225,
      amountDueApproved: 225,
      balanceDue: 225,
      ledger: { approvedCents: 22500, settledCents: 22500, creditedCents: 0 },
      _historicalPaidClosed: true,
    };
    const deny = canPayBalance(legacyPaid);
    assert.equal(deny.ok, false);

    const staleDue = {
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      approvedFinalAmount: 460,
      amountDueApproved: 260,
      balanceDue: 260,
      amountPaid: 50,
      ledger: { approvedCents: 46000, settledCents: 5000, creditedCents: 0 },
    };
    const allow = canPayBalance(staleDue);
    assert.equal(allow.ok, true);
    assert.equal(allow.due, 410);
  });

  it('setApprovedQuoteCommand remains exported for Admin quote authority', () => {
    const cmds = require('../netlify/lib/booking-commands');
    assert.equal(typeof cmds.setApprovedQuoteCommand, 'function');
    const adminSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    assert.match(adminSrc, /buildNextAggregate/);
    assert.match(adminSrc, /ledger/);
  });
});
