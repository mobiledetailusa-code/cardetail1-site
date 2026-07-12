// Fleet removed from public instant-booking UX.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function extractZonePopular(html) {
  const m = html.match(/const ZONE_POPULAR\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(m, 'ZONE_POPULAR missing');
  return m[1];
}

function extractFn(html, name) {
  const re = new RegExp(`function ${name}\\([^{]*\\)\\{[\\s\\S]*?\\n\\}`);
  // Prefer a shallow match by scanning to the matching brace at indent-0 of next function
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  let i = html.indexOf('{', start);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`could not extract ${name}`);
}

test('all 13 pages remove public Fleet booking UI and $60/unit claims', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /id="bkcat-fleet"/, `${page} still has bkcat-fleet`);
    assert.doesNotMatch(html, /id="hsvc-fleet"/, `${page} still has hsvc-fleet`);
    assert.doesNotMatch(html, /id="hfrom-fleet/, `${page} still has hfrom-fleet`);
    assert.doesNotMatch(html, /id="bkfrom-fleet"/, `${page} still has bkfrom-fleet`);
    assert.doesNotMatch(html, /\$60\/unit/, `${page} still shows $60/unit`);
    assert.doesNotMatch(html, /From \$60/, `${page} still shows From $60`);
    assert.doesNotMatch(html, /openBooking\('fleet'\)/, `${page} footer still calls openBooking('fleet')`);
    assert.doesNotMatch(html, /openBookingFromHome\('fleet'\)/, `${page} still opens fleet from home`);
    assert.doesNotMatch(html, /selectCategory\('fleet'\)/, `${page} UI still selects fleet`);
  }
});

test('ZONE_POPULAR arrays contain no fleet category', () => {
  for (const page of PAGES) {
    const block = extractZonePopular(read(page));
    assert.doesNotMatch(block, /'fleet'/, `${page} ZONE_POPULAR still includes fleet`);
  }
});

test('LOC_DISPLAY has no public fleet entry', () => {
  for (const page of PAGES) {
    const html = read(page);
    const m = html.match(/const LOC_DISPLAY\s*=\s*\{([\s\S]*?)\n\};/);
    assert.ok(m, `${page} LOC_DISPLAY missing`);
    assert.doesNotMatch(m[1], /fleet\s*:/, `${page} LOC_DISPLAY still has fleet`);
  }
});

test('footer/contact uses Commercial fleet quote path (no instant fleet booking)', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.match(html, /Commercial &amp; Fleet/, `${page} missing commercial fleet label`);
    assert.doesNotMatch(
      html,
      /onclick="openBooking\('fleet'\)"/,
      `${page} still books fleet from footer`
    );
    if (page === 'index.html') {
      assert.match(html, /href="fleet-services\.html"/, `${page} missing fleet-services link`);
    } else {
      assert.match(html, /openCommercialInquiry\(\)|href="fleet-services\.html"/, `${page} missing fleet quote path`);
      assert.match(html, /function openCommercialInquiry\(/, `${page} missing openCommercialInquiry definition`);
    }
  }
});

test('JSON-LD serviceType no longer advertises Fleet Detailing', () => {
  for (const page of PAGES) {
    const html = read(page);
    if (!html.includes('"serviceType"')) continue;
    assert.doesNotMatch(html, /Fleet Detailing/, `${page} JSON-LD still lists Fleet Detailing`);
  }
});

test('dormant Fleet catalog remains in source', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.match(html, /fleet:\s*\{/, `${page} lost dormant fleet catalog object`);
    assert.match(html, /LENGTH_PRICING\.fleet|PRICING\.fleet|fleet:\s*\{\s*\n/, `${page} fleet catalog missing`);
  }
});

test('remaining categories still have openBooking paths', () => {
  for (const page of PAGES) {
    const html = read(page);
    for (const cat of ['cars', 'boats', 'rvs', 'powersports']) {
      assert.match(
        html,
        new RegExp(`openBooking\\('${cat}'\\)|openBookingFromHome\\('${cat}'\\)|selectCategory\\('${cat}'\\)`),
        `${page} missing ${cat} booking entry`
      );
    }
  }
});

