/**
 * Smoke + simulated e2e: customer change → admin approve → customer projection/pay sync.
 * Covers cars, boats (length), RVs (length), add-ons, pay-link reuse conflicts.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  applyApprovedMoney,
  applyPayLinkMoney,
  canReusePayLink,
  computeDue,
  detectMoneyConflict,
} = require('../netlify/lib/portal-money-sync');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const { getLengthPrice, usesLengthPricing, packagesForCategory } = require('../netlify/lib/length-pricing');
const { catalogForClient, CAR_PACKAGES, ADDONS, resolveAddonsByIds, addonTotal } = require('../netlify/lib/customer-catalog');
const { canRequestChange, canPayBalance } = require('../netlify/lib/appointment-status-policy');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function baseBooking(overrides = {}) {
  return {
    id: 'CD1-SMOKE-001',
    isDraft: false,
    status: 'Pending Review',
    jobStatus: 'pending_review',
    package: 'Premium Detail',
    packageId: 'full',
    vehicleCategory: 'cars',
    vehicleLabel: '2022 Toyota Camry',
    totalPrice: 310,
    approvedFinalAmount: 310,
    amountDueApproved: 310,
    amountPaid: 0,
    travelFeeAmount: 10,
    addons: [],
    payLink: 'https://checkout.stripe.com/old-stale',
    payLinkAmount: 310,
    phone: '5513132956',
    ...overrides,
  };
}

/** Simulate admin approve package/addon money apply (mirrors admin-customer-requests). */
function simulateAdminApproveMoney(booking, proposedTotal, fieldPatch = {}) {
  return {
    ...booking,
    ...fieldPatch,
    ...applyApprovedMoney(booking, proposedTotal),
    customerChangePending: false,
  };
}

describe('portal money sync — conflict detection', () => {
  it('flags stale pay link when amount changes but link remains', () => {
    const before = baseBooking();
    const afterApprove = {
      ...before,
      approvedFinalAmount: 405,
      totalPrice: 405,
      amountDueApproved: 405,
      // BUG pattern: forgot to clear payLink
    };
    const conflict = detectMoneyConflict(afterApprove);
    assert.equal(conflict.ok, false);
    assert.ok(conflict.conflicts.some((c) => c.code === 'stale_pay_link_amount'));
  });

  it('applyApprovedMoney clears pay link and keeps due = approved − paid', () => {
    const booking = baseBooking({ amountPaid: 50, payLink: 'https://checkout.stripe.com/x', payLinkAmount: 310 });
    const patch = applyApprovedMoney(booking, 405);
    const next = { ...booking, ...patch };
    assert.equal(next.approvedFinalAmount, 405);
    assert.equal(next.totalPrice, 405);
    assert.equal(next.amountDueApproved, 355);
    assert.equal(next.payLink, '');
    assert.equal(next.payLinkAmount, null);
    assert.equal(detectMoneyConflict(next).ok, true);
  });

  it('canReusePayLink only when payLinkAmount matches due', () => {
    const booking = baseBooking({ payLink: 'https://x', payLinkAmount: 310, amountDueApproved: 310 });
    assert.equal(canReusePayLink(booking, 310), true);
    assert.equal(canReusePayLink(booking, 405), false);
    assert.equal(canReusePayLink({ ...booking, payLinkAmount: null }, 310), false);
  });
});

