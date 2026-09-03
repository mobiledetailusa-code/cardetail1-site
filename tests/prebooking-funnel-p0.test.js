'use strict';

/**
 * Pre-booking funnel P0: package CTA identity, resume, ZIP gate,
 * #book repair, featured vs full catalog, no payment regression.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const index = read('index.html');
const modalJs = read('assets/car-pkg-detail-modal.js');
const progressSrc = read('assets/booking-progress.js');
const multi = read('multi-vehicle-detailing.html');
const gateSrc = read('assets/booking-routing-gate.js');

function loadProgress(overrides) {
  const store = {};
  const ctx = {
    window: {},
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById() { return null; },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    location: { search: '', pathname: '/' },
    ST: { cat: '', pkgId: '', vehicles: [], addons: [] },
    currentBkStep: 1,
    activeZone: { key: 'nj_a' },
    console,
  };
  Object.assign(ctx, overrides);
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(progressSrc, ctx);
  ctx.__store = store;
  return ctx;
}

describe('P0-1 package CTA identity', () => {
  it('featured package CTAs pass canonical package ids', () => {
    assert.match(index, /class="car-pkg-cta" onclick="openBookingCarPkg\('interior'\)"/);
    assert.match(index, /class="car-pkg-cta" onclick="openBookingCarPkg\('full'\)"/);
    assert.match(index, /class="car-pkg-cta" onclick="openBookingCarPkg\('refresh'\)"/);
    assert.equal((index.match(/class="car-pkg-cta" onclick="openBookingCarPkg\('interior'\)"/g) || []).length, 1);
    assert.equal((index.match(/class="car-pkg-cta" onclick="openBookingCarPkg\('full'\)"/g) || []).length, 1);
    assert.equal((index.match(/class="car-pkg-cta" onclick="openBookingCarPkg\('refresh'\)"/g) || []).length, 1);
    assert.doesNotMatch(index, /class="car-pkg-cta" onclick="openBooking\(null\)"/);
  });

  it('See what\'s included and Book this package share the same package ids', () => {
    for (const pkgId of ['interior', 'full', 'refresh']) {
      assert.match(index, new RegExp(`openHomePkgDetailModal\\('${pkgId}'`));
      assert.match(index, new RegExp(`openBookingCarPkg\\('${pkgId}'\\)`));
    }
    assert.match(modalJs, /openBookingCarPkg\(pkgId\)/);
    assert.doesNotMatch(index, /openBookingCarPkg\('wash'\)/);
  });
});

describe('P0-2 package naming', () => {
  it('authoritative catalog and featured card use Exterior Refresh & Protect', () => {
    assert.match(index, /id:'refresh',\s*name:'Exterior Refresh & Protect'/);
    const card = index.slice(index.indexOf('data-pkg="refresh"'), index.indexOf('data-pkg="refresh"') + 900);
    assert.match(card, /Exterior Refresh &amp; Protect/);
    assert.doesNotMatch(card, /Paint Enhancement/);
    assert.match(modalJs, /title:\s*"Exterior Refresh & Protect"/);
    assert.doesNotMatch(modalJs, /Paint Enhancement/);
  });
});

describe('P0-3 resume', () => {
  it('restores a valid snapshot at the highest safe step', () => {
    const ctx = loadProgress();
    const P = ctx.CD1BookingProgress;
    const snap = {
      v: 1,
      savedAt: Date.now(),
      step: 5,
      zip: '07650',
      ST: {
        cat: 'cars',
        pkgId: 'interior',
        vehicles: [{ id: 'v1' }],
        addons: [],
        vehicleLabel: '2018 Honda Civic',
        tierKey: 'small',
        lengthFt: 0,
        rvType: '',
        rvLiving: '',
        units: 1,
      },
      fields: {
        'f-first': 'Ada',
        'f-last': 'Lovelace',
        'f-phone': '5513735668',
        'f-email': 'ada@example.com',
        'f-addr': '1 Main St',
        'f-date': '2026-09-10',
      },
    };
    assert.equal(P.highestSafeStep(snap, 5, true), 5);
    assert.equal(P.highestSafeStep(snap, 99, true), 5);
  });

  it('stale resume requesting review falls back before a broken review', () => {
    const ctx = loadProgress();
    const P = ctx.CD1BookingProgress;
    const incomplete = {
      v: 1,
      savedAt: Date.now(),
      step: 5,
      ST: { cat: 'cars', pkgId: 'full', vehicles: [], addons: [], vehicleLabel: '', tierKey: '', lengthFt: 0 },
      fields: {},
    };
    assert.equal(P.highestSafeStep(incomplete, 5, true), 3);
    const noPkg = {
      v: 1,
      savedAt: Date.now(),
      ST: { cat: 'rvs', pkgId: '', vehicles: [], addons: [] },
      fields: {},
    };
    assert.equal(P.highestSafeStep(noPkg, 5, true), 2);
    const empty = { v: 1, savedAt: Date.now(), ST: {}, fields: {} };
    assert.equal(P.highestSafeStep(empty, 5, true), 1);
    assert.equal(P.highestSafeStep(empty, 5, false), 1);
  });

  it('resumeFromQuery opens booking and does not land on success step 6', () => {
    let opened = null;
    let gone = null;
    const ctx = loadProgress({
      location: { search: '?resume=1&step=6', pathname: '/' },
      openBooking(cat) { opened = cat; },
      bkGoTo(n) { gone = n; },
    });
    const result = ctx.CD1BookingProgress.resumeFromQuery();
    assert.equal(result.opened, true);
    assert.equal(opened, null);
    assert.equal(result.step, 1);
    assert.equal(gone, 1);
  });
});

describe('P0-4 ZIP gate / deep-link', () => {
  it('homepage booking DOM keeps ZIP required and exposes a pending-intent banner', () => {
    const dom = new JSDOM(index);
    const banner = dom.window.document.getElementById('bk-intent-banner');
    const zip = dom.window.document.getElementById('bk-zip');
    const gate = dom.window.document.getElementById('bk-gate-msg');
    assert.ok(banner);
    assert.ok(zip);
    assert.ok(gate);
    assert.match(index, /ST\._pendingCat=cat/);
    assert.match(index, /CD1BookingProgress\.showPendingIntent\(cat\)/);
    assert.match(index, /if\(zip\.length < 5 \|\| !activeZone\)/);
  });

  it('pending-intent copy names the selected service without auto-submitting ZIP', () => {
    const ctx = loadProgress();
    assert.equal(ctx.CD1BookingProgress.categoryLabel('rvs'), 'RV Detailing');
    assert.equal(ctx.CD1BookingProgress.categoryLabel('boats'), 'Boat Detailing');
    assert.doesNotMatch(index, /onBkZipInput\(this\.value\).*openBooking/);
  });
});

describe('P0-5 / P0-6 funnel copy', () => {
  it('homepage copy is not hardcoded as five steps', () => {
    assert.match(index, /Book in a few quick steps/);
    assert.doesNotMatch(index, /Book in five steps/i);
    assert.doesNotMatch(index, /five clear steps/);
    assert.match(index, /BK_VISIBLE_STEPS\s*=\s*6/);
  });

  it('homepage features 3 packages and offers a path to the full list', () => {
    assert.match(index, /Featured packages/);
    assert.match(index, /Popular services/);
    assert.match(index, />View all packages</);
    assert.equal((index.match(/data-pkg="(interior|full|refresh)"/g) || []).length, 3);
    assert.doesNotMatch(index.slice(index.indexOf('id="services"'), index.indexOf('id="how"')), /data-pkg="wash"/);
  });
});

describe('P0-7 multi-vehicle #book', () => {
  it('routes through the homepage booking opener instead of a dead #book hash', () => {
    assert.doesNotMatch(multi, /#book/);
    assert.match(multi, /index\.html\?book=cars&amp;multi=1/);
    assert.match(multi, /href="index\.html\?book=cars"/);
    assert.match(index, /params\.get\('multi'\)==='1'/);
  });
});

describe('P0-8 / P0-9 / P0-10 booking surface contract', () => {
  it('booking funnel and success surfaces use My Garage as the portal product name', () => {
    assert.match(index, /msc-portal" onclick="openPortal\(\)">My Garage</);
    assert.match(index, /View in My Garage/);
    assert.doesNotMatch(index, /msc-portal" onclick="openPortal\(\)">Your booking</);
    assert.doesNotMatch(index, /ltab-customer" onclick="setLoginRole\('customer'\)">👤 My Booking</);
  });

  it('does not introduce initial card collection or a second submit', () => {
    const bs5 = index.slice(index.indexOf('id="bs5"'), index.indexOf('id="bs6"'));
    const bs6 = index.slice(index.indexOf('id="bs6"'), index.indexOf('id="bs6"') + 2500);
    assert.match(bs5, /onclick="submitBooking\(\)"/);
    assert.doesNotMatch(bs6, /onclick="submitBooking\(\)"/);
    assert.doesNotMatch(bs5, /id="stripe-auth-btn"/);
    assert.doesNotMatch(bs5, /create-setup-intent/);
    assert.match(index, /Request Sent is success-only/);
  });

  it('routing gate opens resume through CD1BookingProgress', () => {
    assert.match(gateSrc, /CD1BookingProgress\.resumeFromQuery/);
    assert.match(index, /assets\/booking-progress\.js/);
  });
});
