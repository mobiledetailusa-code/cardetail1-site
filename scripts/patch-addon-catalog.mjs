/**
 * Sync add-on catalog across booking pages + server pricing catalog.
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
      {id:'pethair',    scope:'int', name:'Pet Hair Removal',          icon:'🐾',  desc:'Deep removal of embedded pet hair from seats, carpets, mats, and trunk. Heavy buildup may require estimate', price:95},
      {id:'superint',   scope:'int', name:'Super Interior Upgrade',    icon:'💎',  desc:'Extra shampoo passes, hand-steam on panels, door pockets, and cargo areas for interior-included packages', price:125},
      {id:'odor',       scope:'int', name:'Odor Treatment & Sanitize', icon:'🌫️',  desc:'Odor treatment for smoke, food, pet, and general interior smells. Severe odor, mold, urine, biohazard, or contamination may require estimate confirmation', price:90},
      {id:'mold',       scope:'int', name:'Mold Treatment',            icon:'🦠',  desc:'Targeted mold treatment for affected interior areas. Requires inspection and may require estimate confirmation. Starting at $149 — final price depends on severity', price:149},
      {id:'sanitize',   scope:'int', name:'Interior Sanitizing',       icon:'🛡️',  desc:'Interior surface sanitizing for high-touch areas after cleaning — steering wheel, controls, handles, seats, belts, and contact points', price:65},
      {id:'biohazard',  scope:'int', name:'Biohazard Cleaning',        icon:'☣️',  desc:'Bodily fluids, blood, vomit, waste, or severe contamination. Requires estimate confirmation before service', price:115},
      {id:'engine',     scope:'ext', name:'Engine Bay Top Clean',      icon:'🧼',  desc:'Top-view engine bay cleaning for visible surfaces and covers only. Not mechanical service, repair, or fluid work', price:45},
      {id:'floormats',  scope:'int', name:'Floor Mat Deep Clean',      icon:'🧽',  desc:'Deep shampoo and scrub of rubber or fabric floor mats. $20 each — set the quantity of mats', price:20, qty:true},
      {id:'rainx',      scope:'ext', name:'Rain-X Glass Treatment',    icon:'💧',  desc:'Water-repellent Rain-X treatment on windshield and front glass for improved wet-weather visibility', price:25},
      {id:'polymer',    scope:'ext', name:'Polymer Paint Sealant',     icon:'🛡️',  desc:'Hand-applied polymer sealant for paint protection and enhanced gloss. Lasts 3–6 months', price:25},
      {id:'wax1yr',     scope:'ext', name:'1-Year Carnauba Wax',       icon:'🥇',  desc:'Premium long-lasting carnauba wax. Superior gloss and up to 12 months of paint protection', price:75},
      {id:'claybar',    scope:'ext', name:'Clay Bar Treatment',        icon:'🧲',  desc:'Removes embedded contaminants, industrial fallout, and rail dust for a smooth, clean paint surface', price:45},
      {id:'headlight',  scope:'ext', name:'Headlight Restoration',     icon:'💡',  desc:'Clean, polish, and seal foggy or yellowed headlights to restore clarity (per pair). Cosmetic detailing only', price:90},
      {id:'babyseat',   scope:'int', name:'Baby / Car Seat Cleaning',  icon:'👶',  desc:'Clean and sanitize a child car seat — straps, padding, and buckle. $20 each — set the quantity', price:20, qty:true},
      {id:'stroller',   scope:'int', name:'Baby Stroller Cleaning',    icon:'🍼',  desc:'Wash and sanitize a baby stroller — fabric, frame, and wheels. $20 each — set the quantity', price:20, qty:true},
      {id:'trashcans',  scope:'any', name:'Trash Can Cleaning',        icon:'🗑️',  desc:'Residential trash can cleaning at the service location. $25 each — set the quantity. Biohazard requires estimate', price:25, qty:true},
    ],`;

const BOATS_ADDONS = `    addons:[
      {id:'rainx',      name:'Rain-X Glass Treatment',        icon:'💧', desc:'Water-repellent treatment for marine windshields and glass surfaces', price:25},
      {id:'polymer',    name:'Polymer Hull Sealant',           icon:'🛡️', desc:'Polymer sealant on hull exterior for enhanced protection and gloss', price:25},
      {id:'wax1yr',     name:'1-Year Marine Carnauba Wax',     icon:'🥇', desc:'Premium carnauba wax for marine gel coat — up to 12 months protection', price:75},
      {id:'chrome',     name:'Chrome / Stainless Polish',      icon:'✨', desc:'Accessible chrome, stainless rails, cleats, and brightwork polished on exterior surfaces', price:85},
      {id:'odor',       name:'Odor Treatment & Sanitize',     icon:'🌫️', desc:'Odor treatment for smoke, food, pet, and general cabin smells. Severe odor, mold, urine, biohazard, or contamination may require estimate confirmation', price:90},
      {id:'mold',       name:'Mold Treatment',                icon:'🦠', desc:'Targeted mold treatment for affected cabin areas. Requires inspection and may require estimate confirmation. Starting at $149 — final price depends on severity', price:149},
      {id:'sanitize',   name:'Interior Sanitizing',           icon:'🛡️', desc:'Cabin surface sanitizing for high-touch areas after cleaning', price:65},
      {id:'biohazard',  name:'Biohazard Cleaning',             icon:'☣️', desc:'Bodily fluids or severe contamination. Requires estimate confirmation before service', price:115},
      {id:'trashcans',  name:'Trash Can Cleaning',             icon:'🗑️', desc:'Trash can cleaning at marina, storage yard, or home location — $25 per can', price:25, qty:true},
    ],`;

const RVS_ADDONS = `    addons:[
      {id:'polymer',    scope:'ext', name:'Polymer Sealant Upgrade',     icon:'🛡️', desc:'Polymer sealant on RV exterior for added protection and gloss. Excellent for fiberglass', price:25},
      {id:'wax1yr',     scope:'ext', name:'1-Year Carnauba Wax',         icon:'🥇', desc:'Premium carnauba wax on RV exterior. Up to 12 months UV and weather protection', price:75},
      {id:'rainx',      scope:'ext', name:'Rain-X Windshield Treatment', icon:'💧', desc:'Water-repellent Rain-X on RV windshield and front glass', price:25},
      {id:'biohazard',  scope:'int', name:'Biohazard Cleaning',          icon:'☣️', desc:'Bodily fluids, waste, or severe contamination. Requires estimate confirmation before service', price:115},
      {id:'mold',       scope:'int', name:'Mold Treatment',              icon:'🦠', desc:'Targeted mold treatment for affected interior areas. Requires inspection and may require estimate confirmation. Starting at $149 — final price depends on severity', price:149},
      {id:'sanitize',   scope:'int', name:'Interior Sanitizing',         icon:'🛡️', desc:'Interior surface sanitizing for high-touch areas after cleaning', price:65},
      {id:'awning',     scope:'ext', name:'Awning Cleaning',             icon:'⛱️', desc:'Awning fabric and surface cleaning. Does not include repair, replacement, motorized mechanism service, or re-tensioning', price:50, qty:true},
      {id:'roof',       scope:'ext', name:'Roof Surface Cleaning',       icon:'🏠', desc:'Exterior roof surface cleaning for RVs and trailers. Does not include roof repair, resealing, leak inspection, or mechanical work', price:50, qty:true},
      {id:'capfront',   scope:'ext', name:'Front Cap Deep Clean',        icon:'🧼', desc:'Bugs, road grime, black streaks, and front cap buildup on accessible exterior surfaces', price:149},
      {id:'pethair',    scope:'int', name:'Pet Hair Removal',            icon:'🐾', desc:'Pet hair removal from RV seats, rugs, cushions, and living areas', price:95},
      {id:'odor',       scope:'int', name:'Odor Treatment & Sanitize',   icon:'🌫️', desc:'Odor treatment for smoke, food, pet, and general interior smells. Severe odor, mold, urine, biohazard, or contamination may require estimate confirmation', price:90},
      {id:'trashcans',  scope:'any', name:'Trash Can Cleaning',          icon:'🗑️', desc:'$25 per can at RV park, campground, storage, or home', price:25, qty:true},
    ],`;

const POWERSPORTS_ADDONS = `    addons:[
      {id:'polymer',    name:'Polymer Sealant',             icon:'🛡️', desc:'Polymer paint and plastic sealant for enhanced protection and gloss', price:25},
      {id:'wax1yr',     name:'1-Year Carnauba Wax',         icon:'🥇', desc:'Premium carnauba wax for enhanced gloss and paint protection', price:75},
      {id:'rainx',      name:'Rain-X Windshield / Visor',   icon:'💧', desc:'Water-repellent treatment on windshields, visors, and exterior glass', price:25},
      {id:'heavymud',   name:'Heavy Mud / Trail Buildup',   icon:'🧼', desc:'Extra cleaning for heavy mud, clay, trail buildup, or off-road grime on exterior surfaces', price:55},
      {id:'seatdeep',   name:'Seat Deep Clean',             icon:'🪑', desc:'Deep cleaning for seats and riding surfaces', price:45},
      {id:'storage',    name:'Storage Compartment Cleaning',icon:'🧰', desc:'Vacuum and wipe storage boxes, saddlebags, and accessible compartments', price:35},
      {id:'wheeldet',   name:'Wheel Detail',                icon:'🛞', desc:'Deep wheel and rim cleaning on accessible surfaces', price:35},
      {id:'waterspot',  name:'Water Spot Treatment',        icon:'💧', desc:'Light water spot removal on paint and exterior surfaces', price:35},
      {id:'saltwash',   name:'Salt Rinse / Marine Rinse',   icon:'🌊', desc:'Salt and mineral rinse for jet ski and marine-exposed exterior surfaces', price:35},
      {id:'trimprot',   name:'Plastic Trim Protection',     icon:'✨', desc:'Clean and protect plastic trim, body panels, and accessible exterior plastics', price:35},
      {id:'lightdeg',   name:'Light Exterior Degreasing',   icon:'🧼', desc:'Light degreasing of visible exterior surfaces. Not engine or mechanical service', price:45},
    ],`;

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

for (const file of HTML_FILES) {
  const p = path.join(root, file);
  let html = fs.readFileSync(p, "utf8");
  html = replaceAddonsBlock(html, "cars", CARS_ADDONS);
  html = replaceAddonsBlock(html, "boats", BOATS_ADDONS);
  html = replaceAddonsBlock(html, "rvs", RVS_ADDONS);
  html = replaceAddonsBlock(html, "powersports", POWERSPORTS_ADDONS);
  fs.writeFileSync(p, html);
  console.log("patched", file);
}

const serverPath = path.join(root, "netlify/lib/booking-price-catalog.js");
let server = fs.readFileSync(serverPath, "utf8");

server = server.replace(
  /cars:\s*\{[\s\S]*?addons:\s*\[[\s\S]*?\],/m,
  `cars: {
    tiers: {
      small: { label: 'Small Car', maint: 175, interior: 225, full: 285, refresh: 375, premium: 450 },
      suv2: { label: 'SUV 2-Row', maint: 215, interior: 250, full: 305, refresh: 425, premium: 550 },
      suv3: { label: 'SUV 3-Row', maint: 250, interior: 275, full: 315, refresh: 475, premium: 635 },
      truck: { label: 'Truck', maint: 250, interior: 275, full: 325, refresh: 465, premium: 615 },
    },
    addons: [
      { id: 'pethair', price: 95 }, { id: 'superint', price: 125 }, { id: 'odor', price: 90 },
      { id: 'mold', price: 149 }, { id: 'sanitize', price: 65 },
      { id: 'biohazard', price: 115 }, { id: 'engine', price: 45 }, { id: 'floormats', price: 20, qty: true },
      { id: 'rainx', price: 25 }, { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 },
      { id: 'claybar', price: 45 }, { id: 'headlight', price: 90 }, { id: 'babyseat', price: 20, qty: true },
      { id: 'stroller', price: 20, qty: true }, { id: 'trashcans', price: 25, qty: true },
    ],`,
);

server = server.replace(
  /boats:\s*\{[\s\S]*?addons:\s*\[[\s\S]*?\],/m,
  `boats: {
    tiers: {
      under20: { label: 'Under 20 ft', maint: 266, essential: 399, full: 599, premium: 933 },
      '20to25': { label: '20–25 ft', maint: 367, essential: 533, full: 800, premium: 1200 },
      '26to30': { label: '26–30 ft', maint: 466, essential: 666, full: 1000, premium: 1467 },
      over30: { label: '30+ ft', maint: 599, essential: 866, full: 1334, premium: 2001 },
    },
    addons: [
      { id: 'rainx', price: 25 }, { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 },
      { id: 'chrome', price: 85 }, { id: 'odor', price: 90 }, { id: 'mold', price: 149 },
      { id: 'sanitize', price: 65 }, { id: 'biohazard', price: 115 },
      { id: 'trashcans', price: 25, qty: true },
    ],`,
);

server = server.replace(
  /rvs:\s*\{[\s\S]*?addons:\s*\[[\s\S]*?\],/m,
  `rvs: {
    tiers: {
      travel: { label: 'Travel Trailer', exterior: 466, interior: 399, full: 733, premium: 1133 },
      fifthwheel: { label: 'Fifth Wheel', exterior: 599, interior: 506, full: 933, premium: 1334 },
      classC: { label: 'Class C', exterior: 666, interior: 573, full: 1067, premium: 1534 },
      classA: { label: 'Class A', exterior: 866, interior: 733, full: 1334, premium: 1934 },
    },
    addons: [
      { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 }, { id: 'rainx', price: 25 },
      { id: 'biohazard', price: 115 }, { id: 'mold', price: 149 }, { id: 'sanitize', price: 65 },
      { id: 'awning', price: 50, qty: true }, { id: 'roof', price: 50, qty: true },
      { id: 'capfront', price: 149 }, { id: 'pethair', price: 95 }, { id: 'odor', price: 90 },
      { id: 'trashcans', price: 25, qty: true },
    ],`,
);

server = server.replace(
  /powersports:\s*\{[\s\S]*?addons:\s*\[[\s\S]*?\],/m,
  `powersports: {
    tiers: {
      motorcycle: { label: 'Motorcycle', wash: 119, essential: 186, full: 266, premium: 372 },
      atv: { label: 'ATV', wash: 119, essential: 186, full: 266, premium: 372 },
      utv: { label: 'UTV / Side-by-Side', wash: 146, essential: 226, full: 332, premium: 466 },
      jetski: { label: 'Jet Ski / PWC', wash: 119, essential: 186, full: 266, premium: 367 },
    },
    addons: [
      { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 }, { id: 'rainx', price: 25 },
      { id: 'heavymud', price: 55 }, { id: 'seatdeep', price: 45 }, { id: 'storage', price: 35 },
      { id: 'wheeldet', price: 35 }, { id: 'waterspot', price: 35 }, { id: 'saltwash', price: 35 },
      { id: 'trimprot', price: 35 }, { id: 'lightdeg', price: 45 },
    ],`,
);

fs.writeFileSync(serverPath, server);
console.log("patched server catalog");
