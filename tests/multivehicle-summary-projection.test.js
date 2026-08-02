/**
 * Release A — multi-vehicle booking summary projection.
 *
 * Regression fixture is the real production booking CD1-MSC8D3IS-9NPP, which
 * rendered ONLY the boat on Review & Submit with a $677 "package price"
 * (215 + 462 — the cart-wide package reducer pinned onto one vehicle's line).
 *
 * Prefers real execution (shared module + the shipped fillConfirm in jsdom)
 * over source-text assertions.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const lineItems = require('../assets/booking-line-items.js');

/** Production evidence — booking CD1-MSC8D3IS-9NPP. */
const PROD_TWO_VEHICLE = [
  {
    vehicleId: 'veh_bronco',
    cat: 'cars',
    vehicleLabel: '2025 Ford Bronco',
    pkgName: 'Maintenance Detail',
    basePrice: 215,
    addons: [
      { id: 'pet_hair', name: 'Pet Hair Removal', price: 95, qty: 1 },
      { id: 'odor', name: 'Odor Treatment & Sanitize', price: 90, qty: 1 },
    ],
    addonTotal: 185,
    subtotal: 400,
  },
  {
    vehicleId: 'veh_boat',
    cat: 'boats',
    vehicleLabel: '2023 Yamaha Boats 222S — 22 ft',
    lengthFt: 22,
    pkgName: 'Essential Marine',
    basePrice: 462,
    addons: [{ id: 'rainx', name: 'Rain-X Glass Treatment', price: 25, qty: 1 }],
    addonTotal: 25,
    subtotal: 487,
  },
];

const GRAND_TOTAL = 887;

// ── 1. Canonical projection ──────────────────────────────────────────────────

describe('multi-vehicle line-item projection (execution)', () => {
  it('projects both production vehicles exactly once, in cart order', () => {
    const { items, itemsSubtotal, vehicleCount } = lineItems.projectBooking({ vehicles: PROD_TWO_VEHICLE });
    assert.equal(vehicleCount, 2);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.label), [
      '2025 Ford Bronco',
      '2023 Yamaha Boats 222S — 22 ft',
    ]);
    assert.equal(itemsSubtotal, GRAND_TOTAL);
  });

  it('keeps each package price on its own vehicle — never the combined 677', () => {
    const { items } = lineItems.projectBooking({ vehicles: PROD_TWO_VEHICLE });
    assert.equal(items[0].packageName, 'Maintenance Detail');
    assert.equal(items[0].packagePrice, 215);
    assert.equal(items[1].packageName, 'Essential Marine');
    assert.equal(items[1].packagePrice, 462);
    for (const item of items) {
      assert.notEqual(item.packagePrice, 677, 'combined package sum must never be one vehicle price');
    }
  });

  it('attaches every add-on to the correct vehicle', () => {
    const { items } = lineItems.projectBooking({ vehicles: PROD_TWO_VEHICLE });
    assert.deepEqual(items[0].addons.map((a) => a.name), ['Pet Hair Removal', 'Odor Treatment & Sanitize']);
    assert.deepEqual(items[0].addons.map((a) => a.lineTotal), [95, 90]);
    assert.deepEqual(items[1].addons.map((a) => a.name), ['Rain-X Glass Treatment']);
    assert.deepEqual(items[1].addons.map((a) => a.lineTotal), [25]);
  });

  it('per-vehicle subtotals are $400 / $487 and sum to the $887 approved total', () => {
    const { items, itemsSubtotal } = lineItems.projectBooking({ vehicles: PROD_TWO_VEHICLE });
    assert.equal(items[0].subtotal, 400);
    assert.equal(items[1].subtotal, 487);
    assert.equal(items.reduce((s, i) => s + i.subtotal, 0), GRAND_TOTAL);
    assert.equal(itemsSubtotal, GRAND_TOTAL);
  });

  it('subtotal equals package + add-ons for every item', () => {
    const { items } = lineItems.projectBooking({ vehicles: PROD_TWO_VEHICLE });
    for (const item of items) {
      const addonSum = item.addons.reduce((s, a) => s + a.lineTotal, 0);
      assert.equal(item.addonTotal, addonSum);
      assert.equal(item.subtotal, item.packagePrice + addonSum);
    }
  });

  it('single-vehicle bookings are unchanged', () => {
    const { items, itemsSubtotal } = lineItems.projectBooking({ vehicles: [PROD_TWO_VEHICLE[0]] });
    assert.equal(items.length, 1);
    assert.equal(items[0].subtotal, 400);
    assert.equal(itemsSubtotal, 400);
  });

  it('three-vehicle bookings itemize without collapsing', () => {
    const third = {
      vehicleId: 'veh_rv', vehicleLabel: '2019 Airstream Flying Cloud', lengthFt: 27,
      pkgName: 'RV Refresh', basePrice: 640, addons: [], addonTotal: 0, subtotal: 640,
    };
    const { items, itemsSubtotal } = lineItems.projectBooking({ vehicles: [...PROD_TWO_VEHICLE, third] });
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.subtotal), [400, 487, 640]);
    assert.equal(itemsSubtotal, 1527);
    assert.equal(new Set(items.map((i) => i.key)).size, 3, 'each item keeps a distinct stable key');
  });

  it('legacy single-vehicle payloads without vehicles[] still itemize', () => {
    const { items } = lineItems.projectBooking({
      vehicle: '2018 Honda Accord', package: 'Full Detail', packagePrice: 260,
      addons: [{ name: 'Engine Bay', price: 40, qty: 1 }], addonTotal: 40,
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].label, '2018 Honda Accord');
    assert.equal(items[0].packagePrice, 260);
    assert.equal(items[0].subtotal, 300);
  });
});