describe('e2e simulate: customer package change → admin approve → customer panel', () => {
  const { quoteService, canonicalAddonPrice } = require('../netlify/lib/canonical-quote');

  it('cars: approved total and due appear on customer projection (canonical quote)', () => {
    // Release A: approvable amount from booking-price-catalog, not customer-catalog fixed $450
    const booking = baseBooking({
      travelFeeAmount: 10,
      vehicles: [{
        vehicleId: 'veh_1',
        cat: 'cars',
        tierKey: 'suv3',
        tierLabel: 'SUV 3-Row',
        pkgId: 'full',
        addons: [],
      }],
      zipCode: '07102',
    });
    const pack = CAR_PACKAGES.find((p) => p.id === 'premium');
    const quoted = quoteService({
      zip: '07102',
      vehicles: [{
        vehicleId: 'veh_1',
        category: 'cars',
        tier: 'suv3',
        tierLabel: 'SUV 3-Row',
        packageId: 'premium',
        pkgId: 'premium',
        addons: [],
      }],
    }, { travelCents: 1000, basedOnBookingVersion: 1 });
    assert.equal(quoted.ok, true);
    // SUV3 Premium $540 + $10 travel
    assert.equal(quoted.quote.approvedCents, 55000);
    const proposedTotal = quoted.approvedDollars;

    const after = simulateAdminApproveMoney(booking, proposedTotal, {
      package: pack.name,
      service: pack.name,
      packageId: pack.id,
      packageDescription: pack.description,
      ledger: {
        approvedCents: quoted.quote.approvedCents,
        settledCents: 0,
        creditedCents: 0,
      },
    });

    const projected = projectBookingForCustomer(after);
    assert.equal(projected.package, 'Signature Interior & Exterior Restoration');
    assert.equal(projected.approvedFinalAmount, 550);
    assert.equal(projected.totalPrice, 550);
    assert.equal(projected.amountDueApproved, 550);
    assert.equal(projected.payLink, '');
    assert.equal(projected.customerChangePending, false);

    const pay = canPayBalance(after);
    assert.equal(pay.ok, true);
    assert.equal(computeDue(after), 550);
    assert.equal(detectMoneyConflict(after).ok, true);
  });

  it('cars: Stripe mint syncs approvedFinalAmount with due (no UI/Stripe split)', () => {
    const afterApprove = simulateAdminApproveMoney(baseBooking(), 645, {
      package: 'Signature Interior & Exterior Restoration',
      packageId: 'premium',
      ledger: { approvedCents: 64500, settledCents: 0, creditedCents: 0 },
    });
    const withPay = {
      ...afterApprove,
      ...applyPayLinkMoney(afterApprove, computeDue(afterApprove), 'https://checkout.stripe.com/new', 'cs_test'),
    };
    const projected = projectBookingForCustomer(withPay);
    assert.equal(projected.approvedFinalAmount, 645);
    assert.equal(projected.amountDueApproved, 645);
    assert.equal(withPay.payLinkAmount, 645);
    assert.equal(canReusePayLink(withPay, 645), true);
    assert.equal(detectMoneyConflict(withPay).ok, true);
  });

  it('addon request: merge + proposed total uses canonical Odor $90 (not portal $149)', () => {
    assert.equal(canonicalAddonPrice('cars', 'odor'), 90);
    assert.equal(canonicalAddonPrice('cars', 'pethair'), 95);
    // Labels may still come from customer-catalog; money must not.
    const portalOdor = ADDONS.find((a) => a.id === 'odor');
    assert.ok(portalOdor.price !== 90, 'portal catalog remains non-authoritative for odor');

    const booking = baseBooking({
      approvedFinalAmount: 270,
      amountDueApproved: 270,
      travelFeeAmount: 0,
      zipCode: '07102',
      vehicles: [{
        vehicleId: 'veh_1',
        cat: 'cars',
        tierKey: 'suv3',
        tierLabel: 'SUV 3-Row',
        pkgId: 'full',
        addons: [],
      }],
    });
    const quoted = quoteService({
      zip: '07102',
      vehicles: [{
        vehicleId: 'veh_1',
        category: 'cars',
        tier: 'suv3',
        packageId: 'full',
        pkgId: 'full',
        addOnIds: ['pethair', 'odor'],
        addons: [{ id: 'pethair' }, { id: 'odor' }],
      }],
    });
    assert.equal(quoted.ok, true);
    // SUV3 Full $270 + pet $95 + odor $90 = $455
    assert.equal(quoted.quote.approvedCents, 45500);
    const proposedTotal = quoted.approvedDollars;
    const selected = resolveAddonsByIds(['pethair', 'odor']).map((a) => ({
      ...a,
      price: canonicalAddonPrice('cars', a.id),
    }));

    const after = simulateAdminApproveMoney(booking, proposedTotal, {
      addons: selected,
      ledger: { approvedCents: quoted.quote.approvedCents, settledCents: 0, creditedCents: 0 },
    });
    const projected = projectBookingForCustomer(after);
    assert.equal(projected.addons.length, 2);
    assert.equal(projected.approvedFinalAmount, 455);
    assert.equal(projected.amountDueApproved, 455);
    assert.equal(projected.payLink, '');
  });
});

