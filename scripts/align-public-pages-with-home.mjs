#!/usr/bin/env node
/**
 * Align legacy public hub/city pages with the current homepage presentation.
 *
 * Presentation only. It does not touch checkout, pricing, the ZIP travel gate
 * (assets/travel-fee-client.js), analytics, consent, or backend code.
 *
 * Every edit is idempotent and asserted: if a source block is not found and the
 * target state is not already present, the script throws instead of skipping.
 *
 *   node scripts/align-public-pages-with-home.mjs          # apply
 *   node scripts/align-public-pages-with-home.mjs --check  # exit 1 on drift
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const checkOnly = process.argv.includes('--check');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Full homepage clones that still carry the legacy booking/reviews blocks. */
const LEGACY = {
  'bergen-county-hub.html': { region: 'Bergen County', hub: true },
  'essex-county-hub.html': { region: 'Essex County', hub: true },
  'hudson-county-hub.html': { region: 'Hudson County', hub: true },
  'passaic-county-hub.html': { region: 'Passaic County', hub: true },
  'newark-mobile-detailing.html': { region: 'Newark', city: true },
  'trenton-mobile-detailing.html': { region: 'Trenton', city: true },
  'westchester-mobile-detailing.html': { region: 'Westchester County', city: true },
  'template-city.html': { region: '{CITY_NAME}', city: true },
};
const STATE_HUBS = ['new-jersey-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html', 'pennsylvania-hub.html'];
const COUNTY_HUBS = ['union-county-hub.html', 'morris-county-hub.html', 'rockland-county-hub.html', 'fairfield-county-hub.html'];
const BERGEN_CITIES = ['palisades-park', 'fort-lee', 'paramus', 'hackensack', 'englewood', 'teaneck', 'ridgewood', 'edgewater']
  .map((c) => `${c}-mobile-detailing.html`);
/** Landing-style pages (sp-* / article template) whose nav lacks Ceramic Coating or My Garage. */
const LANDING_NAV = [
  ...COUNTY_HUBS, ...BERGEN_CITIES,
  'boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html', 'trucks-detailing.html',
  'fleet-services.html', 'multi-vehicle-detailing.html', 'blog.html', 'reviews.html',
  'detailing-vs-car-wash.html', 'how-often-to-detail.html', 'mobile-detailing-what-to-expect.html',
];

const home = read('index.html').replace(/\r\n/g, '\n');

function between(src, start, end, label) {
  const i = src.indexOf(start);
  const j = i < 0 ? -1 : src.indexOf(end, i + start.length);
  if (i < 0 || j < 0) throw new Error(`${label}: block not found`);
  return src.slice(i, j);
}

// ── Canonical fragments taken from the live sources, not retyped ───────────
const HOME_REVIEWS = between(home, '<!-- REVIEWS -->\n<div id="reviews"', '\n\n<!-- HOME FAQ', 'home reviews').trimEnd() + '\n';
const HOME_REVIEW_FNS = between(home, 'function renderReviews(){', '\n// ═══', 'home review fns').trimEnd() + '\n';
// The homepage no longer has a "How it works" block; hub/city clones drop theirs
// (four-step or three-step). Booking steps live in the booking modal itself.
const PROCESS_BLOCK = /\n<!-- HOW IT WORKS -->\n<div id="how"[\s\S]*?\n<\/div>\n(?=\n<!-- (?:TRUST|SPECIALTY SERVICES))/;
const HOW3_CSS = '.how-grid--three{grid-template-columns:repeat(3,minmax(0,1fr))}\n@media(max-width:760px){.how-grid--three{grid-template-columns:1fr}}\n';
function removeProcess(ed) {
  ed.edit('process: remove "How it works" block (homepage has none)', PROCESS_BLOCK, '', (s) => false);
  ed.edit('process: drop now-unused three-column CSS', HOW3_CSS, '', (s) => false);
}
// Homepage carousel rules, re-pointed at the dark hub palette (hubs define no --ink/--line).
// Starts at .rv-vh: the shared module renders visually-hidden star text with it.
const RV_CSS_START = '.rv-vh{';
const RV_CSS_END = '  .rv-slide{flex-basis:100%}\n}';
const homeRvCss = (() => {
  const i = home.indexOf(RV_CSS_START);
  const j = home.indexOf(RV_CSS_END, i);
  if (i < 0 || j < 0) throw new Error('home rv css block not found');
  return home.slice(i, j + RV_CSS_END.length)
    .replace(/var\(--ink\)/g, 'var(--white)')
    .replace(/var\(--line\)/g, 'rgba(255,255,255,.08)')
    .replace(/rgba\(15,23,42,\.15\)/g, 'rgba(255,255,255,.18)');
})();
const RV_CSS_MARK = '/* ── REVIEWS CAROUSEL (shared first-party component, synced from index.html) ── */';
const RV_CSS = `${RV_CSS_MARK}\n${homeRvCss}\n/* end shared reviews carousel */\n`;

