'use strict';

/**
 * Conversion / friction reduction guards for homepage → booking continuity.
 * No pricing, Stripe, or schedule rule changes.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const index = read('index.html');
const modalJs = read('assets/car-pkg-detail-modal.js');
const revops = read('assets/revops-booking-hooks.js');

describe('homepage package clarity', () => {
  it('featured cards claim cars/trucks only — not boats/RVs/powersports', () => {
    const services = index.slice(index.indexOf('id="services"'), index.indexOf('id="before-after"'));
    assert.match(services, /Popular car packages/);
    assert.match(services, /Cars · trucks · SUVs · vans/);
    assert.doesNotMatch(services, /Cars · boats · RVs · powersports/);
    assert.match(services, /boat, RV and powersports packages have their own scopes/);
  });

  it('each featured package has best-for, limitations path, and continue CTA', () => {
    for (const pkgId of ['interior', 'full', 'refresh']) {
      const card = index.slice(index.indexOf(`data-pkg="${pkgId}"`), index.indexOf(`data-pkg="${pkgId}"`) + 1400);
      assert.match(card, /car-pkg-best/);
      assert.match(card, /openHomePkgDetailModal/);
      assert.match(card, new RegExp(`openBookingCarPkg\\('${pkgId}'\\)`));
      assert.match(card, /Continue with/);
      assert.match(card, /starting estimate · by vehicle type/);
    }
    assert.match(modalJs, /notIncluded:\s*\[/);
    assert.match(modalJs, /<h4>Limitations<\/h4>/);
  });

  it('specialty exits remain visible next to View all packages', () => {
    const start = index.indexOf('class="car-services-cta"');
    assert.ok(start > 0);
    const cta = index.slice(start, start + 700);
    assert.match(cta, /View all packages/);
    assert.match(cta, /rv-detailing\.html/);
    assert.match(cta, /boats-detailing\.html/);
    assert.match(cta, /powersports-detailing\.html/);
  });
});

describe('call / text secondary actions', () => {
  it('exposes tel and sms without treating them as booking conversion', () => {
    assert.match(index, /href="tel:5513735668"/);
    assert.match(index, /href="sms:5513735668"/);
    assert.match(index, /class="msc-text" href="sms:5513735668"/);
    assert.match(revops, /click_call/);
    assert.match(revops, /click_text/);
  });
});

describe('estimate and request-only clarity', () => {
  it('sticky and review totals are labeled as estimates, not guaranteed final price', () => {
    assert.match(index, /Estimate only · includes mobile adjustment/);
    assert.match(index, /Estimate only — not a final guaranteed price/);
    assert.match(index, /this is not a confirmed appointment yet/i);
  });
});

describe('funnel instrumentation wiring', () => {
  it('wires package_selected, zip checks, and corrected step events', () => {
    assert.match(revops, /package_selected/);
    assert.match(revops, /zip_check_started/);
    assert.match(revops, /zip_check_valid/);
    assert.match(revops, /zip_check_rejected/);
    assert.match(revops, /2:\s*'package_view'/);
    assert.match(revops, /3:\s*'vehicle_added'/);
    assert.match(revops, /4:\s*'contact_captured'/);
    assert.doesNotMatch(revops, /1:\s*'package_view'/);
    assert.doesNotMatch(revops, /STEP_EVENTS[\s\S]*payment_step_viewed/);
  });

  it('does not treat submit click as confirmed conversion', () => {
    assert.doesNotMatch(revops, /track\('booking_confirmed'/);
    assert.match(index, /submitBooking/);
  });
});