describe('e2e simulate: boats & RVs length pricing modes', () => {
  it('boats require length and price from ruler', () => {
    assert.equal(usesLengthPricing('boats'), true);
    const price22 = getLengthPrice('boats', 'full', 22);
    const price40 = getLengthPrice('boats', 'full', 40);
    assert.ok(price22 >= 380);
    assert.ok(price40 > price22);
    assert.ok(packagesForCategory('boats').some((p) => p.id === 'premium'));
  });

  it('rvs price scales with length', () => {
    const p20 = getLengthPrice('rvs', 'full_basic', 20);
    const p35 = getLengthPrice('rvs', 'full_basic', 35);
    assert.ok(p20 > 0);
    assert.ok(p35 > p20);
  });

  it('boat package change → admin approve updates customer totals with length', () => {
    const booking = baseBooking({
      vehicleCategory: 'boats',
      vehicleLabel: 'Sea Ray SPX 210',
      vehicleLengthFt: 22,
      package: 'Marine Wash',
      packageId: 'maint',
      approvedFinalAmount: 264,
      totalPrice: 264,
      amountDueApproved: 264,
      travelFeeAmount: 0,
    });
    const packPrice = getLengthPrice('boats', 'full', 28);
    const proposedTotal = packPrice;
    const after = simulateAdminApproveMoney(booking, proposedTotal, {
      package: 'Full Marine Detail',
      packageId: 'full',
      vehicleLengthFt: 28,
      vehicleCategory: 'boats',
    });
    const projected = projectBookingForCustomer(after);
    assert.equal(projected.package, 'Full Marine Detail');
    assert.equal(projected.vehicleLengthFt, 28);
    assert.equal(projected.approvedFinalAmount, proposedTotal);
    assert.equal(projected.amountDueApproved, proposedTotal);
    assert.equal(detectMoneyConflict(after).ok, true);
  });

  it('rv package change without length is invalid for portal submit contract', () => {
    // Mirrors submit-customer-action validation intent
    const vehicleCategory = 'rvs';
    const lengthFt = 0;
    const invalid = usesLengthPricing(vehicleCategory) && !(lengthFt > 0);
    assert.equal(invalid, true);
  });
});

describe('policy modes: pending review / confirmed / pay', () => {
  it('pending review package change auto-applies (no admin gate)', () => {
    const r = canRequestChange(baseBooking(), 'package_change');
    assert.equal(r.ok, true);
    assert.equal(r.pendingApproval, false);
  });

  it('confirmed can pay when due > 0', () => {
    const b = baseBooking({ status: 'Confirmed', jobStatus: 'confirmed', amountDueApproved: 310 });
    assert.equal(canPayBalance(b).ok, true);
  });

  it('drafts blocked from customer portal visibility contract', () => {
    const src = read('netlify/functions/customer-portal-data.js');
    // Release A: centralized visibility gate (isDraft handled inside booking-visibility)
    assert.match(src, /isVisibleSubmittedBooking|isVisibleCustomerBooking/);
    assert.match(src, /booking_not_ready/);
  });
});

describe('catalog smoke: all category modes exposed to client', () => {
  it('catalogForClient includes cars/boats/rvs packages and length rulers', () => {
    const cat = catalogForClient();
    assert.ok(cat.packagesByCategory.cars.length >= 4);
    assert.ok(cat.packagesByCategory.boats.length >= 4);
    assert.ok(cat.packagesByCategory.rvs.length >= 4);
    assert.equal(cat.lengthPricing.boats.min, 12);
    assert.equal(cat.lengthPricing.rvs.max, 45);
    assert.ok(cat.lengthPackageRules.boats.full);
    assert.ok(cat.lengthPackageRules.rvs.full_basic);
  });
});

