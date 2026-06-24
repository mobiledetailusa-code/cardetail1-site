// Customer-facing service catalog — subscription pricing (10% monthly discount).
// Base prices use sedan/small-car tier; exact vehicle tier confirmed at service.

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
    description: 'Deep vacuum, carpet shampoo, steam clean, leather conditioning, interior glass.',
    feats: ['Deep vacuum — seats, floors, trunk', 'Carpet shampoo', 'Steam clean vents & panels', 'Interior glass', 'Odor-neutral finish'],
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
    id: 'premium',
    name: 'Paint Correction / Enhancement',
    basePrice: 450,
    tag: 'Gloss & swirl reduction',
    duration: '~4–7h',
    description: 'Machine polish, defect reduction, sealant. Starting price — final quote by paint condition.',
    feats: ['1-step machine polish', 'Swirl reduction', 'Chemical decontamination', 'Machine wax/sealant', 'Rain-X windshield'],
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
  if (/premium detail|full detail|premium/i.test(hay) && !/paint|correction/i.test(hay)) return CAR_PACKAGES[2];
  if (/paint|correction|enhancement/i.test(hay)) return CAR_PACKAGES[3];
  return null;
}

function catalogForClient() {
  return {
    subscriberDiscountPct: SUBSCRIBER_DISCOUNT * 100,
    maxDetailsPerMonth: MAX_DETAILS_PER_MONTH,
    packages: CAR_PACKAGES.map(p => ({
      ...p,
      monthlyPrice: subscriberPrice(p.basePrice),
      savings: roundPrice(p.basePrice - subscriberPrice(p.basePrice)),
    })),
    addons: ADDONS,
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

module.exports = {
  SUBSCRIBER_DISCOUNT,
  MAX_DETAILS_PER_MONTH,
  CAR_PACKAGES,
  ADDONS,
  FLEET_PLANS,
  subscriberPrice,
  fleetMonthlyPrice,
  matchPackFromBooking,
  catalogForClient,
};
