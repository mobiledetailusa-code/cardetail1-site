#!/usr/bin/env node
/**
 * Sync / verify booking conversion Step-4 form + script includes across booking pages.
 *
 * Canonical source: index.html (BK_DETAILS_FORM_START … BK_DETAILS_FORM_END)
 * Canonical UX scripts: assets/booking-*-client|ux.js
 *
 * Usage:
 *   node scripts/sync-booking-conversion-pages.js          # apply
 *   node scripts/sync-booking-conversion-pages.js --check  # exit 1 on drift
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');

function normalizeEol(text) {
  return String(text).replace(/\r\n/g, '\n');
}

const pages = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

const FORM_START = '<!-- BK_DETAILS_FORM_START -->';
const FORM_END = '<!-- BK_DETAILS_FORM_END -->';
const REVIEW_START = '<!-- BK_REVIEW_SUBMIT_START -->';
const SUCCESS_END = '<!-- BK_SUCCESS_END -->';

const scripts = [
  '<script src="assets/booking-availability-client.js"></script>',
  '<script src="assets/booking-conversion-ux.js"></script>',
  '<script src="assets/booking-address-suggest.js"></script>',
];

const powersportsAssets = [
  '<script src="assets/powersports-model-catalog.js"></script>',
  '<script src="assets/powersports-booking-safety.js"></script>',
];

const powersportsCatalogProjection =
  '  powersports: window.CD1PowersportsCatalog.powersportsModelsByMake(),\n';

const powersportsConfirmBlock = `  // Cars confirm only via make-in / model-sel / year-sel — never g-make leftovers.
  if(ST.cat==='cars') return;

  if(ST.cat==='powersports'){
    const resolution=CD1PowersportsBookingSafety.resolveAndApply(ST,PRICING.powersports,make,model);
    typeof bindPowersportsPackageCopy==='function'&&bindPowersportsPackageCopy();
    const canContinue=CD1PowersportsBookingSafety.presentResolution(ST,resolution,make,model,year,document);
    typeof syncTierChipsVisibility==='function'&&syncTierChipsVisibility();
    if(!canContinue) return;
  }

  if(!ST.tierKey)return;`;

const powersportsHelperBlock = `function powersportsPublicFromPriceForPackage(pkgId){
  const keys=['motorcycle','motorcycle_large','motorcycle_trike','atv','utv_standard','utv_large'];
  let min=Infinity;
  for(const key of keys){
    const n=Number(PRICING.powersports.tiers[key] && PRICING.powersports.tiers[key][pkgId]);
    if(n>0 && n<min) min=n;
  }
  return min;
}
function powersportsPublicFromPrice(){
  return powersportsPublicFromPriceForPackage('maintenance');
}
function powersportsIsOffroadClass(serviceClass){
  return serviceClass==='atv' || serviceClass==='utv_standard' || serviceClass==='utv_large';
}
function presentPowersportsPackage(pkg, serviceClass){
  if(!pkg) return pkg;
  if(pkg.id!=='restore') return pkg;
  if(!powersportsIsOffroadClass(serviceClass)) return pkg;
  return Object.assign({}, pkg, {
    name:'Deep Detail & Restore',
    tag:'Deeper cleaning and restoration for ATVs and side-by-sides.',
  });
}
function bindPowersportsPackageCopy(){
  if(ST.cat!=='powersports' || !ST.pkgId) return;
  const base=(PRICING.powersports.packages||[]).find(p=>p.id===ST.pkgId);
  if(!base) return;
  ST.pkg=presentPowersportsPackage(base, ST.tierKey);
}

`;

const requiredMarkers = [
  'id="f-water"',
  'id="f-electric"',
  'id="f-arrival-window"',
  'id="f-arrival-window-select"',
  'id="f-arrival-mode-anytime"',
  'id="f-has-alternate"',
  'id="f-notes"',
  'BK_DETAILS_FORM_START',
  'Preferred arrival window',
  'Any time that day',
  'Choose a 3-hour arrival window',
  'Alternate arrival preference',
  'I have an alternate date',
  'Additional notes — Optional',
  'value="yes"',
  'value="no"',
  'value="unsure"',
  'outdoor faucet or hose connection',
  'standard outlet nearby',
  'assets/booking-availability-client.js',
  'assets/booking-conversion-ux.js',
  'assets/booking-address-suggest.js',
  'id="bk-addr-dd"',
  'id="bk-addr-zip-chip"',
  'assets/booking-review-runtime.js',
  'assets/booking-review.css',
  'bkValidateScheduleSelection',
  'bkEarliestBookable',
  'BK_REVIEW_SUBMIT_START',
  'BK_SUCCESS_END',
  'assets/powersports-model-catalog.js',
  'assets/powersports-booking-safety.js',
  'CD1PowersportsCatalog.powersportsModelsByMake()',
  'CD1PowersportsBookingSafety.resolveAndApply',
  'selectRequestPaymentPreference',
  'Submit Booking Request',
  'Request received',
  'id="pc-online"',
  'id="pc-onsite"',
  'id="pc-cash"',
];

function extractFormBlock(html) {
  const a = html.indexOf(FORM_START);
  const b = html.indexOf(FORM_END);
  if (a < 0 || b < 0 || b < a) return null;
  return html.slice(a, b + FORM_END.length);
}

function replaceOrInsertForm(html, canonicalBlock) {
  const existing = extractFormBlock(html);
  if (existing) {
    // Function replacement avoids $' / $& interpolation if the form ever
    // contains a dollar figure next to a quote (the city-page footer leak).
    return html.replace(existing, () => canonicalBlock);
  }

  // Legacy pages: replace from first fgrid inside #bs4 through Access/Notes textareas.
  const bs4 = html.indexOf('id="bs4"');
  if (bs4 < 0) return html;
  const fgrid = html.indexOf('<div class="fgrid"', bs4);
  const btnRow = html.indexOf('<div class="btn-row">', fgrid);
  if (fgrid < 0 || btnRow < 0) return html;
  // Walk back to include any prior form start; replace fgrid… before btn-row
  return html.slice(0, fgrid) + canonicalBlock + '\n        ' + html.slice(btnRow);
}

function ensureScripts(html) {
  let next = html;
  for (const s of scripts) {
    if (next.includes(s)) continue;
    if (next.includes('<script src="assets/revops-init.js"></script>')) {
      next = next.replace(
        '<script src="assets/revops-init.js"></script>',
        () => `<script src="assets/revops-init.js"></script>\n${s}`
      );
    } else if (next.includes('assets/back-to-top.js')) {
      next = next.replace(
        /<script src="assets\/back-to-top\.js"[^>]*><\/script>/,
        (matched) => `${s}\n${matched}`
      );
    } else {
      next = next.replace('</body>', () => `${s}\n</body>`);
    }
  }
  return next;
}

function ensurePowersportsAssets(html) {
  let next = html;
  const missing = powersportsAssets.filter((asset) => !next.includes(asset));
  if (!missing.length) return next;
  const marker = '<script src="assets/booking-vehicle-summary.js"></script>';
  if (next.includes(marker)) {
    return next.replace(marker, () => `${missing.join('\n')}\n${marker}`);
  }
  return next.replace('</head>', () => `${missing.join('\n')}\n</head>`);
}

function extractBraceBlock(html, start) {
  const open = html.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

function extractPricingPowersports(html) {
  const pricing = html.search(/(?:let|const) PRICING = \{/);
  if (pricing < 0) return null;
  const start = html.search(/\r?\n  powersports: \{/);
  if (start < 0) return null;
  return extractBraceBlock(html, start + 1);
}

function syncPricingPowersports(html, canonical) {
  if (!canonical) return html;
  const current = extractPricingPowersports(html);
  if (!current) return html;
  return html.replace(current, () => canonical);
}

function syncPowersportsCatalog(html) {
  const root = html.indexOf('window.SPECIALTY_MODELS = {');
  if (root < 0) return html;
  const powersports = html.indexOf('  powersports:', root);
  const boats = html.indexOf('  boats:', powersports);
  if (powersports < 0 || boats < 0) return html;
  return html.slice(0, powersports) + powersportsCatalogProjection + html.slice(boats);
}

function syncPowersportsBookingLogic(html) {
  let next = html;

  // Clear a prior vehicle class before the ordinary completeness guard, while
  // the customer is still editing make/model fields.
  next = next.replace(
    /(function tryGenericConfirm\(\)\{[\s\S]*?const year=document\.getElementById\('g-year'\)\.value;\r?\n)(?!\s*if\(ST\.cat==='powersports'\) CD1PowersportsBookingSafety\.resetForIdentityChange)/,
    `$1  if(ST.cat==='powersports') CD1PowersportsBookingSafety.resetForIdentityChange(ST,make,model);\n`
  );

  // All pages call the shared exact-metadata resolver. This replaces both the
  // old regex branch and legacy pages that required a preselected price chip.
  next = next.replace(
    /  \/\/ Cars confirm only via make-in \/ model-sel \/ year-sel[^\n]*\n  if\(ST\.cat==='cars'\) return;[\s\S]*?\n  if\(!ST\.tierKey\)return;/,
    () => powersportsConfirmBlock
  );

  // Unknown/free-form models get explicit service-family choices, not raw
  // internal price tiers (and never browser-only golf/equipment prices).
  next = next.replace(
    /    const tiers=PRICING\[cat\]\.tiers;\r?\n    wrap\.innerHTML=Object\.entries\(tiers\)(?:\.filter\([^\r\n]+\))?\.map/,
    () => `    const tiers=cat==='powersports'\n      ? CD1PowersportsBookingSafety.fallbackTiers(PRICING.powersports)\n      : PRICING[cat].tiers;\n    wrap.innerHTML=Object.entries(tiers).map`
  );

  next = next.replace(
    /function selectTier\(key\)\{[\s\S]*?  ST\.classNeedsConfirm=false;/,
    () => `function selectTier(key){
  document.querySelectorAll('.tchip').forEach(c=>c.classList.remove('sel'));
  document.querySelector(\`.tchip[data-tier="\${key}"]\`)?.classList.add('sel');
  if(ST.cat==='powersports'){
    if(!CD1PowersportsBookingSafety.chooseManualClass(ST,key)) return;
    ST.tierKey=key;
    ST.tier=CD1PowersportsBookingSafety.fallbackTiers(PRICING.powersports)[key]||null;
  }else{
    ST.tierKey=key; ST.tier=PRICING[ST.cat].tiers[key];
  }
  ST.classNeedsConfirm=false;`
  );

  next = next.replace(
    "  motorcycle:'motorcycle', atv:'atv', utv:'utv', golfcart:'golfcart', equipment:'equipment', jetski:'jetski',",
    "  motorcycle:'motorcycle', motorcycle_large:'touring_bagger', motorcycle_trike:'trike',\n  atv:'atv', utv:'utv', utv_standard:'utv', utv_large:'utv_crew', golfcart:'golfcart', equipment:'equipment', jetski:'jetski',"
  );

  if (!next.includes('function powersportsPublicFromPrice(')) {
    next = next.replace('// ── STEP 2: PACKAGES', () => `${powersportsHelperBlock}// ── STEP 2: PACKAGES`);
  }

  next = next.replace(
    '  const pkgKey = cat===\'fleet\'?\'essential\':\'full\';\n  const categoryVisual=CATEGORY_VISUALS[cat]||CATEGORY_VISUALS.cars;\n  grid.innerHTML=d.packages.map(p=>{',
    "  const pkgKey = cat==='fleet'?'essential':'full';\n  const categoryVisual=CATEGORY_VISUALS[cat]||CATEGORY_VISUALS.cars;\n  const packages=cat==='powersports' ? d.packages.filter(p=>!p.legacy) : d.packages;\n  grid.innerHTML=packages.map(p=>{"
  );

  if (!next.includes("ST.cat==='powersports' && !a.publicNew")) {
    next = next.replace(
      /    if\(ST\.cat==='cars' && ST\.pkgId==='maint' && addonRequiresShampooOrSteam\(a\)\) return false;/,
      "    if(ST.cat==='powersports' && !a.publicNew) return false;\n    if(ST.cat==='cars' && ST.pkgId==='maint' && addonRequiresShampooOrSteam(a)) return false;"
    );
  }

  next = next.replace(
    /powersports:Math\.min\(\.\.\.Object\.values\(PRICING\.powersports\.tiers\)\.map\(t=>Object\.values\(t\)\.filter\(v=>typeof v==='number'\)\[0\]\|\|99\)\)/,
    'powersports:powersportsPublicFromPrice()'
  );
  next = next.replace(
    /powersports:\{\s*price: Math\.min\(\.\.\.Object\.values\(PRICING\.powersports\.tiers\)\.map\(t=>Object\.values\(t\)\.filter\(v=>typeof v==='number'\)\[0\]\|\|99\)\)\s*\}/,
    'powersports:{ price: powersportsPublicFromPrice() }'
  );
  next = next.replace(
    /powersports: \{ price: Math\.min\(\.\.\.Object\.values\(PRICING\.powersports\.tiers\)\.map\(t=> Object\.values\(t\)\.filter\(v=>typeof v==='number'\)\[0\]\|\|89\)\)/,
    'powersports: { price: powersportsPublicFromPrice()'
  );
  next = next.replace(
    /id="bkfrom-powersports" style="font-size:12px">From \$100</g,
    'id="bkfrom-powersports" style="font-size:12px">From $175<'
  );
  next = next.replace(
    /powersports:\{ ico:'🏍️', name:'Powersports',      desc:'[^']*',\s+from:'From \$100' \}/g,
    (matched) => matched.replace("from:'From $100'", "from:'From $175'")
  );
  next = next.replace(
    /id="hfrom-powersports-amt">\$100</g,
    'id="hfrom-powersports-amt">$175<'
  );

  return next;
}

function extractMarked(html, start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < 0 || b < a) return null;
  return html.slice(a, b + end.length);
}

function replaceReviewSuccess(html, canonical) {
  const existing = extractMarked(html, REVIEW_START, SUCCESS_END);
  if (existing) return html.replace(existing, () => canonical);
  const start = html.search(/<!-- STEP 5:[^\n]*-->/);
  if (start < 0) return html;
  const bcontent = html.indexOf('</div><!-- /bcontent -->', start);
  if (bcontent < 0) return html;
  return html.slice(0, start) + canonical + '\n\n    ' + html.slice(bcontent);
}

function syncProgressTabs(html) {
  return html.replace(
    /<div class="bpt" id="bpt5"><div class="bpn">5<\/div><span>[^<]*<\/span><\/div>\s*<div class="bpt" id="bpt6"><div class="bpn">6<\/div><span>[^<]*<\/span><\/div>/,
    () => '<div class="bpt" id="bpt5"><div class="bpn">5</div><span>Review &amp; Submit</span></div>\n      <div class="bpt" id="bpt6"><div class="bpn">6</div><span>Request Sent</span></div>'
  );
}

function ensureReviewAssets(html) {
  let next = html;
  if (!next.includes('assets/booking-review.css')) {
    if (next.includes('assets/booking-summary.css')) {
      next = next.replace(
        '<link rel="stylesheet" href="assets/booking-summary.css">',
        () => '<link rel="stylesheet" href="assets/booking-summary.css">\n<link rel="stylesheet" href="assets/booking-review.css">'
      );
    } else if (next.includes('</head>')) {
      next = next.replace('</head>', () => '<link rel="stylesheet" href="assets/booking-review.css">\n</head>');
    }
  }
  if (!next.includes('assets/booking-review-runtime.js')) {
    if (next.includes('assets/booking-line-items.js')) {
      next = next.replace(
        /<script src="assets\/booking-line-items\.js"[^>]*><\/script>/,
        (matched) => `${matched}\n<script src="assets/booking-review-runtime.js" defer></script>`
      );
    } else {
      next = next.replace('</body>', () => '<script src="assets/booking-review-runtime.js" defer></script>\n</body>');
    }
  }
  return next;
}

function applyTransforms(html, canonicalForm, canonicalReview) {
  let next = replaceOrInsertForm(html, canonicalForm);
  next = replaceReviewSuccess(next, canonicalReview);
  next = syncProgressTabs(next);
  next = ensureReviewAssets(next);
  next = ensureScripts(next);
  next = ensurePowersportsAssets(next);
  next = syncPricingPowersports(next, canonicalPowersportsPricing);
  next = syncPowersportsCatalog(next);
  next = syncPowersportsBookingLogic(next);
  next = next.replace(
    /<div class="fg full"><div class="fl">Access notes \(optional\)<\/div><textarea class="fta" id="f-access-notes"[^<]*<\/textarea><\/div>\s*/g,
    ''
  );
  return next;
}

