/**
 * Real PostgreSQL concurrency tests for Customer Identity Foundation.
 *
 * Runs ONLY when CUSTOMER_IDENTITY_TEST_DATABASE_URL is set to an isolated
 * database. Never defaults to DATABASE_URL.
 *
 * Guards (destructive setup refused unless all pass):
 * - CUSTOMER_IDENTITY_TEST_DATABASE_URL present
 * - CONTEXT / NODE_ENV is not production
 * - fingerprint differs from PRODUCTION_DATABASE_URL when that var is set
 * - fingerprint differs from a provided CUSTOMER_IDENTITY_PROD_DB_FINGERPRINT
 *   (hostHash/dbHash) when set
 *
 * Never prints connection URLs or credentials.
 */
require('dotenv/config');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const TEST_URL = String(process.env.CUSTOMER_IDENTITY_TEST_DATABASE_URL || '').trim();
const PROD_URL = String(process.env.PRODUCTION_DATABASE_URL || '').trim();
const PROD_FP_ENV = String(process.env.CUSTOMER_IDENTITY_PROD_DB_FINGERPRINT || '').trim();
const CONTEXT = String(process.env.CONTEXT || process.env.NODE_ENV || '').toLowerCase();

function urlFingerprint(raw) {
  if (!raw) return null;
  try {
    const normalized = raw.replace(/^prisma\+/, '');
    const u = new URL(normalized);
    const host = u.hostname || '';
    const db = (u.pathname || '/').replace(/^\//, '').split('?')[0] || '';
    return {
      hostHash: crypto.createHash('sha256').update(host).digest('hex').slice(0, 10),
      dbHash: crypto.createHash('sha256').update(db).digest('hex').slice(0, 10),
      hostTail: host.slice(-6),
      dbTail: db.slice(-6),
      rawHash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
    };
  } catch {
    return {
      hostHash: 'unparsed',
      dbHash: 'unparsed',
      hostTail: '??????',
      dbTail: '??????',
      rawHash: crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 12),
    };
  }
}

function fingerprintsEqual(a, b) {
  if (!a || !b) return false;
  if (a.rawHash && b.rawHash && a.rawHash === b.rawHash) return true;
  return a.hostHash === b.hostHash && a.dbHash === b.dbHash
    && a.hostHash !== 'unparsed';
}

function parseProdFpEnv(raw) {
  // Expected: "host=<10hex>,db=<10hex>" or "hostHash/dbHash"
  if (!raw) return null;
  const m = raw.match(/([a-f0-9]{10}).*?([a-f0-9]{10})/i);
  if (!m) return null;
  return { hostHash: m[1].toLowerCase(), dbHash: m[2].toLowerCase() };
}

const testFp = urlFingerprint(TEST_URL);
const prodFp = PROD_URL ? urlFingerprint(PROD_URL) : parseProdFpEnv(PROD_FP_ENV);
const isProductionContext = CONTEXT === 'production' || CONTEXT === 'prod';
const sameAsProduction = !!(testFp && prodFp && fingerprintsEqual(testFp, prodFp));

let skipReason = '';
if (!TEST_URL) {
  skipReason = 'SKIP: CUSTOMER_IDENTITY_TEST_DATABASE_URL not set (isolated DB required; does not use DATABASE_URL)';
} else if (isProductionContext) {
  skipReason = 'SKIP: refusing destructive identity concurrency tests in production context';
} else if (sameAsProduction) {
  skipReason = 'SKIP: test DB fingerprint matches Production DATABASE_URL / prod fingerprint';
}

if (skipReason) {
  // eslint-disable-next-line no-console
  console.log(`[customer-identity-pg] ${skipReason}`);
}

