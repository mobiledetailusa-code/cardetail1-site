/** Remove orphaned package-modal fragments left by partial modal relocation. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const files = [
  "index.html",
  "new-jersey-hub.html",
  "ny-metro-hub.html",
  "connecticut-hub.html",
  "pennsylvania-hub.html",
];

const ORPHAN = `
        </div>
    <div class="car-pkg-detail-body" id="car-pkg-detail-body"></div>
    <div class="car-pkg-detail-foot">
      <button type="button" class="btn-primary car-pkg-detail-book" id="car-pkg-detail-book">Book this package</button>
    </div>
  </div>
</div>
`;

for (const file of files) {
  const p = path.join(root, file);
  let html = fs.readFileSync(p, "utf8");
  if (!html.includes(ORPHAN)) {
    console.log("no orphan", file);
    continue;
  }
  html = html.replace(ORPHAN, "");
  const bodies = [...html.matchAll(/id="car-pkg-detail-body"/g)];
  if (bodies.length !== 1) {
    throw new Error(`${file} has ${bodies.length} car-pkg-detail-body elements`);
  }
  fs.writeFileSync(p, html);
  console.log("cleaned", file);
}
