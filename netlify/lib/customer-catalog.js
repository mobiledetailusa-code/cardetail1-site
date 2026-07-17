// Customer-facing service catalog — subscription pricing (10% monthly discount).
// Stripe Price env mapping: see netlify/lib/subscription-checkout.js

const SUBSCRIBER_DISCOUNT = 0.10;
const MAX_DETAILS_PER_MONTH = 1;

const CAR_PACKAGES = [
  {
    id: 'maint',
    name: 'Maintenance Detail',
    basePrice: 175,
    tag: 'Best for regularly maintained vehicles',
    duration: '~1.5–2h',
    description: 'Exterior hand wash, wheels dressed, interior vacuum, dash wipe, UV protectant. Ideal for monthly upkeep.',
    feats: ['Exterior hand wash & rinse', 'Wheels & tires cleaned + dressed', 'Interior vacuum', 'Dashboard & console wipe', 'UV protectant'],
  },
  {
    id: 'interior',
    name: 'Interior Detail',
    basePrice: 225,
    tag: 'Deep interior refresh',
    duration: '~2.5–3.5h',
    description: 'Deep vacuum, fabric shampoo, leather conditioning, steam clean, UV protectant on plastics. Odor treatment available as add-on.',
    feats: ['Deep vacuum — seats, floors, trunk', 'Fabric seats & carpet shampoo', 'Leather surfaces conditioned', 'Steam clean vents & panels', 'UV protectant on plastics', 'Interior glass'],
  },
  {
    id: 'full',
    name: 'Premium Detail',
    basePrice: 300,
    tag: 'Full inside/out refresh — most popular',
    duration: '~3–5h',
    description: 'Complete exterior and interior detail with clay bar, shampoo, steam, and sealant protection.',
    feats: ['Clay bar decontamination', 'Carpet & seat shampoo', 'Interior steam clean', 'Spray sealant', 'Tire dressing'],
  },
  {
    id: 'refresh',
    name: 'Exterior Refresh & Protect',
    basePrice: 375,
    tag: 'Clay bar, single-pass correction, sealant, Rain-X & wheels',
    duration: '~2.5–3h',
    description: 'Clay bar, chemical decontamination, single-pass paint correction, sealant, deep wheel detail, and Rain-X included.',
    feats: ['Clay bar decontamination', 'Single-pass paint correction', 'Long-lasting sealant', 'Deep wheel & lug detailing', 'Rain-X glass treatment', 'Tire dressing'],
  },
  {
    id: 'premium',
    name: 'Signature Interior & Exterior Restoration',
    basePrice: 450,
    tag: 'Single-pass correction, ceramic, clay bar, Rain-X & deep interior',
    duration: '~6–8h',
    description: 'Clay bar, single-pass correction, ceramic protection, Rain-X, deep wheels, carpet shampoo, leather and plastics with UV protection.',
    feats: ['Clay bar decontamination', 'Single-pass paint correction', 'Ceramic protection', 'Deep wheel detailing', 'Rain-X windshield', 'Carpet & seat shampoo', 'Leather & plastics with UV protection'],
  },
];

const ADDONS = [
  { id: 'pethair', name: 'Pet Hair Removal', price: 95, desc: 'Embedded pet hair from seats, carpets, mats' },
  { id: 'odor', name: 'Odor Treatment & Sanitize', price: 149, desc: 'Odor neutralizer + surface sanitizing' },
  { id: 'engine', name: 'Engine Bay Top Clean', price: 45, desc: 'Visible engine bay surfaces only' },
  { id: 'rainx', name: 'Rain-X Glass Treatment', price: 25, desc: 'Water-repellent windshield treatment' },
  { id: 'polymer', name: 'Polymer Paint Sealant', price: 25, desc: '3–6 month paint protection' },
  { id: 'claybar', name: 'Clay Bar Treatment', price: 45, desc: 'Removes embedded contaminants' },
  { id: 'headlight', name: 'Headlight Restoration', price: 90, desc: 'Restore foggy headlights (pair)' },
];

const FLEET_PLANS = [
  {
    id: 'fleet-2',
    name: '2-Vehicle Fleet',
    vehicleCount: 2,
    extraDiscountPct: 0.08,
    description: 'Monthly plan for 2 vehicles at your location — 10% subscriber + 8% fleet savings.',
  },
  {
    id: 'fleet-3',
    name: '3+ Vehicle Fleet',
    vehicleCount: 3,
    extraDiscountPct: 0.12,
    description: 'Monthly plan for 3 or more vehicles — ideal for families or small fleets.',
  },
];

const MAINTENANCE_PERIODS = [
  { id: 'monthly', label: 'Monthly', months: 1 },
  { id: 'bimonthly', label: 'Every 2 months', months: 2 },
  { id: 'quarterly', label: 'Quarterly', months: 3 },
  { id: 'semiannual', label: 'Every 6 months', months: 6 },
  { id: 'annual', label: 'Annually', months: 12 },
];

