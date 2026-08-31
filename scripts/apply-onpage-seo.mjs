#!/usr/bin/env node
/**
 * One-shot on-page SEO patches for existing public HTML.
 * Idempotent where practical. Run after generate-bergen-city-pages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ORIGIN = 'https://cardetail1.com';

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function write(rel, html) {
  fs.writeFileSync(path.join(root, rel), html);
}

const ALT = {
  'subaru-exterior-after': 'After mobile car detailing Subaru Crosstrek Palisades Park NJ — clean paint, dressed trim, and fresh tires',
  'subaru-exterior-before': 'Before mobile car detailing Subaru Crosstrek Palisades Park NJ — road film on paint and dusty wheels',
  'gator-interior-after': 'After mobile interior detailing John Deere Gator Palisades Park NJ — spotless dash, floor mats, and seats',
  'gator-interior-before': 'Before mobile interior detailing John Deere Gator Palisades Park NJ — dusty dash, floor mats, and controls',
  'gmc-exterior-after': 'After mobile car detailing GMC Terrain Bergen County NJ — glossy white paint and deep black trim',
  'gmc-exterior-before': 'Before mobile car detailing GMC Terrain Bergen County NJ — road film on white paint and dusty grille',
  'pet-hair-interior-after': 'After pet hair interior detailing Bergen County NJ — clean fabric seats and rubber floor mats',
  'pet-hair-interior-before': 'Before pet hair interior detailing Bergen County NJ — heavy dog hair on fabric seats',
  'mini-front-after': 'After exterior mobile detailing Mini Cooper S Palisades Park NJ — mirror-gloss black paint',
  'mini-front-before': 'Before exterior mobile detailing Mini Cooper S Palisades Park NJ — dusty hood and dull black paint',
  'mini-side-after': 'After exterior mobile detailing Mini Cooper Clubman Bergen County NJ — deep gloss on dark blue paint',
  'mini-side-before': 'Before exterior mobile detailing Mini Cooper Clubman Bergen County NJ — road dust on lower doors and wheels',
  'mini-rear-after': 'After exterior mobile detailing Mini Cooper Clubman Bergen County NJ — clean split doors and glossy paint',
  'mini-rear-before': 'Before exterior mobile detailing Mini Cooper Clubman Bergen County NJ — thick dust on barn doors and bumper',
  'vienna-rv-front-after': 'After mobile RV detailing Renegade Vienna Palisades Park NJ — glossy black cap and clean windshield',
  'vienna-rv-front-before': 'Before mobile RV detailing Renegade Vienna Palisades Park NJ — mud streaks on black front cap',
  'vienna-rv-roof-after': 'After mobile RV roof cleaning Renegade Vienna NJ — clean solar panels and white roof surface',
  'vienna-rv-roof-before': 'Before mobile RV roof cleaning Renegade Vienna NJ — grime and debris on solar panels and roof',
  'defender-exterior-after': 'After mobile car detailing Land Rover Defender Bergen County NJ — glossy white paint and clean wheels',
  'defender-exterior-before': 'Before mobile car detailing Land Rover Defender Bergen County NJ — road film and dusty wheels',
  'defender-interior-after': 'After interior mobile detailing Land Rover Defender Bergen County NJ — spotless dash and console',
  'defender-interior-before': 'Before interior mobile detailing Land Rover Defender Bergen County NJ — muddy floor mat and dusty dash',
  'volvo-exterior-after': 'After mobile car detailing Volvo XC90 Palisades Park NJ — mirror-gloss black paint',
  'volvo-exterior-before': 'Before mobile car detailing Volvo XC90 Palisades Park NJ — pollen and dust on black hood',
  'luxury-urus': 'Lamborghini Urus after mobile exterior detailing Bergen County NJ — deep gloss on grey paint and clean wheels',
  'luxury-porsche-1': 'Porsche after mobile exterior detailing Palisades Park NJ — mirror-gloss paint and dressed trim',
  'luxury-porsche-2': 'Porsche after mobile exterior detailing Bergen County NJ — clean body lines and glossy finish',
  'luxury-fleet-lineup': 'Two Porsches and Range Rover after multi-vehicle mobile detailing Palisades Park NJ',
  'jayco-dolly-front': 'Jayco Eagle fifth-wheel after mobile RV exterior detailing NJ — glossy white fiberglass front cap',
  'gator-exterior-hero': 'John Deere Gator XUV835M after mobile UTV detailing Bergen County NJ — polished green panels and dressed tires',
};

function patchImages(html) {
  html = html.replace(
    /src="(assets\/(?:before-after|showcase)\/[^"]+?)\.jpg"/g,
    'src="$1.webp"'
  );
  html = html.replace(/<img\b[^>]*>/g, (tag) => {
    const src = tag.match(/src="([^"]+)"/);
    if (!src) return tag;
    const base = path.basename(src[1], path.extname(src[1]));
    const alt = ALT[base];
    if (!alt) return tag;
    if (/alt="/.test(tag)) return tag.replace(/alt="[^"]*"/, `alt="${alt}"`);
    return tag.replace(/<img /, `<img alt="${alt}" `);
  });
  return html;
}

const HOME_FAQ = [
  {
    q: 'Do you come to my home for mobile car detailing in Bergen County?',
    a: 'Yes. Cardetail1 is based in Palisades Park, NJ. We bring water, power, and professional equipment to your driveway, office lot, or other approved location in Bergen County and nearby NJ/NY areas.',
  },
  {
    q: 'How much does mobile car detailing cost in Palisades Park?',
    a: 'Interior Detail starts at $190 for sedans. Premium Full Detail starts at $240 for sedans, $260 for SUVs, and $270 for 3-row SUVs. Exterior Detail & Paint Enhancement starts at $320. Enter your ZIP for the price on your vehicle size.',
  },
  {
    q: 'Is there a travel fee for Bergen County?',
    a: 'Most Bergen County and nearby core NJ ZIP codes have no travel fee. Enter your ZIP on the homepage to see your zone and any distance-based fee before you book.',
  },
  {
    q: 'Do I pay today when I request an appointment?',
    a: 'No. No charge is collected when you submit the request. Payment is handled after service.',
  },
  {
    q: 'Do you bring your own water and power?',
    a: 'Yes. The mobile setup is self-contained. You do not need a hose hookup for a standard driveway job.',
  },
];

const HOME_GRAPH = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': ['LocalBusiness', 'AutomotiveBusiness', 'AutoDetailing'],
      '@id': `${ORIGIN}/#business`,
      name: 'Cardetail1',
      legalName: 'Detailing Zone L.L.C.',
      url: ORIGIN,
      telephone: '+1-551-373-5668',
      description:
        'Mobile car detailing based in Palisades Park, NJ. Serving Bergen County and nearby NJ/NY areas. Interior, full, and exterior packages at your driveway.',
      image: `${ORIGIN}/assets/cardetail1-logo.webp`,
      logo: {
        '@type': 'ImageObject',
        url: `${ORIGIN}/assets/cardetail1-logo-square.png`,
        width: 720,
        height: 720,
      },
      priceRange: '$$',
      serviceType: [
        'Mobile Car Detailing',
        'Interior Detailing',
        'Exterior Detailing',
        'Marine Detailing',
        'RV Detailing',
        'Powersports Detailing',
      ],
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Palisades Park',
        addressRegion: 'NJ',
        postalCode: '07650',
        addressCountry: 'US',
      },
      geo: { '@type': 'GeoCoordinates', latitude: 40.8482, longitude: -73.9976 },
      areaServed: [
        {
          '@type': 'GeoCircle',
          name: 'Mobile service radius',
          geoMidpoint: { '@type': 'GeoCoordinates', latitude: 40.8482, longitude: -73.9976 },
          geoRadius: 241401,
        },
        { '@type': 'AdministrativeArea', name: 'Bergen County, NJ' },
        { '@type': 'City', name: 'Palisades Park, NJ' },
        { '@type': 'City', name: 'Fort Lee, NJ' },
        { '@type': 'City', name: 'Paramus, NJ' },
        { '@type': 'City', name: 'Hackensack, NJ' },
        { '@type': 'City', name: 'Englewood, NJ' },
        { '@type': 'City', name: 'Teaneck, NJ' },
        { '@type': 'City', name: 'Ridgewood, NJ' },
        { '@type': 'City', name: 'Edgewater, NJ' },
        { '@type': 'State', name: 'New Jersey' },
        { '@type': 'State', name: 'New York' },
      ],
      hasOfferCatalog: {
        '@type': 'OfferCatalog',
        name: 'Mobile detailing packages',
        itemListElement: [
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Interior Detail' }, price: '190', priceCurrency: 'USD' },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Premium Full Detail' }, price: '240', priceCurrency: 'USD' },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Exterior Detail & Paint Enhancement' }, price: '320', priceCurrency: 'USD' },
        ],
      },
      openingHoursSpecification: [
        {
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          opens: '08:00',
          closes: '17:00',
        },
      ],
      sameAs: ['https://www.instagram.com/cardetail1com', 'https://g.page/r/CTJwfJerrQeCEAI/review'],
    },
    {
      '@type': 'WebSite',
      '@id': `${ORIGIN}/#website`,
      name: 'Cardetail1',
      url: `${ORIGIN}/`,
      publisher: { '@id': `${ORIGIN}/#business` },
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${ORIGIN}/blog.html?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@type': 'FAQPage',
      '@id': `${ORIGIN}/#faq`,
      mainEntity: HOME_FAQ.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
      ],
    },
  ],
};
const HOME_FAQ_HTML = `
<!-- HOME FAQ (visible; matches FAQPage schema) -->
<section class="home-faq-section" id="faq" aria-labelledby="home-faq-title">
  <div class="section">
    <div class="sec-eye">FAQ</div>
    <h2 id="home-faq-title" class="sec-title">Mobile detailing questions — Bergen County</h2>
    <div class="home-faq">
${HOME_FAQ.map((f) => `      <details><summary>${f.q}</summary><p>${f.a}</p></details>`).join('\n')}
    </div>
  </div>
</section>
`;

const HOME_FAQ_CSS = `
.home-faq{max-width:820px;margin:0 auto;text-align:left}
.home-faq details{border:1px solid var(--line);border-radius:var(--r);padding:14px 18px;margin-bottom:10px;background:var(--bg0)}
.home-faq summary{cursor:pointer;font-weight:600;color:var(--ink);font-size:15px}
.home-faq p{margin-top:10px;color:var(--ink-soft);font-size:14px;line-height:1.6}
`;

const CITY_FOOTER = `        <a href="bergen-county-hub.html">Bergen County</a>
        <a href="palisades-park-mobile-detailing.html">Palisades Park</a>
        <a href="fort-lee-mobile-detailing.html">Fort Lee</a>
        <a href="paramus-mobile-detailing.html">Paramus</a>
        <a href="hackensack-mobile-detailing.html">Hackensack</a>
        <a href="index.html#service-areas">Extended Areas by Quote</a>`;

const CITY_GRID = `      <a class="service-area-city-link" href="/palisades-park-mobile-detailing.html">Mobile detailing in Palisades Park</a>
      <a class="service-area-city-link" href="/fort-lee-mobile-detailing.html">Mobile detailing in Fort Lee</a>
      <a class="service-area-city-link" href="/paramus-mobile-detailing.html">Mobile detailing in Paramus</a>
      <a class="service-area-city-link" href="/hackensack-mobile-detailing.html">Mobile detailing in Hackensack</a>
      <a class="service-area-city-link" href="/englewood-mobile-detailing.html">Mobile detailing in Englewood</a>
      <a class="service-area-city-link" href="/teaneck-mobile-detailing.html">Mobile detailing in Teaneck</a>
      <a class="service-area-city-link" href="/ridgewood-mobile-detailing.html">Mobile detailing in Ridgewood</a>
      <a class="service-area-city-link" href="/edgewater-mobile-detailing.html">Mobile detailing in Edgewater</a>
      <a class="service-area-city-link" href="/bergen-county-hub.html">Mobile detailing in Bergen County</a>`;

function patchIndex(html) {
  if (!html.includes('rel="preload" as="image" href="assets/vehicles/premium/cars-suvs.webp"')) {
    html = html.replace(
      '<link rel="canonical" href="https://cardetail1.com/">',
      `<link rel="canonical" href="https://cardetail1.com/">
<link rel="preload" as="image" href="assets/vehicles/premium/cars-suvs.webp" fetchpriority="high">`
    );
  }

  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="Mobile car detailing in Palisades Park and Bergen County, NJ. Interior from $190, full detail from $240 at your driveway. We bring water and power. Book online.">'
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    '<meta property="og:description" content="Mobile car detailing in Palisades Park and Bergen County, NJ. Interior from $190, full detail from $240 at your driveway. Book online.">'
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="Mobile car detailing in Palisades Park and Bergen County, NJ. Interior from $190, full detail from $240 at your driveway. Book online.">'
  );

  const ldStart = html.indexOf('<script type="application/ld+json">');
  const schemaReady = html.includes('"hasOfferCatalog"') && html.includes('"FAQPage"') && !html.includes('"@graph"');
  if (ldStart >= 0 && !schemaReady) {
    const firstEnd = html.indexOf('</script>', ldStart) + 9;
    const webStart = html.indexOf('<script type="application/ld+json">', firstEnd);
    const webEnd = webStart >= 0 ? html.indexOf('</script>', webStart) + 9 : firstEnd;
    const end = html.includes('"@graph"') ? firstEnd : webEnd;
    const local = { '@context': 'https://schema.org', ...HOME_GRAPH['@graph'][0] };
    const extra = HOME_GRAPH['@graph'].slice(1).map((node) =>
      `<script type="application/ld+json">\n${JSON.stringify({ '@context': 'https://schema.org', ...node }, null, 2)}\n</script>`
    ).join('\n');
    const block = `<script type="application/ld+json">\n${JSON.stringify(local, null, 2)}\n</script>\n${extra}`;
    html = html.slice(0, ldStart) + block + html.slice(end);
  }

  if (!html.includes('.home-faq{')) {
    html = html.replace('</head>', `<style>${HOME_FAQ_CSS}</style>\n</head>`);
  }

  html = html.replace(
    '<div class="sec-title">Choose Your Mobile Detailing Package</div>',
    '<h2 class="sec-title">Choose Your Mobile Detailing Package</h2>'
  );
  html = html.replace(
    '<div class="sec-title" id="ba-heading">See the difference<br>on real jobs</div>',
    '<h2 class="sec-title" id="ba-heading">Before &amp; after mobile detailing in Bergen County</h2>'
  );
  html = html.replace(
    '<div class="sec-title">Customer experiences with Cardetail1</div>',
    '<h2 class="sec-title">Customer experiences with Cardetail1</h2>'
  );

  if (!html.includes('id="faq"')) {
    html = html.replace('<!-- SERVICE AREAS -->', HOME_FAQ_HTML + '\n<!-- SERVICE AREAS -->');
  }

  if (!html.includes('palisades-park-mobile-detailing.html')) {
    html = html.replace(
      /<div class="service-area-city-grid">[\s\S]*?<\/div>\s*<div class="service-area-hub-links">/,
      `<div class="service-area-city-grid">\n${CITY_GRID}\n    </div>\n\n    <div class="service-area-hub-links">`
    );
  }

  html = html.replace(
    `<a href="bergen-county-hub.html">Bergen County</a>
        <a href="index.html#service-areas">Extended Areas by Quote</a>`,
    CITY_FOOTER
  );

  html = html.replace(
    '<img class="nav-logo-img" src="assets/cardetail1-logo.webp" width="520" height="261" alt="Cardetail1 Mobile Detailing" decoding="async">',
    '<img class="nav-logo-img" src="assets/cardetail1-logo.webp" width="520" height="261" alt="Cardetail1 mobile car detailing Palisades Park NJ" decoding="async">'
  );

  html = html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, (m, json) => {
    try {
      const data = JSON.parse(json);
      if ([].concat(data['@type'] || []).includes('LocalBusiness')) {
        delete data.aggregateRating;
        delete data.review;
        return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
      }
    } catch { /* keep original */ }
    return m;
  });

  return patchImages(html);
}

