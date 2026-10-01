// The booking catalog is the single server authority. This module keeps the
// length helpers and display metadata, but no longer carries a second rate table.
const { LENGTH_PRICING } = require('./booking-price-catalog');

const RV_TYPE_MULTIPLIERS = {
  travel: 1, fifthwheel: 1, motorhome: 1, classA: 1, classB: 1, classC: 1, classBC: 1,
  airstream: 1, cargo: 1, horse: 1, other: 1, specialty: 1,
};

const BOAT_PACKAGES = [
  { id: 'maint', name: 'Marine Wash', tag: 'Above-waterline wash for regular hull, deck, and windshield upkeep', duration: '~1.5–2h', description: 'Exterior hull wash above the waterline, deck and cockpit rinse, windshield cleaned, rub rail and hardware wiped, trailer rinse when accessible.' },
  { id: 'essential', name: 'Essential Marine', tag: 'Wash, non-skid scrub, vinyl care, and spray marine sealant', duration: '~3–4h', description: 'Hull wash, deck and cockpit clean, non-skid scrub, windshield, vinyl seats and cushions cleaned and conditioned, cockpit detail, spray marine sealant, trailer rinse when accessible.' },
  { id: 'full', name: 'Full Marine Detail', tag: 'Complete exterior and cabin detail with marine wax', duration: '~4–6h', description: 'Hull wash and surface detail, deck and cockpit deep clean, non-skid scrub, windshield, vinyl care, cabin deep clean when present, teak and brightwork wipe, marine wax or sealant, trailer rinse when accessible.' },
  { id: 'premium', name: 'Premium Marine', tag: 'Gloss enhancement and light-to-moderate oxidation correction', duration: '~6–8h', description: 'Full exterior and cabin detail plus hull polish, gloss enhancement, and light-to-moderate oxidation correction, machine-applied marine wax or sealant, teak conditioning, and final inspection. Above-waterline only. Severe chalking, heavy oxidation, wet sanding or multi-stage gel-coat restoration requires photo review and a custom quote before work is confirmed.' },
];

const RV_PACKAGES = [
  { id: 'exterior_wash', name: 'Exterior Wash', tag: 'A fresh exterior clean to remove everyday dirt and road grime.', duration: 'Planning estimate', description: 'Wash and dry, bugs and light road dirt, exterior windows, wheels, and tire dressing when it suits the tires. Roof, awnings, wax, polish, and the interior are not included.' },
  { id: 'maint', name: 'Wash & Protect', tag: 'A thorough wash with added protection to help maintain the finish.', duration: 'Depends on size', description: 'Hand wash, windows, wheels, tire shine, and a wax or sealant. Roof, polish, and the interior are not included.' },
  { id: 'maint_light', name: 'Maintenance Wash + Light Interior', tag: 'Wash and protect, plus a quick tidy inside.', duration: 'Depends on size', description: 'Outside wash and wax or sealant, plus vacuum and a wipe of surfaces you can reach. Driver cabin and windshield are for motorhomes.' },
  { id: 'interior', name: 'Interior Detail', tag: 'A thorough clean of your RV\'s living space, from carpets and seating to the kitchen and bathroom.', duration: 'Depends on size', description: 'A thorough clean of the living space, from carpets and seating to the kitchen and bathroom. Driver cabin and windshield are for motorhomes. The outside is not included.' },
  { id: 'full_basic', name: 'Full RV Detail', tag: 'A complete interior clean, plus an exterior wash and protection.', duration: 'Depends on size', description: 'A complete interior clean, plus an exterior wash and wax or sealant. Roof and polish are not included.' },
  { id: 'premium', name: 'Exterior Polish & Protect', tag: 'For a dull exterior that needs more than a wash.', duration: 'Depends on size', description: 'One-step polish to improve gloss. One-step polishing to improve shine and reduce light oxidation. Then wax or sealant. Heavy oxidation and deep scratches require a separate quote. Roof is separate. Interior is not included.' },
  { id: 'full', name: 'Premium Complete RV Detail', tag: 'An exterior polish and protective finish, paired with a complete interior clean.', duration: 'Depends on size', description: 'An exterior polish and protective finish, paired with a complete interior clean. The exterior matches Exterior Polish & Protect, including one-step polishing to improve shine and reduce light oxidation. Heavy oxidation and deep scratches require a separate quote. Roof is separate.' },
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
  return require('./booking-price-catalog').getLengthPrice(
    normalizeLengthCategory(cat),
    pkgId,
    ft,
    typeKey,
  );
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
