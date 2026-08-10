/**
 * Release gate: saved-vehicle garage is removed from the customer portal.
 * Booking still supports manual vehicle entry via change-request modals / public booking.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'my-garage.html');
const JS_PATH = path.join(ROOT, 'assets', 'my-garage.js');
const DATA_PATH = path.join(ROOT, 'netlify', 'functions', 'customer-portal-data.js');

describe('customer vehicle garage removed from release', () => {
  it('1. My Vehicles navigation/section is absent from portal HTML', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.doesNotMatch(html, /id="veh-h"|My Vehicles|vehicles-list|vehicle-form|vh-add-btn|vehicles-empty/);
    assert.doesNotMatch(html, /customer-vehicle-card\.js/);
    // Cache-busted is the contract; the stamp itself is not.
    assert.match(html, /my-garage\.js\?v=[A-Za-z0-9._-]+/);
  });

  it('2. frontend never calls customer-portal-vehicles and never shows garage unavailable copy', () => {
    const js = fs.readFileSync(JS_PATH, 'utf8');
    assert.doesNotMatch(js, /customer-portal-vehicles/);
    assert.doesNotMatch(js, /Vehicle garage is temporarily unavailable/);
    assert.doesNotMatch(js, /vehiclesError/);
    assert.doesNotMatch(js, /openVehicleForm|saveVehicleForm|formatSavedVehicleCardHtml/);
    assert.match(js, /vehicle_add_request/);
    assert.match(js, /renderVehicleModal/);
  });

  it('3. customer-portal-data does not invoke vehicle garage loaders', () => {
    const src = fs.readFileSync(DATA_PATH, 'utf8');
    assert.doesNotMatch(src, /listVehiclesForOwner|customer-vehicle-service|vehiclesError/);
    assert.doesNotMatch(src, /vehiclesImportedAt|CustomerVehicle/);
    assert.doesNotMatch(src, /^\s*vehicles,/m);
    assert.doesNotMatch(src, /vehicles:\s*vehicles\.length/);
  });

  it('4. portal account hydrate only requests customer-portal-data (no vehicle API)', () => {
    const js = fs.readFileSync(JS_PATH, 'utf8');
    const loadAccount = js.match(/async function loadAccount[\s\S]*?(?=\n  async function hydrateAuthenticatedPortal)/);
    assert.ok(loadAccount, 'loadAccount function present');
    assert.match(loadAccount[0], /post\('customer-portal-data'/);
    assert.doesNotMatch(loadAccount[0], /customer-portal-vehicles|listVehicles|vehiclesError/);
    const hydrate = js.match(/async function hydrateAuthenticatedPortal[\s\S]*?(?=\n  async function checkSession|\n  function checkSession|\n  async function verifyMagicLink)/);
    assert.ok(hydrate, 'hydrateAuthenticatedPortal present');
    assert.doesNotMatch(hydrate[0], /customer-portal-vehicles/);
    assert.match(js, /PORTAL_PHASE\.READY|'ready'/);
  });

  it('4b. customer-portal-data handler does not call vehicle garage even if Blob fails', async () => {
    // Source-level guarantee: no require of the garage module and no await of listVehicles*.
    const src = fs.readFileSync(DATA_PATH, 'utf8');
    assert.doesNotMatch(src, /require\(['"]\.\.\/lib\/customer-vehicles['"]\)/);
    assert.doesNotMatch(src, /await listVehicles/);
    assert.match(src, /buildCustomerProjection|validateCustomerSession/);
  });

  it('5. public booking still collects manual vehicle year/make/model', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(index, /ST\.vehicleLabel/);
    assert.match(index, /vehicleCategory/);
    assert.match(index, /ST\.year/);
    assert.match(index, /ST\.make/);
    assert.match(index, /ST\.model/);
  });

  it('6. no production CustomerVehicle migration is present on this release branch', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
    const migrations = fs.readdirSync(path.join(ROOT, 'prisma', 'migrations'));
    assert.equal(migrations.includes('20260723000000_customer_saved_vehicles'), false);
    assert.doesNotMatch(schema, /model CustomerVehicle/);
    assert.doesNotMatch(schema, /vehiclesImportedAt/);
  });
});
