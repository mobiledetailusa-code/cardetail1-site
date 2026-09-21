// Server-side booking price catalog — canonical package price authority.
// Browser PRICING / LENGTH_PRICING blocks are synced FROM this file
// (scripts/apply-package-price-change.mjs --sync-only). Wealth-based ZIP
// multipliers are retired: getRichMultiplier always returns 1.0.

const { asArray } = require('./historical-adapter');
const PowersportsCatalog = require('../../assets/powersports-model-catalog');
const SeasonalDriveway = require('../../assets/seasonal-driveway-addon');

const SEASONAL_DRIVEWAY_ADDONS = Object.freeze([
  { id: 'seasonal_driveway_cleanup', price: 95, name: 'Driveway & Entry Cleanup' },
  { id: 'walkway_steps', price: 35, name: 'Front Walkway + Steps' },
  { id: 'porch_entry', price: 45, name: 'Porch / Entry Area' },
  { id: 'small_patio', price: 50, name: 'Small Patio' },
  { id: 'heavy_wet_leaf', price: 50, name: 'Heavy / Wet Leaf Buildup' },
  { id: 'bag_place_property', price: 35, name: 'Bag & Place On Property' },
  { id: 'pressure_surface_wash', price: 125, name: 'Pressure Wash Upgrade' },
]);

const POWERSPORTS_PUBLIC_TIER_KEYS = Object.freeze(
  Object.keys(PowersportsCatalog.serviceClasses).filter((key) =>
    PowersportsCatalog.isPublicBookableServiceClass(key)
  )
);
const POWERSPORTS_LEGACY_TIER_KEYS = new Set(['motorcycle', 'atv', 'utv', 'jetski']);

