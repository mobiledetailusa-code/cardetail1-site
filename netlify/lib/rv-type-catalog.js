/**
 * RV type catalog — explicit per-foot rates (no blanket bump).
 * Travel fees come only from travel-fee.js (authoritative mileage table).
 */
'use strict';

const RV_TYPES = {
  travel: {
    id: 'travel',
    label: 'Travel Trailer',
    multiplier: 1.0,
    minFt: 12,
    maxFt: 40,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Bumper-pull travel trailers',
  },
  fifthwheel: {
    id: 'fifthwheel',
    label: 'Fifth Wheel',
    multiplier: 1.0,
    minFt: 20,
    maxFt: 45,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Fifth-wheel trailers — height and hitch clearance matter',
  },
  classA: {
    id: 'classA',
    label: 'Class A Motorhome',
    multiplier: 1.0,
    minFt: 24,
    maxFt: 45,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Large motorhomes — access and height reviewed upfront',
  },
  classB: {
    id: 'classB',
    label: 'Class B Motorhome',
    multiplier: 1.0,
    minFt: 16,
    maxFt: 28,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Camper vans and Class B coaches',
  },
  classC: {
    id: 'classC',
    label: 'Class C Motorhome',
    multiplier: 1.0,
    minFt: 18,
    maxFt: 35,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Class C coaches with cab-over bunk',
  },
  airstream: {
    id: 'airstream',
    label: 'Airstream',
    multiplier: 1.0,
    minFt: 16,
    maxFt: 34,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
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
    packagesExterior: ['maint', 'premium'],
    packagesLiving: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Finished living quarters required for residential interior packages',
  },
  horse: {
    id: 'horse',
    label: 'Horse Trailer',
    multiplier: 1.0,
    minFt: 12,
    maxFt: 45,
    livingQuarters: 'ask',
    packagesExterior: ['maint', 'premium'],
    packagesLiving: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Living-quarters horse trailers only for interior packages',
  },
  other: {
    id: 'other',
    label: 'Other RV / Custom Trailer',
    multiplier: 1.0,
    minFt: 12,
    maxFt: 45,
    livingQuarters: 'ask',
    packagesExterior: ['maint', 'premium'],
    packagesLiving: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Tell us about your unit — scope confirmed before service',
  },
};

/** Authoritative RV service price: base + exactLength × ratePerFoot (no mins, no blanket %). */
const RV_RATE_TABLE = {
  maint: { base: 150, ratePerFoot: 10 },
  maint_light: { base: 250, ratePerFoot: 16 },
  interior: { base: 250, ratePerFoot: 18 },
  full_basic: { base: 300, ratePerFoot: 25 },
  premium: { base: 300, ratePerFoot: 28 },
  full: { base: 400, ratePerFoot: 36 },
};

const ADJUSTED_RATES = Object.fromEntries(
  Object.entries(RV_RATE_TABLE).map(([k, v]) => [k, v.ratePerFoot]),
);

const RV_RATE_BASELINE = { ...ADJUSTED_RATES };

function computeRvServicePrice(pkgId, lengthFt, typeKey) {
  const rule = RV_RATE_TABLE[pkgId];
  if (!rule) return null;
  const t = RV_TYPES[typeKey] || RV_TYPES.travel;
  const mult = Number(t?.multiplier) || 1;
  const ft = Number(lengthFt) || 0;
  return Math.round((rule.base + rule.ratePerFoot * ft) * mult * 100) / 100;
}

const RV_PACKAGE_META = {
  maint: {
    id: 'maint',
    name: 'Maintenance Wash',
    group: 'outside',
    badge: null,
    subtitle: 'Exterior maintenance with quick machine-applied protection.',
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
    subtitle: 'Complete interior cleaning from the driver cabin to the living area.',
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
    name: 'Premium Exterior Detail',
    group: 'outside',
    badge: null,
    subtitle: 'One-Step Machine Polish + Premium Protection',
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
  computeRvServicePrice,
  eligiblePackagesForType,
  rateIncreasePct,
};
