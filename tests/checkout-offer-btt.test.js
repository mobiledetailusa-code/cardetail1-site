'use strict';

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const {
  computeEligibleServiceSubtotalCents,
  evaluateBookingOfferPreview,
  CLIENT_OFFER_BLOCKED_FIELDS,
  WELCOME_OFFER_ID,
} = require('../netlify/lib/booking-offers');
const { getOfferConfig, evaluateOffers } = require('../netlify/lib/revenue-offers');

describe('six-step checkout', () => {
  it('index exposes exactly six progress steps', () => {
    const html = read('index.html');
    assert.match(html, /BK_VISIBLE_STEPS\s*=\s*6/);
    assert.match(html, /id="bpt1"[\s\S]*Category/);
    assert.match(html, /id="bpt2"[\s\S]*Package/);
    assert.match(html, /id="bpt3"[\s\S]*Vehicle/);
    assert.match(html, /id="bpt4"[\s\S]*Info/);
    assert.match(html, /id="bpt5"[\s\S]*Secure Your Booking/);
    assert.match(html, /id="bpt6"[\s\S]*Confirm/);
  });

  it('public copy says Book in six steps', () => {
    const html = read('index.html');
    assert.match(html, /Book in six steps/i);
  });

  it('bkGoTo maps one panel per step', () => {
    const html = read('index.html');
    assert.match(html, /return \['bs' \+ n\]/);
  });

  it('preserves Stripe SetupIntent and package fields', () => {
    const html = read('index.html');
    assert.match(html, /confirmSetupIntent/);
    assert.match(html, /create-setup-intent/);
    assert.match(html, /ST\.pkgId/);
    assert.match(html, /maint/);
  });

  it('includes checkout analytics and offer modules', () => {
    const html = read('index.html');
    assert.match(html, /checkout-analytics\.js/);
    assert.match(html, /checkout-offer\.js/);
  });
});

describe('WELCOME10 server offer', () => {
  const baseBooking = {
    zipCode: '07030',
    phone: '2015550100',
    email: 'new@example.com',
    vehicleCategory: 'cars',
    packageId: 'interior',
    vehicles: [{ cat: 'cars', pkgId: 'interior', subtotal: 225 }],
  };

  it('is disabled by default', () => {
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
    assert.equal(getOfferConfig().firstBooking.enabled, false);
  });

  it('eligible new customer receives 10% up to $40 cap', async () => {
    process.env.FIRST_BOOKING_OFFER_ENABLED = 'true';
    const preview = await evaluateBookingOfferPreview(baseBooking);
    assert.equal(preview.offer.eligibility_status, 'eligible');
    assert.equal(preview.offer.discount_amount, 2250);
    assert.equal(preview.offer.percent, 10);
    assert.equal(preview.offer.cap_cents, 4000);
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  });

  it('caps multi-vehicle discount at $40 total', async () => {
    process.env.FIRST_BOOKING_OFFER_ENABLED = 'true';
    const booking = {
      ...baseBooking,
      vehicles: [
        { cat: 'cars', pkgId: 'interior', subtotal: 225 },
        { cat: 'cars', pkgId: 'full', subtotal: 300 },
      ],
    };
    const cents = computeEligibleServiceSubtotalCents(booking);
    assert.equal(cents, 52500);
    const preview = await evaluateBookingOfferPreview(booking);
    assert.equal(preview.offer.discount_amount, 4000);
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  });

  it('excludes maintenance package', async () => {
    process.env.FIRST_BOOKING_OFFER_ENABLED = 'true';
    const preview = await evaluateBookingOfferPreview({
      ...baseBooking,
      packageId: 'maint',
      vehicles: [{ cat: 'cars', pkgId: 'maint', subtotal: 99 }],
    });
    assert.equal(preview.offer.eligibility_status, 'ineligible');
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  });

  it('excludes fleet and custom quote', () => {
    process.env.FIRST_BOOKING_OFFER_ENABLED = 'true';
    const fleet = evaluateOffers({
      eligibleSubtotalCents: 10000,
      vehicleCount: 2,
      priorCompletedServices: 0,
      packageId: 'essential',
      category: 'fleet',
      isCustomQuote: false,
    });
    assert.equal(fleet.selected, null);
    const custom = evaluateOffers({
      eligibleSubtotalCents: 10000,
      vehicleCount: 1,
      priorCompletedServices: 0,
      packageId: 'custom',
      category: 'cars',
      isCustomQuote: true,
    });
    assert.equal(custom.selected, null);
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  });

  it('blocks client-supplied discount fields', () => {
    assert.ok(CLIENT_OFFER_BLOCKED_FIELDS.includes('discount_amount'));
    assert.ok(CLIENT_OFFER_BLOCKED_FIELDS.includes('offer_percent'));
  });

  it('evaluate-booking-offer function exists', () => {
    const src = read('netlify/functions/evaluate-booking-offer.js');
    assert.match(src, /evaluateBookingOfferPreview/);
    assert.match(src, /stripClientOfferFields/);
  });

  it('submit-booking applies server offers', () => {
    const src = read('netlify/functions/submit-booking.js');
    assert.match(src, /applyServerOffersToBooking/);
    assert.match(src, /CLIENT_OFFER_BLOCKED_FIELDS/);
  });

  it('offer panel has no fake countdown', () => {
    const html = read('index.html');
    const offerJs = read('assets/checkout-offer.js');
    assert.doesNotMatch(html, /countdown|today only|limited time/i);
    assert.doesNotMatch(offerJs, /countdown|setInterval.*offer/i);
  });

  it('uses WELCOME10 offer id alias', () => {
    assert.equal(WELCOME_OFFER_ID, 'first_booking_welcome');
    assert.match(read('netlify/lib/booking-offers.js'), /WELCOME10/);
  });
});

describe('back to top', () => {
  it('single control with scrollingElement fallback', () => {
    const js = read('assets/back-to-top.js');
    assert.match(js, /scrollingElement/);
    assert.match(js, /cd1-btt/);
    assert.match(js, /__CD1_BTT_INIT__/);
    assert.match(js, /keydown/);
    assert.match(js, /prefers-reduced-motion/);
  });

  it('removes legacy btt id', () => {
    assert.match(read('assets/back-to-top.js'), /getElementById\('btt'\)/);
  });
});

describe('checkout analytics', () => {
  it('maps begin_checkout and add_payment_info', () => {
    const js = read('assets/checkout-analytics.js');
    assert.match(js, /checkout_opened[\s\S]*begin_checkout/);
    assert.match(js, /payment_info_saved[\s\S]*add_payment_info/);
    assert.match(js, /payment_completed[\s\S]*purchase/);
  });

  it('does not emit purchase at booking_submitted', () => {
    const js = read('assets/checkout-analytics.js');
    assert.doesNotMatch(js, /booking_submitted[\s\S]*purchase/);
  });

  it('uses anonymous_session_id not booking id', () => {
    const js = read('assets/checkout-analytics.js');
    assert.match(js, /anonymous_session_id/);
    assert.doesNotMatch(js, /booking_id|bookingId/);
  });
});

describe('my garage offer display', () => {
  it('shows offer discount lines', () => {
    const js = read('assets/my-garage.js');
    assert.match(js, /welcomeOffer/);
    assert.match(js, /redemption_status/);
    assert.match(js, /approvedFinalAmount/);
  });
});