const HUB_TITLES = {
  'bergen-county-hub.html': {
    title: 'Mobile Car Detailing in Bergen County | Palisades Park, NJ',
    desc: 'Mobile car detailing in Bergen County, NJ — Palisades Park, Fort Lee, Paramus, Hackensack, Englewood, Teaneck. Interior from $190. We come to your driveway.',
    h1: null,
  },
  'hudson-county-hub.html': {
    title: 'Mobile Car Detailing in Hudson County | Jersey City & Hoboken',
    desc: 'Mobile car detailing in Hudson County, NJ — Jersey City, Hoboken, and the Gold Coast. Interior, full, and exterior packages at your driveway. Book online.',
  },
  'essex-county-hub.html': {
    title: 'Mobile Car Detailing in Essex County | Newark & Montclair',
    desc: 'Mobile car detailing in Essex County, NJ — Newark, Montclair, Bloomfield, West Orange. Interior, full, and exterior packages at your driveway. Book online.',
  },
  'passaic-county-hub.html': {
    title: 'Mobile Car Detailing in Passaic County | Wayne & Clifton',
    desc: 'Mobile car detailing in Passaic County, NJ — Paterson, Wayne, Clifton, Franklin Lakes. Interior, full, and exterior packages at your driveway. Book online.',
  },
};

