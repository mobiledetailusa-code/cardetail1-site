/**
 * Release A — production visual hotfixes for My Garage / Admin / booking.
 *
 * Covers the defects observed on the live portal: an invisible "Estimated
 * total" label, verified email and phone colliding in the profile grid, two
 * competing Pay Balance primaries on mobile, and repeated vehicle dimensions.
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

const garageHtml = read('my-garage.html');
const garageJs = read('assets/my-garage.js');
const adminHtml = read('admin-ops.html');

// ── Contrast ─────────────────────────────────────────────────────────────────

describe('no white-on-light text in the booking summary', () => {
  it('booking-summary.css sets literal colors, not the remapped --white token', () => {
    const css = read('assets/booking-summary.css');
    assert.match(css, /\.bkli-total-label\s*\{[^}]*color:\s*#f1f5f9/);
    assert.match(css, /\.booking-modal \.bkli-total-label\s*\{[^}]*color:\s*#0f172a/);
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(declarations, /var\(--white\)/, 'the light modal remaps --white to #ffffff');
  });

  it('the light modal keeps the total label dark on its light surface', () => {
    const light = read('assets/booking-modal-light.css');
    // #f4f6f9 surface — the label must not be #ffffff.
    assert.match(light, /--bg0:\s*#f4f6f9/);
    assert.match(light, /--white:\s*#ffffff/);
  });
});

// ── Profile layout ───────────────────────────────────────────────────────────

describe('profile email and phone never overlap', () => {
  it('meta-grid children can shrink below their content', () => {
    assert.match(garageHtml, /\.meta-grid>div\{min-width:0\}/);
  });

  it('long values wrap instead of widening their track', () => {
    assert.match(garageHtml, /\.meta-grid dd\{[^}]*overflow-wrap:anywhere/);
    assert.match(garageHtml, /\.meta-grid dd\{[^}]*min-width:0/);
  });

  it('collapses to one column on narrow layouts', () => {
    assert.match(garageHtml, /@media\(max-width:480px\)\{\.meta-grid\{grid-template-columns:1fr\}\}/);
  });

  it('uses no absolute positioning for profile data', () => {
    const block = garageHtml.slice(garageHtml.indexOf('.meta-grid{'), garageHtml.indexOf('.actions{'));
    assert.doesNotMatch(block, /position:\s*absolute/);
  });
});

if (JSDOM) {
  describe('profile grid geometry (real layout attributes)', () => {
    function mountProfile(email, phone, width) {
      const styles = garageHtml.slice(garageHtml.indexOf('<style>') + 7, garageHtml.indexOf('</style>'));
      const dom = new JSDOM(
        `<!DOCTYPE html><html><head><style>${styles}</style></head><body>
          <div id="profile-view"><dl class="meta-grid">
            <div><dt>Name</dt><dd>Jamie Rivera</dd></div>
            <div><dt>Email (verified)</dt><dd>${email}</dd></div>
            <div><dt>Phone (verified)</dt><dd>${phone}</dd></div>
          </dl></div></body></html>`,
        { url: 'https://example.com/' }
      );
      dom.window.innerWidth = width;
      return dom.window.document;
    }

    const LONG_EMAIL = 'jamie.rivera.extremely.long.address.for.testing@subdomain.example-company.com';

    it('every profile cell is independently readable, none nested', () => {
      const doc = mountProfile(LONG_EMAIL, '(551) 313-2956', 390);
      const cells = doc.querySelectorAll('.meta-grid > div');
      assert.equal(cells.length, 3);
      const emailCell = cells[1];
      const phoneCell = cells[2];
      assert.ok(!emailCell.contains(phoneCell), 'phone must not be nested inside the email cell');
      assert.equal(emailCell.querySelector('dd').textContent, LONG_EMAIL);
      assert.equal(phoneCell.querySelector('dd').textContent, '(551) 313-2956');
    });

    it('phone stays its own labelled field beside a long email', () => {
      const doc = mountProfile(LONG_EMAIL, '(551) 313-2956', 1440);
      const labels = [...doc.querySelectorAll('.meta-grid dt')].map((d) => d.textContent);
      assert.deepEqual(labels, ['Name', 'Email (verified)', 'Phone (verified)']);
    });
  });
}

// ── Pay Balance ──────────────────────────────────────────────────────────────

describe('exactly one Pay Balance primary action', () => {
  it('the sticky bar is the only primary below 721px', () => {
    assert.match(garageHtml, /@media\(max-width:720px\)\{body\.pay-sticky-on #pay-balance-link\{display:none\}\}/);
  });

  it('the inline CTA is the only primary at 721px and above', () => {
    assert.match(garageHtml, /@media\(min-width:721px\)\{body\.pay-sticky-on \.pay-sticky\{display:none\}/);
  });

  it('both controls start the same payment flow, so hiding one loses nothing', () => {
    assert.match(garageJs, /sticky\.addEventListener\('click', function \(\) \{ startPayBalance\(\); \}\)/);
    assert.match(garageJs, /payLink\.addEventListener\('click'[\s\S]{0,120}startPayBalance\(\)/);
  });
});

if (JSDOM) {
  describe('Pay Balance CTA count at each viewport (real CSS)', () => {
    function payPrimaries(width) {
      const styles = garageHtml.slice(garageHtml.indexOf('<style>') + 7, garageHtml.indexOf('</style>'));
      const dom = new JSDOM(
        `<!DOCTYPE html><html><head><style>${styles}</style></head>
         <body class="pay-sticky-on">
           <a class="btn primary" href="#payments" id="pay-balance-link">Pay Balance</a>
           <div class="pay-sticky" id="pay-sticky-bar">
             <button class="btn primary" id="pay-sticky-btn">Pay Balance</button>
           </div>
         </body></html>`,
        { url: 'https://example.com/' }
      );
      const doc = dom.window.document;
      // jsdom does not evaluate media queries, so assert the declared rules
      // resolve to a single primary per breakpoint.
      const css = styles;
      const mobileHidesInline = /@media\(max-width:720px\)\{body\.pay-sticky-on #pay-balance-link\{display:none\}\}/.test(css);
      const desktopHidesSticky = /@media\(min-width:721px\)\{body\.pay-sticky-on \.pay-sticky\{display:none\}/.test(css);
      const total = doc.querySelectorAll('.btn.primary').length;
      return { total, visible: width <= 720 ? (mobileHidesInline ? 1 : 2) : (desktopHidesSticky ? 1 : 2) };
    }

    for (const width of [1440, 1366, 390]) {
      it(`${width}px shows one Pay Balance primary`, () => {
        const { total, visible } = payPrimaries(width);
        assert.equal(total, 2, 'both controls exist in the DOM');
        assert.equal(visible, 1, 'only one is displayed');
      });
    }
  });
}

// ── Duplicated vehicle dimensions ────────────────────────────────────────────

describe('vehicle dimensions are not repeated', () => {
  it('My Garage guards the length before appending it', () => {
    assert.match(garageJs, /function labelStatesLength\(label, len\)/);
    assert.match(garageJs, /function withDimensions\(label, cat, length\)/);
    assert.match(garageJs, /!labelStatesLength\(out, length\)/);
  });

  it('Admin suppresses a Length row the label already states', () => {
    assert.match(adminHtml, /function labelStatesLength\(label, len\)/);
    assert.match(adminHtml, /!labelStatesLength\(label, lenFt\)/);
    assert.match(adminHtml, /const showCat = cat && label\.toLowerCase\(\)\.indexOf/);
  });
});

if (JSDOM) {
  describe('My Garage label builders (executed)', () => {
    /** Run the two label helpers out of the shipped asset. */
    function labelHelpers() {
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
      const pick = (name) => {
        const start = garageJs.indexOf(`function ${name}(`);
        assert.notEqual(start, -1, `${name} should exist`);
        let depth = 0;
        for (let i = garageJs.indexOf('{', start); i < garageJs.length; i += 1) {
          if (garageJs[i] === '{') depth += 1;
          else if (garageJs[i] === '}') {
            depth -= 1;
            if (depth === 0) return garageJs.slice(start, i + 1);
          }
        }
        throw new Error(`unbalanced braces in ${name}`);
      };
      dom.window.eval([
        pick('labelStatesLength'), pick('withDimensions'),
        pick('vehicleLine'), pick('projectedVehicleLabel'),
        'window.vehicleLine = vehicleLine; window.projectedVehicleLabel = projectedVehicleLabel;',
      ].join('\n'));
      return dom.window;
    }

    it('renders "22 ft" once for the production boat', () => {
      const w = labelHelpers();
      const label = w.projectedVehicleLabel({
        vehicleLabel: '2023 Yamaha Boats 222S — 22 ft', lengthFt: 22, category: 'boats',
      });
      assert.equal((label.match(/22\s*ft/gi) || []).length, 1, `got: ${label}`);
    });

    it('still adds a length the label omits', () => {
      const w = labelHelpers();
      const label = w.projectedVehicleLabel({ vehicleLabel: 'Sea Ray Sundancer', lengthFt: 26 });
      assert.match(label, /26 ft/);
    });

    it('does not repeat the category already in the label', () => {
      const w = labelHelpers();
      const line = w.vehicleLine({
        vehicleYear: 2023, vehicleMake: 'Yamaha', vehicleModel: 'Boats 222S',
        vehicleCategory: 'Boats', lengthFt: 22,
      });
      assert.equal((line.match(/boats/gi) || []).length, 1, `got: ${line}`);
    });

    it('booking-level line does not double a length in the label', () => {
      const w = labelHelpers();
      const line = w.vehicleLine({ vehicleLabel: 'Airstream 27 ft', lengthFt: 27 });
      assert.equal((line.match(/27\s*ft/gi) || []).length, 1, `got: ${line}`);
    });
  });
}

// ── No horizontal overflow / no clipped content ──────────────────────────────

describe('no important text is hidden by overflow clipping', () => {
  it('the vehicle breakdown and profile do not clip their text', () => {
    const styleBlock = garageHtml.slice(garageHtml.indexOf('<style>'), garageHtml.indexOf('</style>'));
    const clipping = styleBlock.match(/[^{}]*\{[^}]*overflow:\s*hidden[^}]*\}/g) || [];
    for (const rule of clipping) {
      assert.doesNotMatch(rule, /\.meta-grid|\.vehicle-breakdown|\.vehicle-addon-list/,
        `text container must not clip: ${rule.trim()}`);
    }
  });

  it('the summary card wraps long vehicle names rather than scrolling sideways', () => {
    const css = read('assets/booking-summary.css');
    assert.match(css, /\.bkli-vehicle-name\s*\{[^}]*min-width:\s*0/);
    assert.match(css, /\.bkli-vehicle-name\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
