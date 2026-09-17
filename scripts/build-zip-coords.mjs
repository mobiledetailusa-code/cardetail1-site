/**
 * Regenerates the ZIP centroid table used by travel pricing.
 *
 * Both netlify/lib/data/service-area-zip-coords.js and assets/travel-fee-client.js
 * are written from the same source in one pass, because a browser table that
 * disagrees with the server table produces a price_mismatch rejection at submit.
 *
 *   node scripts/build-zip-coords.mjs
 *
 * Primary source is a public US ZIP centroid CSV. Census ZCTA gazetteer points
 * fill gaps the CSV omits (notably Manhattan 10065 / 10075). Points beyond
 * MAX_STRAIGHT_MI from the base are dropped: they can never be in range, and
 * shipping them would only make the browser bundle larger.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_URL = 'https://raw.githubusercontent.com/midwire/free_zipcode_data/master/all_us_zipcodes.csv';
const CENSUS_GAZ_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip';
const BASE = { zip: '07601', lat: 40.913482, lon: -74.001623 };

/** 120 road miles ÷ 1.25 road factor ≈ 96 straight-line; 135 leaves headroom. */
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

function roundCoord(n) {
  return Math.round(n * 1e4) / 1e4;
}

function keepIfInRange(kept, zip, lat, lon) {
  if (!/^\d{5}$/.test(zip)) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (haversineMiles(BASE, { lat, lon }) > MAX_STRAIGHT_MI) return;
  if (kept.has(zip)) return;
  kept.set(zip, [roundCoord(lat), roundCoord(lon)]);
}

const res = await fetch(SOURCE_URL);
if (!res.ok) throw new Error(`source fetch failed: ${res.status}`);
const csv = await res.text();

const kept = new Map();
for (const line of csv.split('\n').slice(1)) {
  const parts = line.split(',');
  if (parts.length < 7) continue;
  keepIfInRange(kept, parts[0].trim(), Number(parts[5]), Number(parts[6]));
}

const primaryCount = kept.size;

// Census ZCTA interior points close gaps the free CSV never published
// (e.g. Manhattan 10065 / 10075 — in range but treated as out of area).
const gazRes = await fetch(CENSUS_GAZ_URL);
if (!gazRes.ok) throw new Error(`census gazetteer fetch failed: ${gazRes.status}`);
const zipPath = path.join(os.tmpdir(), `cd1-gaz-zcta-${process.pid}.zip`);
await pipeline(Readable.fromWeb(gazRes.body), createWriteStream(zipPath));
const gazText = execFileSync('unzip', ['-p', zipPath], { maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
fs.unlinkSync(zipPath);

let filled = 0;
for (const line of gazText.split('\n').slice(1)) {
  if (!line.trim()) continue;
  const parts = line.split(/\t+/);
  const zip = parts[0].trim();
  const lat = Number(parts[5]);
  const lon = Number(parts[6]);
  const before = kept.size;
  keepIfInRange(kept, zip, lat, lon);
  if (kept.size > before) filled += 1;
}

const packed = [...kept.keys()].sort()
  .map((z) => `${z}:${kept.get(z)[0]},${kept.get(z)[1]}`)
  .join(';');

fs.mkdirSync(path.join(ROOT, 'netlify/lib/data'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'netlify/lib/data/service-area-zip-coords.js'),
  `// Generated ZIP centroid table for the service region.\n`
  + `// Source: public US ZIP centroid dataset + Census ZCTA gazetteer gap-fill,\n`
  + `// filtered to points within ~${MAX_STRAIGHT_MI} straight-line miles of the operating base.\n`
  + `// Regenerate with scripts/build-zip-coords.mjs.\n`
  + `module.exports = {\n`
  + `  base: { zip: "${BASE.zip}", lat: ${BASE.lat}, lon: ${BASE.lon} },\n`
  + `  packed: "${packed}",\n`
  + `};\n`
);

const clientPath = path.join(ROOT, 'assets/travel-fee-client.js');
const clientSrc = fs.readFileSync(clientPath, 'utf8');
const nextClient = clientSrc.replace(
  /var PACKED = "[^"]*";/,
  `var PACKED = "${packed}";`
);
if (nextClient === clientSrc) {
  throw new Error('assets/travel-fee-client.js PACKED string was not updated — pattern mismatch');
}
fs.writeFileSync(clientPath, nextClient);

console.log(`wrote ${kept.size} ZIP centroids (${primaryCount} primary + ${filled} census gap-fill)`);
console.log('updated netlify/lib/data/service-area-zip-coords.js and assets/travel-fee-client.js');
console.log('run: node --test tests/travel-fee.test.js');