const PRICING = {
  cars: {
    tiers: {
      small: { label: 'Small Car', wash: 125, maint: 160, interior: 210, full: 275, refresh: 350, premium: 425 },
      suv2: { label: 'SUV 2-Row', wash: 145, maint: 195, interior: 235, full: 295, refresh: 395, premium: 500 },
      suv3: { label: 'SUV 3-Row', wash: 165, maint: 225, interior: 265, full: 325, refresh: 435, premium: 575 },
      compact_van: { label: 'Compact Van', wash: 165, maint: 225, interior: 260, full: 315, refresh: 435, premium: 575 },
      midsize_van: { label: 'Midsize Van', wash: 165, maint: 225, interior: 260, full: 315, refresh: 435, premium: 575 },
      full_size_van: { label: 'Full-Size Cargo Van', wash: 185, maint: 255, interior: 295, full: 350, refresh: 475, premium: 625 },
      full_size_van_passenger: { label: 'Full-Size Passenger Van', wash: 195, maint: 265, interior: 310, full: 375, refresh: 495, premium: 650 },
      truck: { label: 'Truck', wash: 165, maint: 225, interior: 260, full: 315, refresh: 425, premium: 560 },
    },
    addons: [
      { id: 'pethair', price: 95 }, { id: 'superint', price: 125 }, { id: 'odor', price: 90 },
      { id: 'mold', price: 149 }, { id: 'sanitize', price: 65 },
      { id: 'biohazard', price: 115 }, { id: 'engine', price: 45 }, { id: 'floormats', price: 20, qty: true },
      { id: 'rainx', price: 25 }, { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 },
      { id: 'claybar', price: 45 }, { id: 'headlight', price: 90 }, { id: 'babyseat', price: 20, qty: true },
      { id: 'stroller', price: 20, qty: true }, { id: 'trashcans', price: 25, qty: true },
      // Stage 1 financial-mutation fixture / canonical $40 add-on (4000 cents)
      { id: 'ozone', price: 40 },
      ...SEASONAL_DRIVEWAY_ADDONS,
    ],
  },
  trucks: {
    tiers: {
      day_cab: { label: 'Day Cab / Single Cab', interior: 340, int_wash: 415, int_wash_wax: 520 },
      sleeper_cab: { label: 'Sleep / Sleeper Cab', interior: 425, int_wash: 520, int_wash_wax: 650 },
    },
    addons: [
      { id: 'pethair', price: 95 }, { id: 'superint', price: 125 }, { id: 'odor', price: 90 },
      { id: 'mold', price: 149 }, { id: 'sanitize', price: 65 },
      { id: 'biohazard', price: 115 }, { id: 'engine', price: 45 }, { id: 'floormats', price: 20, qty: true },
      { id: 'rainx', price: 25 }, { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 },
      { id: 'claybar', price: 45 }, { id: 'headlight', price: 90 },
      { id: 'trashcans', price: 25, qty: true },
      { id: 'ozone', price: 40 },
    ],
  },
  boats: {
    tiers: {
      under20: { label: 'Under 20 ft', maint: 235, essential: 350, full: 525, premium: 825 },
      '20to25': { label: '20–25 ft', maint: 320, essential: 475, full: 700, premium: 1060 },
      '26to30': { label: '26–30 ft', maint: 410, essential: 585, full: 880, premium: 1285 },
      over30: { label: '30+ ft', maint: 525, essential: 760, full: 1175, premium: 1760 },
    },
    addons: [
      { id: 'rainx', price: 25 }, { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 },
      { id: 'chrome', price: 85 }, { id: 'odor', price: 90 }, { id: 'mold', price: 149 },
      { id: 'sanitize', price: 65 }, { id: 'biohazard', price: 115 },
      { id: 'trashcans', price: 25, qty: true },
    ],
  },
  rvs: {
    tiers: {
      travel: {
        label: 'Travel Trailer',
        maint: 280, maint_light: 410, interior: 405, full_basic: 790, premium: 1000, full: 1235,
      },
      fifthwheel: {
        label: 'Fifth Wheel',
        maint: 315, maint_light: 525, interior: 510, full_basic: 925, premium: 1175, full: 1480,
      },
      classC: {
        label: 'Class C',
        maint: 340, maint_light: 585, interior: 545, full_basic: 985, premium: 1350, full: 1635,
      },
      classA: {
        label: 'Class A',
        maint: 370, maint_light: 760, interior: 665, full_basic: 1130, premium: 1700, full: 2005,
      },
      classBC: {
        label: 'Class B / Class C Motorhome',
        maint: 340, maint_light: 585, interior: 545, full_basic: 985, premium: 1350, full: 1635,
      },
      airstream: {
        label: 'Airstream',
        maint: 300, maint_light: 440, interior: 440, full_basic: 865, premium: 1060, full: 1320,
      },
      specialty: {
        label: 'Cargo, Horse or Custom Trailer',
        maint: 265, maint_light: 0, interior: 0, full_basic: 0, premium: 925, full: 0,
      },
    },
    addons: [
      { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 }, { id: 'rainx', price: 25 },
      { id: 'biohazard', price: 115 }, { id: 'sanitize', price: 75 },
      { id: 'superint', price: 135 },
      { id: 'awning', price: 50, qty: true }, { id: 'roof', price: 50, qty: true },
      { id: 'capfront', price: 149 }, { id: 'pethair', price: 95 }, { id: 'odor', price: 90 },
      { id: 'trashcans', price: 25, qty: true },
      ...SEASONAL_DRIVEWAY_ADDONS,
    ],
  },
  powersports: {
    tiers: {
      // New public packages: maintenance / restore. wash/essential/full/premium
      // remain so historical bookings keep their original dollar meaning.
      motorcycle: { label: 'Motorcycle', wash: 105, essential: 165, full: 235, premium: 325, maintenance: 180, restore: 250 },
      motorcycle_large: { label: 'Large Motorcycle', wash: 105, essential: 165, full: 235, premium: 325, maintenance: 200, restore: 275 },
      motorcycle_trike: { label: 'Trike / 3-Wheel Motorcycle', wash: 105, essential: 165, full: 235, premium: 325, maintenance: 225, restore: 310 },
      atv: { label: 'ATV', wash: 105, essential: 165, full: 235, premium: 325, maintenance: 180, restore: 240 },
      utv: { label: 'UTV / Side-by-Side', wash: 130, essential: 200, full: 290, premium: 410 },
      utv_standard: { label: 'Side-by-Side / UTV', wash: 130, essential: 200, full: 290, premium: 410, maintenance: 210, restore: 275 },
      utv_large: { label: 'Large / Crew Side-by-Side / UTV', wash: 130, essential: 200, full: 290, premium: 410, maintenance: 235, restore: 325 },
      jetski: { label: 'Jet Ski / PWC', wash: 105, essential: 165, full: 235, premium: 320 },
    },
    addons: [
      { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 }, { id: 'rainx', price: 25 },
      { id: 'heavymud', price: 55 }, { id: 'seatdeep', price: 45 }, { id: 'storage', price: 35 },
      { id: 'wheeldet', price: 35 }, { id: 'waterspot', price: 35 }, { id: 'saltwash', price: 35 },
      { id: 'trimprot', price: 35 }, { id: 'lightdeg', price: 45 },
      ...SEASONAL_DRIVEWAY_ADDONS,
    ],
  },
  fleet: {
    tiers: {
      vehicle: { label: 'Cars / SUVs / Trucks Fleet', maint: 70, essential: 115, full: 185, premium: 270, custom: 0 },
      commercial: { label: 'Vans / Trucks / Buses', maint: 105, essential: 175, full: 280, premium: 0, custom: 0 },
      powersports: { label: 'Golf Carts / Powersports Fleet', maint: 50, essential: 80, full: 135, premium: 205, custom: 0 },
      marine_rv: { label: 'Boat / RV / Trailer Fleet', maint: 0, essential: 0, full: 0, premium: 0, custom: 0 },
    },
    addons: [
      { id: 'polymer', price: 25 }, { id: 'trashcans', price: 25 }, { id: 'disinfect', price: 20 },
      { id: 'biohazard', price: 115 }, { id: 'odor', price: 99 }, { id: 'heavymud', price: 65 },
    ],
  },
};

