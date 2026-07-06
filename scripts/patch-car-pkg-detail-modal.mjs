import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const pages = [
  "index.html",
  "new-jersey-hub.html",
  "ny-metro-hub.html",
  "connecticut-hub.html",
  "pennsylvania-hub.html",
];

const cssLinks = [
  '<link rel="stylesheet" href="assets/car-pkg-detail-modal.css">',
  '<link rel="stylesheet" href="assets/button-states.css">',
];
const scriptTag = '<script src="assets/car-pkg-detail-modal.js"></script>';

const modalHtml = `<!-- Package details in-page panel -->
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

function patchCards(html) {
  for (const id of ["interior", "full", "refresh"]) {
    html = html.replace(
      new RegExp(
        `<div class="car-pkg-top" onclick="toggleHomePkgDetail\\('${id}', event\\)">`,
        "g",
      ),
      '<div class="car-pkg-top">',
    );
    html = html.replace(
      `<span class="car-pkg-see-btn">See what's included</span>\n          <div class="car-pkg-detail" id="home-pkg-detail-${id}" hidden aria-hidden="true"></div>`,
      `<button type="button" class="car-pkg-see-btn" onclick="openHomePkgDetailModal('${id}', event)">See what's included</button>`,
    );
  }
  return html;
}

function removeInlinePkgDetailJs(html) {
  html = html.replace(
    /const CAR_PKG_DETAILS = \{[\s\S]*?\};\s*\n\s*function buildCarPkgDetailSectionsHtml\(d\)\{[\s\S]*?\}\s*\n/,
    "",
  );
  html = html.replace(/function toggleHomePkgDetail\(pkgId, e\)\{[\s\S]*?\}\s*\n/, "");
  html = html.replace(/function initHomePkgDetails\(\)\{[\s\S]*?\}\s*\n/, "");
  html = html.replace(/initHomePkgDetails\(\);/g, "initCarPkgDetailModal();");
  return html;
}

for (const file of pages) {
  const p = path.join(root, file);
  let html = fs.readFileSync(p, "utf8");

  for (const link of cssLinks) {
    if (!html.includes(link)) {
      if (html.includes('href="assets/public-surface-contrast.css"')) {
        html = html.replace(
          '<link rel="stylesheet" href="assets/public-surface-contrast.css">',
          `<link rel="stylesheet" href="assets/public-surface-contrast.css">\n${link}`,
        );
      } else if (html.includes("</head>")) {
        html = html.replace("</head>", `${link}\n</head>`);
      }
    }
  }

  if (!html.includes('src="assets/car-pkg-detail-modal.js"')) {
    html = html.replace("<script>", `${scriptTag}\n<script>`);
  }

  if (!html.includes('id="car-pkg-detail-ov"')) {
    html = html.replace(
      /(<div class="car-addons-block">)/,
      `${modalHtml}\n$1`,
    );
  }

  html = patchCards(html);

  if (file === "index.html") {
    html = removeInlinePkgDetailJs(html);
  } else {
    html = html.replace(/initHomePkgDetails\(\);/g, "initCarPkgDetailModal();");
  }

  fs.writeFileSync(p, html);
  console.log("patched", file);
}
