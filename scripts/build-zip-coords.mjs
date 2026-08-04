/**
 * Regenerates the ZIP centroid table used by travel pricing.
 *
 * Both netlify/lib/data/service-area-zip-coords.js and assets/travel-fee-client.js
 * are written from the same source in one pass, because a browser table that
 * disagrees with the server table produces a price_mismatch rejection at submit.
 *
 *   node scripts/build-zip-coords.mjs
 *
 * Source is a public US ZIP centroid dataset. Points beyond MAX_STRAIGHT_MI from
 * the base are dropped: they can never be in range, and shipping them would only
 * make the browser bundle larger.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_URL = 'https://raw.githubusercontent.com/midwire/free_zipcode_data/master/all_us_zipcodes.csv';
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

const res = await fetch(SOURCE_URL);
if (!res.ok) throw new Error(`source fetch failed: ${res.status}`);
const csv = await res.text();

const kept = new Map();
for (const line of csv.split('\n').slice(1)) {
  const parts = line.split(',');
  if (parts.length < 7) continue;
  const zip = parts[0].trim();
  if (!/^\d{5}$/.test(zip)) continue;
  const lat = Number(parts[5]);
  const lon = Number(parts[6]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  if (haversineMiles(BASE, { lat, lon }) > MAX_STRAIGHT_MI) continue;
  kept.set(zip, [Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4]);
}

const packed = [...kept.keys()].sort()
  .map((z) => `${z}:${kept.get(z)[0]},${kept.get(z)[1]}`)
  .join(';');

fs.mkdirSync(path.join(ROOT, 'netlify/lib/data'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'netlify/lib/data/service-area-zip-coords.js'),
  `// Generated ZIP centroid table for the service region.\n`
  + `// Source: public US ZIP centroid dataset, filtered to points within ~${MAX_STRAIGHT_MI} straight-line\n`
  + `// miles of the operating base. Regenerate with scripts/build-zip-coords.mjs.\n`
  + `module.exports = {\n`
  + `  base: { zip: "${BASE.zip}", lat: ${BASE.lat}, lon: ${BASE.lon} },\n`
  + `  packed: "${packed}",\n`
  + `};\n`
);

console.log(`wrote ${kept.size} ZIP centroids`);
console.log('Now regenerate assets/travel-fee-client.js so the browser table matches:');
console.log('  the client module embeds the same `packed` string — copy it across,');
console.log('  then run: node --test tests/travel-fee.test.js');
