/**
 * Customer Saved Vehicles — Stage 2B focused coverage.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIdentityMemoryPrisma } = require('./helpers/identity-memory-prisma');

const SERVICE_PATH = require.resolve('../netlify/lib/customer-vehicle-service');
const LEGACY_PATH = require.resolve('../netlify/lib/customer-vehicles');
const LEGACY_RO_PATH = require.resolve('../netlify/lib/customer-vehicles-legacy');
const HANDLER_PATH = require.resolve('../netlify/functions/customer-portal-vehicles');
const PROJECTION_PATH = require.resolve('../netlify/lib/customer-identity-projection');
const ACCOUNT_PATH = require.resolve('../netlify/lib/customer-account-service');
const SESSION_PATH = require.resolve('../netlify/lib/customer-session');
const RATE_PATH = require.resolve('../netlify/lib/public-rate-limit');

function clearModule(p) {
  try { delete require.cache[p]; } catch { /* ignore */ }
}

function reloadService() {
  clearModule(SERVICE_PATH);
  clearModule(LEGACY_PATH);
  clearModule(LEGACY_RO_PATH);
  clearModule(PROJECTION_PATH);
  clearModule(ACCOUNT_PATH);
  return require('../netlify/lib/customer-vehicle-service');
}

async function seedAccount(prisma, {
  status = 'active',
  phone = '2015550199',
  email = 'stage2b@example.test',
  vehiclesImportedAt = new Date().toISOString(),
} = {}) {
  const account = await prisma.customerAccount.create({
    data: { status, version: 1, vehiclesImportedAt },
  });
  await prisma.customerProfile.create({
    data: {
      customerAccountId: account.id,
      email,
      normalizedEmail: email,
      phone,
      normalizedPhone: phone,
      firstName: 'Stage',
      lastName: 'TwoB',
    },
  });
  return account;
}

