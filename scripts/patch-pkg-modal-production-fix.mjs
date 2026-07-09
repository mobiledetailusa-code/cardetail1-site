/**
 * Production blockers: move package modal to body end, remove specialty orphan icons.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MODAL_PAGES = [
  "index.html",
  "new-jersey-hub.html",
  "ny-metro-hub.html",
  "connecticut-hub.html",
  "pennsylvania-hub.html",
];

const ALL_HTML = [
  ...MODAL_PAGES,
  "bergen-county-hub.html",
  "hudson-county-hub.html",
  "essex-county-hub.html",
  "passaic-county-hub.html",
  "newark-mobile-detailing.html",
  "trenton-mobile-detailing.html",
  "westchester-mobile-detailing.html",
  "template-city.html",
];

const MODAL_RE =
  /<!-- Package details in-page panel -->\s*<div class="car-pkg-detail-ov"[\s\S]*?<\/div>\s*\n/;

const MODAL_HTML = `<!-- Package details modal (body end) -->
<div class="car-pkg-detail-ov" id="car-pkg-detail-ov" hidden aria-hidden="true" onclick="if(event.target===this)closeHomePkgDetailModal()">
  <div class="car-pkg-detail-panel" role="dialog" aria-modal="true" aria-labelledby="car-pkg-detail-title">
    <button type="button" class="car-pkg-detail-close" onclick="closeHomePkgDetailModal()" aria-label="Close package details">✕</button>
    <div class="car-pkg-detail-head">
      <h2 class="car-pkg-detail-title" id="car-pkg-detail-title"></h2>
      <div class="car-pkg-detail-price" id="car-pkg-detail-price"></div>
    </div>
    <div class="car-pkg-detail-body" id="car-pkg-detail-body"></div>
    <div class="car-pkg-detail-foot">
      <button type="button" class="btn-primary car-pkg-detail-book" id="car-pkg-detail-book">Book this package</button>
    </div>
  </div>
</div>
`;

const CRITICAL_CSS = ".car-pkg-detail-ov[hidden]{display:none!important}";

for (const file of MODAL_PAGES) {
  const p = path.join(root, file);
  let html = fs.readFileSync(p, "utf8");

  if (!html.includes(CRITICAL_CSS)) {
    if (html.includes("assets/car-pkg-detail-modal.css")) {
      html = html.replace(
        '<link rel="stylesheet" href="assets/car-pkg-detail-modal.css">',
        `<link rel="stylesheet" href="assets/car-pkg-detail-modal.css">\n<style>${CRITICAL_CSS}</style>`,
      );
    } else if (html.includes("</head>")) {
      html = html.replace("</head>", `<style>${CRITICAL_CSS}</style>\n</head>`);
    }
  }

  if (MODAL_RE.test(html)) {
    html = html.replace(MODAL_RE, "");
  }

  if (!html.includes('id="car-pkg-detail-ov"')) {
    html = html.replace("</body>", `${MODAL_HTML}\n</body>`);
  } else if (!html.includes("<!-- Package details modal (body end) -->")) {
    const block = html.match(
      /<div class="car-pkg-detail-ov" id="car-pkg-detail-ov"[\s\S]*?<\/div>\s*\n<\/div>\s*\n/,
    );
    if (block) {
      html = html.replace(block[0], "");
      html = html.replace("</body>", `${MODAL_HTML}\n</body>`);
    }
  }

  fs.writeFileSync(p, html);
  console.log("modal fix", file);
}

for (const file of ALL_HTML) {
  const p = path.join(root, file);
  let html = fs.readFileSync(p, "utf8");
  const next = html.replace(/\s*<div class="specialty-icon">[^<]*<\/div>\s*\n/g, "\n");
  if (next !== html) {
    fs.writeFileSync(p, next);
    console.log("specialty icons removed", file);
  }
}
