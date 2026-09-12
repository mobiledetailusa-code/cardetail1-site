#!/usr/bin/env node
/**
 * Sync Cars vehicle catalog SoT → generated runtime + booking HTML MODELS/MAKES.
 *
 * Source of truth: data/cars-vehicle-catalog.json
 *
 * Usage:
 *   node scripts/sync-vehicle-catalog.cjs
 *   node scripts/sync-vehicle-catalog.cjs --check
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SOT = path.join(ROOT, 'data/cars-vehicle-catalog.json');
const GENERATED_JS = path.join(ROOT, 'assets/generated/cars-vehicle-catalog.generated.js');
const CHECK = process.argv.includes('--check');

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function loadSot() {
  return JSON.parse(fs.readFileSync(SOT, 'utf8'));
}

function publicVehicles(catalog) {
  return (catalog.vehicles || []).filter((v) => v.public !== false);
}

function pricingClassForVanUse(vehicle, use) {
  const size = vehicle.vanSize || null;
  const u = use || vehicle.defaultVanUse || (vehicle.vanUseOptions || [])[0] || null;
  if (vehicle.vehicleFamily !== 'van' && !size) return vehicle.pricingClass;
  if (size === 'compact') return 'compact_van';
  if (size === 'midsize') return 'midsize_van';
  if (size === 'full_size') {
    return u === 'passenger' ? 'full_size_van_passenger' : 'full_size_van';
  }
  return vehicle.pricingClass;
}

function toLegacy(catalog) {
  const models = {};
  function add(make, model, pricingClass) {
    if (!models[make]) models[make] = { m: [], t: {} };
    if (!models[make].m.includes(model)) models[make].m.push(model);
    models[make].t[model] = pricingClass;
  }
  for (const v of publicVehicles(catalog)) {
    const uses = Array.isArray(v.vanUseOptions) ? v.vanUseOptions : null;
    const isVan = v.vehicleFamily === 'van' || !!v.vanSize;
    // Canonical family name (default use / legacy pricingClass).
    add(v.make, v.model, isVan ? pricingClassForVanUse(v, v.defaultVanUse) : v.pricingClass);
    // Expand Cargo/Passenger selectables for dual-use vans (no HTML hand-edits).
    if (isVan && uses && uses.length > 1) {
      for (const use of uses) {
        const suffix = use === 'passenger' ? 'Passenger' : 'Cargo';
        add(v.make, `${v.model} ${suffix}`, pricingClassForVanUse(v, use));
      }
    }
  }
  for (const make of Object.keys(models)) {
    models[make].m.sort((a, b) => a.localeCompare(b));
  }
  const makes = Object.keys(models).sort((a, b) => a.localeCompare(b));
  return { makes, models };
}

function serializeModels(models) {
  const makes = Object.keys(models).sort((a, b) => a.localeCompare(b));
  return makes
    .map((make, idx) => {
      const ordered = [...models[make].m].sort((a, b) => a.localeCompare(b));
      const t = {};
      for (const model of ordered) t[model] = models[make].t[model];
      const body = `{m:${JSON.stringify(ordered)},t:${JSON.stringify(t)}}`;
      if (makes.length === 1) return `{${JSON.stringify(make)}:${body}}`;
      if (idx === 0) return `{${JSON.stringify(make)}:${body},`;
      if (idx === makes.length - 1) return `${JSON.stringify(make)}:${body}}`;
      return `${JSON.stringify(make)}:${body},`;
    })
    .join('\n');
}

function extractAssignment(html, name) {
  const re = new RegExp(`const ${name} = `);
  const m = re.exec(html);
  if (!m) throw new Error(`const ${name} not found`);
  const exprStart = m.index + m[0].length;
  const openCh = html[exprStart];
  if (openCh !== '{' && openCh !== '[') {
    throw new Error(`${name} must start with { or [`);
  }
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0;
  let i = exprStart;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < html.length) {
        if (html[i] === '\\') {
          i += 2;
          continue;
        }
        if (html[i] === q) break;
        i++;
      }
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  if (html[i] !== ';') {
    throw new Error(`${name} not terminated with ; near ${JSON.stringify(html.slice(i, i + 12))}`);
  }
  return { exprStart, exprEnd: i, literal: html.slice(exprStart, i) };
}

function replaceAssignment(html, extracted, newLiteral) {
  return html.slice(0, extracted.exprStart) + newLiteral + html.slice(extracted.exprEnd);
}

function ensureCatalogScripts(html) {
  const catalogTag = '<script src="assets/generated/cars-vehicle-catalog.generated.js"></script>';
  const runtimeTag = '<script src="assets/vehicle-catalog.js"></script>';
  const resolverTag = '<script src="assets/vehicle-class-resolver.js"></script>';
  if (!html.includes(resolverTag) && !html.includes("assets/vehicle-class-resolver.js")) {
    throw new Error('vehicle-class-resolver.js script tag missing');
  }
  let next = html;
  if (!next.includes('cars-vehicle-catalog.generated.js')) {
    next = next.replace(
      /<script src="assets\/vehicle-class-resolver\.js"><\/script>/,
      `${catalogTag}\n<script src="assets/vehicle-catalog.js"></script>\n<script src="assets/vehicle-class-resolver.js"></script>`
    );
  } else if (!next.includes('assets/vehicle-catalog.js')) {
    next = next.replace(
      /<script src="assets\/generated\/cars-vehicle-catalog\.generated\.js"><\/script>/,
      `${catalogTag}\n${runtimeTag}`
    );
  }
  return next;
}

function writeGenerated(catalog) {
  const body =
    '/* AUTO-GENERATED by scripts/sync-vehicle-catalog.cjs — do not edit. */\n' +
    '/* Source of truth: data/cars-vehicle-catalog.json */\n' +
    '(function (root, factory) {\n' +
    '  var data = factory();\n' +
    "  if (typeof module === 'object' && module.exports) module.exports = data;\n" +
    '  if (root) root.CD1_CARS_VEHICLE_CATALOG = data;\n' +
    '})(typeof globalThis !== \'undefined\' ? globalThis : this, function () {\n' +
    '  return ' +
    JSON.stringify(catalog) +
    ';\n' +
    '});\n';
  return body;
}

