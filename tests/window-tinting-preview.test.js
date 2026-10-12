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

describe('window tint demonstration catalog', () => {
  it('keeps its own ids and an unpriced table', () => {
    assert.equal(demo.SERVICE_FAMILY, 'window_tint');
    assert.deepEqual(demo.FILMS.map((film) => film.id), [
      'wt_film_carbon',
      'wt_film_ceramic',
      'wt_film_help',
    ]);
    assert.equal(demo.DEMO_PRICE_TABLE.length > 0, true);
    for (const row of demo.DEMO_PRICE_TABLE) {
      assert.equal(row.amountCents, null);
      assert.equal(row.currency, 'usd');
      assert.equal(row.source, 'demo_table_unpriced');
    }
    const source = read('assets/window-tinting-demo-catalog.js');
    assert.doesNotMatch(source, /ceramic_1yr|ceramic_3yr|ceramic_coating|baseMinutes|booking-price-catalog/);
    assert.doesNotMatch(source, /\b(650|1050|480|600)\b/);
  });

  it('ignores URL prices, vehicle size, and ceramic duration', () => {
    const fromLink = demo.selectionFromSearch('?film=carbon&price=999&total=50&pkg=ceramic_1yr&duration=480');
    assert.equal(fromLink.filmId, 'wt_film_carbon');
    assert.deepEqual(fromLink.ignoredPriceKeys.sort(), ['duration', 'pkg', 'price', 'total']);

    const small = demo.quote({
      filmId: 'wt_film_carbon',
      glassIds: ['wt_glass_rear_sides', 'wt_glass_rear'],
      tierKey: 'small',
      price: 1,
      durationMinutes: 480,
    });
    const large = demo.quote({
      filmId: 'wt_film_carbon',
      glassIds: ['wt_glass_rear_sides', 'wt_glass_rear'],
      tierKey: 'suv3',
      price: 99999,
      durationMinutes: 600,
    });
    assert.equal(small.totalCents, null);
    assert.equal(large.totalCents, null);
    assert.equal(small.totalStatus, 'unpriced');
    assert.deepEqual(small.lines.map((line) => line.amountCents), large.lines.map((line) => line.amountCents));
    assert.equal(small.bookable, false);
    assert.equal(small.combinesWithDetailing, false);
    assert.equal(small.durationMinutes, null);
    assert.equal(small.installerResourceId, null);
    assert.equal(small.scheduleStatus, 'installer_capacity_unknown');
    assert.equal(small.priceAuthority, 'window-tinting-demo-catalog');
  });

  it('does not confirm evaluation glass or removal, even if a table has amounts', () => {
    const quote = demo.quote({
      filmId: 'wt_film_ceramic',
      glassIds: ['wt_glass_rear', 'wt_glass_front_sides', 'wt_glass_windshield', 'wt_glass_roof'],
      removal: 'yes',
      amountCents: 99900,
    }, {
      table: [
        { filmId: 'wt_film_ceramic', glassId: 'wt_glass_rear', amountCents: 1000, summable: true },
        { filmId: 'wt_film_ceramic', glassId: 'wt_glass_front_sides', amountCents: 40000, summable: true },
        { filmId: 'wt_film_ceramic', glassId: 'wt_glass_windshield', amountCents: 50000, summable: true },
        { filmId: 'wt_film_ceramic', glassId: 'wt_glass_roof', amountCents: 50000, summable: true },
      ],
    });
    assert.equal(quote.totalCents, 1000);
    assert.equal(quote.bookable, false);
    const byGlass = Object.fromEntries(quote.lines.filter((line) => line.glassId).map((line) => [line.glassId, line]));
    assert.equal(byGlass.wt_glass_rear.summable, true);
    assert.equal(byGlass.wt_glass_front_sides.confirmation, 'rules_review');
    assert.equal(byGlass.wt_glass_front_sides.summable, false);
    assert.equal(byGlass.wt_glass_windshield.confirmation, 'specific_evaluation');
    assert.equal(byGlass.wt_glass_windshield.amountCents, null);
    assert.equal(byGlass.wt_glass_roof.summable, false);
    const removal = quote.lines.find((line) => line.id === 'wt_removal_yes');
    assert.equal(removal.summable, false);
    assert.equal(removal.amountCents, null);
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
    assert.match(page, /Ceramic film is not ceramic coating/);
    assert.doesNotMatch(page, /Most popular|lifetime|3M|Llumar|XPEL|SunTek|ceramic_1yr|ceramic_3yr/i);
    assert.doesNotMatch(page, /\$\d|%|\bguaranteed\b/i);
    assert.doesNotMatch(read('sitemap.xml'), /window-tinting/);
    assert.doesNotMatch(read('index.html'), /window-tinting/);
    assert.doesNotMatch(read('assets/partials/specialty-public-footer.html'), /window-tinting/);
    const rule = parseRedirects(read('netlify.toml')).find((item) => item.from === '/window-tinting.html');
    assert.equal(rule.to, '/window-tinting');
    assert.equal(rule.status, 301);
    assert.equal(rule.force, true);
    assert.match(read('netlify.toml'), /for = "\/window-tinting"/);
    assert.match(read('netlify.toml'), /X-Robots-Tag = "noindex, nofollow"/);
  });

  it('does not enter the production catalog, booking, or schedule', () => {
    for (const file of [
      'netlify/lib/booking-price-catalog.js',
      'netlify/lib/ceramic-coating.js',
      'netlify/lib/booking-schedule.js',
      'netlify/functions/submit-booking.js',
      'index.html',
    ]) {
      const source = read(file);
      assert.equal(source.includes('window-tinting-demo-catalog'), false, file);
      assert.equal(source.includes('wt_film_'), false, file);
      assert.equal(source.includes("serviceFamily = 'window_tint'"), false, file);
    }
    assert.match(read('netlify/lib/ceramic-coating.js'), /baseMinutes: 480/);
    assert.match(read('netlify/lib/ceramic-coating.js'), /baseMinutes: 600/);
    const preview = read('assets/window-tinting-preview.js');
    assert.doesNotMatch(preview, /fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|gtag\(|stripe|submit-booking|booking-availability/i);
    assert.doesNotMatch(page, /type="date"|type="file"|js\.stripe\.com|I agree|I accept|responsible/i);
  });

  it('walks the quote without sending data or accepting a link price', () => {
    const dom = new JSDOM(page, {
      url: 'https://cardetail1.com/window-tinting?film=carbon&price=999&total=50',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    let networkCalls = 0;
    window.fetch = () => {
      networkCalls += 1;
      throw new Error('network');
    };
    window.CD1VehicleCatalog = {
      getMakes: () => ['Toyota'],
      modelsForMake: () => ['RAV4'],
      resolveVehicle: (input) => ({
        ok: !!(input.make && input.model && input.year),
        tierKey: 'suv3',
        displayLabel: '3-Row SUV',
      }),
    };
    window.CD1_CARS_VEHICLE_CATALOG = {
      yearPolicy: { selectableMin: 2020, selectableMax: 2022 },
    };
    window.CD1Travel = {
      estimateMilesForZip: (zip) => (zip === '07650' ? 4 : null),
    };
    window.eval(read('assets/window-tinting-demo-catalog.js'));
    window.eval(read('assets/window-tinting-preview.js'));
    const { document } = window;

    assert.equal(document.getElementById('wt-url-note').hidden, false);
    assert.match(document.getElementById('wt-url-note').textContent, /ignored/);
    assert.equal(document.querySelector('input[name="wt-film"][value="wt_film_carbon"]').checked, true);
    assert.equal(document.getElementById('wt-total-figure').textContent, 'Not priced');
    assert.equal(document.body.textContent.includes('999'), false);
    assert.equal(document.querySelector('#wt-state option[value="NJ"]').textContent, 'New Jersey');

    document.getElementById('wt-zip').value = '07650';
    document.querySelector('[data-wt-step="zip"] [data-wt-next]').click();
    assert.equal(document.querySelector('[data-wt-step="vehicle"]').hidden, false);

    document.getElementById('wt-make').value = 'Toyota';
    document.getElementById('wt-make').dispatchEvent(new window.Event('change'));
    document.getElementById('wt-model').value = 'RAV4';
    document.getElementById('wt-model').dispatchEvent(new window.Event('change'));
    document.getElementById('wt-year').value = '2022';
    document.getElementById('wt-year').dispatchEvent(new window.Event('change'));
    assert.match(document.getElementById('wt-vehicle-note').textContent, /does not change the window tint total/);
    document.querySelector('[data-wt-step="vehicle"] [data-wt-next]').click();

    document.querySelector('input[value="wt_glass_rear"]').checked = true;
    document.querySelector('input[value="wt_glass_windshield"]').checked = true;
    document.querySelector('input[value="wt_glass_windshield"]').dispatchEvent(new window.Event('change'));
    assert.match(document.getElementById('wt-total').textContent, /Specific evaluation/);
    assert.equal(document.getElementById('wt-total-figure').textContent, 'Not priced');
    document.querySelector('[data-wt-step="film"] [data-wt-next]').click();

    assert.match(document.getElementById('wt-vehicle-recap').textContent, /2022 Toyota RAV4/);
    document.getElementById('wt-state').value = 'NJ';
    document.querySelector('input[name="wt-removal"][value="yes"]').checked = true;
    document.querySelector('[data-wt-step="details"] [data-wt-next]').click();

    document.getElementById('wt-first').value = 'Ana';
    document.getElementById('wt-last').value = 'Rios';
    document.getElementById('wt-phone').value = '2015550100';
    document.getElementById('wt-email').value = 'ana@example.com';
    document.getElementById('wt-address').value = '10 Broad Avenue';
    document.querySelector('input[name="wt-contact"][value="text"]').checked = true;
    document.querySelector('input[name="wt-payment"][value="online_after_service"]').checked = true;
    document.querySelector('input[name="wt-payment"][value="online_after_service"]').dispatchEvent(new window.Event('change'));
    assert.match(document.getElementById('wt-payment-help').textContent, /not available in this preview/);
    document.querySelector('[data-wt-step="contact"] [data-wt-next]').click();
    document.getElementById('wt-finish').click();

    const result = document.getElementById('wt-demo-result');
    assert.equal(result.hidden, false);
    assert.match(result.textContent, /Nothing was sent, and no quote or appointment was created/);
    assert.match(result.textContent, /Not priced/);
    assert.match(result.textContent, /No card was saved and no payment was collected/);
    assert.match(result.textContent, /Specific evaluation/);
    assert.doesNotMatch(result.textContent, /quote was sent|appointment confirmed|we'll be in touch|request received/i);
    assert.equal(networkCalls, 0);
    assert.equal(window.CD1WindowTintPreview.currentQuote().bookable, false);
    assert.equal(window.CD1WindowTintPreview.currentQuote().durationMinutes, null);
  });
});
