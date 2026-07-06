/**
 * Remove add-on icon rendering from booking UI across all public booking pages.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const HTML_FILES = [
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

function patchHtml(html) {
  let out = html;
  out = out.replace(
    /<div class="addon-check">✓<\/div><div class="addon-ico">\$\{a\.icon\}<\/div><div class="addon-name">/g,
    '<div class="addon-check">✓</div><div class="addon-name">',
  );
  out = out.replace(/\.addon-ico\{font-size:30px;margin-bottom:8px\}\r?\n?/g, "");
  out = out.replace(/\$\{cpEsc\(a\.icon\|\|''\)\} \$\{cpEsc\(a\.name\)\}/g, "${cpEsc(a.name)}");
  out = out.replace(
    /onclick="openBookingCarPkg\('full'\)">\$\{a\.icon\} \$\{a\.name\}/g,
    "onclick=\"openBookingCarPkg('full')\">${a.name}",
  );
  out = out.replace(
    /\.addon-name\{font-size:12\.5px;font-weight:600;color:var\(--white\);margin-bottom:3px\}/g,
    ".addon-name{font-size:13px;font-weight:600;color:var(--white);margin-bottom:4px;line-height:1.35;padding-top:2px}",
  );
  return out;
}

for (const file of HTML_FILES) {
  const p = path.join(root, file);
  const html = fs.readFileSync(p, "utf8");
  const next = patchHtml(html);
  if (next.includes("addon-ico") || next.includes("${a.icon}")) {
    throw new Error(`${file} still contains add-on icon UI after patch`);
  }
  fs.writeFileSync(p, next);
  console.log("patched ui", file);
}
