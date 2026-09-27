'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PRICING,
  computeVehicleSubtotal,
  inferPkgId,
} = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const {
  applyCeramicBooking,
  assignInternalCoating,
  basePriceFor,
  completeServiceLine,
  customerCeramicSummary,
  depositCentsForApproved,
  durationForVehicle,
  evaluateEligibility,
  PUBLIC_PACKAGE_NAMES,
  resolveCompanionInterior,
  validateAddonSet,
} = require('../netlify/lib/ceramic-coating');
const {
  appendSettlement,
  applyStripePaymentIntent,
  ceramicIntentSpec,
  chargeDueNow,
  collectBalanceOnce,
  conversionEvidence,
  projectPayment,
  stripePaymentIntentForm,
} = require('../netlify/lib/ceramic-payment');
const { hasSlotConflict, planCombinedAppointment, spannedSlotTimes } = require('../netlify/lib/booking-schedule');
const { buildPaymentCompatibilityPatch } = require('../netlify/lib/db/operational-payment');
const { packageOptionsForVehicle } = require('../netlify/lib/package-financial-mutation');
const { projectQuickOpsBooking } = require('../netlify/lib/admin-quick-ops-view');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const { buildReceiptProjection } = require('../netlify/lib/receipt-projection');
const { buildEmailContent, buildSmsBody } = require('../netlify/lib/booking-transactional-notifications');
const { reserveCeramicPaymentIntent } = require('../netlify/lib/db/payment-authority-service');
const fs = require('node:fs');
const path = require('node:path');

const ZIP = '07601';
const WEEKDAY = '2026-10-05';
const SATURDAY = '2026-10-03';

const PRICES = {
  ceramic_1yr: { small: 650, suv2: 725, suv3: 825, truck: 825, compact_van: 825, midsize_van: 825, full_size_van_passenger: 925 },
  ceramic_3yr: { small: 1050, suv2: 1150, suv3: 1275, truck: 1275, compact_van: 1275, midsize_van: 1275, full_size_van_passenger: 1425 },
};

function eligible(extra = {}) {
  return {
    repainted60: 'no',
    clearCoatFailing: 'no',
    severeContamination: 'no',
    matteWrapPpf: 'no',
    coveredCureArea: 'yes',
    remainDry12h: 'yes',
    ...extra,
  };
}

function vehicle(pkgId, tierKey, addons = [], extra = {}) {
  return {
    cat: 'cars',
    pkgId,
    tierKey,
    addons,
    ...extra,
  };
}

function pricedBooking(pkgId, tierKey, addons = [], extraVehicle = {}, extraBooking = {}) {
  const quoted = computeVehicleSubtotal(vehicle(pkgId, tierKey, addons, extraVehicle), ZIP, extraBooking);
  assert.equal(quoted.ok, true, quoted.error || 'price failed');
  return {
    id: 'CD1-CER-1',
    zipCode: ZIP,
    vehicles: [{
      ...vehicle(pkgId, tierKey, quoted.addons, extraVehicle),
      basePrice: quoted.basePrice,
      subtotal: quoted.subtotal,
    }],
    totalPrice: quoted.subtotal,
    travelFeeAmount: 0,
    ceramicEligibility: eligible(),
    ceramicPaymentPlan: 'prepay_full',
    ...extraBooking,
  };
}

describe('ceramic package prices by canonical vehicle class', () => {
  for (const [pkgId, tiers] of Object.entries(PRICES)) {
    for (const [tierKey, amount] of Object.entries(tiers)) {
      it(`${pkgId} ${tierKey} is $${amount}`, () => {
        const quoted = computeVehicleSubtotal(vehicle(pkgId, tierKey), ZIP);
        assert.equal(quoted.ok, true);
        assert.equal(quoted.basePrice, amount);
        assert.equal(quoted.subtotal, amount);
        assert.equal(PRICING.cars.tiers[tierKey][pkgId], amount);
      });
    }
  }

  it('cargo vans, semis, RVs, boats, and powersports do not inherit passenger ceramic prices', () => {
    assert.equal(PRICING.cars.tiers.full_size_van.ceramic_1yr, undefined);
    assert.equal(basePriceFor('cars', 'full_size_van', 'ceramic_1yr').error, 'ceramic_vehicle_ineligible');
    for (const cat of ['trucks', 'rvs', 'boats', 'powersports', 'fleet']) {
      const quoted = computeVehicleSubtotal({ cat, pkgId: 'ceramic_1yr', tierKey: 'day_cab' }, ZIP);
      assert.equal(quoted.ok, false);
      assert.equal(quoted.error, 'ceramic_vehicle_ineligible');
    }
  });

  it('existing non-ceramic car prices stay on the catalog', () => {
    assert.equal(computeVehicleSubtotal(vehicle('wash', 'small'), ZIP).subtotal, 125);
    assert.equal(computeVehicleSubtotal(vehicle('maint', 'small'), ZIP).subtotal, 160);
    assert.equal(computeVehicleSubtotal(vehicle('full', 'suv2'), ZIP).subtotal, 285);
    const engine = PRICING.cars.addons.find((a) => a.id === 'engine');
    assert.equal(engine.price, 45);
  });

  it('powersports heavy mud stays on its own catalog price', () => {
    const quoted = computeVehicleSubtotal({
      cat: 'powersports',
      pkgId: 'wash',
      tierKey: 'motorcycle',
      addons: [{ id: 'heavymud' }],
    }, ZIP);
    assert.equal(quoted.ok, true, quoted.error);
    assert.equal(quoted.addonTotal, 75);
  });
});