// Add-ons whose named treatment is already part of the canonical package.
// Keeping this beside PRICING prevents Customer/Admin clients from creating a
// second billable line for work the selected package already includes.
const PACKAGE_INCLUDED_ADDONS = Object.freeze({
  cars: Object.freeze({
    full: Object.freeze(['claybar']),
    refresh: Object.freeze(['claybar', 'rainx']),
    premium: Object.freeze(['claybar', 'rainx']),
  }),
});

function includedAddonIds(category, packageId) {
  const cat = String(category || '').trim();
  const pkg = String(packageId || '').trim();
  return [...(PACKAGE_INCLUDED_ADDONS[cat]?.[pkg] || [])];
}

const LENGTH_PRICING = {
  boats: {
    min: 12, max: 60, defaultFt: 22, estimateOver: 36,
    packages: {
      maint: { perFt: 11, min: 175 },
      essential: { perFt: 19, min: 265 },
      full: { perFt: 27, min: 390 },
      premium: { perFt: 33, min: 615 },
    },
  },
  rvs: {
    min: 12, max: 45, defaultFt: 20, estimateOver: 40,
    packages: {
      maint: { base: 135, ratePerFoot: 9 },
      maint_light: { base: 220, ratePerFoot: 14 },
      interior: { base: 220, ratePerFoot: 15 },
      full_basic: { base: 265, ratePerFoot: 22 },
      premium: { base: 265, ratePerFoot: 25 },
      full: { base: 350, ratePerFoot: 32 },
    },
  },
  fleet: {
    min: 10, max: 60, defaultFt: 24, estimateOver: 36,
    packages: {
      maint: { perFt: 12, min: 175 },
      essential: { perFt: 16, min: 290 },
      full: { perFt: 23, min: 525 },
      premium: { perFt: 32, min: 700 },
      custom: { perFt: 0, min: 0 },
    },
  },
};

// Former wealth-based ZIP list. Kept exported (empty) so older mirrored pages
// and tests that import RICH_ZIPS keep resolving, but it no longer affects
// quote math — getRichMultiplier is hard-wired to 1.0.
const RICH_ZIPS = new Set();

