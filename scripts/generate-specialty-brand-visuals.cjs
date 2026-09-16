#!/usr/bin/env node
/**
 * Generate exact make+model → studio visual keys for specialty categories
 * (powersports, boats, RVs).
 *
 * Sources:
 *   - assets/powersports-model-catalog.js (exact records)
 *   - index.html window.SPECIALTY_MODELS boats/rvs blocks
 *
 * Output: assets/generated/specialty-brand-model-visuals.generated.js
 *
 * Usage:
 *   node scripts/generate-specialty-brand-visuals.cjs
 *   node scripts/generate-specialty-brand-visuals.cjs --check
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'assets/generated/specialty-brand-model-visuals.generated.js');
const CHECK = process.argv.includes('--check');
const Powersports = require(path.join(ROOT, 'assets/powersports-model-catalog.js'));

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadSpecialtyModels() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const start = html.indexOf('window.SPECIALTY_MODELS = ');
  if (start < 0) throw new Error('SPECIALTY_MODELS not found');
  let i = html.indexOf('{', start);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const lit = html.slice(html.indexOf('{', start), i + 1);
  const sandbox = {
    window: { CD1PowersportsCatalog: Powersports },
    CD1PowersportsCatalog: Powersports,
  };
  vm.createContext(sandbox);
  vm.runInContext('window.SPECIALTY_MODELS = ' + lit + ';', sandbox);
  return sandbox.window.SPECIALTY_MODELS;
}

/**
 * When catalog displaySubtype is a generic "Motorcycle", refine silhouette from
 * the model name (same archetypes as booking MODEL_MAP).
 */
function motorcycleModelVisual(model) {
  const m = norm(model);
  if (!m) return '';
  // Sport before dirt so YZF-R* (road) is not swallowed by YZ* (MX) prefixes
  if (
    /hayabusa|gsx-?r|gsx-?8r|cbr|ninja|yzf-?r|panigale|fireblade|daytona|rc 390|s 1000 rr|rsv4|rs 660|tuono|450ss|zx-?\d/.test(
      m
    )
  ) {
    return 'sportbike';
  }
  // Dirt / dual-sport / MX (YZ250F etc. — not YZF-R road bikes)
  if (
    /^(crf|kx\d|yz\d|wr\d|rm-?z|dr-?z|fc |fe |te |tc )/.test(m) ||
    /\b(enduro|motocross|supermoto)\b/.test(m) ||
    /^(250|300|350|450) (sx|xc|exc)/.test(m) ||
    /\b(sx-?f|xc-?w|exc-?f)\b/.test(m)
  ) {
    return 'dirtbike';
  }
  // Adventure / touring dual-sport
  if (
    /africa twin|v-?strom|tenere|versys|tiger|multistrada|desertx|norden|pan america|adventure|800mt|f 750 gs|f 850 gs|g 310 gs|r 1250 gs|r 1300 gs|klr650|concours/.test(
      m
    )
  ) {
    return 'adventure';
  }
  // Scooter
  if (/^(gts|gtv|primavera|sprint|c 400)/.test(m) || /\b(pcx|forza|metropolis|burgman|nmax|xmax)\b/.test(m)) {
    return 'scooter';
  }
  // Touring / bagger / large cruiser
  if (
    /glide|road king|ultra limited|chieftain|roadmaster|pursuit|challenger|springfield|gold wing|k 1600|fjr|star venture|rocket 3|boulevard m|diavel|heritage|fat (boy|bob)|breakout|softail|low rider|street bob|iron 883|nightster|rebel 1100/.test(
      m
    )
  ) {
    return 'touring_bagger';
  }
  // Cruiser
  if (/boulevard|vulcan|rebel|scout|^chief$|^chief /.test(m)) return 'cruiser';
  return '';
}

/** Map powersports displaySubtype / physicalFamily → visual key. */
function powersportsVisual(record) {
  const sub = String(record.displaySubtype || '').toLowerCase();
  const fam = String(record.physicalFamily || '').toLowerCase();
  const svc = String(record.serviceClass || '').toLowerCase();
  const modelHit = motorcycleModelVisual(record.model);

  if (fam === 'pwc' || /jet ski|pwc/.test(sub)) return 'jetski';
  if (fam === 'golfcart' || /golf cart/.test(sub)) return 'golfcart';
  if (fam === 'equipment' || /tractor|equipment|skid/.test(sub)) return 'equipment';
  if (fam === 'atv' || /atv|quad/.test(sub)) return 'atv';
  if (fam === 'utv' || /side-by-side|utv|utility vehicle/.test(sub)) {
    if (svc === 'utv_large' || /crew|large|max/.test(sub) || /crew|max|4-seat/i.test(record.configuration || '')) {
      return 'utv_crew';
    }
    return 'utv';
  }
  if (fam === 'motorcycle_trike' || /trike|3-wheel/.test(sub)) return 'motorcycle';
  if (fam === 'boat' || /pontoon/.test(sub)) return 'pontoon';

  // Explicit motorcycle subtypes from catalog groups
  if (/dirt|dual-sport|enduro|motocross/.test(sub)) return 'dirtbike';
  if (/sport motorcycle|sportbike/.test(sub)) return 'sportbike';
  if (/adventure/.test(sub)) return 'adventure';
  if (/scooter/.test(sub)) return 'scooter';
  if (/touring|bagger|large cruiser/.test(sub)) return 'touring_bagger';
  if (/cruiser/.test(sub) && svc === 'motorcycle_large') return 'touring_bagger';
  if (/cruiser/.test(sub)) return modelHit === 'sportbike' ? 'sportbike' : 'cruiser';

  // Generic "Motorcycle" / naked / electric — refine from model name
  if (modelHit) return modelHit;
  if (/naked|standard|electric|motorcycle/.test(sub)) return 'motorcycle';
  return 'motorcycle';
}