describe('ceramic add-ons', () => {
  const flat = {
    ceramic_windshield: 100,
    ceramic_glass_all: 175,
    ceramic_wheels: 175,
    ceramic_trim: 125,
    ceramic_lights: 75,
    ceramic_correction: 250,
    engine_bay: 125,
    mobile_water: 50,
    heavymud: 75,
  };

  for (const [id, price] of Object.entries(flat)) {
    it(`${id} lists at $${price}`, () => {
      const row = PRICING.cars.addons.find((a) => a.id === id);
      assert.ok(row);
      assert.equal(row.price, price);
    });
  }

  it('prices water spots, contamination, and undercarriage from the vehicle class', () => {
    const cases = [
      ['small', 'ceramic_waterspot', 125],
      ['suv2', 'ceramic_waterspot', 175],
      ['truck', 'ceramic_waterspot', 225],
      ['full_size_van_passenger', 'ceramic_waterspot', 250],
      ['small', 'ceramic_contamination', 100],
      ['suv2', 'ceramic_contamination', 150],
      ['suv3', 'ceramic_contamination', 200],
      ['full_size_van_passenger', 'ceramic_contamination', 250],
      ['small', 'undercarriage', 125],
      ['suv2', 'undercarriage', 150],
      ['truck', 'undercarriage', 175],
      ['full_size_van_passenger', 'undercarriage', 225],
    ];
    for (const [tierKey, id, price] of cases) {
      const extra = id === 'undercarriage' ? { ceramicWaterSupply: 'customer' } : {};
      const quoted = computeVehicleSubtotal(
        vehicle('ceramic_1yr', tierKey, [{ id }], extra),
        ZIP
      );
      assert.equal(quoted.ok, true, `${tierKey} ${id} ${quoted.error}`);
      assert.equal(quoted.addonTotal, price);
    }
  });

  it('rejects windshield together with all exterior glass', () => {
    const quoted = computeVehicleSubtotal(vehicle('ceramic_1yr', 'small', [
      { id: 'ceramic_windshield' },
      { id: 'ceramic_glass_all' },
    ]), ZIP);
    assert.equal(quoted.ok, false);
    assert.equal(quoted.error, 'ceramic_glass_mutually_exclusive');
  });

  it('rejects ceramic-only add-ons on a wash and engine bay twice', () => {
    const glassOnWash = computeVehicleSubtotal(vehicle('wash', 'small', [{ id: 'ceramic_windshield' }]), ZIP);
    assert.equal(glassOnWash.error, 'incompatible_addon');
    const bothEngines = computeVehicleSubtotal(vehicle('full', 'small', [
      { id: 'engine' },
      { id: 'engine_bay' },
    ]), ZIP);
    assert.equal(bothEngines.error, 'engine_addon_mutually_exclusive');
  });

  it('requires water supply with undercarriage and keeps heavy mud combinable', () => {
    const missing = computeVehicleSubtotal(vehicle('ceramic_1yr', 'small', [{ id: 'undercarriage' }]), ZIP);
    assert.equal(missing.error, 'water_supply_required');
    const mobile = computeVehicleSubtotal(vehicle('ceramic_1yr', 'suv3', [
      { id: 'undercarriage' },
      { id: 'mobile_water' },
      { id: 'heavymud' },
    ], { ceramicWaterSupply: 'mobile' }), ZIP);
    assert.equal(mobile.ok, true, mobile.error);
    assert.equal(mobile.addonTotal, 175 + 50 + 75);
  });

  it('rejects a browser price that does not match the server total', () => {
    const booking = {
      zipCode: ZIP,
      vehicles: [vehicle('ceramic_1yr', 'small')],
      totalPrice: 1,
    };
    const mismatched = applyServerTravelAndTotal(booking);
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.error, 'price_mismatch');
    assert.equal(mismatched.serverTotal, 650);
  });
});

describe('ceramic eligibility', () => {
  it('blocks fresh paint, failing clear coat, and severe contamination toward paint restoration', () => {
    for (const field of ['repainted60', 'clearCoatFailing', 'severeContamination']) {
      const result = evaluateEligibility(eligible({ [field]: 'yes' }), { requireComplete: true });
      assert.equal(result.ok, false);
      assert.equal(result.route, 'paint_restoration');
      assert.equal(result.packageId, 'premium');
    }
  });

  it('routes matte, wrap, or PPF away from the paint package', () => {
    const result = evaluateEligibility(eligible({ matteWrapPpf: 'yes' }), { requireComplete: true });
    assert.equal(result.ok, false);
    assert.equal(result.route, 'compatible_finish');
    assert.equal(result.packageId, null);
  });

  it('warns when no covered curing space is available and blocks a dry-cure refusal', () => {
    const warning = evaluateEligibility(eligible({ coveredCureArea: 'no' }), { requireComplete: true });
    assert.equal(warning.ok, true);
    assert.equal(warning.warnings.length, 1);
    const blocked = evaluateEligibility(eligible({ remainDry12h: 'no' }), { requireComplete: true });
    assert.equal(blocked.error, 'ceramic_blocked_cure');
  });
});

