/**
 * CustomerAccount resolution primitives (Commit 1 — data model + service).
 * Session/portal integration coverage lives in customer-identity-foundation.test.js.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityMemoryPrisma } = require('./helpers/identity-memory-prisma');

describe('customer account resolution', () => {
  let prisma;

  beforeEach(() => {
    prisma = createIdentityMemoryPrisma();
    delete require.cache[require.resolve('../netlify/lib/customer-account-service')];
  });

  it('creates one account on first verified identity', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const r = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'one@example.com',
      verifiedPhone: '2015551001',
    }, { prisma });
    assert.equal(r.status, 'created');
    assert.equal(await prisma.customerAccount.count(), 1);
    assert.equal(await prisma.customerProfile.count(), 1);
  });

  it('reuses account on retry and under concurrency', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const input = { verifiedEmail: 'race@example.com', verifiedPhone: '2015551002' };
    const [a, b, c] = await Promise.all([
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
      svc.resolveOrCreateCustomerAccount(input, { prisma }),
    ]);
    assert.equal(new Set([a, b, c].map((r) => r.customerAccountId)).size, 1);
    assert.equal(await prisma.customerAccount.count(), 1);
  });

  it('never overwrites a booking linked to another account', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const a = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'a@example.com', verifiedPhone: '2015551003',
    }, { prisma });
    const b = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'b@example.com', verifiedPhone: '2015551004',
    }, { prisma });
    await prisma.booking.create({
      data: { id: 'BK-X', customerAccountId: a.customerAccountId, status: 'submitted', isDraft: false },
    });
    const link = await svc.linkBookingToAccount(prisma, {
      bookingId: 'BK-X',
      customerAccountId: b.customerAccountId,
    });
    assert.equal(link.ok, false);
    assert.equal(link.error, 'already_linked_other');
  });

  it('exposes ambiguity instead of merging conflicting contacts', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'e@example.com', verifiedPhone: '2015551005',
    }, { prisma });
    await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'p@example.com', verifiedPhone: '2015551006',
    }, { prisma });
    const r = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'e@example.com',
      verifiedPhone: '2015551006',
    }, { prisma });
    assert.equal(r.status, 'ambiguous');
    assert.equal(svc.EXISTING_CUSTOMER_ROLE,
      'legacy_payment_compatibility_placeholder_not_identity_authority');
  });
});
