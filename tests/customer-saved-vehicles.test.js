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
    // Force older createdAt ordering deterministically via direct update.
    const olderRow = prisma._db.customerVehicle.get(older.vehicleId);
    olderRow.createdAt = '2020-01-01T00:00:00.000Z';
    prisma._db.customerVehicle.set(older.vehicleId, olderRow);

    const newer = await svc.createVehicle({
      customerAccountId: account.id,
      expectedVersion: older.accountVersion,
      vehicle: { label: 'Newer', make: 'Honda', model: 'Accord', isDefault: true },
    });
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

  it('17. My Garage UI wires default/edit/archive and expectedVersion', () => {
    const js = fs.readFileSync(path.join(__dirname, '../assets/my-garage.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../my-garage.html'), 'utf8');
    assert.match(js, /set_default/);
    assert.match(js, /expectedVersion/);
    assert.match(js, /data-vehicle-archive/);
    assert.match(js, /openVehicleForm/);
    assert.match(html, /id="vehicle-form"/);
    assert.match(html, /id="vh-default"/);
  });
});
