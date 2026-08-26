const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// Normalised to LF on read. Several substitutions below are multi-line literals
// written with \n, so on a CRLF checkout they match nothing and String.replace
// turns them into silent no-ops — the generator would emit a page missing its
// footer block and its ZIP initialiser while reporting success. That is a
// platform-dependent wrong page, which is exactly what this script must never
// produce. Verified: with the template as checked out under core.autocrlf=true,
// 3 substitutions miss; normalised to LF, only 1 genuinely misses.
const template = fs.readFileSync(path.join(root, 'template-city.html'), 'utf8').replace(/\r\n/g, '\n');

const hubs = [
  {
    file: 'bergen-county-hub.html',
    name: 'Bergen County',
    anchor: 'Hackensack',
    areas: 'Palisades Park, Englewood, Teaneck, Paramus, Fort Lee',
    badge: 'Serving Bergen County & North Jersey',
    sub: 'Premium mobile detailing across Bergen County — from Palisades Park to Fort Lee. We bring the water, power, and expertise to your driveway.',
    footAreas: 'Palisades Park · Hackensack · Englewood · Teaneck · Paramus · Fort Lee',
  },
  {
    file: 'hudson-county-hub.html',
    name: 'Hudson County',
    anchor: 'Jersey City',
    areas: 'Hoboken, Bayonne, Union City, Weehawken',
    badge: 'Serving Hudson County & the Gold Coast',
    sub: 'Professional mobile detailing in Hudson County — Jersey City, Hoboken, and waterfront neighborhoods. Showroom finish at your door.',
    footAreas: 'Jersey City · Hoboken · Bayonne · Union City · Weehawken',
  },
  {
    file: 'essex-county-hub.html',
    name: 'Essex County',
    anchor: 'Newark',
    areas: 'Elizabeth, Bloomfield, West Orange, Montclair',
    badge: 'Serving Essex County & Greater Newark',
    sub: 'Mobile detailing for Essex County — Newark, Elizabeth, Bloomfield, and West Orange. Fully equipped, fully mobile.',
    footAreas: 'Newark · Elizabeth · Bloomfield · West Orange · Montclair',
  },
  {
    file: 'passaic-county-hub.html',
    name: 'Passaic County',
    anchor: 'Paterson',
    areas: 'Wayne, Clifton, Franklin Lakes, Pompton Lakes',
    badge: 'Serving Passaic County & North Jersey',
    sub: 'Expert mobile detailing in Passaic County — Paterson, Wayne, Clifton, and Franklin Lakes. We come to you.',
    footAreas: 'Paterson · Wayne · Clifton · Franklin Lakes · Pompton Lakes',
  },
  {
    file: 'ny-metro-hub.html',
    name: 'NY Metro',
    anchor: 'Manhattan',
    areas: 'Westchester, Bronx, Queens, Brooklyn',
    badge: 'Serving NYC, Westchester & the Tri-State',
    sub: 'Premium mobile detailing across the NY Metro — Manhattan, Bronx, Queens, and Westchester County. Book online, we come to you.',
    footAreas: 'Manhattan · Bronx · Queens · Westchester · Brooklyn',
  },
  {
    file: 'connecticut-hub.html',
    name: 'Connecticut',
    anchor: 'Waterbury',
    areas: 'Danbury, New Haven, Hartford, Stamford',
    badge: 'Serving Connecticut & Fairfield County',
    sub: 'Premium mobile detailing across Connecticut — Waterbury, Hartford, New Haven, Danbury, and Stamford. We bring the water, power, and expertise to your driveway.',
    footAreas: 'Waterbury · Hartford · New Haven · Danbury · Stamford',
  },
];

const navFix = `<a class="nav-brand-img" href="index.html" aria-label="Cardetail1 Home">`;
const navOld = `<a class="nav-brand-img" href="#" onclick="window.scrollTo({top:0,behavior:'smooth'});return false;" aria-label="Cardetail1 Home">`;

const footQuickLinks = `      <div class="foot-col">
        <h4>Quick Links</h4>
        <a href="index.html">Home</a>
        <a href="rv-detailing.html">RV Detailing</a>
        <a href="fleet-services.html">Fleet Services</a>
      </div>
      <div class="foot-col">
        <h4>Contact</h4>`;

