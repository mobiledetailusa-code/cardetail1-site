import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const stateHubs = [
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
];

const countyHubs = [
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
];

const cityPages = [
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

const hubGradientInline =
  'background:radial-gradient(circle at 82% 20%,rgba(77,163,255,.12),transparent 34%),linear-gradient(135deg,#07111d 0%,#0a1725 55%,#07101a 100%)!important;min-height:60vh!important;padding:88px 20px 48px!important;border-bottom:1px solid rgba(255,255,255,.08)!important;text-align:center!important;position:relative!important;overflow:hidden!important';

function stripHeroBgLayers(html) {
  return html
    .replace(/\s*<div class="hero-bg-desktop" aria-hidden="true"><\/div>\s*/g, '\n')
    .replace(/\s*<div class="hero-bg-mobile" aria-hidden="true"><\/div>\s*/g, '\n');
}

function normalizeStateHubHero(html) {
  html = stripHeroBgLayers(html);
  html = html.replace(
    /class="hero (hero--(?:nj|ny|ct|pa)) (hub-(?:nj|ny|ct|pa)) hero--contrast(?: hero--luxury luxury-hero-glow)?"/g,
    'class="hero $1 $2 hero--hub-brand hero--contrast"'
  );
  html = html.replace(
    /\.hero--nj,\.hero--ny,\.hero--ct,\.hero--pa,\.hub-nj,\.hub-ny,\.hub-ct,\.hub-pa\{background:[^}]+\}/,
    `.hero--nj,.hero--ny,.hero--ct,.hero--pa,.hub-nj,.hub-ny,.hub-ct,.hub-pa,.hero--hub-brand{${hubGradientInline}}`
  );
  html = html.replace(
    /\.hero--nj::before,\.hero--ny::before,\.hero--ct::before,\.hero--pa::before,\.hub-nj::before,\.hub-ny::before,\.hub-ct::before,\.hub-pa::before\{display:none!important\}/,
    '.hero--nj::before,.hero--ny::before,.hero--ct::before,.hero--pa::before,.hub-nj::before,.hub-ny::before,.hub-ct::before,.hub-pa::before,.hero--hub-brand::before{display:none!important}'
  );
  return html;
}

function normalizeCountyHubHero(html) {
  html = stripHeroBgLayers(html);
  html = html.replace(
    /<section class="hero hero--nj hub-nj">/g,
    '<section class="hero hero--hub-brand hero--nj hub-nj">'
  );
  html = html.replace(
    /\.hero\{background:linear-gradient\(180deg,#020b18,#030d1a,var\(--bg0\)\)\}/,
    '.hero{background:transparent}'
  );
  return html;
}

function normalizeCityHero(html) {
  html = html.replace(
    /<section class="hero">/g,
    '<section class="hero hero--hub-brand">'
  );
  html = html.replace(
    /\.hero\{background:\s*linear-gradient\(90deg,rgba\(2,4,10,\.90\)[\s\S]*?url\("assets\/hero-mobile-detailing\.webp"\)[^}]+\}/,
    '.hero{background:transparent}'
  );
  html = html.replace(
    /\.hero\{background:\s*linear-gradient\(90deg,rgba\(2,4,10,\.94\)[\s\S]*?url\("assets\/hero-mobile-detailing-720\.webp"\)[^}]+\}/,
    '.hero{background:transparent}'
  );
  if (!html.includes('assets/hub-styles.css')) {
    html = html.replace(
      '<link rel="stylesheet" href="assets/booking-modal-light.css">',
      '<link rel="stylesheet" href="assets/hub-styles.css">\n<link rel="stylesheet" href="assets/booking-modal-light.css">'
    );
  }
  return html;
}

function normalizeIndexHero(html) {
  html = stripHeroBgLayers(html);
  html = html.replace(
    /<section class="hero hero--luxury hero--home luxury-hero-glow">/,
    '<section class="hero">'
  );
  html = html.replace(
    /<link rel="stylesheet" href="assets\/hub-styles\.css">\s*\n/,
    ''
  );
  return html;
}

const indexPath = path.join(root, 'index.html');
fs.writeFileSync(indexPath, normalizeIndexHero(fs.readFileSync(indexPath, 'utf8')));
console.log('updated index.html');

for (const file of [...stateHubs, ...countyHubs]) {
  const filePath = path.join(root, file);
  const fn = stateHubs.includes(file) ? normalizeStateHubHero : normalizeCountyHubHero;
  fs.writeFileSync(filePath, fn(fs.readFileSync(filePath, 'utf8')));
  console.log(`updated ${file}`);
}

for (const file of cityPages) {
  const filePath = path.join(root, file);
  fs.writeFileSync(filePath, normalizeCityHero(fs.readFileSync(filePath, 'utf8')));
  console.log(`updated ${file}`);
}

console.log('PR #96 hero revision applied');
