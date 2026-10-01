/**
 * Package Stage 2 — customer-facing package catalog serializer.
 *
 * Price authority is exclusively booking-price-catalog via
 * packageOptionsForVehicle (Package Stage 1). Display descriptions carry
 * no prices and are never used for quote or PaymentIntent amounts.
 *
 * Do not import Admin function modules from here.
 */

const {
  packageOptionsForVehicle,
  packageDisplayName,
} = require('./package-financial-mutation');
const { ensureVehicleIds } = require('./booking-aggregate');
const { LENGTH_PRICING } = require('./booking-price-catalog');

/**
 * Complete Interior Detail inclusions. Prices stay in booking-price-catalog.
 * Ceramic packages do not copy this list.
 */
const INTERIOR_SERVICE_INCLUSIONS = Object.freeze([
  'Vacuuming',
  'Shampoo and extraction where appropriate',
  'Steam cleaning',
  'Surface cleaning',
  'UV protection',
  'Door jambs',
  'Cargo area',
]);

/** Display-only descriptions (no prices). */
const PACKAGE_DESCRIPTIONS = {
  cars: {
    maint: 'Exterior hand wash, wheels dressed, interior vacuum, dash wipe, UV protectant. Ideal for monthly upkeep.',
    interior: 'Deep vacuum including trunk and truck bed where applicable, fabric shampoo, leather conditioning, steam clean, door jambs, headliner, UV protectant on plastics.',
    full: 'Complete exterior and interior detail with clay bar, shampoo, steam, door jambs, headliner, trunk and truck bed where applicable, and sealant protection.',
    refresh: 'Clay bar, chemical decontamination, single-pass paint correction, sealant, deep wheel detail, and Rain-X included.',
    premium: 'Clay bar, single-pass correction, Rain-X, wheel cleaning and tire shine, exterior plastic restoration, door jambs, headliner, trunk and truck bed where applicable.',
    ceramic_1yr: 'Professional surface preparation, gloss enhancement, hydrophobic behavior, and contamination resistance on painted exterior surfaces. Expected durability is up to 1 year with required maintenance. Does not include interior, engine bay, undercarriage, or coating on wheels, glass, or trim.',
    ceramic_3yr: 'Professional surface preparation, gloss enhancement, hydrophobic behavior, and contamination resistance on painted exterior surfaces. Expected durability is up to 3 years with required maintenance. Does not include interior, engine bay, undercarriage, or coating on wheels, glass, or trim.',
  },
  boats: {
    maint: 'Exterior marine wash and rinse for regularly maintained boats.',
    essential: 'Essential marine wash with light interior wipe-down.',
    full: 'Full marine detail for exterior and accessible interior areas.',
    premium: 'Premium marine detail with expanded exterior protection.',
  },
  rvs: {
    exterior_wash: 'A fresh exterior clean for everyday dirt and road grime. Wash and dry, bugs and light road dirt, exterior windows, wheels, and tire dressing when it suits the tires. Roof, awnings, wax, polish, and the interior are not included.',
    maint: 'A thorough wash with wax or sealant to help maintain the finish. Roof, polish, and the interior are not included.',
    maint_light: 'Wash and protect outside, plus a quick tidy of floors, seats, and kitchen and bath surfaces you can reach. Driver cabin and windshield are for motorhomes. No shampoo and no roof.',
    interior: 'A thorough clean of your RV\'s living space, from carpets and seating to the kitchen and bathroom. Driver cabin and windshield are for motorhomes. The outside is not included.',
    full_basic: 'A complete interior clean, plus an exterior wash and protection. Roof and polish are not included.',
    premium: 'For a dull exterior that needs more than a wash. One-step polish to improve gloss, light haze improvement and light oxidation care where the surface allows, then wax or sealant. Does not remove all scratches, all haze, or all oxidation. Roof is separate. Interior is not included.',
    full: 'An exterior polish and protective finish, paired with a complete interior clean. The exterior matches Exterior Polish & Protect: one-step polish, light haze improvement and light oxidation care where the surface allows, then wax or sealant. This does not remove all scratches, all haze, or all oxidation. Heavy oxidation, deep scratches, and the roof need a separate quote.',
  },
  powersports: {
    wash: 'Wash and shine for powersports units.',
    essential: 'Essential detail for exterior and riding surfaces.',
    full: 'Full powersports detail.',
    premium: 'Premium powersports protection detail.',
    maintenance: 'Routine professional Powersports cleaning, upkeep and protection.',
    restore: 'Corrective Powersports detailing for paint enhancement, oxidation and deeper polishing.',
  },
  fleet: {
    maint: 'Fleet maintenance wash.',
    essential: 'Fleet essential detail.',
    full: 'Fleet full detail.',
    premium: 'Fleet premium protection.',
    custom: 'Custom fleet quote — final total confirmed by Cardetail1.',
  },
};

