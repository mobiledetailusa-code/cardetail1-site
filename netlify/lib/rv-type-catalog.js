/**
 * RV type catalog + funnel pricing helpers.
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
    multiplier: 1.1,
    minFt: 20,
    maxFt: 45,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Fifth-wheel trailers — height and hitch clearance matter',
  },
  classA: {
    id: 'classA',
    label: 'Class A Motorhome',
    multiplier: 1.15,
    minFt: 24,
    maxFt: 45,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Large motorhomes — access and height reviewed upfront',
  },
  classBC: {
    id: 'classBC',
    label: 'Class B / Class C Motorhome',
    multiplier: 1.1,
    minFt: 16,
    maxFt: 35,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Class B vans and Class C coaches',
  },
  airstream: {
    id: 'airstream',
    label: 'Airstream',
    multiplier: 1.08,
    minFt: 16,
    maxFt: 34,
    livingQuarters: true,
    packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Polished aluminum may require inspection before polish scope',
    surfaceAware: true,
  },
  specialty: {
    id: 'specialty',
    label: 'Cargo, Horse or Custom Trailer',
    multiplier: 1.0,
    minFt: 12,
    maxFt: 45,
    livingQuarters: 'ask',
    packagesExterior: ['maint', 'premium'],
    packagesLiving: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
    notes: 'Finished living quarters required for residential interior packages',
  },
};

/** Pre-7% authoritative per-foot rates (commercial reset baseline). */
const RV_RATE_BASELINE = {
  maint: 8,
  maint_light: 15,
  interior: 20,
  premium: 31,
  full: 44,
};

function bumpPerFtRate(oldRate) {
  const maxAllowed = Number(oldRate) * 1.07;
  let candidate = Math.round(Number(oldRate) * 1.07 * 2) / 2;
  if (candidate > maxAllowed + 1e-9) candidate = Math.floor(maxAllowed * 2) / 2;
  return candidate;
}

function roundHalfDown(n) {
  return Math.floor(Number(n) * 2) / 2;
}

const ADJUSTED_RATES = {
  maint: bumpPerFtRate(RV_RATE_BASELINE.maint),
  maint_light: bumpPerFtRate(RV_RATE_BASELINE.maint_light),
  interior: bumpPerFtRate(RV_RATE_BASELINE.interior),
  premium: bumpPerFtRate(RV_RATE_BASELINE.premium),
};

ADJUSTED_RATES.full_basic = roundHalfDown(
  (ADJUSTED_RATES.maint + ADJUSTED_RATES.interior) * 0.92,
);
ADJUSTED_RATES.full = roundHalfDown(
  (ADJUSTED_RATES.premium + ADJUSTED_RATES.interior) * 0.92,
);

const RV_PACKAGE_META = {
  maint: {
    id: 'maint',
    name: 'Maintenance Wash',
    group: 'exterior',
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
    group: 'interior',
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
    group: 'premium',
    badge: null,
    subtitle: 'One-Step Machine Polish + Premium Protection',
  },
  full: {
    id: 'full',
    name: 'Premium Complete RV Detail',
    group: 'premium',
    badge: 'BEST FINISH',
    subtitle: 'One-Step Exterior Polish + Complete Interior Detail',
  },
};

function eligiblePackagesForType(typeKey, livingQuarters) {
  const t = RV_TYPES[typeKey];
  if (!t) return [];
  if (typeKey === 'specialty') {
    if (livingQuarters === true || livingQuarters === 'yes') return t.packagesLiving.slice();
    return t.packagesExterior.slice();
  }
  return t.packages.slice();
}

function rateIncreasePct(oldRate, newRate) {
  return ((newRate - oldRate) / oldRate) * 100;
}

module.exports = {
  RV_TYPES,
  RV_RATE_BASELINE,
  ADJUSTED_RATES,
  RV_PACKAGE_META,
  bumpPerFtRate,
  eligiblePackagesForType,
  rateIncreasePct,
};
