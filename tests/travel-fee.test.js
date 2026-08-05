const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  travelFeeFromMiles,
  estimateMilesForZip,
  resolveTravelForZip,
  applyServerTravelAndTotal,
  TRAVEL_MAX_MILES,
  FREE_RADIUS_MI,
  RATE_PER_MILE,
} = require('../netlify/lib/travel-fee');

test('fee is free inside the radius and linear beyond it', () => {
  assert.equal(travelFeeFromMiles(0), 0);
  assert.equal(travelFeeFromMiles(FREE_RADIUS_MI), 0);
  // $1/mi beyond 50, rounded to the nearest $5.
  assert.equal(travelFeeFromMiles(55), 5);
  assert.equal(travelFeeFromMiles(70), 20);
  assert.equal(travelFeeFromMiles(100), 50);
  assert.equal(travelFeeFromMiles(TRAVEL_MAX_MILES), 70);
  assert.equal(travelFeeFromMiles(TRAVEL_MAX_MILES + 1), null);
  assert.equal(travelFeeFromMiles(-1), null);
  assert.equal(travelFeeFromMiles('abc'), null);
});

test('no cliff edge — one extra mile never costs more than the rounding step', () => {
  // The old tier model jumped $15 between two adjacent ZIP prefixes. A linear
  // curve means the largest possible step is one rounding increment.
  let maxJump = 0;
  for (let mi = 0; mi < TRAVEL_MAX_MILES; mi += 1) {
    const jump = Math.abs(travelFeeFromMiles(mi + 1) - travelFeeFromMiles(mi));
    if (jump > maxJump) maxJump = jump;
  }
  assert.ok(maxJump <= 5, `largest single-mile jump was $${maxJump}`);
});

test('fee never decreases as distance grows', () => {
  let prev = -1;
  for (let mi = 0; mi <= TRAVEL_MAX_MILES; mi += 1) {
    const fee = travelFeeFromMiles(mi);
    assert.ok(fee >= prev, `fee fell at ${mi} mi`);
    prev = fee;
  }
});

test('distance comes from real coordinates, not from ZIP prefix ordering', () => {
  // The regression that motivated this module: ZIP3 prefixes are assigned by
  // sorting facility, so a higher prefix does not mean a longer drive. Edison
  // (088xx) is far closer than Camden (081xx), and the old table had it backwards.
  const edison = estimateMilesForZip('08817');
  const camden = estimateMilesForZip('08103');
  assert.ok(edison < camden, 'Edison must be nearer than Camden');
  assert.ok(edison < 55, `Edison should be well inside the region, got ${edison} mi`);
  assert.ok(camden > 95, `Camden should be far, got ${camden} mi`);
});

test('dense central-NJ market sits inside the free radius', () => {
  for (const zip of ['08817', '08901', '08872']) {
    const r = resolveTravelForZip(zip);
    assert.ok(r, `${zip} must be in range`);
    assert.equal(r.fee, 0, `${zip} should carry no travel fee`);
  }
});

test('genuinely distant locations are priced, and the far edge is refused', () => {
  const trenton = resolveTravelForZip('08608');
  assert.ok(trenton);
  assert.ok(trenton.fee > 0 && trenton.fee <= 40);

  // Vineland and Atlantic City are ~130-150 road miles out. The old model quoted
  // them at $25; they are now outside the service area entirely.
  assert.equal(resolveTravelForZip('08360'), null);
  assert.equal(resolveTravelForZip('08401'), null);
});

test('base and immediate metro are free', () => {
  for (const zip of ['07601', '07030', '07102', '10001', '11215']) {
    const r = resolveTravelForZip(zip);
    assert.ok(r, `${zip} must resolve`);
    assert.equal(r.fee, 0);
  }
});

test('unknown or malformed ZIP resolves to null rather than a guess', () => {
  assert.equal(resolveTravelForZip('90210'), null);
  assert.equal(resolveTravelForZip('123'), null);
  assert.equal(resolveTravelForZip(''), null);
  assert.equal(resolveTravelForZip(null), null);
  assert.equal(estimateMilesForZip('99999'), null);
});

test('applyServerTravelAndTotal rejects out-of-area zip', () => {
  const b = { zipCode: '90210', totalPrice: 200 };
  const r = applyServerTravelAndTotal(b);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'out_of_service_area');
});

test('applyServerTravelAndTotal ignores inflated client travel fee', () => {
  const b = {
    zipCode: '07601',
    totalPrice: 150,
    zoneSurcharge: 100,
    vehicles: [{
      cat: 'cars',
      pkgId: 'maint',
      tierKey: 'small',
      tierLabel: 'Small Car',
      vehicleLabel: '2022 Honda Civic',
      subtotal: 100,
      addons: [],
    }],
  };
  const r = applyServerTravelAndTotal(b);
  assert.equal(r.ok, true);
  assert.equal(b.travelFeeAmount, 0);
  assert.equal(b.totalPrice, 150);
});

/* ── Browser and server must quote the same number ───────────────────────── */

test('the shared client module agrees with the server on every served ZIP', () => {
  const clientSrc = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'travel-fee-client.js'),
    'utf8'
  );
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', clientSrc)(sandbox.window);
  const client = sandbox.window.CD1Travel;
  assert.ok(client, 'assets/travel-fee-client.js must expose CD1Travel');

  assert.equal(client.TRAVEL_MAX_MILES, TRAVEL_MAX_MILES);
  assert.equal(client.FREE_RADIUS_MI, FREE_RADIUS_MI);
  assert.equal(client.RATE_PER_MILE, RATE_PER_MILE);

  // A divergence here is what produces a price_mismatch rejection at submit,
  // so this walks the whole served table rather than sampling it.
  const { zipCoordIndex } = require('../netlify/lib/travel-fee');
  let checked = 0;
  for (const zip of zipCoordIndex().keys()) {
    const cm = client.estimateMilesForZip(zip);
    const sm = estimateMilesForZip(zip);
    assert.equal(cm, sm, `miles differ for ${zip}`);
    assert.equal(client.travelFeeFromMiles(cm), travelFeeFromMiles(sm), `fee differs for ${zip}`);
    checked += 1;
  }
  assert.ok(checked > 3000, `expected the full served table, checked ${checked}`);
});

test('no booking page carries its own copy of the distance table', () => {
  const root = path.join(__dirname, '..');
  const offenders = fs.readdirSync(root)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => /ZIP3_EST_MILES|TRAVEL_FEE_TIERS/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(offenders, [], 'these pages still duplicate the travel table');
});