const footContactOld = `      <div class="foot-col">
        <h4>Contact</h4>`;

const bookMobileFix = `class="btn-primary booking-popup-trigger" style="font-size:15px;padding:18px 36px;margin-bottom:8px" onclick="openBooking(null)">Book Mobile Detailing →`;
const bookMobileOld = `class="btn-primary" style="font-size:15px;padding:18px 36px;margin-bottom:8px" onclick="openBooking(null)">Book Mobile Detailing →`;

const zipInit = `(function initHubZipFromQuery(){
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('zip') || sessionStorage.getItem('cd1_zip') || '';
  const zip5 = String(raw).replace(/\\D/g,'').slice(0, 5);
  if(zip5.length === 5){
    const inp = document.getElementById('hero-zip');
    if(inp){
      inp.value = zip5;
      if(typeof onHeroZipInput === 'function') onHeroZipInput(zip5);
    }
  }
})();
`;

const initAnchor = `renderReviews();
renderLocationCarousel('default');`;

// ── Safety ───────────────────────────────────────────────────────────────────
//
// This generator rebuilds six hub pages from template-city.html. The template
// and the live pages diverged long ago, so running it on an unmodified checkout
// silently REWRITES those pages and destroys the difference: measured at
// bb4cbfd it produced 645–2,281 changed lines per file, ~7,000 in total, and
// exited 0 while doing it.
//
// It is kept because adding a city is a legitimate use. Three guards make the
// destructive use impossible to trigger by accident:
//
//   1. Dry run by default. Writing requires --write.
//   2. A write that would REMOVE content from an existing page is refused, and
//      needs --force plus reading what it reports.
//   3. Every literal substitution must match. They are plain String.replace
//      calls, so a template that drifted would silently skip them and emit a
//      half-customised page with no error at all.
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const FORCE = argv.includes('--force');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);

/**
 * String.replace that records substitutions matching nothing instead of
 * applying them silently. Collected rather than thrown one at a time so a
 * drifted template reports every broken substitution in one run.
 */
function makeReplacer(misses) {
  return function must(html, from, to, label) {
    // Function replacement: a string replacement treats $' / $& / $` / $n as
    // special patterns. Chat INTENTS contain dollar','$'] — using that block as
    // a replacement string previously spliced </html> into the script and dumped
    // the rest of the JS as visible page text.
    const next = html.replace(from, () => to);
    if (next === html) misses.push(label);
    return next;
  };
}

/** Lines present in `before` that `after` no longer contains, ignoring pure moves. */
function removedLines(before, after) {
  const kept = new Set(after.split('\n').map((l) => l.trim()));
  return before.split('\n').map((l) => l.trim()).filter((l) => l && !kept.has(l));
}