const indexHtml = normalizeEol(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
const canonicalForm = extractFormBlock(indexHtml);
const canonicalReview = extractMarked(indexHtml, REVIEW_START, SUCCESS_END);
const canonicalPowersportsPricing = extractPricingPowersports(indexHtml);
if (!canonicalForm) {
  console.error('Canonical BK_DETAILS_FORM block missing from index.html');
  process.exit(1);
}
if (!canonicalReview) {
  console.error('Canonical BK_REVIEW_SUBMIT / BK_SUCCESS block missing from index.html');
  process.exit(1);
}

let drift = 0;
for (const page of pages) {
  const file = path.join(root, page);
  const before = normalizeEol(fs.readFileSync(file, 'utf8'));
  const after = applyTransforms(before, canonicalForm, canonicalReview);

  if (checkOnly) {
    const missing = requiredMarkers.filter((m) => !before.includes(m));
    if (missing.length) {
      console.error(`[check] ${page} missing: ${missing.join(', ')}`);
      drift += 1;
    }
    if (before !== after) {
      console.error(`[check] ${page} would change under sync (drift)`);
      drift += 1;
    } else {
      console.log(`[check] ${page} ok`);
    }
    continue;
  }

  if (before !== after) {
    fs.writeFileSync(file, after);
    console.log('synced', page);
  } else {
    console.log('unchanged', page);
  }
}

if (checkOnly) {
  if (drift) {
    console.error(`Mirror sync check failed (${drift} issue(s)).`);
    process.exit(1);
  }
  console.log('Mirror sync check passed for', pages.length, 'pages. Canonical booking source: index.html');
  process.exit(0);
}