describe('ceramic payment state', () => {
  function prepared(plan, pkgId = 'ceramic_1yr') {
    const booking = pricedBooking(pkgId, 'small', [], {}, { ceramicPaymentPlan: plan });
    const applied = applyCeramicBooking(booking, { finalize: true });
    assert.equal(applied.ok, true, applied.error);
    return booking;
  }

  it('ignores a client amountPaid and stays unpaid until a ledger settlement', () => {
    const booking = pricedBooking('ceramic_1yr', 'small', [], {}, {
      ceramicPaymentPlan: 'prepay_full',
      amountPaid: 650,
      paymentStatus: 'paid',
    });
    const applied = applyCeramicBooking(booking, { finalize: true });
    assert.equal(applied.ok, true);
    assert.equal(booking.approvedFinalAmount, 650);
    assert.equal(booking.amountPaid, 0);
    assert.equal(booking.balanceDue, 650);
    assert.equal(booking.paymentStatus, 'unpaid');
  });

  it('prepays the full approved amount once and replays the same capture', () => {
    const booking = prepared('prepay_full');
    const due = chargeDueNow(booking);
    assert.equal(due.chargeCents, 65000);
    const failed = applyStripePaymentIntent(booking, {
      id: 'pi_fail',
      status: 'requires_payment_method',
      amount: 65000,
      metadata: { purpose: 'ceramic_checkout', bookingId: booking.id },
    });
    assert.equal(failed.settled, false);
    assert.equal(booking.ledger?.entries?.length || 0, 0);

    const pi = {
      id: 'pi_full',
      status: 'succeeded',
      amount_received: 65000,
      metadata: { purpose: 'ceramic_checkout', bookingId: booking.id },
    };
    const first = applyStripePaymentIntent(booking, pi);
    const second = applyStripePaymentIntent(booking, pi, { stripeEventId: 'evt_retry' });
    assert.equal(first.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(booking.paymentStatus, 'paid');
    assert.equal(booking.amountPaid, 650);
    assert.equal(booking.balanceDue, 0);
    assert.equal(booking.ledger.entries.length, 1);
    assert.equal(booking.ledger.entries[0].immutable, true);
    const projection = projectPayment(booking);
    assert.equal(projection.approvedFinalAmount, projection.amountPaid + projection.balanceDue);
  });

  it('records a deposit as partially paid and collects the exact balance once', () => {
    const booking = prepared('deposit');
    assert.equal(booking.depositAmount, 162.5);
    assert.equal(chargeDueNow(booking).chargeCents, 16250);
    const deposit = applyStripePaymentIntent(booking, {
      id: 'pi_dep',
      status: 'succeeded',
      amount_received: 16250,
      metadata: { purpose: 'ceramic_checkout', bookingId: booking.id },
    });
    assert.equal(deposit.projection.paymentStatus, 'partially_paid');
    assert.equal(booking.amountPaid, 162.5);
    assert.equal(booking.balanceDue, 487.5);
    assert.equal(booking.approvedFinalAmount, 650);

    const again = appendSettlement(booking, {
      providerEventId: 'settlement_pi_dep_2',
      amountCents: 16250,
      purpose: 'ceramic_checkout',
    });
    assert.equal(again.ok, false);
    assert.equal(again.error, 'ceramic_deposit_already_collected');

    const short = collectBalanceOnce(booking, { amountCents: 10000, providerEventId: 'bal_short' });
    assert.equal(short.error, 'ceramic_balance_mismatch');
    const collected = collectBalanceOnce(booking, { providerEventId: 'bal_once', method: 'card' });
    const replay = collectBalanceOnce(booking, { providerEventId: 'bal_once', method: 'card' });
    const third = collectBalanceOnce(booking, { providerEventId: 'bal_other', method: 'cash' });
    assert.equal(collected.ok, true);
    assert.equal(replay.duplicate, true);
    assert.equal(third.error, 'ceramic_balance_already_collected');
    assert.equal(booking.paymentStatus, 'paid');
    assert.equal(booking.amountPaid, 650);
    assert.equal(booking.balanceDue, 0);
    assert.equal(booking.ledger.entries.length, 2);
  });

  it('disables the deposit plan when the feature flag is off', () => {
    const booking = pricedBooking('ceramic_3yr', 'suv2', [], {}, { ceramicPaymentPlan: 'deposit' });
    const blocked = applyCeramicBooking(booking, {
      finalize: true,
      env: { CD1_CERAMIC_DEPOSITS: '0' },
    });
    assert.equal(blocked.error, 'ceramic_deposit_disabled');
    const prepay = pricedBooking('ceramic_3yr', 'suv2', [], {}, { ceramicPaymentPlan: 'prepay_full' });
    const allowed = applyCeramicBooking(prepay, {
      finalize: true,
      env: { CD1_CERAMIC_DEPOSITS: '0' },
    });
    assert.equal(allowed.ok, true);
    assert.equal(prepay.approvedFinalAmount, 1150);
  });

  it('builds an on-session deposit intent and refuses a manipulated amount', () => {
    const booking = prepared('deposit', 'ceramic_3yr');
    const spec = ceramicIntentSpec(booking, { quoteVersion: 1, phase: 'checkout' });
    assert.equal(spec.ok, true);
    assert.equal(spec.amountCents, 26250);
    assert.equal(spec.purpose, 'ceramic_checkout');
    assert.equal(spec.offSession, false);
    assert.equal(spec.confirm, false);
    const form = stripePaymentIntentForm(spec);
    assert.equal(form.get('amount'), '26250');
    assert.equal(form.get('metadata[purpose]'), 'ceramic_checkout');
    assert.equal(form.has('off_session'), false);
    assert.equal(form.has('confirm'), false);
    assert.match(spec.idempotencyKey, /^pi_ceramic_checkout_CD1-CER-1_1_26250_1$/);
  });

  it('does not open a PaymentIntent for a non-ceramic booking', async () => {
    const result = await reserveCeramicPaymentIntent({
      booking: { id: 'CD1-WASH', serviceFamily: 'wash', ceramicPaymentPlan: 'prepay_full' },
      quoteVersion: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_ceramic_booking');
  });

  it('maps a ceramic deposit projection to partially_paid and leaves other balances due', () => {
    const projection = {
      approvedCents: 65000,
      settledCents: 15000,
      remainingCents: 50000,
      refundedCents: 0,
      paymentStatus: 'due',
      quoteVersion: 1,
    };
    const ceramic = buildPaymentCompatibilityPatch({ serviceFamily: 'ceramic_coating' }, projection);
    assert.equal(ceramic.paymentStatus, 'partially_paid');
    assert.equal(ceramic.approvedFinalAmount, 650);
    assert.equal(ceramic.amountPaid, 150);
    assert.equal(ceramic.balanceDue, 500);
    const wash = buildPaymentCompatibilityPatch({ serviceFamily: '', paymentStatus: 'due' }, projection);
    assert.equal(wash.paymentStatus, 'due');
  });
});

describe('ceramic duration and capacity', () => {
  it('adds explicit minutes for the package and each add-on', () => {
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small')).minutes, 480);
    assert.equal(durationForVehicle(vehicle('ceramic_3yr', 'suv2')).minutes, 600);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'ceramic_windshield' }])).minutes, 510);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'ceramic_glass_all' }])).minutes, 540);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'ceramic_wheels' }])).minutes, 540);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'ceramic_trim' }])).minutes, 525);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'ceramic_lights' }])).minutes, 500);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'ceramic_correction' }])).minutes, 600);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'ceramic_waterspot' }])).minutes, 540);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'full_size_van_passenger', [{ id: 'ceramic_contamination' }])).minutes, 600);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'engine_bay' }])).minutes, 525);
    assert.equal(durationForVehicle(vehicle('ceramic_1yr', 'truck', [{ id: 'undercarriage' }])).minutes, 540);
    assert.equal(durationForVehicle(vehicle('wash', 'small')).minutes, 0);
  });

  it('holds consecutive slots and leaves short bookings on one slot', () => {
    const morning = spannedSlotTimes(WEEKDAY, '8:00 AM', 480);
    assert.deepEqual(morning.slots, ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM']);
    const late = spannedSlotTimes(WEEKDAY, '10:00 AM', 480);
    assert.equal(late.ok, false);
    assert.equal(late.error, 'ceramic_duration_exceeds_day');
    const saturday = spannedSlotTimes(SATURDAY, '8:00 AM', 600);
    assert.equal(saturday.ok, true);
    assert.equal(saturday.exceedsGrid, true);
    assert.deepEqual(saturday.slots, ['8:00 AM', '10:00 AM']);
    const wash = {
      id: 'wash-1',
      preferredDate: WEEKDAY,
      preferredTime: '8:00 AM',
      isDraft: false,
    };
    assert.equal(hasSlotConflict([wash], WEEKDAY, '10:00 AM'), false);
    const ceramic = {
      id: 'cer-1',
      preferredDate: WEEKDAY,
      preferredTime: '8:00 AM',
      appointmentDurationMinutes: 480,
      isDraft: false,
    };
    assert.equal(hasSlotConflict([ceramic], WEEKDAY, '2:00 PM'), true);
    assert.equal(hasSlotConflict([ceramic], WEEKDAY, '8:00 AM', 'cer-1'), false);
  });
});