const CITY_ACCORDION = {
  'Palisades Park': '/palisades-park-mobile-detailing.html',
  'Fort Lee': '/fort-lee-mobile-detailing.html',
  'Edgewater': '/edgewater-mobile-detailing.html',
  'Englewood': '/englewood-mobile-detailing.html',
  'Teaneck': '/teaneck-mobile-detailing.html',
  'Hackensack': '/hackensack-mobile-detailing.html',
  'Paramus': '/paramus-mobile-detailing.html',
  'Ridgewood': '/ridgewood-mobile-detailing.html',
};

function patchTitleDesc(html, file, spec) {
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${spec.title}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${spec.desc}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${spec.title}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${spec.desc}">`);
  html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${spec.title}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${spec.desc}">`);
  return html;
}

function enrichLocalBusinessJson(html, extraArea) {
  return html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, (m, json) => {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return m;
    }
    const types = [].concat(data['@type'] || []);
    if (!types.includes('LocalBusiness')) return m;
    delete data.aggregateRating;
    delete data.review;
    const cities = extraArea || [];
    const existing = JSON.stringify(data.areaServed || []);
    for (const c of cities) {
      if (!existing.includes(c.name)) {
        data.areaServed = (data.areaServed || []).concat([c]);
      }
    }
    if (!data.hasOfferCatalog) {
      data.hasOfferCatalog = {
        '@type': 'OfferCatalog',
        name: 'Mobile detailing packages',
        itemListElement: [
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Interior Detail' }, price: '190', priceCurrency: 'USD' },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Premium Full Detail' }, price: '240', priceCurrency: 'USD' },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Exterior Detail & Paint Enhancement' }, price: '320', priceCurrency: 'USD' },
        ],
      };
    }
    if (!data.logo) {
      data.logo = {
        '@type': 'ImageObject',
        url: `${ORIGIN}/assets/cardetail1-logo-square.png`,
        width: 720,
        height: 720,
      };
    }
    return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
  });
}