describe('source smoke: admin approve + customer UI wiring', () => {
  it('admin approve uses canonical decideChangeRequestCommand', () => {
    // Release A: booking-commands is authority; request index is rebuildable
    const src = read('netlify/functions/admin-customer-requests.js');
    assert.match(src, /decideChangeRequestCommand/);
    assert.match(src, /listAllBlobs/);
    assert.doesNotMatch(src, /\.slice\(0,\s*200\)/);
  });

  it('customer balance uses embedded authoritative PaymentIntent service', () => {
    const src = read('netlify/functions/customer-balance-payment-intent.js');
    assert.match(src, /prepareEmbeddedPayment/);
    assert.match(src, /authorizeBookingAccess/);
    assert.doesNotMatch(src, /checkout\.stripe\.com|prepareBalanceCheckout/);
    assert.match(read('netlify/functions/customer-portal-pay.js'), /legacy_checkout_disabled/);
  });

  it('admin stripe generate syncs via applyPayLinkMoney and getBooking', () => {
    const src = read('netlify/functions/admin-ops-jobs.js');
    assert.match(src, /applyPayLinkMoney/);
    assert.match(src, /getBooking\(bookingId\)/);
    assert.match(src, /amount_override_rejected/);
  });

  it('my-garage has length ruler and always pays through embedded Payment Element', () => {
    const js = read('assets/my-garage.js');
    assert.match(js, /lengthRulerHtml|mf-length-range/);
    assert.match(js, /packagesByCategory|packagesForBooking/);
    assert.match(js, /customer-balance-payment-intent/);
    assert.match(js, /confirmPayment/);
    assert.doesNotMatch(js, /customer-portal-pay/);
    // Must not short-circuit to stale payLink before server validation
    assert.doesNotMatch(js, /if \(pay\.payLink && pay\.canPay\) \{\s*\n\s*if \(global\.cd1PortalAnalytics\) global\.cd1PortalAnalytics\.paymentOpened\(\);\s*\n\s*global\.location\.href = pay\.payLink/);
  });

  it('submit-customer-action prices via booking-commands / canonical quote', () => {
    // Release A: approvable totals from booking-commands → canonical-quote
    const src = read('netlify/functions/submit-customer-action.js');
    assert.match(src, /booking-commands/);
    assert.match(src, /submitChangeRequestCommand/);
    assert.match(src, /lengthFt/);
    assert.match(src, /Enter vessel \/ RV length/);
    assert.doesNotMatch(src, /await store\.setJSON\(bookingId,/);
  });
});

describe('regression: UI approved total vs due after admin regenerate pattern', () => {
  it('old bug: amountDue updated but approvedFinalAmount stale is a conflict', () => {
    const booking = baseBooking({
      approvedFinalAmount: 310, // stale UI "Approved total"
      amountDueApproved: 460,   // new Stripe amount
      payLink: 'https://checkout.stripe.com/new',
      payLinkAmount: 460,
    });
    const conflict = detectMoneyConflict(booking);
    assert.equal(conflict.ok, false);
    // Release A derives due from approved−paid, so stale stored due / pay link are flagged
    assert.ok(
      conflict.conflicts.some((c) =>
        c.code === 'due_mismatch_approved_minus_paid'
        || c.code === 'stale_stored_due'
        || c.code === 'stale_pay_link_amount'
      )
    );
  });

  it('fixed path: applyPayLinkMoney keeps approved and due aligned', () => {
    const booking = baseBooking({ approvedFinalAmount: 310, amountDueApproved: 310, payLink: '', payLinkAmount: null });
    const fixed = { ...booking, ...applyPayLinkMoney(booking, 460, 'https://checkout.stripe.com/new', 'cs') };
    // approved becomes max(old approved, due+paid) = 460
    assert.equal(fixed.approvedFinalAmount, 460);
    assert.equal(fixed.amountDueApproved, 460);
    assert.equal(detectMoneyConflict(fixed).ok, true);
    const projected = projectBookingForCustomer(fixed);
    assert.equal(projected.approvedFinalAmount, projected.amountDueApproved);
  });
});