const VEHICLE_CATEGORIES = [
  { id: 'cars', label: 'Car / SUV / Truck' },
  { id: 'rvs', label: 'RV / Camper' },
  { id: 'boats', label: 'Boat' },
  { id: 'powersports', label: 'Powersports' },
  { id: 'fleet', label: 'Fleet / Commercial' },
];

const VEHICLE_YEARS = (() => {
  const y = new Date().getFullYear() + 1;
  const out = [];
  for (let i = 0; i < 45; i++) out.push(String(y - i));
  return out;
})();

function roundPrice(n) {
  return Math.round(Number(n) * 100) / 100;
}

function subscriberPrice(basePrice) {
  return roundPrice(Number(basePrice) * (1 - SUBSCRIBER_DISCOUNT));
}

function fleetMonthlyPrice(packBasePrice, fleetPlan) {
  const perVehicle = subscriberPrice(packBasePrice);
  const fleetDisc = 1 - (fleetPlan.extraDiscountPct || 0);
  return roundPrice(perVehicle * fleetPlan.vehicleCount * fleetDisc);
}

function matchPackFromBooking(booking) {
  const hay = [
    booking.package, booking.service, booking.packageName, booking.pkgName,
  ].join(' ').toLowerCase();
  for (const p of CAR_PACKAGES) {
    if (hay.includes(p.id) || hay.includes(p.name.toLowerCase())) return p;
  }
  if (/maint/i.test(hay)) return CAR_PACKAGES[0];
  if (/interior/i.test(hay)) return CAR_PACKAGES[1];
  if (/premium detail|full detail/i.test(hay) && !/paint|correction|signature|refresh/i.test(hay)) return CAR_PACKAGES[2];
  if (/refresh|exterior refresh/i.test(hay)) return CAR_PACKAGES[3];
  if (/signature|restoration|paint|correction/i.test(hay)) return CAR_PACKAGES[4];
  return null;
}

function catalogForClient() {
  const {
    LENGTH_PRICING,
    BOAT_PACKAGES,
    RV_PACKAGES,
    lengthConfigForClient,
  } = require('./length-pricing');
  return {
    subscriberDiscountPct: SUBSCRIBER_DISCOUNT * 100,
    maxDetailsPerMonth: MAX_DETAILS_PER_MONTH,
    packages: CAR_PACKAGES.map(p => ({
      ...p,
      monthlyPrice: subscriberPrice(p.basePrice),
      savings: roundPrice(p.basePrice - subscriberPrice(p.basePrice)),
      category: 'cars',
    })),
    packagesByCategory: {
      cars: CAR_PACKAGES.map(p => ({
        ...p,
        monthlyPrice: subscriberPrice(p.basePrice),
        savings: roundPrice(p.basePrice - subscriberPrice(p.basePrice)),
        category: 'cars',
      })),
      boats: BOAT_PACKAGES.map(p => ({ ...p, category: 'boats', pricedByLength: true })),
      rvs: RV_PACKAGES.map(p => ({ ...p, category: 'rvs', pricedByLength: true })),
    },
    lengthPricing: {
      boats: lengthConfigForClient('boats'),
      rvs: lengthConfigForClient('rvs'),
      fleet: lengthConfigForClient('fleet'),
    },
    lengthPackageRules: {
      boats: LENGTH_PRICING.boats.packages,
      rvs: LENGTH_PRICING.rvs.packages,
    },
    addons: ADDONS,
    maintenancePeriods: MAINTENANCE_PERIODS,
    vehicleCategories: VEHICLE_CATEGORIES,
    vehicleYears: VEHICLE_YEARS,
    fleetPlans: FLEET_PLANS.map(f => ({
      ...f,
      examplePrices: CAR_PACKAGES.map(p => ({
        packId: p.id,
        packName: p.name,
        monthlyTotal: fleetMonthlyPrice(p.basePrice, f),
      })),
    })),
  };
}

function resolveAddonsByIds(ids) {
  const set = new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean));
  return ADDONS.filter((a) => set.has(a.id)).map((a) => ({
    id: a.id,
    name: a.name,
    price: a.price,
    qty: 1,
  }));
}

function addonTotal(addons) {
  return roundPrice((addons || []).reduce((s, a) => s + Number(a.price || 0) * Number(a.qty || 1), 0));
}

module.exports = {
  SUBSCRIBER_DISCOUNT,
  MAX_DETAILS_PER_MONTH,
  CAR_PACKAGES,
  ADDONS,
  FLEET_PLANS,
  MAINTENANCE_PERIODS,
  VEHICLE_CATEGORIES,
  VEHICLE_YEARS,
  subscriberPrice,
  fleetMonthlyPrice,
  matchPackFromBooking,
  catalogForClient,
  resolveAddonsByIds,
  addonTotal,
  roundPrice,
};
