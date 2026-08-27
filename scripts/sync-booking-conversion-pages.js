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
];

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
  'assets/booking-review-runtime.js',
  'assets/booking-review.css',
  'bkValidateScheduleSelection',
  'bkEarliestBookable',
  'BK_REVIEW_SUBMIT_START',
  'BK_SUCCESS_END',
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
  next = next.replace(
    /<div class="fg full"><div class="fl">Access notes \(optional\)<\/div><textarea class="fta" id="f-access-notes"[^<]*<\/textarea><\/div>\s*/g,
    ''
  );
  return next;
}

const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const canonicalForm = extractFormBlock(indexHtml);
const canonicalReview = extractMarked(indexHtml, REVIEW_START, SUCCESS_END);
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
  const before = fs.readFileSync(file, 'utf8');
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
