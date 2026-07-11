/**
 * Inject shared specialty-service nav + CSS link into public pages.
 * Run: node scripts/inject-specialty-nav.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const CSS_LINK = '<link rel="stylesheet" href="assets/specialty-service-nav.css">';

const NAV_BLOCK = `
<nav class="specialty-service-nav" aria-label="Specialty detailing services">
  <div class="specialty-service-nav-inner">
    <span class="specialty-service-nav-label">Specialty Services</span>
    <div class="specialty-service-links">
      <a class="specialty-service-link" href="rv-detailing.html">RV &amp; Trailers</a>
      <a class="specialty-service-link" href="boats-detailing.html">Boats</a>
      <a class="specialty-service-link" href="powersports-detailing.html">Powersports</a>
    </div>
  </div>
</nav>
`;

const PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function ensureCssLink(html) {
  if (html.includes('assets/specialty-service-nav.css')) return html;
  // Prefer after luxury-theme or hub-styles or booking-modal-light
  const anchors = [
    'assets/luxury-theme.css">',
    'assets/hub-styles.css">',
    'assets/booking-modal-light.css">',
    'assets/public-surface-contrast.css">',
    '</head>',
  ];
  for (const a of anchors) {
    if (html.includes(a)) {
      if (a === '</head>') {
        return html.replace('</head>', `  ${CSS_LINK}\n</head>`);
      }
      return html.replace(a, `${a}\n${CSS_LINK}`);
    }
  }
  return html;
}

function ensureNav(html) {
  if (html.includes('class="specialty-service-nav"')) {
    // Already present — leave as-is (dedicated pages may have aria-current)
    return html;
  }
  // Insert immediately after </nav> that closes #main-nav / first site nav
  const re = /(<nav class="nav"[^>]*>[\s\S]*?<\/nav>)/;
  const m = html.match(re);
  if (!m) {
    console.warn('No .nav found');
    return html;
  }
  return html.replace(re, `${m[1]}\n${NAV_BLOCK}`);
}

let changed = 0;
for (const file of PAGES) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) {
    console.warn('missing', file);
    continue;
  }
  let html = fs.readFileSync(fp, 'utf8');
  const before = html;
  html = ensureCssLink(html);
  html = ensureNav(html);
  if (html !== before) {
    fs.writeFileSync(fp, html);
    changed++;
    console.log('updated', file);
  } else {
    console.log('unchanged', file);
  }
}
console.log('done, changed=', changed);
