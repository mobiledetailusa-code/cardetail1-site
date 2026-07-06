import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const files = [
  "index.html",
  "new-jersey-hub.html",
  "ny-metro-hub.html",
  "connecticut-hub.html",
  "pennsylvania-hub.html",
  "bergen-county-hub.html",
  "hudson-county-hub.html",
  "essex-county-hub.html",
  "passaic-county-hub.html",
  "newark-mobile-detailing.html",
  "trenton-mobile-detailing.html",
  "westchester-mobile-detailing.html",
  "template-city.html",
];
const linkBooking = '<link rel="stylesheet" href="assets/booking-modal-light.css">';
const linkPublic = '<link rel="stylesheet" href="assets/public-surface-contrast.css">';

for (const f of files) {
  const p = path.join(root, f);
  let html = fs.readFileSync(p, "utf8");
  if (html.includes("booking-modal-light.css") && html.includes("public-surface-contrast.css")) {
    console.log("skip", f);
    continue;
  }
  if (html.includes('href="assets/hub-styles.css"')) {
    if (!html.includes("booking-modal-light.css")) {
      html = html.replace(
        '<link rel="stylesheet" href="assets/hub-styles.css">',
        `<link rel="stylesheet" href="assets/hub-styles.css">\n${linkBooking}`,
      );
    }
    if (!html.includes("public-surface-contrast.css")) {
      html = html.replace(
        /(<link rel="stylesheet" href="assets\/booking-modal-light\.css">)/,
        `$1\n${linkPublic}`,
      );
      if (!html.includes("public-surface-contrast.css")) {
        html = html.replace(
          '<link rel="stylesheet" href="assets/hub-styles.css">',
          `<link rel="stylesheet" href="assets/hub-styles.css">\n${linkPublic}`,
        );
      }
    }
  } else if (html.includes("</head>")) {
    if (!html.includes("booking-modal-light.css")) {
      html = html.replace("</head>", `${linkBooking}\n</head>`);
    }
    if (!html.includes("public-surface-contrast.css")) {
      html = html.replace("</head>", `${linkPublic}\n</head>`);
    }
  }
  fs.writeFileSync(p, html);
  console.log("linked", f);
}