/** Boat make/model heuristics → visual key. */
function boatVisual(make, model) {
  const blob = norm(make + ' ' + model);
  if (/pontoon|bennington|barletta|harris|sun tracker|party barge|fishin barge|bass buggy|starcraft cx|princecraft ventura|vectra/.test(blob)) {
    return 'pontoon';
  }
  if (/bass cat|bass tracker|pro team|pro guide|nitro z|skeeter|caymas|ranger boats z|vx1788|vx1888|tracker targa|crestliner fish|lowe fishing/.test(blob)) {
    return 'bassboat';
  }
  if (/sail|catalina sail|beneteau|jeanneau sun|hunter sail|laser/.test(blob)) return 'sailboat';
  if (/sundancer|cabin|cross cabin|super express|grande coupe|ciera|merry fisher|nc |axopar .*cabin|formula 3|regal 3|monterey 3|cobalt r3|chris-craft calypso|launch 3/.test(blob)) {
    return 'cabincruiser';
  }
  if (/yacht|azimut|princess/.test(blob)) return 'yacht';
  if (/outrage|montauk|xsf|lxf|canyon|fisherman|freedom 2|robalo|scout|boston whaler|grady|parker|center console|sportfish/.test(blob)) {
    return 'center_console';
  }
  if (/mastercraft|nautique|ski |wake|supair|nxt|xt2|g21|g23|g25/.test(blob)) return 'runabout';
  if (/bayliner|chaparral|cobalt|element|m17|m19|m20|m22|vr4|ssi|ssx|spx|sdx|slx|ls2|ls4|lx2/.test(blob)) {
    return 'runabout';
  }
  return 'runabout';
}

