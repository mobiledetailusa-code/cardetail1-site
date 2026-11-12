#!/usr/bin/env node
/**
 * Dedicated Bergen County city landings (not full booking clones).
 *
 * The page copy below is the reviewed content of the live pages. Every price in it
 * is a {{token}} resolved at generation time from the canonical server catalog
 * (netlify/lib/booking-price-catalog.js PRICING). Presentation-only fields —
 * package names and durations — come from the homepage catalog (index.html
 * PRICING). Before writing anything, the index.html mirror is checked against the
 * canonical values used here; any divergence aborts. This file holds no price
 * table of its own and the generated pages are never a pricing authority.
 *
 *   node scripts/generate-bergen-city-pages.mjs              # write pages in place
 *   node scripts/generate-bergen-city-pages.mjs --out <dir>  # write into another dir
 *   node scripts/generate-bergen-city-pages.mjs --check      # exit 1 if a page drifts
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : root;

const ORIGIN = 'https://cardetail1.com';
const PHONE = '+15513893986';
const PHONE_DISPLAY = '(551) 389-3986';
const GBP = 'https://g.page/r/CTJwfJerrQeCEAI/review';

// ── Prices: canonical server catalog (financial authority) ─────────────────
const require = createRequire(import.meta.url);
const CANON = require(path.join(root, 'netlify/lib/booking-price-catalog.js')).PRICING;
const CANON_ADDON = Object.fromEntries(CANON.cars.addons.map((a) => [a.id, a.price]));

// ── Presentation: homepage catalog (names, durations) ──────────────────────
function loadHomepagePricing() {
  const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('const CAR_INTERIOR_SERVICE_ITEMS');
  const b = src.indexOf('window.PRICING = PRICING;');
  if (a < 0 || b < a) throw new Error('index.html PRICING block not found');
  const ctx = {};
  vm.runInNewContext(`${src.slice(a, b)}\n;globalThis.__PRICING = PRICING;`, ctx);
  return ctx.__PRICING;
}
const MIRROR = loadHomepagePricing();
const PKG = Object.fromEntries(MIRROR.cars.packages.map((p) => [p.id, p]));
const MIRROR_ADDON = Object.fromEntries(MIRROR.cars.addons.map((a) => [a.id, a.price]));

function need(value, label) {
  if (value === undefined || value === null || value === '') throw new Error(`catalog value missing: ${label}`);
  return value;
}
const money = (n) => `$${n}`;
const hours = (dur) => String(dur).replace(/h$/, ' hrs');

/** Canonical value for a price token key; the mirror must agree or generation aborts. */
const usedPriceKeys = new Set();
function canonicalPrice(key) {
  const parts = key.split('.');
  let canon;
  let mirror;
  if (parts[0] === 'addon') {
    canon = CANON_ADDON[parts[1]];
    mirror = MIRROR_ADDON[parts[1]];
  } else if (parts[0] === 'fleet') {
    canon = CANON.fleet.tiers[parts[1]] && CANON.fleet.tiers[parts[1]][parts[2]];
    mirror = MIRROR.fleet.tiers[parts[1]] && MIRROR.fleet.tiers[parts[1]][parts[2]];
  } else {
    const [pkgId, tier] = parts;
    canon = CANON.cars.tiers[tier] && CANON.cars.tiers[tier][pkgId];
    mirror = MIRROR.cars.tiers[tier] && MIRROR.cars.tiers[tier][pkgId];
  }
  need(canon, `canonical ${key}`);
  if (mirror !== canon) {
    throw new Error(`price mirror drift: index.html ${key}=${mirror} but booking-price-catalog ${key}=${canon}`);
  }
  usedPriceKeys.add(key);
  return canon;
}

/** {{interior.small}} → "$200", {{addon.pethair}} → "$95", {{name.refresh}} → catalog name. */
function resolveTokens(text) {
  return text.replace(/\{\{([a-z0-9_.]+)\}\}/gi, (_m, key) => {
    if (key.startsWith('name.')) return need(PKG[key.slice(5)] && PKG[key.slice(5)].name, key);
    return money(canonicalPrice(key));
  });
}

const PACKAGES = [
  {
    id: 'interior',
    tag: 'Vacuum, shampoo, steam, and wipe-down for seats, carpets, and dash.',
    note: 'Sedans from {{interior.small}} · SUVs from {{interior.suv2}} · trucks from {{interior.truck}}',
  },
  {
    id: 'full',
    tag: 'Most booked — interior detail plus exterior wash, protection, and light paint cleaning.',
    note: 'Sedans from {{full.small}} · SUVs from {{full.suv2}} · 3-row from {{full.suv3}}',
    popular: true,
  },
  {
    id: 'refresh',
    tag: 'Clay bar, polish, sealant, wheels, glass, and gloss restoration — not a basic wash.',
    note: 'Premium exterior · sized by vehicle',
  },
].map((p) => ({
  ...p,
  name: need(PKG[p.id] && PKG[p.id].name, `${p.id}.name`),
  price: canonicalPrice(`${p.id}.small`),
  time: hours(need(PKG[p.id] && PKG[p.id].dur, `${p.id}.dur`)),
  note: resolveTokens(p.note),
}));

/** First-party quotes copied verbatim from the public Google listing. */
const REVIEWS = [
  {
    name: 'John Daquila',
    text: "White BMW 760 ! First time booking and I couldn't be happier! Car is showroom new inside and out. I have a vinyl wrap on my exterior and it isn't the easiest to work with but not for Magno! He did and incredible job and will absolutely be booking again in the near future! 10/10 experience would recommend to everyone",
  },
  {
    name: 'Gerard Baltazar',
    text: "Truly impressive work! They stayed extra long to do a thorough job! I've never experienced such excellent skill and dedication for detailing! This is my family commuter car, and we have a dog! They made my car look and feel like new!",
  },
];