const PKG_ID_ALIASES = {
  'maintenance detail': 'maint',
  'interior detail': 'interior',
  'premium detail': 'full',
  'premium full detail': 'full',
  'exterior hand wash': 'wash',
  'hand wash': 'wash',
  'car wash': 'wash',
  'express wash': 'wash',
  // Exterior Refresh & Protect (cars) — pkgId 'refresh'. Exact-name aliases are
  // required because inferPkgId's includes() fallback would otherwise match the
  // substring 'exterior' and mis-resolve this to the RV 'exterior' package.
  // NOTE: a bare 'exterior' alias is intentionally NOT added — 'exterior' is a
  // real RV package id and must not be globally remapped.
  'exterior refresh & protect': 'refresh',
  'exterior refresh and protect': 'refresh',
  'exterior refresh': 'refresh',
  'exterior detail': 'refresh',
  'exterior_refresh': 'refresh',
  'refresh': 'refresh',
  // Paint Correction / Enhancement stays on the premium/correction path — it is
  // NOT an alias for the cheaper 'refresh' package.
  'paint correction / enhancement': 'premium',
  'marine wash': 'maint',
  'essential marine': 'essential',
  'full marine detail': 'full',
  'premium marine': 'premium',
  'maintenance wash': 'maint',
  'maintenance wash + light interior': 'maint_light',
  'maintenance wash and light interior': 'maint_light',
  'maint light': 'maint_light',
  'maint_light': 'maint_light',
  'exterior wash': 'maint_light',
  'exterior wash & protect': 'maint_light',
  'exterior wash and protect': 'maint_light',
  'full rv detail': 'full_basic',
  'full rv detail package': 'full_basic',
  'full rv detailing': 'full_basic',
  'full_basic': 'full_basic',
  'premium complete detail': 'full',
  'premium complete rv detail': 'full',
  'premium exterior': 'premium',
  'premium exterior detail': 'premium',
  'one-step paint correction': 'premium',
  'one-step paint correction + interior': 'full',
  'one-step paint correction and interior': 'full',
  'wash & shine': 'wash',
  'essential detail': 'essential',
  'full detail': 'full',
  'correction / restoration detail': 'restore',
  'correction/restoration detail': 'restore',
  'deep detail & restore': 'restore',
  'deep detail and restore': 'restore',
  'interior + wash': 'int_wash',
  'interior + wash & wax': 'int_wash_wax',
  'interior + wash and wax': 'int_wash_wax',
  'int wash': 'int_wash',
  'int_wash': 'int_wash',
  'int_wash_wax': 'int_wash_wax',
  'fleet maintenance wash': 'maint',
  'fleet essential detail': 'essential',
  'fleet full detail': 'full',
  'fleet premium protection': 'premium',
  'custom fleet quote': 'custom',
};

function getRichMultiplier(_zip) {
  // Commercial optimization phase 1: ZIP wealth no longer multiplies package price.
  // Travel fees remain appointment-level via travel-fee.js and are unchanged.
  return 1.0;
}

function applyRichPrice(base, zip) {
  return base ? Math.round(base * getRichMultiplier(zip)) : 0;
}

// Loaded lazily so rv-type-catalog can derive its rate table from this catalog
// without creating a CommonJS initialization cycle.
function getRvTypes() {
  return require('./rv-type-catalog').RV_TYPES;
}

function resolveRvTypeKey(vehicle, booking) {
  const RV_TYPES = getRvTypes();
  const raw = String(
    vehicle?.rvType || vehicle?.typeKey || vehicle?.tierKey || booking?.rvType || '',
  ).trim();
  if (!raw || raw === 'length') return 'travel';
  if (RV_TYPES[raw]) return raw;
  const lower = raw.toLowerCase();
  if (lower.includes('fifth')) return 'fifthwheel';
  if (lower.includes('airstream')) return 'airstream';
  if (lower.includes('horse')) return 'horse';
  if (lower.includes('cargo')) return 'cargo';
  if (lower.includes('class a') || lower === 'classa') return 'classA';
  if (lower.includes('class b') || lower === 'classb') return 'classB';
  if (lower.includes('class c') || lower === 'classc') return 'classC';
  if (lower.includes('class bc') || lower === 'classbc') return 'classC';
  if (lower.includes('specialty') || lower.includes('custom')) return 'other';
  if (lower.includes('other')) return 'other';
  if (lower.includes('travel')) return 'travel';
  return 'travel';
}

function getLengthPrice(cat, pkgId, ft, typeKey) {
  const cfg = LENGTH_PRICING[cat];
  if (!cfg) return null;
  let id = pkgId;
  if (cat === 'rvs') {
    const legacy = { exterior: 'maint_light', correction: 'premium', correction_int: 'full' };
    if (legacy[id]) id = legacy[id];
  }
  if (!cfg.packages[id]) return null;
  const rule = cfg.packages[id];
  const lengthFt = Number(ft || cfg.defaultFt);
  if (cat === 'rvs') {
    const RV_TYPES = getRvTypes();
    const key = typeKey && RV_TYPES[typeKey] ? typeKey : 'travel';
    const mult = Number(RV_TYPES[key]?.multiplier) || 1;
    const base = Number(rule.base) || 0;
    const rate = Number(rule.ratePerFoot != null ? rule.ratePerFoot : rule.perFt) || 0;
    const raw = (base + rate * lengthFt) * mult;
    return Math.round(raw * 100) / 100;
  }
  const raw = rule.perFt * lengthFt;
  return Math.max(rule.min, Math.round(raw));
}

