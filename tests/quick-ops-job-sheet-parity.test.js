'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { projectJobSheet } = require('../netlify/lib/quick-ops-job-sheet');
const { projectQuickOpsBooking } = require('../netlify/lib/admin-quick-ops-view');
const { projectTechQuickOpsBooking } = require('../netlify/lib/tech-quick-ops-view');
const { quickOpsPage, techQuickOpsPage } = require('../netlify/lib/quick-ops-html');
const {
  isVisibleSubmittedBooking,
  isInternalBookingStoreKey,
  isInternalStoreRecord,
} = require('../netlify/lib/booking-visibility');

const LONG_NOTE = 'Park in the left driveway, side gate is unlocked. '.repeat(8).trim();

function multiVehicleBooking(overrides = {}) {
  return {
    id: 'CD1-PARITY-1',
    bookingVersion: 3,
    firstName: 'Dana',
    lastName: 'Rivera',
    phone: '+12015550142',
    address: '12 Harbor View, Fort Lee, NJ',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    confirmedDate: '2026-11-20',
    confirmedTimeWindow: '9-11',
    totalPrice: 487.5,
    approvedFinalAmount: 487.5,
    techPayoutAmount: 140,
    appointmentDurationMinutes: 270,
    notes: LONG_NOTE,
    accessNotes: 'Gate code 4417',
    waterAvailable: 'yes',
    electricityAvailable: 'no',
    serviceLocation: 'driveway',
    vehicles: [
      {
        year: 2022, make: 'Honda', model: 'CR-V', cat: 'suv',
        pkgName: 'Full Detail', basePrice: 289.25,
        addons: [
          { id: 'pet_hair', name: 'Pet hair removal', price: 61.75, qty: 1 },
          { id: 'odor', name: 'Odor treatment', price: 33.5, qty: 2 },
        ],
      },
      {
        vehicleLabel: '2020 Ford F-150', cat: 'truck', tierLabel: 'Large',
        pkgName: 'Wash & Shine', basePrice: 69.5,
        addons: [],
      },
    ],
    ...overrides,
  };
}

// Every dollar figure that belongs to the customer price on the fixture.
const CUSTOMER_PRICE_STRINGS = ['487.5', '487.50', '289.25', '61.75', '33.5', '33.50', '69.5', '69.50'];