const BERGEN_CITIES_STRIP = `
<section class="sp-section" id="bergen-cities" style="padding:28px 20px 8px">
  <div class="sec-eye" style="text-align:center">Bergen County cities</div>
  <h2 class="sec-title">Mobile detailing near Palisades Park</h2>
  <p class="sec-desc">Dedicated pages for the towns we run from our Palisades Park base. Same packages and ZIP check as the homepage.</p>
  <div class="service-area-city-grid" style="max-width:900px;margin:0 auto 24px">
    <a class="service-area-city-link" href="palisades-park-mobile-detailing.html">Palisades Park</a>
    <a class="service-area-city-link" href="fort-lee-mobile-detailing.html">Fort Lee</a>
    <a class="service-area-city-link" href="paramus-mobile-detailing.html">Paramus</a>
    <a class="service-area-city-link" href="hackensack-mobile-detailing.html">Hackensack</a>
    <a class="service-area-city-link" href="englewood-mobile-detailing.html">Englewood</a>
    <a class="service-area-city-link" href="teaneck-mobile-detailing.html">Teaneck</a>
    <a class="service-area-city-link" href="ridgewood-mobile-detailing.html">Ridgewood</a>
    <a class="service-area-city-link" href="edgewater-mobile-detailing.html">Edgewater</a>
  </div>
</section>
`;