function inferPkgId(vehicle, booking) {
  if (vehicle.pkgId) {
    const legacy = { exterior: 'maint_light', correction: 'premium', correction_int: 'full' };
    const cat = vehicle.cat || booking?.vehicleCategory;
    if (cat === 'rvs' && legacy[vehicle.pkgId]) return legacy[vehicle.pkgId];
    return vehicle.pkgId;
  }
  const name = String(vehicle.pkgName || booking.package || '').trim().toLowerCase();
  const catEarly = vehicle.cat || booking?.vehicleCategory;
  // Powersports "Maintenance Detail" must not collapse onto cars/fleet `maint`.
  if (catEarly === 'powersports') {
    if (name === 'maintenance detail' || name === 'maintenance') return 'maintenance';
    if (name === 'premium detail') return 'premium';
  }
  if (PKG_ID_ALIASES[name]) return PKG_ID_ALIASES[name];
  const cat = vehicle.cat || booking.vehicleCategory;
  const pkgs = PRICING[cat];
  if (!pkgs) return null;
  if (name.includes('full rv detail') && !name.includes('premium complete')) return 'full_basic';
  if (name.includes('light interior') || name.includes('maint_light')) return 'maint_light';
  if (name.includes('correction') && name.includes('interior')) return 'full';
  if (name.includes('paint correction') || name.includes('one-step paint')) return 'premium';
  if (name.includes('premium complete')) return 'full';
  if (name.includes('wash & protect') || name.includes('wash and protect')) return 'maint_light';
  for (const key of ['full_basic', 'maint_light', 'maint', 'interior', 'full', 'premium', 'essential', 'wash', 'custom']) {
    if (name.includes(key.replace('_', ' '))) return key;
  }
  return null;
}

function resolveTierKey(vehicle) {
  const cat = vehicle.cat || vehicle.category;
  if (cat === 'boats' || cat === 'rvs') return 'length';
  if (cat === 'fleet') {
    const label = String(vehicle.vehicleLabel || '');
    if (/avg\s+\d+\s*ft/i.test(label) || (/unit fleet/i.test(label) && /\d+\s*ft/i.test(label))) {
      return 'marine_rv';
    }
  }
  const tiers = PRICING[cat]?.tiers;
  // Only accept known tier keys — stale/unknown keys (e.g. leftover suv2) must not win.
  const rawKey = String(vehicle.tierKey || vehicle.tier || '').trim();
  if (cat === 'powersports') {
    if (PowersportsCatalog.isPublicBookableServiceClass(rawKey)) return rawKey;
    // Historical bookings retain their original internal price-tier key. These
    // aliases are not exposed as new browser choices.
    if (POWERSPORTS_LEGACY_TIER_KEYS.has(rawKey) && tiers?.[rawKey]) return rawKey;
    const label = String(vehicle.tierLabel || '').trim();
    for (const serviceClass of POWERSPORTS_PUBLIC_TIER_KEYS) {
      if (PowersportsCatalog.classDefinition(serviceClass)?.label === label) return serviceClass;
    }
    return null;
  }
  if (rawKey && tiers && tiers[rawKey]) return rawKey;
  const tierLabel = String(vehicle.tierLabel || '').trim();
  if (tiers && tierLabel) {
    for (const [key, tier] of Object.entries(tiers)) {
      if (tier.label === tierLabel) return key;
    }
  }
  return null;
}

function parseLengthFt(vehicle, booking) {
  const raw = vehicle.lengthFt ?? booking?.lengthFt;
  if (raw != null && raw !== '') return Number(raw);
  const label = String(vehicle.vehicleLabel || '');
  const avg = label.match(/avg\s+(\d+)\s*ft/i);
  if (avg) return Number(avg[1]);
  const ft = label.match(/(\d+)\s*ft/i);
  return ft ? Number(ft[1]) : null;
}

function parseUnits(vehicle, booking) {
  const raw = vehicle.units ?? booking?.units;
  if (raw != null && raw !== '') return Math.max(1, Number(raw));
  const label = String(vehicle.vehicleLabel || '');
  const m = label.match(/^(\d+)\s*unit fleet/i);
  if (m) return Number(m[1]);
  return vehicle.cat === 'fleet' ? 2 : 1;
}

