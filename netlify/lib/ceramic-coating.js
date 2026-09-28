'use strict';

/**
 * Ceramic Coating — server authority for packages, size-banded prices,
 * add-ons, stored eligibility answers, and appointment duration.
 *
 * Prices are never read from the browser. Vehicle size uses the existing
 * cars tier keys (small, suv2, suv3, truck, van tiers). This module does
 * not invent a second size classifier.
 *
 * Band map (canonical tier → product band):
 *   small                        compact/coupe/sedan
 *   suv2                         crossover/midsize SUV
 *   suv3, truck, compact_van,
 *   midsize_van                  large SUV / minivan / pickup
 *                                (minivans already price as suv3; compact and
 *                                midsize vans already price with that band)
 *   full_size_van_passenger      oversized passenger vehicle
 *   full_size_van (cargo)        not offered — commercial cargo is not a
 *                                passenger ceramic price
 * Semis, RVs, boats, buses, trailers, and powersports are not in this map.
 */

const PUBLIC_PACKAGE_NAMES = Object.freeze({
  ceramic_1yr: 'Professional Ceramic Protection — Up to 1 Year',
  ceramic_3yr: 'Professional Ceramic Protection — Up to 3 Years',
});

const PACKAGES = Object.freeze({
  ceramic_1yr: Object.freeze({
    id: 'ceramic_1yr',
    name: PUBLIC_PACKAGE_NAMES.ceramic_1yr,
    durationMonths: 12,
    depositDollars: 150,
    baseMinutes: 480,
    defaultCoatingId: 'gyeon_q2_cancot_evo',
  }),
  ceramic_3yr: Object.freeze({
    id: 'ceramic_3yr',
    name: PUBLIC_PACKAGE_NAMES.ceramic_3yr,
    durationMonths: 36,
    depositDollars: 250,
    baseMinutes: 600,
    defaultCoatingId: 'gyeon_q2_mohs_evo',
  }),
});

const TIER_BAND = Object.freeze({
  small: 'compact',
  suv2: 'crossover',
  suv3: 'large',
  truck: 'large',
  compact_van: 'large',
  midsize_van: 'large',
  full_size_van_passenger: 'oversized',
});

const BAND_LABEL = Object.freeze({
  compact: 'Compact / coupe / sedan',
  crossover: 'Crossover / midsize SUV',
  large: 'Large SUV / minivan / pickup',
  oversized: 'Oversized passenger vehicle',
});

const BASE_PRICES = Object.freeze({
  ceramic_1yr: Object.freeze({ compact: 650, crossover: 725, large: 825, oversized: 925 }),
  ceramic_3yr: Object.freeze({ compact: 1050, crossover: 1150, large: 1275, oversized: 1425 }),
});

const INCLUSIONS = Object.freeze([
  'Technical exterior wash',
  'Tar and iron decontamination',
  'Mechanical clay decontamination when required',
  'One-stage gloss-enhancement polish',
  'Panel-prep wipe',
  'Ceramic coating applied to painted exterior surfaces',
  'Normal cleaning of wheels, tires, and exterior glass',
  'Final inspection',
]);

const EXCLUSIONS = Object.freeze([
  'Interior detailing',
  'Engine bay',
  'Undercarriage',
  'Ceramic protection on wheels',
  'Ceramic protection on glass',
  'Ceramic protection on exterior trim',
  'Headlight restoration',
  'Deep paint correction',
  'Deep scratch removal',
  'Heavy water-spot removal',
  'Overspray, cement, severe sap, or extreme contamination',
  'Clear-coat repair or bodywork',
]);

const CURING_INSTRUCTIONS = Object.freeze([
  'Keep the vehicle dry for at least 12 hours.',
  'Do not wash for 7 days.',
  'Expected durability is up to the booked term and depends on maintenance and operating conditions.',
  'Ceramic coating protects the existing finish and does not repair damaged paint.',
]);

/**
 * Approved coatings. These names are internal. Public packages never include
 * the manufacturer, SKU, or product name.
 */
const INTERNAL_COATINGS = Object.freeze({
  gyeon_q2_cancot_evo: Object.freeze({
    id: 'gyeon_q2_cancot_evo',
    coatingManufacturer: 'GYEON',
    coatingProduct: 'Q² CanCoat EVO',
    internalSku: 'GYEON-Q2-CANCOAT-EVO',
    durabilityMonths: 12,
    cureRequirements: CURING_INSTRUCTIONS,
  }),
  gyeon_q2_mohs_evo: Object.freeze({
    id: 'gyeon_q2_mohs_evo',
    coatingManufacturer: 'GYEON',
    coatingProduct: 'Q² Mohs EVO',
    internalSku: 'GYEON-Q2-MOHS-EVO',
    durabilityMonths: 36,
    cureRequirements: CURING_INSTRUCTIONS,
  }),
});

const STAFF_PRODUCT_DISCLOSURE = 'If the customer asks which coating product will be used, answer with the assigned manufacturer and product. Brand-neutral public names are not permission to misrepresent the product.';

const PUBLIC_CURE_BRAND_BLOCK = Object.freeze([
  'gyeon',
  'cancot',
  'mohs',
  '9h',
  'scratch proof',
  'scratch-proof',
  'permanent protection',
  'guaranteed scratch',
  'manufacturer warranty',
]);

const PAINT_RESTORATION_PACKAGE_ID = 'premium';

/** Add-ons whose treatment is part of Ceramic Coating only. */
const CERAMIC_ADDONS = Object.freeze({
  ceramic_windshield: Object.freeze({
    id: 'ceramic_windshield',
    name: 'Windshield Ceramic Coating',
    price: 100,
    minutes: 30,
    description: 'Ceramic coating on the windshield only. Mutually exclusive with all-exterior-glass coating.',
  }),
  ceramic_glass_all: Object.freeze({
    id: 'ceramic_glass_all',
    name: 'All Exterior Glass Ceramic Coating',
    price: 175,
    minutes: 60,
    description: 'Ceramic coating on all exterior glass. Mutually exclusive with windshield-only coating.',
  }),
  ceramic_wheels: Object.freeze({
    id: 'ceramic_wheels',
    name: 'Wheel Face Ceramic Coating',
    price: 175,
    minutes: 60,
    description: 'Covers accessible exterior wheel faces only. Does not include wheel removal, barrels, or brake calipers.',
  }),
  ceramic_trim: Object.freeze({
    id: 'ceramic_trim',
    name: 'Exterior Plastic Trim Ceramic Coating',
    price: 125,
    minutes: 45,
    description: 'Ceramic coating on exterior plastic trim. Normal cleaning of trim is not this coating.',
  }),
  ceramic_lights: Object.freeze({
    id: 'ceramic_lights',
    name: 'Headlights & Taillights Ceramic Coating',
    price: 75,
    minutes: 20,
    description: 'Ceramic coating on headlights and taillights. Does not include sanding or restoration.',
  }),
  ceramic_correction: Object.freeze({
    id: 'ceramic_correction',
    name: 'Moderate Paint Correction Upgrade',
    price: 250,
    minutes: 120,
    description: 'Adds machine-polishing time. Does not promise 100% scratch removal or complete defect removal.',
  }),
});