/** Reviewed page copy. Prices and the $335 package name are {{tokens}} (see resolveTokens). */
const CITIES = [
  {
    "key": "palisades-park",
    "city": "Palisades Park",
    "zip": "07650",
    "lat": 40.8482,
    "lng": -73.9976,
    "title": "Mobile Car Detailing in Palisades Park, NJ | Cardetail1",
    "h1": "Mobile Car Detailing in Palisades Park, NJ",
    "description": "Mobile car detailing in Palisades Park, NJ — our home base. Interior from {{interior.small}}, full detail from {{full.small}} at your driveway. We bring water and power. Book online.",
    "nearby": [
      "fort-lee",
      "englewood",
      "teaneck",
      "hackensack",
      "edgewater"
    ],
    "faqs": [
      {
        "q": "Are you based in Palisades Park?",
        "a": "Yes. Cardetail1 (Detailing Zone L.L.C.) is based in Palisades Park, ZIP 07650. Jobs here are on our core route with no travel fee on standard Bergen County pricing."
      },
      {
        "q": "Do you work on Broad Avenue and side-street driveways?",
        "a": "Yes, when there is safe staging space. We bring our own water and power, so we do not need a hose bib. Tell us about tight driveways, street parking, or shared lots in the booking notes."
      },
      {
        "q": "How do I book a Palisades Park appointment?",
        "a": "Enter ZIP 07650, pick Interior Detail, Premium Full Detail, or {{name.refresh}}, and submit a request. No charge is collected at submission. We text or call to confirm the day."
      },
      {
        "q": "What are your hours in Palisades Park?",
        "a": "Mobile appointments run Monday–Saturday · By Appointment Only. Call or text (551) 389-3986 if you need to check a specific day."
      }
    ],
    "paragraphs": [
      "Cardetail1 is based in Palisades Park, ZIP 07650 — not a shop you drop the car at. We load water, power, and professional chemicals in the van and detail in your driveway, parking pad, or an approved lot. Palisades Park is the shortest hop on our Bergen County route, so standard interior, full, and exterior packages here use the same core NJ pricing you see on the homepage: Interior Detail from {{interior.small}} Premium Full Detail from {{full.small}} for sedans, and {{name.refresh}} from {{refresh.small}}.",
      "Broad Avenue and the residential blocks off it mix tight driveways, street parking, and small commercial lots. That is normal for this town, and it is why we ask for access notes when you book: where the vehicle will sit, whether we can stage next to it, and whether a HOA or landlord has vendor rules. We do not need your outdoor faucet. Same-week requests are easiest here because we are already in town.",
      "Most Palisades Park jobs we price are daily drivers — sedans, two-row SUVs, and family crossovers that pick up GWB-adjacent film, winter salt, and interior wear from kids or pets. Interior Detail is the right call when the cabin is the problem. Premium Full Detail is the package most customers book when they want inside and out in one visit. Heavy pet hair, odor, or stained carpets are add-ons at booking, not surprises on the invoice.",
      "Interior Detail in the live catalog is deep vacuum (seats, floors, trunk), fabric shampoo, leather conditioning, steam on vents and panels, dash and door trim with UV protectant, and interior glass. It does not include an exterior wash. Premium Full Detail stacks that cabin work with a hand wash, clay decontamination, spray sealant, wheels, and exterior glass — that is why it is marked most booked. {{name.refresh}} is clay, chemical decon, a single-pass enhancement polish, sealant, wheel and lug detail, Rain-X, and tire dressing, with no interior. Signature Restoration (from {{premium.small}} sedan) is the ~3.5–4 hour inside-and-out path with single-pass correction, wheel and tire shine, plastic restoration, and the full interior list — not a ceramic-coating package.",
      "Booking uses the same homepage form: ZIP 07650 unlocks car packages, then vehicle size. Add-ons such as pet hair ({{addon.pethair}}), odor treatment ({{addon.odor}}), engine-bay top clean ({{addon.engine}}), and headlight restoration ({{addon.headlight}}) only apply if you select them. No charge is collected when you submit. We review access and contact you about the day (Monday–Saturday · By Appointment Only). Call (551) 389-3986. Neighboring towns from this base include Fort Lee, Edgewater, Englewood, Teaneck, and Hackensack — use those pages if the car sits there instead."
    ]
  },
  {
    "key": "fort-lee",
    "city": "Fort Lee",
    "zip": "07024",
    "lat": 40.8509,
    "lng": -73.9701,
    "title": "Mobile Car Detailing in Fort Lee, NJ | Cardetail1",
    "h1": "Mobile Car Detailing in Fort Lee, NJ",
    "description": "Mobile car detailing in Fort Lee, NJ (07024). Interior, full, and exterior packages at your driveway or approved garage. Based in Palisades Park. Book online.",
    "nearby": [
      "palisades-park",
      "edgewater",
      "englewood",
      "teaneck",
      "hackensack"
    ],
    "faqs": [
      {
        "q": "Do you detail in Fort Lee high-rises and parking garages?",
        "a": "When building rules and space allow. We need room to stage equipment and a vehicle we can work around for several hours. Add garage, visitor, or loading-dock notes in the booking form so we can confirm access before we roll."
      },
      {
        "q": "Is there a travel fee for ZIP 07024?",
        "a": "Fort Lee is on our Bergen County core route from Palisades Park. Standard jobs in 07024 use core NJ pricing with no separate travel fee on the quote."
      },
      {
        "q": "Can you handle brake dust and GWB road film?",
        "a": "Yes. {{name.refresh}} (from {{refresh.small}}) and Premium Full Detail both include exterior decontamination. Commuter film on light-colored paint is a common Fort Lee request."
      },
      {
        "q": "How do I book in Fort Lee?",
        "a": "Enter ZIP 07024 on this page or the homepage, choose your package, and submit. Payment is not collected when you send the request."
      }
    ],
    "paragraphs": [
      "Fort Lee (ZIP 07024) sits next to our Palisades Park base, on the New Jersey side of the George Washington Bridge. Cardetail1 comes to houses, townhome lots, and approved garage or visitor spots — we bring water and power, so we are not asking the building for a hose. Core Bergen pricing applies: Interior Detail from {{interior.small}} Premium Full Detail from {{full.small}} for sedans, {{name.refresh}} from {{refresh.small}}.",
      "Bridge and Route 9W commuting leaves a specific kind of mess: brake dust on wheels, film on white and silver paint, and interiors that get used hard on the NYC trip. Exterior-only work is the {{name.refresh}} package, not a $20 wash. If the cabin needs shampoo and steam as well, book Premium Full Detail. Pet hair and odor are listed add-ons so the quote stays honest.",
      "High-rise and garage jobs need a clear access plan. We cannot work in a stall that has no staging room or that forbids vendor equipment. Put the building name, floor or lot, and any COI request in the notes. Driveway jobs in the residential blocks toward Palisades Park and Leonia are simpler — same process as the home-base town, a few minutes on local roads.",
      "What you actually get is the homepage spec, not a lighter “Fort Lee special.” Interior Detail: vacuum, shampoo, steam, UV on plastics, interior glass (~1.5–2 hrs). Premium Full Detail: that interior plus hand wash, clay, sealant, and wheels (SUVs from {{full.suv2}}, 3-row from {{full.suv3}}, ~2.5–3 hrs). {{name.refresh}} from {{refresh.small}} is the paint-enhancement path (~3.5–4 hrs). Garage jobs run longer if we have to work around pillars and low clearance.",
      "Enter ZIP 07024 to load pricing, submit the request, and wait for confirmation — no charge at request. Hours Monday–Saturday · By Appointment Only. Call (551) 389-3986 if the building needs a certificate of insurance before we are allowed in. Nearby pages: Palisades Park, Edgewater, Englewood, Teaneck."
    ]
  },
  {
    "key": "paramus",
    "city": "Paramus",
    "zip": "07652",
    "lat": 40.9445,
    "lng": -74.0754,
    "title": "Mobile Car Detailing in Paramus, NJ | Cardetail1",
    "h1": "Mobile Car Detailing in Paramus, NJ",
    "description": "Mobile car detailing in Paramus, NJ (07652). Interior from {{interior.small}}, full detail from {{full.small}} at your driveway. Bergen County core route from Palisades Park. Book online.",
    "nearby": [
      "ridgewood",
      "hackensack",
      "teaneck",
      "englewood",
      "palisades-park"
    ],
    "faqs": [
      {
        "q": "Do you come to Paramus driveways off Route 4 and Route 17?",
        "a": "Yes. Paramus ZIPs 07652 and 07653 are on the Bergen County core route. We detail at the house or office lot when there is safe space to park the van and work around the vehicle."
      },
      {
        "q": "What package fits a family SUV after mall and highway use?",
        "a": "Premium Full Detail is the most booked inside-and-out package (SUVs from {{full.suv2}}, 3-row from {{full.suv3}}). Interior-only starts at {{interior.suv2}} for two-row SUVs. {{name.refresh}} from {{refresh.small}} if the paint and wheels are the issue."
      },
      {
        "q": "Is Paramus a travel-fee ZIP?",
        "a": "No separate travel fee on standard core NJ pricing for 07652/07653. Enter the ZIP at booking to see the exact package total for your vehicle size."
      },
      {
        "q": "Can you do more than one vehicle in a Paramus driveway?",
        "a": "Yes. Use Book Multiple Vehicles on the homepage or add another vehicle in checkout. Same visit, same location."
      }
    ],
    "paragraphs": [
      "Paramus (07652 / 07653) is a Bergen County driveway stop on our Palisades Park route — larger suburban lots than the Gold Coast, which usually means easier staging for a full interior or exterior job. We still bring our own water and power. Pricing matches the homepage catalog: Interior Detail from {{interior.small}} (sedan), Premium Full Detail from {{full.small}} / {{full.suv2}} / {{full.suv3}} by size, {{name.refresh}} from {{refresh.small}}.",
      "Route 4, Route 17, and mall-area traffic put film on paint and brake dust on wheels. Family SUVs and 3-row vehicles are common here; those sizes have their own “from” prices on Premium Full Detail, not a one-size sedan rate. If the interior is the problem after kids, sports gear, or pets, start with Interior Detail and add pet hair or odor only if you need them.",
      "Office-park and dealership-adjacent lots are fine when management allows a vendor to occupy a stall for a few hours. Say so in the notes. We do not do a drive-through wash; {{name.refresh}} is clay, decontamination, and protection sized to the vehicle. Two or more cars in one driveway should use the multi-vehicle checkout so both vehicles share one visit.",
      "Package contents do not change because you are in Paramus. Interior Detail is vacuum, shampoo, steam, and interior glass. Premium Full Detail adds the exterior wash, clay, and sealant. {{name.refresh}} is the machine-polish and protection package without cabin work. Add-ons (pet hair {{addon.pethair}}, odor {{addon.odor}}, polymer sealant {{addon.polymer}}, 1-year carnauba {{addon.wax1yr}}) are optional lines at booking. Weather can delay exterior steps; we confirm the day after you request, Monday–Saturday · By Appointment Only.",
      "Enter ZIP 07652 or 07653 so the quote matches the house, not a neighboring town. Call (551) 389-3986. Nearby dedicated pages: Ridgewood, Hackensack, Teaneck, Palisades Park. Bergen County hub covers Glen Rock, Fair Lawn, and Saddle Brook without their own landing pages yet."
    ]
  },
  {
    "key": "hackensack",
    "city": "Hackensack",
    "zip": "07601",
    "lat": 40.8859,
    "lng": -74.0435,
    "title": "Mobile Car Detailing in Hackensack, NJ | Cardetail1",
    "h1": "Mobile Car Detailing in Hackensack, NJ",
    "description": "Mobile car detailing in Hackensack, NJ (07601). Interior, full, and exterior packages at home or office lots. Bergen County core from Palisades Park. Book online.",
    "nearby": [
      "teaneck",
      "paramus",
      "palisades-park",
      "englewood",
      "ridgewood"
    ],
    "faqs": [
      {
        "q": "Can you detail at a Hackensack office or medical-area lot?",
        "a": "Yes, when the lot allows a vendor vehicle and there is space to work. Put the building, suite, and parking instructions in the booking notes. We bring water and power."
      },
      {
        "q": "Do you handle more than one work vehicle?",
        "a": "Yes. Multi-vehicle checkout is on the homepage, and fleet packages are listed on /fleet-services for vans and trucks on a recurring plan."
      },
      {
        "q": "What does interior detailing cost in Hackensack?",
        "a": "Interior Detail starts at {{interior.small}} for sedans, {{interior.suv2}} for two-row SUVs, and {{interior.truck}} for trucks. Final price follows vehicle size, condition, and add-ons after you enter ZIP 07601."
      },
      {
        "q": "Is 07601 in your free-travel zone?",
        "a": "Hackensack is Bergen County core from Palisades Park. Standard jobs use core NJ pricing with no separate travel fee on the quote."
      }
    ],
    "paragraphs": [
      "Hackensack (07601) is the Bergen County seat and a regular stop from our Palisades Park base. We detail at residential driveways and at office or medical-area lots when access is legal and there is room to stage. Water and power come with us. Packages and “from” prices are the same catalog as the homepage: Interior Detail from {{interior.small}} Premium Full Detail from {{full.small}} for sedans, {{name.refresh}} from {{refresh.small}}.",
      "The mix here is daily drivers plus vehicles that sit in work lots. Interior Detail is the right product when the cabin is dusty, stained, or overdue for shampoo. Premium Full Detail covers inside and out in one appointment. If you manage more than one van or truck, use the fleet page for per-unit programs rather than stacking consumer packages blindly — fleet maintenance wash starts at {{fleet.vehicle.maint}} per unit on the fleet catalog, which is a different product than a {{interior.small}} interior on a personal sedan.",
      "Street parking and garage-only buildings need the same honesty as Fort Lee: we have to stand next to the car with tanks and hoses. If that is not allowed, say so before we confirm the day. South Hackensack (07606) and Maywood (07607) book the same way — enter the actual ZIP so pricing and routing stay correct. County-complex and hospital-area lots often need a visit from security; put that in the notes.",
      "On the car catalog, Interior Detail includes trunk vacuum and interior glass; Premium Full Detail adds clay and a spray sealant on the paint. {{name.refresh}} from {{refresh.small}} is paint enhancement, not a rinse. Truck interior starts at {{interior.truck}}. Add-ons for odor, mold (from {{addon.mold}}), and biohazard are estimate-gated when the job is severe. Hours Monday–Saturday · By Appointment Only. No charge when you submit ZIP 07601 on the booking form.",
      "Call (551) 389-3986. Nearby pages: Teaneck, Paramus, Palisades Park, Englewood, Ridgewood. Quotes on this page are copied from the public Google listing, not invented testimonials."
    ]
  },
  {
    "key": "englewood",
    "city": "Englewood",
    "zip": "07631",
    "lat": 40.8929,
    "lng": -73.9726,
    "title": "Mobile Car Detailing in Englewood, NJ | Cardetail1",
    "h1": "Mobile Car Detailing in Englewood, NJ",
    "description": "Mobile car detailing in Englewood, NJ (07631). Driveway interior, full, and exterior detail from our Palisades Park base. From {{interior.small}} interior / {{full.small}} full. Book online.",
    "nearby": [
      "palisades-park",
      "fort-lee",
      "teaneck",
      "hackensack",
      "ridgewood"
    ],
    "faqs": [
      {
        "q": "Do you service Englewood Cliffs as well as Englewood?",
        "a": "Yes. Enter the ZIP you actually park in (07631 Englewood or 07632 Englewood Cliffs) so routing and the quote stay correct. Both are Bergen County core from Palisades Park."
      },
      {
        "q": "Tree pollen and water spots — which package?",
        "a": "{{name.refresh}} (from {{refresh.small}}) is the exterior-only path for film, pollen, and decontamination. Add Premium Full Detail when the interior needs shampoo and steam too."
      },
      {
        "q": "Can you work on a tree-lined driveway?",
        "a": "Yes, as long as we can park beside the vehicle and run equipment safely. Wet weather can delay exterior steps; we confirm the day after you request."
      },
      {
        "q": "How far are you from Englewood?",
        "a": "Palisades Park is the next town south. Englewood jobs are short-run core route appointments, not long-distance quotes."
      }
    ],
    "paragraphs": [
      "Englewood (07631) is a short run north of Palisades Park. Cardetail1 details in residential driveways along the tree-lined streets and in approved lots — we bring water and power, and we price from the same Bergen County catalog: Interior Detail from {{interior.small}} Premium Full Detail from {{full.small}} for sedans (SUVs from {{full.suv2}}), {{name.refresh}} from {{refresh.small}}.",
      "Pollen, shade-tree sap, and water spots show up on paint here more than beach salt. That is an exterior decontamination job, not a rinse. Interior work is still the Interior Detail package: vacuum, shampoo, steam, glass. Englewood Cliffs (07632) uses the same process; enter that ZIP if the car sits there so the quote is tied to the right block.",
      "Larger properties usually make staging easier than Fort Lee high-rises. If a HOA or gated driveway needs a vendor code, put it in the notes so we are not stuck at the curb. Luxury SUVs and sedans take the same packages; size and condition set the number, not a separate Englewood surcharge. Signature Restoration is the ~3.5–4 hour option when you want single-pass correction, wheel and tire shine, and plastic restoration on the paint plus a full interior.",
      "What Interior Detail includes in Englewood is identical to Palisades Park: seats, carpets, trunk, steam, UV on plastics. Premium Full Detail adds the exterior wash and clay. {{name.refresh}} from {{refresh.small}} is clay, polish, sealant, Rain-X, and wheels. Wet weather pauses exterior work; we do not pretend a detail can be finished in a downpour. Hours Monday–Saturday · By Appointment Only. Request with ZIP 07631; no payment at submission.",
      "Call (551) 389-3986 for gates and HOA questions. Nearby: Palisades Park, Fort Lee, Teaneck, Hackensack. Tenafly and Alpine remain on the Bergen County hub list until they have their own pages — enter those ZIPs on the homepage if that is where the car is."
    ]
  },
  {
    "key": "teaneck",
    "city": "Teaneck",
    "zip": "07666",
    "lat": 40.8976,
    "lng": -74.016,
    "title": "Mobile Car Detailing in Teaneck, NJ | Cardetail1",
    "h1": "Mobile Car Detailing in Teaneck, NJ",
    "description": "Mobile car detailing in Teaneck, NJ (07666). Interior, full, and exterior packages at your driveway. Pet-hair add-on available. Palisades Park base. Book online.",
    "nearby": [
      "hackensack",
      "englewood",
      "palisades-park",
      "paramus",
      "fort-lee"
    ],
    "faqs": [
      {
        "q": "Do you remove pet hair in Teaneck interiors?",
        "a": "Yes. Interior Detail covers vacuum, shampoo, and steam. Heavy pet hair is a {{addon.pethair}} add-on at booking when the coat is packed into fabric. Odor treatment is a separate add-on if you need it."
      },
      {
        "q": "Is ZIP 07666 a core Bergen ZIP?",
        "a": "Yes. Teaneck is between Englewood and Hackensack on our Palisades Park route. Standard jobs use core NJ pricing with no separate travel fee."
      },
      {
        "q": "Can you come while I am at work?",
        "a": "If someone 18+ can provide access, or the vehicle is in an open driveway we can legally work in. Put access instructions in the request. We confirm the appointment before we roll."
      },
      {
        "q": "What is the most booked package in towns like Teaneck?",
        "a": "Premium Full Detail — inside and out — is marked most booked on the homepage. SUVs from {{full.suv2}}, 3-row from {{full.suv3}}."
      }
    ],
    "paragraphs": [
      "Teaneck (07666) sits between Englewood and Hackensack, still on the Palisades Park core route. We detail in suburban driveways with our own water and power. Prices are the live catalog: Interior Detail from {{interior.small}} sedan / {{interior.suv2}} two-row SUV, Premium Full Detail from {{full.small}} / {{full.suv2}} / {{full.suv3}}, {{name.refresh}} from {{refresh.small}}.",
      "Family vehicles are the usual request: car seats, crumbs, and pet hair in the second row. Interior Detail is built for that cabin work. The pet-hair add-on exists because a household vacuum does not lift coat from honeycomb fabric — the before/after slider on the homepage is that job. Do not skip the add-on and expect packed-in coat to disappear inside the base interior price. Baby-seat cleaning is {{addon.babyseat}} per seat if you add it.",
      "Street-parked cars are possible when we can occupy the space legally for the duration (often 1.5–4 hours by package). If the township or a HOA limits that, use a driveway. We confirm access when we confirm the day. Someone 18+ needs to authorize the visit if you will not be home. Hours Monday–Saturday · By Appointment Only.",
      "Package scope matches the rest of Bergen County. Interior Detail: vacuum, shampoo, steam, interior glass, UV on plastics. Premium Full Detail adds exterior wash, clay, and sealant. {{name.refresh}} is the paint-enhancement package. Odor treatment ({{addon.odor}}) and Super Interior Upgrade ({{addon.superint}}) are opt-in when the cabin is beyond a standard shampoo. ZIP 07666 loads core NJ pricing with no separate travel fee on the standard quote.",
      "Book on this page or the homepage with ZIP 07666. Call (551) 389-3986. Nearby: Hackensack, Englewood, Palisades Park, Paramus, Fort Lee. Bergenfield and New Milford are on the county hub accordion until they have dedicated URLs — use the real ZIP so routing stays honest. We bring water and power to every Teaneck driveway job."
    ]
  },
  {
    "key": "ridgewood",
    "city": "Ridgewood",
    "zip": "07450",
    "lat": 40.9793,
    "lng": -74.1165,
    "title": "Mobile Car Detailing in Ridgewood, NJ | Cardetail1",
    "h1": "Mobile Car Detailing in Ridgewood, NJ",
    "description": "Mobile car detailing in Ridgewood, NJ (07450). Interior from {{interior.small}}, full detail from {{full.small}} at your driveway. Bergen County route from Palisades Park. Book online.",
    "nearby": [
      "paramus",
      "hackensack",
      "teaneck",
      "englewood",
      "palisades-park"
    ],
    "faqs": [
      {
        "q": "Is Ridgewood ZIP 07450 inside your Bergen coverage?",
        "a": "Yes. 07450 routes to our Bergen County hub from Palisades Park. Enter the ZIP at booking to load local package pricing."
      },
      {
        "q": "Do larger lots change the price?",
        "a": "No. Price follows vehicle size, condition, package, and add-ons — not lot size. Larger driveways just make staging easier."
      },
      {
        "q": "Can you detail two cars in one Ridgewood visit?",
        "a": "Yes. Use the multi-vehicle path on the homepage so both vehicles are on one request."
      },
      {
        "q": "Do you service Glen Rock or Fair Lawn from the same route?",
        "a": "Those Bergen towns are on the county hub. Enter the ZIP where the car will sit. Dedicated pages on this pass cover Ridgewood, Paramus, Hackensack, and the Palisades Park cluster."
      }
    ],
    "paragraphs": [
      "Ridgewood (07450) is northern Bergen County on our Palisades Park route. We come to the driveway with water and power. Package prices are not a special Ridgewood list — they are the same numbers on cardetail1.com: Interior Detail from {{interior.small}} Premium Full Detail from {{full.small}} for sedans, {{name.refresh}} from {{refresh.small}} sized up for SUVs and trucks at booking.",
      "Commuter vehicles and family SUVs pick up highway film and interior wear. Premium Full Detail is the inside-and-out appointment. If you only need the cabin, book Interior Detail. If the paint is dull from sitting under trees, {{name.refresh}} is the clay / polish / sealant path, not a hand wash sold as a detail. Two cars at the same house should go through multi-vehicle checkout so we route one visit.",
      "Lots here are often large enough for a van and a full-size SUV. That helps time-on-site; it does not change the catalog. Tell us about HOA gates or shared driveways in the notes. Hours remain Monday–Saturday · By Appointment Only. 07450 is in the Bergen hub ZIP map (074 prefix), not a long-distance quote.",
      "Interior Detail includes seats, carpets, trunk, steam, and interior glass. Premium Full Detail adds wash, clay, and sealant. {{name.refresh}} from {{refresh.small}} includes single-pass paint enhancement and Rain-X. Add-ons (pet hair, odor, polymer, 1-year wax) are the same dollars as Palisades Park. We do not invent a Ridgewood travel surcharge on standard core pricing — enter the ZIP so the form can show the live total.",
      "Submit ZIP 07450 or call (551) 389-3986. Nearby dedicated pages: Paramus, Hackensack, Teaneck, Palisades Park. Glen Rock and Fair Lawn stay on the New Jersey hub accordion for now; those links still work as in-county anchors until they get their own files. Request first, pay after service — same as every other Bergen page."
    ]
  },
  {
    "key": "edgewater",
    "city": "Edgewater",
    "zip": "07020",
    "lat": 40.827,
    "lng": -73.9757,
    "title": "Mobile Car Detailing in Edgewater, NJ | Cardetail1",
    "h1": "Mobile Car Detailing in Edgewater, NJ",
    "description": "Mobile car detailing in Edgewater, NJ (07020). Driveway and approved-garage interior, full, and exterior packages. Palisades Park base. Boats by marina access. Book online.",
    "nearby": [
      "fort-lee",
      "palisades-park",
      "englewood",
      "hackensack",
      "teaneck"
    ],
    "faqs": [
      {
        "q": "Can you work in Edgewater waterfront garages?",
        "a": "When the building allows vendors and there is space to stage. Many River Road buildings have rules — send them in the booking notes or we cannot confirm the job."
      },
      {
        "q": "Do you detail boats in Edgewater?",
        "a": "Yes, above-waterline marine packages when marina or storage access allows. Use /boats-detailing and enter your ZIP. Car packages on this page are for automobiles."
      },
      {
        "q": "Is 07020 a core ZIP?",
        "a": "Yes. Edgewater is mapped to the Bergen hub (07020). Standard car jobs use core NJ pricing from Palisades Park."
      },
      {
        "q": "What if street parking is the only option?",
        "a": "Only if we can legally occupy the space for the full job window. A driveway or assigned garage stall is more reliable. We will say no rather than start a job we cannot finish."
      }
    ],
    "paragraphs": [
      "Edgewater (07020) is the Hudson waterfront town just south of Fort Lee, still a Palisades Park core ZIP (mapped in the Bergen hub ZIP5 list). Cardetail1 details cars at driveways and in approved garages; we bring water and power. Car package “from” prices: Interior Detail {{interior.small}}, Premium Full Detail {{full.small}} sedan, {{name.refresh}} {{refresh.small}}. Boat work is a different catalog on /boats-detailing, priced by vessel length, not by this car list.",
      "River Road high-rises have the same constraint as Fort Lee: stall size, discharge rules, and COI requests. If the garage forbids our setup, we cannot do the job there. Townhome and house driveways off the waterfront streets are the straightforward path. Street parking only works if we can legally occupy the space for the full 1.5–4 hour window.",
      "Winter salt, garage dust, and commuter film are the usual exterior complaints. Use {{name.refresh}} or Premium Full Detail, not a wash. Interiors follow Interior Detail plus add-ons. Above-waterline marine jobs at marinas or storage lots use Marine Wash / Full Marine / Premium Marine and need marina rules in the notes — we do not clean underwater hulls.",
      "Car package contents are the Palisades Park catalog. Interior: vacuum, shampoo, steam, interior glass. Premium Full: interior plus wash, clay, sealant. {{name.refresh}}: clay, polish, sealant, Rain-X, wheels. 07020 does not add a special waterfront surcharge on standard core NJ car pricing; enter the ZIP so the form shows the live number. Hours Monday–Saturday · By Appointment Only. No charge at request.",
      "Book with ZIP 07020 or call (551) 389-3986 for garage questions. Nearby: Fort Lee, Palisades Park, Englewood, Hackensack, Teaneck. Cliffside Park and Fairview remain on the county hub city list; use those ZIPs on the homepage if that is where the vehicle will sit. Public quotes lower on this page are shown as written."
    ]
  }
];

