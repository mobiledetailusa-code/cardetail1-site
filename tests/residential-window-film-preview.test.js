'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const film = require('../assets/residential-window-film-catalog');
const automotive = require('../assets/window-tinting-demo-catalog');

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

function panes(overrides) {
  return film.measure(Object.assign({
    filmId: 'rwf_film_privacy',
    glassTypeId: 'rwf_glass_unknown',
    floor: '2',
    access: 'Stairs',
    rows: [{ quantity: 2, width: 36, height: 48, unit: 'in' }],
  }, overrides));
}

describe('residential window film catalog', () => {
  it('stays separate from automotive tint and has no price', () => {
    assert.equal(film.SERVICE_FAMILY, 'residential_window_film');
    assert.notEqual(film.SERVICE_FAMILY, automotive.SERVICE_FAMILY);
    assert.equal(film.COMMERCIAL.enabled, false);
    assert.equal(film.commercialReady(), false);
    assert.equal(film.commercialReady({ enabled: true, commercialReady: true, amountCents: 5000 }), false);
    assert.equal(film.COMMERCIAL.durationMinutes, null);
    assert.equal(film.DEMO.demoDurationMinutes, null);
    assert.equal(automotive.DEMO.demoDurationMinutes, 180);
    assert.equal(film.COMMERCIAL.usesAutomotiveResource, false);
    assert.equal(film.COMMERCIAL.usesDetailingCapacity, false);
    assert.deepEqual(film.COMMERCIAL_PRICE_ROWS, []);
    assert.deepEqual(film.FILMS.map((item) => item.id), ['rwf_film_solar', 'rwf_film_privacy', 'rwf_film_decorative']);
    assert.equal(automotive.DEMO_PRICE_ROWS[0].carbonCents, 17900);
    assert.equal(automotive.DEMO_PRICE_ROWS[3].ceramicCents, 64900);
    const source = read('assets/residential-window-film-catalog.js');
    assert.equal(source.includes('window-tinting-demo-catalog'), false);
    assert.equal(source.includes('wt_film_'), false);
    assert.doesNotMatch(source, /\b(17900|24900|39900|54900|44900|59900|49900|64900|180)\b/);
    assert.throws(() => { film.COMMERCIAL.enabled = true; }, TypeError);
    assert.equal(film.COMMERCIAL.enabled, false);
  });

  it('calculates area, repeats sizes, and accepts an unknown glass type', () => {
    const fromLink = film.selectionFromSearch('?film=privacy&price=880&commercialReady=true&enabled=true&duration=180');
    assert.equal(fromLink.filmId, 'rwf_film_privacy');
    assert.deepEqual(fromLink.ignoredOfferKeys.sort(), ['commercialReady', 'duration', 'enabled', 'price']);

    const first = panes();
    assert.equal(first.areaSqFt, 24);
    assert.equal(first.areaStatus, 'area_only');
    assert.equal(first.paneCount, 2);
    assert.equal(first.totalCents, null);
    assert.equal(first.priceCents, null);
    assert.equal(first.compatibility, null);
    assert.equal(first.bookable, false);
    assert.equal(first.enabled, false);
    assert.equal(first.canConfirmTime, false);
    assert.equal(first.durationMinutes, null);
    assert.equal(first.demoDurationMinutes, null);
    assert.equal(first.glassTypeLabel, "I don't know");
    assert.match(first.nightPrivacyNote, /At night/);
    assert.match(first.nightPrivacyNote, /not protection against intrusion/);

    const repeated = panes({
      rows: [
        { quantity: 2, width: 36, height: 48, unit: 'in' },
        { quantity: 2, width: 36, height: 48, unit: 'in' },
      ],
    });
    assert.equal(repeated.areaSqFt, 48);

    const mixed = panes({
      filmId: 'rwf_film_solar',
      glassTypeId: 'rwf_glass_double',
      rows: [
        { quantity: 2, width: 36, height: 48, unit: 'in' },
        { quantity: 1, width: 3, height: 4, unit: 'ft' },
      ],
      price: 5000,
      amountCents: 5000,
      enabled: true,
      commercialReady: true,
      compatible: true,
      durationMinutes: 180,
    });
    assert.equal(mixed.areaSqFt, 36);
    assert.equal(mixed.totalCents, null);
    assert.equal(mixed.compatibility, null);
    assert.equal(mixed.nightPrivacy, false);
    assert.equal(mixed.durationMinutes, null);
    assert.ok(mixed.ignoredInputs.includes('commercialReady'));

    assert.equal(panes({ rows: [{ quantity: 1, width: 36, height: 48, unit: '' }] }).areaSqFt, null);
    assert.equal(panes({ rows: [{ quantity: 1, width: 36, height: 48 }] }).areaStatus, 'measurement_needed');
    assert.notEqual(panes({ rows: [] }).areaSqFt, 0);
  });
});

