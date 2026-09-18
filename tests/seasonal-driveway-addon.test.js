'use strict';

/**
 * Seasonal Driveway Cleanup — appointment-once convenience add-on.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  computeBookingServiceSubtotal,
  computeAddonTotal,
  PRICING,
} = require('../netlify/lib/booking-price-catalog');
const { quoteService, applyServiceDelta } = require('../netlify/lib/canonical-quote');
const { computeEligibleServiceSubtotalCents } = require('../netlify/lib/booking-offers');
const { buildReceiptProjection } = require('../netlify/lib/receipt-projection');
const Seasonal = require('../assets/seasonal-driveway-addon');
const lineItems = require('../assets/booking-line-items');

const PARENT = Seasonal.PARENT_ID;
const CHILDREN = Seasonal.CHILD_IDS;
const FAMILY_TOTAL = 95 + 35 + 45 + 50 + 50 + 35 + 125; // 435

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function car(overrides) {
  return {
    vehicleId: 'veh_a',
    cat: 'cars',
    category: 'cars',
    pkgId: 'full',
    packageId: 'full',
    pkgName: 'Premium Detail',
    tierKey: 'small',
    tierLabel: 'Small Car',
    vehicleLabel: '2022 Honda Civic',
    addons: [],
    addOnIds: [],
    ...overrides,
  };
}

function priced(vehicles) {
  return computeBookingServiceSubtotal({ zipCode: '07601', vehicles });
}

describe('Seasonal Driveway Cleanup catalog', () => {
  it('exposes parent + children at fixed prices on eligible categories only', () => {
    for (const cat of ['cars', 'rvs', 'powersports']) {
      const byId = Object.fromEntries(PRICING[cat].addons.map((a) => [a.id, a.price]));
      assert.equal(byId[PARENT], 95, cat);
      assert.equal(byId.walkway_steps, 35, cat);
      assert.equal(byId.porch_entry, 45, cat);
      assert.equal(byId.small_patio, 50, cat);
      assert.equal(byId.heavy_wet_leaf, 50, cat);
      assert.equal(byId.bag_place_property, 35, cat);
      assert.equal(byId.pressure_surface_wash, 125, cat);
      assert.equal(byId[PARENT] % 5, 0);
    }
    for (const cat of ['boats', 'fleet', 'trucks']) {
      const ids = (PRICING[cat].addons || []).map((a) => a.id);
      for (const id of Seasonal.FAMILY_IDS) {
        assert.equal(ids.includes(id), false, `${cat} must not list ${id}`);
      }
    }
  });

  it('does not promise haul-away or off-property disposal', () => {
    const { serializeCanonicalAddonCatalog } = require('../netlify/lib/canonical-addon-catalog');
    const sources = [
      read('assets/seasonal-driveway-addon.js'),
      read('index.html'),
      JSON.stringify(serializeCanonicalAddonCatalog()),
    ];
    for (const src of sources) {
      assert.doesNotMatch(src, /haul away/i);
      assert.doesNotMatch(src, /Bag & Remove/);
      assert.doesNotMatch(src, /waste disposal/i);
      assert.doesNotMatch(src, /leaf disposal/i);
      assert.match(src, /Bag & Place On Property/);
      assert.match(src, /Off-property disposal is not included|Debris haul-away or off-property disposal is not included/);
    }
  });
});

describe('single-vehicle server prices', () => {
  const cases = [
    { addons: [PARENT], extra: 95 },
    { addons: [PARENT, 'walkway_steps'], extra: 130 },
    { addons: [PARENT, 'porch_entry'], extra: 140 },
    { addons: [PARENT, 'small_patio'], extra: 145 },
    { addons: [PARENT, 'heavy_wet_leaf'], extra: 145 },
    { addons: [PARENT, 'bag_place_property'], extra: 130 },
    { addons: [PARENT, 'pressure_surface_wash'], extra: 220 },
    { addons: [PARENT, ...CHILDREN], extra: FAMILY_TOTAL },
  ];
  for (const c of cases) {
    it(`${c.addons.join('+')} adds $${c.extra}`, () => {
      const r = priced([car({ addons: c.addons.map((id) => ({ id })) })]);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.serviceSubtotal, 240 + c.extra);
      assert.equal(r.vehicles[0].addonTotal, c.extra);
    });
  }

  it('all options expected $435 actual matches', () => {
    const r = priced([car({ addons: [PARENT, ...CHILDREN].map((id) => ({ id })) })]);
    assert.equal(r.ok, true);
    assert.equal(r.vehicles[0].addonTotal, 435);
  });
});

describe('orphan children', () => {
  for (const id of CHILDREN) {
    it(`${id} without parent is rejected`, () => {
      const r = priced([car({ addons: [{ id }] })]);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'addon_parent_required');
    });
  }

  it('applyServiceDelta rejects a child-only add', () => {
    const delta = applyServiceDelta(
      { vehicles: [car()] },
      { vehicleId: 'veh_a' },
      { addOnIdsToAdd: ['porch_entry'] },
    );
    assert.equal(delta.ok, false);
    assert.equal(delta.error, 'addon_parent_required');
  });
});

describe('duplicate IDs charge once', () => {
  it('parent twice on one vehicle is $95', () => {
    const r = priced([car({
      addons: [{ id: PARENT }, { id: PARENT }],
    })]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.vehicles[0].addonTotal, 95);
  });

  it('parent on two vehicles is $95 once', () => {
    const r = priced([
      car({ vehicleId: 'veh_a', addons: [{ id: PARENT }] }),
      car({
        vehicleId: 'veh_b',
        pkgId: 'maint',
        packageId: 'maint',
        pkgName: 'Maintenance Detail',
        tierKey: 'suv2',
        addons: [{ id: PARENT }],
      }),
    ]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.serviceSubtotal, 240 + 185 + 95);
    const familyCounts = r.vehicles.map((v) => (v.addons || []).filter((a) => a.id === PARENT).length);
    assert.deepEqual(familyCounts.sort(), [0, 1]);
  });

  it('walkway twice across three vehicles is +$35 once', () => {
    const r = priced([
      car({ vehicleId: 'v1', addons: [{ id: PARENT }, { id: 'walkway_steps' }] }),
      car({ vehicleId: 'v2', pkgId: 'maint', packageId: 'maint', tierKey: 'suv2', addons: [{ id: PARENT }, { id: 'walkway_steps' }] }),
      car({ vehicleId: 'v3', pkgId: 'wash', packageId: 'wash', tierKey: 'small', addons: [{ id: 'walkway_steps' }] }),
    ]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.serviceSubtotal, 240 + 185 + 110 + 95 + 35);
  });

  it('qty greater than 1 is ignored for the family', () => {
    const r = computeAddonTotal({
      cat: 'cars',
      pkgId: 'full',
      addons: [{ id: PARENT, qty: 4 }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.total, 95);
    assert.equal(r.addons[0].qty, 1);
  });
});

describe('multi-vehicle appointment-once', () => {
  it('Vehicle A $240 + Vehicle B $185 + driveway $95 + walkway $35 + porch $45 = $600', () => {
    const r = priced([
      car({
        vehicleId: 'veh_a',
        addons: [{ id: PARENT }, { id: 'walkway_steps' }, { id: 'porch_entry' }],
      }),
      car({
        vehicleId: 'veh_b',
        pkgId: 'maint',
        packageId: 'maint',
        pkgName: 'Maintenance Detail',
        tierKey: 'suv2',
        addons: [{ id: PARENT }, { id: 'walkway_steps' }],
      }),
    ]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.serviceSubtotal, 600);
    const familyOnB = (r.vehicles[1].addons || []).filter((a) => Seasonal.isFamilyId(a.id));
    assert.equal(familyOnB.length, 0);
    const familyOnA = (r.vehicles[0].addons || []).map((a) => a.id);
    assert.deepEqual(familyOnA, [PARENT, 'walkway_steps', 'porch_entry']);
  });

  it('quoteService line items include the family once', () => {
    const quoted = quoteService({
      zip: '07601',
      vehicles: [
        car({ addons: [{ id: PARENT }, { id: 'walkway_steps' }] }),
        car({ vehicleId: 'veh_b', pkgId: 'maint', packageId: 'maint', tierKey: 'suv2', addons: [{ id: PARENT }] }),
      ],
    });
    assert.equal(quoted.ok, true, quoted.error);
    const familyLines = quoted.quote.lineItems.filter((l) => l.kind === 'addon' && Seasonal.isFamilyId(l.addonId));
    assert.equal(familyLines.length, 2);
    assert.equal(familyLines.reduce((s, l) => s + l.amountCents, 0), 13000);
    assert.equal(quoted.quote.serviceSubtotalCents, (240 + 185 + 130) * 100);
  });
});

describe('eligibility', () => {
  it('boats cannot host the family', () => {
    const r = priced([{
      vehicleId: 'boat1',
      cat: 'boats',
      pkgId: 'full',
      lengthFt: 22,
      addons: [{ id: PARENT }],
    }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'addon_ineligible_category');
  });

  it('fleet cannot host the family', () => {
    const r = priced([{
      vehicleId: 'fleet1',
      cat: 'fleet',
      pkgId: 'maint',
      tierKey: 'vehicle',
      units: 3,
      addons: [{ id: PARENT }],
    }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'addon_ineligible_category');
  });

  it('commercial trucks cannot host the family', () => {
    const r = priced([{
      vehicleId: 'semi1',
      cat: 'trucks',
      pkgId: 'int_wash',
      tierKey: 'day_cab',
      addons: [{ id: PARENT }],
    }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'addon_ineligible_category');
  });

  it('pickup trucks in the cars catalog can host the family', () => {
    const r = priced([car({
      tierKey: 'truck',
      pkgId: 'full',
      packageId: 'full',
      addons: [{ id: PARENT }],
    })]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.vehicles[0].addonTotal, 95);
    assert.equal(r.serviceSubtotal, 275 + 95);
  });

  it('rvs and powersports can host the family', () => {
    const rv = priced([{
      vehicleId: 'rv1',
      cat: 'rvs',
      pkgId: 'full_basic',
      rvType: 'travel',
      lengthFt: 20,
      addons: [{ id: PARENT }],
    }]);
    assert.equal(rv.ok, true, rv.error);
    assert.equal(rv.vehicles[0].addonTotal, 95);

    const ps = priced([{
      vehicleId: 'ps1',
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      addons: [{ id: PARENT }],
    }]);
    assert.equal(ps.ok, true, ps.error);
    assert.equal(ps.vehicles[0].addonTotal, 95);
  });
});

describe('parent uncheck / remove clears children', () => {
  it('removing parent strips children on the booking', () => {
    const delta = applyServiceDelta(
      {
        vehicles: [car({
          addOnIds: [PARENT, 'walkway_steps', 'porch_entry'],
          addons: [{ id: PARENT }, { id: 'walkway_steps' }, { id: 'porch_entry' }],
        })],
      },
      { vehicleId: 'veh_a' },
      { addOnIdsToRemove: [PARENT] },
    );
    assert.equal(delta.ok, true, delta.error);
    const ids = delta.service.vehicles[0].addOnIds;
    assert.equal(ids.includes(PARENT), false);
    assert.equal(ids.includes('walkway_steps'), false);
    assert.equal(ids.includes('porch_entry'), false);
  });

  it('UI toggle parent off clears children', () => {
    const st = { seasonalAddonIds: [PARENT, 'walkway_steps', 'small_patio'], vehicles: [] };
    Seasonal.toggle(PARENT, st, PRICING);
    assert.deepEqual(st.seasonalAddonIds, []);
  });
});

describe('multi-vehicle mutation keeps one appointment-level set', () => {
  function twoCars() {
    return {
      vehicles: [
        car({
          addOnIds: [PARENT, 'walkway_steps', 'porch_entry'],
          addons: [{ id: PARENT }, { id: 'walkway_steps' }, { id: 'porch_entry' }],
        }),
        car({
          vehicleId: 'veh_b',
          pkgId: 'maint',
          packageId: 'maint',
          pkgName: 'Maintenance Detail',
          tierKey: 'suv2',
          addOnIds: [],
          addons: [],
        }),
      ],
    };
  }

  it('removing a child targeting the non-host vehicle still drops that child once', () => {
    const delta = applyServiceDelta(
      twoCars(),
      { vehicleId: 'veh_b' },
      { addOnIdsToRemove: ['walkway_steps'] },
    );
    assert.equal(delta.ok, true, delta.error);
    const family = Seasonal.collectFamilyIds(delta.service.vehicles);
    assert.deepEqual(family, [PARENT, 'porch_entry']);
    assert.equal(delta.service.vehicles[1].addOnIds.some((id) => Seasonal.isFamilyId(id)), false);
  });

  it('adding the family to the second vehicle collapses onto the primary', () => {
    const delta = applyServiceDelta(
      {
        vehicles: [
          car({ addOnIds: [], addons: [] }),
          car({ vehicleId: 'veh_b', pkgId: 'maint', packageId: 'maint', tierKey: 'suv2', addOnIds: [], addons: [] }),
        ],
      },
      { vehicleId: 'veh_b' },
      { addOnIdsToAdd: [PARENT, 'walkway_steps'] },
    );
    assert.equal(delta.ok, true, delta.error);
    assert.deepEqual(Seasonal.collectFamilyIds([delta.service.vehicles[0]]), [PARENT, 'walkway_steps']);
    assert.equal(delta.service.vehicles[1].addOnIds.some((id) => Seasonal.isFamilyId(id)), false);
  });

  it('removing the primary vehicle rehomes the family onto the remaining eligible vehicle', () => {
    const prev = twoCars().vehicles;
    const remaining = prev.filter((v) => v.vehicleId !== 'veh_a');
    const rehomed = Seasonal.rehomeAppointmentFamily(prev, remaining);
    assert.equal(rehomed.ok, true, rehomed.error);
    assert.equal(rehomed.vehicles.length, 1);
    assert.deepEqual(Seasonal.collectFamilyIds(rehomed.vehicles), [PARENT, 'walkway_steps', 'porch_entry']);
    assert.equal(rehomed.vehicles[0].vehicleId, 'veh_b');
  });

  it('adding a second vehicle does not clone the family', () => {
    const prev = twoCars().vehicles;
    const next = prev.concat([
      car({
        vehicleId: 'veh_c',
        pkgId: 'wash',
        packageId: 'wash',
        addOnIds: [],
        addons: [],
      }),
    ]);
    const rehomed = Seasonal.rehomeAppointmentFamily(prev, next);
    assert.equal(rehomed.ok, true, rehomed.error);
    const familyHosts = rehomed.vehicles.filter((v) => Seasonal.collectFamilyIds([v]).length > 0);
    assert.equal(familyHosts.length, 1);
    assert.equal(familyHosts[0].vehicleId, 'veh_a');
  });

  it('cart sync after removing the primary vehicle keeps one charge', () => {
    const st = {
      seasonalAddonIds: [PARENT, 'walkway_steps'],
      vehicles: [
        car({ addons: [{ id: PARENT, price: 95 }, { id: 'walkway_steps', price: 35 }, { id: 'rainx', price: 35 }] }),
        car({
          vehicleId: 'veh_b',
          pkgId: 'maint',
          packageId: 'maint',
          tierKey: 'suv2',
          basePrice: 185,
          addons: [],
          addonTotal: 0,
          subtotal: 185,
        }),
      ],
    };
    st.vehicles.splice(0, 1);
    Seasonal.syncSeasonalOntoCart(st, PRICING);
    const family = (st.vehicles[0].addons || []).filter((a) => Seasonal.isFamilyId(a.id)).map((a) => a.id);
    assert.deepEqual(family, [PARENT, 'walkway_steps']);
    assert.equal(st.vehicles[0].addonTotal, 130);
    assert.equal(st.vehicles[0].subtotal, 185 + 130);
  });
});

describe('history immutability', () => {
  it('stored driveway prices stay $95 / $35 after catalog change', () => {
    const booking = {
      id: 'CD1-HIST-DRIVEWAY',
      isDraft: false,
      status: 'Completed',
      jobStatus: 'completed',
      completedAt: '2026-09-15T18:00:00.000Z',
      paymentWorkflowStatus: 'payment_succeeded',
      approvedFinalAmount: 370,
      totalPrice: 370,
      vehicles: [{
        vehicleId: 'veh_a',
        vehicleLabel: '2022 Honda Civic',
        packageName: 'Premium Detail',
        basePrice: 240,
        addons: [
          { id: PARENT, name: 'Seasonal Driveway Cleanup', qty: 1, price: 95 },
          { id: 'walkway_steps', name: 'Front Walkway + Steps', qty: 1, price: 35 },
        ],
        addonTotal: 130,
        subtotal: 370,
      }],
      ledger: {
        approvedCents: 37000,
        settledCents: 37000,
        creditedCents: 0,
        entries: [{ kind: 'settlement', amountCents: 37000, recordedAt: '2026-09-15T17:30:00.000Z' }],
      },
    };

    const parentDef = PRICING.cars.addons.find((a) => a.id === PARENT);
    const walkDef = PRICING.cars.addons.find((a) => a.id === 'walkway_steps');
    const prevParent = parentDef.price;
    const prevWalk = walkDef.price;
    parentDef.price = 110;
    walkDef.price = 40;
    try {
      const receipt = buildReceiptProjection(booking, 'final');
      assert.equal(receipt.ok, true, receipt.error);
      const addons = receipt.receipt.vehicles[0].addons;
      assert.equal(addons.find((a) => a.name === 'Seasonal Driveway Cleanup').price.cents, 9500);
      assert.equal(addons.find((a) => a.name === 'Front Walkway + Steps').price.cents, 3500);
    } finally {
      parentDef.price = prevParent;
      walkDef.price = prevWalk;
    }
  });
});

describe('Review presentation', () => {
  it('groups driveway family once under On-Site Convenience', () => {
    const html = lineItems.renderSummaryHtml(lineItems.projectBooking({
      vehicles: [
        {
          vehicleLabel: '2022 Honda Civic',
          pkgName: 'Premium Detail',
          basePrice: 240,
          addons: [
            { id: PARENT, name: 'Seasonal Driveway Cleanup', price: 95 },
            { id: 'walkway_steps', name: 'Front Walkway + Steps', price: 35 },
            { id: 'bag_place_property', name: 'Bag & Place On Property', price: 35 },
            { id: 'rainx', name: 'Rain-X Glass Treatment', price: 25 },
          ],
          addonTotal: 190,
          subtotal: 430,
        },
        {
          vehicleLabel: '2019 Toyota RAV4',
          pkgName: 'Maintenance Detail',
          basePrice: 185,
          addons: [{ id: PARENT, name: 'Seasonal Driveway Cleanup', price: 95 }],
          addonTotal: 95,
          subtotal: 280,
        },
      ],
    }).items);
    assert.match(html, /On-Site Convenience/);
    assert.equal((html.match(/Seasonal Driveway Cleanup/g) || []).length, 1);
    assert.match(html, /Front Walkway \+ Steps/);
    assert.match(html, /Bag &amp; Place On Property/);
    assert.match(html, /On-Site Convenience subtotal/);
    assert.doesNotMatch(html, /haul away/i);
  });
});

describe('Welcome10 generic add-on semantics are unchanged', () => {
  it('eligible subtotal uses vehicle subtotal which already includes add-ons', () => {
    const cents = computeEligibleServiceSubtotalCents({
      vehicles: [{
        cat: 'cars',
        pkgId: 'full',
        pkgName: 'Premium Detail',
        subtotal: 240 + 95,
        basePrice: 240,
        addonTotal: 95,
      }],
    });
    assert.equal(cents, 33500);
  });
});

describe('booking page wiring', () => {
  for (const page of BOOKING_PAGES) {
    it(`${page} loads seasonal module, catalog, and filters family cards`, () => {
      const html = read(page);
      assert.match(html, /assets\/seasonal-driveway-addon\.js/);
      assert.match(html, /id:'seasonal_driveway_cleanup'/);
      assert.match(html, /CD1SeasonalDriveway\.isFamilyId/);
      assert.match(html, /CD1SeasonalDriveway\.mountAddonGrid/);
      assert.match(html, /CD1SeasonalDriveway\.syncSeasonalOntoCart/);
      assert.doesNotMatch(html, /haul away/i);
      assert.match(html, /Weather permitting/);
    });
  }
});

describe('UI parent/child visibility', () => {
  it('hides children until parent is selected and clears them on uncheck', () => {
    const st = { cat: 'cars', seasonalAddonIds: [], vehicles: [] };
    const closed = Seasonal.blockHtml(st, PRICING);
    assert.match(closed, /Seasonal Driveway Cleanup/);
    assert.match(closed, /onsite-conv-children"/);
    assert.doesNotMatch(closed, /onsite-conv-children open/);

    Seasonal.toggle(PARENT, st, PRICING);
    Seasonal.toggle('walkway_steps', st, PRICING);
    const open = Seasonal.blockHtml(st, PRICING);
    assert.match(open, /onsite-conv-children open/);
    assert.deepEqual(st.seasonalAddonIds, [PARENT, 'walkway_steps']);

    Seasonal.toggle(PARENT, st, PRICING);
    assert.deepEqual(st.seasonalAddonIds, []);
    const again = Seasonal.blockHtml(st, PRICING);
    assert.doesNotMatch(again, /onsite-conv-children open/);
  });

  it('does not allow a child toggle without the parent', () => {
    const st = { cat: 'cars', seasonalAddonIds: [], vehicles: [] };
    Seasonal.toggle('porch_entry', st, PRICING);
    assert.deepEqual(st.seasonalAddonIds, []);
  });
});

describe('convenience is not a standalone booking', () => {
  it('family add-ons without a package cannot price a booking', () => {
    const r = priced([{
      vehicleId: 'veh_only',
      cat: 'cars',
      addons: [{ id: PARENT }],
    }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_pricing');
  });
});