describe('customer saved vehicles (Stage 2B)', () => {
  let prisma;

  beforeEach(() => {
    prisma = createIdentityMemoryPrisma();
    const svc = reloadService();
    svc.setPrismaForTests(prisma);
    svc.setLegacyReaderForTests(async () => ({ ok: true, vehicles: [] }));
  });

  afterEach(() => {
    try {
      require('../netlify/lib/customer-vehicle-service').setPrismaForTests(null);
      require('../netlify/lib/customer-vehicle-service').setLegacyReaderForTests(null);
    } catch { /* ignore */ }
    clearModule(HANDLER_PATH);
    clearModule(SESSION_PATH);
    clearModule(RATE_PATH);
    clearModule(SERVICE_PATH);
  });

  it('1. normalization strips tags and enforces year format', () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const ok = svc.normalizeVehicleFields({
      label: '  <b>Daily</b>  ',
      category: 'SUV',
      year: '2020',
      make: 'Honda',
      model: 'CR-V',
      notes: '<script>x</script>keep',
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.fields.label, 'Daily');
    assert.equal(ok.fields.category, 'suv');
    assert.equal(ok.fields.notes.includes('<'), false);
    assert.equal(ok.fields.notes.includes('keep'), true);
    const badYear = svc.normalizeVehicleFields({ year: '20', make: 'A', model: 'B', label: 'x' });
    assert.equal(badYear.ok, false);
    assert.equal(badYear.field, 'year');
  });

  it('2. create requires label or make/model', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma);
    const r = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: { category: 'car' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'validation_error');
  });

  it('3. create first vehicle becomes default', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma);
    const r = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: { make: 'Toyota', model: 'Camry', year: '2019' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.vehicle.isDefault, true);
    const list = await svc.listVehicles(account.id);
    assert.equal(list.vehicles.length, 1);
    assert.equal(list.defaultVehicleId, r.vehicleId);
  });

  it('4. set_default clears prior default', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma);
    const a = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: { label: 'A', make: 'Ford', model: 'F150' },
    });
    const b = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: a.accountVersion,
      vehicle: { label: 'B', make: 'Chevy', model: 'Tahoe' },
    });
    assert.equal(b.vehicle.isDefault, false);
    const set = await svc.setDefaultVehicle({
      customerAccountId: account.id,
      vehicleId: b.vehicleId,
      expectedVersion: b.accountVersion,
    });
    assert.equal(set.ok, true);
    const list = await svc.listVehicles(account.id);
    assert.equal(list.defaultVehicleId, b.vehicleId);
    assert.equal(list.vehicles.filter((v) => v.isDefault).length, 1);
  });

  it('5. archive default promotes oldest remaining active', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma);
    const older = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: { label: 'Older', make: 'Honda', model: 'Civic' },
    });
    // Native Date instances (Prisma DateTime fidelity), not ISO-string-only mocks.
    const olderRow = prisma._db.customerVehicle.get(older.vehicleId);
    olderRow.createdAt = new Date('2020-01-01T00:00:00.000Z');
    prisma._db.customerVehicle.set(older.vehicleId, olderRow);

    const newer = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: older.accountVersion,
      vehicle: { label: 'Newer', make: 'Honda', model: 'Accord', isDefault: true },
    });
    const newerRow = prisma._db.customerVehicle.get(newer.vehicleId);
    newerRow.createdAt = new Date('2020-01-08T00:00:00.000Z');
    prisma._db.customerVehicle.set(newer.vehicleId, newerRow);

    const arch = await svc.archiveVehicle({
      customerAccountId: account.id,
      vehicleId: newer.vehicleId,
      expectedVersion: newer.accountVersion,
    });
    assert.equal(arch.ok, true);
    assert.equal(arch.wasDefault, true);
    assert.equal(arch.promotedDefaultId, older.vehicleId);
    const list = await svc.listVehicles(account.id);
    assert.equal(list.vehicles.length, 1);
    assert.equal(list.defaultVehicleId, older.vehicleId);
  });

  it('6. archive last default leaves no default', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma);
    const a = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: { label: 'Only', make: 'Nissan', model: 'Leaf' },
    });
    const arch = await svc.archiveVehicle({
      customerAccountId: account.id,
      vehicleId: a.vehicleId,
      expectedVersion: a.accountVersion,
    });
    assert.equal(arch.ok, true);
    assert.equal(arch.promotedDefaultId, null);
    const list = await svc.listVehicles(account.id);
    assert.equal(list.vehicles.length, 0);
    assert.equal(list.defaultVehicleId, null);
  });

  it('7. cross-account vehicle id returns not_found', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const a = await seedAccount(prisma, { email: 'a@example.test', phone: '2015550101' });
    const b = await seedAccount(prisma, { email: 'b@example.test', phone: '2015550102' });
    const created = await svc.createVehicle({
      customerAccountId: a.id,
      expectedVersion: 1,
      vehicle: { label: 'Secret', make: 'BMW', model: 'X5' },
    });
    const r = await svc.updateVehicle({
      customerAccountId: b.id,
      vehicleId: created.vehicleId,
      expectedVersion: 1,
      vehicle: { label: 'Hijack' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_found');
  });

  it('8. disabled and merged accounts return not_found', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const disabled = await seedAccount(prisma, {
      status: 'disabled',
      email: 'dis@example.test',
      phone: '2015550103',
    });
    const merged = await seedAccount(prisma, {
      status: 'merged',
      email: 'mer@example.test',
      phone: '2015550104',
    });
    assert.equal((await svc.listVehicles(disabled.id)).error, 'not_found');
    assert.equal((await svc.listVehicles(merged.id)).error, 'not_found');
  });

  it('9. version conflict returns version_conflict', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma);
    const r = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 99,
      vehicle: { label: 'Stale', make: 'Kia', model: 'Soul' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'version_conflict');
  });

  it('10. legacy import is idempotent and uses legacySourceId', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma, { vehiclesImportedAt: null });
    svc.setLegacyReaderForTests(async () => ({
      ok: true,
      vehicles: [
        { id: 'cv_legacy_1', label: 'Blob One', category: 'suv', year: '2018', make: 'Subaru', model: 'Outback' },
        { id: 'cv_legacy_1', label: 'Blob One Dup', category: 'suv', year: '2018', make: 'Subaru', model: 'Outback' },
        { id: 'cv_legacy_2', archived: true, label: 'Archived', make: 'X', model: 'Y' },
      ],
    }));
    const first = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(first.ok, true);
    assert.equal(first.importedCount, 1);
    const second = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(second.ok, true);
    assert.equal(second.alreadyImported, true);
    assert.equal(second.importedCount, 0);
    const list = await svc.listVehicles(account.id);
    assert.equal(list.vehicles.length, 1);
    assert.equal(list.vehicles[0].label, 'Blob One');
    assert.equal(prisma._meta.advisoryLockCalls > 0, true);
  });

  it('11. failed import rolls back completely', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma, { vehiclesImportedAt: null });
    svc.setLegacyReaderForTests(async () => ({
      ok: true,
      vehicles: [
        { id: 'cv_fail_1', label: 'Will Fail', make: 'Audi', model: 'Q5' },
      ],
    }));
    prisma.failInsideNextTransactionAfter(2, new Error('forced import failure'));
    const r = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(r.ok, false);
    const refreshed = await prisma.customerAccount.findUnique({ where: { id: account.id } });
    assert.equal(refreshed.vehiclesImportedAt, null);
    assert.equal(await prisma.customerVehicle.count({ where: { customerAccountId: account.id } }), 0);
  });

  it('12. legacy Blob writes are disabled', async () => {
    const legacy = require('../netlify/lib/customer-vehicles');
    const add = await legacy.addVehicle('2015550199', { label: 'Nope', make: 'X', model: 'Y' });
    assert.equal(add.ok, false);
    assert.equal(add.error, 'unavailable');
  });

  it('13. handler rejects unauthenticated and ignores browser account id', async () => {
    clearModule(HANDLER_PATH);
    clearModule(SESSION_PATH);
    clearModule(RATE_PATH);
    require.cache[SESSION_PATH] = {
      id: SESSION_PATH,
      filename: SESSION_PATH,
      loaded: true,
      exports: {
        validateCustomerSession: async () => ({ ok: false }),
      },
    };
    require.cache[RATE_PATH] = {
      id: RATE_PATH,
      filename: RATE_PATH,
      loaded: true,
      exports: {
        enforcePublicRateLimit: async () => ({ blocked: false }),
      },
    };
    const handler = require('../netlify/functions/customer-portal-vehicles');
    const res = await handler.handler({
      httpMethod: 'POST',
      headers: { origin: 'https://cardetail1.com', host: 'cardetail1.com' },
      body: JSON.stringify({ action: 'list', customerAccountId: 'attacker' }),
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'authentication_failed');
  });

  it('14. handler list returns account vehicles for active session', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma);
    await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: { label: 'Portal', make: 'Mazda', model: 'CX-5' },
    });
    clearModule(HANDLER_PATH);
    clearModule(SESSION_PATH);
    clearModule(RATE_PATH);
    require.cache[SESSION_PATH] = {
      id: SESSION_PATH,
      filename: SESSION_PATH,
      loaded: true,
      exports: {
        validateCustomerSession: async () => ({
          ok: true,
          scope: 'account',
          customerAccountId: account.id,
          phoneDigits: '2015550199',
        }),
      },
    };
    require.cache[RATE_PATH] = {
      id: RATE_PATH,
      filename: RATE_PATH,
      loaded: true,
      exports: {
        enforcePublicRateLimit: async () => ({ blocked: false }),
      },
    };
    const handler = require('../netlify/functions/customer-portal-vehicles');
    const res = await handler.handler({
      httpMethod: 'POST',
      headers: { origin: 'https://cardetail1.com', host: 'cardetail1.com' },
      body: JSON.stringify({ action: 'list', customerAccountId: 'ignored' }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.vehicles.length, 1);
    assert.equal(body.vehicles[0].label, 'Portal');
  });

  it('15. admin projection includes active vehicle count without mutation APIs', () => {
    const proj = require('../netlify/lib/customer-identity-projection');
    const summary = proj.projectCustomerAccountForAdmin({
      id: 'acc1',
      status: 'active',
      version: 3,
      profile: { displayName: 'Pat', email: 'p@example.test', phone: '2015550111' },
      addresses: [],
      vehicles: [
        { id: 'v1', label: 'Daily', category: 'car', isDefault: true, archivedAt: null },
        { id: 'v2', label: 'Gone', archivedAt: '2026-01-01T00:00:00.000Z' },
      ],
      consents: [],
      bookings: [],
    });
    assert.equal(summary.activeVehicleCount, 1);
    assert.equal(summary.defaultVehicle.label, 'Daily');
    const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/customer-portal-vehicles.js'), 'utf8');
    assert.doesNotMatch(src, /admin/i);
  });

  it('16. schema migration is additive for CustomerVehicle', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
    const migration = fs.readFileSync(
      path.join(__dirname, '../prisma/migrations/20260723000000_customer_saved_vehicles/migration.sql'),
      'utf8'
    );
    assert.match(schema, /model CustomerVehicle/);
    assert.match(schema, /vehiclesImportedAt/);
    assert.match(migration, /CREATE TABLE "CustomerVehicle"/);
    assert.match(migration, /vehiclesImportedAt/);
    assert.doesNotMatch(migration, /DROP TABLE/i);
    const vehicleModel = schema.slice(schema.indexOf('model CustomerVehicle'), schema.indexOf('enum ConsentChannel'));
    assert.doesNotMatch(vehicleModel, /bookingId/);
  });

  it('17a. portal-data exposes top-level accountVersion for vehicle mutations', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../netlify/functions/customer-portal-data.js'),
      'utf8'
    );
    assert.match(src, /let accountVersion = null/);
    assert.match(src, /vehicleList\.accountVersion/);
    assert.match(src, /accountVersion,/);
    assert.match(src, /select: \{ version: true \}/);
  });

  it('17. My Garage UI wires default/edit/archive and expectedVersion', () => {
    const js = fs.readFileSync(path.join(__dirname, '../assets/my-garage.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../my-garage.html'), 'utf8');
    assert.match(js, /set_default/);
    assert.match(js, /expectedVersion/);
    assert.match(js, /data-vehicle-archive/);
    assert.match(js, /openVehicleForm/);
    assert.match(js, /formatSavedVehicleCardHtml/);
    assert.match(js, /CD1VehicleCard/);
    assert.match(html, /id="vehicle-form"/);
    assert.match(html, /id="vh-default"/);
    assert.match(html, /customer-vehicle-card\.js\?v=20260723-vehicles2/);
    assert.match(html, /my-garage\.js\?v=20260723-vehicles3/);
    // accountVersion must be readable for create/update/archive mutations
    assert.match(js, /function accountVersionForMutation/);
    assert.match(js, /function ensureAccountVersionForMutation/);
    assert.match(js, /data\.accountVersion/);
    assert.doesNotMatch(js, /Session outdated\. Refresh and try again/);
    // Create/edit field mapping — form controls write the API contract keys.
    assert.match(js, /label:\s*\(\$\('vh-label'\)/);
    assert.match(js, /category:\s*\(\$\('vh-category'\)/);
    assert.match(js, /year:\s*\(\$\('vh-year'\)/);
    assert.match(js, /make:\s*\(\$\('vh-make'\)/);
    assert.match(js, /model:\s*\(\$\('vh-model'\)/);
    assert.match(js, /color:\s*\(\$\('vh-color'\)/);
    assert.match(js, /notes:\s*\(\$\('vh-notes'\)/);
    assert.match(js, /\$\('vh-year'\)\.value = \(vehicle && vehicle\.year\)/);
    assert.match(js, /\$\('vh-make'\)\.value = \(vehicle && vehicle\.make\)/);
    assert.match(js, /\$\('vh-model'\)\.value = \(vehicle && vehicle\.model\)/);
    assert.match(js, /\$\('vh-color'\)\.value = \(vehicle && vehicle\.color\)/);
  });

  it('18. native Date Sunday-before-Monday sorts chronologically first', () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    // localeCompare on Date.toString() would put Monday before Sunday.
    const sunday = {
      id: 'cv_b',
      isDefault: false,
      createdAt: new Date('2026-07-12T15:00:00.000Z'), // Sunday
    };
    const monday = {
      id: 'cv_a',
      isDefault: false,
      createdAt: new Date('2026-07-13T15:00:00.000Z'), // Monday
    };
    assert.equal(svc.compareCreatedAtAsc(sunday, monday) < 0, true);
    const sorted = svc.sortActiveVehicles([monday, sunday]);
    assert.equal(sorted[0].id, 'cv_b');
    assert.equal(sorted[1].id, 'cv_a');
  });

  it('19. identical createdAt tie-breaks by id ascending', () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const stamp = new Date('2026-07-01T12:00:00.000Z');
    const a = { id: 'cv_zzz', isDefault: false, createdAt: stamp };
    const b = { id: 'cv_aaa', isDefault: false, createdAt: new Date(stamp.getTime()) };
    const sorted = svc.sortActiveVehicles([a, b]);
    assert.equal(sorted[0].id, 'cv_aaa');
    assert.equal(sorted[1].id, 'cv_zzz');
  });

  it('20. sortActiveVehicles keeps default first then chronological Date order', () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const sorted = svc.sortActiveVehicles([
      { id: 'cv_2', isDefault: false, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { id: 'cv_def', isDefault: true, createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { id: 'cv_1', isDefault: false, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    assert.deepEqual(sorted.map((v) => v.id), ['cv_def', 'cv_1', 'cv_2']);
  });

  it('21. archive default promotes oldest by native Date createdAt', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma, { email: 'dates@example.test', phone: '2015550188' });
    const mid = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: { label: 'Mid', make: 'Ford', model: 'Focus' },
    });
    const oldest = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: mid.accountVersion,
      vehicle: { label: 'Oldest', make: 'Ford', model: 'Fiesta' },
    });
    const newest = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: oldest.accountVersion,
      vehicle: { label: 'Newest', make: 'Ford', model: 'Mustang', isDefault: true },
    });

    prisma._db.customerVehicle.get(oldest.vehicleId).createdAt = new Date('2026-07-12T10:00:00.000Z'); // Sunday
    prisma._db.customerVehicle.get(mid.vehicleId).createdAt = new Date('2026-07-13T10:00:00.000Z'); // Monday
    prisma._db.customerVehicle.get(newest.vehicleId).createdAt = new Date('2026-07-14T10:00:00.000Z');

    const arch = await svc.archiveVehicle({
      customerAccountId: account.id,
      vehicleId: newest.vehicleId,
      expectedVersion: newest.accountVersion,
    });
    assert.equal(arch.ok, true);
    assert.equal(arch.promotedDefaultId, oldest.vehicleId);
  });

  it('22. missing Blob key imports zero vehicles and sets marker', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma, {
      email: 'missing@example.test',
      phone: '2015550177',
      vehiclesImportedAt: null,
    });
    svc.setLegacyReaderForTests(async () => ({
      ok: true,
      missing: true,
      vehicles: [],
    }));
    const first = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(first.ok, true);
    assert.equal(first.importedCount, 0);
    const refreshed = await prisma.customerAccount.findUnique({ where: { id: account.id } });
    assert.ok(refreshed.vehiclesImportedAt);
    assert.equal(await prisma.customerVehicle.count({ where: { customerAccountId: account.id } }), 0);
    const second = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(second.alreadyImported, true);
  });

  it('23. Blob read transient failure leaves marker null and zero rows', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const { LEGACY_SOURCE_UNAVAILABLE } = require('../netlify/lib/customer-vehicles-legacy');
    const account = await seedAccount(prisma, {
      email: 'blobfail@example.test',
      phone: '2015550176',
      vehiclesImportedAt: null,
    });
    svc.setLegacyReaderForTests(async () => {
      const err = new Error(LEGACY_SOURCE_UNAVAILABLE);
      err.code = LEGACY_SOURCE_UNAVAILABLE;
      throw err;
    });
    const r = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'temporarily_unavailable');
    const refreshed = await prisma.customerAccount.findUnique({ where: { id: account.id } });
    assert.equal(refreshed.vehiclesImportedAt, null);
    assert.equal(await prisma.customerVehicle.count({ where: { customerAccountId: account.id } }), 0);
  });

  it('24. retry after transient Blob failure imports and commits marker', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const { LEGACY_SOURCE_UNAVAILABLE } = require('../netlify/lib/customer-vehicles-legacy');
    const account = await seedAccount(prisma, {
      email: 'retry@example.test',
      phone: '2015550175',
      vehiclesImportedAt: null,
    });
    let calls = 0;
    svc.setLegacyReaderForTests(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error(LEGACY_SOURCE_UNAVAILABLE);
        err.code = LEGACY_SOURCE_UNAVAILABLE;
        throw err;
      }
      return {
        ok: true,
        vehicles: [
          { id: 'cv_retry_1', label: 'Recovered', make: 'Tesla', model: 'Model 3' },
        ],
      };
    });
    const fail = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(fail.ok, false);
    assert.equal(fail.error, 'temporarily_unavailable');
    const ok = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(ok.ok, true);
    assert.equal(ok.importedCount, 1);
    const refreshed = await prisma.customerAccount.findUnique({ where: { id: account.id } });
    assert.ok(refreshed.vehiclesImportedAt);
    assert.equal(await prisma.customerVehicle.count({
      where: { customerAccountId: account.id, archivedAt: null },
    }), 1);
  });

  it('25. malformed Blob payload does not set vehiclesImportedAt', async () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const account = await seedAccount(prisma, {
      email: 'malformed@example.test',
      phone: '2015550174',
      vehiclesImportedAt: null,
    });
    svc.setLegacyReaderForTests(async () => ({
      ok: false,
      error: 'legacy_vehicle_source_unavailable',
    }));
    const r = await svc.importLegacyVehiclesForAccount(account.id);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'temporarily_unavailable');
    const refreshed = await prisma.customerAccount.findUnique({ where: { id: account.id } });
    assert.equal(refreshed.vehiclesImportedAt, null);
    assert.equal(await prisma.customerVehicle.count({ where: { customerAccountId: account.id } }), 0);
  });

  it('26. legacy reader distinguishes missing key from thrown Blob errors', async () => {
    const legacy = require('../netlify/lib/customer-vehicles-legacy');
    const missing = await legacy.readLegacyVehiclesForPhone('2015550173', {
      store: {
        async get() { return null; },
      },
    });
    assert.equal(missing.ok, true);
    assert.equal(missing.missing, true);
    assert.deepEqual(missing.vehicles, []);

    await assert.rejects(
      () => legacy.readLegacyVehiclesForPhone('2015550173', {
        store: {
          async get() { throw new Error('upstream_timeout'); },
        },
      }),
      (err) => err && err.code === legacy.LEGACY_SOURCE_UNAVAILABLE
    );

    await assert.rejects(
      () => legacy.readLegacyVehiclesForPhone('2015550173', {
        store: {
          async get() { return { vehicles: 'not-an-array' }; },
        },
      }),
      (err) => err && err.code === legacy.LEGACY_SOURCE_UNAVAILABLE
    );
  });

  it('27. invalid createdAt sorts deterministically last (no NaN instability)', () => {
    const svc = require('../netlify/lib/customer-vehicle-service');
    const sorted = svc.sortActiveVehicles([
      { id: 'cv_bad', isDefault: false, createdAt: 'not-a-date' },
      { id: 'cv_ok', isDefault: false, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    assert.equal(sorted[0].id, 'cv_ok');
    assert.equal(sorted[1].id, 'cv_bad');
  });

  it('28. card HTML: label + complete identity + color + default', () => {
    const card = require('../assets/customer-vehicle-card');
    const html = card.renderSavedVehicleCardHtml({
      id: 'cv_civic',
      label: 'My Civic',
      category: 'car',
      year: '2020',
      make: 'Honda',
      model: 'Civic',
      color: 'Black',
      isDefault: true,
    });
    assert.match(html, /<strong>My Civic<\/strong>/);
    assert.match(html, /saved-vehicle-identity[^>]*>2020 Honda Civic</);
    assert.match(html, /saved-vehicle-meta[^>]*>Car · Black</);
    assert.match(html, /card-kicker">Default</);
    assert.doesNotMatch(html, />Color</);
    assert.doesNotMatch(html, /undefined|null/);
  });

  it('29. card HTML: no label uses identity as title', () => {
    const card = require('../assets/customer-vehicle-card');
    const html = card.renderSavedVehicleCardHtml({
      id: 'cv_1',
      category: 'suv',
      year: '2019',
      make: 'Toyota',
      model: 'RAV4',
      color: 'Silver',
      isDefault: false,
    }, { includeActions: false });
    assert.match(html, /<strong>2019 Toyota RAV4<\/strong>/);
    assert.doesNotMatch(html, /saved-vehicle-identity/);
    assert.match(html, /SUV · Silver/);
  });

  it('30. card HTML: partial identity and category-only fallback', () => {
    const card = require('../assets/customer-vehicle-card');
    const partial = card.renderSavedVehicleCardHtml({
      id: 'cv_p',
      make: 'Ford',
      model: 'F-150',
      category: 'truck',
    }, { includeActions: false });
    assert.match(partial, /<strong>Ford F-150<\/strong>/);
    assert.match(partial, /Truck/);

    const catOnly = card.renderSavedVehicleCardHtml({
      id: 'cv_c',
      category: 'boat',
    }, { includeActions: false });
    assert.match(catOnly, /<strong>Boat<\/strong>/);
  });

  it('31. card HTML: never shows Color label or helper-description leakage', () => {
    const card = require('../assets/customer-vehicle-card');
    const html = card.renderSavedVehicleCardHtml({
      id: 'cv_x',
      label: 'Daily',
      category: 'Choose a vehicle category for accurate pricing',
      color: '',
      year: '2021',
      make: 'Honda',
      model: 'Accord',
    }, { includeActions: false });
    assert.match(html, /<strong>Daily<\/strong>/);
    assert.match(html, /2021 Honda Accord/);
    assert.doesNotMatch(html, /Choose a vehicle category/);
    assert.doesNotMatch(html, />Color</);
    assert.doesNotMatch(html, /accurate pricing/);
  });

  it('32. card HTML escapes label/make/model/color against XSS', () => {
    const card = require('../assets/customer-vehicle-card');
    const html = card.renderSavedVehicleCardHtml({
      id: 'cv_xss',
      label: '<img src=x onerror=alert(1)>',
      year: '2020',
      make: '<script>evil</script>',
      model: 'X&Y',
      color: '"Red"',
      category: 'car',
    }, { includeActions: false });
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>evil/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;script&gt;evil&lt;\/script&gt;/);
    assert.match(html, /X&amp;Y/);
    assert.match(html, /&quot;Red&quot;/);
  });

  it('33. projectVehicle API contract includes identity fields without owner keys', async () => {
    const svc = reloadService();
    svc.setPrismaForTests(prisma);
    const account = await seedAccount(prisma, {
      email: 'card-api@example.test',
      phone: '2015550188',
    });
    const created = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: {
        label: 'My Civic',
        category: 'car',
        year: '2020',
        make: 'Honda',
        model: 'Civic',
        color: 'Black',
        notes: 'QA STAGE2B SYNTHETIC',
        isDefault: true,
      },
    });
    assert.equal(created.ok, true);
    const listed = await svc.listVehicles(account.id);
    assert.equal(listed.ok, true);
    assert.equal(listed.vehicles.length, 1);
    const v = listed.vehicles[0];
    for (const key of [
      'id', 'label', 'category', 'year', 'make', 'model', 'color',
      'notes', 'isDefault', 'archivedAt', 'createdAt', 'updatedAt',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(v, key), `missing ${key}`);
    }
    assert.equal(v.label, 'My Civic');
    assert.equal(v.year, '2020');
    assert.equal(v.make, 'Honda');
    assert.equal(v.model, 'Civic');
    assert.equal(v.color, 'Black');
    assert.equal(v.archivedAt, null);
    assert.equal(Object.prototype.hasOwnProperty.call(v, 'customerAccountId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(v, 'legacySourceId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(v, 'phone'), false);

    const card = require('../assets/customer-vehicle-card');
    const html = card.renderSavedVehicleCardHtml(v);
    assert.match(html, /My Civic/);
    assert.match(html, /2020 Honda Civic/);
    assert.match(html, /Car · Black/);
  });

  it('34. create then update persists identity fields for card refresh', async () => {
    const svc = reloadService();
    svc.setPrismaForTests(prisma);
    const account = await seedAccount(prisma, {
      email: 'card-edit@example.test',
      phone: '2015550187',
    });
    const created = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: 1,
      vehicle: {
        label: 'QA STAGE2B A',
        category: 'car',
        year: '2018',
        make: 'Honda',
        model: 'Fit',
        color: 'Blue',
      },
    });
    assert.equal(created.ok, true);
    const updated = await svc.updateVehicle({
      customerAccountId: account.id,
      vehicleId: created.vehicleId,
      expectedVersion: created.accountVersion,
      vehicle: {
        label: 'QA STAGE2B B',
        year: '2022',
        make: 'Honda',
        model: 'Civic',
        color: 'Black',
      },
    });
    assert.equal(updated.ok, true);
    const listed = await svc.listVehicles(account.id);
    const v = listed.vehicles[0];
    assert.equal(v.label, 'QA STAGE2B B');
    assert.equal(v.year, '2022');
    assert.equal(v.model, 'Civic');
    assert.equal(v.color, 'Black');
    const html = require('../assets/customer-vehicle-card').renderSavedVehicleCardHtml(v);
    assert.match(html, /QA STAGE2B B/);
    assert.match(html, /2022 Honda Civic/);
    assert.match(html, /Black/);
  });
});
