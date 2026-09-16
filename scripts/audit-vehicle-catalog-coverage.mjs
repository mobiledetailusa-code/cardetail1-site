#!/usr/bin/env node
/**
 * READ-ONLY Cardetail1 Cars catalog coverage audit vs NHTSA vPIC.
 * Does not modify production catalog data.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const OUT_DIR = path.join(root, 'artifacts');
const CACHE_DIR = path.join(root, '/tmp/vpic-audit'.replace(/^\/tmp/, path.join(root, '.cache')));
const CACHE = path.join(root, '.cache', 'vpic-audit');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(root, 'docs', 'audit'), { recursive: true });

const YEAR_MIN = 1990;
const YEAR_MAX = new Date().getFullYear(); // Cars picker in index.html
const VEHICLE_TYPES = ['passenger', 'mpv', 'truck'];

// Extra US-market light-vehicle makes not necessarily in Cardetail1
const EXTRA_MAKES = [
  'Rivian', 'Lucid', 'Polestar', 'VinFast', 'Karma', 'Fisker',
  'Suzuki', 'Isuzu', 'Hummer', 'Smart', 'Scion', 'Saturn', 'Pontiac',
  'Oldsmobile', 'Mercury', 'Plymouth', 'Saab', 'Maybach', 'Bugatti',
  'Lotus', 'Genesis', // already in CD1 but keep
];

const MAKE_ALIASES = {
  'mercedes benz': 'Mercedes-Benz',
  'mercedes-benz': 'Mercedes-Benz',
  mercedes: 'Mercedes-Benz',
  'landrover': 'Land Rover',
  'land rover': 'Land Rover',
  'alfa-romeo': 'Alfa Romeo',
  'rolls royce': 'Rolls-Royce',
  'rolls-royce': 'Rolls-Royce',
  infiniti: 'INFINITI',
  fiat: 'FIAT',
  mini: 'MINI',
  bmw: 'BMW',
  gmc: 'GMC',
  vw: 'Volkswagen',
  'aston martin': 'Aston Martin',
};

// Normalize NHTSA model strings → Cardetail1-style canonical families
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapMake(name) {
  const n = normKey(name);
  if (MAKE_ALIASES[n]) return MAKE_ALIASES[n];
  // Title-case fallback
  return String(name || '')
    .split(/[\s-]+/)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(String(name).includes('-') && !/\s/.test(name) ? '-' : ' ');
}

/** Load Cardetail1 MODELS from index.html (canonical cars catalog). */
function loadCardetail1() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = html.indexOf('const MODELS = ');
  const from = html.slice(start + 'const MODELS = '.length);
  const end = from.indexOf(';\n');
  // eslint-disable-next-line no-eval
  const models = eval('(' + from.slice(0, end) + ')');
  const makesMatch = html.match(/const MAKES = (\[[^\]]+\])/);
  // eslint-disable-next-line no-eval
  const makes = eval(makesMatch[1]);
  const flat = [];
  for (const make of makes) {
    const entry = models[make];
    if (!entry) continue;
    for (const model of entry.m) {
      flat.push({ make, model, class: entry.t[model] || null, label: `${make} ${model}` });
    }
  }
  return { makes, models, flat, yearMin: YEAR_MIN, yearMax: YEAR_MAX };
}

const { PRICING } = require(path.join(root, 'netlify/lib/booking-price-catalog.js'));
const vehicleClass = require(path.join(root, 'assets/vehicle-class-resolver.js'));

async function fetchJson(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
}

function cachePath(make, year, vtype) {
  const safe = String(make).replace(/[^a-zA-Z0-9_-]+/g, '_');
  return path.join(CACHE, `${safe}_${year}_${vtype}.json`);
}