function packageDescription(category, id) {
  const cat = String(category || '').trim() || 'cars';
  const key = String(id || '').trim();
  return (PACKAGE_DESCRIPTIONS[cat] && PACKAGE_DESCRIPTIONS[cat][key]) || '';
}

/** Raw catalog-shaped vehicles for package pricing probes (keeps tier/length/rvType). */
function rawVehiclesForPackageCatalog(booking) {
  const raw = (booking?.service && Array.isArray(booking.service.vehicles) && booking.service.vehicles.length)
    ? booking.service.vehicles
    : (Array.isArray(booking?.vehicles) ? booking.vehicles : []);
  return ensureVehicleIds(raw.length
    ? raw
    : [{
      vehicleLabel: booking?.vehicleLabel || booking?.vehicle || '',
      category: booking?.vehicleCategory || booking?.cat || 'cars',
      cat: booking?.vehicleCategory || booking?.cat || 'cars',
      tierLabel: booking?.vehicleTier || booking?.tierLabel || '',
      tierKey: booking?.tierKey || booking?.vehicleTier || '',
      pkgId: booking?.packageId || booking?.pkgId || '',
      pkgName: booking?.package || booking?.packageName || '',
      lengthFt: booking?.vehicleLengthFt || booking?.lengthFt || 0,
      rvType: booking?.rvType || '',
      addOnIds: booking?.addOnIds || [],
      addons: booking?.addons || [],
    }]);
}

/**
 * Booking-scoped canonical package options for the Customer portal.
 * Every option.priceCents comes from booking-price-catalog probes.
 */
function serializeCanonicalPackageCatalogForBooking(booking) {
  const vehicles = rawVehiclesForPackageCatalog(booking).map((v) => {
    const { category, currentPackageId, options } = packageOptionsForVehicle(v, booking);
    const tierKey = String(v.tierKey || v.tier || '').trim();
    const lengthFt = Number(v.lengthFt || 0) || 0;
    const lengthPriced = !!(LENGTH_PRICING[category] && LENGTH_PRICING[category].packages);
    const vehicleId = String(v.vehicleId || '').trim();
    return {
      vehicleId,
      label: String(v.vehicleLabel || v.vehicle || vehicleId || 'Vehicle').trim(),
      category,
      currentPackageId,
      tierKey: tierKey || null,
      lengthFt: lengthFt > 0 ? lengthFt : null,
      lengthPriced,
      options: options.map((o) => ({
        packageId: o.id,
        id: o.id,
        label: o.name || packageDisplayName(category, o.id),
        name: o.name || packageDisplayName(category, o.id),
        description: packageDescription(category, o.id),
        priceCents: Math.round(Number(o.priceCents) || 0),
        current: !!o.current,
        pricedByLength: lengthPriced,
      })),
    };
  }).filter((v) => v.vehicleId);

  const packageCatalogByVehicle = {};
  for (const row of vehicles) {
    packageCatalogByVehicle[row.vehicleId] = row;
  }

  return {
    source: 'booking-price-catalog',
    vehicles,
    packageCatalogByVehicle,
  };
}

module.exports = {
  INTERIOR_SERVICE_INCLUSIONS,
  PACKAGE_DESCRIPTIONS,
  packageDescription,
  rawVehiclesForPackageCatalog,
  serializeCanonicalPackageCatalogForBooking,
};