describe('residential window film page', () => {
  const page = read('residential-window-film.html');

  it('is a noindex preview outside the sitemap and production nav', () => {
    assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(page, /<h1 id="rwf-title">Comfort and privacy for home glass\.<\/h1>/);
    assert.match(page, /Solar control/);
    assert.match(page, /Privacy/);
    assert.match(page, /Decorative \/ frosted/);
    assert.match(page, /I don't know/);
    assert.match(page, /At night, when the lights are on inside/);
    assert.match(page, /not protection against intrusion/);
    assert.match(page, /Illustration only\. Not a Cardetail1 residential installation\./);
    assert.doesNotMatch(page, /Most popular|lifetime|3M|Llumar|XPEL|SunTek|id="bk-ov"|\$\d|%|\bguaranteed\b/i);
    assert.doesNotMatch(read('sitemap.xml'), /residential-window-film/);
    assert.doesNotMatch(read('index.html'), /href="\/residential-window-film/);
    assert.match(read('index.html'), /residential-window-film-booking-preview\.js/);
    assert.doesNotMatch(read('assets/partials/specialty-public-footer.html'), /residential-window-film/);
    const rule = parseRedirects(read('netlify.toml')).find((item) => item.from === '/residential-window-film.html');
    assert.equal(rule.to, '/residential-window-film');
    assert.equal(rule.status, 301);
    assert.equal(rule.force, true);
    assert.match(read('netlify.toml'), /for = "\/residential-window-film"/);
    assert.doesNotMatch(read('assets/residential-window-film-preview.js'), /fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|gtag\(|stripe|submit-booking/i);
    assert.match(read('netlify/functions/submit-booking.js'), /residentialWindowFilmBlock/);
    assert.match(read('netlify/functions/create-setup-intent.js'), /residentialWindowFilmBlock/);
    assert.match(read('netlify/functions/booking-availability.js'), /residentialWindowFilmBlock/);
  });

  it('keeps the film choice and drops a price in the link', () => {
    const dom = new JSDOM(page, {
      url: 'https://cardetail1.com/residential-window-film?film=privacy&price=880&commercialReady=true',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    window.fetch = () => { throw new Error('network'); };
    window.eval(read('assets/residential-window-film-catalog.js'));
    window.eval(read('assets/residential-window-film-preview.js'));
    const { document } = window;
    assert.equal(document.getElementById('rwf-url-note').hidden, false);
    assert.equal(document.body.textContent.includes('880'), false);
    assert.equal(document.querySelector('[data-rwf-film="rwf_film_privacy"]').getAttribute('aria-pressed'), 'true');
    assert.equal(document.getElementById('rwf-open-booking').disabled, false);
    assert.equal(
      window.CD1ResidentialWindowFilmPreview.bookingUrl(),
      '/?embed=1&rwfpreview=1&film=rwf_film_privacy'
    );
    document.querySelector('[data-rwf-film="rwf_film_decorative"]').click();
    assert.equal(
      window.CD1ResidentialWindowFilmPreview.bookingUrl(),
      '/?embed=1&rwfpreview=1&film=rwf_film_decorative'
    );
  });
});

describe('residential booking preview', () => {
  function mount(search) {
    const html = `<!DOCTYPE html><body>
      <div id="bk-ov"><div class="bprog" id="bprog"></div><div class="bcontent">
        <div class="bsec on" id="bs4">
          <div class="fg"><input id="f-first"></div>
          <div class="fg"><input id="f-last"></div>
          <div class="fg"><input id="f-phone"></div>
          <div class="fg"><input id="f-email"></div>
          <div class="fg"><input id="f-addr"></div>
          <input id="f-date" type="date">
          <div id="booking-sms-consent"><input id="sms-consent-ok" type="checkbox"></div>
        </div>
      </div></div>
    </body>`;
    const dom = new JSDOM(html, {
      url: 'https://cardetail1.com/?' + search,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    const store = window.localStorage;
    store.setItem('cd1_booking_progress', '{"service":"detailing"}');
    store.setItem('cd1_bookings', '[]');
    window.CD1BookingProgress = {
      resumeFromQuery() { return { opened: true, restored: true }; },
      applySnapshot() { return true; },
      persist() { store.setItem('cd1_booking_progress', '{"service":"residential_window_film"}'); },
    };
    window.fetch = () => { throw new Error('network'); };
    window.eval(read('assets/residential-window-film-catalog.js'));
    window.eval(read('assets/residential-window-film-booking-preview.js'));
    return { window, document: window.document };
  }

  function setRow(document, index, values) {
    const row = document.querySelectorAll('[data-rwfb-row]')[index];
    row.querySelector('[data-field="quantity"]').value = values.quantity;
    row.querySelector('[data-field="width"]').value = values.width;
    row.querySelector('[data-field="height"]').value = values.height;
    row.querySelector('[data-field="unit"]').value = values.unit;
    row.querySelector('[data-field="unit"]').dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  }

  it('reuses contact and address, repeats a size, and does not overwrite detailing', async () => {
    const { window, document } = mount('embed=1&rwfpreview=1&film=privacy&price=880&commercialReady=true');
    assert.equal(window.CD1BookingProgress.resumeFromQuery().reason, 'residential_window_film_preview');
    assert.equal(document.querySelector('input[name="rwfb-film"][value="rwf_film_privacy"]').checked, true);
    assert.equal(document.body.textContent.includes('880'), false);
    assert.match(document.body.textContent, /I don't know/);

    document.querySelector('[data-rwfb-step="film"] [data-rwfb-next]').click();
    document.querySelector('input[name="rwfb-glass"][value="rwf_glass_unknown"]').checked = true;
    document.getElementById('rwfb-floor').value = '2';
    document.getElementById('rwfb-access').value = 'Stairs';
    setRow(document, 0, { quantity: '2', width: '36', height: '48', unit: 'in' });
    assert.equal(document.getElementById('rwfb-area-figure').textContent, '24 sq ft');
    document.querySelector('[data-rwfb-repeat]').click();
    assert.equal(document.querySelectorAll('[data-rwfb-row]').length, 2);
    assert.equal(document.getElementById('rwfb-area-figure').textContent, '48 sq ft');
    setRow(document, 1, { quantity: '1', width: '3', height: '4', unit: 'ft' });
    assert.equal(document.getElementById('rwfb-area-figure').textContent, '36 sq ft');
    assert.match(document.getElementById('rwfb-night').textContent, /At night/);
    assert.doesNotMatch(document.getElementById('rwfb-area').textContent, /\$/);

    document.querySelector('input[name="rwfb-film"][value="rwf_film_solar"]').checked = true;
    document.querySelector('input[name="rwfb-film"][value="rwf_film_solar"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(document.getElementById('rwfb-night'), null);
    assert.equal(document.getElementById('rwfb-area-figure').textContent, '36 sq ft');

    document.querySelector('[data-rwfb-step="measure"] [data-rwfb-back]').click();
    assert.equal(document.querySelector('[data-rwfb-step="film"]').hidden, false);
    document.querySelector('[data-rwfb-step="film"] [data-rwfb-next]').click();
    assert.equal(document.querySelectorAll('[data-rwfb-row]').length, 2);
    document.querySelector('[data-rwfb-step="measure"] [data-rwfb-next]').click();
    document.getElementById('f-first').value = 'Ana';
    document.getElementById('f-last').value = 'Rios';
    document.getElementById('f-phone').value = '2015550100';
    document.getElementById('f-email').value = 'ana@example.com';
    document.getElementById('f-addr').value = '10 Broad Avenue';
    document.querySelector('[data-rwfb-step="contact"] [data-rwfb-back]').click();
    assert.equal(document.getElementById('rwfb-floor').value, '2');
    document.querySelector('[data-rwfb-step="measure"] [data-rwfb-next]').click();
    document.querySelector('[data-rwfb-step="contact"] [data-rwfb-next]').click();
    assert.match(document.getElementById('rwfb-review-body').textContent, /36 sq ft/);
    assert.match(document.getElementById('rwfb-review-body').textContent, /10 Broad Avenue/);
    assert.match(document.getElementById('rwfb-review-body').textContent, /No price is set/);
    assert.equal(document.getElementById('rwfb-finish').textContent, 'Finish preview');
    document.getElementById('rwfb-finish').click();
    assert.match(document.getElementById('rwfb-result').textContent, /Demo completed\. No appointment was created\./);
    assert.doesNotMatch(document.getElementById('rwfb-result').textContent, /\$/);

    const blocked = await window.fetch('/.netlify/functions/submit-booking', { method: 'POST' });
    assert.equal(blocked.status, 403);
    assert.equal(window.localStorage.getItem('cd1_booking_progress'), '{"service":"detailing"}');
    assert.equal(window.localStorage.getItem('cd1_bookings'), '[]');
    window.CD1BookingProgress.persist();
    assert.equal(window.localStorage.getItem('cd1_booking_progress'), '{"service":"detailing"}');
  });
});

describe('residential server refusal', () => {
  it('rejects booking, card setup, and availability from client-supplied switches', async () => {
    const submit = require('../netlify/functions/submit-booking');
    const setup = require('../netlify/functions/create-setup-intent');
    const availability = require('../netlify/functions/booking-availability');
    const booking = await submit.handler({
      httpMethod: 'POST',
      headers: { host: 'localhost' },
      body: JSON.stringify({
        firstName: 'Ana',
        phone: '2015550100',
        serviceFamily: 'residential_window_film',
        filmId: 'rwf_film_solar',
        enabled: true,
        commercialReady: true,
        bookable: true,
        amountCents: 5000,
        durationMinutes: 90,
        areaSqFt: 36,
      }),
    });
    assert.equal(booking.statusCode, 403);
    assert.equal(JSON.parse(booking.body).error, 'residential_window_film_disabled');
    assert.equal(JSON.parse(booking.body).bookingCreated, false);
    assert.equal(JSON.parse(booking.body).paymentCreated, false);

    const detailing = await submit.handler({
      httpMethod: 'POST',
      headers: { host: 'localhost' },
      body: JSON.stringify({ cat: 'cars', pkgId: 'full', commercialReady: true, enabled: true }),
    });
    assert.notEqual(JSON.parse(detailing.body).error, 'residential_window_film_disabled');
    assert.notEqual(JSON.parse(detailing.body).error, 'window_tint_disabled');

    const card = await setup.handler({
      httpMethod: 'POST',
      headers: { host: 'localhost' },
      body: JSON.stringify({
        bookingId: 'CD1-1',
        filmId: 'rwf_film_privacy',
        commercialReady: true,
        enabled: true,
        amountCents: 5000,
      }),
    });
    assert.equal(card.statusCode, 403);
    assert.equal(JSON.parse(card.body).error, 'residential_window_film_disabled');
    assert.equal(JSON.parse(card.body).paymentCreated, false);

    const slots = await availability.handler({
      httpMethod: 'GET',
      headers: { host: 'localhost' },
      queryStringParameters: {
        commercialReady: 'true',
        enabled: 'true',
        price: '5000',
        filmId: 'rwf_film_decorative',
      },
    });
    assert.equal(slots.statusCode, 403);
    assert.equal(JSON.parse(slots.body).error, 'residential_window_film_disabled');
    assert.equal(JSON.parse(slots.body).bookingCreated, false);
  });
});