const SIZE_ADDONS = Object.freeze({
  ceramic_waterspot: Object.freeze({
    id: 'ceramic_waterspot',
    name: 'Water Spot Removal',
    ceramicOnly: true,
    prices: Object.freeze({ compact: 125, crossover: 175, large: 225, oversized: 250 }),
    minutes: Object.freeze({ compact: 60, crossover: 90, large: 120, oversized: 120 }),
    description: 'Fixed preparation for water spots. Priced from the server vehicle class. Not a quote request.',
  }),
  ceramic_contamination: Object.freeze({
    id: 'ceramic_contamination',
    name: 'Heavy Sap/Contamination Removal',
    ceramicOnly: true,
    prices: Object.freeze({ compact: 100, crossover: 150, large: 200, oversized: 250 }),
    minutes: Object.freeze({ compact: 60, crossover: 90, large: 120, oversized: 120 }),
    description: 'Fixed preparation for heavy sap or contamination. Severe cases that fail eligibility are not booked as ceramic.',
  }),
  undercarriage: Object.freeze({
    id: 'undercarriage',
    name: 'Accessible Undercarriage Cleaning',
    global: true,
    prices: Object.freeze({ compact: 125, crossover: 150, large: 175, oversized: 225 }),
    minutes: Object.freeze({ compact: 45, crossover: 45, large: 60, oversized: 60 }),
    description: 'High-pressure rinse of accessible undercarriage areas for road salt, loose dirt, and surface contamination. Excludes vehicle lifting, disassembly, rust removal, rustproofing, and heavy mud.',
  }),
});

const FLAT_GLOBAL_ADDONS = Object.freeze({
  engine_bay: Object.freeze({
    id: 'engine_bay',
    name: 'Engine Bay Detail',
    price: 125,
    minutes: 45,
    global: true,
    description: 'Controlled low-moisture cleaning and dressing of accessible engine-bay surfaces. Excludes oil leaks, severe grease, mechanical repair, disassembly, and modified or exposed electrical systems.',
  }),
  mobile_water: Object.freeze({
    id: 'mobile_water',
    name: 'Mobile Water Supply',
    price: 50,
    minutes: 0,
    global: true,
    description: 'Historical mobile water supply line. New bookings do not add this fee from water access, and Ceramic Coating no longer requires it.',
  }),
  heavymud: Object.freeze({
    id: 'heavymud',
    name: 'Heavy Mud Removal',
    price: 75,
    minutes: 0,
    global: true,
    description: 'Packed mud removal starting at $75. May be combined with accessible undercarriage cleaning. Severe conditions may still need a photo review on non-ceramic services.',
  }),
});

/** Existing $45 engine-bay top clean. Kept; not redefined. */
const LEGACY_ENGINE_ADDON_ID = 'engine';

/** Companion service id. Price and inclusions stay in the canonical catalogs. */
const INTERIOR_SERVICE_ID = 'interior';
const INTERIOR_SERVICE_ALIAS = 'interior_detail';
const INTERIOR_SERVICE_NAME = 'Complete Interior Detail';
const SEQUENCING_NOTE = 'Complete Interior Detail before final panel prep and coating application to reduce dust, contact, and contamination risk.';

const INTERIOR_ONLY_ADDON_IDS = Object.freeze([
  'pethair',
  'odor',
  'superint',
  'mold',
  'sanitize',
  'biohazard',
  'floormats',
  'babyseat',
  'stroller',
]);
const EXTERIOR_PROTECTION_ADDON_IDS = Object.freeze(['wax1yr', 'polymer', 'claybar']);
const GENERAL_ADDON_IDS = Object.freeze(['engine', 'engine_bay', 'undercarriage', 'heavymud']);
const WATER_ADDON_ID = 'mobile_water';
const WATER_REPELLENT_ID = 'rainx';
const WATER_REPELLENT_NAME = 'Windshield Water-Repellent Treatment';
const WATER_REPELLENT_DESCRIPTION = 'Hydrophobic windshield treatment that improves water beading and visibility. This is not a ceramic coating.';
const WATER_REPELLENT_MINUTES = 15;
const GLASS_PROTECTION_IDS = Object.freeze(['rainx', 'ceramic_windshield', 'ceramic_glass_all']);
const SINGLE_SELECT_INTERIOR_IDS = Object.freeze(['pethair', 'odor']);

const GLOBAL_PACKAGE_IDS = Object.freeze([
  'wash', 'refresh', 'full', 'premium', 'ceramic_1yr', 'ceramic_3yr',
]);

const ELIGIBILITY_FIELDS = Object.freeze([
  'repainted60',
  'clearCoatFailing',
  'severeContamination',
  'matteWrapPpf',
  'coveredCureArea',
  'remainDry12h',
]);

function isCeramicPackage(packageId) {
  return Object.prototype.hasOwnProperty.call(PACKAGES, String(packageId || '').trim());
}

function packageDef(packageId) {
  return PACKAGES[String(packageId || '').trim()] || null;
}

function bandForTier(tierKey) {
  return TIER_BAND[String(tierKey || '').trim()] || null;
}

function tierPackagePrices(tierKey) {
  const band = bandForTier(tierKey);
  if (!band) return null;
  return {
    ceramic_1yr: BASE_PRICES.ceramic_1yr[band],
    ceramic_3yr: BASE_PRICES.ceramic_3yr[band],
  };
}

function basePriceFor(category, tierKey, packageId) {
  const id = String(packageId || '').trim();
  if (!isCeramicPackage(id)) return { ok: false, error: 'invalid_pricing' };
  if (String(category || '').trim() !== 'cars') {
    return {
      ok: false,
      error: 'ceramic_vehicle_ineligible',
      message: 'Ceramic Coating passenger pricing does not apply to commercial trucks, semis, RVs, buses, boats, trailers, or powersports.',
    };
  }
  const band = bandForTier(tierKey);
  if (!band) {
    return {
      ok: false,
      error: 'ceramic_vehicle_ineligible',
      tierKey: tierKey || null,
      message: 'This vehicle class is not eligible for instant passenger Ceramic Coating pricing.',
    };
  }
  return {
    ok: true,
    amount: BASE_PRICES[id][band],
    band,
    bandLabel: BAND_LABEL[band],
    tierKey: String(tierKey),
    packageId: id,
  };
}

function listPrice(def) {
  if (def.price != null) return def.price;
  return def.prices.compact;
}

function catalogAddonRows() {
  const rows = [];
  for (const def of Object.values(CERAMIC_ADDONS)) {
    rows.push({ id: def.id, price: def.price, name: def.name });
  }
  for (const def of Object.values(SIZE_ADDONS)) {
    rows.push({ id: def.id, price: listPrice(def), name: def.name });
  }
  for (const def of Object.values(FLAT_GLOBAL_ADDONS)) {
    rows.push({ id: def.id, price: def.price, name: def.name });
  }
  return rows;
}

