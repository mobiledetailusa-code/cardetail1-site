#!/usr/bin/env node
/** Inject RevOps scripts and compact Garage Plan CTAs into public HTML pages. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const SCRIPT_BLOCK = `
<script src="assets/customer-segments.js"></script>
<script src="assets/universal-customer-strategy.generated.js"></script>
<script src="assets/booking-routing-gate.js"></script>
<script src="assets/lead-score.js"></script>
<script src="assets/next-best-action.js"></script>
<script src="assets/consent-manager.js"></script>
<script src="assets/revenue-events.js"></script>
<script src="assets/garage-plan.js"></script>
<script src="assets/revops-booking-hooks.js"></script>
<script src="assets/revops-init.js"></script>`;

const COMPACT_CTA = `
<div class="cd1-garage-cta-wrap" style="text-align:center;margin:18px 0 8px">
  <button type="button" data-cd1-garage-cta style="display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;border:1px solid rgba(77,163,255,.45);background:rgba(77,163,255,.08);color:#4da3ff;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit">
    Have 2+ vehicles at one location? <strong>Build Your Garage Plan</strong>
  </button>
  <p style="font-size:12px;color:#8a9bb0;margin-top:8px">One vehicle? Book any package above — same service quality for every customer.</p>
</div>`;

const FOOTER_LINK = `<a href="multi-vehicle-detailing.html">Multi-Vehicle Detailing</a>`;

const TARGETS = [
  'index.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'multi-vehicle-detailing.html',
];

function inject(file) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) return { file, skipped: 'missing' };
  let html = fs.readFileSync(fp, 'utf8');
  let changed = false;

  if (!html.includes('assets/revops-init.js')) {
    html = html.replace('</body>', `${SCRIPT_BLOCK}\n</body>`);
    changed = true;
  } else if (!html.includes('assets/booking-routing-gate.js')) {
    html = html.replace(
      '<script src="assets/universal-customer-strategy.generated.js"></script>',
      '<script src="assets/universal-customer-strategy.generated.js"></script>\n<script src="assets/booking-routing-gate.js"></script>'
    );
    changed = true;
  } else if (!html.includes('assets/universal-customer-strategy.generated.js')) {
    html = html.replace(
      '<script src="assets/universal-customer-strategy.js"></script>',
      '<script src="assets/universal-customer-strategy.generated.js"></script>'
    );
    if (!html.includes('assets/universal-customer-strategy.generated.js')) {
      html = html.replace(
        '<script src="assets/customer-segments.js"></script>',
        '<script src="assets/customer-segments.js"></script>\n<script src="assets/universal-customer-strategy.generated.js"></script>'
      );
    }
    changed = true;
  }

  if (file === 'index.html') {
    if (!html.includes('data-cd1-garage-cta') && html.includes('car-pkg-intro')) {
      html = html.replace(
        '</div>\n\n    <div class="car-pkg-grid">',
        `</div>\n${COMPACT_CTA}\n\n    <div class="car-pkg-grid">`
      );
      changed = true;
    }
    if (!html.includes('multi-vehicle-detailing.html') && html.includes('<h4>Specialty Services</h4>')) {
      html = html.replace(
        '<a href="powersports-detailing.html">Powersports Detailing</a>',
        `<a href="powersports-detailing.html">Powersports Detailing</a>\n        ${FOOTER_LINK}`
      );
      changed = true;
    }
  } else if (!html.includes('data-cd1-garage-cta') && html.includes('class="hero"')) {
    html = html.replace('</header>', `${COMPACT_CTA}\n</header>`);
    changed = true;
  }

  if (changed) fs.writeFileSync(fp, html, 'utf8');
  return { file, changed };
}

const results = TARGETS.map(inject);
console.log(JSON.stringify(results, null, 2));
