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

/** Display-only descriptions (no prices). */
const PACKAGE_DESCRIPTIONS = {
  cars: {
    maint: 'Exterior hand wash, wheels dressed, interior vacuum, dash wipe, UV protectant. Ideal for monthly upkeep.',
    interior: 'Deep vacuum including trunk and truck bed where applicable, fabric shampoo, leather conditioning, steam clean, door jambs, headliner, UV protectant on plastics.',
    full: 'Complete exterior and interior detail with clay bar, shampoo, steam, door jambs, headliner, trunk and truck bed where applicable, and sealant protection.',
    refresh: 'Clay bar, chemical decontamination, single-pass paint correction, sealant, deep wheel detail, and Rain-X included.',
    premium: 'Clay bar, single-pass correction, Rain-X, wheel cleaning and tire shine, exterior plastic restoration, door jambs, headliner, trunk and truck bed where applicable.',
  },
  boats: {
    maint: 'Exterior marine wash and rinse for regularly maintained boats.',
    essential: 'Essential marine wash with light interior wipe-down.',
    full: 'Full marine detail for exterior and accessible interior areas.',
    premium: 'Premium marine detail with expanded exterior protection.',
  },
  rvs: {
    maint: 'Exterior maintenance wash for RVs and trailers.',
    maint_light: 'Exterior wash and protect for regularly maintained units.',
    interior: 'Interior detail for living areas and soft surfaces.',
    full_basic: 'Full RV detail covering exterior and interior basics.',
    premium: 'Premium exterior detail and protection.',
    full: 'Premium complete RV detail.',
  },
  powersports: {
    wash: 'Wash and shine for powersports units.',
    essential: 'Essential detail for exterior and riding surfaces.',
    full: 'Full powersports detail.',
    premium: 'Premium powersports protection detail.',
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
  PACKAGE_DESCRIPTIONS,
  packageDescription,
  rawVehiclesForPackageCatalog,
  serializeCanonicalPackageCatalogForBooking,
};