function addonDef(id) {
  return CERAMIC_ADDONS[id] || SIZE_ADDONS[id] || FLAT_GLOBAL_ADDONS[id] || null;
}

function isCeramicAddonId(id) {
  return !!CERAMIC_ADDONS[id] || !!(SIZE_ADDONS[id] && SIZE_ADDONS[id].ceramicOnly);
}

function isKnownCeramicCatalogAddon(id) {
  return !!addonDef(id);
}

function globalPackageAllowed(packageId) {
  return GLOBAL_PACKAGE_IDS.includes(String(packageId || '').trim());
}

function priceAndMinutesForAddon(id, band) {
  const ceramic = CERAMIC_ADDONS[id];
  if (ceramic) return { price: ceramic.price, minutes: ceramic.minutes, name: ceramic.name };
  const sized = SIZE_ADDONS[id];
  if (sized) {
    if (!band || sized.prices[band] == null) return null;
    return { price: sized.prices[band], minutes: sized.minutes[band], name: sized.name };
  }
  const flat = FLAT_GLOBAL_ADDONS[id];
  if (flat) return { price: flat.price, minutes: flat.minutes, name: flat.name };
  return null;
}

/**
 * Resolve one add-on against the server catalog.
 * handled:false means the caller should keep the normal flat catalog price.
 */
function waterRepellentOffer() {
  const row = (catalogPricing().PRICING?.cars?.addons || []).find((addon) => addon.id === WATER_REPELLENT_ID);
  const price = row ? Number(row.price) : NaN;
  if (!(price > 0)) return null;
  return {
    id: WATER_REPELLENT_ID,
    name: WATER_REPELLENT_NAME,
    price,
    minutes: WATER_REPELLENT_MINUTES,
    description: WATER_REPELLENT_DESCRIPTION,
    nonCeramic: true,
  };
}

function filterAddonsForCeramicAdmin(rows) {
  const blocked = exteriorProtectionSet();
  return (Array.isArray(rows) ? rows : []).filter((row) => row && !blocked.has(row.id) && row.id !== WATER_ADDON_ID);
}

function resolveAddonPrice(id, vehicle) {
  const addonId = String(id || '').trim();
  const pkgId = String(vehicle?.pkgId || vehicle?.packageId || '').trim();
  const ceramic = isCeramicPackage(pkgId);
  if (addonId === WATER_REPELLENT_ID && ceramic) {
    const offer = waterRepellentOffer();
    if (!offer) return { handled: true, ok: false, error: 'invalid_pricing', addonId };
    return { handled: true, ok: true, ...offer };
  }
  if (!isKnownCeramicCatalogAddon(addonId)) return { handled: false };
  const cat = String(vehicle?.cat || vehicle?.category || '').trim();
  const tierKey = String(vehicle?.tierKey || vehicle?.tier || '').trim();

  // Powersports and fleet already price Heavy Mud Removal. Do not replace those catalogs.
  if (addonId === 'heavymud' && cat !== 'cars') return { handled: false };

  if (cat !== 'cars') {
    return {
      handled: true,
      ok: false,
      error: 'ceramic_addon_vehicle_ineligible',
      addonId,
    };
  }

  if (isCeramicAddonId(addonId) && !ceramic) {
    return { handled: true, ok: false, error: 'incompatible_addon', addonId };
  }
  if ((addonDef(addonId) || {}).global && !globalPackageAllowed(pkgId)) {
    return { handled: true, ok: false, error: 'incompatible_addon', addonId };
  }
  if (addonId === LEGACY_ENGINE_ADDON_ID) return { handled: false };

  const band = bandForTier(tierKey);
  if ((SIZE_ADDONS[addonId] || CERAMIC_ADDONS[addonId] || FLAT_GLOBAL_ADDONS[addonId]) && !band && SIZE_ADDONS[addonId]) {
    return { handled: true, ok: false, error: 'ceramic_vehicle_ineligible', addonId };
  }
  const priced = priceAndMinutesForAddon(addonId, band);
  if (!priced) return { handled: true, ok: false, error: 'invalid_pricing', addonId };
  return { handled: true, ok: true, ...priced, id: addonId };
}

function selectedIds(addons) {
  return (Array.isArray(addons) ? addons : []).map((a) => String(a && a.id || '').trim()).filter(Boolean);
}

function interiorAddonSet() {
  return new Set(INTERIOR_ONLY_ADDON_IDS);
}

function exteriorProtectionSet() {
  return new Set(EXTERIOR_PROTECTION_ADDON_IDS);
}

function generalAddonSet() {
  return new Set([...GENERAL_ADDON_IDS, WATER_ADDON_ID, LEGACY_ENGINE_ADDON_ID]);
}

function companionInteriorSelected(vehicle) {
  if (!vehicle || typeof vehicle !== 'object') return false;
  if (vehicle.companionInterior === true || vehicle.companionInterior === 'true' || vehicle.companionInterior === 1) {
    return true;
  }
  const bags = [vehicle.companionServices, vehicle.serviceIds];
  for (const bag of bags) {
    if (!Array.isArray(bag)) continue;
    if (bag.some((entry) => {
      const id = typeof entry === 'string'
        ? entry
        : (entry && (entry.serviceId || entry.canonicalServiceId || entry.id));
      return id === INTERIOR_SERVICE_ID || id === INTERIOR_SERVICE_ALIAS;
    })) return true;
  }
  return false;
}

function catalogPricing() {
  return require('./booking-price-catalog');
}

function interiorScheduleMinutes() {
  const catalog = catalogPricing();
  return {
    service: Number(catalog.PACKAGE_SERVICE_MINUTES?.cars?.interior) || 0,
    addons: catalog.INTERIOR_ADDON_MINUTES || {},
  };
}

function interiorLineInclusions() {
  const catalog = require('./canonical-package-catalog');
  return Array.isArray(catalog.INTERIOR_SERVICE_INCLUSIONS)
    ? catalog.INTERIOR_SERVICE_INCLUSIONS.slice()
    : [];
}

function centsFromDollars(value) {
  return Math.round((Number(value) || 0) * 100);
}

/**
 * Interior Detail price from the cars tier catalog. Ceramic packages do not
 * store a copy of this amount.
 */
function resolveCompanionInterior(vehicle) {
  const pkgId = String(vehicle?.pkgId || vehicle?.packageId || '').trim();
  if (!isCeramicPackage(pkgId)) return { ok: true, selected: false, price: 0 };
  if (!companionInteriorSelected(vehicle)) return { ok: true, selected: false, price: 0 };
  const tierKey = String(vehicle?.tierKey || vehicle?.tier || '').trim();
  const tier = catalogPricing().PRICING?.cars?.tiers?.[tierKey];
  const price = tier ? Number(tier.interior) : 0;
  if (!(price > 0)) {
    return {
      ok: false,
      error: 'invalid_pricing',
      message: 'Complete Interior Detail is not priced for this vehicle class.',
    };
  }
  return {
    ok: true,
    selected: true,
    price,
    serviceId: INTERIOR_SERVICE_ID,
    canonicalServiceId: INTERIOR_SERVICE_ID,
    name: INTERIOR_SERVICE_NAME,
  };
}