function patchHub(file, spec) {
  let html = read(file);
  html = patchTitleDesc(html, file, spec);
  html = enrichLocalBusinessJson(html, [
    { '@type': 'City', name: 'Palisades Park, NJ' },
    { '@type': 'City', name: 'Fort Lee, NJ' },
    { '@type': 'City', name: 'Paramus, NJ' },
    { '@type': 'City', name: 'Hackensack, NJ' },
    { '@type': 'City', name: 'Englewood, NJ' },
    { '@type': 'City', name: 'Teaneck, NJ' },
    { '@type': 'City', name: 'Ridgewood, NJ' },
  ]);
  if (file === 'bergen-county-hub.html' && !html.includes('bergen-cities')) {
    html = html.replace('<!-- ZIP GATE -->', BERGEN_CITIES_STRIP + '\n<!-- ZIP GATE -->');
  }
  if (!html.includes('palisades-park-mobile-detailing.html') && html.includes('<h4>Service Areas</h4>')) {
    html = html.replace(
      `<a href="bergen-county-hub.html">Bergen County</a>
        <a href="index.html#service-areas">Extended Areas by Quote</a>`,
      CITY_FOOTER
    );
  }
  html = patchImages(html);
  write(file, html);
}

function patchAccordion(file) {
  let html = read(file);
  for (const [name, href] of Object.entries(CITY_ACCORDION)) {
    const re = new RegExp(`<a href="/new-jersey-hub\\.html#bergen-county">${name}</a>`, 'g');
    html = html.replace(re, `<a href="${href}">${name}</a>`);
  }
  write(file, html);
}

