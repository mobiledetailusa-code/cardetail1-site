'use strict';

/**
 * Ceramic Coating — server authority for packages, size-banded prices,
 * add-ons, eligibility, and appointment duration.
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

const PACKAGES = Object.freeze({
  ceramic_1yr: Object.freeze({
    id: 'ceramic_1yr',
    name: '1-Year Ceramic Protection',
    product: 'GYEON Q² CanCoat EVO or equivalent approved 12-month coating',
    durationMonths: 12,
    depositDollars: 150,
    baseMinutes: 480,
  }),
  ceramic_3yr: Object.freeze({
    id: 'ceramic_3yr',
    name: '3-Year Ceramic Protection',
    product: 'GYEON Q² Mohs EVO or equivalent approved 36-month coating',
    durationMonths: 36,
    depositDollars: 250,
    baseMinutes: 600,
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
  'Durability depends on maintenance and operating conditions.',
  'Ceramic coating protects the existing finish and does not repair damaged paint.',
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
    description: 'Required when accessible undercarriage cleaning is selected and the customer does not provide a usable exterior water connection.',
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

const BLOCKS = Object.freeze({
  repainted60: Object.freeze({
    error: 'ceramic_blocked_repaint',
    route: 'paint_restoration',
    message: 'A vehicle repainted within the last 60 days cannot be booked for instant Ceramic Coating. Fresh paint needs Paint Restoration review instead. No ceramic quote was created.',
  }),
  clearCoatFailing: Object.freeze({
    error: 'ceramic_blocked_clearcoat',
    route: 'paint_restoration',
    message: 'Peeling, oxidized, or failing clear coat is not eligible for instant Ceramic Coating. Book Paint Restoration. Ceramic coating does not repair damaged paint, and no ceramic quote was created.',
  }),
  severeContamination: Object.freeze({
    error: 'ceramic_blocked_contamination',
    route: 'paint_restoration',
    message: 'Cement, extensive overspray, severe sap, or extreme contamination is not eligible for instant Ceramic Coating. Book Paint Restoration. No ceramic quote was created.',
  }),
  matteWrapPpf: Object.freeze({
    error: 'ceramic_blocked_finish',
    route: 'compatible_finish',
    message: 'Matte paint, vinyl wrap, or paint-protection film cannot use the gloss paint-coating package. Choose a compatible service instead. The paint ceramic package was not applied.',
  }),
  remainDry12h: Object.freeze({
    error: 'ceramic_blocked_cure',
    route: null,
    message: 'Ceramic Coating needs the vehicle to stay dry for at least 12 hours after application. Checkout stays closed until that cure window is available.',
  }),
});

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
function resolveAddonPrice(id, vehicle) {
  const addonId = String(id || '').trim();
  if (!isKnownCeramicCatalogAddon(addonId)) return { handled: false };
  const cat = String(vehicle?.cat || vehicle?.category || '').trim();
  const pkgId = String(vehicle?.pkgId || vehicle?.packageId || '').trim();
  const tierKey = String(vehicle?.tierKey || vehicle?.tier || '').trim();
  const ceramic = isCeramicPackage(pkgId);

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

function validateAddonSet(vehicle) {
  const ids = selectedIds(vehicle?.addons);
  const pkgId = String(vehicle?.pkgId || vehicle?.packageId || '').trim();
  const ceramic = isCeramicPackage(pkgId);
  if (ids.includes('ceramic_windshield') && ids.includes('ceramic_glass_all')) {
    return {
      ok: false,
      error: 'ceramic_glass_mutually_exclusive',
      message: 'Choose windshield ceramic coating or all exterior glass ceramic coating, not both.',
    };
  }
  if (ids.includes(LEGACY_ENGINE_ADDON_ID) && ids.includes('engine_bay')) {
    return {
      ok: false,
      error: 'engine_addon_mutually_exclusive',
      message: 'Choose Engine Bay Top Clean or Engine Bay Detail, not both.',
    };
  }
  if (ids.includes('mobile_water') && !ids.includes('undercarriage')) {
    return { ok: false, error: 'mobile_water_requires_undercarriage' };
  }
  if (ids.includes('undercarriage')) {
    const supply = String(vehicle?.ceramicWaterSupply || vehicle?.waterSupply || '').trim();
    if (supply !== 'customer' && supply !== 'mobile') {
      return {
        ok: false,
        error: 'water_supply_required',
        message: 'Undercarriage cleaning needs either a usable exterior water connection or Mobile Water Supply.',
      };
    }
    if (supply === 'mobile' && !ids.includes('mobile_water')) {
      return { ok: false, error: 'mobile_water_required' };
    }
    if (supply === 'customer' && ids.includes('mobile_water')) {
      return { ok: false, error: 'mobile_water_not_needed' };
    }
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
  let minutes = pkg.baseMinutes;
  for (const id of selectedIds(vehicle?.addons)) {
    const priced = priceAndMinutesForAddon(id, band);
    if (priced) minutes += priced.minutes;
  }
  return { ok: true, minutes };
}

function yesNo(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'yes' || v === 'true') return 'yes';
  if (v === 'no' || v === 'false') return 'no';
  return '';
}

function evaluateEligibility(raw, { requireComplete = false } = {}) {
  const answers = {};
  for (const field of ELIGIBILITY_FIELDS) {
    answers[field] = yesNo(raw && raw[field]);
  }
  const missing = ELIGIBILITY_FIELDS.filter((field) => !answers[field]);
  if (missing.length && requireComplete) {
    return {
      ok: false,
      error: 'ceramic_eligibility_required',
      missing,
      message: 'Answer the Ceramic Coating eligibility questions before checkout.',
    };
  }
  if (!missing.length || Object.values(answers).some(Boolean)) {
    for (const field of ['repainted60', 'clearCoatFailing', 'severeContamination', 'matteWrapPpf']) {
      if (answers[field] === 'yes') {
        return {
          ok: false,
          ...BLOCKS[field],
          packageId: field === 'matteWrapPpf' ? null : PAINT_RESTORATION_PACKAGE_ID,
          answers,
        };
      }
    }
    if (answers.remainDry12h === 'no') {
      return { ok: false, ...BLOCKS.remainDry12h, answers };
    }
  }
  const warnings = [];
  if (answers.coveredCureArea === 'no') {
    warnings.push('No covered, dry curing area was confirmed. Scheduling is weather-dependent and can move if the finish cannot stay dry.');
  }
  return { ok: true, answers, warnings };
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

  const eligibility = evaluateEligibility(booking.ceramicEligibility, { requireComplete: finalize });
  if (!eligibility.ok) return eligibility;

  let durationMinutes = 0;
  const stampedVehicles = [];
  for (const vehicle of vehicles) {
    const pkgId = String(vehicle.pkgId || vehicle.packageId || '').trim();
    const priced = basePriceFor(vehicle.cat || vehicle.category, vehicle.tierKey || vehicle.tier, pkgId);
    if (!priced.ok) return priced;
    const setCheck = validateAddonSet(vehicle);
    if (!setCheck.ok) return setCheck;
    const duration = durationForVehicle(vehicle);
    durationMinutes += duration.minutes;
    const pkg = packageDef(pkgId);
    stampedVehicles.push({
      packageId: pkgId,
      packageName: pkg.name,
      product: pkg.product,
      durationMonths: pkg.durationMonths,
      tierKey: priced.tierKey,
      sizeBand: priced.band,
      sizeLabel: priced.bandLabel,
      basePrice: priced.amount,
    });
  }

  const primary = packageDef(ceramicVehicles[0].pkgId || ceramicVehicles[0].packageId);
  const plan = normalizePaymentPlan(booking.ceramicPaymentPlan || booking.paymentPlan);
  if (finalize && !plan) {
    return {
      ok: false,
      error: 'ceramic_payment_plan_required',
      message: 'Choose Prepay in Full or Reserve with Deposit.',
      depositsEnabled: depositsEnabled(env),
    };
  }
  if (plan === 'deposit' && !depositsEnabled(env)) {
    return {
      ok: false,
      error: 'ceramic_deposit_disabled',
      message: 'Reserve with Deposit is temporarily unavailable. Prepay in Full is still available.',
      depositsEnabled: false,
    };
  }

  const serviceDollars = vehicles.reduce((sum, v) => sum + (Number(v.subtotal) || 0), 0);
  const travel = Math.round((Number(booking.travelFeeAmount) || 0) * 100) / 100;
  const approved = Math.round((serviceDollars + travel) * 100) / 100;
  const depositAmount = plan === 'deposit' ? primary.depositDollars : 0;
  if (plan === 'deposit' && !(depositAmount > 0 && depositAmount < approved)) {
    return { ok: false, error: 'ceramic_deposit_invalid' };
  }
  const chargeAmount = plan === 'deposit' ? depositAmount : (plan === 'prepay_full' ? approved : 0);

  const settledCents = (Array.isArray(booking.ledger?.entries) ? booking.ledger.entries : [])
    .filter((entry) => entry && entry.kind === 'settlement')
    .reduce((sum, entry) => sum + Math.max(0, Math.round(Number(entry.amountCents) || 0)), 0);
  booking.serviceFamily = 'ceramic_coating';
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
    packageName: primary.name,
    product: primary.product,
    durationMonths: primary.durationMonths,
    inclusions: INCLUSIONS.slice(),
    exclusions: EXCLUSIONS.slice(),
    curingInstructions: CURING_INSTRUCTIONS.slice(),
    eligibility: eligibility.answers || null,
    warnings: eligibility.warnings || [],
    appointmentDurationMinutes: durationMinutes,
    paymentPlan: plan || null,
    depositAmount,
    chargeAmount,
    depositsEnabled: depositsEnabled(env),
    paintRestorationPackageId: PAINT_RESTORATION_PACKAGE_ID,
  };
  return { ok: true, ceramic: true, booking };
}

function customerCeramicSummary(booking) {
  if (!booking || booking.serviceFamily !== 'ceramic_coating' || !booking.ceramic) return null;
  const c = booking.ceramic;
  return {
    serviceFamily: 'ceramic_coating',
    packageName: c.packageName,
    product: c.product,
    durationMonths: c.durationMonths,
    packages: c.packages || [],
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
  };
}

module.exports = {
  PACKAGES,
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
  validateAddonSet,
  durationForVehicle,
  evaluateEligibility,
  depositsEnabled,
  normalizePaymentPlan,
  depositDollarsForPackage,
  applyCeramicBooking,
  customerCeramicSummary,
};