const CITY_GRID_CSS_MARK = '/* Bergen city links (rules mirrored from assets/luxury-theme.css, which this page does not load) */';
const CITY_GRID_CSS = `${CITY_GRID_CSS_MARK}
#bergen-cities .service-area-city-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
#bergen-cities .service-area-city-link{display:flex;align-items:center;min-height:48px;padding:12px 14px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.035);color:#fff;text-decoration:none;font-size:14px;font-weight:500;line-height:1.35;transition:border-color .2s,background .2s}
#bergen-cities .service-area-city-link:hover,#bergen-cities .service-area-city-link:focus-visible{border-color:rgba(77,163,255,.55);background:rgba(77,163,255,.08);outline:none}
@media(max-width:768px){#bergen-cities .service-area-city-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}#bergen-cities .service-area-city-link{font-size:13px;overflow-wrap:anywhere}}
@media(max-width:420px){#bergen-cities .service-area-city-grid{grid-template-columns:1fr}}
`;

// ── Edit helpers ───────────────────────────────────────────────────────────
function makeEditor(file) {
  let src = read(file).replace(/\r\n/g, '\n');
  const log = [];
  return {
    get src() { return src; },
    /** Replace `from` (string or RegExp) with `to`, unless `done` already holds. */
    edit(name, from, to, done) {
      if (done && (typeof done === 'string' ? src.includes(done) : done.test(src))) return;
      if (from instanceof RegExp) from.lastIndex = 0;
      const hit = typeof from === 'string' ? src.includes(from) : from.test(src);
      if (from instanceof RegExp) from.lastIndex = 0;
      if (!hit) throw new Error(`${file}: "${name}" source not found`);
      src = typeof from === 'string' ? src.split(from).join(to) : src.replace(from, to);
      log.push(name);
    },
    log,
  };
}

const NAV_LINKS_HOME_STYLE = (cta) => `  <div class="nav-links" id="nav-links">
    <a class="nav-link" onclick="openBooking(null);document.getElementById('nav-links').classList.remove('open')">Services</a>
    <a class="nav-link" href="/ceramic-coating" onclick="document.getElementById('nav-links').classList.remove('open')">Ceramic Coating</a>
    <a class="nav-link" href="/blog">Guides</a>
    <a class="nav-link" href="my-garage.html">My Garage</a>
    <a class="nav-link" href="tel:+15513893986">Call / Text</a>
    ${cta}
  </div>`;