function patchCanonicalSelf(file) {
  let html = read(file);
  const url = `${ORIGIN}/${file}`;
  html = html.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`);
  if (!html.includes('noindex') && file === 'template-city.html') {
    html = html.replace('<meta name="viewport"', '<meta name="robots" content="noindex, nofollow">\n<meta name="viewport"');
  }
  html = enrichLocalBusinessJson(html);
  html = patchImages(html);
  write(file, html);
}

function specialtyGraph(page, spec) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Service',
        '@id': `${ORIGIN}/${page}#service`,
        name: spec.name,
        serviceType: spec.serviceType,
        provider: { '@id': `${ORIGIN}/#business` },
        areaServed: spec.areaServed,
        url: `${ORIGIN}/${page}`,
        offers: spec.offers.map((o) => ({
          '@type': 'Offer',
          name: o.name,
          price: String(o.price),
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
          url: `${ORIGIN}/${page}`,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: spec.crumb, item: `${ORIGIN}/${page}` },
        ],
      },
    ],
  };
}

function patchSpecialty(file, spec) {
  let html = read(file);
  const graph = specialtyGraph(file, spec);
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">\n${JSON.stringify(graph, null, 2)}\n</script>`
  );
  if (spec.title) {
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${spec.title}</title>`);
    html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${spec.title}">`);
  }
  if (spec.desc) {
    html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${spec.desc}">`);
  }
  html = patchImages(html);
  write(file, html);
}