function addonUnits(addon) {
  return Math.max(1, Math.round(Number(addon?.qty) || 1));
}

function validateAddonSet(vehicle) {
  const addons = Array.isArray(vehicle?.addons) ? vehicle.addons : [];
  const ids = selectedIds(addons);
  const pkgId = String(vehicle?.pkgId || vehicle?.packageId || '').trim();
  const ceramic = isCeramicPackage(pkgId);
  const companion = companionInteriorSelected(vehicle);
  if (ceramic) {
    if (ids.includes(INTERIOR_SERVICE_ID) || ids.includes(INTERIOR_SERVICE_ALIAS)) {
      return {
        ok: false,
        error: 'duplicated_interior',
        message: 'Complete Interior Detail is a companion service, not a second add-on.',
      };
    }
    const interiorIds = interiorAddonSet();
    const protectionIds = exteriorProtectionSet();
    const generalIds = generalAddonSet();
    for (const id of ids) {
      if (protectionIds.has(id)) {
        return { ok: false, error: 'incompatible_addon', addonId: id };
      }
      if (id === WATER_REPELLENT_ID) continue;
      if (interiorIds.has(id)) {
        if (!companion) {
          return {
            ok: false,
            error: 'interior_addon_requires_service',
            addonId: id,
            message: 'Interior add-ons require Complete Interior Detail on the same vehicle.',
          };
        }
        continue;
      }
      if (isCeramicAddonId(id) || generalIds.has(id)) continue;
      if (isKnownCeramicCatalogAddon(id)) continue;
      return { ok: false, error: 'incompatible_addon', addonId: id };
    }
    for (const id of SINGLE_SELECT_INTERIOR_IDS) {
      const matches = addons.filter((addon) => addon && addon.id === id);
      const units = matches.reduce((sum, addon) => sum + addonUnits(addon), 0);
      if (matches.length > 1 || units > 1) {
        return {
          ok: false,
          error: 'duplicated_interior_addon',
          addonId: id,
          message: 'Pet hair removal and odor treatment can be selected once.',
        };
      }
    }
  }
  const selectedGlass = GLASS_PROTECTION_IDS.filter((id) => ids.includes(id));
  if (selectedGlass.length > 1) {
    return {
      ok: false,
      error: 'ceramic_glass_mutually_exclusive',
      addonIds: selectedGlass,
      message: 'Choose one glass protection option. Windshield water-repellent treatment, windshield ceramic coating, and all exterior glass ceramic coating cannot be combined.',
    };
  }
  if (ids.includes(LEGACY_ENGINE_ADDON_ID) && ids.includes('engine_bay')) {
    return {
      ok: false,
      error: 'engine_addon_mutually_exclusive',
      message: 'Choose Engine Bay Top Clean or Engine Bay Detail, not both.',
    };
  }
  if (!ceramic && ids.includes('mobile_water') && !ids.includes('undercarriage')) {
    return { ok: false, error: 'mobile_water_requires_undercarriage' };
  }
  if (!ceramic) {
    for (const id of ids) {
      if (isCeramicAddonId(id)) return { ok: false, error: 'incompatible_addon', addonId: id };
    }
  }
  return { ok: true };
}

function durationForVehicle(vehicle) {
  const pkg = packageDef(vehicle?.pkgId || vehicle?.packageId);
  if (!pkg) return { ok: true, minutes: 0 };
  const band = bandForTier(vehicle?.tierKey || vehicle?.tier);
  const schedule = interiorScheduleMinutes();
  const companion = companionInteriorSelected(vehicle);
  let ceramicMinutes = pkg.baseMinutes;
  let interiorMinutes = companion ? schedule.service : 0;
  for (const addon of (Array.isArray(vehicle?.addons) ? vehicle.addons : [])) {
    const id = String(addon && addon.id || '').trim();
    if (!id) continue;
    const units = addonUnits(addon);
    if (id === WATER_REPELLENT_ID) {
      const offer = waterRepellentOffer();
      if (offer) ceramicMinutes += offer.minutes * units;
      continue;
    }
    const priced = priceAndMinutesForAddon(id, band);
    if (priced) {
      ceramicMinutes += priced.minutes * units;
      continue;
    }
    if (companion && schedule.addons[id]) interiorMinutes += schedule.addons[id] * units;
  }
  return {
    ok: true,
    minutes: ceramicMinutes + interiorMinutes,
    ceramicMinutes,
    interiorMinutes,
    companionInterior: companion,
  };
}

function priorCompletion(vehicle, serviceId) {
  const lines = Array.isArray(vehicle?.serviceLineItems) ? vehicle.serviceLineItems : [];
  const found = lines.find((line) => line && (line.serviceId === serviceId || line.canonicalServiceId === serviceId));
  if (found && found.completionStatus === 'completed') {
    return { completionStatus: 'completed', completedAt: found.completedAt || null };
  }
  return { completionStatus: 'pending', completedAt: null };
}

function addonMoney(addons, allowed) {
  let cents = 0;
  const ids = [];
  for (const addon of addons) {
    const id = String(addon && addon.id || '').trim();
    if (!id || !allowed.has(id)) continue;
    if (!ids.includes(id)) ids.push(id);
    cents += centsFromDollars((Number(addon.price) || 0) * addonUnits(addon));
  }
  return { cents, ids };
}

function buildVehicleServiceLines(vehicle, pkg, priced) {
  const addons = Array.isArray(vehicle.addons) ? vehicle.addons : [];
  const duration = durationForVehicle(vehicle);
  const ceramicAddonIds = new Set([
    ...Object.keys(CERAMIC_ADDONS),
    ...Object.keys(SIZE_ADDONS).filter((id) => SIZE_ADDONS[id].ceramicOnly),
    ...GENERAL_ADDON_IDS,
    LEGACY_ENGINE_ADDON_ID,
    WATER_REPELLENT_ID,
  ]);
  const ceramicAddons = addonMoney(addons, ceramicAddonIds);
  const interiorAddons = addonMoney(addons, interiorAddonSet());
  const companion = resolveCompanionInterior(vehicle);
  const ceramicCompletion = priorCompletion(vehicle, pkg.id);
  const lines = [{
    serviceId: pkg.id,
    canonicalServiceId: pkg.id,
    name: pkg.name,
    price: priced.amount,
    priceCents: centsFromDollars(priced.amount),
    durationMinutes: duration.ceramicMinutes,
    inclusions: INCLUSIONS.slice(),
    addonIds: ceramicAddons.ids,
    compatibleAddons: [...ceramicAddonIds, WATER_ADDON_ID].filter((id) => !exteriorProtectionSet().has(id)),
    financialAllocationCents: centsFromDollars(priced.amount) + ceramicAddons.cents,
    completionStatus: ceramicCompletion.completionStatus,
    completedAt: ceramicCompletion.completedAt,
  }];
  if (companion.selected) {
    const interiorCompletion = priorCompletion(vehicle, INTERIOR_SERVICE_ID);
    lines.push({
      serviceId: INTERIOR_SERVICE_ID,
      canonicalServiceId: INTERIOR_SERVICE_ID,
      alias: INTERIOR_SERVICE_ALIAS,
      name: INTERIOR_SERVICE_NAME,
      price: companion.price,
      priceCents: centsFromDollars(companion.price),
      durationMinutes: duration.interiorMinutes,
      inclusions: interiorLineInclusions(),
      addonIds: interiorAddons.ids,
      compatibleAddons: INTERIOR_ONLY_ADDON_IDS.slice(),
      financialAllocationCents: centsFromDollars(companion.price) + interiorAddons.cents,
      completionStatus: interiorCompletion.completionStatus,
      completedAt: interiorCompletion.completedAt,
    });
  }
  return lines;
}

