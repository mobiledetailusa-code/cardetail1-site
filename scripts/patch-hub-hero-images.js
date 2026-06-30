'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'imagens estados');
const destDir = path.join(root, 'assets', 'hubs');

const copies = [
  ['NJ_line_header_desktop_1920x520.webp', 'hero-nj-desktop.webp'],
  ['NJ_line_header_mobile_900x600.webp', 'hero-nj-mobile.webp'],
  ['NY_line_header_desktop_1920x520.webp', 'hero-ny-desktop.webp'],
  ['NY_line_header_mobile_900x600.webp', 'hero-ny-mobile.webp'],
  ['CT_line_header_desktop_1920x520.webp', 'hero-ct-desktop.webp'],
  ['CT_line_header_mobile_900x600.webp', 'hero-ct-mobile.webp'],
  ['PA_line_header_desktop_1920x520.webp', 'hero-pa-desktop.webp'],
  ['PA_line_header_mobile_900x600.webp', 'hero-pa-mobile.webp'],
];

fs.mkdirSync(destDir, { recursive: true });
for (const [src, dest] of copies) {
  fs.copyFileSync(path.join(srcDir, src), path.join(destDir, dest));
  console.log('Copied', dest);
}

const hubPages = [
  { file: 'bergen-county-hub.html', cls: 'hero--nj' },
  { file: 'hudson-county-hub.html', cls: 'hero--nj' },
  { file: 'essex-county-hub.html', cls: 'hero--nj' },
  { file: 'passaic-county-hub.html', cls: 'hero--nj' },
  { file: 'ny-metro-hub.html', cls: 'hero--ny' },
  { file: 'connecticut-hub.html', cls: 'hero--ct' },
  { file: 'pennsylvania-hub.html', cls: 'hero--pa' },
];

const heroBgBlock = (cls) =>
  `  <div class="hero-bg-desktop" aria-hidden="true"></div>\n  <div class="hero-bg-mobile" aria-hidden="true"></div>`;

const stripInlineHeroBg = (html) =>
  html
    .replace(
      /\.hero\{background:\s*\n[\s\S]*?url\("assets\/hero-mobile-detailing\.webp"\)[^}]+\}/,
      '.hero{background:linear-gradient(180deg,#020b18,#030d1a,var(--bg0))}'
    )
    .replace(
      /@media\(max-width:760px\)\{\s*\.hero\{background:[\s\S]*?url\("assets\/hero-mobile-detailing-720\.webp"\)[^}]+\}/,
      ''
    )
    .replace(
      /  \.hero\{text-align:left;justify-content:flex-start;background-position:center right !important\}/,
      '  .hero{text-align:left;justify-content:flex-start}'
    );

for (const { file, cls } of hubPages) {
  const filePath = path.join(root, file);
  let html = fs.readFileSync(filePath, 'utf8');

  if (!html.includes('assets/hub-styles.css')) {
    html = html.replace('</style>', '</style>\n<link rel="stylesheet" href="assets/hub-styles.css">');
  }

  html = stripInlineHeroBg(html);

  if (!html.includes('hero-bg-desktop')) {
    html = html.replace(
      /<section class="hero">/,
      `<section class="hero ${cls}">\n${heroBgBlock(cls)}`
    );
  } else {
    html = html.replace(/<section class="hero[^"]*">/, `<section class="hero ${cls}">`);
  }

  fs.writeFileSync(filePath, html, 'utf8');
  console.log('Patched', file);
}

// index.html: NJ hero + ZIP fallback (handled separately if script re-run)
const indexPath = path.join(root, 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf8');

if (!indexHtml.includes('assets/hub-styles.css')) {
  indexHtml = indexHtml.replace('</style>', '</style>\n<link rel="stylesheet" href="assets/hub-styles.css">');
}

indexHtml = stripInlineHeroBg(indexHtml);

if (!indexHtml.includes('hero-bg-desktop')) {
  indexHtml = indexHtml.replace(
    /<section class="hero">/,
    `<section class="hero hero--nj">\n${heroBgBlock('hero--nj')}`
  );
}

indexHtml = indexHtml.replace(
  /if\(hub\)\{\s*sessionStorage\.setItem\('cd1_zip', zip5\);\s*sessionStorage\.setItem\('cd1_hub', hub\.key\);\s*window\.location\.href = hub\.page \+ '\?zip=' \+ encodeURIComponent\(zip5\);\s*return;\s*\}\s*inp\.classList\.add\('valid'\);\s*inp\.classList\.remove\('invalid'\);\s*if\(fb\) fb\.innerHTML = `\s*<div style="background:rgba\(255,255,255,\.06\);[\s\S]*?<\/div>`;/,
  `if(hub){
    sessionStorage.setItem('cd1_zip', zip5);
    sessionStorage.setItem('cd1_hub', hub.key);
    window.location.href = hub.page + '?zip=' + encodeURIComponent(zip5);
    return;
  }
  inp.classList.remove('valid');
  inp.classList.add('invalid');
  console.log('[Cardetail1 ZIP]', zip5, '→ hub: none');
  if(fb) fb.innerHTML = '<span class="hero-zip-err">Service area not found. Please try a different ZIP or contact us.</span>';`
);

fs.writeFileSync(indexPath, indexHtml, 'utf8');
console.log('Patched index.html');
