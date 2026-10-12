'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const demo = require('../assets/window-tinting-demo-catalog');

function parseRedirects(toml) {
  return toml.split('[[redirects]]').slice(1).map((block) => {
    const body = block.split('[[')[0];
    const from = body.match(/from = "([^"]+)"/);
    const to = body.match(/to = "([^"]+)"/);
    const status = body.match(/status = (\d+)/);
    if (!from || !to || !status) return null;
    return { from: from[1], to: to[1], status: Number(status[1]), force: /force = true/.test(body) };
  }).filter(Boolean);
}

function quote(overrides) {
  return demo.quote(Object.assign({
    filmId: 'wt_film_carbon',
    coverageId: 'wt_cov_sides_rear',
    removal: 'no',
    displayClass: 'small',
    tierKey: 'small',
  }, overrides));
}

describe('window tint catalog', () => {
  it('keeps demo cents apart from the empty commercial offer', () => {
    assert.equal(demo.SERVICE_FAMILY, 'window_tint');
    assert.equal(demo.COMMERCIAL.enabled, false);
    assert.equal(demo.commercialReady(), false);
    assert.equal(demo.COMMERCIAL.durationMinutes, null);
    assert.equal(demo.COMMERCIAL.installerResourceId, null);
    assert.equal(demo.COMMERCIAL.usesDetailingCapacity, false);
    assert.equal(demo.DEMO.demoDurationMinutes, 180);
    assert.equal(demo.DEMO_PRICE_LABEL, 'Demo pricing — not available for booking');
    assert.deepEqual(demo.DEMO_PRICE_ROWS.map((row) => [row.carbonCents, row.ceramicCents]), [
      [17900, 24900],
      [39900, 54900],
      [44900, 59900],
      [49900, 64900],
    ]);
    for (const row of demo.COMMERCIAL_PRICE_ROWS) assert.equal(row.amountCents, null);
    const source = read('assets/window-tinting-demo-catalog.js');
    assert.doesNotMatch(source, /ceramic_1yr|ceramic_3yr|ceramic_coating|baseMinutes|booking-price-catalog/);
    assert.doesNotMatch(source, /\b(650|1050|480|600)\b/);
    assert.doesNotMatch(read('window-tinting.html'), /\$\d/);
  });

  it('prices the four demo rows and ignores a link price', () => {
    const fromLink = demo.selectionFromSearch('?film=carbon&coverage=sides-rear&price=999&total=50&pkg=ceramic_1yr&duration=480');
    assert.equal(fromLink.filmId, 'wt_film_carbon');
    assert.equal(fromLink.coverageId, 'wt_cov_sides_rear');
    assert.deepEqual(fromLink.ignoredPriceKeys.sort(), ['duration', 'pkg', 'price', 'total']);

    assert.equal(quote().totalCents, 39900);
    assert.equal(quote({ filmId: 'wt_film_ceramic' }).totalCents, 54900);
    assert.equal(quote({ displayClass: 'suv2', tierKey: 'suv2' }).totalCents, 44900);
    assert.equal(quote({ displayClass: 'minivan', tierKey: 'suv3' }).totalCents, 49900);
    assert.equal(quote({ coverageId: 'wt_cov_two_side', displayClass: 'suv3' }).totalCents, 17900);
    assert.equal(quote({ filmId: 'wt_film_ceramic', coverageId: 'wt_cov_two_side' }).totalCents, 24900);

    const priced = quote({ price: 99999, amountCents: 0, durationMinutes: 480, pkgId: 'ceramic_1yr' });
    assert.equal(priced.totalCents, 39900);
    assert.equal(priced.bookable, false);
    assert.equal(priced.durationMinutes, null);
    assert.equal(priced.demoDurationMinutes, 180);
    assert.equal(priced.usesDetailingCapacity, false);
    assert.equal(priced.canConfirmTime, false);
    assert.equal(priced.priceLabel, 'Demo pricing — not available for booking');
    assert.deepEqual(priced.includedGlass.map((glass) => glass.id), ['wt_glass_rear_sides', 'wt_glass_rear']);
    assert.equal(priced.excludedGlass.some((glass) => glass.id === 'wt_glass_windshield'), true);
  });

  it('keeps windshield, roof, removal, and unmatched vehicles pending', () => {
    const windshield = quote({ extraGlassIds: ['wt_glass_windshield'], amountCents: 0, price: 0 });
    assert.equal(windshield.totalCents, null);
    assert.equal(windshield.totalStatus, 'evaluation_pending');
    assert.equal(windshield.demoDurationMinutes, null);
    assert.equal(windshield.fictionalWindows.length, 0);
    assert.equal(windshield.pendingGlass[0].id, 'wt_glass_windshield');

    assert.equal(quote({ extraGlassIds: ['wt_glass_roof', 'wt_glass_front_sides'] }).totalCents, null);
    assert.equal(quote({ removal: 'yes' }).totalCents, null);
    assert.equal(quote({ removal: 'unsure' }).totalStatus, 'evaluation_pending');
    assert.equal(quote({ filmId: 'wt_film_help' }).totalCents, null);
    assert.equal(quote({ coverageId: 'wt_cov_unsure' }).totalCents, null);
    assert.equal(quote({ displayClass: 'truck', tierKey: 'truck' }).totalCents, null);
    assert.notEqual(quote({ removal: 'yes' }).totalCents, 0);
  });
});

