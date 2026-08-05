// The booking catalog is the single server authority. This module keeps the
// length helpers and display metadata, but no longer carries a second rate table.
const { LENGTH_PRICING } = require('./booking-price-catalog');

const RV_TYPE_MULTIPLIERS = {
  travel: 1, fifthwheel: 1, classA: 1, classB: 1, classC: 1, classBC: 1,
  airstream: 1, cargo: 1, horse: 1, other: 1, specialty: 1,
};

const BOAT_PACKAGES = [
  { id: 'maint', name: 'Marine Wash', tag: 'Regular upkeep — hull, deck & glass', duration: '~1.5–2h', description: 'Hull wash, deck rinse, glass, trailer rinse when accessible.' },
  { id: 'essential', name: 'Essential Marine', tag: 'Exterior protection + vinyl', duration: '~3–4h', description: 'Marine wash plus non-skid, vinyl conditioning, spray sealant.' },
  { id: 'full', name: 'Full Marine Detail', tag: 'Complete boat refresh', duration: '~4–6h', description: 'Essential plus cabin/cockpit deep clean and marine wax/sealant.' },
  { id: 'premium', name: 'Premium Marine', tag: 'Oxidation & max protection', duration: '~6–8h', description: 'Full marine plus machine wax/sealant and gloss enhancement.' },
];

const RV_PACKAGES = [
  { id: 'maint', name: 'Maintenance Wash', tag: 'Exterior upkeep', duration: 'Depends on size', description: 'Exterior hand wash, windows, wheels, quick wax/sealant.' },
  { id: 'maint_light', name: 'Maintenance Wash + Light Interior', tag: 'Exterior + quick interior', duration: 'Depends on size', description: 'Exterior maintenance plus light cabin refresh.' },
  { id: 'interior', name: 'Interior Detail', tag: 'Full interior', duration: 'Depends on size', description: 'Complete interior from cabin to living area.' },
  { id: 'full_basic', name: 'Full RV Detail', tag: 'Inside + outside', duration: 'Depends on size', description: 'Full interior plus exterior wash and protection.' },
  { id: 'premium', name: 'Premium Exterior Detail', tag: 'One-step polish', duration: 'Depends on size', description: 'Machine polish and premium exterior protection.' },
  { id: 'full', name: 'Premium Complete RV Detail', tag: 'Polish + full interior', duration: 'Depends on size', description: 'One-step exterior polish plus complete interior detail.' },
];

function usesLengthPricing(category) {
  const c = String(category || '').toLowerCase();
  return c === 'boats' || c === 'rvs' || c === 'boat' || c === 'rv'
    || c === 'trailer' || c === 'trailers';
}

function normalizeLengthCategory(category) {
  const c = String(category || '').toLowerCase();
  if (c === 'boat') return 'boats';
  if (c === 'rv' || c === 'trailer' || c === 'trailers') return 'rvs';
  return c;
}

function getLengthPrice(cat, pkgId, ft, typeKey) {
  const category = normalizeLengthCategory(cat);
  const cfg = LENGTH_PRICING[category];
  if (!cfg) return null;
  let id = String(pkgId || '');
  if (category === 'rvs') {
    const legacy = { exterior: 'maint_light', correction: 'premium', correction_int: 'full' };
    if (legacy[id]) id = legacy[id];
  }
  if (!cfg.packages[id]) return null;
  const rule = cfg.packages[id];
  const lengthFt = Number(ft || cfg.defaultFt);
  if (!(lengthFt > 0)) return null;
  if (category === 'rvs') {
    const mult = Number(RV_TYPE_MULTIPLIERS[typeKey || 'travel']) || 1;
    const base = Number(rule.base) || 0;
    const rate = Number(rule.ratePerFoot != null ? rule.ratePerFoot : rule.perFt) || 0;
    return Math.round((base + rate * lengthFt) * mult * 100) / 100;
  }
  const raw = Number(rule.perFt) * lengthFt;
  return Math.max(Number(rule.min) || 0, Math.round(raw));
}

function lengthConfigForClient(category) {
  const categoryNorm = normalizeLengthCategory(category);
  const cfg = LENGTH_PRICING[categoryNorm];
  if (!cfg) return null;
  return {
    category: categoryNorm,
    min: cfg.min,
    max: cfg.max,
    defaultFt: cfg.defaultFt,
    estimateOver: cfg.estimateOver,
  };
}

function packagesForCategory(category) {
  const c = normalizeLengthCategory(category);
  if (c === 'boats') return BOAT_PACKAGES;
  if (c === 'rvs') return RV_PACKAGES;
  return null;
}

module.exports = {
  LENGTH_PRICING,
  RV_TYPE_MULTIPLIERS,
  BOAT_PACKAGES,
  RV_PACKAGES,
  usesLengthPricing,
  normalizeLengthCategory,
  getLengthPrice,
  lengthConfigForClient,
  packagesForCategory,
};
