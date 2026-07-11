import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const stateHeroPatches = {
  'new-jersey-hub.html': {
    badge: 'Mobile Detailing · New Jersey',
    h1: 'Mobile Car Detailing in New Jersey',
    sub: 'Professional on-site interior, exterior and full detailing at your home, office or approved parking location.',
    title: 'Mobile Car Detailing in New Jersey | Cardetail1',
    ogTitle: 'Mobile Car Detailing in New Jersey | Cardetail1',
  },
  'ny-metro-hub.html': {
    badge: 'Mobile Detailing · New York',
    h1: 'Mobile Car Detailing in New York City &amp; Nearby Suburbs',
    sub: 'On-site car detailing across NYC, Westchester and selected nearby New York service areas.',
    title: 'Mobile Car Detailing in NYC &amp; Westchester | Cardetail1',
    ogTitle: 'Mobile Car Detailing in NYC &amp; Westchester | Cardetail1',
  },
  'connecticut-hub.html': {
    badge: 'Mobile Detailing · Connecticut',
    h1: 'Mobile Car Detailing in Connecticut',
    sub: 'Mobile interior, exterior and full detailing in selected Connecticut service areas. Enter your ZIP to confirm availability.',
    title: 'Mobile Car Detailing in Connecticut | Cardetail1',
    ogTitle: 'Mobile Car Detailing in Connecticut | Cardetail1',
  },
  'pennsylvania-hub.html': {
    badge: 'Mobile Detailing · Pennsylvania',
    h1: 'Mobile Car Detailing in Eastern Pennsylvania',
    sub: 'On-site detailing in selected eastern Pennsylvania service areas. Enter your ZIP to confirm availability.',
    title: 'Mobile Car Detailing in Eastern Pennsylvania | Cardetail1',
    ogTitle: 'Mobile Car Detailing in Eastern Pennsylvania | Cardetail1',
  },
};

const countyHeroPatches = {
  'bergen-county-hub.html': { badge: 'Mobile Detailing · Bergen County, NJ', h1: 'Mobile Car Detailing in Bergen County' },
  'essex-county-hub.html': { badge: 'Mobile Detailing · Essex County, NJ', h1: 'Mobile Car Detailing in Essex County' },
  'hudson-county-hub.html': { badge: 'Mobile Detailing · Hudson County, NJ', h1: 'Mobile Car Detailing in Hudson County' },
  'passaic-county-hub.html': { badge: 'Mobile Detailing · Passaic County, NJ', h1: 'Mobile Car Detailing in Passaic County' },
};

const cityHeroPatches = {
  'newark-mobile-detailing.html': { h1: 'Mobile Car Detailing in Newark' },
  'trenton-mobile-detailing.html': { h1: 'Mobile Car Detailing in Trenton' },
  'westchester-mobile-detailing.html': { h1: 'Mobile Car Detailing in Westchester' },
  'template-city.html': { h1: 'Mobile Car Detailing in {CITY_NAME}' },
};

function patchStateHub(file, patch) {
  let html = fs.readFileSync(path.join(root, file), 'utf8');
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${patch.title}</title>`);
  html = html.replace(/property="og:title" content="[^"]*"/, `property="og:title" content="${patch.ogTitle}"`);
  html = html.replace(/name="twitter:title" content="[^"]*"/, `name="twitter:title" content="${patch.ogTitle}"`);
  html = html.replace(
    /<div class="hero-badge">[^<]*<\/div>\s*<h1>[^<]*<\/h1>/,
    `<div class="hero-badge">${patch.badge}</div>\n    <h1>${patch.h1}</h1>`
  );
  html = html.replace(
    /<p class="hero-sub">[^<]*<\/p>/,
    `<p class="hero-sub">${patch.sub}</p>`
  );
  fs.writeFileSync(path.join(root, file), html);
  console.log(`patched state hero: ${file}`);
}

function patchCountyHub(file, patch) {
  let html = fs.readFileSync(path.join(root, file), 'utf8');
  html = html.replace(
    /<div class="hero-badge">[^<]*<\/div>\s*<h1>[^<]*<\/h1>/,
    `<div class="hero-badge">${patch.badge}</div>\n    <h1>${patch.h1}</h1>`
  );
  fs.writeFileSync(path.join(root, file), html);
  console.log(`patched county hero: ${file}`);
}

function patchCityPage(file, patch) {
  let html = fs.readFileSync(path.join(root, file), 'utf8');
  html = html.replace(
    /<h1>Premium Mobile Detailing<br>in <em>[^<]*<\/em><\/h1>/,
    `<h1>${patch.h1}</h1>`
  );
  fs.writeFileSync(path.join(root, file), html);
  console.log(`patched city hero: ${file}`);
}

function patchIndex() {
  const file = 'index.html';
  let html = fs.readFileSync(path.join(root, file), 'utf8');
  html = html.replace(
    /<title>[^<]*<\/title>/,
    '<title>Mobile Car Detailing in Bergen County, NJ | Cardetail1</title>'
  );
  html = html.replace(
    /<h1><span class="hero-h1-line">Mobile Car Detailing<\/span><br class="hero-br"><span class="hero-h1-line">That Comes To You<\/span><\/h1>/,
    '<h1>Mobile Car Detailing at Your Home or Office</h1>'
  );
  html = html.replace(
    /<p class="hero-sub hero-sub--long">[^<]*<\/p>/,
    '<p class="hero-sub hero-sub--long">Interior, exterior and full detailing for cars and SUVs across Bergen County and nearby NJ/NY.</p>'
  );
  html = html.replace(
    /<p class="hero-sub hero-sub--short">[^<]*<\/p>/,
    '<p class="hero-sub hero-sub--short">Interior, exterior and full detailing for cars and SUVs across Bergen County and nearby NJ/NY.</p>'
  );
  if (!html.includes('service-area-accordion.css')) {
    html = html.replace(
      '<link rel="stylesheet" href="assets/public-surface-contrast.css">',
      '<link rel="stylesheet" href="assets/public-surface-contrast.css">\n<link rel="stylesheet" href="assets/service-area-accordion.css">'
    );
  }
  fs.writeFileSync(path.join(root, file), html);
  console.log('patched index hero');
}

for (const [file, patch] of Object.entries(stateHeroPatches)) patchStateHub(file, patch);
for (const [file, patch] of Object.entries(countyHeroPatches)) patchCountyHub(file, patch);
for (const [file, patch] of Object.entries(cityHeroPatches)) patchCityPage(file, patch);
patchIndex();
