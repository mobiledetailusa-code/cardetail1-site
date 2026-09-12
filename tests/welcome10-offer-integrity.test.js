'use strict';

/**
 * WELCOME10 offer integrity — submit fail-closed + one-time redemption.
 * Fixture: $200 eligible service + $25 travel → discount $20 → approved $205.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const revenueStore = require('../netlify/lib/revenue-store');
const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
const { saveWelcomeLeadCapture } = require('../netlify/lib/welcome-lead-store');
const {
  evaluateBookingOfferPreview,
  applyServerOffersToBooking,
  stripClientOfferFields,
  CLIENT_OFFER_BLOCKED_FIELDS,
} = require('../netlify/lib/booking-offers');
const {
  claimWelcomeOfferRedemption,
  findWelcomeOfferRedemption,
  redemptionKey,
} = require('../netlify/lib/welcome-offer-redemption');
const { buildReceiptProjection } = require('../netlify/lib/receipt-projection');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const bookingHistory = require('../netlify/lib/booking-history');

function createMemoryStores() {
  const stores = new Map();
  return async function getRevenueStore(name) {
    if (!stores.has(name)) {
      const data = new Map();
      stores.set(name, {
        data,
        async get(key, { type } = {}) {
          if (!data.has(key)) return null;
          const raw = data.get(key);
          return type === 'json' ? JSON.parse(raw) : raw;
        },
        async set(key, value, opts = {}) {
          if (opts.onlyIfNew && data.has(key)) return { modified: false };
          data.set(key, value);
          return { modified: true, etag: `e${data.size}` };
        },
        async list() {
          return Array.from(data.keys()).map((key) => ({ key }));
        },
      });
    }
    return stores.get(name);
  };
}

function emptyOpsStore(records = []) {
  const map = new Map(records.map((b) => [b.id, b]));
  return {
    async list() {
      return { blobs: Array.from(map.keys()).map((key) => ({ key })) };
    },
    async get(key, { type } = {}) {
      if (!map.has(key)) return null;
      const raw = map.get(key);
      return type === 'json' ? raw : JSON.stringify(raw);
    },
  };
}

function fixtureBooking(overrides = {}) {
  return {
    id: 'CD1-W10-205',
    firstName: 'Pat',
    lastName: 'Customer',
    email: 'welcome205@example.com',
    phone: '2015550205',
    zipCode: '07650',
    vehicleCategory: 'cars',
    packageId: 'full',
    package: 'Premium Full Detail',
    vehicles: [{
      cat: 'cars',
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      basePrice: 180,
      addonTotal: 20,
      addons: [{ id: 'rainx', name: 'Rain-X', price: 20 }],
      subtotal: 200,
    }],
    travelFeeAmount: 25,
    ...overrides,
  };
}

describe('WELCOME10 offer integrity', () => {
  let prevGetStore;
  let prevHistory;
  const EMAIL = 'welcome205@example.com';

  beforeEach(() => {
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
    prevGetStore = revenueStore.getRevenueStore;
    revenueStore.getRevenueStore = createMemoryStores();
    setOpsStoreOverride(emptyOpsStore());
    prevHistory = bookingHistory.listBookingHistoryForOfferEligibility;
  });

  afterEach(() => {
    revenueStore.getRevenueStore = prevGetStore;
    setOpsStoreOverride(null);
    bookingHistory.listBookingHistoryForOfferEligibility = prevHistory;
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  });

  it('1. first-time entitlement applies ($200 → $20)', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const booking = fixtureBooking();
    const preview = await evaluateBookingOfferPreview(booking);
    assert.equal(preview.ok, true);
    assert.equal(preview.offer.eligibility_status, 'eligible');
    assert.equal(preview.offer.discount_amount, 2000);
    const applied = await applyServerOffersToBooking(booking, {
      serviceSubtotal: 200,
      travelFee: 25,
      claimRedemption: true,
      redemptionBookingId: booking.id,
    });
    assert.equal(applied.discountDollars, 20);
    assert.equal(applied.totalPrice, 205);
    assert.equal(booking.approvedFinalAmount, 205);
    assert.equal(booking.offer.redemption_status, 'applied');
  });

  it('2. Review → submit amount parity ($205)', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const booking = fixtureBooking();
    const preview = await evaluateBookingOfferPreview(booking);
    const reviewTotal = Math.round(
      (200 + 25 - (preview.offer.discount_amount || 0) / 100) * 100
    ) / 100;
    assert.equal(reviewTotal, 205);
    await applyServerOffersToBooking(booking, {
      serviceSubtotal: 200,
      travelFee: 25,
      claimRedemption: true,
      redemptionBookingId: booking.id,
    });
    assert.equal(booking.approvedFinalAmount, reviewTotal);
  });

  it('3. offer evaluation failure does not leave a full-price apply result', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    bookingHistory.listBookingHistoryForOfferEligibility = async () => ({
      ok: false,
      error: 'offer_history_unavailable',
    });
    const booking = fixtureBooking({
      discountAmount: 0,
      approvedFinalAmount: 225,
      totalPrice: 225,
    });
    await assert.rejects(
      () => applyServerOffersToBooking(booking, {
        serviceSubtotal: 200,
        travelFee: 25,
        claimRedemption: true,
        redemptionBookingId: booking.id,
      }),
      (err) => err && err.code === 'offer_redemption_lookup_unavailable'
    );
    // Client-forged totals must not become the applied authority after failure.
    assert.notEqual(booking.approvedFinalAmount, 225);
  });

  it('4. retry after transient history failure succeeds at $205', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    let calls = 0;
    bookingHistory.listBookingHistoryForOfferEligibility = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, error: 'offer_history_unavailable' };
      return { ok: true, bookings: [], source: 'blobs' };
    };
    const booking = fixtureBooking();
    await assert.rejects(
      () => applyServerOffersToBooking(booking, {
        serviceSubtotal: 200,
        travelFee: 25,
        claimRedemption: true,
        redemptionBookingId: booking.id,
      }),
      (err) => err && err.code === 'offer_redemption_lookup_unavailable'
    );
    const claimed = await findWelcomeOfferRedemption(EMAIL);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.record, null);

    const booking2 = fixtureBooking();
    await applyServerOffersToBooking(booking2, {
      serviceSubtotal: 200,
      travelFee: 25,
      claimRedemption: true,
      redemptionBookingId: booking2.id,
    });
    assert.equal(booking2.approvedFinalAmount, 205);
  });

  it('5. prior redemption blocks reuse', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const first = fixtureBooking({ id: 'CD1-W10-A' });
    await applyServerOffersToBooking(first, {
      serviceSubtotal: 200,
      travelFee: 25,
      claimRedemption: true,
      redemptionBookingId: first.id,
    });
    assert.equal(first.approvedFinalAmount, 205);

    const second = fixtureBooking({ id: 'CD1-W10-B' });
    const preview = await evaluateBookingOfferPreview(second);
    assert.equal(preview.offer.eligibility_status, 'ineligible');
    assert.equal(preview.offer.eligibility_reason, 'prior_redemption');
    await applyServerOffersToBooking(second, {
      serviceSubtotal: 200,
      travelFee: 25,
      claimRedemption: false,
    });
    assert.equal(second.discountAmount, 0);
    assert.equal(second.approvedFinalAmount, 225);
  });

  it('6. redemption-history lookup failure does not grant discount', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    bookingHistory.listBookingHistoryForOfferEligibility = async () => ({
      ok: false,
      error: 'offer_history_unavailable',
    });
    const preview = await evaluateBookingOfferPreview(fixtureBooking());
    assert.equal(preview.ok, false);
    assert.equal(preview.error, 'offer_redemption_lookup_unavailable');
    assert.notEqual(preview.offer.eligibility_status, 'eligible');
  });

  it('7. concurrent claim allows only one redemption', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const a = await claimWelcomeOfferRedemption({ email: EMAIL, bookingId: 'CD1-A' });
    const b = await claimWelcomeOfferRedemption({ email: EMAIL, bookingId: 'CD1-B' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.error, 'offer_already_redeemed');
    const again = await claimWelcomeOfferRedemption({ email: EMAIL, bookingId: 'CD1-A' });
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
  });

  it('8. uncaptured / wrong email is ineligible', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const preview = await evaluateBookingOfferPreview(fixtureBooking({
      email: 'other@example.com',
    }));
    assert.equal(preview.offer.eligibility_status, 'ineligible');
    assert.equal(preview.offer.eligibility_reason, 'offer_disabled');
  });

  it('9. client-forged discount is stripped', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const booking = fixtureBooking({
      discountAmount: 99,
      approvedFinalAmount: 1,
      offer: { discount_amount: 9999, eligibility_status: 'eligible' },
    });
    assert.ok(CLIENT_OFFER_BLOCKED_FIELDS.includes('discountAmount'));
    stripClientOfferFields(booking);
    assert.equal(booking.discountAmount, undefined);
    assert.equal(booking.offer, undefined);
    await applyServerOffersToBooking(booking, {
      serviceSubtotal: 200,
      travelFee: 25,
      claimRedemption: true,
      redemptionBookingId: booking.id,
    });
    assert.equal(booking.discountAmount, 20);
    assert.equal(booking.approvedFinalAmount, 205);
  });

  it('10. $500 eligible subtotal caps at $40', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const booking = fixtureBooking({
      vehicles: [{ cat: 'cars', pkgId: 'full', subtotal: 500 }],
      travelFeeAmount: 0,
    });
    const preview = await evaluateBookingOfferPreview(booking);
    assert.equal(preview.offer.discount_amount, 4000);
    await applyServerOffersToBooking(booking, {
      serviceSubtotal: 500,
      travelFee: 0,
      claimRedemption: true,
      redemptionBookingId: booking.id,
    });
    assert.equal(booking.discountAmount, 40);
    assert.equal(booking.approvedFinalAmount, 460);
  });

  it('11. travel remains undiscounted ($200 + $25 → $205)', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const booking = fixtureBooking();
    await applyServerOffersToBooking(booking, {
      serviceSubtotal: 200,
      travelFee: 25,
      claimRedemption: true,
      redemptionBookingId: booking.id,
    });
    assert.equal(booking.serviceSubtotal, 200);
    assert.equal(booking.travelFeeAmount, 25);
    assert.equal(booking.discountAmount, 20);
    assert.equal(booking.preDiscountTotal, 225);
    assert.equal(booking.approvedFinalAmount, 205);
  });

  it('12. Admin / payment / receipt authority parity', async () => {
    await saveWelcomeLeadCapture({ email: EMAIL, source: 'first_visit_balloon' });
    const booking = fixtureBooking({
      status: 'Completed',
      jobStatus: 'completed',
      completedAt: '2026-09-15T18:00:00.000Z',
      confirmedDate: '2026-09-14',
      address: '1 Test Way',
      paymentWorkflowStatus: 'payment_succeeded',
      vehicles: [{
        vehicleId: 'v1',
        vehicleLabel: '2020 Honda CR-V',
        year: 2020,
        make: 'Honda',
        model: 'CR-V',
        packageName: 'Premium Full Detail',
        basePrice: 180,
        addonTotal: 20,
        addons: [{ id: 'rainx', name: 'Rain-X', qty: 1, price: 20 }],
        subtotal: 200,
      }],
    });
    await applyServerOffersToBooking(booking, {
      serviceSubtotal: 200,
      travelFee: 25,
      claimRedemption: true,
      redemptionBookingId: booking.id,
    });
    const ac = Math.round(booking.approvedFinalAmount * 100);
    booking.ledger = {
      approvedCents: ac,
      settledCents: ac,
      creditedCents: 0,
      entries: [{
        kind: 'settlement',
        amountCents: ac,
        recordedAt: '2026-09-15T17:30:00.000Z',
        providerObjectId: 'cs_W10',
      }],
    };
    booking.paymentAttempts = [{
      attemptId: 'a1',
      status: 'settled',
      amountCents: ac,
      settledAt: '2026-09-15T17:30:00.000Z',
      providerObjectId: 'cs_W10',
    }];

    const admin = projectBookingForCustomer(booking);
    assert.equal(admin.approvedFinalAmount, 205);
    assert.equal(admin.totalPrice, 205);
    assert.equal(admin.offer.discount_amount, 2000);

    const receipt = buildReceiptProjection(booking, 'payment');
    assert.equal(receipt.ok, true);
    assert.equal(receipt.receipt.financialSummary.approvedTotal.cents, 20500);
    const discountLine = (receipt.receipt.adjustments || [])
      .find((a) => /discount/i.test(a.name));
    assert.ok(discountLine);
    assert.equal(discountLine.amount.cents, -2000);
  });

  it('submit-booking fail-closes offer apply (no .catch continue)', () => {
    const src = read('netlify/functions/submit-booking.js');
    assert.match(src, /offer_application_unavailable|offer_already_redeemed/);
    assert.match(src, /claimRedemption/);
    assert.doesNotMatch(
      src,
      /applyServerOffersToBooking\([\s\S]*?\)\.catch\(\(e\) => \{\s*console\.warn\(\'\[submit-booking\] offer apply failed/
    );
  });

  it('redemption key is email-bound', () => {
    assert.equal(redemptionKey('  Pat@Example.COM '), redemptionKey('pat@example.com'));
    assert.match(redemptionKey('pat@example.com'), /^welcome10:/);
  });
});