describe('QuickOps job sheet parity (admin /ops/q vs technician /ops/t)', () => {
  it('admin and technician views carry the identical job sheet', () => {
    const booking = multiVehicleBooking();
    const admin = projectQuickOpsBooking(booking);
    const tech = projectTechQuickOpsBooking(booking);
    assert.deepEqual(tech.jobSheet, admin.jobSheet);
  });

  it('lists every vehicle with its package and add-ons (names and quantity)', () => {
    const sheet = projectJobSheet(multiVehicleBooking());
    assert.equal(sheet.vehicleCount, 2);
    assert.equal(sheet.vehicles[0].label, '2022 Honda CR-V');
    assert.equal(sheet.vehicles[0].packageName, 'Full Detail');
    assert.deepEqual(sheet.vehicles[0].addons, [
      { name: 'Pet hair removal', qty: 1 },
      { name: 'Odor treatment', qty: 2 },
    ]);
    assert.equal(sheet.vehicles[1].packageName, 'Wash & Shine');
    assert.equal(sheet.vehicles[1].tier, 'Large');
    assert.equal(sheet.durationMinutes, 270);
    assert.equal(sheet.water, 'Yes');
    assert.equal(sheet.electricity, 'No');
    assert.equal(sheet.accessNotes, 'Gate code 4417');
  });

  it('keeps legacy single-vehicle add-ons stored at the booking level', () => {
    const sheet = projectJobSheet({
      vehicleLabel: '2019 Subaru Forester',
      package: 'Maintenance Detail',
      addons: [{ id: 'clay', name: 'Clay bar', price: 45 }],
    });
    assert.equal(sheet.vehicles.length, 1);
    assert.deepEqual(sheet.vehicles[0].addons, [{ name: 'Clay bar', qty: 1 }]);
  });

  it('no longer cuts the customer note at 180 characters on either page', () => {
    const booking = multiVehicleBooking();
    assert.ok(LONG_NOTE.length > 180);
    assert.equal(projectQuickOpsBooking(booking).jobSheet.customerNote, LONG_NOTE);
    assert.equal(projectTechQuickOpsBooking(booking).jobSheet.customerNote, LONG_NOTE);
    assert.equal(projectQuickOpsBooking(booking).service.note, LONG_NOTE);
  });

  it('the job sheet never carries money', () => {
    const json = JSON.stringify(projectJobSheet(multiVehicleBooking()));
    for (const s of CUSTOMER_PRICE_STRINGS) assert.ok(!json.includes(s), `job sheet leaked ${s}`);
    assert.doesNotMatch(json, /price|total|amount|subtotal|deposit|\$/i);
  });

  it('both rendered pages show the add-ons; only the admin page shows the customer total', () => {
    const booking = multiVehicleBooking();
    const adminHtml = quickOpsPage(projectQuickOpsBooking(booking), 'csrf').body;
    const techHtml = techQuickOpsPage(projectTechQuickOpsBooking(booking), 'csrf').body;
    for (const html of [adminHtml, techHtml]) {
      assert.match(html, /Pet hair removal/);
      assert.match(html, /Odor treatment &times; 2/);
      assert.match(html, /2020 Ford F-150/);
      assert.match(html, /Gate code 4417/);
      assert.match(html, /4 h 30 min/);
    }
    assert.match(adminHtml, /\$487\.50/);
    for (const s of CUSTOMER_PRICE_STRINGS) {
      assert.ok(!techHtml.includes(s), `technician page leaked ${s}`);
    }
    assert.match(techHtml, /\$140/, 'technician still sees their own pay');
  });

  it('hides access notes from the technician after a completed, paid job', () => {
    const booking = multiVehicleBooking({
      jobStatus: 'completed_paid',
      completedAt: '2026-11-20T15:00:00.000Z',
      paymentStatus: 'paid',
      ledger: { approvedCents: 48750, settledCents: 48750 },
    });
    const tech = projectTechQuickOpsBooking(booking);
    assert.equal(tech.contactRestricted, true);
    assert.equal(tech.jobSheet.accessNotes, '');
    assert.deepEqual(tech.jobSheet.vehicles, projectQuickOpsBooking(booking).jobSheet.vehicles);
  });
});

describe('booking store internal records stay off the Jobs Board', () => {
  it('recognizes occupancy-claim keys and claim-shaped records', () => {
    assert.equal(isInternalBookingStoreKey('occupancy-claim/CD1-MVJLFEUS-2M6Q'), true);
    assert.equal(isInternalBookingStoreKey('CD1-MVJLFEUS-2M6Q'), false);
    assert.equal(isInternalStoreRecord({ at: '2026-10-22T13:45:09.514Z', nonce: 'abc-123', id: 'x' }), true);
    assert.equal(isInternalStoreRecord({ id: 'CD1-A', firstName: 'A', jobStatus: 'pending_review' }), false);
  });

  it('isVisibleSubmittedBooking rejects claim records', () => {
    const claim = {
      at: '2026-10-22T13:45:09.514Z',
      nonce: 'mvjlfeus-abc',
      id: 'occupancy-claim/CD1-MVJLFEUS-2M6Q',
      __blobKey: 'occupancy-claim/CD1-MVJLFEUS-2M6Q',
    };
    assert.equal(isVisibleSubmittedBooking(claim), false);
    assert.equal(isVisibleSubmittedBooking(claim, { includeArchivedTest: true }), false);
    assert.equal(isVisibleSubmittedBooking({ id: 'CD1-A', jobStatus: 'pending_review', firstName: 'A' }), true);
  });
});