describe('ceramic portals, receipts, and messages', () => {
  function captured() {
    const booking = pricedBooking('ceramic_1yr', 'suv2', [{ id: 'ceramic_lights' }], {}, {
      ceramicPaymentPlan: 'deposit',
      firstName: 'Ava',
      lastName: 'Stone',
      phone: '2015550100',
      email: 'ava@example.com',
      preferredDate: WEEKDAY,
      preferredTime: '8:00 AM',
      package: 'GYEON Q² CanCoat EVO',
    });
    const applied = applyCeramicBooking(booking, { finalize: true });
    assert.equal(applied.ok, true, applied.error);
    applyStripePaymentIntent(booking, {
      id: 'pi_portal',
      status: 'succeeded',
      amount_received: 20000,
      metadata: { purpose: 'ceramic_checkout', bookingId: booking.id },
    });
    return booking;
  }

  it('shows the same package, add-on, and balance in admin, garage, and receipt', () => {
    const booking = captured();
    assert.equal(booking.approvedFinalAmount, 800);
    const ops = projectQuickOpsBooking(booking);
    assert.equal(ops.ceramic.packageName, PUBLIC_PACKAGE_NAMES.ceramic_1yr);
    assert.equal(ops.ceramic.internal.coatingManufacturer, 'GYEON');
    assert.equal(ops.ceramic.internal.coatingProduct, 'Q² CanCoat EVO');
    assert.match(ops.ceramic.internal.staffDisclosure, /answer with the assigned manufacturer/);
    assert.equal(ops.ceramic.durationMonths, 12);
    assert.equal(ops.service.durationMinutes, 500);
    const customer = projectBookingForCustomer(booking);
    assert.equal(customer.serviceFamily, 'ceramic_coating');
    assert.equal(customer.depositAmount, 200);
    assert.equal(customer.balanceDue, 600);
    assert.equal(customer.paymentStatus, 'partially_paid');
    assert.equal(customer.ceramic.packageName, PUBLIC_PACKAGE_NAMES.ceramic_1yr);
    assert.equal(customer.ceramic.expectedDurability, 'up to 1 year');
    assert.equal(customer.ceramic.internal, undefined);
    assert.equal(customer.ceramic.product, undefined);
    assert.doesNotMatch(JSON.stringify(customer), /GYEON|CanCoat|Mohs/);
    assert.ok(customer.ceramic.curingInstructions.some((line) => /12 hours/.test(line)));
    const receipt = buildReceiptProjection(booking, 'payment');
    assert.equal(receipt.ok, true, receipt.error);
    assert.equal(receipt.receipt.financialSummary.approvedTotal.display, '$800.00');
    assert.equal(receipt.receipt.financialSummary.amountPaid.display, '$200.00');
    assert.equal(receipt.receipt.financialSummary.remainingBalance.display, '$600.00');
    assert.equal(receipt.receipt.ceramic.packageName, PUBLIC_PACKAGE_NAMES.ceramic_1yr);
    assert.equal(receipt.receipt.ceramic.coatingManufacturer, undefined);
    assert.doesNotMatch(JSON.stringify(receipt.receipt.ceramic), /GYEON|CanCoat|Mohs/);
    assert.equal(receipt.receipt.paidInFull, false);
  });

  it('itemizes ceramic totals in email and SMS', () => {
    const booking = captured();
    const email = buildEmailContent('booking.request_received', booking, 'https://cardetail1.com/my-garage.html');
    assert.match(email.text, /Professional Ceramic Protection — Up to 1 Year/);
    assert.match(email.text, /Expected durability: up to 1 year/);
    assert.doesNotMatch(email.text, /GYEON|CanCoat|Mohs/);
    assert.match(email.text, /Approved total: \$800\.00/);
    assert.match(email.text, /Amount paid: \$200\.00/);
    assert.match(email.text, /Remaining balance: \$600\.00/);
    assert.match(email.text, /Do not wash for 7 days/);
    assert.match(email.html, /does not repair damaged paint/);
    const sms = buildSmsBody('booking.request_received', booking, 'https://cardetail1.com/my-garage.html');
    assert.match(sms, /Professional Ceramic Protection — Up to 1 Year/);
    assert.doesNotMatch(sms, /GYEON|CanCoat|Mohs/);
    assert.match(sms, /Balance due \$600\.00/);
    assert.match(sms, /does not repair paint/);
  });

  it('does not offer ceramic packages on an ordinary wash mutation', () => {
    const wash = packageOptionsForVehicle({ cat: 'cars', pkgId: 'wash', tierKey: 'small' }, { zipCode: ZIP });
    assert.equal(wash.options.some((o) => o.id === 'ceramic_1yr'), false);
    const ceramic = packageOptionsForVehicle({ cat: 'cars', pkgId: 'ceramic_1yr', tierKey: 'small' }, { zipCode: ZIP });
    assert.deepEqual(ceramic.options.map((o) => o.id).sort(), ['ceramic_1yr', 'ceramic_3yr']);
    assert.equal(ceramic.options.find((o) => o.id === 'ceramic_1yr').name, PUBLIC_PACKAGE_NAMES.ceramic_1yr);
  });
});

