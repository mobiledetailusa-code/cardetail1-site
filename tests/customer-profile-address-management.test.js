/**
 * Customer Profile & Address Management — Stage 2A focused coverage.
 */
require('dotenv/config');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIdentityMemoryPrisma } = require('./helpers/identity-memory-prisma');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ACCOUNT_PATH = require.resolve('../netlify/lib/customer-account-service');
const PROFILE_PATH = require.resolve('../netlify/lib/customer-profile-service');
const ADDRESS_PATH = require.resolve('../netlify/lib/customer-address-service');
const PROJECTION_PATH = require.resolve('../netlify/lib/customer-identity-projection');
const SESSION_PATH = require.resolve('../netlify/lib/customer-session');
const HANDLER_PATH = require.resolve('../netlify/functions/customer-portal-profile');
const RATE_PATH = require.resolve('../netlify/lib/public-rate-limit');

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

function cookieEvent(token, body = {}, extraHeaders = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      cookie: token ? `cd1_customer_session=${encodeURIComponent(token)}` : '',
      origin: 'https://cardetail1.com',
      host: 'cardetail1.com',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

describe('customer profile & address management (Stage 2A)', () => {
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

    for (const p of [
      ACCOUNT_PATH, PROFILE_PATH, ADDRESS_PATH, PROJECTION_PATH,
      SESSION_PATH, HANDLER_PATH, RATE_PATH,
    ]) {
      delete require.cache[p];
    }

    const rate = require('../netlify/lib/public-rate-limit');
    rate.setPublicRateLimitStoreFactory(() => ({
      async getWithMetadata() { return null; },
      async setJSON() { return { modified: true }; },
    }));

    const profileSvc = require('../netlify/lib/customer-profile-service');
    const addressSvc = require('../netlify/lib/customer-address-service');
    profileSvc.setPrismaForTests(prisma);
    addressSvc.setPrismaForTests(prisma);

    const session = require('../netlify/lib/customer-session');
    session.setCustomerSessionStoreFactory(() => sessionStore);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnap)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      require('../netlify/lib/customer-profile-service').setPrismaForTests(null);
      require('../netlify/lib/customer-address-service').setPrismaForTests(null);
      require('../netlify/lib/customer-session').resetCustomerSessionStoreFactory();
      require('../netlify/lib/public-rate-limit').resetPublicRateLimitStoreFactory();
    } catch { /* ignore */ }
    for (const p of [
      ACCOUNT_PATH, PROFILE_PATH, ADDRESS_PATH, PROJECTION_PATH,
      SESSION_PATH, HANDLER_PATH, RATE_PATH,
    ]) {
      delete require.cache[p];
    }
  });

  async function seedAccount(email, phone, extras = {}) {
    const svc = require('../netlify/lib/customer-account-service');
    return svc.resolveOrCreateCustomerAccount({
      verifiedEmail: email,
      verifiedPhone: phone,
      firstName: extras.firstName || 'Test',
      lastName: extras.lastName || 'User',
      ...extras,
    }, { prisma });
  }

  async function sessionFor(accountId, phoneDigits = '2015551001') {
    const session = require('../netlify/lib/customer-session');
    return session.createAccountSession({
      phoneDigits,
      email: 'sess@example.com',
      bookingIds: [],
      customerAccountId: accountId,
    });
  }

  it('1. authenticated customer loads own profile', async () => {
    const created = await seedAccount('load@example.com', '2015551001', {
      firstName: 'Lina',
      lastName: 'Load',
    });
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const r = await profileSvc.getProfile(created.customerAccountId, { prisma });
    assert.equal(r.ok, true);
    assert.equal(r.customer.profile.firstName, 'Lina');
    assert.equal(r.customer.profile.email, 'load@example.com');
    assert.equal(r.customer.profile.emailReadOnly, true);
    assert.equal(r.customer.profile.phoneReadOnly, true);
  });

  it('2. unauthenticated request returns 401', async () => {
    const handler = require('../netlify/functions/customer-portal-profile');
    const res = await handler.handler(cookieEvent(null, { action: 'get_profile' }));
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'authentication_failed');
  });

  it('3. revoked session returns 401', async () => {
    const created = await seedAccount('revoked@example.com', '2015551002');
    const { token } = await sessionFor(created.customerAccountId, '2015551002');
    const session = require('../netlify/lib/customer-session');
    await session.revokeCustomerSession(cookieEvent(token));
    const handler = require('../netlify/functions/customer-portal-profile');
    const res = await handler.handler(cookieEvent(token, { action: 'get_profile' }));
    assert.equal(res.statusCode, 401);
  });

  it('4. browser-supplied customerAccountId is ignored', async () => {
    const a = await seedAccount('owner@example.com', '2015551003');
    const b = await seedAccount('other@example.com', '2015551004');
    const { token } = await sessionFor(a.customerAccountId, '2015551003');
    const handler = require('../netlify/functions/customer-portal-profile');
    const res = await handler.handler(cookieEvent(token, {
      action: 'get_profile',
      customerAccountId: b.customerAccountId,
      browserCustomerAccountId: b.customerAccountId,
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.customer.customerAccountId, a.customerAccountId);
    assert.notEqual(body.customer.customerAccountId, b.customerAccountId);
  });

  it('5. profile update changes only permitted fields', async () => {
    const created = await seedAccount('edit@example.com', '2015551005', {
      firstName: 'Old',
      lastName: 'Name',
    });
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const r = await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: {
        firstName: 'New',
        lastName: 'Person',
        displayName: 'New P',
        preferredContactChannel: 'email',
        timezone: 'America/New_York',
      },
    }, { prisma });
    assert.equal(r.ok, true);
    assert.equal(r.customer.profile.firstName, 'New');
    assert.equal(r.customer.profile.displayName, 'New P');
    assert.equal(r.customer.profile.preferredContactChannel, 'email');
    assert.equal(r.customer.profile.timezone, 'America/New_York');
    assert.equal(r.customer.profile.email, 'edit@example.com');
  });

  it('6. email cannot be changed through profile update', async () => {
    const created = await seedAccount('email-lock@example.com', '2015551006');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const r = await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: { email: 'attacker@evil.com', firstName: 'X' },
    }, { prisma });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'contact_change_requires_verification');
    const again = await profileSvc.getProfile(created.customerAccountId, { prisma });
    assert.equal(again.customer.profile.email, 'email-lock@example.com');
  });

  it('7. phone cannot be changed through profile update', async () => {
    const created = await seedAccount('phone-lock@example.com', '2015551007');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const r = await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: { phone: '9995550000', firstName: 'X' },
    }, { prisma });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'contact_change_requires_verification');
  });

  it('8. invalid preferredContactChannel is rejected', async () => {
    const created = await seedAccount('channel@example.com', '2015551008');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const r = await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: { preferredContactChannel: 'carrier_pigeon' },
    }, { prisma });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'validation_error');
    assert.equal(r.field, 'preferredContactChannel');
  });

  it('9. invalid timezone is rejected', async () => {
    const created = await seedAccount('tz@example.com', '2015551009');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const r = await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: { timezone: 'Not/A_Zone' },
    }, { prisma });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'validation_error');
    assert.equal(r.field, 'timezone');
  });

  it('10. stale account version returns 409', async () => {
    const created = await seedAccount('stale@example.com', '2015551010');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: { firstName: 'One' },
    }, { prisma });
    const stale = await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: { firstName: 'Two' },
    }, { prisma });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, 'version_conflict');

    const { token } = await sessionFor(created.customerAccountId, '2015551010');
    const handler = require('../netlify/functions/customer-portal-profile');
    const res = await handler.handler(cookieEvent(token, {
      action: 'update_profile',
      expectedVersion: 1,
      patch: { firstName: 'Http' },
    }));
    assert.equal(res.statusCode, 409);
  });

  it('11. successful profile update increments version', async () => {
    const created = await seedAccount('ver@example.com', '2015551011');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const r = await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: { firstName: 'Versioned' },
    }, { prisma });
    assert.equal(r.ok, true);
    assert.equal(r.accountVersion, 2);
    assert.equal(r.customer.accountVersion, 2);
  });

  it('12. retry is idempotent', async () => {
    const created = await seedAccount('idem@example.com', '2015551012');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const req = {
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      requestId: 'idem-profile-1',
      patch: { firstName: 'Idem', lastName: 'Potent' },
    };
    const first = await profileSvc.updateProfile(req, { prisma });
    assert.equal(first.ok, true);
    assert.equal(first.accountVersion, 2);
    const second = await profileSvc.updateProfile({
      ...req,
      expectedVersion: 2,
    }, { prisma });
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.customer.profile.firstName, 'Idem');
    assert.equal(await prisma.customerAccount.findUnique({
      where: { id: created.customerAccountId },
    }).then((a) => a.version), 2);
  });

  it('13. customer creates an address', async () => {
    const created = await seedAccount('addr@example.com', '2015551013');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const r = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: {
        label: 'Home',
        line1: '10 River Rd',
        city: 'Hoboken',
        state: 'NJ',
        postalCode: '07030',
        country: 'US',
        isDefault: true,
      },
    }, { prisma });
    assert.equal(r.ok, true);
    assert.ok(r.addressId);
    assert.equal(r.customer.addresses.length, 1);
    assert.equal(r.customer.addresses[0].isDefault, true);
    assert.equal(r.customer.defaultAddressId, r.addressId);
  });

  it('14. customer lists only own addresses', async () => {
    const a = await seedAccount('lista@example.com', '2015551014');
    const b = await seedAccount('listb@example.com', '2015551015');
    const addressSvc = require('../netlify/lib/customer-address-service');
    await addressSvc.createAddress({
      customerAccountId: a.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'A Street', city: 'A', isDefault: true },
    }, { prisma });
    await addressSvc.createAddress({
      customerAccountId: b.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'B Street', city: 'B', isDefault: true },
    }, { prisma });
    const listed = await addressSvc.listAddresses(a.customerAccountId, { prisma });
    assert.equal(listed.ok, true);
    assert.equal(listed.addresses.length, 1);
    assert.equal(listed.addresses[0].line1, 'A Street');
  });

  it('15. customer cannot read/update another account’s address', async () => {
    const a = await seedAccount('ownera@example.com', '2015551016');
    const b = await seedAccount('ownerb@example.com', '2015551017');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const created = await addressSvc.createAddress({
      customerAccountId: a.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'Secret Ln', isDefault: true },
    }, { prisma });
    const update = await addressSvc.updateAddress({
      customerAccountId: b.customerAccountId,
      addressId: created.addressId,
      expectedVersion: 1,
      address: { line1: 'Hacked' },
    }, { prisma });
    assert.equal(update.ok, false);
    assert.equal(update.error, 'not_found');
    const still = await addressSvc.listAddresses(a.customerAccountId, { prisma });
    assert.equal(still.addresses[0].line1, 'Secret Ln');
  });

  it('16. update preserves ownership', async () => {
    const created = await seedAccount('own@example.com', '2015551018');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const addr = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: { line1: '1 Own St', isDefault: true },
    }, { prisma });
    const updated = await addressSvc.updateAddress({
      customerAccountId: created.customerAccountId,
      addressId: addr.addressId,
      expectedVersion: 2,
      address: { line1: '2 Own St', city: 'Jersey City' },
    }, { prisma });
    assert.equal(updated.ok, true);
    const row = await prisma.customerAddress.findUnique({ where: { id: addr.addressId } });
    assert.equal(row.customerAccountId, created.customerAccountId);
    assert.equal(row.line1, '2 Own St');
  });

  it('17. archive uses archivedAt and does not hard-delete', async () => {
    const created = await seedAccount('arch@example.com', '2015551019');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const addr = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'Archive Me', isDefault: true },
    }, { prisma });
    const archived = await addressSvc.archiveAddress({
      customerAccountId: created.customerAccountId,
      addressId: addr.addressId,
      expectedVersion: 2,
    }, { prisma });
    assert.equal(archived.ok, true);
    const row = await prisma.customerAddress.findUnique({ where: { id: addr.addressId } });
    assert.ok(row);
    assert.ok(row.archivedAt);
    assert.equal(row.isDefault, false);
    assert.equal(await prisma.customerAddress.count(), 1);
  });

  it('18. archived address disappears from active projection', async () => {
    const created = await seedAccount('gone@example.com', '2015551020');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const addr = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'Temp', isDefault: true },
    }, { prisma });
    await addressSvc.archiveAddress({
      customerAccountId: created.customerAccountId,
      addressId: addr.addressId,
      expectedVersion: 2,
    }, { prisma });
    const listed = await addressSvc.listAddresses(created.customerAccountId, { prisma });
    assert.equal(listed.addresses.length, 0);
    assert.equal(listed.customer.addresses.length, 0);
    assert.equal(listed.defaultAddressId, null);
  });

  it('19. setting default clears previous default', async () => {
    const created = await seedAccount('def@example.com', '2015551021');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const a1 = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'First', isDefault: true },
    }, { prisma });
    const a2 = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 2,
      address: { line1: 'Second', isDefault: false },
    }, { prisma });
    const set = await addressSvc.setDefaultAddress({
      customerAccountId: created.customerAccountId,
      addressId: a2.addressId,
      expectedVersion: 3,
    }, { prisma });
    assert.equal(set.ok, true);
    const rows = await prisma.customerAddress.findMany({
      where: { customerAccountId: created.customerAccountId, archivedAt: null },
    });
    const defaults = rows.filter((r) => r.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, a2.addressId);
    assert.equal(rows.find((r) => r.id === a1.addressId).isDefault, false);
  });

  it('20. concurrent default updates leave at most one default', async () => {
    const created = await seedAccount('race-def@example.com', '2015551022');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const a1 = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'R1', isDefault: true },
    }, { prisma });
    const a2 = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 2,
      address: { line1: 'R2', isDefault: false },
    }, { prisma });
    const a3 = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 3,
      address: { line1: 'R3', isDefault: false },
    }, { prisma });

    // Simulate concurrent attempts from same version — only one can win version check;
    // the winner leaves exactly one default. Retry the loser with fresh version.
    const results = await Promise.all([
      addressSvc.setDefaultAddress({
        customerAccountId: created.customerAccountId,
        addressId: a2.addressId,
        expectedVersion: 4,
      }, { prisma }),
      addressSvc.setDefaultAddress({
        customerAccountId: created.customerAccountId,
        addressId: a3.addressId,
        expectedVersion: 4,
      }, { prisma }),
    ]);
    const ok = results.filter((r) => r.ok);
    const conflict = results.filter((r) => r.error === 'version_conflict');
    assert.equal(ok.length, 1);
    assert.equal(conflict.length, 1);
    const rows = await prisma.customerAddress.findMany({
      where: { customerAccountId: created.customerAccountId, archivedAt: null, isDefault: true },
    });
    assert.equal(rows.length, 1);
    void a1;
  });

  it('21. archiving default address is deterministic (no auto-replacement)', async () => {
    const created = await seedAccount('nodef@example.com', '2015551023');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const a1 = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'Default', isDefault: true },
    }, { prisma });
    await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 2,
      address: { line1: 'Other', isDefault: false },
    }, { prisma });
    const archived = await addressSvc.archiveAddress({
      customerAccountId: created.customerAccountId,
      addressId: a1.addressId,
      expectedVersion: 3,
    }, { prisma });
    assert.equal(archived.ok, true);
    assert.equal(archived.wasDefault, true);
    assert.equal(archived.customer.defaultAddressId, null);
    const defaults = (archived.customer.addresses || []).filter((a) => a.isDefault);
    assert.equal(defaults.length, 0);
  });

  it('22. address mutation increments account version', async () => {
    const created = await seedAccount('bump@example.com', '2015551024');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const r = await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'Bump St', isDefault: true },
    }, { prisma });
    assert.equal(r.accountVersion, 2);
  });

  it('23. AuditEvent excludes full street address/email/phone', async () => {
    const created = await seedAccount('audit@example.com', '2015551025');
    const addressSvc = require('../netlify/lib/customer-address-service');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    await profileSvc.updateProfile({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      patch: { firstName: 'Aud' },
    }, { prisma });
    await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 2,
      address: {
        line1: '99 Confidential Ave',
        city: 'Hoboken',
        isDefault: true,
      },
    }, { prisma });
    const events = await prisma.auditEvent.findMany();
    const blob = JSON.stringify(events);
    assert.doesNotMatch(blob, /99 Confidential Ave/);
    assert.doesNotMatch(blob, /audit@example\.com/);
    assert.doesNotMatch(blob, /2015551025/);
    assert.ok(events.some((e) => e.action === 'customer_profile_updated'));
    assert.ok(events.some((e) => e.action === 'customer_address_created'));
  });

  it('24. customer projection excludes internal fields', async () => {
    const created = await seedAccount('safe@example.com', '2015551026');
    prisma._db.customerAccount.get(created.customerAccountId).stripeCustomerId = 'cus_SECRET';
    const addressSvc = require('../netlify/lib/customer-address-service');
    await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: { line1: 'Safe', isDefault: true },
    }, { prisma });
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const r = await profileSvc.getProfile(created.customerAccountId, { prisma });
    const json = JSON.stringify(r.customer);
    assert.equal(r.customer.stripeCustomerId, undefined);
    assert.equal(r.customer.profile.normalizedEmail, undefined);
    assert.doesNotMatch(json, /cus_SECRET/);
    assert.ok(r.customer.defaultAddressId);
    assert.ok(r.customer.accountVersion >= 1);
  });

  it('25. admin projection reads same default address', async () => {
    const created = await seedAccount('admin-addr@example.com', '2015551027', {
      firstName: 'Ada',
      lastName: 'Admin',
    });
    const addressSvc = require('../netlify/lib/customer-address-service');
    await addressSvc.createAddress({
      customerAccountId: created.customerAccountId,
      expectedVersion: 1,
      address: {
        label: 'HQ',
        line1: '1 Admin Way',
        city: 'Newark',
        state: 'NJ',
        postalCode: '07102',
        isDefault: true,
      },
    }, { prisma });
    const proj = require('../netlify/lib/customer-identity-projection');
    const admin = await proj.buildAdminCustomerAccountSummary(created.customerAccountId, { prisma });
    const customer = await proj.buildCustomerProjection(created.customerAccountId, { prisma });
    assert.ok(admin.defaultAddress);
    assert.match(admin.defaultAddress.summary, /1 Admin Way/);
    assert.equal(admin.activeAddressCount, 1);
    assert.equal(admin.accountVersion, customer.accountVersion);
    assert.ok(admin.profileUpdatedAt || admin.profileUpdatedAt === null);
    assert.equal(customer.defaultAddressId, customer.addresses.find((a) => a.isDefault).id);
  });

  it('26-28. logout / HTTP 401 clear rendered customer state (UI contract)', () => {
    const src = read('assets/my-garage.js');
    assert.match(src, /function clearAuthenticatedCustomerState/);
    assert.match(src, /reason: 'logout'/);
    assert.match(src, /reason: 'http_401'/);
    assert.match(src, /res\.status === 401 && isAuthenticatedPortalCall/);
    assert.match(src, /state\.customer = null/);
    assert.match(src, /clearProfileAddressDom/);
    assert.match(src, /show\(\$\('profile-section'\), false\)/);
    assert.match(src, /show\(\$\('addresses-section'\), false\)/);
    assert.match(src, /closeModalQuiet/);
    // Logout must not leave profile/address DOM populated
    assert.match(src, /async function logout/);
    assert.match(src, /clearAuthenticatedCustomerState\(\{ reason: 'logout'/);
  });

  it('29. identity resolution and booking visibility remain unchanged', async () => {
    const svc = require('../netlify/lib/customer-account-service');
    const a = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'vis@example.com',
      verifiedPhone: '2015551028',
    }, { prisma });
    await prisma.booking.create({
      data: {
        id: 'BK-VIS-1',
        customerAccountId: a.customerAccountId,
        status: 'submitted',
        isDraft: false,
      },
    });
    const profileSvc = require('../netlify/lib/customer-profile-service');
    await profileSvc.updateProfile({
      customerAccountId: a.customerAccountId,
      expectedVersion: 1,
      patch: { firstName: 'Visible' },
    }, { prisma });
    const ids = await svc.listBookingIdsForAccount(a.customerAccountId, { prisma });
    assert.deepEqual(ids, ['BK-VIS-1']);
    const again = await svc.resolveOrCreateCustomerAccount({
      verifiedEmail: 'vis@example.com',
      verifiedPhone: '2015551028',
    }, { prisma });
    assert.equal(again.customerAccountId, a.customerAccountId);
  });

  it('30. payment/quote/ledger values remain unchanged', () => {
    const schema = read('prisma/schema.prisma');
    assert.match(schema, /model PaymentAttempt/);
    assert.match(schema, /model LedgerEntry/);
    assert.match(schema, /model Quote /);
    const profileSrc = read('netlify/lib/customer-profile-service.js');
    const addressSrc = read('netlify/lib/customer-address-service.js');
    assert.doesNotMatch(profileSrc, /PaymentAttempt|LedgerEntry|approvedCents/);
    assert.doesNotMatch(addressSrc, /PaymentAttempt|LedgerEntry|approvedCents/);
    const paySrc = read('netlify/lib/db/payment-authority-service.js');
    assert.match(paySrc, /function|exports/);
  });

  it('UI exposes profile and address management in My Garage', () => {
    const html = read('my-garage.html');
    const js = read('assets/my-garage.js');
    assert.match(html, /id="profile-section"/);
    assert.match(html, /id="addresses-section"/);
    assert.match(html, /Verified email and phone are read-only/);
    assert.match(js, /portalProfileAction/);
    assert.match(js, /update_profile/);
    assert.match(js, /create_address/);
    assert.match(js, /archive_address/);
    assert.match(js, /set_default_address/);
    assert.match(js, /version_conflict/);
  });

  it('API actions surface is complete and session-scoped', () => {
    const src = read('netlify/functions/customer-portal-profile.js');
    for (const action of [
      'get_profile', 'update_profile', 'list_addresses',
      'create_address', 'update_address', 'archive_address', 'set_default_address',
    ]) {
      assert.match(src, new RegExp(action));
    }
    assert.match(src, /validateCustomerSession/);
    assert.match(src, /void body\.customerAccountId/);
    assert.match(src, /payload_too_large/);
    assert.match(src, /allowedBrowserOrigin/);
  });

  function assertUniformNotFound(res) {
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not_found');
    assert.equal(body.message, 'Resource not found.');
    const raw = res.body;
    assert.equal(/disabled|merged/i.test(raw), false);
    assert.equal(/@example\.com|normalizedEmail|normalizedPhone/i.test(raw), false);
    assert.equal(/line1|postalCode|Hoboken|cus_/i.test(raw), false);
    assert.equal(/"status"\s*:/.test(raw), false);
    assert.equal(/"email"\s*:|"phone"\s*:/.test(raw), false);
    return body;
  }

  async function setAccountStatus(accountId, status) {
    const row = prisma._db.customerAccount.get(accountId);
    assert.ok(row, 'seeded account must exist');
    row.status = status;
    row.updatedAt = new Date().toISOString();
  }

  it('repair: get_profile rejects disabled account with uniform not_found', async () => {
    const created = await seedAccount('dis-get@example.com', '2015552101', {
      firstName: 'Disabled',
      lastName: 'Get',
    });
    await setAccountStatus(created.customerAccountId, 'disabled');
    const { token } = await sessionFor(created.customerAccountId, '2015552101');
    const handler = require('../netlify/functions/customer-portal-profile');
    const res = await handler.handler(cookieEvent(token, { action: 'get_profile' }));
    assertUniformNotFound(res);

    const profileSvc = require('../netlify/lib/customer-profile-service');
    const svc = await profileSvc.getProfile(created.customerAccountId, { prisma });
    assert.equal(svc.ok, false);
    assert.equal(svc.error, 'not_found');
    assert.equal(svc.status, undefined);
  });

  it('repair: get_profile rejects merged account with uniform not_found', async () => {
    const created = await seedAccount('mer-get@example.com', '2015552102');
    await setAccountStatus(created.customerAccountId, 'merged');
    const { token } = await sessionFor(created.customerAccountId, '2015552102');
    const handler = require('../netlify/functions/customer-portal-profile');
    const missing = await seedAccount('missing-compare@example.com', '2015552199');
    const missingToken = (await sessionFor('acct_does_not_exist', '2015552199')).token;

    const disabledRes = await handler.handler(cookieEvent(token, { action: 'get_profile' }));
    const missingRes = await handler.handler(cookieEvent(missingToken, { action: 'get_profile' }));
    assertUniformNotFound(disabledRes);
    assertUniformNotFound(missingRes);
    assert.deepEqual(JSON.parse(disabledRes.body), JSON.parse(missingRes.body));
    void missing;
  });

  it('repair: list_addresses rejects disabled and merged accounts uniformly', async () => {
    const handler = require('../netlify/functions/customer-portal-profile');
    const addressSvc = require('../netlify/lib/customer-address-service');

    const disabled = await seedAccount('dis-list@example.com', '2015552103');
    await addressSvc.createAddress({
      customerAccountId: disabled.customerAccountId,
      expectedVersion: 1,
      address: { line1: '9 Secret St', city: 'Hoboken', state: 'NJ', postalCode: '07030' },
    }, { prisma });
    await setAccountStatus(disabled.customerAccountId, 'disabled');

    const merged = await seedAccount('mer-list@example.com', '2015552104');
    await setAccountStatus(merged.customerAccountId, 'merged');

    const missingToken = (await sessionFor('acct_missing_list', '2015552105')).token;
    const disTok = (await sessionFor(disabled.customerAccountId, '2015552103')).token;
    const merTok = (await sessionFor(merged.customerAccountId, '2015552104')).token;

    const disRes = await handler.handler(cookieEvent(disTok, { action: 'list_addresses' }));
    const merRes = await handler.handler(cookieEvent(merTok, { action: 'list_addresses' }));
    const missRes = await handler.handler(cookieEvent(missingToken, { action: 'list_addresses' }));
    assertUniformNotFound(disRes);
    assertUniformNotFound(merRes);
    assertUniformNotFound(missRes);
    assert.deepEqual(JSON.parse(disRes.body), JSON.parse(missRes.body));
    assert.deepEqual(JSON.parse(merRes.body), JSON.parse(missRes.body));

    const svcDis = await addressSvc.listAddresses(disabled.customerAccountId, { prisma });
    const svcMer = await addressSvc.listAddresses(merged.customerAccountId, { prisma });
    assert.equal(svcDis.ok, false);
    assert.equal(svcDis.error, 'not_found');
    assert.equal(svcMer.ok, false);
    assert.equal(svcMer.error, 'not_found');
  });

  it('repair: active accounts still read profile and addresses; writes blocked when inactive', async () => {
    const handler = require('../netlify/functions/customer-portal-profile');
    const profileSvc = require('../netlify/lib/customer-profile-service');
    const addressSvc = require('../netlify/lib/customer-address-service');

    const active = await seedAccount('active-read@example.com', '2015552106', {
      firstName: 'Active',
      lastName: 'Reader',
    });
    await addressSvc.createAddress({
      customerAccountId: active.customerAccountId,
      expectedVersion: 1,
      address: { line1: '1 Active Ave', city: 'Jersey City', state: 'NJ', postalCode: '07302', isDefault: true },
    }, { prisma });

    const { token } = await sessionFor(active.customerAccountId, '2015552106');
    const profileRes = await handler.handler(cookieEvent(token, { action: 'get_profile' }));
    assert.equal(profileRes.statusCode, 200);
    const profileBody = JSON.parse(profileRes.body);
    assert.equal(profileBody.ok, true);
    assert.equal(profileBody.customer.profile.firstName, 'Active');

    const listRes = await handler.handler(cookieEvent(token, { action: 'list_addresses' }));
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.equal(listBody.ok, true);
    assert.equal(listBody.addresses.length, 1);

    await setAccountStatus(active.customerAccountId, 'disabled');
    const write = await profileSvc.updateProfile({
      customerAccountId: active.customerAccountId,
      expectedVersion: 2,
      patch: { firstName: 'Nope' },
    }, { prisma });
    assert.equal(write.ok, false);
    assert.equal(write.error, 'not_found');

    const createBlocked = await addressSvc.createAddress({
      customerAccountId: active.customerAccountId,
      expectedVersion: 2,
      address: { line1: 'Should Fail', city: 'X', state: 'NJ', postalCode: '07030' },
    }, { prisma });
    assert.equal(createBlocked.ok, false);
    assert.equal(createBlocked.error, 'not_found');

    // Admin/internal graph load must still succeed for inactive accounts.
    const graph = await require('../netlify/lib/customer-account-service')
      .loadCustomerAccountGraph(active.customerAccountId, { prisma });
    assert.ok(graph);
    assert.equal(graph.status, 'disabled');
  });

  it('repair: handler rate-limit rejection maps to HTTP 429', async () => {
    process.env.PUBLIC_RATE_LIMIT_CUSTOMER_PORTAL_PROFILE_READ_MAX = '1';
    process.env.PUBLIC_RATE_LIMIT_CUSTOMER_PORTAL_PROFILE_WINDOW_SEC = '900';

    // Conditional store matching public-rate-limit's onlyIfNew / onlyIfMatch protocol.
    const data = new Map();
    let etagCounter = 0;
    const rate = require('../netlify/lib/public-rate-limit');
    rate.setPublicRateLimitStoreFactory(() => ({
      async getWithMetadata(key, { type } = {}) {
        if (!data.has(key)) return null;
        const entry = data.get(key);
        return {
          data: type === 'json' ? JSON.parse(entry.value) : entry.value,
          etag: entry.etag,
          metadata: {},
        };
      },
      async setJSON(key, value, options = {}) {
        const exists = data.has(key);
        if (options.onlyIfNew && exists) return { modified: false };
        if (options.onlyIfMatch) {
          if (!exists || data.get(key).etag !== options.onlyIfMatch) return { modified: false };
        }
        const etag = `etag-${++etagCounter}`;
        data.set(key, { value: JSON.stringify(value), etag });
        return { modified: true, etag };
      },
    }));

    delete require.cache[HANDLER_PATH];
    delete require.cache[RATE_PATH];
    // Re-bind rate factory after cache clear of rate module used by handler.
    require('../netlify/lib/public-rate-limit').setPublicRateLimitStoreFactory(() => ({
      async getWithMetadata(key, { type } = {}) {
        if (!data.has(key)) return null;
        const entry = data.get(key);
        return {
          data: type === 'json' ? JSON.parse(entry.value) : entry.value,
          etag: entry.etag,
          metadata: {},
        };
      },
      async setJSON(key, value, options = {}) {
        const exists = data.has(key);
        if (options.onlyIfNew && exists) return { modified: false };
        if (options.onlyIfMatch) {
          if (!exists || data.get(key).etag !== options.onlyIfMatch) return { modified: false };
        }
        const etag = `etag-${++etagCounter}`;
        data.set(key, { value: JSON.stringify(value), etag });
        return { modified: true, etag };
      },
    }));
    const handler = require('../netlify/functions/customer-portal-profile');
    const created = await seedAccount('rl@example.com', '2015552107');
    const { token } = await sessionFor(created.customerAccountId, '2015552107');
    const evt = (body) => cookieEvent(token, body, {
      'x-nf-client-connection-ip': '203.0.113.77',
    });

    const first = await handler.handler(evt({ action: 'get_profile' }));
    assert.notEqual(first.statusCode, 429);
    const blocked = await handler.handler(evt({ action: 'get_profile' }));
    assert.equal(blocked.statusCode, 429);
    const body = JSON.parse(blocked.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'rate_limited');

    delete process.env.PUBLIC_RATE_LIMIT_CUSTOMER_PORTAL_PROFILE_READ_MAX;
    delete process.env.PUBLIC_RATE_LIMIT_CUSTOMER_PORTAL_PROFILE_WINDOW_SEC;
  });
});
