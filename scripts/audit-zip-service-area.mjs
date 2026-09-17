/**
 * Audits ZIP coverage for the travel/service-area gate.
 *
 * Compares Census ZCTA interior points within range against the packed coord
 * table, and flags ZIP_CITIES labels that have no coordinates (the 10065 failure mode).
 *
 *   node scripts/audit-zip-service-area.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  estimateMilesForZip,
  resolveTravelForZip,
  zipCoordIndex,
  TRAVEL_MAX_MILES,
  ROAD_FACTOR,
} = require('../netlify/lib/travel-fee');
const COORDS = require('../netlify/lib/data/service-area-zip-coords');

const CENSUS_GAZ_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip';
const MAX_STRAIGHT_MI = 135;
const EARTH_RADIUS_MI = 3958.8;
const rad = (d) => (d * Math.PI) / 180;

function haversineMiles(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

const idx = zipCoordIndex();
const zipPath = path.join(os.tmpdir(), `cd1-gaz-audit-${process.pid}.zip`);
const gazRes = await fetch(CENSUS_GAZ_URL);
if (!gazRes.ok) throw new Error(`census fetch failed: ${gazRes.status}`);
await pipeline(Readable.fromWeb(gazRes.body), createWriteStream(zipPath));
const gazText = execFileSync('unzip', ['-p', zipPath], { maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
fs.unlinkSync(zipPath);

const missingInRange = [];
const missingNear = [];
for (const line of gazText.split('\n').slice(1)) {
  if (!line.trim()) continue;
  const parts = line.split(/\t+/);
  const zip = parts[0].trim();
  if (!/^\d{5}$/.test(zip) || idx.has(zip)) continue;
  const lat = Number(parts[5]);
  const lon = Number(parts[6]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const straight = haversineMiles(COORDS.base, { lat, lon });
  const road = Math.round(straight * ROAD_FACTOR);
  if (straight <= MAX_STRAIGHT_MI) missingNear.push({ zip, road, straight });
  if (road <= TRAVEL_MAX_MILES) missingInRange.push({ zip, road, straight });
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const start = html.indexOf('const ZIP_CITIES');
const brace = html.indexOf('{', start);
let depth = 0;
let end = brace;
for (let i = brace; i < html.length; i++) {
  if (html[i] === '{') depth += 1;
  else if (html[i] === '}') {
    depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
const ghosts = [];
const beyondLabeled = [];
for (const m of html.slice(brace, end + 1).matchAll(/'(\d{5})':'([^']+)'/g)) {
  const miles = estimateMilesForZip(m[1]);
  if (miles == null) ghosts.push({ zip: m[1], label: m[2] });
  else if (!resolveTravelForZip(m[1])) beyondLabeled.push({ zip: m[1], label: m[2], miles });
}

const report = {
  generatedAt: new Date().toISOString(),
  tableSize: idx.size,
  missingCensusInRoadRange: missingInRange,
  missingCensusInStraight135: missingNear,
  zipCitiesMissingCoords: ghosts,
  zipCitiesBeyondMax: beyondLabeled,
  spotCheck: Object.fromEntries(
    ['10065', '10075', '10021', '07601', '06455', '11201'].map((zip) => {
      const r = resolveTravelForZip(zip);
      return [zip, r ? { miles: r.miles, fee: r.fee } : null];
    })
  ),
};

fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'reports/zip-service-area-audit.json'),
  `${JSON.stringify(report, null, 2)}\n`
);

let md = `# ZIP service-area audit\n\nGenerated: ${report.generatedAt}\n\n`;
md += `## Verdict\n\n`;
md += `- Coord table: **${idx.size}** ZIPs\n`;
md += `- Census ZCTAs within ${TRAVEL_MAX_MILES} road mi missing from table: **${missingInRange.length}**\n`;
md += `- Census ZCTAs within ${MAX_STRAIGHT_MI} straight mi missing from table: **${missingNear.length}**\n`;
md += `- ZIP_CITIES with no coordinates (10065-class bug): **${ghosts.length}**\n`;
md += `- ZIP_CITIES beyond max (correctly refused): **${beyondLabeled.length}**\n\n`;
md += `### Spot check\n\n`;
for (const [zip, v] of Object.entries(report.spotCheck)) {
  md += `- **${zip}**: ${v ? `${v.miles} mi, $${v.fee}` : 'OUT OF AREA'}\n`;
}
if (ghosts.length) {
  md += `\n### Ghost labels (must fix)\n\n`;
  for (const g of ghosts) md += `- ${g.zip} — ${g.label}\n`;
}
fs.writeFileSync(path.join(ROOT, 'reports/zip-service-area-audit.md'), md);

console.log(JSON.stringify({
  tableSize: idx.size,
  missingInRoadRange: missingInRange.length,
  missingNear: missingNear.length,
  ghosts: ghosts.length,
  beyondLabeled: beyondLabeled.length,
  spotCheck: report.spotCheck,
}, null, 2));

if (missingInRange.length || ghosts.length) {
  console.error('AUDIT FAILED: gaps remain');
  process.exit(1);
}
console.log('AUDIT OK');
