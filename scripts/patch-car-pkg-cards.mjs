import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const pages = [
  "new-jersey-hub.html",
  "ny-metro-hub.html",
  "connecticut-hub.html",
  "pennsylvania-hub.html",
];

for (const file of pages) {
  let html = fs.readFileSync(path.join(root, file), "utf8");
  for (const id of ["interior", "full", "refresh"]) {
    html = html.replace(
      new RegExp(
        `<div class="car-pkg-top" onclick="toggleHomePkgDetail\\('${id}', event\\)">`,
        "g",
      ),
      "<div class=\"car-pkg-top\">",
    );
    html = html.replace(
      new RegExp(
        `<span class="car-pkg-see-btn">See what's included</span>\\s*<div class="car-pkg-detail" id="home-pkg-detail-${id}" hidden aria-hidden="true"></div>`,
        "g",
      ),
      `<button type="button" class="car-pkg-see-btn" onclick="openHomePkgDetailModal('${id}', event)">See what's included</button>`,
    );
  }
  fs.writeFileSync(path.join(root, file), html);
  console.log("cards", file);
}