function alignFullCloneNav(ed) {
  ed.edit('nav: homepage link set',
    /  <div class="nav-links" id="nav-links">\n[\s\S]*?(    <a class="nav-cta booking-popup-trigger" onclick="openBooking\(null\)">[^<]+<\/a>)\n  <\/div>/,
    (_m, cta) => NAV_LINKS_HOME_STYLE(cta.trim()),
    /id="nav-links">\n    <a class="nav-link" onclick="openBooking\(null\)[^\n]*>Services<\/a>\n    <a class="nav-link" href="\/ceramic-coating"/);
  // Two more links than before: tighten spacing on tablet widths so the row clears the logo.
  ed.edit('nav: tablet spacing for the longer link set',
    /(<\/style>)/,
    '/* nav: homepage link set (tablet spacing) */\n@media(min-width:641px) and (max-width:960px){#main-nav .nav-links{gap:14px}}\n$1',
    '/* nav: homepage link set (tablet spacing) */');
  // "My Booking" opened the removed legacy portal (now a redirect to My Garage) — duplicate of My Garage.
  ed.edit('nav: drop duplicate mobile My Booking', '  <a class="nav-portal-mobile" onclick="openPortal()">My Booking</a>\n', '',
    (s) => false);
}

function alignSpecialtyNavLabel(ed) {
  ed.edit('specialty nav: Semi Trucks label (homepage)',
    '<a class="specialty-service-link" href="/trucks-detailing">Trucks</a>',
    '<a class="specialty-service-link" href="/trucks-detailing">Semi Trucks</a>',
    '<a class="specialty-service-link" href="/trucks-detailing">Semi Trucks</a>');
}

// ── Coverage: qualitative, as on the homepage (owner decision 2026-11-12) ──
// No numeric radius and no whole-state promise in copy, metadata or JSON-LD.
// The ZIP gate (assets/travel-fee-client.js) is not touched.
const COVERAGE_AREA = {
  'new-jersey-hub.html': 'Bergen County and nearby NJ areas',
  'ny-metro-hub.html': 'NYC &amp; NY Metro by appointment',
  'connecticut-hub.html': 'selected Connecticut service areas',
  'pennsylvania-hub.html': 'selected eastern Pennsylvania service areas',
};
const coverageArea = (file) => COVERAGE_AREA[file] || `${LEGACY[file].region} and nearby areas`;
const coverageLine = (area) => `Based in Palisades Park, NJ. Serving ${area}. Extended service areas available by quote.`;

/** areaServed keeps the named counties/cities the pages describe; drops the 150-mi circle and whole states. */
function alignJsonLdCoverage(ed) {
  if (!/"@type": "(?:GeoCircle|State)"/.test(ed.src)) return;
  ed.edit('coverage: JSON-LD areaServed without radius circle or whole states',
    /(<script type="application\/ld\+json">\n)([\s\S]*?)(\n<\/script>)/g,
    (m, open, body, close) => {
      if (!/"@type": "(?:GeoCircle|State)"/.test(body)) return m;
      const data = JSON.parse(body);
      if (JSON.stringify(data, null, 2) !== body.trim()) throw new Error('JSON-LD block is not canonical JSON; refusing to rewrite');
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o.areaServed)) {
          o.areaServed = o.areaServed.filter((a) => !a || (a['@type'] !== 'GeoCircle' && a['@type'] !== 'State'));
          if (!o.areaServed.length) throw new Error('areaServed would be empty');
        }
        Object.values(o).forEach(walk);
      };
      walk(data);
      return `${open}${JSON.stringify(data, null, 2)}${close}`;
    });
}

function alignCoverageCopy(ed, file) {
  const line = coverageLine(coverageArea(file));
  ed.edit('coverage: local line under reviews',
    /<p class="rv-local-note"([^>]*)>📍 [^<]*<\/p>/,
    `<p class="rv-local-note"$1>📍 ${line}</p>`,
    `>📍 ${line}</p>`);
  if (!LEGACY[file]) return;
  ed.edit('coverage: ZIP helper',
    /Based in Palisades Park(?:, NJ)? (?:-|—) we serve [^.<]*\. Pop in your ZIP to check coverage\./,
    `${line} Pop in your ZIP to check coverage.`,
    `${line} Pop in your ZIP to check coverage.`);
  if (LEGACY[file].hub) {
    ed.edit('coverage: service-area paragraph',
      /<p class="hub-radius-desc">[\s\S]*?<\/p>/,
      `<p class="hub-radius-desc">${line.replace('Palisades Park, NJ', '<strong>Palisades Park, NJ</strong>')} Enter your ZIP above — we'll confirm coverage before you book.</p>`,
      `we'll confirm coverage before you book.</p>`);
  }
  if (LEGACY[file].city) {
    const area = coverageArea(file);
    ed.edit('coverage: meta/og/twitter description without "up to 120 miles"',
      / — serving the Tri-State up to 120 miles\./g,
      ` — based in Palisades Park, NJ, serving ${area}; extended service areas by quote.`,
      (s) => false);
  }
}

/** Each page keeps its own local coverage line under the shared reviews block. */
const LOCAL_REVIEW_LINE = {
  'new-jersey-hub.html': 'Serving New Jersey by appointment',
  'ny-metro-hub.html': 'Serving NYC &amp; NY Metro by appointment',
  'connecticut-hub.html': 'Serving Connecticut &amp; Fairfield County',
  'pennsylvania-hub.html': 'Serving Pennsylvania &amp; Delaware Valley',
  'bergen-county-hub.html': 'Serving Bergen County &amp; North Jersey',
};