function yesNo(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'yes' || v === 'true') return 'yes';
  if (v === 'no' || v === 'false') return 'no';
  return '';
}

function normalizeEligibilityAnswers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const answers = {};
  let any = false;
  for (const field of ELIGIBILITY_FIELDS) {
    const value = yesNo(raw[field]);
    if (!value) continue;
    answers[field] = value;
    any = true;
  }
  return any ? answers : null;
}

/**
 * Keep yes/no answers already collected. Missing or historically blocking
 * answers do not close checkout and do not mark the vehicle approved.
 */
function evaluateEligibility(raw) {
  return {
    ok: true,
    answers: normalizeEligibilityAnswers(raw),
    warnings: [],
  };
}

function stripRetiredCeramicWaterFee(vehicle) {
  if (!vehicle || !isCeramicPackage(vehicle.pkgId || vehicle.packageId)) return vehicle;
  if (Array.isArray(vehicle.addons)) {
    vehicle.addons = vehicle.addons.filter((addon) => String(addon && addon.id || '') !== WATER_ADDON_ID);
  }
  delete vehicle.ceramicWaterSupply;
  delete vehicle.waterSupply;
  return vehicle;
}

/**
 * Keep a deposit or prepay obligation that is already stored.
 * A new request cannot create one, and omitting the plan does not erase it.
 */
function retainStoredCeramicPayment(booking, existing) {
  if (!booking || booking.serviceFamily !== 'ceramic_coating' || !booking.ceramic) return booking;
  const plan = normalizePaymentPlan(
    existing && (existing.ceramicPaymentPlan || (existing.ceramic && existing.ceramic.paymentPlan))
  );
  if (!plan) {
    booking.ceramicPaymentPlan = null;
    booking.depositAmount = 0;
    booking.ceramic.paymentPlan = null;
    booking.ceramic.depositAmount = 0;
    booking.ceramic.chargeAmount = 0;
    return booking;
  }
  const depositAmount = existing.depositAmount != null ? Number(existing.depositAmount) : 0;
  const chargeAmount = existing.ceramic && existing.ceramic.chargeAmount != null
    ? Number(existing.ceramic.chargeAmount)
    : (plan === 'deposit' ? depositAmount : Number(existing.approvedFinalAmount || booking.approvedFinalAmount || 0));
  booking.ceramicPaymentPlan = plan;
  booking.depositAmount = depositAmount;
  booking.ceramic.paymentPlan = plan;
  booking.ceramic.depositAmount = existing.ceramic && existing.ceramic.depositAmount != null
    ? Number(existing.ceramic.depositAmount)
    : depositAmount;
  booking.ceramic.chargeAmount = chargeAmount;
  if (existing.ceramic && existing.ceramic.depositsEnabled != null) {
    booking.ceramic.depositsEnabled = existing.ceramic.depositsEnabled;
  }
  return booking;
}

/**
 * Reconstruct a stored deposit or prepay so later collection still matches
 * the original obligation. Public checkout does not call this.
 */
function stampStoredCeramicChargePlan(booking, plan, env = process.env) {
  const normalized = normalizePaymentPlan(plan);
  if (!booking || booking.serviceFamily !== 'ceramic_coating' || !booking.ceramic) {
    return { ok: false, error: 'ceramic_booking_required' };
  }
  if (!normalized) return { ok: false, error: 'ceramic_payment_plan_required' };
  if (normalized === 'deposit' && !depositsEnabled(env)) {
    return {
      ok: false,
      error: 'ceramic_deposit_disabled',
      message: 'Reserve with Deposit is temporarily unavailable. Prepay in Full is still available.',
      depositsEnabled: false,
    };
  }
  const approved = Math.round((Number(booking.approvedFinalAmount) || 0) * 100) / 100;
  const depositAmount = normalized === 'deposit'
    ? depositCentsForApproved(booking.ceramic.packageId, approved) / 100
    : 0;
  if (normalized === 'deposit' && !(depositAmount > 0 && depositAmount < approved)) {
    return { ok: false, error: 'ceramic_deposit_invalid' };
  }
  const chargeAmount = normalized === 'deposit' ? depositAmount : approved;
  booking.ceramicPaymentPlan = normalized;
  booking.depositAmount = depositAmount;
  booking.ceramic.paymentPlan = normalized;
  booking.ceramic.depositAmount = depositAmount;
  booking.ceramic.chargeAmount = chargeAmount;
  booking.ceramic.depositsEnabled = depositsEnabled(env);
  return { ok: true, booking };
}

const CERAMIC_NEW_BOOKING_METHODS = new Set(['cash_onsite', 'card_onsite', 'online_after_service']);

/**
 * New Ceramic reservations offer card online charged after service, card at
 * service, or cash at service. None of those collects a deposit or prepay.
 * A stored deposit or prepay plan keeps the payment path it already had.
 */
function ceramicPayAtServiceViolation(booking, existing, { finalize = false } = {}) {
  if (!booking || booking.serviceFamily !== 'ceramic_coating') return null;
  const storedPlan = normalizePaymentPlan(
    existing && (existing.ceramicPaymentPlan || (existing.ceramic && existing.ceramic.paymentPlan))
  );
  if (storedPlan) return null;
  const preference = String(
    booking.paymentMethodPreference || (existing && existing.paymentMethodPreference) || ''
  ).trim();
  if (!preference && !finalize) return null;
  if (CERAMIC_NEW_BOOKING_METHODS.has(preference)) return null;
  return {
    ok: false,
    error: preference ? 'ceramic_payment_method_unavailable' : 'ceramic_payment_preference_required',
    message: 'Choose card online charged after service, card at service, or cash at service. Nothing is charged to reserve.',
  };
}

function retainStoredCeramicEligibility(booking, existing) {
  if (!booking || !booking.ceramic) return booking;
  const incoming = normalizeEligibilityAnswers(
    booking.ceramicEligibility || booking.ceramic.eligibility
  );
  const stored = normalizeEligibilityAnswers(existing && existing.ceramic && existing.ceramic.eligibility);
  booking.ceramic.eligibility = incoming || stored || null;
  if (!incoming && stored && Array.isArray(existing.ceramic.warnings)) {
    booking.ceramic.warnings = existing.ceramic.warnings.slice();
  }
  delete booking.ceramic.technicalApproval;
  delete booking.ceramic.technicallyApproved;
  delete booking.vehicleTechnicallyApproved;
  return booking;
}

