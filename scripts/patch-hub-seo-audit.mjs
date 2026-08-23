#!/usr/bin/env node
/**
 * Hub SEO + conversion quick wins (og:image, FAQ schema, ZIP sync, localized copy).
 * Run: node scripts/patch-hub-seo-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const GBP_URL = 'https://g.page/r/CTJwfJerrQeCEAI/review';

const HUBS = {
  'new-jersey-hub.html': {
    ogImage: 'hero-nj-desktop.webp',
    footAreas:
      'Serving Bergen County · Hudson County · Essex County · Passaic County · and nearby North Jersey areas',
    faq: [
      {
        q: 'Do you come to my home or office in New Jersey?',
        a: 'Yes. We are a mobile detailing service based in Palisades Park, NJ. We bring professional equipment to your driveway, office parking area, or other approved location in Bergen County and nearby NJ areas.',
      },
      {
        q: 'What areas in New Jersey do you serve?',
        a: 'Our core route covers Bergen, Hudson, Essex, and Passaic counties. Enter your ZIP on this page to confirm service and see local pricing. Extended NJ areas may be available by quote.',
      },
      {
        q: 'Is there a travel fee for Bergen County?',
        a: 'Most Bergen County and nearby core NJ ZIP codes have no travel fee. Enter your ZIP to see your exact zone and any distance-based fee before you book.',
      },
      {
        q: 'Do I pay today when I book online?',
        a: 'No charge is made today. Your card is securely saved with Stripe to hold your appointment request. Final payment is collected after service, per your selected payment preference.',
      },
      {
        q: 'What mobile detailing packages do you offer?',
        a: 'Interior detail, full detail, and exterior paint enhancement for cars and SUVs, plus boats, RVs, powersports, and fleet services. Package pricing updates by vehicle size after you enter your ZIP.',
      },
    ],
  },
  'ny-metro-hub.html': {
    ogImage: 'hero-ny-desktop.webp',
    footAreas:
      'Serving Manhattan · Brooklyn · Queens · Bronx · Staten Island · Westchester · Long Island · and surrounding NY Metro areas',
    copy: {
      'Serving Bergen County &amp; North Jersey':
        'Serving NYC &amp; NY Metro by appointment',
      '📍 Bergen County &amp; North Jersey · Local Detail Service':
        '📍 NYC &amp; NY Metro · Mobile detail by appointment',
      'Mon–Fri 8AM–5PM · Bergen County, NJ and nearby areas':
        'Mon–Fri 8AM–5PM · NYC &amp; NY Metro by appointment from our NJ base',
      "We are a local, hard-working team proud to serve our Bergen County neighbors.":
        'We are a mobile detailing team serving New York Metro customers by appointment from our Palisades Park, NJ base.',
      'Serving Bergen County · Hudson County · Manhattan · Long Island · Fairfield CT · and surrounding areas':
        'Serving Manhattan · Brooklyn · Queens · Bronx · Staten Island · Westchester · Long Island · and surrounding NY Metro areas',
      'Your review will appear publicly on Google and help others find us in Bergen County.':
        'Your review will appear publicly on Google and help others find us in the NY Metro area.',
      "const AREAS = 'Bergen County, NJ and nearby NJ/NY areas';":
        "const AREAS = 'NYC and NY Metro by appointment from our NJ base';",
    },
    faq: [
      {
        q: 'Do you detail cars in Manhattan and NYC?',
        a: 'Yes — by appointment. We travel from our Palisades Park, NJ base to Manhattan, Brooklyn, Queens, the Bronx, Staten Island, Westchester, and nearby NY Metro locations. Enter your ZIP to confirm service.',
      },
      {
        q: 'Is there a travel fee for New York City?',
        a: 'Many NYC ZIP codes include a modest distance-based travel fee, shown automatically when you enter your ZIP before booking. Core NJ areas near our base often have no travel fee.',
      },
      {
        q: 'Can you detail at my driveway or parking garage?',
        a: 'Yes, when access, space, and building rules allow. Tell us about driveway, street, garage, or apartment parking in the booking form so we can confirm the appointment.',
      },
      {
        q: 'Do I pay today when I book online?',
        a: 'No charge is made today. Your card is securely saved with Stripe to hold your appointment request. Final payment is collected after service.',
      },
      {
        q: 'How do I book mobile detailing in the NY Metro area?',
        a: 'Tap Book Mobile Detail, enter your ZIP, choose your package and vehicle, then submit your request. We review location, access, and availability, then contact you about confirmation. If you opted in for SMS, that update may be sent by text.',
      },
    ],
  },
  'connecticut-hub.html': {
    ogImage: 'hero-ct-desktop.webp',
    faq: [
      {
        q: 'Do you offer mobile car detailing in Connecticut?',
        a: 'Yes — by quote and approved appointment. We travel from our NJ base for Connecticut jobs when scheduling, distance, and service type fit our route.',
      },
      {
        q: 'Which Connecticut areas do you serve?',
        a: 'Fairfield County, Hartford, New Haven, Waterbury, Danbury, Stamford, and surrounding areas may be available. Enter your ZIP to check eligibility and pricing.',
      },
      {
        q: 'Is Connecticut service by quote only?',
        a: 'Longer-distance Connecticut appointments are often confirmed by quote after we review your ZIP, vehicle, and service type. Enter your ZIP to start.',
      },
      {
        q: 'Do I pay today when I book online?',
        a: 'No charge is made today when your card is saved. Final payment is collected after service according to your booking policy.',
      },
    ],
  },
  'pennsylvania-hub.html': {
    ogImage: 'hero-pa-desktop.webp',
    faq: [
      {
        q: 'Do you offer mobile car detailing in Pennsylvania?',
        a: 'Yes — by quote and approved appointment. We serve parts of the Delaware Valley and eastern PA when distance and scheduling align with our mobile route.',
      },
      {
        q: 'Which Pennsylvania areas do you serve?',
        a: 'Philadelphia, King of Prussia, Allentown, Scranton, and surrounding areas may be available. Enter your ZIP to confirm service and see pricing.',
      },
      {
        q: 'Is there a travel fee for Pennsylvania jobs?',
        a: 'Longer-distance PA appointments may include a distance-based fee. Your ZIP unlocks local pricing and any travel fee before you book.',
      },
      {
        q: 'Do I pay today when I book online?',
        a: 'No charge is made today when your card is saved with Stripe. Final payment is collected after service.',
      },
    ],
  },
};

const FAQ_CSS = `
.hub-faq-section{background:var(--bg0)!important;border-top:1px solid var(--line)!important;padding:48px 24px!important}
.hub-faq-list{max-width:720px;margin:0 auto;display:grid;gap:10px}
.hub-faq-item{background:var(--bg1);border:1px solid var(--line);border-radius:var(--r);padding:0 16px}
.hub-faq-item summary{padding:14px 0;font-weight:600;color:var(--ink);cursor:pointer;list-style:none}
.hub-faq-item summary::-webkit-details-marker{display:none}
.hub-faq-item p{padding:0 0 14px;font-size:14px;color:var(--ink-soft);line-height:1.6;margin:0}
`;

const OPEN_BOOKING_OLD = `function openBooking(cat){
  document.getElementById('bk-ov').classList.add('open');
  document.body.style.overflow='hidden';
  if(cat){selectCategory(cat)}else{bkGoTo(1)}
}`;

const OPEN_BOOKING_NEW = `function syncBookingZipFromHero(){
  const heroZip=document.getElementById('hero-zip');
  let zip5='';
  if(heroZip&&heroZip.value.replace(/\\D/g,'').length===5){
    zip5=heroZip.value.replace(/\\D/g,'').slice(0,5);
  }else{
    const stored=sessionStorage.getItem('cd1_zip')||'';
    zip5=String(stored).replace(/\\D/g,'').slice(0,5);
  }
  if(zip5.length===5){
    const bkZip=document.getElementById('bk-zip');
    if(bkZip) bkZip.value=zip5;
    if(typeof onBkZipInput==='function') onBkZipInput(zip5);
  }
}
function openBooking(cat){
  syncBookingZipFromHero();
  document.getElementById('bk-ov').classList.add('open');
  document.body.style.overflow='hidden';
  if(cat){selectCategory(cat)}else{bkGoTo(1)}
}`;

const FROM_HOME_OLD = `function openBookingFromHome(cat){
  // If ZIP already entered on hero, sync it to the booking modal silently
  const heroZip = document.getElementById('hero-zip');
  if(heroZip && heroZip.value.replace(/\\D/g,'').length === 5){
    const zip5 = heroZip.value.replace(/\\D/g,'').slice(0, 5);
    const bkZip = document.getElementById('bk-zip');
    if(bkZip && !bkZip.value) bkZip.value = zip5;
    if(typeof onBkZipInput === 'function') onBkZipInput(zip5);
  }
  openBooking(cat);
}`;

const FROM_HOME_NEW = `function openBookingFromHome(cat){
  syncBookingZipFromHero();
  openBooking(cat);
}`;

function faqSchema(faq) {
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
${faq
  .map(
    (item) => `    {
      "@type": "Question",
      "name": ${JSON.stringify(item.q)},
      "acceptedAnswer": {
        "@type": "Answer",
        "text": ${JSON.stringify(item.a)}
      }
    }`
  )
  .join(',\n')}
  ]
}
</script>`;
}

function faqHtml(faq) {
  const items = faq
    .map(
      (item) => `      <details class="hub-faq-item">
        <summary>${item.q}</summary>
        <p>${item.a}</p>
      </details>`
    )
    .join('\n');
  return `<!-- LOCAL FAQ -->
<section class="hub-faq-section" id="local-faq" aria-labelledby="hub-faq-heading">
  <div class="section">
    <div class="sec-eye">Questions</div>
    <h2 class="sec-title" id="hub-faq-heading" style="margin-bottom:20px">Mobile detailing FAQ</h2>
    <div class="hub-faq-list">
${items}
    </div>
  </div>
</section>

`;
}

function patchHub(file, cfg) {
  const filePath = path.join(root, file);
  let html = fs.readFileSync(filePath, 'utf8');
  const ogUrl = `https://cardetail1.com/assets/hubs/${cfg.ogImage}`;

  if (!html.includes('property="og:image"')) {
    html = html.replace(
      /(<meta property="og:description" content="[^"]*">)/,
      `$1\n<meta property="og:image" content="${ogUrl}">\n<meta property="og:image:width" content="1920">\n<meta property="og:image:height" content="520">\n<meta name="twitter:image" content="${ogUrl}">`
    );
  }

  if (!html.includes(GBP_URL)) {
    html = html.replace(
      '"sameAs": [\n    "https://www.instagram.com/cardetail1com"\n  ]',
      `"sameAs": [\n    "https://www.instagram.com/cardetail1com",\n    ${JSON.stringify(GBP_URL)}\n  ]`
    );
  }

  if (!html.includes('"@type": "FAQPage"')) {
    html = html.replace('</script>\n<link rel="preconnect"', `${faqSchema(cfg.faq)}\n<link rel="preconnect"`);
  }

  if (!html.includes('.hub-faq-section')) {
    html = html.replace('.hub-service-area-note{', `${FAQ_CSS}\n.hub-service-area-note{`);
  }

  if (!html.includes('id="local-faq"')) {
    html = html.replace('<!-- CTA SECTION -->', `${faqHtml(cfg.faq)}<!-- CTA SECTION -->`);
  }

  if (cfg.footAreas) {
    html = html.replace(
      /<div class="foot-areas">[^<]*<\/div>/,
      `<div class="foot-areas">${cfg.footAreas}</div>`
    );
  }

  if (cfg.copy) {
    for (const [from, to] of Object.entries(cfg.copy)) {
      html = html.split(from).join(to);
    }
  }

  if (!html.includes('function syncBookingZipFromHero')) {
    html = html.replace(OPEN_BOOKING_OLD, OPEN_BOOKING_NEW);
    html = html.replace(FROM_HOME_OLD, FROM_HOME_NEW);
  }

  fs.writeFileSync(filePath, html);
  console.log('patched', file);
}

function patchIndex() {
  const file = path.join(root, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  const ogUrl = 'https://cardetail1.com/assets/vehicles/premium/cars-suvs.webp';

  if (!html.includes('property="og:image"')) {
    html = html.replace(
      /(<meta property="og:description" content="[^"]*">)/,
      `$1\n<meta property="og:image" content="${ogUrl}">\n<meta name="twitter:image" content="${ogUrl}">`
    );
  }

  if (!html.includes(GBP_URL)) {
    html = html.replace(
      '"sameAs": [\n    "https://www.instagram.com/cardetail1com"\n  ]',
      `"sameAs": [\n    "https://www.instagram.com/cardetail1com",\n    ${JSON.stringify(GBP_URL)}\n  ]`
    );
  }

  const indexOpenOld = `function openBooking(cat){
  document.getElementById('bk-ov').classList.add('open');
  document.body.style.overflow='hidden';
  if(cat){selectCategory(cat)}else{bkGoTo(1)}
}`;

  const indexOpenNew = `function syncBookingZipFromHero(){
  const heroZip=document.getElementById('hero-zip');
  let zip5='';
  if(heroZip&&heroZip.value.replace(/\\D/g,'').length===5){
    zip5=heroZip.value.replace(/\\D/g,'').slice(0,5);
  }else{
    const stored=sessionStorage.getItem('cd1_zip')||'';
    zip5=String(stored).replace(/\\D/g,'').slice(0,5);
  }
  if(zip5.length===5){
    const bkZip=document.getElementById('bk-zip');
    if(bkZip) bkZip.value=zip5;
    if(typeof onBkZipInput==='function') onBkZipInput(zip5);
  }
}
function openBooking(cat){
  syncBookingZipFromHero();
  document.getElementById('bk-ov').classList.add('open');
  document.body.style.overflow='hidden';
  if(cat){selectCategory(cat)}else{bkGoTo(1)}
}`;

  const indexFromOld = `function openBookingFromHome(cat){
  // If ZIP already entered on hero, sync it to the booking modal silently
  const heroZip = document.getElementById('hero-zip');
  if(heroZip && heroZip.value.replace(/\\D/g,'').length === 5){
    const zip5 = heroZip.value.replace(/\\D/g,'').slice(0, 5);
    const bkZip = document.getElementById('bk-zip');
    if(bkZip && !bkZip.value) bkZip.value = zip5;
    if(typeof onBkZipInput === 'function') onBkZipInput(zip5);
  }
  openBooking(cat);
}`;

  const indexFromNew = `function openBookingFromHome(cat){
  syncBookingZipFromHero();
  openBooking(cat);
}`;

  if (!html.includes('function syncBookingZipFromHero')) {
    html = html.replace(indexOpenOld, indexOpenNew);
    html = html.replace(indexFromOld, indexFromNew);
  }

  fs.writeFileSync(file, html);
  console.log('patched index.html');
}

for (const [file, cfg] of Object.entries(HUBS)) {
  patchHub(file, cfg);
}
patchIndex();
