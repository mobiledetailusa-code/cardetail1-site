/**
 * Sync add-on catalog across booking pages + server pricing catalog.
 * Add-on entries have no icon fields — UI is name/description/price only.
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

const CARS_ADDONS = `    addons:[
      {id:'pethair',    scope:'int', name:'Pet Hair Removal',          desc:'Deep pet hair removal from seats, carpets, mats, and trunk. Heavy buildup may need an estimate', price:95},
      {id:'superint',   scope:'int', name:'Super Interior Upgrade',    desc:'Extra shampoo passes and hand-steam on panels, pockets, and cargo areas', price:125},
      {id:'odor',       scope:'int', name:'Odor Treatment & Sanitize', desc:'Treatment for smoke, food, pet, and general interior odors. Severe odor, mold, urine, or biohazard may require estimate confirmation', price:90},
      {id:'mold',       scope:'int', name:'Mold Treatment',            desc:'Targeted mold treatment for affected interior areas. Inspection required; estimate may be needed. Starting at $149 based on severity', price:149},
      {id:'sanitize',   scope:'int', name:'Interior Sanitizing',       desc:'High-touch interior wipe-down after cleaning — wheel, controls, handles, seats, and belts', price:65},
      {id:'biohazard',  scope:'int', name:'Biohazard Cleaning',        desc:'Bodily fluids, blood, vomit, waste, or severe contamination. Estimate confirmation required', price:115},
      {id:'engine',     scope:'ext', name:'Engine Bay Top Clean',      desc:'Top-view cleaning of visible engine bay surfaces and covers. Detailing only — not mechanical service', price:45},
      {id:'floormats',  scope:'int', name:'Floor Mat Deep Clean',      desc:'Deep shampoo and scrub of rubber or fabric floor mats. $20 each', price:20, qty:true},
      {id:'rainx',      scope:'ext', name:'Rain-X Glass Treatment',    desc:'Water-repellent Rain-X on windshield and front glass', price:25},
      {id:'polymer',    scope:'ext', name:'Polymer Paint Sealant',     desc:'Hand-applied polymer sealant for paint protection and gloss. Lasts 3–6 months', price:25},
      {id:'wax1yr',     scope:'ext', name:'1-Year Carnauba Wax',       desc:'Premium carnauba wax with enhanced gloss and up to 12 months of protection', price:75},
      {id:'claybar',    scope:'ext', name:'Clay Bar Treatment',        desc:'Removes embedded contaminants, fallout, and rail dust for smooth paint', price:45},
      {id:'headlight',  scope:'ext', name:'Headlight Restoration',     desc:'Clean, polish, and seal foggy headlights (per pair). Cosmetic detailing only', price:90},
      {id:'babyseat',   scope:'int', name:'Baby / Car Seat Cleaning',  desc:'Clean child car seat straps, padding, and buckle. $20 each', price:20, qty:true},
      {id:'stroller',   scope:'int', name:'Baby Stroller Cleaning',    desc:'Wash stroller fabric, frame, and wheels. $20 each', price:20, qty:true},
      {id:'trashcans',  scope:'any', name:'Trash Can Cleaning',        desc:'Residential trash can cleaning at the service location. $25 each', price:25, qty:true},
    ],`;

const BOATS_ADDONS = `    addons:[
      {id:'rainx',      name:'Rain-X Glass Treatment',     desc:'Water-repellent treatment for marine windshields and glass', price:25},
      {id:'polymer',    name:'Polymer Hull Sealant',        desc:'Polymer sealant on hull exterior for protection and gloss', price:25},
      {id:'wax1yr',     name:'1-Year Marine Carnauba Wax',  desc:'Premium carnauba wax for marine gel coat — up to 12 months protection', price:75},
      {id:'chrome',     name:'Chrome / Stainless Polish',   desc:'Polish accessible chrome, rails, cleats, and brightwork on exterior surfaces', price:85},
      {id:'odor',       name:'Odor Treatment & Sanitize',  desc:'Treatment for smoke, food, pet, and cabin odors. Severe cases may require estimate confirmation', price:90},
      {id:'mold',       name:'Mold Treatment',              desc:'Targeted mold treatment for affected cabin areas. Inspection required; estimate may be needed. Starting at $149 based on severity', price:149},
      {id:'sanitize',   name:'Interior Sanitizing',         desc:'High-touch cabin wipe-down after cleaning', price:65},
      {id:'biohazard',  name:'Biohazard Cleaning',          desc:'Bodily fluids or severe contamination. Estimate confirmation required', price:115},
      {id:'trashcans',  name:'Trash Can Cleaning',          desc:'Trash can cleaning at marina, storage yard, or home. $25 per can', price:25, qty:true},
    ],`;

const RVS_ADDONS = `    addons:[
      {id:'polymer',    scope:'ext', name:'Polymer Sealant Upgrade',   desc:'Polymer sealant on RV exterior for added protection and gloss', price:25},
      {id:'wax1yr',     scope:'ext', name:'1-Year Carnauba Wax',       desc:'Premium carnauba wax on RV exterior with UV and weather protection', price:75},
      {id:'rainx',      scope:'ext', name:'Rain-X Windshield Treatment', desc:'Water-repellent Rain-X on RV windshield and front glass', price:25},
      {id:'biohazard',  scope:'int', name:'Biohazard Cleaning',        desc:'Bodily fluids, waste, or severe contamination. Estimate confirmation required', price:115},
      {id:'mold',       scope:'int', name:'Mold Treatment',            desc:'Targeted mold treatment for affected interior areas. Inspection required; estimate may be needed. Starting at $149 based on severity', price:149},
      {id:'sanitize',   scope:'int', name:'Interior Sanitizing',       desc:'High-touch interior wipe-down after cleaning', price:65},
      {id:'awning',     scope:'ext', name:'Awning Cleaning',           desc:'RV awning fabric wash and clean. Cleaning only — no repair, replacement, mechanism service, or re-tensioning', price:50, qty:true},
      {id:'roof',       scope:'ext', name:'Roof Surface Cleaning',     desc:'Exterior RV/trailer roof wash and clean. Cleaning only — no repair, resealing, leaks, or mechanical work', price:50, qty:true},
      {id:'capfront',   scope:'ext', name:'Front Cap Deep Clean',      desc:'RV front cap exterior wash for bugs, grime, and road film. Surface cleaning and detailing only', price:149},
      {id:'pethair',    scope:'int', name:'Pet Hair Removal',          desc:'Pet hair removal from RV seats, rugs, cushions, and living areas', price:95},
      {id:'odor',       scope:'int', name:'Odor Treatment & Sanitize', desc:'Treatment for smoke, food, pet, and interior odors. Severe cases may require estimate confirmation', price:90},
      {id:'trashcans',  scope:'any', name:'Trash Can Cleaning',        desc:'$25 per can at RV park, campground, storage, or home', price:25, qty:true},
    ],`;

const POWERSPORTS_ADDONS = `    addons:[
      {id:'polymer',    name:'Polymer Sealant',              desc:'Polymer paint and plastic sealant for protection and gloss', price:25},
      {id:'wax1yr',     name:'1-Year Carnauba Wax',          desc:'Premium carnauba wax for enhanced gloss and paint protection', price:75},
      {id:'rainx',      name:'Rain-X Windshield / Visor',    desc:'Water-repellent treatment on windshields, visors, and exterior glass', price:25},
      {id:'heavymud',   name:'Heavy Mud / Trail Buildup',    desc:'Extra cleaning for heavy mud, clay, and trail grime on exterior surfaces', price:55},
      {id:'seatdeep',   name:'Seat Deep Clean',              desc:'Deep cleaning for seats and riding surfaces', price:45},
      {id:'storage',    name:'Storage Compartment Cleaning', desc:'Vacuum and wipe saddlebags, boxes, and accessible compartments', price:35},
      {id:'wheeldet',   name:'Wheel Detail',                 desc:'Deep wheel and rim cleaning on accessible surfaces', price:35},
      {id:'waterspot',  name:'Water Spot Treatment',         desc:'Light water spot removal on paint and exterior surfaces', price:35},
      {id:'saltwash',   name:'Salt Rinse / Marine Rinse',    desc:'Salt and mineral rinse for jet ski and marine-exposed exterior surfaces', price:35},
      {id:'trimprot',   name:'Plastic Trim Protection',      desc:'Clean and protect plastic trim, panels, and exterior plastics', price:35},
      {id:'lightdeg',   name:'Light Exterior Degreasing',    desc:'Light degrease of visible exterior surfaces. Detailing only — not engine service', price:45},
    ],`;

const FLEET_ADDONS = `    addons:[
      {id:'polymer',      name:'Polymer Sealant Upgrade',     desc:'Polymer sealant per unit for added paint protection and gloss', price:25},
      {id:'trashcans',    name:'Trash Can Cleaning',          desc:'$25 per can at service location or fleet estimate', price:25},
      {id:'disinfect',    name:'High-Touch Sanitizing',       desc:'Wheel, controls, handles, seats, and high-contact surfaces per unit', price:20},
      {id:'biohazard',    name:'Biohazard Cleaning',          desc:'Bodily fluids or severe contamination per unit. Individual estimate required', price:115},
      {id:'odor',         name:'Fleet Odor Treatment',        desc:'Interior odor treatment per unit. Severe odor requires individual estimate', price:99},
      {id:'heavymud',     name:'Heavy Mud / Worksite Soil',   desc:'Extra cleaning for construction, trail, farm, or worksite grime per unit', price:65},
    ]`;

function replaceAddonsBlock(html, category, replacement) {
  const catRe = new RegExp(
    `${category}:\\s*\\{[\\s\\S]*?    addons:\\[[\\s\\S]*?    \\],`,
    "m",
  );
  if (!catRe.test(html)) {
    throw new Error(`Could not find ${category} addons block`);
  }
  return html.replace(catRe, (match) => {
    const head = match.slice(0, match.indexOf("    addons:["));
    return head + replacement;
  });
}

function replaceFleetAddons(html, replacement) {
  const fleetRe = /fleet:\s*\{[\s\S]*?    addons:\[[\s\S]*?\n    \]/m;
  if (!fleetRe.test(html)) {
    throw new Error("Could not find fleet addons block");
  }
  return html.replace(fleetRe, (match) => {
    const head = match.slice(0, match.indexOf("    addons:["));
    return head + replacement;
  });
}

for (const file of HTML_FILES) {
  const p = path.join(root, file);
  let html = fs.readFileSync(p, "utf8");
  html = replaceAddonsBlock(html, "cars", CARS_ADDONS);
  html = replaceAddonsBlock(html, "boats", BOATS_ADDONS);
  html = replaceAddonsBlock(html, "rvs", RVS_ADDONS);
  html = replaceAddonsBlock(html, "powersports", POWERSPORTS_ADDONS);
  html = replaceFleetAddons(html, FLEET_ADDONS);
  fs.writeFileSync(p, html);
  console.log("patched catalog", file);
}

// Package prices are owned by booking-price-catalog.js. This legacy add-on
// patcher must never replace server tiers; use apply-package-price-change.mjs
// --sync-only after changing the authoritative catalog.
console.log("server package catalog left unchanged (authoritative)");