// ── 2. Duplicated vehicle dimensions ─────────────────────────────────────────

describe('vehicle dimension de-duplication', () => {
  it('does not append a length the label already states (22 FT · 22 FT)', () => {
    assert.equal(
      lineItems.vehicleLabel({ vehicleLabel: '2023 Yamaha Boats 222S — 22 ft', lengthFt: 22 }),
      '2023 Yamaha Boats 222S — 22 ft'
    );
    assert.equal(lineItems.vehicleLabel({ vehicleLabel: 'Sea Ray 22FT', lengthFt: 22 }), 'Sea Ray 22FT');
    assert.equal(lineItems.vehicleLabel({ vehicleLabel: "Boston Whaler 22'", lengthFt: 22 }), "Boston Whaler 22'");
  });

  it('still appends a length the label omits', () => {
    assert.equal(
      lineItems.vehicleLabel({ vehicleLabel: '2023 Yamaha Boats 222S', lengthFt: 22 }),
      '2023 Yamaha Boats 222S — 22 ft'
    );
  });

  it('a model number containing the digits is not mistaken for a length', () => {
    assert.equal(lineItems.labelStatesLength('2023 Yamaha Boats 222S', 22), false);
    assert.equal(lineItems.labelStatesLength('Regal 26 Express', 2), false);
  });
});

// ── 3. Rendered summary markup ───────────────────────────────────────────────

describe('rendered summary markup', () => {
  const html = lineItems.renderSummaryHtml(lineItems.projectBooking({ vehicles: PROD_TWO_VEHICLE }).items);

  it('shows each vehicle exactly once', () => {
    assert.equal((html.match(/2025 Ford Bronco/g) || []).length, 1);
    assert.equal((html.match(/2023 Yamaha Boats 222S/g) || []).length, 1);
    assert.equal((html.match(/class="bkli-vehicle"/g) || []).length, 2);
  });

  it('never prints the combined 677 package figure', () => {
    assert.doesNotMatch(html, /\$677/);
  });

  it('prints both per-vehicle subtotals', () => {
    assert.match(html, /Vehicle subtotal<\/span><span class="ov">\$400\.00/);
    assert.match(html, /Vehicle subtotal<\/span><span class="ov">\$487\.00/);
  });

  it('escapes vehicle and add-on text', () => {
    const evil = lineItems.renderSummaryHtml(lineItems.projectBooking({
      vehicles: [{ vehicleLabel: '<img src=x onerror=alert(1)>', pkgName: 'A&B', basePrice: 10, addons: [], subtotal: 10 }],
    }).items);
    assert.doesNotMatch(evil, /<img src=x/);
    assert.match(evil, /&lt;img src=x/);
    assert.match(evil, /A&amp;B/);
  });
});