describe('ceramic public names and internal coating assignment', () => {
  const CURE = [
    'Keep the vehicle dry for at least 12 hours.',
    'Do not wash for 7 days.',
    'Expected durability is up to the booked term and depends on maintenance.',
  ];

  function booked(pkgId) {
    const booking = pricedBooking(pkgId, 'small', [], {}, {
      ceramicPaymentPlan: 'prepay_full',
      package: 'GYEON Q² Mohs EVO',
    });
    const applied = applyCeramicBooking(booking, { finalize: true });
    assert.equal(applied.ok, true, applied.error);
    return booking;
  }

  it('keeps manufacturer names off the public package and checkout copy', () => {
    assert.equal(PUBLIC_PACKAGE_NAMES.ceramic_1yr, 'Professional Ceramic Protection — Up to 1 Year');
    assert.equal(PUBLIC_PACKAGE_NAMES.ceramic_3yr, 'Professional Ceramic Protection — Up to 3 Years');
    assert.equal(inferPkgId({ pkgName: PUBLIC_PACKAGE_NAMES.ceramic_1yr }, {}), 'ceramic_1yr');
    assert.equal(inferPkgId({ pkgName: PUBLIC_PACKAGE_NAMES.ceramic_3yr }, {}), 'ceramic_3yr');
    const booking = booked('ceramic_1yr');
    assert.equal(booking.package, PUBLIC_PACKAGE_NAMES.ceramic_1yr);
    assert.equal(booking.ceramic.internal.coatingManufacturer, 'GYEON');
    assert.equal(customerCeramicSummary(booking).coatingManufacturer, undefined);
    const pages = [
      'index.html',
      'bergen-county-hub.html',
      'connecticut-hub.html',
      'essex-county-hub.html',
      'hudson-county-hub.html',
      'new-jersey-hub.html',
      'newark-mobile-detailing.html',
      'ny-metro-hub.html',
      'passaic-county-hub.html',
      'pennsylvania-hub.html',
      'template-city.html',
      'trenton-mobile-detailing.html',
      'westchester-mobile-detailing.html',
      'assets/car-pkg-detail-modal.js',
      'assets/my-garage.js',
    ];
    for (const rel of pages) {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.doesNotMatch(text, /GYEON|CanCoat|Mohs|9H|scratch proof|permanent protection/i, rel);
      assert.match(text, /Professional Ceramic Protection — Up to 1 Year|ceramic\.packageName/);
    }
    const home = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.match(home, /Professional Ceramic Protection — Up to 3 Years/);
    assert.match(home, /hydrophobic/i);
  });

  it('prints the manufacturer on a receipt only when Admin selects disclosure', () => {
    const booking = booked('ceramic_3yr');
    applyStripePaymentIntent(booking, {
      id: 'pi_receipt_brand',
      status: 'succeeded',
      amount_received: Math.round(booking.approvedFinalAmount * 100),
      metadata: { purpose: 'ceramic_checkout', bookingId: booking.id },
    });
    const hidden = buildReceiptProjection(booking, 'payment');
    assert.equal(hidden.receipt.ceramic.packageName, PUBLIC_PACKAGE_NAMES.ceramic_3yr);
    assert.equal(hidden.receipt.ceramic.coatingManufacturer, undefined);
    const disclosed = assignInternalCoating(booking, {
      productId: 'gyeon_q2_mohs_evo',
      cureRequirements: CURE,
      discloseOnReceipt: true,
      installer: 'Riley',
    }, { role: 'admin', id: 'admin-1' });
    assert.equal(disclosed.ok, true, disclosed.error);
    const receipt = buildReceiptProjection(booking, 'payment');
    assert.equal(receipt.receipt.ceramic.coatingManufacturer, 'GYEON');
    assert.equal(receipt.receipt.ceramic.coatingProduct, 'Q² Mohs EVO');
    assert.equal(receipt.receipt.ceramic.packageName, PUBLIC_PACKAGE_NAMES.ceramic_3yr);
    assert.equal(customerCeramicSummary(booking).coatingManufacturer, undefined);
  });

  it('rejects a coating whose documented durability is below the sold term', () => {
    const booking = booked('ceramic_3yr');
    const denied = assignInternalCoating(booking, {
      productId: 'gyeon_q2_cancot_evo',
      cureRequirements: CURE,
    }, { role: 'admin', id: 'admin-1' });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'ceramic_product_durability_insufficient');
    assert.equal(booking.ceramic.internal.productId, 'gyeon_q2_mohs_evo');
    assert.equal(booking.ceramic.packageId, 'ceramic_3yr');
  });

  it('changes the internal coating without changing the public package', () => {
    const booking = booked('ceramic_1yr');
    const blocked = assignInternalCoating(booking, {
      productId: 'gyeon_q2_mohs_evo',
      cureRequirements: CURE,
    }, { role: 'quick_ops', id: 'ops-1' });
    assert.equal(blocked.error, 'ceramic_product_change_unauthorized');
    const brandedCure = assignInternalCoating(booking, {
      productId: 'gyeon_q2_mohs_evo',
      cureRequirements: ['GYEON cure: keep dry 12 hours.'],
    }, { role: 'admin', id: 'admin-1' });
    assert.equal(brandedCure.error, 'ceramic_cure_brand_leak');
    const changed = assignInternalCoating(booking, {
      productId: 'gyeon_q2_mohs_evo',
      cureRequirements: CURE,
      batchOrLotNumber: 'LOT-42',
      installer: 'Riley',
      internalNotes: 'Customer asked; answered with the assigned product.',
    }, { role: 'admin', id: 'admin-1' });
    assert.equal(changed.ok, true, changed.error);
    assert.equal(booking.ceramic.packageId, 'ceramic_1yr');
    assert.equal(booking.package, PUBLIC_PACKAGE_NAMES.ceramic_1yr);
    assert.equal(booking.ceramic.internal.coatingProduct, 'Q² Mohs EVO');
    assert.equal(booking.ceramic.internal.durabilityMonths, 36);
    assert.equal(booking.ceramic.internal.batchOrLotNumber, 'LOT-42');
    assert.deepEqual(booking.ceramic.curingInstructions, CURE);
    const audit = booking.ceramic.internal.auditHistory;
    assert.equal(audit.at(-1).action, 'internal_product_change');
    assert.equal(audit.at(-1).actorRole, 'admin');
    assert.equal(audit.at(-1).fromProductId, 'gyeon_q2_cancot_evo');
    assert.equal(audit.at(-1).packageId, 'ceramic_1yr');
    const missingCure = assignInternalCoating(booking, {
      productId: 'gyeon_q2_cancot_evo',
      cureRequirements: [],
    }, { role: 'admin', id: 'admin-1' });
    assert.equal(missingCure.error, 'ceramic_cure_required');
  });
});