function computeAddonTotal(vehicle) {
  const cat = vehicle.cat;
  const catalog = PRICING[cat]?.addons || [];
  const included = new Set(includedAddonIds(cat, vehicle.packageId || vehicle.pkgId));
  let total = 0;
  const normalized = [];
  const seenFamily = new Set();
  for (const a of (vehicle.addons || [])) {
    if (included.has(a.id)) continue;
    const def = catalog.find((x) => x.id === a.id);
    if (!def) return { ok: false, error: 'invalid_pricing' };
    if (SeasonalDriveway.isFamilyId(a.id)) {
      if (seenFamily.has(a.id)) continue;
      seenFamily.add(a.id);
      const meta = SeasonalDriveway.displayFor(a.id);
      total += def.price;
      normalized.push({
        id: a.id,
        name: a.name || meta.name || def.name || a.id,
        price: def.price,
        qty: 1,
      });
      continue;
    }
    const qty = Math.max(1, Number(a.qty) || 1);
    total += def.price * qty;
    normalized.push({ id: a.id, name: a.name || def.name || a.id, price: def.price, qty });
  }
  return { ok: true, total, addons: normalized };
}

function computeVehicleBasePrice(vehicle, zip, booking) {
  const cat = vehicle.cat || booking?.vehicleCategory;
  const pkgId = inferPkgId(vehicle, booking);
  if (!cat || !pkgId || !PRICING[cat]) return { ok: false, error: 'invalid_pricing' };

  const tiers = PRICING[cat].tiers;
  const tierKey = resolveTierKey({ ...vehicle, cat });

  if (cat === 'boats' || cat === 'rvs') {
    const cfg = LENGTH_PRICING[cat];
    const ft = parseLengthFt(vehicle, booking) || cfg.defaultFt;
    const typeKey = cat === 'rvs' ? resolveRvTypeKey(vehicle, booking) : null;
    const raw = getLengthPrice(cat, pkgId, ft, typeKey);
    if (raw == null) return { ok: false, error: 'invalid_pricing' };
    // Client length path (tryGenericConfirm) does not apply rich multiplier.
    return { ok: true, basePrice: raw, cat, pkgId, tierKey: tierKey || typeKey || 'length', rvType: typeKey || undefined };
  }

  if (cat === 'fleet') {
    const units = parseUnits(vehicle, booking);
    if (pkgId === 'custom') return { ok: true, basePrice: 0, cat, pkgId, tierKey };
    if (tierKey === 'marine_rv') {
      const ft = parseLengthFt(vehicle, booking) || LENGTH_PRICING.fleet.defaultFt;
      const unitPrice = getLengthPrice('fleet', pkgId, ft);
      if (unitPrice == null) return { ok: false, error: 'invalid_pricing' };
      return { ok: true, basePrice: unitPrice * units, cat, pkgId, tierKey };
    }
    const tier = tierKey ? tiers[tierKey] : null;
    if (!tier) return { ok: false, error: 'invalid_pricing' };
    const unitPrice = tier[pkgId];
    if (!unitPrice) return { ok: true, basePrice: 0, cat, pkgId, tierKey };
    return { ok: true, basePrice: unitPrice * units, cat, pkgId, tierKey };
  }

  const powersportsPriceTier = cat === 'powersports'
    ? (PowersportsCatalog.priceTierForServiceClass(tierKey)
      || (POWERSPORTS_LEGACY_TIER_KEYS.has(tierKey) ? tierKey : null))
    : null;
  const tier = tierKey ? tiers[cat === 'powersports' ? powersportsPriceTier : tierKey] : null;
  if (!tier) return { ok: false, error: 'invalid_pricing' };
  const raw = tier[pkgId] ?? tier.wash ?? tier.maint ?? tier.exterior ?? 0;
  if (!raw) return { ok: false, error: 'invalid_pricing' };
  return { ok: true, basePrice: applyRichPrice(raw, zip), cat, pkgId, tierKey };
}

function vehiclesFromBooking(booking) {
  if (Array.isArray(booking.vehicles) && booking.vehicles.length) return booking.vehicles;
  const cat = booking.vehicleCategory;
  if (!cat) return [];
  return [{
    cat,
    pkgId: inferPkgId({ pkgName: booking.package }, booking),
    pkgName: booking.package,
    tierLabel: booking.vehicleTier,
    vehicleLabel: booking.vehicle || booking.vehicleLabel,
    lengthFt: booking.lengthFt,
    units: booking.units,
    addons: booking.addons || [],
  }];
}

