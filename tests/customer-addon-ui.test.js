/**
 * Stage 2 — Customer add-on UI: canonical catalog + submit carve-out/remove + garage wiring.
 * Prefers real execution over source-text assertions for money/policy invariants.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const { PRICING } = require('../netlify/lib/booking-price-catalog');
const { ADDONS: customerCatalogAddons } = require('../netlify/lib/customer-catalog');
const { canRequestChange, isInvoicePaid } = require('../netlify/lib/appointment-status-policy');
const {
  serializeCanonicalAddonCatalog,
  serializeCategoryAddons,
  evaluatePostPayAdditiveAddonCarveOut,
  parseAddonIdList,
  currentAddonIdsOnBooking,
} = require('../netlify/lib/canonical-addon-catalog');
const { portalCatalogForClient } = require('../netlify/functions/customer-portal-data');

describe('Stage 2 canonical addon catalog serializer', () => {
  it('portal catalog is generated from booking-price-catalog prices (execution)', () => {
    const catalog = serializeCanonicalAddonCatalog();
    assert.equal(catalog.source, 'booking-price-catalog');
    const ozone = catalog.addons.find((a) => a.id === 'ozone');
    assert.ok(ozone, 'ozone Stage 1 fixture must be in serialized catalog');
    assert.equal(ozone.priceCents, 4000);
    assert.equal(ozone.name, 'Ozone Odor Treatment');
    assert.ok(ozone.description);

    for (const def of PRICING.cars.addons) {
      const row = catalog.addonsByCategory.cars.find((a) => a.id === def.id);
      assert.ok(row, `missing ${def.id}`);
      assert.equal(row.priceCents, Math.round(def.price * 100));
    }
  });

  it('serializer does not invent prices independent of PRICING', () => {
    const cars = serializeCategoryAddons('cars');
    for (const row of cars) {
      const def = PRICING.cars.addons.find((a) => a.id === row.id);
      assert.ok(def);
      assert.equal(row.priceCents, def.price * 100);
    }
  });

  it('portalCatalogForClient overwrites customer-catalog ADDONS with canonical prices', () => {
    const portal = portalCatalogForClient();
    assert.equal(portal.addonCatalogSource, 'booking-price-catalog');
    const ozone = portal.addons.find((a) => a.id === 'ozone');
    assert.ok(ozone, 'portal must expose ozone from booking-price-catalog');
    assert.equal(ozone.priceCents, 4000);

    // customer-catalog still has its own list, but portal must not use its prices.
    const staleOdor = customerCatalogAddons.find((a) => a.id === 'odor');
    assert.ok(staleOdor, 'fixture: customer-catalog still has odor');
    const portalOdor = portal.addons.find((a) => a.id === 'odor');
    assert.ok(portalOdor);
    assert.equal(portalOdor.priceCents, PRICING.cars.addons.find((a) => a.id === 'odor').price * 100);
    assert.notEqual(portalOdor.priceCents, staleOdor.price * 100,
      'portal must not serve independently priced customer-catalog odor');
  });

  it('customer-portal-data wires serializer (wiring guard)', () => {
    const src = read('netlify/functions/customer-portal-data.js');
    assert.match(src, /serializeCanonicalAddonCatalog/);
    assert.match(src, /portalCatalogForClient\(\)/);
    assert.doesNotMatch(src, /catalog:\s*catalogForClient\(\)/);
  });
});

describe('Stage 2 post-pay additive carve-out', () => {
  function paidBooking(overrides = {}) {
    return {
      id: 'CD1-TEST',
      bookingVersion: 1,
      quoteVersion: 1,
      status: 'Paid',
      paymentWorkflowStatus: 'payment_succeeded',
      paymentStatus: 'paid',
      ledger: { approvedCents: 17500, settledCents: 17500, creditedCents: 0, entries: [] },
      quote: { quoteVersion: 1, approvedCents: 17500 },
      service: {
        vehicles: [{
          vehicleId: 'veh_1',
          category: 'cars',
          cat: 'cars',
          tierKey: 'small',
          packageId: 'maint',
          addOnIds: [],
          addons: [],
        }],
      },
      travelFeeAmount: 0,
      ...overrides,
    };
  }

  it('allows additive ozone after settlement when approvedCents would increase', () => {
    const carve = evaluatePostPayAdditiveAddonCarveOut(paidBooking(), {
      addonIds: ['ozone'],
    });
    assert.equal(carve.ok, true, carve.error);
    assert.equal(carve.proposedApprovedCents, 21500);
    assert.equal(carve.currentApprovedCents, 17500);
  });

  it('rejects package/vehicle fields in post-pay carve-out', () => {
    const pack = evaluatePostPayAdditiveAddonCarveOut(paidBooking(), {
      addonIds: ['ozone'],
      newPackId: 'premium',
    });
    assert.equal(pack.ok, false);
    assert.equal(pack.error, 'invoice_paid');

    const veh = evaluatePostPayAdditiveAddonCarveOut(paidBooking(), {
      addonIds: ['ozone'],
      make: 'Toyota',
    });
    assert.equal(veh.ok, false);
    assert.equal(veh.error, 'invoice_paid');
  });

  it('rejects remove fields in post-pay carve-out', () => {
    const carve = evaluatePostPayAdditiveAddonCarveOut(paidBooking(), {
      addonIds: ['ozone'],
      addOnIdsToRemove: ['ozone'],
    });
    assert.equal(carve.ok, false);
    assert.equal(carve.error, 'settled_addon_remove_denied');
  });

  it('duplicate post-pay add is a harmless noop signal', () => {
    const carve = evaluatePostPayAdditiveAddonCarveOut(paidBooking({
      service: {
        vehicles: [{
          vehicleId: 'veh_1',
          category: 'cars',
          cat: 'cars',
          tierKey: 'small',
          packageId: 'maint',
          addOnIds: ['ozone'],
          addons: [{ id: 'ozone' }],
        }],
      },
      ledger: { approvedCents: 21500, settledCents: 17500, creditedCents: 0 },
      quote: { quoteVersion: 2, approvedCents: 21500 },
    }), { addonIds: ['ozone'] });
    assert.equal(carve.ok, false);
    assert.equal(carve.error, 'duplicate_addon');
    assert.equal(carve.noop, true);
  });
});

describe('Stage 2 policy remains globally paid-locked (execution)', () => {
  function paidInvoiceBooking() {
    return {
      status: 'Paid',
      paymentWorkflowStatus: 'payment_succeeded',
      paymentStatus: 'paid',
      ledger: { approvedCents: 17500, settledCents: 17500, creditedCents: 0 },
    };
  }

  it('canRequestChange still blocks package, vehicle, and addon at policy layer', () => {
    const paid = paidInvoiceBooking();
    assert.equal(isInvoicePaid(paid), true);
    assert.equal(canRequestChange(paid, 'package_change').ok, false);
    assert.equal(canRequestChange(paid, 'package_change').error, 'invoice_paid');
    assert.equal(canRequestChange(paid, 'vehicle_replace').ok, false);
    assert.equal(canRequestChange(paid, 'vehicle_add').ok, false);
    assert.equal(canRequestChange(paid, 'addon').ok, false);
    assert.equal(canRequestChange(paid, 'addon').error, 'invoice_paid');
    // Address / reschedule remain available (global paid policy unchanged)
    assert.equal(canRequestChange(paid, 'address').ok, true);
  });

  it('carve-out is additive-only; policy itself is not loosened', () => {
    const policySrc = read('netlify/lib/appointment-status-policy.js');
    assert.doesNotMatch(policySrc, /postPayAdditive|canApplyAdditive|addon_request/);
    const paid = paidInvoiceBooking();
    // Policy still says no — submit path must use carve-out evaluator, not a policy edit
    assert.equal(canRequestChange(paid, 'addon').ok, false);
    const carve = evaluatePostPayAdditiveAddonCarveOut({
      ...paid,
      bookingVersion: 1,
      quoteVersion: 1,
      quote: { quoteVersion: 1, approvedCents: 17500 },
      service: {
        vehicles: [{
          vehicleId: 'veh_1', category: 'cars', cat: 'cars',
          tierKey: 'small', packageId: 'maint', addOnIds: [], addons: [],
        }],
      },
      travelFeeAmount: 0,
    }, { addonIds: ['ozone'] });
    assert.equal(carve.ok, true);
  });
});

describe('Stage 2 empty / absent remove (execution helpers)', () => {
  it('empty remove list is a no-mutation signal', () => {
    assert.deepEqual(parseAddonIdList([]), []);
    assert.deepEqual(parseAddonIdList(''), []);
    assert.deepEqual(parseAddonIdList(null), []);
  });

  it('absent remove ids filter to empty — no quote-worthy delta', () => {
    const booking = {
      service: { vehicles: [{ addOnIds: ['rainx'], addons: [{ id: 'rainx' }] }] },
    };
    const requested = parseAddonIdList(['ozone']);
    const onBooking = new Set(currentAddonIdsOnBooking(booking));
    const actual = requested.filter((id) => onBooking.has(id));
    assert.deepEqual(actual, []);
  });
});

describe('Stage 2 submit-customer-action wiring guards', () => {
  const src = read('netlify/functions/submit-customer-action.js');

  it('wires addon_remove_request with settled deny and empty noop', () => {
    assert.match(src, /action === 'addon_remove_request'/);
    assert.match(src, /settled_addon_remove_denied/);
    assert.match(src, /empty_remove/);
    assert.match(src, /addon_not_present/);
    assert.match(src, /addOnIdsToRemove/);
  });

  it('post-pay carve-out uses evaluatePostPayAdditiveAddonCarveOut before auto-apply', () => {
    assert.match(src, /evaluatePostPayAdditiveAddonCarveOut/);
    assert.match(src, /postPayAdditiveCarveOut/);
  });

  it('returns authoritative projection cents on addon mutation response', () => {
    assert.match(src, /approvedCents:/);
    assert.match(src, /remainingCents:/);
    assert.match(src, /postgresProjection/);
    assert.match(src, /financialProjection/);
  });

  it('rate-limit branch returns 429 without Set-Cookie session clears', () => {
    // Server path: enforcePublicRateLimit runs before auth; blocked response must not
    // clear cookies (session preservation for 429).
    assert.match(src, /enforcePublicRateLimit/);
    assert.match(src, /rateLimit\.blocked/);
    assert.doesNotMatch(src, /Set-Cookie/);
    const rateSrc = read('netlify/lib/public-rate-limit.js');
    assert.doesNotMatch(rateSrc, /Set-Cookie/i);
    assert.doesNotMatch(rateSrc, /cd1_customer_session|clearCookie|Max-Age=0/i);
  });
});

describe('Stage 2 My Garage customer UI (wiring guards)', () => {
  const js = read('assets/my-garage.js');

  it('keeps add-on available after payment and hides remove when settled', () => {
    assert.match(js, /settledCentsFromPayment/);
    assert.match(js, /data-remove-addon/);
    assert.match(js, /Paid — removal unavailable|settled === 0/);
    assert.match(js, /addon_remove_request/);
    assert.match(js, /moneyActionsLockedWhenPaid/);
    assert.doesNotMatch(
      js.slice(js.indexOf('moneyActionsLockedWhenPaid'), js.indexOf('moneyActionsLockedWhenPaid') + 280),
      /addon_request:\s*true/
    );
  });

  it('pending lock + authoritative money + no silent version replay', () => {
    assert.match(js, /mutationPending/);
    assert.match(js, /setModalSubmitPending/);
    assert.match(js, /applyAuthoritativeMoney/);
    assert.match(js, /version_conflict/);
    assert.match(js, /Do not silently replay/);
    assert.match(js, /Preview only \(catalog\)/);
    assert.match(js, /Total approved/);
    assert.match(js, /delete body\.price/);
    assert.match(js, /delete body\.proposedTotal/);
  });

  it('429 and 5xx messages preserve session (no credential clear in error path)', () => {
    const mapStart = js.indexOf('function mapAddonErrorMessage');
    assert.ok(mapStart >= 0);
    const mapFn = js.slice(mapStart, mapStart + 1200);
    assert.match(mapFn, /429|too_many_requests/);
    assert.match(mapFn, /Temporary server error|5xx|service_unavailable|postgres_payment_disabled/);
    assert.match(mapFn, /session is still active/);
    // Error mapper must not invoke logout / credential clears
    assert.doesNotMatch(mapFn, /logout\(|clearLookupCredentials|sessionStorage\.removeItem/);
  });
});

describe('Stage 2 helpers', () => {
  it('parseAddonIdList dedupes and trims', () => {
    assert.deepEqual(parseAddonIdList([' ozone ', 'ozone', 'rainx']), ['ozone', 'rainx']);
  });

  it('currentAddonIdsOnBooking reads service vehicle ids', () => {
    const ids = currentAddonIdsOnBooking({
      service: { vehicles: [{ addOnIds: ['ozone', 'rainx'] }] },
    });
    assert.deepEqual(ids, ['ozone', 'rainx']);
  });
});
