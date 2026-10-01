/**
 * RV type catalog — explicit per-foot rates (no blanket bump).
 * Travel fees come only from travel-fee.js (authoritative mileage table).
 */
'use strict';

const RV_TYPES = {
  travel: {
    id: 'travel',
    label: 'Travel Trailer — rear hitch',
    multiplier: 1.0,
    minFt: 12,
    maxFt: 40,
    livingQuarters: true,
    motorized: false,
    packages: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Bumper-pull travel trailers',
  },
  fifthwheel: {
    id: 'fifthwheel',
    label: 'Fifth Wheel — pickup-bed hitch',
    multiplier: 1.0,
    minFt: 20,
    maxFt: 45,
    livingQuarters: true,
    motorized: false,
    packages: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Fifth-wheel trailers — height and hitch clearance matter',
  },
  motorhome: {
    id: 'motorhome',
    label: 'Motorhome — Class A, B or C',
    multiplier: 1.0,
    minFt: 16,
    maxFt: 45,
    livingQuarters: true,
    motorized: true,
    packages: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Class A, B, and C share one price. Length bounds are the combined range (16–45 ft).',
  },
  classA: {
    id: 'classA',
    label: 'Class A Motorhome',
    multiplier: 1.0,
    minFt: 24,
    maxFt: 45,
    livingQuarters: true,
    motorized: true,
    packages: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Kept for existing bookings. New bookings use motorhome. Price matches the other motorhome classes.',
  },
  classB: {
    id: 'classB',
    label: 'Class B Motorhome',
    multiplier: 1.0,
    minFt: 16,
    maxFt: 28,
    livingQuarters: true,
    motorized: true,
    packages: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Camper vans and Class B coaches. Kept for existing bookings.',
  },
  classC: {
    id: 'classC',
    label: 'Class C Motorhome',
    multiplier: 1.0,
    minFt: 18,
    maxFt: 35,
    livingQuarters: true,
    motorized: true,
    packages: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Class C coaches with cab-over bunk. Kept for existing bookings.',
  },
  airstream: {
    id: 'airstream',
    label: 'Airstream',
    multiplier: 1.0,
    minFt: 16,
    maxFt: 34,
    livingQuarters: true,
    motorized: false,
    packages: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Polished aluminum may require inspection before polish scope',
    surfaceAware: true,
  },
  cargo: {
    id: 'cargo',
    label: 'Cargo Trailer',
    multiplier: 1.0,
    minFt: 12,
    maxFt: 45,
    livingQuarters: 'ask',
    motorized: false,
    packagesExterior: ['exterior_wash', 'maint', 'premium'],
    packagesLiving: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Finished living quarters required for residential interior packages',
  },
  horse: {
    id: 'horse',
    label: 'Horse Trailer',
    multiplier: 1.0,
    minFt: 12,
    maxFt: 45,
    livingQuarters: 'ask',
    motorized: false,
    packagesExterior: ['exterior_wash', 'maint', 'premium'],
    packagesLiving: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Living-quarters horse trailers only for interior packages',
  },
  other: {
    id: 'other',
    label: 'Other RV / Custom Trailer',
    multiplier: 1.0,
    minFt: 12,
    maxFt: 45,
    livingQuarters: 'ask',
    motorized: false,
    packagesExterior: ['exterior_wash', 'maint', 'premium'],
    packagesLiving: ['exterior_wash', 'maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Tell us about your unit — scope confirmed before service',
  },
};

/** Authoritative RV service price: base + exactLength × ratePerFoot. */
const { LENGTH_PRICING } = require('./booking-price-catalog');
const RV_RATE_TABLE = LENGTH_PRICING.rvs.packages;

const ADJUSTED_RATES = Object.fromEntries(
  Object.entries(RV_RATE_TABLE).map(([k, v]) => [k, v.ratePerFoot]),
);

const RV_RATE_BASELINE = { ...ADJUSTED_RATES };

function computeRvServicePrice(pkgId, lengthFt, typeKey) {
  const { getLengthPrice } = require('./booking-price-catalog');
  return getLengthPrice('rvs', pkgId, lengthFt, typeKey || 'travel');
}

/**
 * Planning estimate for the basic exterior wash only. Not a guaranteed time.
 * Line through two solo anchors: 150 min at 25 ft, 280 min at 40 ft.
 * 280 is the 40 ft wash with roof (~360 min) minus ~60 min of interruptions
 * and supply and ~20 min of roof. Those are not added back, and there is no
 * second setup line. 12, 20, and 45 ft are straight-line extrapolations.
 * Travel stays a separate fee. The 2-hour schedule grid rounds the hold up
 * on its own (1 slot at or under 120 min, otherwise ceil(minutes / 120)).
 */
const EXTERIOR_WASH_DURATION = Object.freeze({
  packageId: 'exterior_wash',
  anchorMinutes: Object.freeze({ 25: 150, 40: 280 }),
  ownerValidationRequired: true,
  guaranteed: false,
  basis: 'Preliminary solo planning estimate. 150 minutes at 25 ft and about 280 minutes at 40 ft without roof. Not a promised finish time.',
});

function estimateExteriorWashMinutes(lengthFt) {
  const ft = Number(lengthFt);
  if (!Number.isFinite(ft) || ft <= 0) return null;
  return Math.ceil((130 * ft - 1000) / 15);
}

function applyRvExteriorWashDuration(booking) {
  if (!booking) return booking;
  const vehicles = Array.isArray(booking.vehicles) ? booking.vehicles : [];
  const ceramicIds = new Set(['ceramic_1yr', 'ceramic_3yr']);
  if (vehicles.some((v) => ceramicIds.has(String((v && (v.pkgId || v.packageId)) || '')))) {
    return booking;
  }
  let minutes = 0;
  let saw = false;
  for (const vehicle of vehicles) {
    const id = String((vehicle && (vehicle.pkgId || vehicle.packageId)) || '');
    if (id !== 'exterior_wash') continue;
    const ft = Number(
      vehicle.lengthFt != null && vehicle.lengthFt !== '' ? vehicle.lengthFt : booking.lengthFt,
    );
    const est = estimateExteriorWashMinutes(ft);
    if (!est) continue;
    saw = true;
    minutes += est;
    vehicle.durationMinutes = est;
    vehicle.durationSource = 'estimate_owner_review';
  }
  if (!saw) return booking;
  booking.appointmentDurationMinutes = minutes;
  booking.durationSource = 'estimate_owner_review';
  return booking;
}

/** Manufacturer classification only. Does not invent year or length. */
const RV_MODEL_TYPE_HINTS = Object.freeze({
  'forest river': Object.freeze({
    // Forest River Class C Division: Lexington is a Class C / B+ motorhome,
    // not a travel trailer. Brochure: library.rvusa.com/brochure/13_Lexington.pdf
    lexington: 'motorhome',
  }),
});

function rvModelTypeHint(make, model) {
  const byMake = RV_MODEL_TYPE_HINTS[String(make || '').trim().toLowerCase()];
  if (!byMake) return '';
  return byMake[String(model || '').trim().toLowerCase()] || '';
}

const RV_PACKAGE_META = {
  exterior_wash: {
    id: 'exterior_wash',
    name: 'Exterior Wash',
    group: 'outside',
    badge: null,
    subtitle: 'A fresh exterior clean to remove everyday dirt and road grime.',
  },
  maint: {
    id: 'maint',
    name: 'Wash & Protect',
    group: 'outside',
    badge: null,
    subtitle: 'A thorough wash with added protection to help maintain the finish.',
  },
  maint_light: {
    id: 'maint_light',
    name: 'Maintenance Wash + Light Interior',
    group: 'inside_out',
    badge: null,
    subtitle: 'Exterior maintenance plus a quick interior refresh.',
  },
  interior: {
    id: 'interior',
    name: 'Interior Detail',
    group: 'inside',
    badge: null,
    subtitle: 'Complete interior cleaning. Driver cabin applies to motorhomes.',
  },
  full_basic: {
    id: 'full_basic',
    name: 'Full RV Detail',
    group: 'inside_out',
    badge: 'MOST POPULAR',
    subtitle: 'Complete interior cleaning plus exterior wash and protection.',
  },
  premium: {
    id: 'premium',
    name: 'Exterior Polish & Protect',
    group: 'outside',
    badge: null,
    subtitle: 'For a dull exterior that needs more than a wash.',
  },
  full: {
    id: 'full',
    name: 'Premium Complete RV Detail',
    group: 'inside_out',
    badge: 'BEST FINISH',
    subtitle: 'One-Step Exterior Polish + Complete Interior Detail',
  },
};

function eligiblePackagesForType(typeKey, livingQuarters) {
  const t = RV_TYPES[typeKey];
  if (!t) return [];
  if (t.packages) return t.packages.slice();
  const hasLiving = livingQuarters === true || livingQuarters === 'yes';
  if (hasLiving) return (t.packagesLiving || []).slice();
  return (t.packagesExterior || []).slice();
}

function rateIncreasePct(oldRate, newRate) {
  return ((newRate - oldRate) / oldRate) * 100;
}

/** @deprecated legacy alias — rates are explicit in ADJUSTED_RATES */
function bumpPerFtRate(oldRate) {
  return Number(oldRate);
}

module.exports = {
  RV_TYPES,
  RV_RATE_TABLE,
  RV_RATE_BASELINE,
  ADJUSTED_RATES,
  RV_PACKAGE_META,
  EXTERIOR_WASH_DURATION,
  RV_MODEL_TYPE_HINTS,
  computeRvServicePrice,
  estimateExteriorWashMinutes,
  applyRvExteriorWashDuration,
  rvModelTypeHint,
  eligiblePackagesForType,
  rateIncreasePct,
};