function patchRobots() {
  let txt = read('robots.txt');
  if (!txt.includes('template-city.html')) {
    txt = `User-agent: *
Disallow: /customer/
Disallow: /admin/
Disallow: /tech/
Disallow: /admin.html
Disallow: /admin-ops.html
Disallow: /admin-owner-studio.html
Disallow: /admin-owner-studio-catalog.html
Disallow: /technician.html
Disallow: /template-city.html
Disallow: /authorize.html
Disallow: /receipt.html
Disallow: /bid.html
Disallow: /resume.html
Disallow: /customer.html

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

Sitemap: https://cardetail1.com/sitemap.xml
`;
    write('robots.txt', txt);
  }
}

function patchSitemap() {
  let xml = read('sitemap.xml');
  const extras = [
    'palisades-park-mobile-detailing.html',
    'fort-lee-mobile-detailing.html',
    'paramus-mobile-detailing.html',
    'hackensack-mobile-detailing.html',
    'englewood-mobile-detailing.html',
    'teaneck-mobile-detailing.html',
    'ridgewood-mobile-detailing.html',
    'edgewater-mobile-detailing.html',
  ];
  if (!xml.includes('palisades-park-mobile-detailing.html')) {
    const block = extras.map((f) => `  <url><loc>${ORIGIN}/${f}</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`).join('\n');
    xml = xml.replace('  <!-- City pages -->', `  <!-- City pages -->\n${block}`);
  }
  write('sitemap.xml', xml);
}

function writeLlms() {
  const body = `# Cardetail1

> Mobile car, boat, RV, and powersports detailing based in Palisades Park, Bergen County, New Jersey. We come to the driveway with water and power. Cardetail1 is a registered DBA of Detailing Zone L.L.C.

## Primary pages
- [Home](https://cardetail1.com/): Mobile car detailing in Bergen County — packages, ZIP check, booking
- [Bergen County](https://cardetail1.com/bergen-county-hub.html)
- [Palisades Park](https://cardetail1.com/palisades-park-mobile-detailing.html)
- [Fort Lee](https://cardetail1.com/fort-lee-mobile-detailing.html)
- [Paramus](https://cardetail1.com/paramus-mobile-detailing.html)
- [Hackensack](https://cardetail1.com/hackensack-mobile-detailing.html)
- [Englewood](https://cardetail1.com/englewood-mobile-detailing.html)
- [Teaneck](https://cardetail1.com/teaneck-mobile-detailing.html)
- [Ridgewood](https://cardetail1.com/ridgewood-mobile-detailing.html)
- [Edgewater](https://cardetail1.com/edgewater-mobile-detailing.html)
- [Boats](https://cardetail1.com/boats-detailing.html)
- [RVs](https://cardetail1.com/rv-detailing.html)
- [Powersports](https://cardetail1.com/powersports-detailing.html)
- [Fleet](https://cardetail1.com/fleet-services.html)

## Car packages (from prices, sedan unless noted)
- Interior Detail from $190
- Premium Full Detail from $240 (SUVs from $260, 3-row from $270)
- Exterior Detail & Paint Enhancement from $320

## Facts
- Address locality: Palisades Park, NJ 07650
- Phone: +1-551-373-5668
- Hours: Monday–Friday 8:00–17:00, by appointment
- Google listing: 5.0 from 9 reviews (snapshot August 2026)
- Booking: request online, no charge at submission
- Coverage: Bergen County core (no travel fee on standard NJ core ZIPs); Hudson, Essex, Passaic; NY Metro, CT, PA by quote

## Optional
- [llms.txt](https://cardetail1.com/llms.txt)
`;
  write('llms.txt', body);
}

// --- run ---
write('index.html', patchIndex(read('index.html')));

for (const [file, spec] of Object.entries(HUB_TITLES)) {
  patchHub(file, spec);
}

patchAccordion('new-jersey-hub.html');
let nj = read('new-jersey-hub.html');
nj = patchTitleDesc(nj, 'new-jersey-hub.html', {
  title: 'Mobile Car Detailing in New Jersey | Palisades Park & Bergen County',
  desc: 'Mobile car detailing in New Jersey from Palisades Park. Interior, full, and exterior packages in Bergen County and nearby NJ. Book by ZIP.',
});
nj = enrichLocalBusinessJson(nj);
nj = patchImages(nj);
if (!nj.includes('palisades-park-mobile-detailing.html') || true) {
  nj = nj.replace(
    `<a href="bergen-county-hub.html">Bergen County</a>
        <a href="index.html#service-areas">Extended Areas by Quote</a>`,
    CITY_FOOTER
  );
}
write('new-jersey-hub.html', nj);