const RUN_ID = `CIDPG-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

function createClient(url) {
  if (url.startsWith('prisma+postgres://') || url.includes('accelerate.prisma-data.net')) {
    return new PrismaClient({ accelerateUrl: url });
  }
  // Prisma 7 requires accelerateUrl or a driver adapter; refuse opaque TCP URLs here
  // rather than print them or invent adapters.
  throw new Error(
    'CUSTOMER_IDENTITY_TEST_DATABASE_URL must be a Prisma Accelerate URL for this suite'
  );
}

describe(
  'customer identity postgres concurrency (isolated DB)',
  { skip: skipReason || false },
  () => {
    let prisma;
    const createdAccountIds = [];
    const createdBookingIds = [];

    before(() => {
      prisma = createClient(TEST_URL);
    });

    after(async () => {
      if (!prisma) return;
      try {
        for (const id of createdBookingIds) {
          try {
            await prisma.booking.updateMany({
              where: { id },
              data: { customerAccountId: null },
            });
            await prisma.auditEvent.deleteMany({ where: { bookingId: id } });
            await prisma.booking.deleteMany({ where: { id } });
          } catch { /* best-effort */ }
        }
        for (const id of createdAccountIds) {
          try {
            await prisma.customerProfile.deleteMany({ where: { customerAccountId: id } });
            await prisma.customerAccount.deleteMany({ where: { id } });
          } catch { /* best-effort */ }
        }
        try {
          await prisma.auditEvent.deleteMany({
            where: {
              action: {
                in: [
                  'customer_account.created',
                  'customer_account.ambiguity',
                  'customer_account.booking_linked',
                ],
              },
              createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
            },
          });
        } catch { /* ignore */ }
      } finally {
        await prisma.$disconnect().catch(() => {});
      }
    });

    it('refuses to run when fingerprints collide (guard self-check)', () => {
      assert.ok(TEST_URL);
      assert.equal(sameAsProduction, false);
      assert.equal(isProductionContext, false);
      assert.ok(testFp.hostHash);
      // eslint-disable-next-line no-console
      console.log(
        `[customer-identity-pg] test_db_fp host=${testFp.hostHash} db=${testFp.dbHash} `
        + `raw=${testFp.rawHash} prod_match=false`
      );
    });

    it('two concurrent resolutions create exactly one account and profile', async () => {
      delete require.cache[require.resolve('../netlify/lib/customer-account-service')];
      const svc = require('../netlify/lib/customer-account-service');
      const email = `concurrent.${RUN_ID.toLowerCase()}@example.test`;
      const phone = '2015550401';

      const [a, b] = await Promise.all([
        svc.resolveOrCreateCustomerAccount(
          { verifiedEmail: email, verifiedPhone: phone, firstName: 'Conc', lastName: 'A' },
          { prisma }
        ),
        svc.resolveOrCreateCustomerAccount(
          { verifiedEmail: email, verifiedPhone: phone, firstName: 'Conc', lastName: 'B' },
          { prisma }
        ),
      ]);

      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.equal(a.customerAccountId, b.customerAccountId);
      createdAccountIds.push(a.customerAccountId);

      assert.equal(await prisma.customerAccount.count({ where: { id: a.customerAccountId } }), 1);
      assert.equal(await prisma.customerProfile.count({ where: { customerAccountId: a.customerAccountId } }), 1);
      assert.equal(await prisma.customerProfile.count({ where: { normalizedEmail: email } }), 1);
    });

    it('advisory lock is exercised in PostgreSQL during resolution', async () => {
      delete require.cache[require.resolve('../netlify/lib/customer-account-service')];
      const svc = require('../netlify/lib/customer-account-service');
      const email = `lock.${RUN_ID.toLowerCase()}@example.test`;
      const phone = '2015550402';

      let sawAdvisorySql = false;
      const root = prisma;
      const spy = {
        ...root,
        $transaction: async (fn) => root.$transaction(async (tx) => {
          const wrapped = new Proxy(tx, {
            get(t2, p2, r2) {
              if (p2 === '$executeRawUnsafe') {
                return async (sql, ...args) => {
                  if (/pg_advisory_xact_lock/i.test(String(sql))) sawAdvisorySql = true;
                  return t2.$executeRawUnsafe(sql, ...args);
                };
              }
              const val = Reflect.get(t2, p2, r2);
              return typeof val === 'function' ? val.bind(t2) : val;
            },
          });
          return fn(wrapped);
        }),
        customerAccount: root.customerAccount,
        customerProfile: root.customerProfile,
        booking: root.booking,
        auditEvent: root.auditEvent,
        $executeRawUnsafe: root.$executeRawUnsafe.bind(root),
      };

      const r = await svc.resolveOrCreateCustomerAccount(
        { verifiedEmail: email, verifiedPhone: phone },
        { prisma: spy }
      );
      assert.equal(r.ok, true);
      createdAccountIds.push(r.customerAccountId);
      assert.equal(sawAdvisorySql, true, 'pg_advisory_xact_lock must run inside the transaction');
    });

    it('forced transaction failure leaves no partial identity rows', async () => {
      delete require.cache[require.resolve('../netlify/lib/customer-account-service')];
      const svc = require('../netlify/lib/customer-account-service');
      const email = `partial.${RUN_ID.toLowerCase()}@example.test`;
      const phone = '2015550403';
      const bookingId = `${RUN_ID}-BK-PARTIAL`;

      await prisma.booking.create({
        data: {
          id: bookingId,
          customerAccountId: null,
          status: 'submitted',
          isDraft: false,
        },
      });
      createdBookingIds.push(bookingId);

      const beforeAccounts = await prisma.customerProfile.count({
        where: { normalizedEmail: email },
      });

      const failing = {
        ...prisma,
        $transaction: async () => {
          throw Object.assign(new Error('InteractiveTransaction simulated outage'), {
            code: 'P2028',
          });
        },
        customerAccount: prisma.customerAccount,
        customerProfile: prisma.customerProfile,
        booking: prisma.booking,
        auditEvent: prisma.auditEvent,
      };

      await assert.rejects(
        () => svc.resolveOrCreateCustomerAccount(
          { verifiedEmail: email, verifiedPhone: phone },
          { prisma: failing }
        ),
        (err) => err.code === 'customer_identity_transaction_failed'
      );

      assert.equal(
        await prisma.customerProfile.count({ where: { normalizedEmail: email } }),
        beforeAccounts
      );
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      assert.equal(booking.customerAccountId, null);
    });

    it('idempotent create does not duplicate customer_account.created audits on retry', async () => {
      delete require.cache[require.resolve('../netlify/lib/customer-account-service')];
      const svc = require('../netlify/lib/customer-account-service');
      const email = `idem.${RUN_ID.toLowerCase()}@example.test`;
      const phone = '2015550404';

      const first = await svc.resolveOrCreateCustomerAccount(
        { verifiedEmail: email, verifiedPhone: phone },
        { prisma }
      );
      assert.equal(first.status, 'created');
      createdAccountIds.push(first.customerAccountId);

      const allCreated = await prisma.auditEvent.findMany({
        where: { action: 'customer_account.created' },
      });
      const createdAudits = allCreated.filter(
        (row) => row.detail && row.detail.customerAccountId === first.customerAccountId
      ).length;
      assert.equal(createdAudits, 1);

      const second = await svc.resolveOrCreateCustomerAccount(
        { verifiedEmail: email, verifiedPhone: phone },
        { prisma }
      );
      assert.equal(second.customerAccountId, first.customerAccountId);
      assert.equal(second.status, 'resolved');

      const afterAll = await prisma.auditEvent.findMany({
        where: { action: 'customer_account.created' },
      });
      const after = afterAll.filter(
        (row) => row.detail && row.detail.customerAccountId === first.customerAccountId
      ).length;
      assert.equal(after, 1);
    });
  }
);
