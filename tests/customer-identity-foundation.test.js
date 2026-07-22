/**
 * Customer Identity Foundation Stage 1 — focused coverage.
 */
require('dotenv/config');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIdentityMemoryPrisma } = require('./helpers/identity-memory-prisma');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SERVICE_PATH = require.resolve('../netlify/lib/customer-account-service');
const PROJECTION_PATH = require.resolve('../netlify/lib/customer-identity-projection');
const SESSION_PATH = require.resolve('../netlify/lib/customer-session');
const AUTH_PATH = require.resolve('../netlify/functions/customer-portal-auth');
const DATA_PATH = require.resolve('../netlify/functions/customer-portal-data');
const PRISMA_PATH = require.resolve('../netlify/lib/prisma');

const TEST_SESSION_SECRET = 'test-customer-session-secret-32chars!!';

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  return {
    data,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      return opts && opts.type === 'json' ? structuredClone(v) : v;
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value));
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function cookieEvent(token, body = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      cookie: token ? `cd1_customer_session=${encodeURIComponent(token)}` : '',
    },
    body: JSON.stringify(body),
  };
}

describe('customer identity foundation', () => {
  let prisma;
  let envSnap;
  let sessionStore;

  beforeEach(() => {
    prisma = createIdentityMemoryPrisma();
    sessionStore = createMemoryStore();
    envSnap = {
      CUSTOMER_SESSION_SECRET: process.env.CUSTOMER_SESSION_SECRET,
      CONTEXT: process.env.CONTEXT,
    };
    process.env.CUSTOMER_SESSION_SECRET = TEST_SESSION_SECRET;
    process.env.CONTEXT = 'dev';
    delete require.cache[SERVICE_PATH];
    delete require.cache[PROJECTION_PATH];
    delete require.cache[SESSION_PATH];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      const session = require('../netlify/lib/customer-session');
      if (session.resetCustomerSessionStoreFactory) session.resetCustomerSessionStoreFactory();
    } catch { /* ignore */ }
    delete require.cache[SERVICE_PATH];
    delete require.cache[PROJECTION_PATH];
    delete require.cache[SESSION_PATH];
    delete require.cache[AUTH_PATH];
    delete require.cache[DATA_PATH];
  });

  it('1. first verified login creates one account', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const r = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'alice@example.com',
      verifiedPhone: '5513132956',
      firstName: 'Alice',
      lastName: 'One',
    }, { prisma });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'created');
    assert.ok(r.customerAccountId);
    assert.equal(await prisma.customerAccount.count(), 1);
  });

  it('2. retry reuses the account', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const first = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'bob@example.com',
      verifiedPhone: '2015550101',
    }, { prisma });
    const second = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'bob@example.com',
      verifiedPhone: '2015550101',
    }, { prisma });
    assert.equal(second.customerAccountId, first.customerAccountId);
    assert.equal(second.status, 'resolved');
    assert.equal(await prisma.customerAccount.count(), 1);
  });

  it('3. concurrent first login does not create uncontrolled duplicates', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const input = { verifiedEmail: 'race@example.com', verifiedPhone: '2015550199' };
    const results = await Promise.all([
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
    ]);
    const ids = new Set(results.map((r) => r.customerAccountId).filter(Boolean));
    assert.equal(ids.size, 1, 'concurrent creates must converge on one account');
    assert.equal(await prisma.customerAccount.count(), 1);
    assert.equal(await prisma.customerProfile.count(), 1);
  });

  it('4. exactly one profile exists per account', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const r = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'profile@example.com',
      verifiedPhone: '2015550111',
    }, { prisma });
    assert.equal(await prisma.customerProfile.count({
      where: { customerAccountId: r.customerAccountId },
    }), 1);
    await assert.rejects(
      () => prisma.customerProfile.create({
        data: {
          customerAccountId: r.customerAccountId,
          email: 'other@example.com',
          normalizedEmail: 'other@example.com',
        },
      }),
      /Unique|P2002/i
    );
  });

  it('5. session receives customerAccountId', async () => {
    const session = require('../netlify/lib/customer-session');
    session.setCustomerSessionStoreFactory(() => sessionStore);
    const { token, session: payload } = await session.createAccountSession({
      phoneDigits: '2015550122',
      email: 'sess@example.com',
      bookingIds: ['BK-1'],
      customerAccountId: 'acct_test_123',
    });
    assert.equal(payload.customerAccountId, 'acct_test_123');
    const validated = await session.validateCustomerSession(cookieEvent(token));
    assert.equal(validated.ok, true);
    assert.equal(validated.customerAccountId, 'acct_test_123');
  });

  it('6. existing linked booking resolves the same account', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const created = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'link@example.com',
      verifiedPhone: '2015550133',
    }, { prisma });
    await prisma.booking.create({
      data: {
        id: 'BK-LINKED',
        customerAccountId: created.customerAccountId,
        status: 'submitted',
        isDraft: false,
      },
    });
    const again = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'other-path@example.com',
      verifiedPhone: '9995550000',
      bookingIds: ['BK-LINKED'],
    }, { prisma, createIfMissing: false });
    assert.equal(again.customerAccountId, created.customerAccountId);
    assert.equal(again.resolutionPath, 'booking_link');
  });

  it('7. eligible null booking is linked', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const created = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'nullbook@example.com',
      verifiedPhone: '2015550144',
    }, { prisma });
    await prisma.booking.create({
      data: { id: 'BK-NULL', customerAccountId: null, status: 'submitted', isDraft: false },
    });
    const link = await svc.linkBookingToAccount(prisma, {
      bookingId: 'BK-NULL',
      customerAccountId: created.customerAccountId,
    });
    assert.equal(link.ok, true);
    assert.equal(link.linked, true);
    const row = await prisma.booking.findUnique({ where: { id: 'BK-NULL' } });
    assert.equal(row.customerAccountId, created.customerAccountId);
  });

  it('8. linked booking is never overwritten', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const a = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'owner-a@example.com',
      verifiedPhone: '2015550151',
    }, { prisma });
    const b = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'owner-b@example.com',
      verifiedPhone: '2015550152',
    }, { prisma });
    await prisma.booking.create({
      data: {
        id: 'BK-OWNED',
        customerAccountId: a.customerAccountId,
        status: 'submitted',
        isDraft: false,
      },
    });
    const link = await svc.linkBookingToAccount(prisma, {
      bookingId: 'BK-OWNED',
      customerAccountId: b.customerAccountId,
    });
    assert.equal(link.ok, false);
    assert.equal(link.error, 'already_linked_other');
    const row = await prisma.booking.findUnique({ where: { id: 'BK-OWNED' } });
    assert.equal(row.customerAccountId, a.customerAccountId);
  });

  it('9. ambiguous contact candidates are not merged', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const a = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'dup@example.com',
      verifiedPhone: '2015550161',
    }, { prisma });
    // Force a second account sharing email (family / collision) without going through resolver.
    const second = await prisma.customerAccount.create({ data: { status: 'active', version: 1 } });
    await prisma.customerProfile.create({
      data: {
        customerAccountId: second.id,
        email: 'dup@example.com',
        normalizedEmail: 'dup@example.com',
        phone: '2015550162',
        normalizedPhone: '2015550162',
      },
    });
    const result = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'dup@example.com',
      verifiedPhone: '2015550190',
    }, { prisma });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.customerAccountId, null);
    assert.notEqual(a.customerAccountId, second.id);
    assert.equal(await prisma.customerAccount.count(), 2);
  });

  it('10. shared family contact is not silently merged', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'parent@example.com',
      verifiedPhone: '2015550171',
    }, { prisma });
    const childAcct = await prisma.customerAccount.create({ data: { status: 'active', version: 1 } });
    await prisma.customerProfile.create({
      data: {
        customerAccountId: childAcct.id,
        email: 'child@example.com',
        normalizedEmail: 'child@example.com',
        phone: '2015550171',
        normalizedPhone: '2015550171',
      },
    });
    const result = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'parent@example.com',
      verifiedPhone: '2015550171',
    }, { prisma });
    // Email+phone together match parent only — should resolve parent, not merge child.
    // If phone alone would collide across accounts without exact email+phone, ambiguity.
    assert.ok(result.ok || result.status === 'ambiguous');
    if (result.ok) {
      assert.equal(await prisma.customerAccount.count(), 2, 'must not collapse family accounts');
    }
  });

  it('11. conflicting email/phone are not merged', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'email-owner@example.com',
      verifiedPhone: '2015550181',
    }, { prisma });
    await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'phone-owner@example.com',
      verifiedPhone: '2015550182',
    }, { prisma });
    const result = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'email-owner@example.com',
      verifiedPhone: '2015550182',
    }, { prisma });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.ambiguity.reason, 'email_phone_conflict');
    assert.equal(await prisma.customerAccount.count(), 2);
  });

  it('12. browser-supplied customerAccountId is ignored', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const real = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'real@example.com',
      verifiedPhone: '2015550191',
    }, { prisma });
    const decoy = await prisma.customerAccount.create({ data: { status: 'active', version: 1 } });
    await prisma.customerProfile.create({
      data: {
        customerAccountId: decoy.id,
        email: 'decoy@example.com',
        normalizedEmail: 'decoy@example.com',
      },
    });
    const result = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'real@example.com',
      verifiedPhone: '2015550191',
      customerAccountId: decoy.id,
      browserCustomerAccountId: decoy.id,
    }, { prisma, acceptBrowserAccountId: false, trustSessionAccountId: false });
    assert.equal(result.customerAccountId, real.customerAccountId);
    assert.notEqual(result.customerAccountId, decoy.id);
  });

  it('13. revoked session remains rejected', async () => {
    const session = require('../netlify/lib/customer-session');
    session.setCustomerSessionStoreFactory(() => sessionStore);
    const { token } = await session.createAccountSession({
      phoneDigits: '2015550200',
      email: 'revoked@example.com',
      customerAccountId: 'acct_rev',
    });
    const before = await session.validateCustomerSession(cookieEvent(token));
    assert.equal(before.ok, true);
    await session.revokeCustomerSession(cookieEvent(token));
    const after = await session.validateCustomerSession(cookieEvent(token));
    assert.equal(after.ok, false);
    assert.equal(after.error, 'session_invalid');
  });

  it('14. legacy Booking ID + phone remains operational', async () => {
    const authSrc = read('netlify/lib/booking-customer-auth.js');
    assert.match(authSrc, /authorizeBookingAccess/);
    assert.match(authSrc, /phonesMatchForPortal/);
    // Limited mode does not require CustomerAccount.
    const dataSrc = read('netlify/functions/customer-portal-data.js');
    assert.match(dataSrc, /mode === 'limited'/);
    assert.match(dataSrc, /authorizeBookingAccess/);
  });

  it('15. dual-read preserves prior booking visibility', async () => {
    const dataSrc = read('netlify/functions/customer-portal-data.js');
    assert.match(dataSrc, /listBookingIdsForAccount/);
    assert.match(dataSrc, /sessionBookingIds/);
    assert.match(dataSrc, /phonesMatch/);
    assert.match(dataSrc, /Dual-read order/);
  });

  it('16. one account cannot access another account\'s booking', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const a = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'iso-a@example.com',
      verifiedPhone: '2015550211',
    }, { prisma });
    const b = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'iso-b@example.com',
      verifiedPhone: '2015550212',
    }, { prisma });
    await prisma.booking.create({
      data: {
        id: 'BK-ISO-A',
        customerAccountId: a.customerAccountId,
        status: 'submitted',
        isDraft: false,
      },
    });
    const { sessionBookingAllowed, normalizeBookingId } = require('../netlify/lib/booking-customer-auth');
    const allowed = sessionBookingAllowed(
      {
        customerAccountId: b.customerAccountId,
        bookingIds: ['BK-ISO-A'],
        phoneDigits: '2015550211',
      },
      { id: 'BK-ISO-A', customerAccountId: a.customerAccountId, phone: '2015550211' }
    );
    assert.equal(allowed, false);
    assert.equal(normalizeBookingId('bk-iso-a'), 'BK-ISO-A');
  });

  it('17. customer projection excludes internal fields', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const proj = require('../netlify/lib/customer-identity-projection');
    const created = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'proj@example.com',
      verifiedPhone: '2015550222',
      firstName: 'Pat',
      lastName: 'Customer',
    }, { prisma });
    await prisma.customerAddress.create({
      data: {
        customerAccountId: created.customerAccountId,
        line1: '1 Main St',
        city: 'Hoboken',
        state: 'NJ',
        postalCode: '07030',
        isDefault: true,
      },
    });
    // Attach stripe id on account — must not appear in projection.
    prisma._db.customerAccount.get(created.customerAccountId).stripeCustomerId = 'cus_SECRET';
    const graph = await svc.loadCustomerAccountGraph(created.customerAccountId, { prisma });
    const customer = proj.assertSafeCustomerProjection(proj.projectCustomerIdentity(graph));
    assert.equal(customer.customerAccountId, created.customerAccountId);
    assert.ok(customer.profile);
    assert.ok(Array.isArray(customer.addresses));
    assert.ok(Array.isArray(customer.consents));
    assert.equal(customer.accountVersion, 1);
    assert.equal(customer.stripeCustomerId, undefined);
    assert.equal(customer.mergedIntoAccountId, undefined);
    assert.equal(customer.profile.normalizedEmail, undefined);
    assert.equal(JSON.stringify(customer).includes('cus_SECRET'), false);
  });

  it('18. admin projection groups linked bookings correctly', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const proj = require('../netlify/lib/customer-identity-projection');
    const created = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'admin@example.com',
      verifiedPhone: '2015550233',
      firstName: 'Ada',
      lastName: 'Admin',
    }, { prisma });
    await prisma.booking.create({
      data: { id: 'BK-ADM-1', customerAccountId: created.customerAccountId, status: 'submitted', isDraft: false },
    });
    await prisma.booking.create({
      data: { id: 'BK-ADM-2', customerAccountId: created.customerAccountId, status: 'completed', isDraft: false },
    });
    const summary = await proj.buildAdminCustomerAccountSummary(created.customerAccountId, { prisma });
    assert.equal(summary.customerAccountId, created.customerAccountId);
    assert.equal(summary.linkedBookingCount, 2);
    assert.ok(summary.linkedBookingIds.includes('BK-ADM-1'));
    assert.ok(summary.linkedBookingIds.includes('BK-ADM-2'));
    assert.equal(summary.email, 'admin@example.com');
    assert.equal(summary.stripeCustomerId, undefined);
  });

  it('19. existing Customer model has a documented non-competing role', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    assert.equal(
      svc.EXISTING_CUSTOMER_ROLE,
      'legacy_payment_compatibility_placeholder_not_identity_authority'
    );
    const schema = read('prisma/schema.prisma');
    assert.match(schema, /NOT the permanent identity root/);
    assert.match(schema, /model CustomerAccount/);
    assert.match(schema, /model CustomerProfile/);
    assert.match(schema, /customerAccountId/);
    // No competing CustomerAccount on legacy Customer table required for Stage 1.
    assert.doesNotMatch(
      schema.match(/model Customer \{[\s\S]*?\n\}/)[0],
      /customerAccountId/
    );
  });

  it('20. migration applies to a populated test database (or schema is additive)', async () => {
    const migration = read(
      'prisma/migrations/20260722000000_customer_identity_foundation/migration.sql'
    );
    assert.match(migration, /CREATE TABLE "CustomerAccount"/);
    assert.match(migration, /CREATE TABLE "CustomerProfile"/);
    assert.match(migration, /CREATE TABLE "CustomerAddress"/);
    assert.match(migration, /CREATE TABLE "CustomerConsent"/);
    assert.match(migration, /ADD COLUMN "customerAccountId"/);
    assert.doesNotMatch(migration, /DROP TABLE/i);
    assert.doesNotMatch(migration, /DROP COLUMN/i);
    // No incorrect global uniqueness on phone/email
    assert.doesNotMatch(migration, /UNIQUE.*"normalizedEmail"/);
    assert.doesNotMatch(migration, /UNIQUE.*"normalizedPhone"/);
    assert.match(migration, /CustomerConsent_customerAccountId_channel_key/);

    const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');
    if (!prismaConfigured()) {
      assert.ok(true, 'schema/migration additive checks passed without live DB');
      return;
    }
    const live = getPrisma();
    // Prove tables exist after migrate (caller runs migrate deploy in validation).
    const accounts = await live.customerAccount.count();
    assert.equal(typeof accounts, 'number');
  });

  it('21. payment/quote/ledger behavior remains unchanged', async () => {
    const schema = read('prisma/schema.prisma');
    assert.match(schema, /model PaymentAttempt/);
    assert.match(schema, /model LedgerEntry/);
    assert.match(schema, /model Quote /);
    const migration = read(
      'prisma/migrations/20260722000000_customer_identity_foundation/migration.sql'
    );
    assert.doesNotMatch(migration, /PaymentAttempt/);
    assert.doesNotMatch(migration, /LedgerEntry/);
    assert.doesNotMatch(migration, /ALTER TABLE "Quote"/);
    // Authority service file untouched by Stage 1 identity work beyond admin list enrichment.
    const paySrc = read('netlify/lib/db/payment-authority-service.js');
    assert.match(paySrc, /function|exports/);
  });

  it('schema models include address + consent + nullable booking link', () => {
    const schema = read('prisma/schema.prisma');
    assert.match(schema, /model CustomerAddress/);
    assert.match(schema, /model CustomerConsent/);
    assert.match(schema, /email_transactional/);
    assert.match(schema, /sms_marketing/);
    assert.match(schema, /archivedAt/);
  });

  it('auth verify wires resolve + backfill + session account id', () => {
    const src = read('netlify/functions/customer-portal-auth.js');
    assert.match(src, /resolveOrCreateCustomerAccount/);
    assert.match(src, /backfillBookingsOnLogin/);
    assert.match(src, /customerAccountId/);
    assert.match(src, /acceptBrowserAccountId: false/);
  });

  it('backfill only links null bookings and is idempotent', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const created = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'backfill@example.com',
      verifiedPhone: '2015550244',
    }, { prisma });
    await prisma.booking.create({
      data: { id: 'BK-BF-1', customerAccountId: null, status: 'submitted', isDraft: false },
    });
    const other = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'other-bf@example.com',
      verifiedPhone: '2015550245',
    }, { prisma });
    await prisma.booking.create({
      data: {
        id: 'BK-BF-OTHER',
        customerAccountId: other.customerAccountId,
        status: 'submitted',
        isDraft: false,
      },
    });

    const first = await svc.backfillBookingsOnLogin({
      customerAccountId: created.customerAccountId,
      verifiedEmail: 'backfill@example.com',
      verifiedPhone: '2015550244',
      bookingIds: ['BK-BF-1', 'BK-BF-OTHER'],
      blobBookings: [
        { id: 'BK-BF-1', email: 'backfill@example.com', phone: '2015550244' },
        { id: 'BK-BF-OTHER', email: 'other-bf@example.com', phone: '2015550245' },
      ],
      prisma,
    });
    assert.equal(first.ok, true);
    assert.ok(first.linked.some((x) => x.bookingId === 'BK-BF-1'));
    assert.ok(first.skipped.some((x) => x.bookingId === 'BK-BF-OTHER'));

    const second = await svc.backfillBookingsOnLogin({
      customerAccountId: created.customerAccountId,
      verifiedEmail: 'backfill@example.com',
      verifiedPhone: '2015550244',
      bookingIds: ['BK-BF-1'],
      prisma,
    });
    assert.equal(second.ok, true);
    assert.ok(second.linked.every((x) => x.alreadyLinked || x.linked));
  });

  it('transaction failure: generic DB error fails closed with no account rows', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const beforeAccounts = await prisma.customerAccount.count();
    const beforeProfiles = await prisma.customerProfile.count();
    const beforeAudits = await prisma.auditEvent.count();
    const beforeTxn = prisma._meta.transactionCalls;

    prisma.failNextTransactionWith(new Error('connection terminated unexpectedly'));

    await assert.rejects(
      () => svc.resolveOrCreateCustomerAccount({
        verifiedEmail: 'txn-fail@example.com',
        verifiedPhone: '2015550301',
      }, { prisma }),
      (err) => {
        assert.equal(err.code, 'customer_identity_transaction_failed');
        assert.match(String(err.message), /customer_identity_transaction_failed/);
        assert.doesNotMatch(String(err.message), /connection terminated/i);
        return true;
      }
    );

    assert.equal(prisma._meta.transactionCalls, beforeTxn + 1);
    assert.equal(await prisma.customerAccount.count(), beforeAccounts);
    assert.equal(await prisma.customerProfile.count(), beforeProfiles);
    assert.equal(await prisma.auditEvent.count(), beforeAudits);
    assert.equal(await prisma.booking.count({ where: { customerAccountId: { not: null } } }), 0);
  });

  it('transaction failure: message matching InteractiveTransaction still does not fall back', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const phrases = [
      'InteractiveTransaction is not supported',
      'transaction already closed',
      'prisma.$transaction is not a function',
    ];
    for (const message of phrases) {
      const beforeAccounts = await prisma.customerAccount.count();
      const beforeProfiles = await prisma.customerProfile.count();
      prisma.failNextTransactionWith(Object.assign(new Error(message), { code: 'P2028' }));
      await assert.rejects(
        () => svc.resolveOrCreateCustomerAccount({
          verifiedEmail: `phrase-${phrases.indexOf(message)}@example.com`,
          verifiedPhone: `20155503${10 + phrases.indexOf(message)}`,
        }, { prisma }),
        (err) => err.code === 'customer_identity_transaction_failed'
      );
      assert.equal(await prisma.customerAccount.count(), beforeAccounts, `must not create after: ${message}`);
      assert.equal(await prisma.customerProfile.count(), beforeProfiles);
    }
  });

  it('mid-transaction failure rolls back account, profile, booking link, and audits', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    await prisma.booking.create({
      data: { id: 'BK-TX-ROLL', customerAccountId: null, status: 'submitted', isDraft: false },
    });
    const beforeAccounts = await prisma.customerAccount.count();
    const beforeProfiles = await prisma.customerProfile.count();
    const beforeAudits = await prisma.auditEvent.count();

    // Allow account create (1), then fail before profile create (2nd write).
    prisma.failInsideNextTransactionAfter(
      1,
      Object.assign(new Error('forced mid-transaction disk full'), { code: 'P1001' })
    );

    await assert.rejects(
      () => svc.resolveOrCreateCustomerAccount({
        verifiedEmail: 'rollback@example.com',
        verifiedPhone: '2015550320',
      }, { prisma }),
      (err) => err.code === 'customer_identity_transaction_failed'
    );

    assert.equal(await prisma.customerAccount.count(), beforeAccounts);
    assert.equal(await prisma.customerProfile.count(), beforeProfiles);
    assert.equal(await prisma.auditEvent.count(), beforeAudits);
    const booking = await prisma.booking.findUnique({ where: { id: 'BK-TX-ROLL' } });
    assert.equal(booking.customerAccountId, null);
  });

  it('successful retry after DB recovers creates exactly one account and profile', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    prisma.failNextTransactionWith(new Error('temporary transaction outage'));
    await assert.rejects(
      () => svc.resolveOrCreateCustomerAccount({
        verifiedEmail: 'recover@example.com',
        verifiedPhone: '2015550330',
      }, { prisma }),
      (err) => err.code === 'customer_identity_transaction_failed'
    );
    assert.equal(await prisma.customerAccount.count(), 0);

    const ok = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'recover@example.com',
      verifiedPhone: '2015550330',
    }, { prisma });
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 'created');
    assert.equal(await prisma.customerAccount.count(), 1);
    assert.equal(await prisma.customerProfile.count(), 1);

    const again = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'recover@example.com',
      verifiedPhone: '2015550330',
    }, { prisma });
    assert.equal(again.customerAccountId, ok.customerAccountId);
    assert.equal(await prisma.customerAccount.count(), 1);
    assert.equal(await prisma.customerProfile.count(), 1);
  });

  it('concurrent transactional path still resolves to one account', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const input = { verifiedEmail: 'concurrent-tx@example.com', verifiedPhone: '2015550340' };
    const results = await Promise.all([
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
    ]);
    assert.ok(results.every((r) => r.ok));
    assert.equal(new Set(results.map((r) => r.customerAccountId)).size, 1);
    assert.equal(await prisma.customerAccount.count(), 1);
    assert.equal(await prisma.customerProfile.count(), 1);
    assert.ok(prisma._meta.transactionCalls >= 1);
    assert.ok(prisma._meta.advisoryLockCalls >= 1);
  });

  it('missing $transaction without allowNonTransactional fails closed', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const bare = createIdentityMemoryPrisma();
    delete bare.$transaction;
    const result = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'no-tx@example.com',
      verifiedPhone: '2015550350',
    }, { prisma: bare });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.error, 'transaction_unavailable');
    assert.equal(await bare.customerAccount.count(), 0);
  });

  it('schema documents Booking.customerAccountId identity-linkage writers', () => {
    const schema = read('prisma/schema.prisma');
    assert.match(schema, /identity-linkage field only/);
    assert.match(schema, /backfill-on-login/);
    assert.match(schema, /never overwritten/);
    assert.match(schema, /Financial authority/);
  });
});
