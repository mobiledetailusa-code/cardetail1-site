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
  it('cars: approved total and due appear on customer projection', () => {
    const booking = baseBooking();
    const pack = CAR_PACKAGES.find((p) => p.id === 'premium');
    const travel = Number(booking.travelFeeAmount || 0);
    const proposedTotal = Math.round((pack.basePrice + travel) * 100) / 100;

    // Customer request state
    const requestedState = {
      packageId: pack.id,
      packageName: pack.name,
      packagePrice: pack.basePrice,
      packageDescription: pack.description,
      proposedTotal,
    };
    assert.equal(requestedState.proposedTotal, 460);

    // Admin approve
    const after = simulateAdminApproveMoney(booking, proposedTotal, {
      package: pack.name,
      service: pack.name,
      packageId: pack.id,
      packageDescription: pack.description,
    });

    const projected = projectBookingForCustomer(after);
    assert.equal(projected.package, 'Signature Interior & Exterior Restoration');
    assert.equal(projected.approvedFinalAmount, 460);
    assert.equal(projected.totalPrice, 460);
    assert.equal(projected.amountDueApproved, 460);
    assert.equal(projected.payLink, '');
    assert.equal(projected.customerChangePending, false);

    const pay = canPayBalance(after);
    assert.equal(pay.ok, true);
    assert.equal(computeDue(after), 460);
    assert.equal(detectMoneyConflict(after).ok, true);
  });

  it('cars: Stripe mint syncs approvedFinalAmount with due (no UI/Stripe split)', () => {
    const afterApprove = simulateAdminApproveMoney(baseBooking(), 460, {
      package: 'Signature Interior & Exterior Restoration',
      packageId: 'premium',
    });
    // Customer opens pay → new session
    const withPay = {
      ...afterApprove,
      ...applyPayLinkMoney(afterApprove, computeDue(afterApprove), 'https://checkout.stripe.com/new', 'cs_test'),
    };
    const projected = projectBookingForCustomer(withPay);
    assert.equal(projected.approvedFinalAmount, 460);
    assert.equal(projected.amountDueApproved, 460);
    assert.equal(withPay.payLinkAmount, 460);
    assert.equal(canReusePayLink(withPay, 460), true);
    assert.equal(detectMoneyConflict(withPay).ok, true);
  });

  it('addon request: merge + proposed total applied to customer panel', () => {
    const booking = baseBooking({ approvedFinalAmount: 310, amountDueApproved: 310 });
    const selected = resolveAddonsByIds(['pethair', 'odor']);
    const addOnSum = addonTotal(selected);
    const proposedTotal = Math.round((310 + addOnSum) * 100) / 100;
    assert.equal(proposedTotal, 554);

    const after = simulateAdminApproveMoney(booking, proposedTotal, {
      addons: selected,
    });
    const projected = projectBookingForCustomer(after);
    assert.equal(projected.addons.length, 2);
    assert.equal(projected.approvedFinalAmount, 554);
    assert.equal(projected.amountDueApproved, 554);
    assert.equal(projected.payLink, '');
  });
});

describe('e2e simulate: boats & RVs length pricing modes', () => {
  it('boats require length and price from ruler', () => {
    assert.equal(usesLengthPricing('boats'), true);
    const price22 = getLengthPrice('boats', 'full', 22);
    const price40 = getLengthPrice('boats', 'full', 40);
    assert.ok(price22 >= 449);
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
  it('pending review can request package change with approval', () => {
    const r = canRequestChange(baseBooking(), 'package_change');
    assert.equal(r.ok, true);
    assert.equal(r.pendingApproval, true);
  });

  it('confirmed can pay when due > 0', () => {
    const b = baseBooking({ status: 'Confirmed', jobStatus: 'confirmed', amountDueApproved: 310 });
    assert.equal(canPayBalance(b).ok, true);
  });

  it('drafts blocked from customer portal visibility contract', () => {
    const src = read('netlify/functions/customer-portal-data.js');
    assert.match(src, /isDraft/);
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
  it('admin approve uses applyApprovedMoney', () => {
    const src = read('netlify/functions/admin-customer-requests.js');
    assert.match(src, /applyApprovedMoney/);
    assert.match(src, /Approved — your appointment details and totals were updated/);
  });

  it('customer-portal-pay uses canReusePayLink / payLinkAmount', () => {
    const src = read('netlify/functions/customer-portal-pay.js');
    assert.match(src, /canReusePayLink/);
    assert.match(src, /applyPayLinkMoney/);
    assert.doesNotMatch(src, /Number\(booking\.amountDueApproved\) === due/);
  });

  it('admin stripe generate syncs approvedFinalAmount via applyPayLinkMoney', () => {
    const src = read('netlify/functions/admin-ops-jobs.js');
    assert.match(src, /applyPayLinkMoney/);
    assert.match(src, /getBooking\(bookingId\)/);
  });

  it('my-garage has length ruler and always pays via customer-portal-pay', () => {
    const js = read('assets/my-garage.js');
    assert.match(js, /lengthRulerHtml|mf-length-range/);
    assert.match(js, /packagesByCategory|packagesForBooking/);
    assert.match(js, /customer-portal-pay/);
    // Must not short-circuit to stale payLink before server validation
    assert.doesNotMatch(js, /if \(pay\.payLink && pay\.canPay\) \{\s*\n\s*if \(global\.cd1PortalAnalytics\) global\.cd1PortalAnalytics\.paymentOpened\(\);\s*\n\s*global\.location\.href = pay\.payLink/);
  });

  it('submit-customer-action prices boats/rvs by length', () => {
    const src = read('netlify/functions/submit-customer-action.js');
    assert.match(src, /getLengthPrice/);
    assert.match(src, /lengthFt/);
    assert.match(src, /Enter vessel \/ RV length/);
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
    assert.ok(conflict.conflicts.some((c) => c.code === 'due_mismatch_approved_minus_paid'));
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