function buildHub(hub) {
  const misses = [];
  const must = makeReplacer(misses);

  let html = template;
  if (!/\{CITY_NAME\}/.test(html)) misses.push('{CITY_NAME} token');
  html = html.replace(/\{CITY_NAME\}/g, () => hub.name);
  html = must(html, navOld, navFix, 'nav brand link');
  html = must(html, footContactOld, footQuickLinks, 'footer Quick Links block');
  html = must(html, bookMobileOld, bookMobileFix, 'book mobile CTA');
  html = must(html, `<link rel="canonical" href="https://cardetail1.com/">`, `<link rel="canonical" href="https://cardetail1.com/${hub.file}">`, 'canonical URL');
  html = must(html, `<meta property="og:url" content="https://cardetail1.com/">`, `<meta property="og:url" content="https://cardetail1.com/${hub.file}">`, 'og:url');
  html = must(html, `<div class="foot-areas">Serving Bergen County · Hudson County · Manhattan · Long Island · Fairfield CT · and surrounding areas</div>`, `<div class="foot-areas">Serving ${hub.footAreas} · and surrounding areas · <a href="index.html" style="color:var(--mu);text-decoration:none">← All service areas</a></div>`, 'footer service areas');
  html = must(html, initAnchor, zipInit + initAnchor, 'ZIP-from-query initialiser (initHubZipFromQuery)');

  if (misses.length > 0) {
    throw new Error(
      `[generate-hub-pages] ${misses.length} substitution(s) matched nothing in template-city.html:\n` +
        misses.map((m) => `    - ${m}`).join('\n') +
        '\n\n  template-city.html has drifted from what this generator expects. Emitting the page anyway\n' +
        '  would produce a half-customised hub — that is what the old version did, silently, exiting 0.\n' +
        '  Reconcile the template with these substitutions before generating anything.',
    );
  }

  // The remaining substitutions are content polish. They are intentionally not
  // guarded: several depend on {CITY_NAME} having already been interpolated and
  // are harmless no-ops on a city whose template copy differs.
  return html
    .replace(
      `<title>Mobile Detailing in ${hub.name} | Cardetail1</title>`,
      () => `<title>Premium Mobile Detailing in ${hub.name} | Cardetail1</title>`
    )
    .replace(
      `content="Cardetail1 — premium mobile auto, marine, RV &amp; fleet detailing in ${hub.name}.`,
      () => `content="Cardetail1 — premium mobile auto, marine, RV &amp; fleet detailing in ${hub.name} (${hub.anchor} hub).`
    )
    .replace(
      `<div class="hero-badge">📍 Serving ${hub.name} &amp; Surrounding Areas | Fully Mobile Service</div>`,
      () => `<div class="hero-badge">📍 ${hub.badge} | Fully Mobile Service</div>`
    )
    .replace(
      `<p class="hero-sub">Professional mobile detailing in ${hub.name} — we bring the water, the power, and the expertise directly to your driveway. No waiting rooms, no hassle—just a showroom finish at your doorstep.</p>`,
      () => `<p class="hero-sub">${hub.sub}</p>`
    )
    .replace(
      `<!--
  CITY LANDING PAGE TEMPLATE — replace tokens per city:`,
      () => `<!-- HUB PAGE: ${hub.name} (anchor: ${hub.anchor}) — covers ${hub.areas} -->`
    );
}

const targets = ONLY ? hubs.filter((h) => h.file === ONLY) : hubs;
if (ONLY && targets.length === 0) {
  console.error(`[generate-hub-pages] --only=${ONLY} matches no configured hub`);
  process.exit(2);
}

let refused = 0;
let wrote = 0;

for (const hub of targets) {
  const dest = path.join(root, hub.file);
  const html = buildHub(hub);
  const exists = fs.existsSync(dest);

  if (!exists) {
    if (WRITE) { fs.writeFileSync(dest, html); wrote += 1; console.log(`[new]     ${hub.file}`); }
    else console.log(`[new]     ${hub.file} — would be created`);
    continue;
  }

  const current = fs.readFileSync(dest, 'utf8');
  if (current === html) { console.log(`[same]    ${hub.file}`); continue; }

  const lost = removedLines(current, html);
  if (lost.length > 0) {
    refused += 1;
    console.error(
      `[REFUSED] ${hub.file} — regenerating would remove ${lost.length} line(s) that exist on the live page.\n` +
        `            first: ${JSON.stringify(lost[0].slice(0, 100))}\n` +
        `            This page has diverged from template-city.html. Regenerating discards that work.`,
    );
    if (!FORCE) continue;
    console.error(`            --force given; overwriting ${hub.file} anyway.`);
  }

  if (WRITE) { fs.writeFileSync(dest, html); wrote += 1; console.log(`[written] ${hub.file}`); }
  else console.log(`[changed] ${hub.file} — ${lost.length} line(s) would be lost; not written (dry run)`);
}

if (!WRITE) {
  console.log('\nDry run. Nothing was written. Pass --write to apply.');
}
if (refused > 0 && !FORCE) {
  console.error(`\n${refused} page(s) refused. They have diverged from the template; regenerating destroys content.`);
  console.error('Re-run with --force ONLY if you have read the report above and intend to discard that content.');
  process.exit(1);
}
if (WRITE) console.log(`\n${wrote} file(s) written.`);