function computeVehicleSubtotal(vehicle, zip, booking) {
  const base = computeVehicleBasePrice(vehicle, zip, booking);
  if (!base.ok) return base;
  const addons = computeAddonTotal({ ...vehicle, cat: base.cat });
  if (!addons.ok) return addons;
  const subtotal = base.basePrice + addons.total;
  return {
    ok: true,
    subtotal,
    basePrice: base.basePrice,
    addonTotal: addons.total,
    addons: addons.addons,
    cat: base.cat,
    pkgId: base.pkgId,
    tierKey: base.tierKey,
  };
}

function computeBookingServiceSubtotal(booking) {
  const zip = booking.zipCode || booking.zip || '';
  const vehicles = vehiclesFromBooking(booking);
  if (!vehicles.length) return { ok: false, error: 'invalid_pricing' };

  const appointment = SeasonalDriveway.normalizeAppointmentAddons(vehicles);
  if (!appointment.ok) return appointment;
  const pricedVehicles = appointment.vehicles;

  let serviceSubtotal = 0;
  const updatedVehicles = [];
  for (const v of pricedVehicles) {
    const r = computeVehicleSubtotal(v, zip, booking);
    if (!r.ok) return r;
    serviceSubtotal += r.subtotal;
    updatedVehicles.push({
      ...v,
      cat: r.cat,
      pkgId: r.pkgId,
      tierKey: r.tierKey,
      basePrice: r.basePrice,
      addonTotal: r.addonTotal,
      addons: r.addons,
      subtotal: r.subtotal,
    });
  }
  return { ok: true, serviceSubtotal, vehicles: updatedVehicles };
}

function validateAndRecalculateBookingPricing(booking) {
  const result = computeBookingServiceSubtotal(booking);
  if (!result.ok) return result;
  return {
    ok: true,
    serviceSubtotal: result.serviceSubtotal,
    vehicles: result.vehicles,
    clientTotal: Number(booking.totalPrice) || 0,
  };
}

/**
 * When category changes (trailer/RV → SUV/car), coerce package/tier/addons so
 * quoteService does not return invalid_pricing from leftover length packages.
 */