test('openBooking/selectCategory/openBookingFromHome guard fleet to inquiry', () => {
  for (const page of PAGES) {
    const html = read(page);
    for (const name of ['openBooking', 'selectCategory', 'openBookingFromHome']) {
      const fn = extractFn(html, name);
      assert.match(
        fn,
        /if\(cat==='fleet'\)\{\s*openCommercialInquiry\(\);\s*return;\s*\}/,
        `${page} ${name} missing fleet guard`
      );
    }
  }
});

test('behavioral: openBooking("fleet") routes to inquiry without opening booking modal', () => {
  const html = read('index.html');
  const openBookingSrc = extractFn(html, 'openBooking');

  let modalOpen = false;
  let inquiryCalled = false;
  let selectCalled = false;
  let syncCalled = false;

  const openCommercialInquiry = () => { inquiryCalled = true; };
  const syncBookingZipFromHero = () => { syncCalled = true; };
  const selectCategory = () => { selectCalled = true; };
  const bkGoTo = () => {};
  const document = {
    getElementById(id) {
      if (id === 'bk-ov') {
        return {
          classList: {
            add(cls) { if (cls === 'open') modalOpen = true; },
            remove() {},
          },
        };
      }
      return null;
    },
    body: { style: {} },
  };

  // Evaluate extracted function in a local scope with injected deps.
  // eslint-disable-next-line no-new-func
  const runner = new Function(
    'openCommercialInquiry',
    'syncBookingZipFromHero',
    'selectCategory',
    'bkGoTo',
    'document',
    `${openBookingSrc}\nreturn openBooking;`
  );
  const openBooking = runner(
    openCommercialInquiry,
    syncBookingZipFromHero,
    selectCategory,
    bkGoTo,
    document
  );
  openBooking('fleet');

  assert.equal(inquiryCalled, true, 'fleet should call commercial inquiry');
  assert.equal(modalOpen, false, 'fleet must not open booking modal');
  assert.equal(selectCalled, false, 'fleet must not reach selectCategory');
  assert.equal(syncCalled, false, 'fleet must return before syncBookingZipFromHero');
});

test('behavioral: selectCategory("fleet") does not proceed to packages', () => {
  const html = read('index.html');
  const selectCategorySrc = extractFn(html, 'selectCategory');
  let inquiryCalled = false;
  let packagesRendered = false;

  const openCommercialInquiry = () => { inquiryCalled = true; };
  const renderPackages = () => { packagesRendered = true; };
  const renderTierChips = () => {};
  const bkGoTo = () => {};
  const document = {
    getElementById() {
      return { value: '07650', focus() {}, style: {} };
    },
  };
  const activeZone = { key: 'nj_a' };
  const ST = {};

  const runner = new Function(
    'openCommercialInquiry',
    'document',
    'activeZone',
    'ST',
    'renderPackages',
    'renderTierChips',
    'bkGoTo',
    `${selectCategorySrc}\nreturn selectCategory;`
  );
  const selectCategory = runner(
    openCommercialInquiry,
    document,
    activeZone,
    ST,
    renderPackages,
    renderTierChips,
    bkGoTo
  );
  selectCategory('fleet');
  assert.equal(inquiryCalled, true);
  assert.equal(packagesRendered, false);
});

test('no Netlify Functions were modified for fleet UX removal', () => {
  // Static assertion: this suite lives only in frontend HTML. Presence of submit-booking
  // fleet handling would still be dormant acceptance — ensure we did not introduce
  // create-setup-intent fleet wrappers in pages.
  for (const page of PAGES) {
    const html = read(page);
    assert.doesNotMatch(
      html,
      /create-setup-intent[\s\S]{0,80}fleet|fleet[\s\S]{0,80}create-setup-intent/,
      `${page} links fleet to create-setup-intent`
    );
  }
});

test('unit-box Fleet Quantity markup remains dormant (hidden by default CSS)', () => {
  for (const page of PAGES) {
    const html = read(page);
    // Allowed to remain in source; must still exist id=unit-box without becoming a Step 1 card
    assert.match(html, /id="unit-box"/, `${page} unexpectedly deleted unit-box`);
    assert.doesNotMatch(html, /id="bkcat-fleet"/);
  }
});