function depositsEnabled(env = process.env) {
  const flag = String(env.CD1_CERAMIC_DEPOSITS ?? '1').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off');
}

function normalizePaymentPlan(value) {
  const plan = String(value || '').trim();
  if (plan === 'prepay_full' || plan === 'deposit') return plan;
  return '';
}

function depositDollarsForPackage(packageId) {
  const pkg = packageDef(packageId);
  return pkg ? pkg.depositDollars : 0;
}

/**
 * Deposit is the greater of 25% of the approved total and the package minimum.
 * Rounded to whole cents. The minimums are $150 (1-year) and $250 (3-year).
 */
function depositCentsForApproved(packageId, approvedDollars) {
  const approvedCents = Math.max(0, centsFromDollars(approvedDollars));
  const percent = Math.round(approvedCents * 25 / 100);
  const minimum = centsFromDollars(depositDollarsForPackage(packageId));
  return Math.max(percent, minimum);
}

function coatingById(productId) {
  return INTERNAL_COATINGS[String(productId || '').trim()] || null;
}

function expectedDurabilityLabel(durationMonths) {
  const months = Math.round(Number(durationMonths) || 0);
  if (months === 12) return 'up to 1 year';
  if (months === 36) return 'up to 3 years';
  if (months > 0) return `up to ${months} months`;
  return '';
}

function optionalText(value, max) {
  if (value == null || value === '') return null;
  const text = String(value).replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
}

function normalizeCureRequirements(value) {
  const rows = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/\n+/) : []);
  return rows
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 12);
}

function cureLeaksBrand(lines) {
  const blob = lines.join(' ').toLowerCase();
  return PUBLIC_CURE_BRAND_BLOCK.some((needle) => blob.includes(needle));
}

function catalogChoices(packageId) {
  const pkg = packageDef(packageId);
  const sold = pkg ? pkg.durationMonths : 0;
  return Object.values(INTERNAL_COATINGS).map((product) => ({
    productId: product.id,
    coatingManufacturer: product.coatingManufacturer,
    coatingProduct: product.coatingProduct,
    internalSku: product.internalSku,
    durabilityMonths: product.durabilityMonths,
    compatible: product.durabilityMonths >= sold,
  }));
}

function isAdminActor(actor) {
  const role = String(actor?.role || actor?.actorRole || '').trim().toLowerCase();
  const id = String(actor?.id || actor?.actorId || actor?.email || '').trim();
  return role === 'admin' && !!id;
}

function buildInternalRecord(product, pkg, extras, auditHistory) {
  const cure = normalizeCureRequirements(extras.cureRequirements || product.cureRequirements);
  return {
    coatingManufacturer: product.coatingManufacturer,
    coatingProduct: product.coatingProduct,
    internalSku: product.internalSku,
    productId: product.id,
    durabilityMonths: product.durabilityMonths,
    batchOrLotNumber: optionalText(extras.batchOrLotNumber, 80),
    bottleOpenedAt: optionalText(extras.bottleOpenedAt, 40),
    expirationDate: optionalText(extras.expirationDate, 40),
    applicationDate: optionalText(extras.applicationDate, 40),
    installer: optionalText(extras.installer, 80),
    cureRequirements: cure,
    internalNotes: optionalText(extras.internalNotes, 2000) || '',
    discloseOnReceipt: extras.discloseOnReceipt === true,
    disclosureBasis: extras.discloseOnReceipt === true
      ? (extras.disclosureBasis || 'admin_selected')
      : null,
    staffDisclosure: STAFF_PRODUCT_DISCLOSURE,
    compatibleWithSoldDuration: product.durabilityMonths >= pkg.durationMonths,
    availableProducts: catalogChoices(pkg.id),
    auditHistory,
  };
}

function initialInternalRecord(pkg, nowIso) {
  const product = coatingById(pkg.defaultCoatingId);
  return buildInternalRecord(product, pkg, {
    cureRequirements: product.cureRequirements,
    discloseOnReceipt: false,
  }, [{
    at: nowIso,
    action: 'initial_assignment',
    actorRole: 'system',
    actorId: 'ceramic-coating',
    packageId: pkg.id,
    publicPackageName: pkg.name,
    productId: product.id,
    durabilityMonths: product.durabilityMonths,
    soldDurationMonths: pkg.durationMonths,
  }]);
}

/**
 * Stamp server-owned ceramic fields onto a booking after catalog pricing.
 * Does not read client totals. Callers still compare client totalPrice separately.
 */
