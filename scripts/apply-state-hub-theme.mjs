/**
 * Sync NJ/NY/CT/PA state hub pages with clean conversion-focused homepage theme.
 * Front-end copy/layout/theme only — preserves routes, package IDs, booking preselect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function sliceBetween(src, start, end) {
  const s = src.indexOf(start);
  const e = src.indexOf(end, s + start.length);
  if (s === -1 || e === -1) throw new Error(`Slice markers not found: ${start}`);
  return src.slice(s, e);
}

const lightRootMatch = indexHtml.match(/:root\{([\s\S]*?)\}\s*html/);
if (!lightRootMatch) throw new Error(':root block not found in index.html');
const lightRoot = lightRootMatch[1];

const pkgBlockStart = indexHtml.indexOf('const CAR_PKG_DETAILS = {');
const pkgBlockEnd = indexHtml.indexOf('const PRICING = {', pkgBlockStart);
if (pkgBlockStart === -1 || pkgBlockEnd === -1) throw new Error('CAR_PKG_DETAILS block not found');
const fullCarPkgJsBlock = indexHtml.slice(pkgBlockStart, pkgBlockEnd).trim();

const carPkgCss = sliceBetween(indexHtml, '.car-pkg-intro{', '.hero-zip-details{border:none');
const modalLightCss = sliceBetween(indexHtml, '/* ── MODALS — light surfaces', '@media(max-width:680px){');
const pkgDetailCss = sliceBetween(indexHtml, '.pkg-detail-panel{margin:', '.car-pkg-card--popular .car-pkg-cta:hover');
const bkCatNoteCss = sliceBetween(indexHtml, '#bk-cat-grid .svc-cat-note{', '#bk-cat-grid .bk-cat-specialty{');

const updateHomeBlock = indexHtml.slice(
  indexHtml.indexOf('function _updateHomeFromPrices(){'),
  indexHtml.indexOf('(function initTrustedStatsCounter()')
).trim();

const openBookingCarPkgFn = `function openBookingCarPkg(pkgId){
  ST._prefillPkgId=pkgId||'';
  openBookingFromHome('cars');
}`;

const initHeroZipDetailsJs = `(function initHeroZipDetails(){
  const details=document.querySelector('.hero-zip-details');
  if(!details) return;
  const mq=window.matchMedia('(max-width:768px)');
  function sync(){
    if(mq.matches) details.removeAttribute('open');
    else details.setAttribute('open','');
  }
  sync();
  if(typeof mq.addEventListener==='function') mq.addEventListener('change',sync);
  else if(typeof mq.addListener==='function') mq.addListener(sync);
})();`;

function replaceOldUpdateHome(html) {
  if (html.includes("setPkgAmt('home-from-interior'")) return html;
  const start = html.indexOf('function _updateHomeFromPrices(){');
  if (start === -1) throw new Error('_updateHomeFromPrices not found');
  const fnStart = html.indexOf('(function initTrustedStatsCounter()', start);
  if (fnStart === -1) throw new Error('initTrustedStatsCounter marker not found after _updateHomeFromPrices');
  return html.slice(0, start) + updateHomeBlock + '\n\n' + html.slice(fnStart);
}

const servicesHtml = sliceBetween(
  indexHtml,
  '<!-- SERVICES — car-first purchase path -->',
  '<!-- Radar widget removed'
).trim();

const specialtyHtml = sliceBetween(
  indexHtml,
  '<!-- SPECIALTY SERVICES (secondary) -->',
  '<!-- REAL RESULTS -->'
).trim();

const selectPkgReplacement = `function selectPkg(id){
  document.querySelectorAll('.pkg').forEach(c=>c.classList.remove('sel'));
  const el=document.getElementById('pk-'+id);
  if(el)el.classList.add('sel');
  ST.pkgId=id;
  ST.pkg=(PRICING[ST.cat]&&PRICING[ST.cat].packages)?PRICING[ST.cat].packages.find(p=>p.id===id):null;
  document.getElementById('next2').disabled=!ST.pkg;
  renderPkgDetailPanel();
  if((ST.cat==='boats'||ST.cat==='rvs'||ST.cat==='fleet') && (ST.lengthFt||ST.units)){tryGenericConfirm();}
}`;

const howHtml3Step = `<!-- HOW IT WORKS -->
<div id="how" style="background:var(--bg0)">
  <div class="section">
    <div class="sec-eye">How it works</div>
    <div class="sec-title">Three simple steps</div>
    <div class="sec-desc">No charge today — card holds your slot. Final payment after service. Long-distance appointments may require quote approval.</div>
    <div class="how-grid how-grid--three">
      <div class="how-card">
        <div class="how-ico">📍</div>
        <div class="how-title">Enter ZIP &amp; request</div>
        <div class="how-desc">Check your area and start your appointment online — we confirm coverage before you book.</div>
      </div>
      <div class="how-card">
        <div class="how-ico">📋</div>
        <div class="how-title">Choose package &amp; add-ons</div>
        <div class="how-desc">Pick interior, full, or exterior detail. Add pet hair, odor, engine bay, and more when you book.</div>
      </div>
      <div class="how-card">
        <div class="how-ico">🚐</div>
        <div class="how-title">We come to you</div>
        <div class="how-desc">Our tech arrives at your driveway or office. Walk the vehicle when done — pay after the detail.</div>
      </div>
    </div>
  </div>
</div>`;

const hubLightCss = `
/* === STATE HUB LIGHT THEME (synced from homepage) === */
:root{${lightRoot}}
body{background:var(--bg0)!important;color:var(--tx)!important;-webkit-font-smoothing:antialiased}
.nav{background:rgba(23,33,47,.94)!important;border-bottom:1px solid rgba(255,255,255,.08)!important;height:60px!important}
.nav-link{color:rgba(255,255,255,.72)!important;font-weight:500!important;letter-spacing:0!important}
.nav-cta{color:var(--white)!important;text-transform:none!important;font-weight:600!important;box-shadow:0 2px 8px rgba(37,99,235,.28)!important}
.nav-cta:hover{background:var(--blue-hover)!important}
.nav-book-mobile{color:var(--white)!important}
.nav-portal-mobile{display:none!important}
.hero--nj,.hero--ny,.hero--ct,.hero--pa,.hub-nj,.hub-ny,.hub-ct,.hub-pa,.hero{background:var(--bg1)!important;min-height:auto!important;padding:88px 20px 48px!important;border-bottom:1px solid var(--line)!important;text-align:center!important}
.hero::before{background:radial-gradient(ellipse 80% 60% at 70% 40%,rgba(37,99,235,.04),transparent)!important}
.hero-bg-desktop,.hero-bg-mobile,.hero-brand-mark,.hero-scroll{display:none!important}
.hero-inner{max-width:520px;width:100%;position:relative;z-index:1;margin:0 auto}
.hero h1{font-family:var(--fb)!important;font-size:clamp(30px,5.5vw,44px)!important;font-weight:600!important;color:var(--ink)!important;line-height:1.15!important;letter-spacing:-.025em!important;margin-bottom:10px!important}
.hero-sub{color:var(--ink-soft)!important;font-weight:400!important;font-size:15px!important;max-width:460px!important;margin:0 auto 20px!important;line-height:1.6!important}
.hero-badge{font-size:12px!important;font-weight:600!important;letter-spacing:.04em!important;text-transform:uppercase!important;color:var(--blue)!important;background:var(--bdim)!important;border:1px solid var(--bbr)!important;border-radius:999px!important;padding:5px 12px!important;margin-bottom:12px!important}
.hero-facts{list-style:none;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:0 0 16px;padding:0}
.hero-facts li{font-size:12px;font-weight:600;color:var(--ink-soft);background:var(--bg0);border:1px solid var(--line);border-radius:999px;padding:6px 12px;line-height:1.25}
.hero-trust-line{font-size:12px;color:#475569;max-width:420px;margin:0 auto 16px;line-height:1.55}
.hero-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:16px}
.btn-primary{color:var(--white)!important;text-transform:none!important;font-weight:600!important;letter-spacing:0!important;box-shadow:0 2px 10px rgba(37,99,235,.22)!important}
.btn-primary:hover{background:var(--blue-hover)!important;color:var(--white)!important;transform:translateY(-1px)!important}
.btn-outline{background:var(--bg1)!important;color:var(--ink)!important;border:1px solid var(--line-strong)!important;text-transform:none!important;font-weight:500!important}
.btn-outline:hover{background:var(--bg2)!important;border-color:var(--bbr)!important;color:var(--blue)!important}
#zip-section{background:transparent!important;padding:0!important;margin:0!important}
.hero-zip-wrap{background:var(--bg0)!important;border:1px solid var(--line)!important;box-shadow:none!important;border-radius:var(--r)!important;padding:16px 18px!important;max-width:440px!important;margin:0 auto 12px!important}
.hero-zip-label{color:var(--mu)!important;font-weight:500!important;letter-spacing:0!important;text-transform:none!important;font-size:12px!important}
.hero-zip-input{background:var(--bg0)!important;border:1px solid var(--line-strong)!important;color:var(--ink)!important;border-radius:14px!important}
.hero-zip-input::placeholder{color:#94a3b8!important}
.hero-zip-btn{color:var(--white)!important;border-radius:14px!important;font-weight:600!important;text-transform:none!important;letter-spacing:0!important}
.hub-service-area-note{font-size:12px;color:#475569;max-width:440px;margin:8px auto 0;line-height:1.55;text-align:center}
.hub-radius-section{background:var(--bg0)!important;border-top:1px solid var(--line)!important;padding:32px 24px!important}
.hub-radius-desc,.hub-radius-note{color:var(--ink-soft)!important}
.sec-eye{font-size:12px!important;font-weight:500!important;letter-spacing:.06em!important;text-transform:none!important;color:var(--blue)!important}
.sec-title{font-family:var(--fb)!important;font-size:clamp(26px,4.5vw,40px)!important;line-height:1.15!important;font-weight:600!important;color:var(--ink)!important;letter-spacing:-.02em!important}
.sec-desc{color:var(--ink-soft)!important;line-height:1.65!important}
.how-grid--three{grid-template-columns:repeat(3,minmax(0,1fr))}
@media(max-width:760px){.how-grid--three{grid-template-columns:1fr}}
.how-card{background:var(--bg1)!important;border:1px solid var(--line)!important;box-shadow:var(--shadow-sm)!important}
.how-title{color:var(--ink)!important;font-weight:600!important}
.how-desc{color:var(--ink-soft)!important;font-size:13px!important;line-height:1.55!important}
.trust-val{color:var(--ink)!important;font-family:var(--fb)!important;font-size:clamp(18px,3vw,24px)!important;font-weight:700!important;letter-spacing:0!important}
.trust-lbl{color:var(--ink-soft)!important;text-transform:none!important;letter-spacing:0!important;font-size:12px!important}
.trust-item{border-color:var(--line)!important}
.loc-section{background:var(--bg1)!important;border-top:1px solid var(--line)!important;border-bottom:1px solid var(--line)!important}
.loc-card{background:var(--bg0)!important;border:1px solid var(--line)!important;box-shadow:var(--shadow-sm)!important}
.loc-name{font-family:var(--fb)!important;font-size:16px!important;font-weight:700!important;color:var(--ink)!important;letter-spacing:0!important}
.loc-req{color:var(--ink-soft)!important}
.loc-from{color:var(--blue)!important}
.loc-visual{background:var(--bg2)!important}
.loc-zip-in{background:var(--bg0)!important;border:1px solid var(--line-strong)!important;color:var(--ink)!important}
.loc-zip-btn{color:var(--white)!important}
#reviews{background:var(--bg0)!important}
.section-full{background:var(--bg1)!important}
.ba-section{background:var(--bg1)!important;border-color:var(--line)!important}
.ba-vehicle{color:var(--ink)!important;font-family:var(--fb)!important;font-size:17px!important;font-weight:700!important}
.hero-tel-mobile{background:var(--bg1)!important;color:var(--blue)!important}
.msc-portal,.foot-portal-link{opacity:1!important}
${pkgDetailCss}
${carPkgCss}
${bkCatNoteCss}
${modalLightCss}
@media(max-width:680px){
  .hero{background:var(--bg1)!important}
  .hero::before{display:none}
}
`;

const STATES = {
  'new-jersey-hub.html': {
    metaDesc: 'Mobile interior, full, and exterior car detailing in New Jersey. We come to your driveway in Bergen County and nearby NJ areas. Book by appointment — extended areas by quote.',
    ogDesc: 'Mobile car detailing in New Jersey — interior, full, and exterior packages at your driveway. Bergen County and nearby NJ areas by appointment.',
    badge: 'Palisades Park, NJ · Bergen County',
    h1: 'Mobile Car Detailing in New Jersey',
    facts: ['🚐 We come to you', '📍 Bergen County &amp; nearby NJ', '📅 Book online'],
    heroSub: 'Interior detail, full detail, and exterior paint enhancement for sedans, SUVs, and trucks — at your home or office across New Jersey.',
    serviceArea: 'Based in Palisades Park, NJ. Serving Bergen County and nearby NJ areas. Extended service areas available by quote.',
    specialtyNote: 'Boats, RVs, powersports, and fleets available by quote for larger vehicles and approved appointments. Most bookings are car detailing — <a href="#" onclick="openBookingFromHome(\'cars\');return false;" style="color:var(--blue);font-weight:600;text-decoration:none">start with packages above</a> or call <a href="tel:5513132956" style="color:var(--blue);text-decoration:none">551-313-2956</a>.',
    locTitle: 'SERVICES IN',
    heroClass: '',
  },
  'ny-metro-hub.html': {
    metaDesc: 'Mobile interior, full, and exterior car detailing in New York. Service by appointment from our Palisades Park, NJ base. Longer-distance NY jobs available by quote.',
    ogDesc: 'Mobile car detailing in New York — interior, full, and exterior packages by appointment from our NJ base. Longer-distance jobs by quote.',
    badge: 'NY Metro · By appointment',
    h1: 'Mobile Car Detailing in New York',
    facts: ['🚐 We come to you', '📍 NY Metro by appointment', '📅 Book online'],
    heroSub: 'Interior detail, full detail, and exterior paint enhancement for sedans, SUVs, and trucks — we travel to your NY location by appointment.',
    serviceArea: 'Serving nearby NY areas by appointment from our Palisades Park, NJ base. Longer-distance jobs available by quote.',
    specialtyNote: 'Available by quote for larger vehicles, fleets, RVs, boats, and long-distance appointments. Most bookings are car detailing — <a href="#" onclick="openBookingFromHome(\'cars\');return false;" style="color:var(--blue);font-weight:600;text-decoration:none">start with packages above</a> or call <a href="tel:5513132956" style="color:var(--blue);text-decoration:none">551-313-2956</a>.',
    locTitle: 'NY METRO SERVICES IN',
    heroClass: ' hero--ny',
  },
  'connecticut-hub.html': {
    metaDesc: 'Mobile interior, full, and exterior car detailing in Connecticut. Service by quote for approved appointments, larger details, RVs, and fleets.',
    ogDesc: 'Mobile car detailing in Connecticut — interior, full, and exterior packages by quote for approved long-distance appointments.',
    badge: 'Connecticut · By quote',
    h1: 'Mobile Car Detailing in Connecticut',
    facts: ['🚐 We come to you', '📍 CT by quote', '📅 Request appointment'],
    heroSub: 'Interior detail, full detail, and exterior paint enhancement for sedans, SUVs, and trucks — Connecticut service by quote for approved appointments.',
    serviceArea: 'Connecticut service is available by quote for larger details, RVs, fleets, and approved long-distance appointments.',
    specialtyNote: 'Available by quote for larger vehicles, fleets, RVs, boats, and long-distance appointments. Most bookings are car detailing — <a href="#" onclick="openBookingFromHome(\'cars\');return false;" style="color:var(--blue);font-weight:600;text-decoration:none">start with packages above</a> or call <a href="tel:5513132956" style="color:var(--blue);text-decoration:none">551-313-2956</a>.',
    locTitle: 'CONNECTICUT SERVICES IN',
    heroClass: ' hero--ct',
  },
  'pennsylvania-hub.html': {
    metaDesc: 'Mobile interior, full, and exterior car detailing in Pennsylvania. Service by quote for approved appointments, larger details, RVs, and fleets.',
    ogDesc: 'Mobile car detailing in Pennsylvania — interior, full, and exterior packages by quote for approved long-distance appointments.',
    badge: 'Pennsylvania · By quote',
    h1: 'Mobile Car Detailing in Pennsylvania',
    facts: ['🚐 We come to you', '📍 PA by quote', '📅 Request appointment'],
    heroSub: 'Interior detail, full detail, and exterior paint enhancement for sedans, SUVs, and trucks — Pennsylvania service by quote for approved appointments.',
    serviceArea: 'Pennsylvania service is available by quote for larger details, RVs, fleets, and approved long-distance appointments.',
    specialtyNote: 'Available by quote for larger vehicles, fleets, RVs, boats, and long-distance appointments. Most bookings are car detailing — <a href="#" onclick="openBookingFromHome(\'cars\');return false;" style="color:var(--blue);font-weight:600;text-decoration:none">start with packages above</a> or call <a href="tel:5513132956" style="color:var(--blue);text-decoration:none">551-313-2956</a>.',
    locTitle: 'PENNSYLVANIA SERVICES IN',
    heroClass: ' hero--pa',
  },
};

function heroHtml(cfg) {
  return `<!-- HERO -->
<section class="hero${cfg.heroClass}">
  <div class="hero-inner">
    <div class="hero-badge">${cfg.badge}</div>
    <h1>${cfg.h1}</h1>
    <ul class="hero-facts" aria-label="Service highlights">
      ${cfg.facts.map((f) => `<li>${f}</li>`).join('\n      ')}
    </ul>
    <p class="hero-sub">${cfg.heroSub}</p>
    <div class="hero-btns">
      <button type="button" class="btn-primary booking-popup-trigger" onclick="openBooking(null)">Book Mobile Detail</button>
      <a class="btn-outline" href="tel:5513132956">Call / Text</a>
    </div>
    <p class="hero-trust-line">No charge today — your card holds your slot. Final payment after service.</p>
    <div id="zip-section" aria-label="Check service area by ZIP code">
      <details class="hero-zip-details">
        <summary>Check ZIP for local pricing</summary>
        <div class="hero-zip-wrap hero-zip-wrap--compact">
          <span class="hero-zip-label">Enter ZIP for local pricing</span>
          <div class="hero-zip-row">
            <input class="hero-zip-input" id="hero-zip" type="text" inputmode="numeric" maxlength="5" placeholder="ZIP code" autocomplete="postal-code" oninput="onHeroZipInput(this.value)" onkeydown="if(event.key==='Enter')onHeroZipSubmit()">
            <button class="hero-zip-btn" id="hero-zip-btn" type="button" onclick="onHeroZipSubmit()"><span class="hero-zip-spin" aria-hidden="true"></span><span class="hero-zip-btn-lbl">Check ZIP</span></button>
          </div>
          <div class="hero-zip-feedback" id="hero-zip-feedback">
            <span style="font-size:12px;color:var(--mu)">${cfg.serviceArea}</span>
          </div>
        </div>
      </details>
    </div>
    <p class="hub-service-area-note">${cfg.serviceArea}</p>
    <a class="hero-tel-mobile" href="tel:5513132956">📞 Call 551-313-2956</a>
  </div>
</section>`;
}

function patchNav(html) {
  return html
    .replace(
      /<a class="nav-link" onclick="openPortal\(\);document\.getElementById\('nav-links'\)\.classList\.remove\('open'\)">My Booking<\/a>\s*/g,
      ''
    )
    .replace(
      /<a class="nav-portal-mobile" onclick="openPortal\(\)">My Booking<\/a>\s*/g,
      ''
    )
    .replace(
      /<a class="nav-cta booking-popup-trigger" onclick="openBooking\(null\)">Book Now<\/a>/g,
      '<a class="nav-cta booking-popup-trigger" onclick="openBooking(null)">Book online</a>'
    )
    .replace(
      /<a class="nav-book-mobile booking-popup-trigger" onclick="openBooking\(null\)">Book Now<\/a>/g,
      '<a class="nav-book-mobile booking-popup-trigger" onclick="openBooking(null)">Book online</a>'
    );
}

function patchFile(filename, cfg) {
  const filePath = path.join(root, filename);
  let html = fs.readFileSync(filePath, 'utf8');
  const orig = html;

  if (html.includes('Choose Your Mobile Detailing Package')) {
    console.log(`Skip (already themed): ${filename}`);
    return;
  }

  // Meta / SEO
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${cfg.metaDesc}">`
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    `<meta property="og:description" content="${cfg.ogDesc}">`
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    `<meta name="twitter:description" content="${cfg.ogDesc}">`
  );

  // Light theme CSS
  if (!html.includes('STATE HUB LIGHT THEME')) {
    html = html.replace('</style>', `${hubLightCss}\n</style>`);
  }

  // Nav
  html = patchNav(html);

  // Hero + remove old zip gate + radius
  html = html.replace(
    /<!-- HERO -->[\s\S]*?<!-- LOCATION CAROUSEL -->/,
    `${heroHtml(cfg)}\n\n<!-- LOCATION CAROUSEL -->`
  );

  // Location carousel title contrast
  html = html.replace(
    /font-family:var\(--fd\);font-size:clamp\(28px,5vw,46px\);color:var\(--white\)/g,
    'font-family:var(--fb);font-size:clamp(22px,4vw,32px);color:var(--ink);font-weight:600'
  );
  html = html.replace(/SERVICES IN<br>/, `${cfg.locTitle}<br>`);

  // Services section
  html = html.replace(
    /<!-- SERVICES -->[\s\S]*?<!-- HOW IT WORKS -->/,
    `${servicesHtml}\n\n${howHtml3Step}\n\n<!-- SPECIALTY PLACEHOLDER -->\n\n<!-- HOW IT WORKS -->`
  );
  // Remove duplicate HOW if specialty placeholder trick left extra
  html = html.replace(/<!-- SPECIALTY PLACEHOLDER -->\s*\n\s*<!-- HOW IT WORKS -->[\s\S]*?<!-- TRUST -->/, () => {
    const spec = specialtyHtml.replace(
      /<p class="specialty-note">[\s\S]*?<\/p>/,
      `<p class="specialty-note">${cfg.specialtyNote}</p>`
    );
    return `${spec}\n\n<!-- TRUST -->`;
  });

  // Trust row copy
  html = html.replace(
    /<!-- TRUST -->[\s\S]*?<!-- REVIEWS -->/,
    `<!-- TRUST -->
<div class="section-full" style="background:var(--bg1)">
  <div class="section">
    <div class="trust-row">
      <div class="trust-item"><div class="trust-ico">🚐</div><div class="trust-val">Mobile</div><div class="trust-lbl">We come to you</div></div>
      <div class="trust-item"><div class="trust-ico">📍</div><div class="trust-val">Local</div><div class="trust-lbl">By appointment</div></div>
      <div class="trust-item"><div class="trust-ico">✓</div><div class="trust-val">No charge today</div><div class="trust-lbl">Card holds your slot</div></div>
      <div class="trust-item"><div class="trust-ico">📋</div><div class="trust-val">Clear packages</div><div class="trust-lbl">Interior · Full · Exterior</div></div>
      <div class="trust-item"><div class="trust-ico">📅</div><div class="trust-val">Book online</div><div class="trust-lbl">Anytime</div></div>
    </div>
  </div>
</div>

<!-- REVIEWS -->`
  );

  // Booking step 1 cars category
  html = html.replace(
    /<div class="svc-from" id="bkfrom-cars" style="font-size:12px">From \$175<\/div>/,
    '<div class="svc-cat-note" id="bkfrom-cars">Packages shown after ZIP check</div>'
  );

  // Booking step 2 package detail panel
  if (!html.includes('id="pkg-detail-panel"')) {
    html = html.replace(
      '<div class="pkg-grid" id="pkg-grid"></div>',
      `<div class="pkg-grid" id="pkg-grid"></div>
        <div class="pkg-detail-panel" id="pkg-detail-panel" hidden aria-live="polite"></div>`
    );
    html = html.replace(
      '<div class="bdesc">Select a package - price updates by vehicle type or exact length for boats, RVs and travel trailers.</div>',
      '<div class="bdesc">Review what\'s included in your package before entering vehicle details. Price updates by vehicle size or exact length for boats, RVs and travel trailers.</div>'
    );
    html = html.replace(
      '<button type="button" class="btn-n" id="next2" disabled onclick="bkGoTo(3)">Enter Vehicle →</button>',
      '<button type="button" class="btn-n" id="next2" disabled onclick="bkGoTo(3)">Continue to vehicle →</button>'
    );
  }

  // Pricing caps
  html = html.replace(/full:300,/g, 'full:285,');
  html = html.replace(/full:325, refresh:425/g, 'full:305, refresh:425');
  html = html.replace(/full:325, refresh:475/g, 'full:315, refresh:475');
  html = html.replace(/full:325, refresh:465/g, 'full:325, refresh:465'); // truck unchanged

  // CAR_PKG_DETAILS + helpers
  if (!html.includes('const CAR_PKG_DETAILS')) {
    html = html.replace('// ── PRICING DATA ──────────────────────────────────────────────────────────────\nconst PRICING = {', `// ── PRICING DATA ──────────────────────────────────────────────────────────────\n${fullCarPkgJsBlock}\nconst PRICING = {`);
  }

  // selectPkg
  html = html.replace(
    /function selectPkg\(id\)\{[\s\S]*?if\(ST\.pkg\) setTimeout\(\(\)=>bkGoTo\(3\), 180\);\s*\}/,
    selectPkgReplacement
  );
  if (!html.includes('function renderPkgDetailPanel')) {
    // already in fullCarPkgJsBlock
  }

  // _updateHomeFromPrices + home package helpers
  html = replaceOldUpdateHome(html);

  if (!html.includes('function openBookingCarPkg(pkgId)') || !html.includes('initHeroZipDetails')) {
    let prepend = '';
    if (!html.includes('function openBookingCarPkg(pkgId)')) prepend += `${openBookingCarPkgFn}\n\n`;
    if (!html.includes('initHeroZipDetails')) prepend += `${initHeroZipDetailsJs}\n\n`;
    html = html.replace(
      /\/\/ Opens booking - always allowed, but pre-fills ZIP if already entered on hero\r?\nfunction openBookingFromHome\(cat\)\{/,
      `${prepend}// Opens booking - always allowed, but pre-fills ZIP if already entered on hero\nfunction openBookingFromHome(cat){`
    );
  }

  // Init calls
  if (!html.includes('initHomePkgDetails()')) {
    html = html.replace(
      /seedDefaultTechs\(\);\s*\n<\/script>/,
      `seedDefaultTechs();
_updateHomeFromPrices();
renderHomeAddons();
initHomePkgDetails();
</script>`
    );
  }

  if (html === orig) {
    console.warn(`No changes applied to ${filename} (may already be patched)`);
  } else {
    fs.writeFileSync(filePath, html);
    console.log(`Patched: ${filename}`);
  }
}

for (const [file, cfg] of Object.entries(STATES)) {
  patchFile(file, cfg);
}

console.log('State hub theme sync complete.');