describe('ceramic plus interior companion', () => {
  it('books ceramic without interior and keeps interior prices out of the ceramic catalog', () => {
    const booking = pricedBooking('ceramic_1yr', 'small');
    const applied = applyCeramicBooking(booking, { finalize: true });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(booking.companionInterior, false);
    assert.equal(booking.vehicles[0].serviceLineItems.length, 1);
    assert.equal(booking.vehicles[0].serviceLineItems[0].serviceId, 'ceramic_1yr');
    assert.equal(booking.approvedFinalAmount, 650);
    assert.equal(resolveCompanionInterior(vehicle('ceramic_1yr', 'small')).selected, false);
    const source = fs.readFileSync(path.join(__dirname, '../netlify/lib/ceramic-coating.js'), 'utf8');
    assert.doesNotMatch(source, /interior:\s*200/);
    assert.equal(booking.ceramic.inclusions.some((line) => /vacuum/i.test(line)), false);
  });

  it('adds Complete Interior Detail to the same vehicle at the canonical price', () => {
    const before = PRICING.cars.tiers.suv3.interior;
    PRICING.cars.tiers.suv3.interior = 255;
    const quoted = computeVehicleSubtotal(vehicle('ceramic_1yr', 'suv3', [], { companionInterior: true }), ZIP);
    assert.equal(quoted.companionInteriorPrice, PRICING.cars.tiers.suv3.interior);
    assert.equal(quoted.subtotal, 825 + 255);
    PRICING.cars.tiers.suv3.interior = 261;
    const changed = computeVehicleSubtotal(vehicle('ceramic_1yr', 'suv3', [], { companionInterior: true }), ZIP);
    assert.equal(changed.companionInteriorPrice, 261);
    assert.equal(changed.subtotal, 825 + 261);
    PRICING.cars.tiers.suv3.interior = before;
    const booking = pricedBooking('ceramic_1yr', 'small', [], { companionInterior: true });
    const applied = applyCeramicBooking(booking, { finalize: true });
    assert.equal(applied.ok, true, applied.error);
    const lines = booking.vehicles[0].serviceLineItems;
    assert.deepEqual(lines.map((line) => line.serviceId), ['ceramic_1yr', 'interior']);
    assert.equal(lines[1].name, 'Complete Interior Detail');
    assert.equal(lines[1].canonicalServiceId, 'interior');
    assert.equal(lines[1].price, 200);
    assert.equal(lines[1].alias, 'interior_detail');
    assert.equal(booking.approvedFinalAmount, 850);
    assert.equal(lines[0].financialAllocationCents + lines[1].financialAllocationCents, 85000);
    assert.match(booking.opsSequencingNote, /before final panel prep/);
    assert.equal(customerCeramicSummary(booking).sequencingNote, undefined);
  });

  it('shows interior add-ons only after interior is selected and keeps engine bay separate', () => {
    const early = computeVehicleSubtotal(vehicle('ceramic_1yr', 'small', [{ id: 'pethair' }]), ZIP);
    assert.equal(early.ok, false);
    assert.equal(early.error, 'interior_addon_requires_service');
    const wax = validateAddonSet(vehicle('ceramic_1yr', 'small', [{ id: 'wax1yr' }], { companionInterior: true }));
    assert.equal(wax.error, 'incompatible_addon');
    const dup = validateAddonSet(vehicle('ceramic_1yr', 'small', [{ id: 'interior' }], { companionInterior: true }));
    assert.equal(dup.error, 'duplicated_interior');
    const twice = validateAddonSet(vehicle('ceramic_1yr', 'small', [{ id: 'odor', qty: 2 }], { companionInterior: true }));
    assert.equal(twice.error, 'duplicated_interior_addon');
    const booking = pricedBooking('ceramic_1yr', 'small', [
      { id: 'pethair' },
      { id: 'engine_bay' },
    ], { companionInterior: true });
    const applied = applyCeramicBooking(booking, { finalize: true });
    assert.equal(applied.ok, true, applied.error);
    const lines = booking.vehicles[0].serviceLineItems;
    assert.deepEqual(lines[1].addonIds, ['pethair']);
    assert.deepEqual(lines[0].addonIds, ['engine_bay']);
    assert.equal(lines[1].addonIds.includes('engine_bay'), false);
    assert.equal(lines[1].price, PRICING.cars.tiers.small.interior);
    assert.equal(booking.approvedFinalAmount, 650 + 200 + 95 + 125);
  });

  it('sums ceramic, interior, and add-on duration and rejects a late or over-capacity start', () => {
    const minutes = durationForVehicle(vehicle('ceramic_1yr', 'small', [{ id: 'pethair' }, { id: 'engine_bay' }], { companionInterior: true }));
    assert.equal(minutes.minutes, 480 + 120 + 45 + 45);
    assert.equal(minutes.ceramicMinutes + minutes.interiorMinutes, minutes.minutes);
    const late = planCombinedAppointment(WEEKDAY, '10:00 AM', minutes.minutes);
    assert.equal(late.ok, false);
    assert.equal(late.error, 'ceramic_duration_exceeds_day');
    assert.match(late.message, /extended appointment/);
    assert.equal(late.nextValidStart.time, '8:00 AM');
    const planned = planCombinedAppointment(WEEKDAY, '8:00 AM', 600);
    assert.equal(planned.ok, true);
    assert.equal(planned.multiDay, true);
    assert.equal(planned.days[0].slots.length + planned.days[1].slots.length, 5);
    assert.equal(planned.days[1].date, '2026-10-06');
    const saturday = planCombinedAppointment(SATURDAY, '8:00 AM', 600);
    assert.equal(saturday.days[1].date, '2026-10-05');
    const booking = pricedBooking('ceramic_1yr', 'small', [], { companionInterior: true }, {
      preferredDate: WEEKDAY,
      preferredTime: '8:00 AM',
    });
    applyCeramicBooking(booking, { finalize: true });
    booking.appointmentSchedule = planned;
    assert.equal(hasSlotConflict([booking], WEEKDAY, '2:00 PM'), true);
    assert.equal(hasSlotConflict([booking], '2026-10-06', '8:00 AM'), true);
    assert.equal(hasSlotConflict([booking], '2026-10-06', '10:00 AM'), false);
    const occupied = {
      id: 'other',
      preferredDate: '2026-10-06',
      preferredTime: '8:00 AM',
      isDraft: false,
    };
    assert.equal(hasSlotConflict([occupied], '2026-10-06', '8:00 AM'), true);
  });

  it('charges the combined total in full and uses 25 percent with the package minimum for deposits', () => {
    assert.equal(depositCentsForApproved('ceramic_1yr', 825), 20625);
    assert.equal(depositCentsForApproved('ceramic_1yr', 1075), 26875);
    assert.equal(depositCentsForApproved('ceramic_3yr', 1275), 31875);
    assert.equal(depositCentsForApproved('ceramic_1yr', 400), 15000);
    const full = pricedBooking('ceramic_1yr', 'small', [], { companionInterior: true }, { ceramicPaymentPlan: 'prepay_full' });
    applyCeramicBooking(full, { finalize: true });
    assert.equal(chargeDueNow(full).chargeCents, 85000);
    const deposit = pricedBooking('ceramic_1yr', 'suv3', [], { companionInterior: true }, { ceramicPaymentPlan: 'deposit' });
    applyCeramicBooking(deposit, { finalize: true });
    assert.equal(deposit.approvedFinalAmount, 825 + 255);
    assert.equal(deposit.depositAmount, 270);
    assert.equal(chargeDueNow(deposit).chargeCents, 27000);
    assert.equal(deposit.approvedFinalAmount, deposit.depositAmount + (deposit.approvedFinalAmount - deposit.depositAmount));
  });

  it('keeps the same service lines and totals on the receipt, admin, and My Garage', () => {
    const booking = pricedBooking('ceramic_1yr', 'small', [{ id: 'pethair' }], { companionInterior: true }, {
      ceramicPaymentPlan: 'prepay_full',
      firstName: 'Ava',
      lastName: 'Stone',
      phone: '2015550100',
      email: 'ava@example.com',
    });
    applyCeramicBooking(booking, { finalize: true });
    applyStripePaymentIntent(booking, {
      id: 'pi_combo',
      status: 'succeeded',
      amount_received: 94500,
      metadata: { purpose: 'ceramic_checkout', bookingId: booking.id },
    });
    const ids = (rows) => (rows || []).map((line) => line.serviceId).join(',');
    const ops = projectQuickOpsBooking(booking);
    const customer = projectBookingForCustomer(booking);
    const receipt = buildReceiptProjection(booking, 'payment');
    assert.equal(receipt.ok, true, receipt.error);
    assert.equal(ids(ops.ceramic.serviceLineItems), 'ceramic_1yr,interior');
    assert.equal(ids(customer.ceramic.serviceLineItems), ids(ops.ceramic.serviceLineItems));
    assert.equal(ids(receipt.receipt.ceramic.serviceLineItems), ids(customer.ceramic.serviceLineItems));
    assert.equal(customer.vehicles[0].serviceLineItems[1].name, 'Complete Interior Detail');
    assert.equal(customer.approvedFinalAmount, 945);
    assert.equal(ops.money.approvedLabel, '$945');
    assert.equal(receipt.receipt.financialSummary.approvedTotal.display, '$945.00');
    assert.equal(receipt.receipt.financialSummary.amountPaid.display, '$945.00');
    assert.equal(receipt.receipt.financialSummary.remainingBalance.display, '$0.00');
    const evidence = conversionEvidence(booking);
    assert.equal(evidence.paymentSucceeded, true);
    assert.equal(evidence.approvedFinalAmount, 945);
    const unpaid = pricedBooking('ceramic_1yr', 'small', [], { companionInterior: true });
    applyCeramicBooking(unpaid, { finalize: true });
    assert.equal(unpaid.paymentStatus, 'unpaid');
    const done = completeServiceLine(unpaid, 'interior', { role: 'admin', id: 'admin-1' });
    assert.equal(done.ok, true);
    assert.equal(unpaid.paymentStatus, 'unpaid');
    assert.equal(unpaid.amountPaid, 0);
    assert.equal(unpaid.vehicles[0].serviceLineItems.find((line) => line.serviceId === 'interior').completionStatus, 'completed');
    assert.equal(unpaid.vehicles[0].serviceLineItems.find((line) => line.serviceId === 'ceramic_1yr').completionStatus, 'pending');
  });
});