for (const file of [
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
]) {
  write(file, patchImages(enrichLocalBusinessJson(read(file))));
}

for (const file of [
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
]) {
  patchCanonicalSelf(file);
}

patchSpecialty('boats-detailing.html', {
  name: 'Mobile Boat & Marine Detailing',
  crumb: 'Boat Detailing',
  serviceType: ['Boat Detailing', 'Marine Detailing'],
  areaServed: 'Bergen County and nearby marinas',
  title: 'Mobile Boat Detailing in Bergen County | Palisades Park, NJ',
  desc: 'Mobile boat detailing in Bergen County and nearby marinas. Hull, deck, and cockpit packages from Palisades Park. Priced by length. Book online.',
  offers: [
    { name: 'Marine Wash', price: 170 },
    { name: 'Full Marine Detail', price: 380 },
    { name: 'Premium Marine', price: 595 },
  ],
});

patchSpecialty('rv-detailing.html', {
  name: 'Mobile RV & Travel Trailer Detailing',
  crumb: 'RV Detailing',
  serviceType: ['RV Detailing', 'Travel Trailer Detailing'],
  areaServed: 'Bergen County, New Jersey',
  title: 'Mobile RV Detailing in Bergen County | Palisades Park, NJ',
  desc: 'Mobile RV and travel trailer detailing in Bergen County. Six packages priced by length from our Palisades Park base. Book online.',
  offers: [
    { name: 'Maintenance Wash', price: 270 },
    { name: 'Interior Detail', price: 390 },
    { name: 'Full RV Detail', price: 765 },
  ],
});

patchSpecialty('powersports-detailing.html', {
  name: 'Mobile Powersports Detailing',
  crumb: 'Powersports Detailing',
  serviceType: ['Motorcycle Detailing', 'ATV Detailing', 'UTV Detailing'],
  areaServed: 'Bergen County, New Jersey',
  title: 'Mobile Motorcycle & Powersports Detailing | Palisades Park, NJ',
  desc: 'Mobile motorcycle, ATV, UTV, and Jet Ski detailing in Bergen County. Hand-safe cleaning from Palisades Park. Book online.',
  offers: [
    { name: 'Wash & Shine', price: 100 },
    { name: 'Full Detail', price: 225 },
    { name: 'Premium Detail', price: 315 },
  ],
});

let fleet = read('fleet-services.html');
if (!fleet.includes('application/ld+json')) {
  fleet = fleet.replace(
    '</title>',
    `</title>
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Service',
  name: 'Commercial Fleet Wash & Mobile Detailing',
  provider: { '@id': `${ORIGIN}/#business` },
  areaServed: 'New Jersey',
  url: `${ORIGIN}/fleet-services.html`,
  offers: { '@type': 'Offer', price: '65', priceCurrency: 'USD', name: 'Fleet Maintenance Wash from price' },
})}
</script>`
  );
}
if (!fleet.includes('rel="canonical"')) {
  fleet = fleet.replace(
    '<title>',
    '<link rel="canonical" href="https://cardetail1.com/fleet-services.html">\n<title>'
  );
}
write('fleet-services.html', fleet);

let multi = read('multi-vehicle-detailing.html');
if (!multi.includes('application/ld+json')) {
  multi = multi.replace(
    '</title>',
    `</title>
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Service',
      name: 'Multi-Vehicle Mobile Detailing',
      provider: { '@id': `${ORIGIN}/#business` },
      url: `${ORIGIN}/multi-vehicle-detailing.html`,
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Multi-Vehicle', item: `${ORIGIN}/multi-vehicle-detailing.html` },
      ],
    },
  ],
})}
</script>`
  );
}
write('multi-vehicle-detailing.html', patchImages(multi));

patchRobots();
patchSitemap();
writeLlms();

console.log('apply-onpage-seo: done');
