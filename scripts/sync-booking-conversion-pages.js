#!/usr/bin/env node
/**
 * Sync / verify booking conversion labels + script includes across booking pages.
 *
 * Canonical source of booking UX scripts: assets/booking-*-client|ux.js
 * Canonical page for full booking modal: index.html (mirrors share Step-4 fields).
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

/** Only replace these exact option/label strings inside booking markup — not SEO copy. */
const replacements = [
  ['<div class="fl">Water available?</div>', '<div class="fl">Water access at the service location</div>'],
  ['<div class="fl">Electricity available?</div>', '<div class="fl">Electricity access at the service location</div>'],
  ['Yes, water spigot/hose access available', 'Available — outdoor faucet or hose connection'],
  ['No water available', 'Not available'],
  ['Yes, outlet available', 'Available — standard outlet nearby'],
  ['No electricity available', 'Not available'],
];

const scripts = [
  '<script src="assets/booking-availability-client.js"></script>',
  '<script src="assets/booking-conversion-ux.js"></script>',
];

const requiredMarkers = [
  'id="f-water"',
  'id="f-electric"',
  'value="yes"',
  'value="no"',
  'value="unsure"',
  'outdoor faucet or hose connection',
  'standard outlet nearby',
  'assets/booking-availability-client.js',
  'assets/booking-conversion-ux.js',
  'bkInitSchedulePicker',
  'bkValidateScheduleSelection',
  'bkEarliestBookable',
];

function applyTransforms(html) {
  let next = html;
  for (const [from, to] of replacements) {
    next = next.split(from).join(to);
  }
  for (const s of scripts) {
    if (next.includes(s)) continue;
    if (next.includes('<script src="assets/revops-init.js"></script>')) {
      next = next.replace(
        '<script src="assets/revops-init.js"></script>',
        `<script src="assets/revops-init.js"></script>\n${s}`
      );
    } else if (next.includes('assets/back-to-top.js')) {
      next = next.replace(
        /<script src="assets\/back-to-top\.js"[^>]*><\/script>/,
        `${s}\n$&`
      );
    } else {
      next = next.replace('</body>', `${s}\n</body>`);
    }
  }
  return next;
}

let drift = 0;
for (const page of pages) {
  const file = path.join(root, page);
  const before = fs.readFileSync(file, 'utf8');
  const after = applyTransforms(before);

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