function main() {
  const catalog = loadSot();
  const { makes, models } = toLegacy(catalog);
  const makesLit = JSON.stringify(makes);
  const modelsLit = serializeModels(models);
  const generated = writeGenerated(catalog);

  let drift = false;

  // Generated JS
  if (CHECK) {
    if (!fs.existsSync(GENERATED_JS) || fs.readFileSync(GENERATED_JS, 'utf8') !== generated) {
      console.error('DRIFT: assets/generated/cars-vehicle-catalog.generated.js');
      drift = true;
    }
  } else {
    fs.mkdirSync(path.dirname(GENERATED_JS), { recursive: true });
    fs.writeFileSync(GENERATED_JS, generated);
    console.log('wrote', path.relative(ROOT, GENERATED_JS));
  }

  for (const page of BOOKING_PAGES) {
    const fp = path.join(ROOT, page);
    let html = fs.readFileSync(fp, 'utf8');
    const before = html;
    const makesExt = extractAssignment(html, 'MAKES');
    html = replaceAssignment(html, makesExt, makesLit);
    const modelsExt = extractAssignment(html, 'MODELS');
    html = replaceAssignment(html, modelsExt, modelsLit);
    html = ensureCatalogScripts(html);
    if (CHECK) {
      if (html !== before) {
        console.error('DRIFT:', page);
        drift = true;
      }
    } else if (html !== before) {
      fs.writeFileSync(fp, html);
      console.log('synced', page);
    } else {
      console.log('unchanged', page);
    }
  }

  // Parity snapshot counts
  let modelCount = 0;
  for (const mk of makes) modelCount += models[mk].m.length;
  console.log(JSON.stringify({ makes: makes.length, models: modelCount, check: CHECK, drift }, null, 2));
  if (CHECK && drift) process.exit(1);
}

main();