/** RV make/model heuristics → visual key. */
function rvVisual(make, model) {
  const mk = norm(make);
  const md = norm(model);
  const blob = mk + ' ' + md;

  if (/airstream/.test(mk) || /flying cloud|basecamp|bambi|caravel|globetrotter|trade wind|pottery barn|rangeline/.test(md)) {
    // Interstate is Class B van; others mostly travel trailer / touring
    if (/interstate/.test(md)) return 'classb';
    return 'airstream';
  }

  // Cargo / utility / horse trailers
  if (/big tex|carry-on|haulmark|featherlite|cargo trailer|utility trailer|car hauler|dump trailer|equipment trailer|horse trailer|livestock/.test(blob)) {
    return 'trailer';
  }

  // Fifth wheels
  if (/fifth|5th|solitude|momentum|reflection|paradigm|avenue|delta|valor|cardinal|cedar creek|bighorn|big country|landmark|arctic wolf|sandpiper|montana|cougar|eagle ht|passport gt/.test(blob)) {
    // some of these are also travel trailers — prefer fifth when brand is known fifth-wheel lines
    if (/grand design solitude|grand design momentum|grand design reflection|alliance|heartland bighorn|heartland big country|forest river cardinal|jayco eagle|keystone cougar|keystone montana/.test(blob) || /fifth|5th/.test(blob)) {
      return 'fifthwheel';
    }
  }
  if (/solitude|momentum|reflection|paradigm|cardinal|bighorn|big country|cedar creek|yukon|voltage|cyclone|torque|fuel|sandpiper|open range|terrane/.test(md)) {
    return 'fifthwheel';
  }

  // Class A motorhomes
  if (/bounder|pace arrow|discovery|flair|fortis|frontier|mirada|georgetown|berkshire|anthem|aspire|cornerstone|accade|reata|phaton|dutch star|ventana|journey|essex|ambassador|arcadia|allegro|phason|inspire|embark|adair|precept|ace |fr3|fray|bay star|storm|challenger|magnus|magnolia|quantum|odyssey class|southwind|bounder/.test(blob)) {
    return 'classa';
  }
  if (/fleetwood|entegra|tiffin|newmar|winnebago vista|winnebago adventurer|winnebago sightseer|thor ace|thor hurricane|thor palazzo|coachmen encore|coachmen miranda/.test(blob)) {
    // brand-level Class A lean — model-specific below overrides
  }

  // Class B camper vans
  if (/travato|revel|ekko|boldt|solis|vita|ethos|navion|view |interstate|rangeline|prism|tellaro|yncar|pleasure-way|roadtrek|chinook|airstream interstate|winnebago travato|winnebago revel|winnebago ekko|thor tellaro|coachmen galleria|coachmen beyond/.test(blob)) {
    return 'classb';
  }
  if (/class b|camper van|sprinter van|transit camper/.test(blob)) return 'classb';

  // Class C
  if (/freelander|leprechaun|forester|sunseeker|quantum|chateau|four winds|quantum|odyssey|esteem|bt cruiser|freedom elite|twin beds|class c/.test(blob)) {
    return 'classc';
  }
  if (/thor four winds|thor chateau|thor quantum|coachmen freelander|coachmen leprechaun|forest river forester|forest river sunseeker|jayco redhawk|jayco melbourne|gustream independence/.test(blob)) {
    return 'classc';
  }

  // Travel trailers (default for remaining towables)
  if (/imagine|transcend|apex|catalina|salem|wildwood|vibe|rockwood|flagstaff|no boundaries|grey wolf|wolf pack|sandstorm|aspen trail|kodiak|coleman|colorado|zinger|volante|sunset trail|cruiser aire|cameo|hampton|redwood|americana|americana lite|geo pro|jay feather|white hawk|hummingbird|talon|eagle ht|passport|springdale|hideout|bullet|connect|sprinter|outback|bullet|connect/.test(blob)) {
    return 'traveltrailer';
  }

  // Brand defaults
  if (/winnebago|thor|tiffin|newmar|fleetwood|entegra|coachmen|jayco|forest river|grand design|heartland|dutchmen|gulf stream|crossroads|alliance|keystone|lazydays/.test(mk)) {
    // motorized brands often Class A/C — prefer traveltrailer only when model looks towable
    if (/trailer|travel|nano|feather|lite|apex|imagine|salem|wildwood/.test(md)) return 'traveltrailer';
    if (/van|travato|revel|ekko|solis|vita|ethos|navion|view|interstate|tellaro|prism/.test(md)) return 'classb';
    if (/freelander|leprechaun|forester|sunseeker|chateau|four winds|redhawk|melbourne|quantum|odyssey|esteem/.test(md)) return 'classc';
    return 'classa';
  }

  return 'traveltrailer';
}

function build() {
  const specialty = loadSpecialtyModels();
  const byCat = { powersports: {}, boats: {}, rvs: {} };
  const flat = {};
  let count = 0;

  function add(cat, make, model, visual) {
    if (!byCat[cat][make]) byCat[cat][make] = {};
    byCat[cat][make][model] = visual;
    flat[cat + '|' + norm(make) + '|' + norm(model)] = visual;
    count++;
  }

  for (const r of Powersports.records || []) {
    add('powersports', r.make, r.model, powersportsVisual(r));
  }

  for (const [make, models] of Object.entries(specialty.boats || {})) {
    for (const model of models) add('boats', make, model, boatVisual(make, model));
  }

  for (const [make, models] of Object.entries(specialty.rvs || {})) {
    for (const model of models) add('rvs', make, model, rvVisual(make, model));
  }

  return { byCat, flat, count };
}

function serialize(data) {
  return (
    '/* AUTO-GENERATED by scripts/generate-specialty-brand-visuals.cjs — do not edit. */\n' +
    '/* Sources: powersports-model-catalog.js + index.html SPECIALTY_MODELS */\n' +
    '(function (root, factory) {\n' +
    '  var data = factory();\n' +
    "  if (typeof module === 'object' && module.exports) module.exports = data;\n" +
    '  if (root) root.CD1_SPECIALTY_BRAND_MODEL_VISUALS = data;\n' +
    "})(typeof globalThis !== 'undefined' ? globalThis : this, function () {\n" +
    '  return ' +
    JSON.stringify(data) +
    ';\n' +
    '});\n'
  );
}

function main() {
  const data = build();
  const body = serialize(data);
  if (CHECK) {
    if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== body) {
      console.error('DRIFT: assets/generated/specialty-brand-model-visuals.generated.js');
      process.exit(1);
    }
    console.log(JSON.stringify({ check: true, models: data.count, drift: false }));
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  const summary = {
    wrote: path.relative(ROOT, OUT),
    models: data.count,
    powersports: Object.values(data.byCat.powersports).reduce((n, m) => n + Object.keys(m).length, 0),
    boats: Object.values(data.byCat.boats).reduce((n, m) => n + Object.keys(m).length, 0),
    rvs: Object.values(data.byCat.rvs).reduce((n, m) => n + Object.keys(m).length, 0),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