// ── 4. Text / email itemization ──────────────────────────────────────────────

describe('email itemization', () => {
  const items = lineItems.projectBooking({ vehicles: PROD_TWO_VEHICLE }).items;

  it('text lines carry both vehicles with their own packages and subtotals', () => {
    const text = lineItems.summaryTextLines(items).join('\n');
    assert.match(text, /2025 Ford Bronco/);
    assert.match(text, /Maintenance Detail: \$215\.00/);
    assert.match(text, /Pet Hair Removal: \$95\.00/);
    assert.match(text, /Odor Treatment & Sanitize: \$90\.00/);
    assert.match(text, /Vehicle subtotal: \$400\.00/);
    assert.match(text, /2023 Yamaha Boats 222S/);
    assert.match(text, /Essential Marine: \$462\.00/);
    assert.match(text, /Rain-X Glass Treatment: \$25\.00/);
    assert.match(text, /Vehicle subtotal: \$487\.00/);
    assert.doesNotMatch(text, /677/);
  });

  it('email html carries both vehicles exactly once', () => {
    const emailHtml = lineItems.summaryEmailHtml(items);
    assert.equal((emailHtml.match(/2025 Ford Bronco/g) || []).length, 1);
    assert.equal((emailHtml.match(/2023 Yamaha Boats 222S/g) || []).length, 1);
    assert.match(emailHtml, /Vehicle subtotal: <strong>\$400\.00<\/strong>/);
    assert.match(emailHtml, /Vehicle subtotal: <strong>\$487\.00<\/strong>/);
  });
});

// ── 4b. Transactional email, executed ────────────────────────────────────────

describe('transactional email itemizes every vehicle (execution)', () => {
  const {
    buildEmailContent,
    EVENT_REQUEST_RECEIVED,
    EVENT_CONFIRMED,
    serviceItemization,
  } = require('../netlify/lib/booking-transactional-notifications');

  const twoVehicleBooking = {
    id: 'CD1-TEST-2VEH',
    firstName: 'Jamie', lastName: 'Rivera',
    package: 'Maintenance Detail', vehicle: '2025 Ford Bronco',
    preferredDate: '2026-08-12', confirmedDate: '2026-08-12',
    confirmedTimeWindow: '9:00–11:00 AM',
    totalPrice: GRAND_TOTAL,
    vehicles: PROD_TWO_VEHICLE,
  };

  it('request-received email lists both vehicles with their own packages', () => {
    const content = buildEmailContent(EVENT_REQUEST_RECEIVED, twoVehicleBooking, 'https://example.com/a');
    for (const body of [content.text, content.html]) {
      assert.match(body, /2025 Ford Bronco/);
      assert.match(body, /2023 Yamaha Boats 222S/);
      assert.match(body, /Maintenance Detail/);
      assert.match(body, /Essential Marine/);
      assert.match(body, /Pet Hair Removal/);
      assert.match(body, /Rain-X Glass Treatment/);
      assert.doesNotMatch(body, /677/);
    }
  });

  it('confirmed email lists both vehicles and per-vehicle subtotals', () => {
    const content = buildEmailContent(EVENT_CONFIRMED, twoVehicleBooking, 'https://example.com/b');
    assert.match(content.text, /Vehicle subtotal: \$400\.00/);
    assert.match(content.text, /Vehicle subtotal: \$487\.00/);
    assert.match(content.html, /\$400\.00/);
    assert.match(content.html, /\$487\.00/);
    assert.equal((content.html.match(/2025 Ford Bronco/g) || []).length, 1);
    assert.equal((content.html.match(/2023 Yamaha Boats 222S/g) || []).length, 1);
  });

  it('single-vehicle emails keep their existing Vehicle / Service copy', () => {
    const single = { ...twoVehicleBooking, vehicles: [PROD_TWO_VEHICLE[0]] };
    assert.equal(serviceItemization(single), null);
    const content = buildEmailContent(EVENT_CONFIRMED, single, 'https://example.com/c');
    assert.match(content.text, /Vehicle: /);
    assert.match(content.text, /Service: /);
    assert.match(content.html, /<li>Vehicle: /);
  });

  it('multi-vehicle email escapes customer-controlled vehicle text', () => {
    const hostile = {
      ...twoVehicleBooking,
      vehicles: [
        { ...PROD_TWO_VEHICLE[0], vehicleLabel: '<img onerror=alert(1)>' },
        PROD_TWO_VEHICLE[1],
      ],
    };
    const content = buildEmailContent(EVENT_CONFIRMED, hostile, 'https://example.com/d');
    assert.doesNotMatch(content.html, /<img onerror/);
    assert.match(content.html, /&lt;img onerror/);
  });
});