describe('window tint preview page', () => {
  const page = read('window-tinting.html');

  it('is a noindex preview outside the sitemap and production nav', () => {
    assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(page, /<h1 id="wt-title">A cooler ride\. A look that feels right\.<\/h1>/);
    assert.match(page, /Explore window tint options for your vehicle, with clear guidance on film, shade, and coverage\./);
    assert.match(page, /Get my tint quote/);
    assert.match(page, /Carbon Window Tint/);
    assert.match(page, /Ceramic Window Tint/);
    assert.match(page, /Help me choose/);
    assert.match(page, /Illustration only\. Not a Cardetail1 window tint installation\./);
    assert.match(page, /Ceramic film is not ceramic coating/);
    assert.doesNotMatch(page, /Most popular|lifetime|3M|Llumar|XPEL|SunTek|ceramic_1yr|ceramic_3yr|id="bk-ov"/i);
    assert.doesNotMatch(page, /\$\d|%|\bguaranteed\b/i);
    assert.doesNotMatch(read('sitemap.xml'), /window-tinting/);
    assert.doesNotMatch(read('index.html'), /href="\/window-tinting/);
    assert.match(read('index.html'), /window-tinting-booking-preview\.js/);
    assert.doesNotMatch(read('assets/partials/specialty-public-footer.html'), /window-tinting/);
    const rule = parseRedirects(read('netlify.toml')).find((item) => item.from === '/window-tinting.html');
    assert.equal(rule.to, '/window-tinting');
    assert.equal(rule.status, 301);
    assert.equal(rule.force, true);
    assert.match(read('netlify.toml'), /for = "\/window-tinting"/);
    assert.match(read('netlify.toml'), /X-Robots-Tag = "noindex, nofollow"/);
  });

  it('does not copy demo prices into the production catalog', () => {
    for (const file of [
      'netlify/lib/booking-price-catalog.js',
      'netlify/lib/ceramic-coating.js',
      'netlify/lib/booking-schedule.js',
    ]) {
      const source = read(file);
      assert.equal(source.includes('window-tinting-demo-catalog'), false, file);
      assert.equal(source.includes('wt_film_'), false, file);
    }
    assert.match(read('netlify/functions/submit-booking.js'), /windowTintBlock/);
    assert.match(read('netlify/functions/create-setup-intent.js'), /windowTintBlock/);
    assert.match(read('netlify/functions/booking-availability.js'), /windowTintBlock/);
    assert.match(read('netlify/lib/ceramic-coating.js'), /baseMinutes: 480/);
    assert.match(read('netlify/lib/ceramic-coating.js'), /baseMinutes: 600/);
    assert.doesNotMatch(read('assets/window-tinting-preview.js'), /fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|gtag\(|stripe|submit-booking/i);
    assert.doesNotMatch(page, /type="date"|type="file"|js\.stripe\.com|I agree|I accept|responsible/i);
  });

  it('selects film and coverage and opens the existing form without a link price', () => {
    const dom = new JSDOM(page, {
      url: 'https://cardetail1.com/window-tinting?film=carbon&coverage=sides-rear&price=999&total=50',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    window.fetch = () => { throw new Error('network'); };
    window.eval(read('assets/window-tinting-demo-catalog.js'));
    window.eval(read('assets/window-tinting-preview.js'));
    const { document } = window;

    assert.equal(document.getElementById('wt-url-note').hidden, false);
    assert.match(document.getElementById('wt-compare').textContent, /Demo pricing — not available for booking/);
    assert.match(document.getElementById('wt-compare').textContent, /\$179/);
    assert.match(document.getElementById('wt-compare').textContent, /\$649/);
    assert.equal(document.body.textContent.includes('999'), false);
    assert.equal(document.querySelector('[data-wt-film="wt_film_carbon"]').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('input[name="wt-coverage"][value="wt_cov_sides_rear"]').checked, true);
    assert.equal(document.getElementById('wt-open-booking').disabled, false);
    assert.equal(
      window.CD1WindowTintPreview.bookingUrl(),
      '/?embed=1&wtpreview=1&film=wt_film_carbon&coverage=wt_cov_sides_rear'
    );

    document.querySelector('[data-wt-film="wt_film_ceramic"]').click();
    document.querySelector('input[value="wt_cov_two_side"]').checked = true;
    document.querySelector('input[value="wt_cov_two_side"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(
      window.CD1WindowTintPreview.bookingUrl(),
      '/?embed=1&wtpreview=1&film=wt_film_ceramic&coverage=wt_cov_two_side'
    );
  });
});

describe('window tint booking preview', () => {
  function mount(search) {
    const html = `<!DOCTYPE html><body>
      <div id="bk-ov"><div class="bprog" id="bprog"></div><div class="bcontent">
        <div class="bsec on" id="bs1"><input id="bk-zip" oninput="onBkZipInput(this.value)"></div>
        <div class="bsec" id="bs3"><div id="make-search-wrap">
          <input id="make-in"><select id="model-sel"></select><select id="year-sel"></select>
        </div></div>
        <div class="bsec" id="bs4">
          <div class="fg"><input id="f-first"></div>
          <div class="fg"><input id="f-last"></div>
          <div class="fg"><input id="f-phone"></div>
          <div class="fg"><input id="f-email"></div>
          <div class="fg"><input id="f-addr"></div>
          <input id="f-date" type="date">
          <div id="booking-sms-consent"><input id="sms-consent-ok" type="checkbox"></div>
        </div>
        <div class="bsec" id="bs5"></div>
      </div></div>
    </body>`;
    const dom = new JSDOM(html, {
      url: 'https://cardetail1.com/?' + search,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    const writes = [];
    const store = window.localStorage;
    const originalSet = store.setItem.bind(store);
    store.setItem = function (key, value) {
      writes.push(key);
      return originalSet(key, value);
    };
    store.setItem('cd1_booking_progress', '{"service":"detailing"}');
    store.setItem('cd1_bookings', '[]');
    window.CD1BookingProgress = {
      resumeFromQuery() { return { opened: true, restored: true }; },
      applySnapshot() { return true; },
      persist() { store.setItem('cd1_booking_progress', '{"service":"window_tint"}'); },
    };
    window.CD1VehicleCatalog = {
      resolveVehicle(input) {
        const ok = !!(input.make && input.model && input.year);
        const tier = input.model === 'RAV4' ? 'suv2' : 'small';
        return { ok, tierKey: tier, displayClass: tier, displayLabel: tier };
      },
    };
    window.CD1Travel = { estimateMilesForZip: (zip) => (zip === '07650' ? 4 : null) };
    window.fetch = () => { throw new Error('network'); };
    window.eval(read('assets/window-tinting-demo-catalog.js'));
    window.eval(read('assets/window-tinting-booking-preview.js'));
    return { window, document: window.document, writes };
  }

  function choose(document, id, value) {
    const select = document.getElementById(id);
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
    select.value = value;
  }

  async function walkToReview(document, window, model) {
    document.getElementById('bk-zip').value = '07650';
    document.querySelector('[data-wtb-step="zip"] [data-wtb-next]').click();
    document.getElementById('make-in').value = 'Toyota';
    choose(document, 'model-sel', model);
    choose(document, 'year-sel', '2022');
    document.getElementById('year-sel').dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('[data-wtb-step="vehicle"] [data-wtb-next]').click();
    document.getElementById('wtb-state').value = 'NJ';
    document.querySelector('input[name="wtb-removal"][value="no"]').checked = true;
    document.querySelector('input[name="wtb-removal"][value="no"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('[data-wtb-step="tint"] [data-wtb-next]').click();
    document.getElementById('f-first').value = 'Ana';
    document.getElementById('f-last').value = 'Rios';
    document.getElementById('f-phone').value = '2015550100';
    document.getElementById('f-email').value = 'ana@example.com';
    document.getElementById('f-addr').value = '10 Broad Avenue';
    document.querySelector('[data-wtb-step="contact"] [data-wtb-next]').click();
  }

  it('preserves the page choice, reprices, goes back, and finishes without storing or booking', async () => {
    const { window, document, writes } = mount('embed=1&wtpreview=1&film=carbon&coverage=wt_cov_sides_rear&price=999');
    assert.equal(window.CD1WindowTintBookingPreview.disarmResume !== undefined, true);
    assert.equal(window.CD1BookingProgress.resumeFromQuery().reason, 'window_tint_preview');
    assert.equal(document.querySelector('input[name="wtb-film"][value="wt_film_carbon"]').checked, true);
    assert.equal(document.querySelector('input[name="wtb-coverage"][value="wt_cov_sides_rear"]').checked, true);
    assert.equal(document.body.textContent.includes('999'), false);

    await walkToReview(document, window, 'Camry');
    assert.match(document.getElementById('wtb-total-figure').textContent, /\$399/);
    assert.match(document.getElementById('wtb-schedule').textContent, /not a real opening/);
    assert.match(document.getElementById('wtb-schedule').textContent, /Commercial duration is not set/);
    assert.match(document.getElementById('wtb-glass').textContent, /Included/);
    assert.match(document.getElementById('wtb-glass').textContent, /Rear window/);
    assert.match(document.getElementById('wtb-glass').textContent, /Windshield/);

    document.querySelector('[data-wtb-step="schedule"] [data-wtb-back]').click();
    assert.equal(document.querySelector('[data-wtb-step="contact"]').hidden, false);
    document.getElementById('f-first').value = 'Ana';
    document.querySelector('[data-wtb-step="contact"] [data-wtb-next]').click();

    choose(document, 'model-sel', 'RAV4');
    document.getElementById('model-sel').dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('[data-wtb-step="schedule"] [data-wtb-back]').click();
    document.querySelector('[data-wtb-step="contact"] [data-wtb-back]').click();
    assert.match(document.getElementById('wtb-total-figure').textContent, /\$449/);
    document.querySelector('input[name="wtb-coverage"][value="wt_cov_two_side"]').checked = true;
    document.querySelector('input[name="wtb-coverage"][value="wt_cov_two_side"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.match(document.getElementById('wtb-total-figure').textContent, /\$179/);
    document.querySelector('input[value="wt_glass_windshield"]').checked = true;
    document.querySelector('input[value="wt_glass_windshield"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(document.getElementById('wtb-total-figure').textContent, 'Evaluation pending');
    assert.doesNotMatch(document.getElementById('wtb-total').textContent, /\$0/);

    document.querySelector('input[value="wt_glass_windshield"]').checked = false;
    document.querySelector('input[name="wtb-coverage"][value="wt_cov_sides_rear"]').checked = true;
    document.querySelector('input[name="wtb-coverage"][value="wt_cov_sides_rear"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('[data-wtb-step="tint"] [data-wtb-next]').click();
    document.querySelector('[data-wtb-step="contact"] [data-wtb-next]').click();
    document.querySelector('input[name="wtb-time"]').checked = true;
    document.querySelector('input[name="wtb-time"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('[data-wtb-step="schedule"] [data-wtb-next]').click();
    document.querySelector('input[name="wtb-pay"][value="online_after_service"]').checked = true;
    document.querySelector('input[name="wtb-pay"][value="online_after_service"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(document.querySelector('#wt-book input[autocomplete="cc-number"], #wt-book iframe'), null);
    document.querySelector('[data-wtb-step="pay"] [data-wtb-next]').click();
    assert.equal(document.getElementById('wtb-finish').textContent, 'Finish preview');
    document.getElementById('wtb-finish').click();
    assert.match(document.getElementById('wtb-result').textContent, /Demo completed\. No appointment was created\./);

    const blocked = await window.fetch('/.netlify/functions/submit-booking', { method: 'POST' });
    assert.equal(blocked.status, 403);
    assert.equal(writes.filter((key) => key.indexOf('cd1_') === 0 && key !== 'cd1_booking_progress' && key !== 'cd1_bookings').length, 0);
    assert.equal(window.localStorage.getItem('cd1_booking_progress'), '{"service":"detailing"}');
    assert.equal(window.localStorage.getItem('cd1_bookings'), '[]');
    window.CD1BookingProgress.persist();
    assert.equal(window.localStorage.getItem('cd1_booking_progress'), '{"service":"detailing"}');
  });
});

describe('window tint server refusal', () => {
  it('rejects booking, card setup, and availability while the service is disabled', async () => {
    const submit = require('../netlify/functions/submit-booking');
    const setup = require('../netlify/functions/create-setup-intent');
    const availability = require('../netlify/functions/booking-availability');

    const booking = await submit.handler({
      httpMethod: 'POST',
      headers: { host: 'localhost' },
      body: JSON.stringify({
        firstName: 'Ana',
        phone: '2015550100',
        zipCode: '07650',
        serviceFamily: 'window_tint',
        filmId: 'wt_film_carbon',
        packageId: 'wt_cov_sides_rear',
      }),
    });
    assert.equal(booking.statusCode, 403);
    assert.equal(JSON.parse(booking.body).error, 'window_tint_disabled');
    assert.equal(JSON.parse(booking.body).bookingCreated, false);

    const detailing = await submit.handler({
      httpMethod: 'POST',
      headers: { host: 'localhost' },
      body: JSON.stringify({ cat: 'cars', pkgId: 'full' }),
    });
    assert.notEqual(JSON.parse(detailing.body).error, 'window_tint_disabled');

    const card = await setup.handler({
      httpMethod: 'POST',
      headers: { host: 'localhost' },
      body: JSON.stringify({ bookingId: 'CD1-1', filmId: 'wt_film_ceramic', draftSaveToken: 'x' }),
    });
    assert.equal(card.statusCode, 403);
    assert.equal(JSON.parse(card.body).paymentCreated, false);
    assert.equal(JSON.parse(card.body).error, 'window_tint_disabled');

    const slots = await availability.handler({
      httpMethod: 'GET',
      headers: { host: 'localhost' },
      queryStringParameters: { action: 'nearby', packageId: 'wt_cov_two_side', serviceFamily: 'window_tint' },
    });
    assert.equal(slots.statusCode, 403);
    assert.equal(JSON.parse(slots.body).error, 'window_tint_disabled');
  });
});
