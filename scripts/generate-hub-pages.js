const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'template-city.html'), 'utf8');

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

for (const hub of hubs) {
  let html = template
    .replace(/\{CITY_NAME\}/g, hub.name)
    .replace(navOld, navFix)
    .replace(footContactOld, footQuickLinks)
    .replace(bookMobileOld, bookMobileFix)
    .replace(
      `<link rel="canonical" href="https://cardetail1.com/">`,
      `<link rel="canonical" href="https://cardetail1.com/${hub.file}">`
    )
    .replace(
      `<meta property="og:url" content="https://cardetail1.com/">`,
      `<meta property="og:url" content="https://cardetail1.com/${hub.file}">`
    )
    .replace(
      `<title>Mobile Detailing in ${hub.name} | Cardetail1</title>`,
      `<title>Premium Mobile Detailing in ${hub.name} | Cardetail1</title>`
    )
    .replace(
      `content="Cardetail1 — premium mobile auto, marine, RV &amp; fleet detailing in ${hub.name}.`,
      `content="Cardetail1 — premium mobile auto, marine, RV &amp; fleet detailing in ${hub.name} (${hub.anchor} hub).`
    )
    .replace(
      `<div class="hero-badge">📍 Serving ${hub.name} &amp; Surrounding Areas | Fully Mobile Service</div>`,
      `<div class="hero-badge">📍 ${hub.badge} | Fully Mobile Service</div>`
    )
    .replace(
      `<p class="hero-sub">Professional mobile detailing in ${hub.name} — we bring the water, the power, and the expertise directly to your driveway. No waiting rooms, no hassle—just a showroom finish at your doorstep.</p>`,
      `<p class="hero-sub">${hub.sub}</p>`
    )
    .replace(
      `<div class="foot-areas">Serving Bergen County · Hudson County · Manhattan · Long Island · Fairfield CT · and surrounding areas</div>`,
      `<div class="foot-areas">Serving ${hub.footAreas} · and surrounding areas · <a href="index.html" style="color:var(--mu);text-decoration:none">← All service areas</a></div>`
    )
    .replace(
      `<!--
  CITY LANDING PAGE TEMPLATE — replace tokens per city:`,
      `<!-- HUB PAGE: ${hub.name} (anchor: ${hub.anchor}) — covers ${hub.areas} -->`
    )
    .replace(initAnchor, zipInit + initAnchor);

  fs.writeFileSync(path.join(root, hub.file), html);
  console.log('Created', hub.file);
}