// ── 5. The shipped fillConfirm, executed ─────────────────────────────────────

/** Slice a top-level `function name(...) { ... }` out of the inline page script. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in index.html`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
  // eslint-disable-next-line no-unreachable
  void open;
}

function extractSection(src, id) {
  const start = src.indexOf(`<div class="bsec" id="${id}">`);
  assert.notEqual(start, -1, `#${id} should exist`);
  const after = src.indexOf('<!-- ', start + 10);
  return src.slice(start, after === -1 ? src.length : after);
}

if (JSDOM) {
  describe('fillConfirm renders the production two-vehicle booking (real DOM)', () => {
    const src = read('index.html');
    const confirmMarkup = extractSection(src, 'bs6');
    const moduleSrc = read('assets/booking-line-items.js');

    function mount(vehicles, { travelFee = 0 } = {}) {
      const dom = new JSDOM(
        `<!DOCTYPE html><html><body><div class="booking-modal">
          ${confirmMarkup}
          <input id="f-first" value="Jamie"><input id="f-last" value="Rivera">
          <input id="f-phone" value="551-555-0134"><input id="f-email" value="jamie.rivera@example.com">
          <input id="f-addr" value="12 Palisade Ave"><input id="f-date" value="2026-08-12">
          <input id="f-time" value="8:00 AM">
        </div>
        <script>${moduleSrc}</script>
        </body></html>`,
        { runScripts: 'dangerously', url: 'https://example.com/' }
      );
      const { window } = dom;
      window.ST = {
        vehicles, addons: [], cat: '', pkg: null, vehicleLabel: '',
        basePrice: 0, addonTotal: 0, payMethod: 'card_onsite', offerPreview: null,
      };
      window.getTravelFeeAmount = () => travelFee;
      window.getVehicleVisualKey = () => 'sedan';
      window.VEHICLE_VISUALS = { sedan: { img: '/a.png', alt: 'car' } };
      window.CATEGORY_VISUALS = {};
      window.buildCurrentVehicleItem = () => null;

      const glue = [
        extractFunction(src, 'bkMoney'),
        extractFunction(src, 'bkEsc'),
        extractFunction(src, 'bkProjectVehicles'),
        extractFunction(src, 'bkRenderVehicleSummary'),
        extractFunction(src, 'fillConfirm'),
      ].join('\n');
      window.eval(`${glue}\nwindow.fillConfirm = fillConfirm;`);
      window.fillConfirm();
      return window.document;
    }

    it('renders Bronco $400, Boat $487 and a $887 grand total', () => {
      const doc = mount(PROD_TWO_VEHICLE);
      const cards = doc.querySelectorAll('#c-vehicle-cards .bkli-vehicle');
      assert.equal(cards.length, 2, 'one card per booked vehicle');

      const first = cards[0].textContent;
      assert.match(first, /2025 Ford Bronco/);
      assert.match(first, /Maintenance Detail/);
      assert.match(first, /\$215\.00/);
      assert.match(first, /Pet Hair Removal/);
      assert.match(first, /\$95\.00/);
      assert.match(first, /Odor Treatment & Sanitize/);
      assert.match(first, /\$90\.00/);
      assert.match(first, /Vehicle subtotal/);
      assert.match(first, /\$400\.00/);

      const second = cards[1].textContent;
      assert.match(second, /2023 Yamaha Boats 222S/);
      assert.match(second, /Essential Marine/);
      assert.match(second, /\$462\.00/);
      assert.match(second, /Rain-X Glass Treatment/);
      assert.match(second, /\$25\.00/);
      assert.match(second, /\$487\.00/);

      assert.equal(doc.getElementById('c-total').textContent, '$887.00');
    });

    it('shows the Ford Bronco — the vehicle production dropped', () => {
      const doc = mount(PROD_TWO_VEHICLE);
      const body = doc.getElementById('c-vehicle-cards').textContent;
      assert.equal((body.match(/2025 Ford Bronco/g) || []).length, 1);
      assert.equal((body.match(/2023 Yamaha Boats 222S/g) || []).length, 1);
    });

    it('never renders the combined $677 package price', () => {
      const doc = mount(PROD_TWO_VEHICLE);
      assert.doesNotMatch(doc.querySelector('.oc').textContent, /677/);
    });

    it('renders the boat length once, not "22 ft · 22 ft"', () => {
      const doc = mount(PROD_TWO_VEHICLE);
      const label = doc.querySelectorAll('#c-vehicle-cards .bkli-vehicle-name')[1].textContent;
      assert.equal((label.match(/22\s*ft/gi) || []).length, 1);
    });

    it('the Estimated total label is not white-on-light', () => {
      const doc = mount(PROD_TWO_VEHICLE);
      const label = [...doc.querySelectorAll('.oc .ol')].find((el) => /Estimated total/.test(el.textContent));
      assert.ok(label, 'Estimated total label present');
      assert.ok(label.classList.contains('bkli-total-label'));
      assert.doesNotMatch(label.getAttribute('style') || '', /var\(--white\)/);
    });

    it('single-vehicle review is unchanged and needs no subtotal row', () => {
      const doc = mount([PROD_TWO_VEHICLE[0]]);
      const cards = doc.querySelectorAll('#c-vehicle-cards .bkli-vehicle');
      assert.equal(cards.length, 1);
      assert.doesNotMatch(cards[0].textContent, /Vehicle subtotal/);
      assert.equal(doc.getElementById('c-total').textContent, '$400.00');
    });

    it('travel fee still lands on the grand total, not a vehicle line', () => {
      const doc = mount(PROD_TWO_VEHICLE, { travelFee: 45 });
      assert.equal(doc.getElementById('c-total').textContent, '$932.00');
      assert.doesNotMatch(doc.getElementById('c-vehicle-cards').textContent, /adjustment/i);
    });
  });

  describe('showSuccess renders the submitted booking (real DOM)', () => {
    const src = read('index.html');
    const successMarkup = extractSection(src, 'bs-ok');
    const moduleSrc = read('assets/booking-line-items.js');

    function mountSuccess(payload) {
      const dom = new JSDOM(
        `<!DOCTYPE html><html><body><div class="booking-modal">
          ${successMarkup}
          <input id="f-date" value="2026-08-12">
        </div><script>${moduleSrc}</script></body></html>`,
        { runScripts: 'dangerously', url: 'https://example.com/' }
      );
      const { window } = dom;
      window.clearDraftSaveTokenState = () => {};
      window.mailtoForBooking = () => 'mailto:test@example.com';
      window.smsForBooking = () => 'sms:5551234567';
      const glue = [
        extractFunction(src, 'bkMoney'),
        extractFunction(src, 'bkEsc'),
        extractFunction(src, 'bkProjectVehicles'),
        extractFunction(src, 'bkRenderVehicleSummary'),
        extractFunction(src, 'showSuccess'),
      ].join('\n');
      window.eval(`${glue}\nwindow.showSuccess = showSuccess;`);
      window.showSuccess(payload);
      return window.document;
    }

    const submittedPayload = {
      id: 'CD1-MSC8D3IS-9NPP',
      totalPrice: GRAND_TOTAL,
      preferredDate: '2026-08-12',
      vehicles: PROD_TWO_VEHICLE,
    };

    it('confirmation screen lists both vehicles with their own subtotals', () => {
      const doc = mountSuccess(submittedPayload);
      const cards = doc.querySelectorAll('#ok-vehicle-cards .bkli-vehicle');
      assert.equal(cards.length, 2);
      assert.match(cards[0].textContent, /2025 Ford Bronco/);
      assert.match(cards[0].textContent, /Maintenance Detail/);
      assert.match(cards[0].textContent, /\$400\.00/);
      assert.match(cards[1].textContent, /2023 Yamaha Boats 222S/);
      assert.match(cards[1].textContent, /Essential Marine/);
      assert.match(cards[1].textContent, /\$487\.00/);
      assert.equal(doc.getElementById('ok-total').textContent, '$887.00');
    });

    it('confirmation screen never shows the combined $677 package price', () => {
      const doc = mountSuccess(submittedPayload);
      assert.doesNotMatch(doc.getElementById('bs-ok').textContent, /677/);
    });

    it('confirmation screen shows each vehicle exactly once', () => {
      const doc = mountSuccess(submittedPayload);
      const body = doc.getElementById('ok-vehicle-cards').textContent;
      assert.equal((body.match(/2025 Ford Bronco/g) || []).length, 1);
      assert.equal((body.match(/2023 Yamaha Boats 222S/g) || []).length, 1);
      assert.equal((body.match(/22\s*ft/gi) || []).length, 1);
    });

    it('single-vehicle confirmation is unchanged', () => {
      const doc = mountSuccess({ ...submittedPayload, totalPrice: 400, vehicles: [PROD_TWO_VEHICLE[0]] });
      const cards = doc.querySelectorAll('#ok-vehicle-cards .bkli-vehicle');
      assert.equal(cards.length, 1);
      assert.doesNotMatch(cards[0].textContent, /Vehicle subtotal/);
      assert.equal(doc.getElementById('ok-total').textContent, '$400.00');
    });

    it('a three-vehicle booking renders all three on confirmation', () => {
      const third = {
        vehicleId: 'veh_rv', vehicleLabel: '2019 Airstream Flying Cloud', lengthFt: 27,
        pkgName: 'RV Refresh', basePrice: 640, addons: [], addonTotal: 0, subtotal: 640,
      };
      const doc = mountSuccess({ ...submittedPayload, totalPrice: 1527, vehicles: [...PROD_TWO_VEHICLE, third] });
      assert.equal(doc.querySelectorAll('#ok-vehicle-cards .bkli-vehicle').length, 3);
      assert.equal(doc.getElementById('ok-total').textContent, '$1527.00');
    });
  });
}

// ── 6. Page wiring guards ────────────────────────────────────────────────────

describe('every booking page loads the shared line-item module', () => {
  const pages = fs.readdirSync(root)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => read(f).includes('function fillConfirm('));

  it('finds the duplicated booking flow', () => {
    assert.ok(pages.length >= 13, `expected the flow on 13+ pages, found ${pages.length}`);
  });

  for (const page of pages) {
    it(`${page} loads booking-line-items.js and booking-summary.css`, () => {
      const html = read(page);
      assert.match(html, /assets\/booking-line-items\.js/, `${page} must load the shared module`);
      assert.match(html, /assets\/booking-summary\.css/, `${page} must load the summary styles`);
    });

    it(`${page} no longer pins a cart-wide package price to one vehicle`, () => {
      const html = read(page);
      assert.doesNotMatch(html, /getElementById\('c-pprice'\)/, `${page} must not render a single package-price row`);
      assert.doesNotMatch(html, /getElementById\('c-addon-rows'\)/, `${page} must not render cart-wide add-on rows`);
      assert.match(html, /getElementById\('c-vehicle-cards'\)/, `${page} must render per-vehicle cards`);
    });

    it(`${page} has no white-on-light Estimated total label`, () => {
      const html = read(page);
      assert.doesNotMatch(
        html,
        /<span class="ol" style="color:var\(--white\);font-weight:600">Estimated total/,
        `${page} Estimated total label must not be var(--white) on the light modal`
      );
    });
  }
});