function addLocalReviewLine(ed, file) {
  const line = LOCAL_REVIEW_LINE[file] || `Serving ${LEGACY[file].region} by appointment`;
  ed.edit('reviews: keep page-local coverage line',
    /(<div class="rv-actions">[\s\S]*?\n    <\/div>\n)/,
    `$1    <p class="rv-local-note" style="text-align:center;margin:14px 0 0;font-size:12px;color:var(--mu)">📍 ${line} · based in Palisades Park, NJ</p>\n`,
    'class="rv-local-note"');
}

function swapReviews(ed, nextMarker) {
  ed.edit('reviews: shared first-party component markup',
    new RegExp('<!-- REVIEWS -->\\n<div id="reviews" style="background:var\\(--bg0\\)">[\\s\\S]*?\\n(?=\\n?' + nextMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')'),
    HOME_REVIEWS,
    'id="rv-viewport"');
  ed.edit('reviews: drop inline REVIEWS array + legacy carousel fns',
    /\/\/ REVIEWS\n(?:\/\/ ═+\n)?const REVIEWS = \[[\s\S]*?function rvMove\(dir\)\{ rvGoTo\(rvIdx \+ dir\); \}\n/,
    '// REVIEWS — first-party curated list lives in assets/customer-reviews.js\n' + HOME_REVIEW_FNS,
    'CD1CustomerReviews.mount();');
  ed.edit('reviews: load assets/customer-reviews.js',
    /(\n)(<script>\n(?:(?!<\/script>)[\s\S])*?\/\/ REVIEWS — first-party curated list)/,
    '$1<script src="assets/customer-reviews.js"></script>\n$2',
    '<script src="assets/customer-reviews.js"></script>');
  ed.edit('reviews: carousel CSS from homepage',
    /\/\* ── REVIEWS CAROUSEL ── \*\/\n(?:\.rv-[^\n]*\n)+|\/\* ── REVIEWS CAROUSEL \(shared[^\n]*\n[\s\S]*?\/\* end shared reviews carousel \*\/\n/,
    () => RV_CSS,
    RV_CSS);
}

/**
 * The inline fallback booking lost the "<div" of its car make-search wrapper
 * (75829276), so the parser drops #make-search-wrap and selectCategory() throws
 * in renderTierChips — the fallback cannot leave step 1. Restore the tag exactly
 * as in index.html; no booking logic changes.
 */
function repairFallbackMarkup(ed) {
  // 75829276 inserted the truck-cab block in the middle of the tag, leaving a
  // stray "<div " before it and the tag's attributes after it.
  ed.edit('fallback booking: restore <div id="make-search-wrap"> and drop the stray "<div " (as in index.html)',
    /        <!-- Make search \(cars only\) -->\n        <div \n([\s\S]*?)\n        (?:<div )?id="make-search-wrap" style="display:none">\n/,
    '$1\n        <!-- Make search (cars only) -->\n        <div id="make-search-wrap" style="display:none">\n',
    (s) => false);
}

function fixMojibake(ed) {
  ed.edit('encoding: boat icon', '🚥️️️️', '🛥️', (s) => false);
  ed.edit('encoding: multiplication sign', "' Ã—'", "' ×'", (s) => false);
  ed.edit('encoding: multiplication sign (copy)', 'average length Ã— unit count', 'average length × unit count', (s) => false);
}

const results = {};
function run(file, fn) {
  const before = read(file);
  const ed = makeEditor(file);
  // tolerate idempotent no-op edits whose `done` is a function returning false
  const origEdit = ed.edit.bind(ed);
  ed.edit = (name, from, to, done) => {
    if (typeof done === 'function') {
      if (from instanceof RegExp) from.lastIndex = 0;
      const hit = typeof from === 'string' ? ed.src.includes(from) : from.test(ed.src);
      if (from instanceof RegExp) from.lastIndex = 0;
      if (!hit) return; // already applied or never present
      return origEdit(name, from, to);
    }
    return origEdit(name, from, to, done);
  };
  fn(ed);
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const out = ed.src.replace(/\n/g, eol);
  results[file] = ed.log;
  if (out !== before) {
    if (checkOnly) { console.error(`DRIFT: ${file}: ${ed.log.join('; ')}`); process.exitCode = 1; }
    else fs.writeFileSync(path.join(root, file), out);
  }
}

// ── Legacy full clones ─────────────────────────────────────────────────────
for (const [file, { region, hub }] of Object.entries(LEGACY)) {
  run(file, (ed) => {
    const isBergen = file === 'bergen-county-hub.html';
    alignFullCloneNav(ed);
    alignSpecialtyNavLabel(ed);
    fixMojibake(ed);
    repairFallbackMarkup(ed);

    if (hub) {
      ed.edit('coverage copy: no 120-mile promise; Palisades Park base',
        /    <p class="hub-radius-desc">We operate from our <strong>[^<]+<\/strong> hub and travel up to <strong>120 miles<\/strong>[^\n]*\n    <p class="hub-radius-note">We travel up to 120 miles from our anchor city\.[^\n]*/,
        `    <p class="hub-radius-desc">Based in <strong>Palisades Park, NJ</strong>, we serve ${region} and nearby NJ/NY areas at your driveway, marina, or fleet yard. Enter your ZIP above — we'll confirm coverage and unlock booking for your area. Extended service areas are available by quote.</p>\n    <p class="hub-radius-note">Distance may affect your total — any travel pricing is included in the quote at booking, not shown as a separate fee when you enter your ZIP.</p>`,
        (s) => false);
      ed.edit('coverage heading', '<div class="sec-title">MOBILE SERVICE<br><span style="color:var(--blue)">RADIUS</span></div>',
        '<div class="sec-title">MOBILE SERVICE<br><span style="color:var(--blue)">AREA</span></div>', (s) => false);
    }

    removeProcess(ed);

    swapReviews(ed, '<!-- CTA SECTION -->');
    addLocalReviewLine(ed, file);
    alignCoverageCopy(ed, file);
    alignJsonLdCoverage(ed);

    if (!isBergen) {
      ed.edit('local copy: services intro region',
        'We are a local, hard-working team proud to serve our Bergen County neighbors.',
        `We are a local, hard-working team proud to serve ${region} customers.`,
        `proud to serve ${region} customers.`);
      ed.edit('local copy: trust label region',
        '<div class="trust-lbl">Bergen County</div>', `<div class="trust-lbl">${region}</div>`, (s) => false);
      ed.edit('local copy: call CTA region',
        'Monday–Saturday · By Appointment Only · Bergen County, NJ and nearby areas',
        `Monday–Saturday · By Appointment Only · ${region} and nearby areas`, (s) => false);
      ed.edit('local copy: ZIP helper region',
        /Based in Palisades Park (?:-|—) we serve Bergen County neighbors and the wider Tri-State\./,
        `Based in Palisades Park, NJ — we serve ${region} and nearby NJ/NY areas.`,
        (s) => false);
    } else {
      ed.edit('bergen city links: styles', /(<\/style>)/, `${CITY_GRID_CSS}$1`, CITY_GRID_CSS_MARK);
    }

    // City pages shared one generic social card naming "Palisades Park & Bergen County".
    if (LEGACY[file].city) {
      const title = (ed.src.match(/<title>([^<]+)<\/title>/) || [])[1];
      const desc = (ed.src.match(/<meta name="description" content="([^"]+)"/) || [])[1];
      if (!title || !desc) throw new Error(`${file}: title/description missing`);
      for (const [attr, key, val] of [['property', 'og:title', title], ['property', 'og:description', desc], ['name', 'twitter:title', title], ['name', 'twitter:description', desc]]) {
        ed.edit(`social card: ${key} = page ${key.endsWith('title') ? 'title' : 'description'}`,
          new RegExp(`<meta ${attr}="${key}" content="[^"]*">`), `<meta ${attr}="${key}" content="${val}">`,
          `<meta ${attr}="${key}" content="${val}">`);
      }
    }
  });
}

// ── State hubs (partially aligned) ─────────────────────────────────────────
for (const file of STATE_HUBS) {
  run(file, (ed) => {
    alignFullCloneNav(ed);
    alignSpecialtyNavLabel(ed);
    fixMojibake(ed);
    repairFallbackMarkup(ed);
    removeProcess(ed);
    swapReviews(ed, '<!-- LOCAL FAQ -->');
    addLocalReviewLine(ed, file);
    alignCoverageCopy(ed, file);
    alignJsonLdCoverage(ed);
  });
}

// ── Homepage: structured data only (no copy or booking changes) ─────────────
run('index.html', (ed) => alignJsonLdCoverage(ed));

// ── Recent county hubs: footer hours drifted from every other page ─────────
for (const file of COUNTY_HUBS) {
  run(file, (ed) => {
    ed.edit('footer hours: canonical Monday–Saturday',
      '<span class="foot-static">Mon–Fri 8AM–5PM · By appointment</span>',
      '<span class="foot-static">Monday–Saturday · By Appointment Only</span>', (s) => false);
  });
}

// ── Bergen city landings: keep ad parameters on the booking handoff ────────
for (const file of BERGEN_CITIES) {
  run(file, (ed) => {
    ed.edit('attribution: decorate /?book= handoff links (same script as county hubs)',
      /(\n<\/body>)/,
      '\n<script src="assets/county-hub-booking-attribution.js" defer></script>$1',
      'assets/county-hub-booking-attribution.js');
  });
}

// ── Landing-style navs: Ceramic Coating + My Garage, as on the homepage ────
for (const file of LANDING_NAV) {
  run(file, (ed) => {
    if (!/<div class="nav-links" id="nav-links">/.test(ed.src)) return;
    ed.edit('nav: Ceramic Coating link',
      /(<div class="nav-links" id="nav-links">\n    <a class="nav-link" href="[^"]*">(?:Services|Home)<\/a>\n(?:    <a class="nav-link" href="\/">Services<\/a>\n|    <a class="nav-link" href="\/#services">Services<\/a>\n)?)/,
      '$1    <a class="nav-link" href="/ceramic-coating">Ceramic Coating</a>\n',
      /id="nav-links">[\s\S]{0,400}href="\/ceramic-coating"/);
    ed.edit('nav: My Garage link',
      /(\n)(    <a class="nav-link" href="tel:\+15513893986">Call \/ Text<\/a>)/,
      '$1    <a class="nav-link" href="my-garage.html">My Garage</a>\n$2',
      /id="nav-links">[\s\S]{0,700}href="my-garage\.html">My Garage<\/a>/);
  });
}

// ── $335 car package: one public name, the catalog's (index.html PRICING id 'refresh') ──
// Only package-name uses change; generic "exterior detailing" and other services do not.
const REFRESH_NAME = (() => {
  const m = home.match(/\{id:'refresh',\s*name:'([^']+)'/);
  if (!m) throw new Error('refresh package name not found in index.html');
  return m[1];
})();
function renameRefreshPackage(ed) {
  const html = REFRESH_NAME.replace(/&/g, '&amp;');
  const inHtml = (s) => s
    .split('Exterior Detail &amp; Paint Enhancement').join(html)
    .split('Exterior Detail & Paint Enhancement').join(REFRESH_NAME) // raw-& style used in some copy
    .replace(/\bor Exterior Detail from \$335\b/g, `or ${html} from $335`)
    .replace(/(href="\/\?book=cars&amp;pkg=refresh[^"]*">)Book Exterior Detail</g, `$1Book ${html}<`);
  const inJson = (s) => s
    .split('Exterior Detail & Paint Enhancement').join(REFRESH_NAME)
    .replace(/\bor Exterior Detail from \$335\b/g, `or ${REFRESH_NAME} from $335`);
  const before = ed.src;
  const parts = before.split(/(<script type="application\/ld\+json">[\s\S]*?<\/script>)/);
  const after = parts.map((p, i) => (i % 2 ? inJson(p) : inHtml(p))).join('');
  if (after !== before) ed.edit(`naming: $335 package is "${REFRESH_NAME}"`, before, after, (s) => false);
}

// ── Floating WELCOME10 pop-up: off public pages, as on the homepage ────────
// Display only. The WELCOME10 offer, eligibility and checkout discount live in
// index.html / assets/checkout-offer.js / backend and are not touched here.
function removeWelcomeBalloon(ed) {
  ed.edit('pop-up: drop floating WELCOME10 balloon script (homepage has none)',
    /\n?<script src="assets\/welcome-lead-balloon\.js"(?: defer)?><\/script>/g, '', (s) => false);
}

const PUBLIC_PAGES = fs.readdirSync(root).filter((f) => f.endsWith('.html')
  && !/^(admin|technician|customer|my-garage|receipt|resume|bid|authorize)/.test(f));
for (const file of PUBLIC_PAGES) {
  run(file, (ed) => {
    if (file !== 'index.html') removeWelcomeBalloon(ed);
    renameRefreshPackage(ed);
  });
}

for (const [file, log] of Object.entries(results)) if (log.length) console.log(`${file}: ${log.join('; ')}`);