function applyCeramicBooking(booking, { finalize = false, env = process.env } = {}) {
  const vehicles = Array.isArray(booking?.vehicles) ? booking.vehicles : [];
  const ceramicVehicles = vehicles.filter((v) => isCeramicPackage(v?.pkgId || v?.packageId));
  if (!ceramicVehicles.length) return { ok: true, ceramic: false };

  if (ceramicVehicles.length !== vehicles.length) {
    return {
      ok: false,
      error: 'ceramic_mixed_cart',
      message: 'Ceramic Coating is booked on its own. Remove other service packages from this appointment.',
    };
  }

  const incomingEligibility = normalizeEligibilityAnswers(booking.ceramicEligibility);
  const storedEligibility = normalizeEligibilityAnswers(booking.ceramic && booking.ceramic.eligibility);
  const eligibilityAnswers = incomingEligibility || storedEligibility || null;
  const eligibilityWarnings = (!incomingEligibility && storedEligibility && Array.isArray(booking.ceramic?.warnings))
    ? booking.ceramic.warnings.slice()
    : [];

  let durationMinutes = 0;
  const stampedVehicles = [];
  delete booking.ceramicWaterSupply;
  delete booking.ceramicPaymentPlan;
  delete booking.paymentPlan;
  for (const vehicle of vehicles) {
    stripRetiredCeramicWaterFee(vehicle);
    const pkgId = String(vehicle.pkgId || vehicle.packageId || '').trim();
    const priced = basePriceFor(vehicle.cat || vehicle.category, vehicle.tierKey || vehicle.tier, pkgId);
    if (!priced.ok) return priced;
    const setCheck = validateAddonSet(vehicle);
    if (!setCheck.ok) return setCheck;
    const duration = durationForVehicle(vehicle);
    durationMinutes += duration.minutes;
    const pkg = packageDef(pkgId);
    const companion = resolveCompanionInterior(vehicle);
    if (!companion.ok) return companion;
    vehicle.pkgName = pkg.name;
    vehicle.packageName = pkg.name;
    vehicle.companionInterior = companion.selected;
    vehicle.companionInteriorPrice = companion.selected ? companion.price : 0;
    vehicle.serviceLineItems = buildVehicleServiceLines(vehicle, pkg, priced);
    delete vehicle.product;
    stampedVehicles.push({
      packageId: pkgId,
      packageName: pkg.name,
      durationMonths: pkg.durationMonths,
      expectedDurability: expectedDurabilityLabel(pkg.durationMonths),
      tierKey: priced.tierKey,
      sizeBand: priced.band,
      sizeLabel: priced.bandLabel,
      basePrice: priced.amount,
      companionInterior: companion.selected,
      companionInteriorPrice: vehicle.companionInteriorPrice,
      serviceLineItems: vehicle.serviceLineItems,
    });
  }

  const primary = packageDef(ceramicVehicles[0].pkgId || ceramicVehicles[0].packageId);
  // New reservations are pay-at-service. A browser deposit or prepay choice
  // does not create an amount due today. Stored plans are restored later.
  const plan = '';
  const serviceDollars = vehicles.reduce((sum, v) => sum + (Number(v.subtotal) || 0), 0);
  const travel = Math.round((Number(booking.travelFeeAmount) || 0) * 100) / 100;
  const approved = Math.round((serviceDollars + travel) * 100) / 100;
  const depositAmount = 0;
  const chargeAmount = 0;

  const settledCents = (Array.isArray(booking.ledger?.entries) ? booking.ledger.entries : [])
    .filter((entry) => entry && entry.kind === 'settlement')
    .reduce((sum, entry) => sum + Math.max(0, Math.round(Number(entry.amountCents) || 0)), 0);
  const assignedAt = new Date().toISOString();
  const internal = initialInternalRecord(primary, assignedAt);
  booking.serviceFamily = 'ceramic_coating';
  booking.package = primary.name;
  booking.packageName = primary.name;
  booking.serviceLabel = primary.name;
  if (typeof booking.service !== 'object' || booking.service == null) booking.service = primary.name;
  const serviceLineItems = vehicles.flatMap((vehicle) => vehicle.serviceLineItems || []);
  const companionInterior = serviceLineItems.some((line) => line.serviceId === INTERIOR_SERVICE_ID);
  booking.companionInterior = companionInterior;
  booking.opsSequencingNote = companionInterior ? SEQUENCING_NOTE : null;
  booking.appointmentDurationMinutes = durationMinutes;
  booking.depositAmount = depositAmount;
  booking.ceramicPaymentPlan = plan || null;
  booking.approvedFinalAmount = approved;
  booking.totalPrice = approved;
  // Captured money comes only from ledger settlements, never from the browser.
  booking.amountPaid = Math.round(settledCents) / 100;
  booking.paidAmount = booking.amountPaid;
  booking.balanceDue = Math.round((approved - booking.amountPaid) * 100) / 100;
  if (booking.balanceDue < 0) return { ok: false, error: 'ceramic_balance_invalid' };
  if (!booking.paymentStatus || booking.paymentStatus === 'paid') {
    booking.paymentStatus = booking.amountPaid <= 0
      ? 'unpaid'
      : (booking.balanceDue === 0 ? 'paid' : 'partially_paid');
  }
  booking.ceramic = {
    serviceFamily: 'ceramic_coating',
    packages: stampedVehicles,
    packageId: primary.id,
    packageName: primary.name,
    durationMonths: primary.durationMonths,
    expectedDurability: expectedDurabilityLabel(primary.durationMonths),
    inclusions: INCLUSIONS.slice(),
    exclusions: EXCLUSIONS.slice(),
    curingInstructions: internal.cureRequirements.slice(),
    eligibility: eligibilityAnswers,
    warnings: eligibilityWarnings,
    appointmentDurationMinutes: durationMinutes,
    paymentPlan: plan || null,
    depositAmount,
    chargeAmount,
    depositsEnabled: depositsEnabled(env),
    paintRestorationPackageId: PAINT_RESTORATION_PACKAGE_ID,
    companionInterior,
    serviceLineItems,
    sequencingNote: companionInterior ? SEQUENCING_NOTE : null,
    internal,
  };
  return { ok: true, ceramic: true, booking };
}

/**
 * Replace the assigned coating without changing the public package.
 * Requires an admin actor, a product whose documented durability is at least
 * the sold term, and updated cure instructions. Appends audit history.
 */
function assignInternalCoating(booking, input = {}, actor = null) {
  if (!booking || booking.serviceFamily !== 'ceramic_coating' || !booking.ceramic) {
    return { ok: false, error: 'ceramic_booking_required' };
  }
  if (!isAdminActor(actor)) {
    return {
      ok: false,
      error: 'ceramic_product_change_unauthorized',
      message: 'Changing the assigned coating requires Admin authorization.',
    };
  }
  const packageId = booking.ceramic.packageId
    || booking.ceramic.packages?.[0]?.packageId
    || '';
  const pkg = packageDef(packageId);
  if (!pkg) return { ok: false, error: 'ceramic_package_required' };
  const product = coatingById(input.productId);
  if (!product) return { ok: false, error: 'ceramic_product_unknown' };
  if (product.durabilityMonths < pkg.durationMonths) {
    return {
      ok: false,
      error: 'ceramic_product_durability_insufficient',
      message: 'The assigned coating durability is below the duration sold.',
      soldDurationMonths: pkg.durationMonths,
      productDurabilityMonths: product.durabilityMonths,
    };
  }
  const cureRequirements = normalizeCureRequirements(input.cureRequirements);
  if (!cureRequirements.length) {
    return {
      ok: false,
      error: 'ceramic_cure_required',
      message: 'Updated cure instructions are required when the assigned coating changes.',
    };
  }
  if (cureLeaksBrand(cureRequirements)) {
    return {
      ok: false,
      error: 'ceramic_cure_brand_leak',
      message: 'Cure instructions shown to customers stay brand-neutral. Put manufacturer detail in internal notes.',
    };
  }
  const previous = booking.ceramic.internal || {};
  const disclose = input.discloseOnReceipt === true || input.legallyRequired === true;
  const auditHistory = Array.isArray(previous.auditHistory) ? previous.auditHistory.slice() : [];
  auditHistory.push({
    at: new Date().toISOString(),
    action: 'internal_product_change',
    actorRole: 'admin',
    actorId: String(actor.id || actor.actorId || actor.email),
    packageId: pkg.id,
    publicPackageName: pkg.name,
    fromProductId: previous.productId || null,
    toProductId: product.id,
    fromDurabilityMonths: previous.durabilityMonths || null,
    toDurabilityMonths: product.durabilityMonths,
    soldDurationMonths: pkg.durationMonths,
    cureRequirements,
    discloseOnReceipt: disclose,
  });
  const internal = buildInternalRecord(product, pkg, {
    batchOrLotNumber: input.batchOrLotNumber,
    bottleOpenedAt: input.bottleOpenedAt,
    expirationDate: input.expirationDate,
    applicationDate: input.applicationDate,
    installer: input.installer,
    cureRequirements,
    internalNotes: input.internalNotes,
    discloseOnReceipt: disclose,
    disclosureBasis: input.legallyRequired === true ? 'legally_required' : (disclose ? 'admin_selected' : null),
  }, auditHistory);
  booking.package = pkg.name;
  booking.packageName = pkg.name;
  booking.serviceLabel = pkg.name;
  if (typeof booking.service !== 'object' || booking.service == null) booking.service = pkg.name;
  booking.ceramic.packageId = pkg.id;
  booking.ceramic.packageName = pkg.name;
  booking.ceramic.durationMonths = pkg.durationMonths;
  booking.ceramic.expectedDurability = expectedDurabilityLabel(pkg.durationMonths);
  booking.ceramic.curingInstructions = cureRequirements.slice();
  booking.ceramic.internal = internal;
  delete booking.ceramic.product;
  return { ok: true, booking };
}