const CITY_BY_KEY = Object.fromEntries(CITIES.map((c) => [c.key, c]));
const pagePath = (c) => `${c.key}-mobile-detailing`;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nearbyLinks(city) {
  const items = city.nearby
    .map((key) => CITY_BY_KEY[key])
    .filter((other) => other && other.key !== city.key)
    .map((other) => `<a href="/${pagePath(other)}">Mobile detailing in ${esc(other.city)}</a>`);
  items.push('<a href="/bergen-county-hub">Bergen County hub</a>');
  items.push('<a href="/">Cars &amp; SUVs</a>');
  items.push('<a href="/trucks-detailing">Trucks / Semis</a>');
  return items.join('\n      ');
}

function faqHtml(city) {
  return city.faqs
    .map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(resolveTokens(f.a))}</p></details>`)
    .join('\n    ');
}

function packagesHtml(city) {
  return PACKAGES.map((p) => {
    const pop = p.popular ? ' pop' : '';
    return `<article class="sp-pkg-card${pop}">
      <h3 class="sp-pkg-name">${esc(p.name)}</h3>
      <p class="sp-pkg-tag">${esc(p.tag)}</p>
      <div class="sp-pkg-price">From ${money(p.price)}</div>
      <div class="sp-pkg-basis">${esc(p.note)}</div>
      <div class="sp-pkg-time">${esc(p.time)}</div>
      <a class="sp-btn sp-btn-primary sp-btn-block" href="/?book=cars&amp;pkg=${p.id}&amp;zip=${city.zip}">Book ${esc(p.name)} in ${esc(city.city)}</a>
    </article>`;
  }).join('\n    ');
}

function schema(city) {
  const url = `${ORIGIN}/${pagePath(city)}`;
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['LocalBusiness', 'AutomotiveBusiness'],
        '@id': `${ORIGIN}/#business`,
        name: 'Cardetail1',
        legalName: 'Detailing Zone L.L.C.',
        url: ORIGIN,
        telephone: PHONE,
        image: `${ORIGIN}/assets/cardetail1-logo.webp`,
        logo: { '@type': 'ImageObject', url: `${ORIGIN}/assets/cardetail1-logo-square.png`, width: 720, height: 720 },
        priceRange: '$$',
        address: { '@type': 'PostalAddress', addressLocality: 'Palisades Park', addressRegion: 'NJ', postalCode: '07650', addressCountry: 'US' },
        geo: { '@type': 'GeoCoordinates', latitude: 40.8482, longitude: -73.9976 },
        areaServed: [
          { '@type': 'City', name: `${city.city}, NJ` },
          { '@type': 'AdministrativeArea', name: 'Bergen County, NJ' },
          { '@type': 'AdministrativeArea', name: 'Palisades Park, NJ' },
        ],
        sameAs: ['https://www.instagram.com/cardetail1com', GBP],
      },
      {
        '@type': 'Service',
        '@id': `${url}#service`,
        name: `Mobile Car Detailing in ${city.city}`,
        serviceType: 'Mobile Car Detailing',
        provider: { '@id': `${ORIGIN}/#business` },
        areaServed: { '@type': 'City', name: `${city.city}, NJ` },
        url,
        offers: PACKAGES.map((p) => ({
          '@type': 'Offer',
          name: p.name,
          price: String(p.price),
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
          url: `${ORIGIN}/?book=cars&pkg=${p.id}&zip=${city.zip}`,
        })),
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: city.faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: resolveTokens(f.a) },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Bergen County', item: `${ORIGIN}/bergen-county-hub` },
          { '@type': 'ListItem', position: 3, name: city.city, item: url },
        ],
      },
    ],
  };
  return JSON.stringify(graph, null, 2);
}