function coerceVehicleForCategory(vehicle, category, opts = {}) {
  const { normalizeLengthCategory } = require('./length-pricing');
  const cat = normalizeLengthCategory(category || vehicle?.category || vehicle?.cat || 'cars');
  const next = { ...(vehicle || {}), category: cat, cat };
  let pkgId = String(opts.packageId || next.packageId || next.pkgId || '').trim();
  let tierKey = String(opts.tierKey || opts.tier || next.tierKey || next.tier || '').trim();
  let lengthFt = Number(opts.lengthFt != null ? opts.lengthFt : next.lengthFt) || 0;

  if (cat === 'cars') {
    lengthFt = 0;
    const carPkgMap = {
      full_basic: 'full',
      maint_light: 'maint',
      essential: 'full',
      exterior: 'refresh',
    };
    if (carPkgMap[pkgId]) pkgId = carPkgMap[pkgId];
    const carPkgs = ['wash', 'maint', 'interior', 'full', 'refresh', 'premium'];
    if (!carPkgs.includes(pkgId)) pkgId = 'full';
    const tiers = PRICING.cars.tiers || {};
    if (!tierKey || !tiers[tierKey]) {
      const label = String(opts.tierLabel || next.tierLabel || opts.vehicleLabel || next.vehicleLabel || '').toLowerCase();
      if (/3[\s-]?row|suburban|tahoe|expedition|sequoia|pilot|pathfinder/.test(label)) tierKey = 'suv3';
      else if (/full.?size.?van.?passenger|passenger van/.test(label)) tierKey = 'full_size_van_passenger';
      else if (/midsize.?van|metris/.test(label)) tierKey = 'midsize_van';
      else if (/compact.?van|transit connect|promaster city|nv200|city express/.test(label)) tierKey = 'compact_van';
      else if (/full.?size.?van|sprinter|transit(?! connect)|promaster(?! city)|express van|savana|\bnv\b/.test(label)) tierKey = 'full_size_van';
      else if (
        !/semi|sleeper|day\s*cab|highway\s*tractor|freightliner|peterbilt|kenworth|cascadia|\bmack\b/.test(label) &&
        /truck|pickup|f-?150|silverado|ram|tundra|sierra/.test(label)
      ) tierKey = 'truck';
      else if (/suv|crossover|cx-|rav4|cr-v|highlander|explorer|4runner/.test(label)) tierKey = 'suv2';
      else if (/sedan|coupe|small|civic|corolla|camry|accord/.test(label)) tierKey = 'small';
      else tierKey = 'suv2';
    }
    next.rvType = '';
    next.typeKey = '';
    next.truckCab = '';
    const carAddonIds = new Set((PRICING.cars.addons || []).map((a) => a.id));
    const ids = asArray(opts.addOnIds || next.addOnIds).length
      ? asArray(opts.addOnIds || next.addOnIds)
      : asArray(next.addons).map((a) => a && a.id).filter(Boolean);
    const kept = ids.filter((id) => carAddonIds.has(id));
    next.addOnIds = kept;
    next.addons = kept.map((id) => {
      const prev = asArray(next.addons).find((a) => a && a.id === id);
      return prev || { id };
    });
  } else if (cat === 'trucks') {
    lengthFt = 0;
    const truckPkgs = ['interior', 'int_wash', 'int_wash_wax'];
    if (!truckPkgs.includes(pkgId)) pkgId = 'interior';
    const tiers = PRICING.trucks.tiers || {};
    if (!tierKey || !tiers[tierKey]) {
      const label = String(opts.tierLabel || next.tierLabel || opts.vehicleLabel || next.vehicleLabel || '').toLowerCase();
      if (/sleeper|sleep\s*cab|bunk/.test(label)) tierKey = 'sleeper_cab';
      else tierKey = 'day_cab';
    }
    next.rvType = '';
    next.typeKey = '';
    const truckAddonIds = new Set((PRICING.trucks.addons || []).map((a) => a.id));
    const ids = asArray(opts.addOnIds || next.addOnIds).length
      ? asArray(opts.addOnIds || next.addOnIds)
      : asArray(next.addons).map((a) => a && a.id).filter(Boolean);
    const kept = ids.filter((id) => truckAddonIds.has(id));
    next.addOnIds = kept;
    next.addons = kept.map((id) => {
      const prev = asArray(next.addons).find((a) => a && a.id === id);
      return prev || { id };
    });
  } else if (cat === 'boats' || cat === 'rvs') {
    if (!(lengthFt > 0)) lengthFt = LENGTH_PRICING[cat]?.defaultFt || 20;
    const lengthPkgs = Object.keys((LENGTH_PRICING[cat] && LENGTH_PRICING[cat].packages) || {});
    if (!lengthPkgs.includes(pkgId)) pkgId = cat === 'rvs' ? 'full_basic' : 'full';
    const catAddonIds = new Set((PRICING[cat].addons || []).map((a) => a.id));
    const ids = asArray(opts.addOnIds || next.addOnIds).length
      ? asArray(opts.addOnIds || next.addOnIds)
      : asArray(next.addons).map((a) => a && a.id).filter(Boolean);
    const kept = ids.filter((id) => catAddonIds.has(id));
    next.addOnIds = kept;
    next.addons = kept.map((id) => {
      const prev = asArray(next.addons).find((a) => a && a.id === id);
      return prev || { id };
    });
  }

  next.packageId = pkgId;
  next.pkgId = pkgId;
  if (opts.packageName) {
    next.packageName = opts.packageName;
    next.pkgName = opts.packageName;
  }
  next.tierKey = tierKey;
  next.tier = tierKey;
  if (opts.tierLabel) next.tierLabel = opts.tierLabel;
  else if (cat === 'cars' && PRICING.cars.tiers[tierKey]) {
    next.tierLabel = PRICING.cars.tiers[tierKey].label;
  } else if (cat === 'trucks' && PRICING.trucks.tiers[tierKey]) {
    next.tierLabel = PRICING.trucks.tiers[tierKey].label;
  }
  next.lengthFt = lengthFt;
  return next;
}

module.exports = {
  PRICING,
  POWERSPORTS_PUBLIC_TIER_KEYS,
  PACKAGE_INCLUDED_ADDONS,
  SEASONAL_DRIVEWAY_ADDONS,
  includedAddonIds,
  LENGTH_PRICING,
  RICH_ZIPS,
  getRichMultiplier,
  applyRichPrice,
  getLengthPrice,
  inferPkgId,
  resolveRvTypeKey,
  computeAddonTotal,
  computeVehicleSubtotal,
  computeBookingServiceSubtotal,
  validateAndRecalculateBookingPricing,
  vehiclesFromBooking,
  coerceVehicleForCategory,
};