function isStaffActor(actor) {
  const role = String(actor?.role || actor?.actorRole || '').trim().toLowerCase();
  const id = String(actor?.id || actor?.actorId || actor?.email || '').trim();
  return !!id && (role === 'admin' || role === 'ops' || role === 'quick_ops');
}

/**
 * Mark one service line complete. Does not change payment status or amounts.
 */
function completeServiceLine(booking, serviceId, actor = null) {
  if (!booking || booking.serviceFamily !== 'ceramic_coating') {
    return { ok: false, error: 'ceramic_booking_required' };
  }
  if (!isStaffActor(actor)) {
    return { ok: false, error: 'service_line_complete_unauthorized' };
  }
  const wanted = String(serviceId || '').trim();
  const canonical = wanted === INTERIOR_SERVICE_ALIAS ? INTERIOR_SERVICE_ID : wanted;
  if (!canonical) return { ok: false, error: 'service_line_required' };
  const paymentStatus = booking.paymentStatus;
  const amountPaid = booking.amountPaid;
  const balanceDue = booking.balanceDue;
  const approvedFinalAmount = booking.approvedFinalAmount;
  let found = false;
  const now = new Date().toISOString();
  const visit = (line) => {
    if (!line) return;
    const id = line.serviceId || line.canonicalServiceId;
    if (id !== canonical && line.alias !== wanted) return;
    line.completionStatus = 'completed';
    line.completedAt = line.completedAt || now;
    found = true;
  };
  for (const vehicle of booking.vehicles || []) {
    for (const line of vehicle.serviceLineItems || []) visit(line);
  }
  for (const line of booking.ceramic?.serviceLineItems || []) visit(line);
  if (!found) return { ok: false, error: 'service_line_not_found' };
  booking.paymentStatus = paymentStatus;
  booking.amountPaid = amountPaid;
  booking.balanceDue = balanceDue;
  booking.approvedFinalAmount = approvedFinalAmount;
  return { ok: true, booking, serviceId: canonical };
}

function publicServiceLine(line) {
  if (!line) return null;
  return {
    serviceId: line.serviceId,
    canonicalServiceId: line.canonicalServiceId,
    name: line.name,
    price: line.price,
    priceCents: line.priceCents,
    durationMinutes: line.durationMinutes,
    inclusions: line.inclusions || [],
    addonIds: line.addonIds || [],
    compatibleAddons: line.compatibleAddons || [],
    financialAllocationCents: line.financialAllocationCents,
    completionStatus: line.completionStatus || 'pending',
  };
}

function customerCeramicSummary(booking) {
  if (!booking || booking.serviceFamily !== 'ceramic_coating' || !booking.ceramic) return null;
  const c = booking.ceramic;
  const packages = (Array.isArray(c.packages) ? c.packages : []).map((row) => ({
    packageId: row.packageId,
    packageName: row.packageName,
    durationMonths: row.durationMonths,
    expectedDurability: row.expectedDurability || expectedDurabilityLabel(row.durationMonths),
    tierKey: row.tierKey,
    sizeBand: row.sizeBand,
    sizeLabel: row.sizeLabel,
    basePrice: row.basePrice,
  }));
  return {
    serviceFamily: 'ceramic_coating',
    packageId: c.packageId || packages[0]?.packageId || null,
    packageName: c.packageName,
    durationMonths: c.durationMonths,
    expectedDurability: c.expectedDurability || expectedDurabilityLabel(c.durationMonths),
    packages,
    inclusions: c.inclusions || INCLUSIONS.slice(),
    exclusions: c.exclusions || EXCLUSIONS.slice(),
    curingInstructions: c.curingInstructions || CURING_INSTRUCTIONS.slice(),
    eligibility: c.eligibility || null,
    warnings: c.warnings || [],
    appointmentDurationMinutes: booking.appointmentDurationMinutes || c.appointmentDurationMinutes || null,
    paymentPlan: c.paymentPlan || booking.ceramicPaymentPlan || null,
    depositAmount: booking.depositAmount != null ? Number(booking.depositAmount) : c.depositAmount,
    approvedFinalAmount: booking.approvedFinalAmount != null ? Number(booking.approvedFinalAmount) : null,
    amountPaid: booking.amountPaid != null ? Number(booking.amountPaid) : null,
    balanceDue: booking.balanceDue != null ? Number(booking.balanceDue) : null,
    paymentStatus: booking.paymentStatus || null,
    companionInterior: !!c.companionInterior,
    serviceLineItems: (Array.isArray(c.serviceLineItems) ? c.serviceLineItems : [])
      .map(publicServiceLine)
      .filter(Boolean),
  };
}

module.exports = {
  PUBLIC_PACKAGE_NAMES,
  PACKAGES,
  INTERNAL_COATINGS,
  STAFF_PRODUCT_DISCLOSURE,
  TIER_BAND,
  BAND_LABEL,
  BASE_PRICES,
  INCLUSIONS,
  EXCLUSIONS,
  CURING_INSTRUCTIONS,
  CERAMIC_ADDONS,
  SIZE_ADDONS,
  FLAT_GLOBAL_ADDONS,
  GLOBAL_PACKAGE_IDS,
  ELIGIBILITY_FIELDS,
  PAINT_RESTORATION_PACKAGE_ID,
  LEGACY_ENGINE_ADDON_ID,
  INTERIOR_SERVICE_ID,
  INTERIOR_SERVICE_ALIAS,
  INTERIOR_SERVICE_NAME,
  INTERIOR_ONLY_ADDON_IDS,
  EXTERIOR_PROTECTION_ADDON_IDS,
  WATER_REPELLENT_ID,
  WATER_REPELLENT_NAME,
  WATER_REPELLENT_DESCRIPTION,
  GLASS_PROTECTION_IDS,
  SEQUENCING_NOTE,
  isCeramicPackage,
  packageDef,
  bandForTier,
  tierPackagePrices,
  basePriceFor,
  catalogAddonRows,
  addonDef,
  isCeramicAddonId,
  isKnownCeramicCatalogAddon,
  resolveAddonPrice,
  waterRepellentOffer,
  filterAddonsForCeramicAdmin,
  validateAddonSet,
  companionInteriorSelected,
  resolveCompanionInterior,
  durationForVehicle,
  completeServiceLine,
  evaluateEligibility,
  normalizeEligibilityAnswers,
  retainStoredCeramicEligibility,
  retainStoredCeramicPayment,
  stampStoredCeramicChargePlan,
  ceramicPayAtServiceViolation,
  stripRetiredCeramicWaterFee,
  depositsEnabled,
  normalizePaymentPlan,
  depositDollarsForPackage,
  depositCentsForApproved,
  expectedDurabilityLabel,
  applyCeramicBooking,
  assignInternalCoating,
  customerCeramicSummary,
};