function pageHtml(city) {
  const url = `${ORIGIN}/${pagePath(city)}`;
  const copy = city.paragraphs.map((p) => `<p>${esc(resolveTokens(p))}</p>`).join('\n      ');
  const book = `/?book=cars&amp;zip=${city.zip}`;
  const desc = resolveTokens(city.description);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(city.title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta name="geo.region" content="US-NJ">
<meta name="geo.placename" content="${esc(city.city)}, Bergen County, New Jersey">
<meta name="geo.position" content="${city.lat};${city.lng}">
<meta property="og:locale" content="en_US">
<meta property="og:site_name" content="Cardetail1">
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(city.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${ORIGIN}/assets/vehicles/premium/cars-suvs.webp">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(city.title)}">
<meta name="twitter:description" content="${esc(desc)}">
<script type="application/ld+json">
${schema(city)}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/specialty-category.css">
<link rel="stylesheet" href="assets/specialty-service-nav.css">
<link rel="stylesheet" href="assets/specialty-public-footer.css">
<link rel="stylesheet" href="assets/specialty-page-ui.css">
<link rel="stylesheet" href="assets/public-surface.css">
<link rel="stylesheet" href="assets/city-landing.css">
</head>
<body>
<nav class="nav" id="main-nav">
  <a class="nav-brand-img" href="/" aria-label="Cardetail1 Home"><img class="nav-logo-img" src="assets/cardetail1-logo.webp" width="520" height="261" alt="Cardetail1 mobile car detailing Palisades Park NJ" decoding="async"></a>
  <div class="nav-links" id="nav-links">
    <a class="nav-link" href="/#services">Services</a>
    <a class="nav-link" href="/ceramic-coating">Ceramic Coating</a>
    <a class="nav-link" href="/bergen-county-hub">Bergen County</a>
    <a class="nav-link" href="my-garage.html">My Garage</a>
    <a class="nav-link" href="tel:${PHONE}">Call / Text</a>
    <a class="nav-cta" href="${book}">Book Online</a>
  </div>
  <a class="nav-book-mobile" href="${book}">Book</a>
  <button type="button" class="nav-menu-btn" onclick="document.getElementById('nav-links').classList.toggle('open')" aria-label="Menu">☰</button>
</nav>
<nav class="specialty-service-nav" aria-label="Specialty detailing services">
  <div class="specialty-service-nav-inner">
        <div class="specialty-service-links">
      <a class="specialty-service-link" href="/#services">Cars &amp; SUVs</a>
      <a class="specialty-service-link" href="/trucks-detailing">Semi Trucks</a>
      <a class="specialty-service-link" href="/rv-detailing">RV &amp; Trailers</a>
      <a class="specialty-service-link" href="/boats-detailing">Boats</a>
      <a class="specialty-service-link" href="/powersports-detailing">Powersports</a>
    </div>
  </div>
</nav>
<nav class="city-crumb" aria-label="Breadcrumb">
  <a href="/">Home</a> · <a href="/bergen-county-hub">Bergen County</a> · ${esc(city.city)}
</nav>
<header class="sp-hero">
  <div class="sp-eyebrow">Palisades Park base · ${esc(city.city)}, NJ ${city.zip}</div>
  <h1>${esc(city.h1)}</h1>
  <p class="sp-hero-sub">We come to your driveway in ${esc(city.city)} with water and power. Interior, full, and exterior packages priced from the same Bergen County catalog — no shop drop-off.</p>
  <form class="city-zip" action="/" method="get">
    <input type="hidden" name="book" value="cars">
    <label for="city-zip-${city.zip}">Check ZIP for local pricing</label>
    <div class="city-zip-row">
      <input id="city-zip-${city.zip}" name="zip" inputmode="numeric" maxlength="5" value="${city.zip}" autocomplete="postal-code" required>
      <button class="sp-btn sp-btn-primary" type="submit">Check ZIP &amp; Book</button>
    </div>
  </form>
  <div class="sp-btns">
    <a class="sp-btn sp-btn-primary" href="${book}">Book mobile detailing in ${esc(city.city)}</a>
    <a class="sp-btn sp-btn-outline" href="tel:${PHONE}">Call ${PHONE_DISPLAY}</a>
  </div>
</header>
<section class="sp-section" aria-label="Why this town">
  <div class="sp-trust">
    <div class="sp-trust-item"><strong>Based in Palisades Park</strong><span>${city.zip === '07650' ? 'Home base · ZIP 07650' : `Serving ZIP ${city.zip}`}</span></div>
    <div class="sp-trust-item"><strong>We bring water &amp; power</strong><span>No hose hookup required</span></div>
    <div class="sp-trust-item"><strong>5+ Years Experience</strong><span>Owner-operated mobile detailing</span></div>
    <div class="sp-trust-item"><strong>$0 at request</strong><span>Pay after service</span></div>
  </div>
</section>
<section class="sp-section" id="about">
  <div class="sp-sec-eye">Mobile detailing in ${esc(city.city)}</div>
  <h2 class="sp-sec-title">How we work in ${esc(city.city)}</h2>
  <div class="city-copy">
      ${copy}
  </div>
</section>
<section class="sp-section" id="packages">
  <div class="sp-sec-eye">Packages &amp; from prices</div>
  <h2 class="sp-sec-title">Interior, full, and exterior detail in ${esc(city.city)}</h2>
  <p class="sp-sec-copy">These are the same starting prices as the homepage catalog. Final totals adjust by vehicle size, condition, and add-ons after you enter ZIP ${city.zip}.</p>
  <div class="sp-pkg-grid">
    ${packagesHtml(city)}
  </div>
</section>
<section class="sp-section" id="reviews">
  <div class="sp-sec-eye">Customer Feedback</div>
  <h2 class="sp-sec-title">What customers say</h2>
  <p class="sp-sec-copy">Quotes are shown as written on the public Google listing.</p>
  <div class="city-reviews">
    ${REVIEWS.map((r) => `<article class="city-review">
      <div class="city-stars" aria-label="5 stars">★★★★★</div>
      <p>${esc(r.text).replace(/&quot;/g, '"')}</p>
      <p class="city-review-meta">${esc(r.name)} · Google review</p>
    </article>`).join('\n    ')}
  </div>
  <p class="sp-sec-copy" style="margin-top:18px"><a href="${GBP}">Read or leave a Google review</a></p>
</section>
<section class="sp-section" id="faq">
  <div class="sp-sec-eye">FAQ</div>
  <h2 class="sp-sec-title">${esc(city.city)} mobile detailing questions</h2>
  <div class="sp-faq">
    ${faqHtml(city)}
  </div>
</section>
<section class="sp-section">
  <div class="sp-sec-eye">Nearby</div>
  <h2 class="sp-sec-title">Other Bergen County cities we serve</h2>
  <div class="city-nearby">
      ${nearbyLinks(city)}
      <a href="/boats-detailing">Boat detailing</a>
      <a href="/rv-detailing">RV detailing</a>
      <a href="/fleet-services">Fleet detailing</a>
  </div>
</section>
<section class="sp-cta" aria-label="Book in ${esc(city.city)}">
  <h2>Ready to book in ${esc(city.city)}?</h2>
  <p>ZIP ${city.zip} · Monday–Saturday · By Appointment Only · Palisades Park base</p>
  <div class="sp-btns">
    <a class="sp-btn sp-btn-primary" href="${book}">Check price &amp; availability</a>
    <a class="sp-btn sp-btn-outline" href="tel:${PHONE}">Call / Text</a>
  </div>
</section>
<footer class="specialty-public-footer" id="cd1-public-footer">
  <div class="foot-in">
    <div class="foot-top">
      <div>
        <img class="foot-logo-img" src="assets/cardetail1-logo.webp" width="520" height="261" alt="Cardetail1 Mobile Detailing" loading="lazy" decoding="async">
        <p class="foot-tagline">Based in Palisades Park, NJ. Mobile cars, boats, RVs, and powersports — we come to you.</p>
      </div>
      <div class="foot-col">
        <h4>Services</h4>
        <a href="/">Cars &amp; SUVs</a>
        <a href="/trucks-detailing">Trucks / Semis</a>
        <a href="/boats-detailing">Boats &amp; Marine</a>
        <a href="/rv-detailing">RVs &amp; Trailers</a>
        <a href="/powersports-detailing">Motorcycles &amp; Powersports</a>
        <a href="/multi-vehicle-detailing">Multi-Vehicle Detailing</a>
        <a href="/fleet-services">Commercial &amp; Fleet</a>
      </div>
      <div class="foot-col">
        <h4>Bergen County</h4>
${CITIES.map((c) => `        <a href="/${pagePath(c)}">${esc(c.city)}</a>`).join('\n')}
        <a href="/bergen-county-hub">All Bergen County</a>
      </div>
      <div class="foot-col">
        <h4>Contact</h4>
        <a href="tel:${PHONE}">Call / Text</a>
        <a href="https://www.instagram.com/cardetail1com" target="_blank" rel="noopener noreferrer">Instagram</a>
        <span class="foot-static">Palisades Park, NJ</span>
        <span class="foot-static">Monday–Saturday · By Appointment Only</span>
      </div>
    </div>
    <div class="foot-bot">
      <div class="foot-copy">&copy; 2026 Cardetail1 &middot; All rights reserved.</div>
      <div class="foot-legal" data-nosnippet>Cardetail1 is a registered DBA of Detailing Zone L.L.C.</div>
    </div>
  </div>
</footer>
<script src="assets/back-to-top.js" defer></script>
<script src="assets/county-hub-booking-attribution.js" defer></script>
</body>
</html>
`;
}

// Render every page first (all price tokens resolved and mirror-checked), then write.
const rendered = CITIES.map((city) => {
  const name = `${pagePath(city)}.html`;
  const html = pageHtml(city);
  const leftover = html.match(/\{\{[^}]+\}\}/);
  if (leftover) throw new Error(`${name}: unresolved token ${leftover[0]}`);
  return { name, html };
});

if (args.includes('--parity')) {
  for (const key of [...usedPriceKeys].sort()) console.log(`parity ${key} canonical=${canonicalPrice(key)} mirror=ok`);
}

let drift = 0;
for (const { name, html } of rendered) {
  const target = path.join(outDir, name);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const eol = current && current.includes('\r\n') ? '\r\n' : '\n';
  const out = html.replace(/\n/g, eol);
  if (checkOnly) {
    if (current !== out) { drift++; console.error(`DRIFT: ${name}`); }
    continue;
  }
  if (current === out) { console.log('unchanged', name); continue; }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(target, out);
  console.log('wrote', name);
}
if (checkOnly && drift) process.exitCode = 1;

export { CITIES, PACKAGES, resolveTokens };
