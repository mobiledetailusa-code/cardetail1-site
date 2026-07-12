#!/usr/bin/env node
/**
 * Sync canonical public footer + shared back-to-top across public HTML pages.
 * Also removes legacy inline portal modal + patches openPortal redirect.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FOOTER_PARTIAL = join(ROOT, 'assets/partials/specialty-public-footer.html');

const PUBLIC_HTML = [
  'index.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'fleet-services.html',
  'multi-vehicle-detailing.html',
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
  'terms-conditions.html',
  'template-city.html',
];

const HUB_PAGES = PUBLIC_HTML.filter((f) =>
  f.includes('-hub.html') || f.includes('-detailing.html') || f === 'template-city.html'
);

const SURFACE_CSS = '<link rel="stylesheet" href="assets/public-surface.css">';
const BTT_JS = '<script src="assets/back-to-top.js" defer></script>';
const HUB_BRIDGE_JS = '<script src="assets/hub-booking-bridge.js" defer></script>';

const CARD_STATUS_BODY =
  "body:JSON.stringify({bookingId:ST.bookingId,phone:(ST.phone||ST.customerPhone||''),draftSaveToken:(ST.draftSaveToken||draftSessionToken||'')})";

const PORTAL_JS_RE =
  /\/\/ ══+\r?\n\/\/ CUSTOMER PORTAL\r?\n\/\/ ══+[\s\S]*?function cpSubmitReview\(\)\{[\s\S]*?cpSetStar\(0\);\r?\n\}/;

const PORTAL_JS_STUB = `// CUSTOMER PORTAL — My Garage handoff (legacy modal removed)
function resetPortalView(){}
function openPortal(){window.location.href='my-garage.html#lookup';}
function closePortal(){}
function handleCpOv(e){}
function cpTab(){openPortal();}
function cpFindBooking(){openPortal();}
function cpSetStar(){openPortal();}
function cpSubmitReview(){openPortal();}`;

const CP_OV_MODAL_RE =
  /<div class="cp-ov" id="cp-ov"[\s\S]*?<\/div>\s*\r?\n\s*<!-- ══[\s\S]*?BOOKING MODAL[\s\S]*?-->\s*/i;

const PORTAL_MODAL_RE =
  /<!-- ══[\s\S]*?CUSTOMER PORTAL MODAL[\s\S]*?<!-- ══[\s\S]*?BOOKING MODAL[\s\S]*?-->\s*/i;

const OPEN_PORTAL_REDIRECT =
  "function openPortal(){window.location.href='my-garage.html#lookup';}";
const GO_PORTAL_REDIRECT =
  "function goCustomerPortal(){ closeLogin(); window.location.href='my-garage.html'; }";
const CLOSE_PORTAL_STUB = "function closePortal(){}";
const HANDLE_CP_STUB = "function handleCpOv(e){ if(e.target&&e.target.id==='cp-ov') closePortal(); }";

function stripFooterComment(html) {
  return html.replace(/<!-- Canonical shared public footer[\s\S]*?-->\s*/i, '').trim();
}

function patchPortalJs(html) {
  let out = html;
  out = out.replace(
    /function openPortal\(\)\{[\s\S]*?\}/,
    OPEN_PORTAL_REDIRECT
  );
  out = out.replace(
    /function goCustomerPortal\(\)\{[\s\S]*?\}/,
    GO_PORTAL_REDIRECT
  );
  out = out.replace(/function closePortal\(\)\{[\s\S]*?\}/, CLOSE_PORTAL_STUB);
  return out;
}

function removeInlineBtt(html) {
  let out = html;
  out = out.replace(/<button[^>]*id="btt"[\s\S]*?<\/button>\s*/gi, '');
  out = out.replace(
    /\n?\/\/ ── BACK TO TOP[\s\S]*?syncBtt\(\);\s*\}\)\(\);\s*/m,
    '\n// Back to top: assets/back-to-top.js\n'
  );
  out = out.replace(
    /\n?\(function\(\)\{\s*const btn=document\.getElementById\('btt'\);[\s\S]*?syncBtt\(\);\s*\}\)\(\);\s*/m,
    '\n'
  );
  return out;
}

async function main() {
  const footerRaw = await readFile(FOOTER_PARTIAL, 'utf8');
  const footer = stripFooterComment(footerRaw);

  for (const file of PUBLIC_HTML) {
    const path = join(ROOT, file);
    let html = await readFile(path, 'utf8');
    const orig = html;

    if (/<footer[\s\S]*?<\/footer>/i.test(html)) {
      html = html.replace(/<footer[\s\S]*?<\/footer>/i, footer);
    } else if (file === 'terms-conditions.html') {
      html = html.replace('</body>', `${footer}\n  ${BTT_JS}\n</body>`);
    }

    html = removeInlineBtt(html);

    if (PORTAL_MODAL_RE.test(html)) {
      html = html.replace(PORTAL_MODAL_RE, '');
    } else if (CP_OV_MODAL_RE.test(html)) {
      html = html.replace(CP_OV_MODAL_RE, '');
    }

    if (PORTAL_JS_RE.test(html)) {
      html = html.replace(PORTAL_JS_RE, PORTAL_JS_STUB);
    }

    html = html.replace(/window\.location\.href='customer\.html\?subscribe=1'/g, "window.location.href='my-garage.html'");
    html = html.replace(/href="customer\.html"/g, 'href="my-garage.html"');

    if (html.includes('function openPortal(') && !html.includes("my-garage.html#lookup")) {
      html = patchPortalJs(html);
    }

    if (/booking-card-status/.test(html) && !html.includes('draftSaveToken:(ST.draftSaveToken')) {
      html = html.replace(
        /body:JSON\.stringify\(\{bookingId:ST\.bookingId\}\)/g,
        CARD_STATUS_BODY
      );
    }

    if (!html.includes('assets/public-surface.css') && html.includes('</head>')) {
      html = html.replace('</head>', `  ${SURFACE_CSS}\n</head>`);
    }

    if (!html.includes('<script src="assets/back-to-top.js"') && html.includes('</body>')) {
      html = html.replace('</body>', `  ${BTT_JS}\n</body>`);
    }

    if (HUB_PAGES.includes(file) && !html.includes('assets/hub-booking-bridge.js') && html.includes('</body>')) {
      html = html.replace('</body>', `  ${HUB_BRIDGE_JS}\n</body>`);
    }

    if (html !== orig) {
      await writeFile(path, html, 'utf8');
      console.log('updated', file);
    } else {
      console.log('skipped', file);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