async function getModelsForMakeYear(make, year, vtype) {
  const cp = cachePath(make, year, vtype);
  if (fs.existsSync(cp)) {
    return JSON.parse(fs.readFileSync(cp, 'utf8'));
  }
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}/vehicletype/${vtype}?format=json`;
  const data = await fetchJson(url);
  const names = [...new Set((data.Results || []).map((r) => r.Model_Name).filter(Boolean))];
  fs.writeFileSync(cp, JSON.stringify({ make, year, vtype, names, count: names.length }));
  return { make, year, vtype, names, count: names.length };
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Build alias / family matching between CD1 models and NHTSA names.
 * Returns true if external model should be considered covered by a CD1 model.
 */
function buildMatchers(cd1) {
  // Explicit family merges (NHTSA variant → CD1 canonical)
  const FAMILY = [
    // Ford trucks / vans
    { make: 'Ford', cd1: 'F-150', match: /^(f[- ]?150|f150)$/i },
    { make: 'Ford', cd1: 'F-250 Super Duty', match: /^(f[- ]?250|f250)( super duty)?$/i },
    { make: 'Ford', cd1: 'F-350 Super Duty', match: /^(f[- ]?350|f350)( super duty)?$/i },
    { make: 'Ford', cd1: 'Transit', match: /^transit( (150|250|350|350hd|cargo|passenger|connect))?$/i, exclude: /connect/i },
    { make: 'Ford', cd1: 'Transit Connect', match: /^transit connect/i },
    { make: 'Ford', cd1: 'E-Series', match: /^(e[- ]?(150|250|350|450)|econoline)/i }, // may be missing in CD1
    // Mercedes
    { make: 'Mercedes-Benz', cd1: 'Sprinter', match: /sprinter/i },
    { make: 'Mercedes-Benz', cd1: 'Metris', match: /metris/i },
    { make: 'Mercedes-Benz', cd1: 'C-Class', match: /^c[- ]?(class|\\d{3})/i },
    { make: 'Mercedes-Benz', cd1: 'E-Class', match: /^e[- ]?(class|\\d{3})/i },
    { make: 'Mercedes-Benz', cd1: 'S-Class', match: /^s[- ]?(class|\\d{3})/i },
    { make: 'Mercedes-Benz', cd1: 'GLA', match: /^gla/i },
    { make: 'Mercedes-Benz', cd1: 'GLB', match: /^glb/i },
    { make: 'Mercedes-Benz', cd1: 'GLC', match: /^glc/i },
    { make: 'Mercedes-Benz', cd1: 'GLE', match: /^gle|^m[- ]?class/i },
    { make: 'Mercedes-Benz', cd1: 'GLS', match: /^gls|^gl[- ]?class/i },
    { make: 'Mercedes-Benz', cd1: 'G-Class', match: /^g[- ]?(class|\\d{3})|^g[- ]?wagen/i },
    { make: 'Mercedes-Benz', cd1: 'CLA', match: /^cla/i },
    { make: 'Mercedes-Benz', cd1: 'CLS', match: /^cls/i },
    { make: 'Mercedes-Benz', cd1: 'A-Class', match: /^a[- ]?(class|\\d{3})/i },
    { make: 'Mercedes-Benz', cd1: 'AMG GT', match: /amg gt|gt[- ]?class/i },
    // BMW series
    { make: 'BMW', cd1: '2 Series', match: /^(2 series|2[0-9]{2}i?|m2)/i },
    { make: 'BMW', cd1: '3 Series', match: /^(3 series|3[0-9]{2}i?|m3)/i },
    { make: 'BMW', cd1: '4 Series', match: /^(4 series|4[0-9]{2}i?|m4)/i },
    { make: 'BMW', cd1: '5 Series', match: /^(5 series|5[0-9]{2}i?|m5)/i },
    { make: 'BMW', cd1: '7 Series', match: /^(7 series|7[0-9]{2}i?)/i },
    { make: 'BMW', cd1: '8 Series', match: /^(8 series|8[0-9]{2}i?|m8)/i },
    { make: 'BMW', cd1: 'X5', match: /^x5/i },
    { make: 'BMW', cd1: 'X3', match: /^x3/i },
    { make: 'BMW', cd1: 'X1', match: /^x1/i },
    { make: 'BMW', cd1: 'X7', match: /^x7/i },
    { make: 'BMW', cd1: 'iX', match: /^ix$/i },
    // Chevy / GMC vans
    { make: 'Chevrolet', cd1: 'Express', match: /^express/i },
    { make: 'Chevrolet', cd1: 'Silverado 1500', match: /^silverado( 1500)?$/i },
    { make: 'Chevrolet', cd1: 'Silverado 2500HD', match: /silverado 2500/i },
    { make: 'Chevrolet', cd1: 'Silverado 3500HD', match: /silverado 3500/i },
    { make: 'GMC', cd1: 'Savana', match: /^savana/i },
    { make: 'GMC', cd1: 'Sierra 1500', match: /^sierra( 1500)?$/i },
    { make: 'GMC', cd1: 'Sierra 2500HD', match: /sierra 2500/i },
    { make: 'GMC', cd1: 'Sierra 3500HD', match: /sierra 3500/i },
    // Ram
    { make: 'Ram', cd1: '1500', match: /^(1500|ram 1500)$/i },
    { make: 'Ram', cd1: '2500', match: /^(2500|ram 2500)$/i },
    { make: 'Ram', cd1: '3500', match: /^(3500|ram 3500)$/i },
    { make: 'Ram', cd1: 'ProMaster', match: /^promaster(?! city)/i },
    { make: 'Ram', cd1: 'ProMaster City', match: /^promaster city/i },
    // Nissan vans
    { make: 'Nissan', cd1: 'NV', match: /^nv(1500|2500|3500)?$/i },
    { make: 'Nissan', cd1: 'NV200', match: /^nv200/i },
    // Jeep
    { make: 'Jeep', cd1: 'Grand Cherokee', match: /^grand cherokee( l| wk| wk2)?$/i },
    { make: 'Jeep', cd1: 'Wrangler', match: /^wrangler( unlimited| 4xe)?$/i },
    // Toyota
    { make: 'Toyota', cd1: 'Corolla', match: /^corolla( hatchback| cross| im)?$/i },
    { make: 'Toyota', cd1: 'Prius', match: /^prius( c| v| prime)?$/i },
    { make: 'Toyota', cd1: 'Camry', match: /^camry( hybrid| solara)?$/i },
    { make: 'Toyota', cd1: 'RAV4', match: /^rav4( prime| hybrid| ev)?$/i },
    { make: 'Toyota', cd1: 'Highlander', match: /^highlander( hybrid)?$/i },
    { make: 'Toyota', cd1: '4Runner', match: /^4runner/i },
    { make: 'Toyota', cd1: 'Tacoma', match: /^tacoma/i },
    { make: 'Toyota', cd1: 'Tundra', match: /^tundra/i },
    // Honda
    { make: 'Honda', cd1: 'Civic', match: /^civic( si| type r| hatchback)?$/i },
    { make: 'Honda', cd1: 'Accord', match: /^accord( hybrid)?$/i },
    { make: 'Honda', cd1: 'CR-V', match: /^cr[- ]?v( hybrid)?$/i },
    { make: 'Honda', cd1: 'Pilot', match: /^pilot/i },
    { make: 'Honda', cd1: 'Odyssey', match: /^odyssey/i },
    // Tesla
    { make: 'Tesla', cd1: 'Model 3', match: /^model 3/i },
    { make: 'Tesla', cd1: 'Model Y', match: /^model y/i },
    { make: 'Tesla', cd1: 'Model S', match: /^model s/i },
    { make: 'Tesla', cd1: 'Model X', match: /^model x/i },
    { make: 'Tesla', cd1: 'Cybertruck', match: /^cybertruck/i },
    // Audi
    { make: 'Audi', cd1: 'e-tron', match: /^(e[- ]?tron|q8 e[- ]?tron|e[- ]?tron gt)$/i },
    { make: 'Audi', cd1: 'Q5', match: /^q5/i },
    { make: 'Audi', cd1: 'A4', match: /^a4/i },
    { make: 'Audi', cd1: 'A6', match: /^a6/i },
    // VW
    { make: 'Volkswagen', cd1: 'Golf', match: /^golf( gti| r| alltrack| sportwagen)?$/i },
    { make: 'Volkswagen', cd1: 'ID.4', match: /^id[.\s]?4/i },
    { make: 'Volkswagen', cd1: 'ID.Buzz', match: /^id[.\s]?buzz/i },
    { make: 'Volkswagen', cd1: 'Tiguan', match: /^tiguan/i },
    { make: 'Volkswagen', cd1: 'Atlas', match: /^atlas(?! cross)/i },
    { make: 'Volkswagen', cd1: 'Atlas Cross Sport', match: /^atlas cross/i },
    // Hyundai / Kia EVs often have variants
    { make: 'Hyundai', cd1: 'Ioniq 5', match: /^ioniq ?5/i },
    { make: 'Hyundai', cd1: 'Ioniq 6', match: /^ioniq ?6/i },
    { make: 'Hyundai', cd1: 'Tucson', match: /^tucson/i },
    { make: 'Hyundai', cd1: 'Santa Fe', match: /^santa fe/i },
    { make: 'Hyundai', cd1: 'Palisade', match: /^palisade/i },
    { make: 'Kia', cd1: 'EV6', match: /^ev6/i },
    { make: 'Kia', cd1: 'EV9', match: /^ev9/i },
    { make: 'Kia', cd1: 'Telluride', match: /^telluride/i },
    { make: 'Kia', cd1: 'Sportage', match: /^sportage/i },
    { make: 'Kia', cd1: 'Carnival', match: /^carnival/i },
    { make: 'Kia', cd1: 'Sorento', match: /^sorento/i },
    // Chrysler / Dodge minivans
    { make: 'Dodge', cd1: 'Grand Caravan', match: /grand caravan|caravan/i },
    { make: 'Chrysler', cd1: 'Pacifica', match: /^pacifica/i },
    { make: 'Chrysler', cd1: 'Town & Country', match: /town.?country/i },
    { make: 'Chrysler', cd1: '300', match: /^300c?$/i },
    // Lexus
    { make: 'Lexus', cd1: 'RX', match: /^rx/i },
    { make: 'Lexus', cd1: 'NX', match: /^nx/i },
    { make: 'Lexus', cd1: 'GX', match: /^gx/i },
    { make: 'Lexus', cd1: 'LX', match: /^lx/i },
    { make: 'Lexus', cd1: 'ES', match: /^es/i },
    { make: 'Lexus', cd1: 'IS', match: /^is/i },
    { make: 'Lexus', cd1: 'LS', match: /^ls/i },
    { make: 'Lexus', cd1: 'UX', match: /^ux/i },
    // Land Rover
    { make: 'Land Rover', cd1: 'Range Rover', match: /^range rover(?! sport| evoque| velar)/i },
    { make: 'Land Rover', cd1: 'Range Rover Sport', match: /^range rover sport/i },
    { make: 'Land Rover', cd1: 'Range Rover Evoque', match: /^range rover evoque|^evoque/i },
    { make: 'Land Rover', cd1: 'Range Rover Velar', match: /^range rover velar|^velar/i },
    { make: 'Land Rover', cd1: 'Discovery', match: /^discovery(?! sport)/i },
    { make: 'Land Rover', cd1: 'Discovery Sport', match: /^discovery sport/i },
    { make: 'Land Rover', cd1: 'Defender', match: /^defender/i },
    // Porsche
    { make: 'Porsche', cd1: '911', match: /^911/i },
    { make: 'Porsche', cd1: 'Cayenne', match: /^cayenne/i },
    { make: 'Porsche', cd1: 'Macan', match: /^macan/i },
    { make: 'Porsche', cd1: 'Panamera', match: /^panamera/i },
    { make: 'Porsche', cd1: 'Taycan', match: /^taycan/i },
    // Mazda
    { make: 'Mazda', cd1: 'CX-5', match: /^cx[- ]?5/i },
    { make: 'Mazda', cd1: 'CX-50', match: /^cx[- ]?50/i },
    { make: 'Mazda', cd1: 'CX-9', match: /^cx[- ]?9$/i },
    { make: 'Mazda', cd1: 'CX-90', match: /^cx[- ]?90/i },
    { make: 'Mazda', cd1: 'CX-30', match: /^cx[- ]?30/i },
    { make: 'Mazda', cd1: 'Mazda3', match: /^(mazda3|3)$/i },
    { make: 'Mazda', cd1: 'Mazda6', match: /^(mazda6|6)$/i },
    // Subaru
    { make: 'Subaru', cd1: 'Outback', match: /^outback/i },
    { make: 'Subaru', cd1: 'Forester', match: /^forester/i },
    { make: 'Subaru', cd1: 'Crosstrek', match: /^(crosstrek|xv crosstrek)/i },
    { make: 'Subaru', cd1: 'Ascent', match: /^ascent/i },
    { make: 'Subaru', cd1: 'Impreza', match: /^impreza/i },
    // Cadillac
    { make: 'Cadillac', cd1: 'Escalade', match: /^escalade(?! esv)/i },
    { make: 'Cadillac', cd1: 'Escalade ESV', match: /^escalade esv/i },
    // Lincoln
    { make: 'Lincoln', cd1: 'Navigator', match: /^navigator/i },
    { make: 'Lincoln', cd1: 'Aviator', match: /^aviator/i },
    { make: 'Lincoln', cd1: 'Nautilus', match: /^nautilus/i },
    { make: 'Lincoln', cd1: 'Corsair', match: /^corsair/i },
    // Volvo
    { make: 'Volvo', cd1: 'XC90', match: /^xc90/i },
    { make: 'Volvo', cd1: 'XC60', match: /^xc60/i },
    { make: 'Volvo', cd1: 'XC40', match: /^xc40/i },
    { make: 'Volvo', cd1: 'EX90', match: /^ex90/i },
    { make: 'Volvo', cd1: 'EX30', match: /^ex30/i },
  ];

  const byMake = new Map();
  for (const row of cd1.flat) {
    if (!byMake.has(row.make)) byMake.set(row.make, []);
    byMake.get(row.make).push(row);
  }

  function findCd1Match(make, externalModel) {
    const fam = FAMILY.filter((f) => f.make === make);
    for (const f of fam) {
      if (f.exclude && f.exclude.test(externalModel)) continue;
      if (f.match.test(externalModel)) {
        const hit = cd1.flat.find((r) => r.make === make && r.model === f.cd1);
        if (hit) return { ...hit, via: 'family', externalModel };
        return { make, model: f.cd1, class: null, missingCanonical: true, via: 'family', externalModel };
      }
    }
    const list = byMake.get(make) || [];
    const nk = normKey(externalModel);
    // exact
    let hit = list.find((r) => normKey(r.model) === nk);
    if (hit) return { ...hit, via: 'exact', externalModel };
    // contains / stripped punctuation
    hit = list.find((r) => {
      const a = normKey(r.model);
      return a === nk || nk.startsWith(a + ' ') || a.startsWith(nk + ' ');
    });
    if (hit) return { ...hit, via: 'fuzzy', externalModel };
    return null;
  }

  return { findCd1Match, FAMILY };
}

/** Heuristic: is this a legitimate passenger/light-duty road vehicle for detailing? */
function isInScopeLightVehicle(make, model) {
  const m = normKey(model);
  const noise = [
    /trailer/, /chassis/, /motorhome/, /cutaway/, /incomplete/, /glider/,
    /bus\b/, /school/, /ambulance/, /hearse/, /limousine coach/,
    /commercial chassis/, /stripped/, /cab chassis/, /medium duty/,
    /f[- ]?[4567]50/, /f[- ]?650/, /f[- ]?750/, /e[- ]?450/,
    /affordable/, /bradford/, /cranford/, /stafford/, /swinford/,
    /classic sedan/, /malibu sedan/, /cordova sedan/, /'34/, /gt mkii/,
    /medford/, /milford/, /travel park/, /pipe/, /tank/,
    /\batv\b/, /\butv\b/, /motorcycle/, /scooter/, /snowmobile/,
  ];
  if (noise.some((re) => re.test(m))) return false;
  // Heavy trucks often appear under truck type — keep light pickups only
  if (/^f[- ]?[4567]\d{2}/.test(m)) return false;
  if (/^c4500|^c5500|^c6500|^t[67]500|^topkick|^kodiak/.test(m)) return false;
  return true;
}

/** Recommend Cardetail1 class for a missing model (heuristic). */
function recommendClass(make, model) {
  const m = normKey(model);
  const makeN = normKey(make);

  // Full-size vans
  if (
    /^(transit)(?! connect)/.test(m) ||
    /sprinter/.test(m) ||
    /^promaster(?! city)/.test(m) ||
    /^express/.test(m) ||
    /^savana/.test(m) ||
    /^nv(1500|2500|3500)?$/.test(m) ||
    /^e[- ]?(150|250|350)/.test(m) ||
    /econoline/.test(m) ||
    /metris/.test(m)
  ) {
    if (/connect|city|nv200|metris/.test(m)) return 'compact_van_or_suv2';
    return 'full_size_van';
  }
  if (/connect|promaster city|nv200/.test(m)) return 'suv2'; // compact van → nearest existing

  // Pickups
  if (
    /f[- ]?1[45]0|f[- ]?250|f[- ]?350|silverado|sierra|ram 1500|ram 2500|ram 3500|^1500$|^2500$|^3500$|tacoma|tundra|ranger|colorado|canyon|frontier|titan|ridgeline|maverick|cybertruck|santa cruz/.test(m)
  ) {
    return 'truck';
  }

  // Minivans
  if (/odyssey|sienna|pacifica|voyager|carnival|grand caravan|town.?country|quest|sedona|routan/.test(m)) {
    return 'minivan';
  }

  // Known 3-row
  if (
    /suburban|tahoe|yukon|expedition|sequoia|armada|pathfinder|pilot|highlander|palisade|telluride|ascent|atlas(?! cross)|traverse|enclave|xc90|qx60|qx80|mdx|gx|lx|gls|x7|q7|q8|cayenne|escalade|navigator|wagoneer|grand wagoneer|commander|durango|explorer|passport|santa fe|sorento|cx-?9|cx-?90|outlander|murano|4runner|land cruiser|defender|discovery(?! sport)|range rover(?! evoque| velar)|model x|ioniq 9|ev9|id buzz/.test(m)
  ) {
    return 'suv3';
  }

  // Crossovers / 2-row SUV-ish
  if (
    /\b(suv|crossover)\b/.test(m) ||
    /rav4|cr-?v|hr-?v|cx-?[345]|equinox|escape|tucson|sportage|forester|outback|crosstrek|rogue|murano|edge|bronco|blazer|trailblazer|encore|envision|xt[456]|lyriq|model y|mach-?e|id\.?4|ioniq|ev6|solterra|bz4x|niro|kona|venue|soul|seltos|kicks|versa|compass|renegade|cherokee|wrangler|gladiator|macan|glc|gle|x[123456]|q[345]|rdx|nx|rx|ux|nx|gx|xc[46]0|c40|ex30|ex40|revera|r1s|r2|air|gravity|tonale|stelvio|dbx|bentayga|cullinan|urus|levante|ghibli/.test(m)
  ) {
    // Gladiator is truck
    if (/gladiator|santa cruz|ridgeline|maverick|cybertruck/.test(m)) return 'truck';
    // some 3-row already caught
    return 'suv2';
  }

  return 'small';
}

function priorityForGap({ make, model, issue_type, recommended_class, cd1Status }) {
  const m = normKey(model);
  const makeN = normKey(make);

  // P0: selectable but wrong pricing/class
  if (issue_type === 'WRONG_CLASS' || issue_type === 'PRICING_TIER_SUSPECT' || issue_type === 'WRONG_ROWS') {
    // Full-size vans priced as truck, minivans wrong, etc.
    if (recommended_class === 'full_size_van' || recommended_class === 'minivan') return 'P0';
    if (issue_type === 'WRONG_CLASS') return 'P0';
  }

  // High-volume US brands
  const commonMake = /toyota|honda|ford|chevrolet|chevy|gmc|ram|jeep|hyundai|kia|nissan|mazda|subaru|volkswagen|bmw|mercedes|audi|lexus|tesla|chrysler|dodge|buick|cadillac|lincoln|acura|volvo|porsche|rivian|lucid|polestar|genesis/.test(makeN);

  const commonModel =
    /camry|civic|accord|corolla|rav4|cr-?v|f[- ]?150|silverado|escape|explorer|equinox|rogue|tucson|sportage|outback|forester|model [3ysx]|cybertruck|transit|sprinter|promaster|express|savana|pacifica|odyssey|sienna|carnival|grand caravan|wrangler|grand cherokee|tahoe|suburban|highlander|pilot|telluride|palisade|r1[st]|air|gravity|ioniq|ev[69]|mach-?e|lyriq|id\.?4|bronco|tundra|tacoma|ranger|maverick|cx-?[59]|outlander|pathfinder|4runner|sequoia|land cruiser|defende|discovery|gladiator|santa fe|sorento|ascent|atlas|nv200|metris|nv |impala|flex|town.?country|soul|k5|forte|elantra|sonata|optima|malibu|impala|cruze|spark|trax|blazer|traverse|encore|enclave|ct[45]|xt[456]|navigator|aviator|corsair|nautilus|es |rx |nx |gx |is |ux |x[135]|3 series|5 series|c-class|e-class|gla|glb|glc|gle|a[3456]|q[345]|911|cayenne|macan|taycan|model y|leaf|ariya|sentra|altima|maxima|versa|kicks|frontier|titan/.test(
      m
    );

  if (issue_type === 'MISSING_MODEL' && commonMake && commonModel) return 'P1';
  if (issue_type === 'MISSING_MODEL' && /rivian|lucid|polestar|vinfast/.test(makeN)) return 'P1';
  if (issue_type === 'MISSING_YEAR' && commonMake) return 'P1';
  if (issue_type === 'INVALID_YEAR') return 'P1';
  if (issue_type === 'ALIAS' || issue_type === 'DUPLICATE') return 'P2';
  if (issue_type === 'MISSING_MODEL' && commonMake) return 'P2';
  if (/ferrari|lamborghini|mclaren|rolls|bentley|aston|bugatti|lotus|karma|fisker/.test(makeN)) return 'P3';
  if (issue_type === 'MISSING_MODEL') return 'P3';
  return 'P2';
}

async function main() {
  console.log('Loading Cardetail1 catalog…');
  const cd1 = loadCardetail1();
  const { findCd1Match } = buildMatchers(cd1);

  const makesToFetch = [...new Set([...cd1.makes, ...EXTRA_MAKES])];
  // Year sampling for discovery + full years for denser coverage on recent decade
  const sampleYears = [];
  for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
    // Full density 2010+; every 2 years 2000-2009; every 5 years before
    if (y >= 2010) sampleYears.push(y);
    else if (y >= 2000 && y % 2 === 0) sampleYears.push(y);
    else if (y < 2000 && y % 5 === 0) sampleYears.push(y);
  }
  // Always include endpoints
  for (const y of [YEAR_MIN, 1995, 2000, 2005, YEAR_MAX]) {
    if (!sampleYears.includes(y)) sampleYears.push(y);
  }
  sampleYears.sort((a, b) => a - b);

  const jobs = [];
  for (const make of makesToFetch) {
    for (const year of sampleYears) {
      for (const vtype of VEHICLE_TYPES) {
        jobs.push({ make, year, vtype });
      }
    }
  }
  console.log(`Fetching NHTSA vPIC: ${jobs.length} requests (cache: ${CACHE})…`);

  let done = 0;
  await mapPool(jobs, 8, async (job) => {
    try {
      await getModelsForMakeYear(job.make, job.year, job.vtype);
    } catch (err) {
      console.warn('FAIL', job.make, job.year, job.vtype, err.message);
    }
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${jobs.length}`);
  });
  console.log('Fetch complete.');

  // Aggregate external inventory
  /** @type {Map<string, {make:string, model:string, years:Set<number>, types:Set<string>}>} */
  const external = new Map();
  for (const make of makesToFetch) {
    for (const year of sampleYears) {
      for (const vtype of VEHICLE_TYPES) {
        const cp = cachePath(make, year, vtype);
        if (!fs.existsSync(cp)) continue;
        const data = JSON.parse(fs.readFileSync(cp, 'utf8'));
        for (const model of data.names || []) {
          if (!isInScopeLightVehicle(make, model)) continue;
          const key = `${make}||${model}`;
          if (!external.has(key)) {
            external.set(key, { make, model, years: new Set(), types: new Set() });
          }
          external.get(key).years.add(year);
          external.get(key).types.add(vtype);
        }
      }
    }
  }

  // Normalize external models into families for gap reporting
  /** @type {Map<string, {make:string, model:string, years:number[], externalNames:string[], cd1:any}>} */
  const families = new Map();
  for (const row of external.values()) {
    const match = findCd1Match(row.make, row.model);
    const canonModel = match && !match.missingCanonical ? match.model : row.model;
    // If family points to missing canonical (e.g. Sprinter), use that name
    const reportModel = match?.missingCanonical ? match.model : match ? match.model : row.model;
    const key = `${row.make}||${reportModel}`;
    if (!families.has(key)) {
      families.set(key, {
        make: row.make,
        model: reportModel,
        years: new Set(),
        externalNames: new Set(),
        cd1: match && !match.missingCanonical ? match : null,
        missingCanonicalHint: match?.missingCanonical || false,
      });
    }
    const f = families.get(key);
    for (const y of row.years) f.years.add(y);
    f.externalNames.add(row.model);
    if (match && !match.missingCanonical) f.cd1 = match;
  }

  const gaps = [];
  const presentValid = [];
  const missingModels = [];
  const partialYear = [];
  const invalidYear = [];
  const suspect = [];
  const aliasIssues = [];

  // Known classification suspects in CD1 (hand + heuristic)
  const CLASS_SUSPECTS = [
    { make: 'Ford', model: 'Transit', current: 'truck', recommended: 'full_size_van', issue: 'WRONG_CLASS', notes: 'Full-size van priced/classified as Truck' },
    { make: 'Ford', model: 'Transit Connect', current: 'truck', recommended: 'suv2', issue: 'WRONG_CLASS', notes: 'Compact van; should not be Truck or full_size_van' },
    { make: 'Chevrolet', model: 'Express', current: 'truck', recommended: 'full_size_van', issue: 'WRONG_CLASS', notes: 'Full-size cargo/passenger van as Truck' },
    { make: 'Ram', model: 'ProMaster', current: 'truck', recommended: 'full_size_van', issue: 'WRONG_CLASS', notes: 'Full-size van as Truck' },
    { make: 'Ram', model: 'ProMaster City', current: 'truck', recommended: 'suv2', issue: 'WRONG_CLASS', notes: 'Compact van as Truck' },
    { make: 'Volkswagen', model: 'ID.Buzz', current: 'suv2', recommended: 'minivan', issue: 'WRONG_CLASS', notes: 'Van/MPV body; closer to minivan than 2-row SUV' },
    { make: 'Toyota', model: '4Runner', current: 'suv3', recommended: 'suv2', issue: 'WRONG_ROWS', notes: 'Mainstream 4Runner is 2-row (3rd row rare/optional historically); often over-classed' },
    { make: 'Ford', model: 'Mustang Mach-E', current: 'small', recommended: 'suv2', issue: 'WRONG_CLASS', notes: 'Crossover EV body; typically SUV 2-Row' },
    { make: 'Honda', model: 'Passport', current: null, recommended: 'suv2', issue: 'MISSING_MODEL', notes: 'placeholder' },
  ];

  // Minivan display set vs catalog
  for (const key of vehicleClass.MINIVAN_KEYS) {
    const [make, model] = key.split('|');
    const row = cd1.flat.find((r) => r.make === make && r.model === model);
    if (row && row.class !== 'suv3') {
      suspect.push({ make, model, issue: 'PRICING_TIER_SUSPECT', notes: `Minivan display but catalog tier ${row.class}` });
    }
  }

  // Check for missing common minivans in MINIVAN_KEYS
  const expectedMinivans = [
    ['Chrysler', 'Town & Country'],
    ['Nissan', 'Quest'],
    ['Kia', 'Sedona'],
    ['Volkswagen', 'Routan'],
    ['Ford', 'Freestar'],
    ['Mazda', 'Mazda5'],
  ];

  for (const s of CLASS_SUSPECTS) {
    if (s.issue === 'MISSING_MODEL') continue;
    const row = cd1.flat.find((r) => r.make === s.make && r.model === s.model);
    if (!row) continue;
    gaps.push({
      make: s.make,
      model: s.model,
      model_year_or_range: `${YEAR_MIN}-${YEAR_MAX}`,
      external_reference: 'NHTSA vPIC + classification audit',
      cardetail1_status: 'PRESENT_SUSPECT',
      current_class: row.class,
      recommended_class: s.recommended,
      issue_type: s.issue,
      priority: priorityForGap({ make: s.make, model: s.model, issue_type: s.issue, recommended_class: s.recommended }),
      notes: s.notes,
    });
    suspect.push(s);
  }

  // Duplicates / near-duplicates in CD1
  const seenNorm = new Map();
  for (const row of cd1.flat) {
    const k = `${row.make}||${normKey(row.model)}`;
    if (seenNorm.has(k)) {
      gaps.push({
        make: row.make,
        model: row.model,
        model_year_or_range: `${YEAR_MIN}-${YEAR_MAX}`,
        external_reference: 'Cardetail1 internal',
        cardetail1_status: 'DUPLICATE',
        current_class: row.class,
        recommended_class: row.class,
        issue_type: 'DUPLICATE',
        priority: 'P2',
        notes: `Duplicate of ${seenNorm.get(k)}`,
      });
    } else seenNorm.set(k, row.model);
  }
  // Toyota 86 / GR86 etc.
  if (cd1.models.Toyota?.t['86'] && cd1.models.Toyota?.t.GR86) {
    gaps.push({
      make: 'Toyota',
      model: '86 / GR86',
      model_year_or_range: '2012-2026',
      external_reference: 'NHTSA / market naming',
      cardetail1_status: 'ALIAS_OR_OVERLAP',
      current_class: 'small',
      recommended_class: 'small',
      issue_type: 'ALIAS',
      priority: 'P3',
      notes: 'Both 86 and GR86 listed; market continuity / alias overlap',
    });
    aliasIssues.push('Toyota 86 / GR86');
  }

  // Compare families
  for (const f of families.values()) {
    const years = [...f.years].sort((a, b) => a - b);
    const yearRange = years.length ? `${years[0]}-${years[years.length - 1]}` : '';
    const extNames = [...f.externalNames].join(' | ');

    if (f.cd1) {
      presentValid.push({ make: f.make, model: f.cd1.model, years });
      // Year validity: CD1 allows ANY year 1990-current for every model
      // If sampled external years are sparse relative to full selectable range, flag INVALID_YEAR risk
      const selectableSpan = YEAR_MAX - YEAR_MIN + 1;
      // Approximate: if model only appears in a late window, early years are invalid
      if (years.length >= 1) {
        const first = years[0];
        const last = years[years.length - 1];
        if (first > YEAR_MIN + 5) {
          gaps.push({
            make: f.make,
            model: f.cd1.model,
            model_year_or_range: `${YEAR_MIN}-${first - 1}`,
            external_reference: `NHTSA first-seen ~${first} (sampled); names: ${extNames}`,
            cardetail1_status: 'INVALID_YEAR_ACCEPTED',
            current_class: f.cd1.class,
            recommended_class: f.cd1.class,
            issue_type: 'INVALID_YEAR',
            priority: priorityForGap({ make: f.make, model: f.cd1.model, issue_type: 'INVALID_YEAR', recommended_class: f.cd1.class }),
            notes: `Catalog accepts years from ${YEAR_MIN} but model not observed in vPIC before ~${first}`,
          });
          invalidYear.push(f);
        }
        if (last < YEAR_MAX - 3 && last < 2020) {
          // discontinued long ago but still accepting recent years
          gaps.push({
            make: f.make,
            model: f.cd1.model,
            model_year_or_range: `${last + 1}-${YEAR_MAX}`,
            external_reference: `NHTSA last-seen ~${last} (sampled); names: ${extNames}`,
            cardetail1_status: 'INVALID_YEAR_ACCEPTED',
            current_class: f.cd1.class,
            recommended_class: f.cd1.class,
            issue_type: 'INVALID_YEAR',
            priority: priorityForGap({ make: f.make, model: f.cd1.model, issue_type: 'INVALID_YEAR', recommended_class: f.cd1.class }),
            notes: `Catalog accepts years through ${YEAR_MAX} but model not observed in vPIC after ~${last}`,
          });
          invalidYear.push(f);
        }
      }
    } else {
      // Missing from CD1 — or make missing
      const makePresent = cd1.makes.includes(f.make);
      const rec = recommendClass(f.make, f.model);
      const status = makePresent ? 'MISSING_MODEL' : 'MISSING_MAKE_AND_MODEL';
      const issue = 'MISSING_MODEL';
      const pri = priorityForGap({ make: f.make, model: f.model, issue_type: issue, recommended_class: rec });
      const row = {
        make: f.make,
        model: f.model,
        model_year_or_range: yearRange,
        external_reference: `NHTSA vPIC (${extNames})`,
        cardetail1_status: status,
        current_class: '',
        recommended_class: rec,
        issue_type: issue,
        priority: pri,
        notes: makePresent ? 'No canonical Cardetail1 model' : 'Make not in Cardetail1 MAKES list',
      };
      gaps.push(row);
      missingModels.push(row);
    }
  }

  // Models in CD1 never seen in NHTSA for this make (possible alias / typo / exotic)
  for (const row of cd1.flat) {
    const hit = [...families.values()].find((f) => f.cd1 && f.cd1.make === row.make && f.cd1.model === row.model);
    if (!hit) {
      // try direct external name scan
      const any = [...external.values()].some((e) => e.make === row.make && findCd1Match(e.make, e.model)?.model === row.model);
      if (!any) {
        gaps.push({
          make: row.make,
          model: row.model,
          model_year_or_range: `${YEAR_MIN}-${YEAR_MAX}`,
          external_reference: 'Not found in sampled NHTSA vPIC for make',
          cardetail1_status: 'PRESENT_UNVERIFIED',
          current_class: row.class,
          recommended_class: row.class,
          issue_type: 'ALIAS',
          priority: 'P3',
          notes: 'Present in Cardetail1 but not matched in sampled vPIC — verify naming/years',
        });
      }
    }
  }

  // Explicit full-size van inventory
  const VAN_EXPECT = [
    ['Ford', 'Transit', 'full_size_van'],
    ['Ford', 'Transit Connect', 'suv2'],
    ['Mercedes-Benz', 'Sprinter', 'full_size_van'],
    ['Mercedes-Benz', 'Metris', 'suv2'],
    ['Ram', 'ProMaster', 'full_size_van'],
    ['Ram', 'ProMaster City', 'suv2'],
    ['Chevrolet', 'Express', 'full_size_van'],
    ['GMC', 'Savana', 'full_size_van'],
    ['Nissan', 'NV', 'full_size_van'],
    ['Nissan', 'NV200', 'suv2'],
    ['Ford', 'E-Series', 'full_size_van'],
  ];
  for (const [make, model, rec] of VAN_EXPECT) {
    const row = cd1.flat.find((r) => r.make === make && normKey(r.model) === normKey(model));
    // fuzzy find
    const row2 = row || cd1.flat.find((r) => r.make === make && normKey(r.model).includes(normKey(model).split(' ')[0]));
    if (!row && !cd1.flat.some((r) => r.make === make && (normKey(r.model) === normKey(model) || normKey(r.model).startsWith(normKey(model))))) {
      // already may be in missingModels; ensure gap row exists
      const exists = gaps.some((g) => g.make === make && normKey(g.model) === normKey(model) && g.issue_type === 'MISSING_MODEL');
      if (!exists) {
        gaps.push({
          make,
          model,
          model_year_or_range: `${YEAR_MIN}-${YEAR_MAX}`,
          external_reference: 'Full-size/compact van audit checklist',
          cardetail1_status: 'MISSING_MODEL',
          current_class: '',
          recommended_class: rec,
          issue_type: 'MISSING_MODEL',
          priority: priorityForGap({ make, model, issue_type: 'MISSING_MODEL', recommended_class: rec }),
          notes: 'Expected van family from audit checklist',
        });
      }
    }
  }

  // Expected high-impact missing models (ensure listed even if NHTSA naming differs)
  const MUST_CHECK = [
    ['Honda', 'Passport', 'suv2'],
    ['Honda', 'Prologue', 'suv2'],
    ['Honda', 'Element', 'suv2'],
    ['Honda', 'Fit', 'small'],
    ['Honda', 'Insight', 'small'],
    ['Honda', 'HR-V', 'suv2'],
    ['Toyota', 'Corolla Cross', 'suv2'],
    ['Toyota', 'Grand Highlander', 'suv3'],
    ['Toyota', 'Crown Signia', 'suv2'],
    ['Toyota', 'FJ Cruiser', 'suv2'],
    ['Toyota', 'Matrix', 'small'],
    ['Toyota', 'Yaris', 'small'],
    ['Toyota', 'Sequoia', 'suv3'],
    ['Ford', 'Flex', 'suv3'],
    ['Ford', 'Fusion', 'small'],
    ['Ford', 'Focus', 'small'],
    ['Ford', 'Fiesta', 'small'],
    ['Ford', 'Taurus', 'small'],
    ['Ford', 'EcoSport', 'suv2'],
    ['Ford', 'Expedition MAX', 'suv3'],
    ['Chevrolet', 'Impala', 'small'],
    ['Chevrolet', 'Cruze', 'small'],
    ['Chevrolet', 'Spark', 'small'],
    ['Chevrolet', 'Sonic', 'small'],
    ['Chevrolet', 'Volt', 'small'],
    ['Chevrolet', 'Bolt EV', 'small'],
    ['Chevrolet', 'Bolt EUV', 'suv2'],
    ['Chevrolet', 'Blazer EV', 'suv2'],
    ['Chevrolet', 'Equinox EV', 'suv2'],
    ['Chevrolet', 'Silverado EV', 'truck'],
    ['Chevrolet', 'Traverse', 'suv3'],
    ['GMC', 'Hummer EV', 'suv3'],
    ['GMC', 'Terrain', 'suv2'],
    ['GMC', 'Acadia', 'suv3'],
    ['GMC', 'Yukon', 'suv3'],
    ['GMC', 'Savana', 'full_size_van'],
    ['Nissan', 'Kicks', 'suv2'],
    ['Nissan', 'Leaf', 'small'],
    ['Nissan', 'Ariya', 'suv2'],
    ['Nissan', 'Armada', 'suv3'],
    ['Nissan', 'Pathfinder', 'suv3'],
    ['Nissan', 'Murano', 'suv2'],
    ['Nissan', 'Quest', 'minivan'],
    ['Nissan', 'NV', 'full_size_van'],
    ['Nissan', 'NV200', 'suv2'],
    ['Nissan', 'Juke', 'suv2'],
    ['Nissan', 'Cube', 'small'],
    ['Nissan', 'Maxima', 'small'],
    ['Nissan', 'Sentra', 'small'],
    ['Nissan', 'Versa', 'small'],
    ['Nissan', 'Altima', 'small'],
    ['Hyundai', 'Venue', 'suv2'],
    ['Hyundai', 'Kona', 'suv2'],
    ['Hyundai', 'Ioniq', 'small'],
    ['Hyundai', 'Ioniq 5', 'suv2'],
    ['Hyundai', 'Ioniq 6', 'small'],
    ['Hyundai', 'Ioniq 9', 'suv3'],
    ['Hyundai', 'Santa Cruz', 'truck'],
    ['Hyundai', 'Genesis', 'small'], // legacy sedan before brand split
    ['Kia', 'Soul', 'suv2'],
    ['Kia', 'Niro', 'suv2'],
    ['Kia', 'EV6', 'suv2'],
    ['Kia', 'EV9', 'suv3'],
    ['Kia', 'K5', 'small'],
    ['Kia', 'Forte', 'small'],
    ['Kia', 'Rio', 'small'],
    ['Kia', 'Seltos', 'suv2'],
    ['Kia', 'Telluride', 'suv3'],
    ['Kia', 'Sedona', 'minivan'],
    ['Subaru', 'Legacy', 'small'],
    ['Subaru', 'BRZ', 'small'],
    ['Subaru', 'Baja', 'truck'],
    ['Mazda', 'CX-70', 'suv3'],
    ['Mazda', 'MX-5 Miata', 'small'],
    ['Mazda', 'CX-3', 'suv2'],
    ['Mazda', 'Tribute', 'suv2'],
    ['Mazda', 'Mazda5', 'minivan'],
    ['Volkswagen', 'Passat', 'small'],
    ['Volkswagen', 'CC', 'small'],
    ['Volkswagen', 'Beetle', 'small'],
    ['Volkswagen', 'Eos', 'small'],
    ['Volkswagen', 'Touareg', 'suv2'],
    ['Volkswagen', 'Routan', 'minivan'],
    ['Volkswagen', 'ID.Buzz', 'minivan'],
    ['Jeep', 'Wagoneer', 'suv3'],
    ['Jeep', 'Grand Wagoneer', 'suv3'],
    ['Jeep', 'Gladiator', 'truck'],
    ['Jeep', 'Commander', 'suv3'],
    ['Jeep', 'Liberty', 'suv2'],
    ['Jeep', 'Patriot', 'suv2'],
    ['Jeep', 'Compass', 'suv2'],
    ['Dodge', 'Charger', 'small'],
    ['Dodge', 'Challenger', 'small'],
    ['Dodge', 'Durango', 'suv3'],
    ['Dodge', 'Journey', 'suv3'],
    ['Dodge', 'Dart', 'small'],
    ['Dodge', 'Avenger', 'small'],
    ['Dodge', 'Nitro', 'suv2'],
    ['Dodge', 'Caliber', 'small'],
    ['Dodge', 'Viper', 'small'],
    ['Chrysler', 'Town & Country', 'minivan'],
    ['Chrysler', '200', 'small'],
    ['Chrysler', 'Sebring', 'small'],
    ['Chrysler', 'PT Cruiser', 'small'],
    ['Buick', 'Regal', 'small'],
    ['Buick', 'Verano', 'small'],
    ['Buick', 'Cascada', 'small'],
    ['Buick', 'Encore', 'suv2'],
    ['Cadillac', 'CT6', 'small'],
    ['Cadillac', 'ATS', 'small'],
    ['Cadillac', 'CTS', 'small'],
    ['Cadillac', 'XTS', 'small'],
    ['Cadillac', 'SRX', 'suv2'],
    ['Cadillac', 'Optiq', 'suv2'],
    ['Cadillac', 'Vistiq', 'suv3'],
    ['Cadillac', 'Escalade IQ', 'suv3'],
    ['Lincoln', 'MKZ', 'small'],
    ['Lincoln', 'MKC', 'suv2'],
    ['Lincoln', 'MKT', 'suv3'],
    ['Lincoln', 'MKX', 'suv2'],
    ['Lincoln', 'Continental', 'small'],
    ['Lincoln', 'Town Car', 'small'],
    ['Acura', 'RDX', 'suv2'],
    ['Acura', 'MDX', 'suv3'],
    ['Acura', 'TSX', 'small'],
    ['Acura', 'TL', 'small'],
    ['Acura', 'RSX', 'small'],
    ['INFINITI', 'QX60', 'suv3'],
    ['INFINITI', 'QX80', 'suv3'],
    ['INFINITI', 'QX50', 'suv2'],
    ['INFINITI', 'QX55', 'suv2'],
    ['INFINITI', 'Q50', 'small'],
    ['INFINITI', 'Q60', 'small'],
    ['Genesis', 'GV60', 'suv2'],
    ['Genesis', 'GV70', 'suv2'],
    ['Genesis', 'GV80', 'suv3'],
    ['Genesis', 'G70', 'small'],
    ['Genesis', 'G80', 'small'],
    ['Genesis', 'G90', 'small'],
    ['BMW', 'iX', 'suv2'],
    ['BMW', 'i3', 'small'],
    ['BMW', 'i8', 'small'],
    ['BMW', 'X6', 'suv2'],
    ['Mercedes-Benz', 'Sprinter', 'full_size_van'],
    ['Mercedes-Benz', 'Metris', 'suv2'],
    ['Mercedes-Benz', 'EQS', 'small'],
    ['Mercedes-Benz', 'EQE', 'small'],
    ['Mercedes-Benz', 'EQB', 'suv2'],
    ['Mercedes-Benz', 'EQS SUV', 'suv3'],
    ['Audi', 'Q4 e-tron', 'suv2'],
    ['Audi', 'Q6 e-tron', 'suv2'],
    ['Audi', 'e-tron GT', 'small'],
    ['Audi', 'Q8', 'suv3'],
    ['Porsche', 'Taycan', 'small'],
    ['Porsche', 'Macan', 'suv2'],
    ['Volvo', 'EX30', 'suv2'],
    ['Volvo', 'EX90', 'suv3'],
    ['Volvo', 'C40', 'suv2'],
    ['Polestar', '2', 'small'],
    ['Polestar', '3', 'suv2'],
    ['Polestar', '4', 'suv2'],
    ['Rivian', 'R1T', 'truck'],
    ['Rivian', 'R1S', 'suv3'],
    ['Lucid', 'Air', 'small'],
    ['Lucid', 'Gravity', 'suv3'],
    ['Tesla', 'Cybertruck', 'truck'],
    ['Mitsubishi', 'Outlander', 'suv3'],
    ['Mitsubishi', 'Outlander Sport', 'suv2'],
    ['Mitsubishi', 'Eclipse Cross', 'suv2'],
    ['Mitsubishi', 'Mirage', 'small'],
    ['Land Rover', 'Defender', 'suv3'],
    ['Jaguar', 'I-PACE', 'suv2'],
    ['Jaguar', 'F-PACE', 'suv2'],
    ['Jaguar', 'E-PACE', 'suv2'],
    ['MINI', 'Countryman', 'suv2'],
    ['MINI', 'Clubman', 'small'],
    ['FIAT', '500e', 'small'],
    ['FIAT', '500X', 'suv2'],
    ['FIAT', '500L', 'suv2'],
    ['Alfa Romeo', 'Tonale', 'suv2'],
    ['Saturn', 'Vue', 'suv2'],
    ['Saturn', 'Outlook', 'suv3'],
    ['Pontiac', 'Vibe', 'small'],
    ['Pontiac', 'G6', 'small'],
    ['Mercury', 'Grand Marquis', 'small'],
    ['Suzuki', 'SX4', 'small'],
    ['Suzuki', 'Grand Vitara', 'suv2'],
    ['Isuzu', 'Ascender', 'suv3'],
    ['Hummer', 'H2', 'suv3'],
    ['Hummer', 'H3', 'suv2'],
  ];

  function cd1Has(make, model) {
    const list = cd1.models[make];
    if (!list) return false;
    const nk = normKey(model);
    return list.m.some((m) => {
      const a = normKey(m);
      return a === nk || a.startsWith(nk) || nk.startsWith(a);
    });
  }

  for (const [make, model, rec] of MUST_CHECK) {
    if (cd1Has(make, model)) continue;
    const exists = gaps.some(
      (g) => g.make === make && normKey(g.model) === normKey(model) && g.issue_type === 'MISSING_MODEL'
    );
    if (exists) continue;
    gaps.push({
      make,
      model,
      model_year_or_range: `${YEAR_MIN}-${YEAR_MAX}`,
      external_reference: 'US-market checklist + NHTSA cross-check',
      cardetail1_status: cd1.makes.includes(make) ? 'MISSING_MODEL' : 'MISSING_MAKE_AND_MODEL',
      current_class: '',
      recommended_class: rec,
      issue_type: 'MISSING_MODEL',
      priority: priorityForGap({ make, model, issue_type: 'MISSING_MODEL', recommended_class: rec }),
      notes: 'Common/legitimate US light vehicle not in Cardetail1 canonical MODELS',
    });
  }

  // Deduplicate gaps by make|model|issue_type|year range
  const gapKey = (g) => `${g.make}|${g.model}|${g.issue_type}|${g.model_year_or_range}`;
  const uniq = new Map();
  for (const g of gaps) {
    const k = gapKey(g);
    if (!uniq.has(k)) uniq.set(k, g);
  }
  const gapRows = [...uniq.values()].sort((a, b) => {
    const po = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return (po[a.priority] ?? 9) - (po[b.priority] ?? 9) || a.make.localeCompare(b.make) || a.model.localeCompare(b.model);
  });

  // Pricing numeric proof
  const pkgs = ['wash', 'maint', 'interior', 'full', 'refresh', 'premium'];
  let pricingAllNumeric = true;
  const pricingIssues = [];
  for (const [tier, cfg] of Object.entries(PRICING.cars.tiers)) {
    for (const p of pkgs) {
      const v = cfg[p];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        pricingAllNumeric = false;
        pricingIssues.push(`${tier}.${p}=${v}`);
      }
    }
  }

  // Counts
  const priCount = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const g of gapRows) priCount[g.priority] = (priCount[g.priority] || 0) + 1;

  const missingCanon = gapRows.filter((g) => g.issue_type === 'MISSING_MODEL');
  const partial = gapRows.filter((g) => g.issue_type === 'MISSING_YEAR');
  const invalid = gapRows.filter((g) => g.issue_type === 'INVALID_YEAR');
  const wrongClass = gapRows.filter((g) => g.issue_type === 'WRONG_CLASS' || g.issue_type === 'WRONG_ROWS' || g.issue_type === 'PRICING_TIER_SUSPECT');
  const aliasDup = gapRows.filter((g) => g.issue_type === 'ALIAS' || g.issue_type === 'DUPLICATE');

  // Compact vans present
  const compactVansPresent = cd1.flat.filter((r) =>
    /transit connect|promaster city|nv200|metris/i.test(`${r.make} ${r.model}`)
  );
  const fullSizePresent = cd1.flat.filter((r) =>
    /^(Transit|Express|ProMaster|Savana|Sprinter|NV)$/i.test(r.model) || /sprinter|^nv$/i.test(r.model)
  );

  // Write CSV
  const csvPath = path.join(OUT_DIR, 'vehicle-catalog-gaps-2026-09.csv');
  const header = [
    'make',
    'model',
    'model_year_or_range',
    'external_reference',
    'cardetail1_status',
    'current_class',
    'recommended_class',
    'issue_type',
    'priority',
    'notes',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    return /["',\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header.join(','), ...gapRows.map((g) => header.map((h) => esc(g[h])).join(','))].join('\n');
  fs.writeFileSync(csvPath, csv);

  // Summary JSON for markdown generation
  const summary = {
    catalog: {
      source: 'index.html const MODELS / MAKES (duplicated across hubs)',
      yearMin: YEAR_MIN,
      yearMax: YEAR_MAX,
      yearAware: false,
      aliasesSupported: false,
      makes: cd1.makes.length,
      makeList: cd1.makes,
      canonicalModels: cd1.flat.length,
      classes: {
        pricing: Object.keys(PRICING.cars.tiers),
        display: Object.keys(vehicleClass.DISPLAY),
        byCount: cd1.flat.reduce((a, r) => {
          a[r.class] = (a[r.class] || 0) + 1;
          return a;
        }, {}),
      },
      minivanKeys: [...vehicleClass.MINIVAN_KEYS],
      yearOverrides: vehicleClass.YEAR_OVERRIDES,
    },
    external: {
      makesReviewed: makesToFetch.length,
      makeList: makesToFetch,
      sampleYears,
      modelYearCombosApprox: [...external.values()].reduce((n, r) => n + r.years.size, 0),
      uniqueExternalModels: external.size,
      uniqueFamilies: families.size,
    },
    coverage: {
      missingModels: missingCanon.length,
      partialYear: partial.length,
      invalidYear: invalid.length,
      suspectClass: wrongClass.length,
      aliasDup: aliasDup.length,
      gapRows: gapRows.length,
    },
    vans: {
      fullSizePresent: fullSizePresent.map((r) => `${r.make} ${r.model}→${r.class}`),
      compactPresent: compactVansPresent.map((r) => `${r.make} ${r.model}→${r.class}`),
      missingFullSizeFamilies: ['Mercedes-Benz Sprinter', 'GMC Savana', 'Nissan NV', 'Ford E-Series (legacy)'].filter((label) => {
        const [make, ...rest] = label.split(' ');
        const model = rest.join(' ').replace(/ \(legacy\)/, '');
        return !cd1Has(make, model.split(' ')[0] === 'Mercedes-Benz' ? rest.slice(1).join(' ') : model);
      }),
      recommendFullSizeVanClass: true,
      passengerCargoSubtypeFeasible: true,
    },
    priority: priCount,
    pricing: {
      allNumeric: pricingAllNumeric,
      issues: pricingIssues,
      newTiersNeeded: ['full_size_van'],
      minivanPlus10Compatible: true,
    },
    topGaps: gapRows
      .filter((g) => g.priority === 'P0' || g.priority === 'P1')
      .slice(0, 40)
      .map((g) => `${g.priority} ${g.make} ${g.model} [${g.issue_type}] → ${g.recommended_class}`),
    estimates: {
      modelsToAdd: missingCanon.filter((g) => g.priority === 'P0' || g.priority === 'P1' || g.priority === 'P2').length,
      yearRangeFixes: invalid.length,
      classificationFixes: wrongClass.length,
      recommendedPRs: 4,
    },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'vehicle-catalog-coverage-summary-2026-09.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(CACHE, 'gap-rows.json'), JSON.stringify(gapRows, null, 2));

  console.log(JSON.stringify({
    csvPath,
    gapRows: gapRows.length,
    priCount,
    missing: missingCanon.length,
    invalid: invalid.length,
    wrongClass: wrongClass.length,
    models: cd1.flat.length,
    makes: cd1.makes.length,
    externalModels: external.size,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
