/**
 * Resolve customer-facing package details for a booking vehicle.
 * Authority order: packageSnapshot → published catalog → unavailable message.
 * Never invent inclusions from package names alone.
 */

const { CAR_PACKAGES } = require('./customer-catalog');
const { BOAT_PACKAGES, RV_PACKAGES, packagesForCategory } = require('./length-pricing');

const UNAVAILABLE_MESSAGE =
  'Package details are unavailable for this older booking. Contact us if you need clarification.';

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function moneyFromCents(cents) {
  const n = Math.round(Number(cents) || 0);
  return Math.round(n) / 100;
}

function categoryKey(vehicle) {
  return String(vehicle?.cat || vehicle?.category || 'cars').trim().toLowerCase() || 'cars';
}

function packageIdOf(vehicle) {
  return String(vehicle?.packageId || vehicle?.pkgId || vehicle?.package || '').trim();
}

function normalizeStringList(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x || '').trim()).filter(Boolean);
}

function catalogPackagesForCategory(cat) {
  const c = String(cat || 'cars').toLowerCase();
  if (c === 'cars' || c === 'car' || c === 'suv' || c === 'truck') return CAR_PACKAGES;
  if (c === 'boats' || c === 'boat') return BOAT_PACKAGES;
  if (c === 'rvs' || c === 'rv' || c === 'trailer' || c === 'trailers') return RV_PACKAGES;
  const via = packagesForCategory(c);
  return Array.isArray(via) ? via : [];
}

function catalogEntryForVehicle(vehicle) {
  const cat = categoryKey(vehicle);
  const pkgId = packageIdOf(vehicle);
  if (!pkgId) return null;
  const list = catalogPackagesForCategory(cat);
  const found = list.find((p) => String(p.id) === pkgId);
  return found ? { ...found, category: cat } : null;
}

function selectedAddonsForVehicle(vehicle, { stripIds = false } = {}) {
  const named = Array.isArray(vehicle?.addons)
    ? vehicle.addons.map((a) => {
      const row = {
        name: String(a?.name || a?.label || a?.id || '').trim(),
        price: money(a?.price != null ? a.price : moneyFromCents(a?.priceCents)),
      };
      if (!stripIds) row.id = String(a?.id || a?.addonId || '').trim();
      return row;
    }).filter((a) => a.name)
    : [];
  if (named.length) return named;
  const ids = Array.isArray(vehicle?.addOnIds) ? vehicle.addOnIds : [];
  return ids.map((id) => {
    const row = {
      name: String(id || '').trim(),
      price: null,
    };
    if (!stripIds) row.id = String(id || '').trim();
    return row;
  }).filter((a) => a.name);
}

/**
 * Full resolver (internal + tests). Includes source + addons alias.
 */
function resolvePackageDetailsForVehicle(vehicle, opts = {}) {
  const v = vehicle && typeof vehicle === 'object' ? vehicle : {};
  const packageName = String(
    v.packageName || v.pkgName || opts.packageName || packageIdOf(v) || 'Package'
  ).trim() || 'Package';
  const vehicleSubtotal = v.subtotal != null
    ? money(v.subtotal)
    : (v.lineTotalCents != null ? moneyFromCents(v.lineTotalCents) : null);
  const stripIds = !!opts.stripIds;
  const selectedAddons = selectedAddonsForVehicle(v, { stripIds });

  const snap = v.packageSnapshot && typeof v.packageSnapshot === 'object'
    ? v.packageSnapshot
    : null;

  if (snap) {
    const included = normalizeStringList(
      snap.includedServices || snap.includes || snap.features || snap.whatsIncluded || snap.feats
    );
    const limitations = normalizeStringList(
      snap.limitations || snap.exclusions || snap.importantDetails
    );
    const description = String(snap.description || '').trim();
    const packagePrice = snap.priceCents != null
      ? moneyFromCents(snap.priceCents)
      : (snap.price != null ? money(snap.price) : (v.basePrice != null ? money(v.basePrice) : null));
    const hasAuthority = included.length > 0 || description || limitations.length > 0;
    if (hasAuthority) {
      const name = String(snap.name || packageName).trim() || packageName;
      return {
        available: true,
        source: 'snapshot',
        packageName: name,
        name,
        description,
        includedServices: included,
        limitations,
        packagePrice,
        selectedAddons,
        addons: selectedAddons,
        vehicleSubtotal,
        unavailableMessage: null,
      };
    }
  }

  const catalog = catalogEntryForVehicle(v);
  if (catalog) {
    const included = normalizeStringList(catalog.feats || catalog.features || catalog.includes || catalog.includedServices);
    const limitations = normalizeStringList(catalog.limitations || catalog.exclusions || catalog.miss);
    const description = String(catalog.description || '').trim();
    const packagePrice = v.basePrice != null
      ? money(v.basePrice)
      : (catalog.basePrice != null ? money(catalog.basePrice) : (catalog.price != null ? money(catalog.price) : null));
    // Authoritative catalog hit: description and/or feats count as available.
    // Do not invent feats when the catalog entry has none (boats/RVs may be description-only).
    const name = String(catalog.name || packageName).trim() || packageName;
    return {
      available: true,
      source: 'catalog',
      packageName: name,
      name,
      description,
      includedServices: included,
      limitations,
      packagePrice,
      selectedAddons,
      addons: selectedAddons,
      vehicleSubtotal,
      unavailableMessage: null,
    };
  }

  return {
    available: false,
    source: 'unavailable',
    packageName,
    name: packageName,
    description: '',
    includedServices: [],
    limitations: [],
    packagePrice: v.basePrice != null ? money(v.basePrice) : null,
    selectedAddons,
    addons: selectedAddons,
    vehicleSubtotal,
    unavailableMessage: UNAVAILABLE_MESSAGE,
  };
}

/**
 * Customer portal projection — strip internal addon IDs from the details payload.
 */
function resolvePackageDetailsForCustomerView(vehicle, opts = {}) {
  return resolvePackageDetailsForVehicle(vehicle, { ...opts, stripIds: true });
}

module.exports = {
  resolvePackageDetailsForVehicle,
  resolvePackageDetailsForCustomerView,
  UNAVAILABLE_MESSAGE,
};
