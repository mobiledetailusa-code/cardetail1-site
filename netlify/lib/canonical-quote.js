/**
 * Canonical server quote service — sole pricing authority for Release A.
 * Wraps booking-price-catalog; ignores client/operator totals.
 */

const crypto = require('crypto');
const {
  validateAndRecalculateBookingPricing,
  computeBookingServiceSubtotal,
  PRICING,
} = require('./booking-price-catalog');
const { ensureVehicleIds, newVehicleId } = require('./booking-aggregate');
const { dollarsToCents, centsToDollars, asArray } = require('./historical-adapter');

const CATALOG_VERSION = 'booking-price-catalog';

function inputsHash(service, extras = {}) {
  const payload = JSON.stringify({
    zip: service?.zip || '',
    vehicles: asArray(service?.vehicles).map((v) => ({
      vehicleId: v.vehicleId,
      category: v.category || v.cat,
      tier: v.tier || v.tierKey || v.tierLabel,
      packageId: v.packageId || v.pkgId,
      addOnIds: asArray(v.addOnIds).length
        ? asArray(v.addOnIds).slice().sort()
        : asArray(v.addons).map((a) => a.id).filter(Boolean).sort(),
      lengthFt: v.lengthFt || 0,
    })),
    travelCents: extras.travelCents || 0,
    adjustmentCents: extras.adjustmentCents || 0,
    offerCents: extras.offerCents || 0,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function bookingShapeFromService(service, base = {}) {
  const vehicles = ensureVehicleIds(service.vehicles || []);
  return {
    ...base,
    zipCode: service.zip || base.zipCode || '',
    zip: service.zip || base.zip || '',
    address: service.serviceAddress || base.address || '',
    vehicles: vehicles.map((v) => {
      const cat = v.category || v.cat || 'cars';
      const tiers = PRICING[cat]?.tiers || {};
      const rawTier = v.tierKey || v.tier || '';
      const knownKey = rawTier && tiers[rawTier] ? rawTier : (v.tierKey && tiers[v.tierKey] ? v.tierKey : '');
      const tierLabel = v.tierLabel
        || (!knownKey && (v.tier || v.tierKey))
        || (knownKey && tiers[knownKey]?.label)
        || '';
      return {
        ...v,
        cat,
        pkgId: v.packageId || v.pkgId,
        pkgName: v.pkgName || v.packageName || '',
        tierKey: knownKey || v.tierKey || undefined,
        tierLabel,
        addons: asArray(v.addons).length
          ? asArray(v.addons)
          : asArray(v.addOnIds).map((id) => ({ id })),
      };
    }),
  };
}

/**
 * Apply a structured delta to a target vehicle. Duplicate add-on is a no-op.
 * addOnIdsToRemove is accepted only when explicitly provided (no UI until implemented).
 */
function applyServiceDelta(service, target, delta) {
  const vehicles = ensureVehicleIds(service.vehicles || []);
  let vehicleId = target?.vehicleId;
  if (!vehicleId && vehicles.length === 1) vehicleId = vehicles[0].vehicleId;
  if (!vehicleId) {
    return { ok: false, error: 'vehicle_target_required' };
  }

  const idx = vehicles.findIndex((v) => v.vehicleId === vehicleId);
  if (idx < 0) return { ok: false, error: 'vehicle_not_found' };

  const vehicle = { ...vehicles[idx] };
  const d = delta || {};

  if (d.packageId) {
    vehicle.packageId = d.packageId;
    vehicle.pkgId = d.packageId;
    if (d.packageName) {
      vehicle.pkgName = d.packageName;
      vehicle.packageName = d.packageName;
    }
  }

  if (d.vehicleCategory || d.category) {
    const cat = d.vehicleCategory || d.category;
    vehicle.category = cat;
    vehicle.cat = cat;
  }
  if (d.tierKey || d.tier) {
    const tierKey = d.tierKey || d.tier;
    vehicle.tierKey = tierKey;
    vehicle.tier = tierKey;
    if (d.tierLabel) vehicle.tierLabel = d.tierLabel;
  }
  if (d.lengthFt != null && d.lengthFt !== '') {
    vehicle.lengthFt = Number(d.lengthFt) || 0;
  }

  let existingIds = new Set(
    asArray(vehicle.addOnIds).length
      ? asArray(vehicle.addOnIds)
      : asArray(vehicle.addons).map((a) => a.id).filter(Boolean)
  );

  const toAdd = asArray(d.addOnIdsToAdd);
  const duplicateOnly = toAdd.length > 0 && toAdd.every((id) => existingIds.has(id));
  if (duplicateOnly && !d.packageId && !d.addOnIdsToRemove?.length) {
    return {
      ok: true,
      noop: true,
      service: { ...service, vehicles },
      reason: 'duplicate_addon',
    };
  }

  for (const id of toAdd) {
    if (!existingIds.has(id)) existingIds.add(id);
  }

  if (Array.isArray(d.addOnIdsToRemove) && d.addOnIdsToRemove.length) {
    for (const id of d.addOnIdsToRemove) existingIds.delete(id);
  }

  vehicle.addOnIds = [...existingIds];
  // Keep addon objects for catalog pricing (ids only is enough for computeAddonTotal)
  const prevById = new Map(asArray(vehicle.addons).map((a) => [a.id, a]));
  vehicle.addons = vehicle.addOnIds.map((id) => prevById.get(id) || { id });

  if (d.requestedDate != null || d.requestedTime != null || d.serviceAddress != null) {
    // Schedule/address deltas are carried outside service structure
  }

  const nextVehicles = vehicles.slice();
  nextVehicles[idx] = vehicle;
  return {
    ok: true,
    noop: false,
    service: {
      ...service,
      vehicles: nextVehicles,
      serviceAddress: d.serviceAddress != null ? d.serviceAddress : service.serviceAddress,
    },
    schedule: {
      preferredDate: d.requestedDate,
      preferredTime: d.requestedTime,
    },
  };
}

/**
 * Produce an immutable quote from structured service input.
 * Client totals are ignored.
 */
function quoteService(service, opts = {}) {
  const travelCents = Math.round(Number(opts.travelCents) || 0);
  const adjustmentCents = Math.round(Number(opts.adjustmentCents) || 0);
  const offerCents = Math.round(Number(opts.offerCents) || 0);
  const basedOnBookingVersion = Math.max(0, Math.round(Number(opts.basedOnBookingVersion) || 0));
  const previousQuoteVersion = Math.max(0, Math.round(Number(opts.previousQuoteVersion) || 0));

  const shaped = bookingShapeFromService(service, opts.bookingBase || {});
  const priced = computeBookingServiceSubtotal(shaped);
  if (!priced.ok) {
    return { ok: false, error: priced.error || 'invalid_pricing' };
  }

  const serviceSubtotalCents = dollarsToCents(priced.serviceSubtotal);
  const approvedCents = Math.max(
    0,
    serviceSubtotalCents + travelCents + adjustmentCents - Math.abs(offerCents)
  );

  const lineItems = [];
  for (const v of priced.vehicles) {
    lineItems.push({
      kind: 'package',
      vehicleId: v.vehicleId,
      packageId: v.pkgId,
      amountCents: dollarsToCents(v.basePrice),
    });
    for (const a of asArray(v.addons)) {
      lineItems.push({
        kind: 'addon',
        vehicleId: v.vehicleId,
        addonId: a.id,
        amountCents: dollarsToCents(Number(a.price || 0) * Number(a.qty || 1)),
      });
    }
  }
  if (travelCents) lineItems.push({ kind: 'travel', amountCents: travelCents });
  if (adjustmentCents) lineItems.push({ kind: 'adjustment', amountCents: adjustmentCents });
  if (offerCents) lineItems.push({ kind: 'offer', amountCents: -Math.abs(offerCents) });

  const quote = {
    quoteVersion: previousQuoteVersion + 1,
    basedOnBookingVersion,
    catalogVersion: CATALOG_VERSION,
    currency: 'usd',
    inputsHash: inputsHash(service, { travelCents, adjustmentCents, offerCents }),
    lineItems,
    serviceSubtotalCents,
    travelCents,
    adjustmentCents,
    offerCents: Math.abs(offerCents),
    approvedCents,
    createdAt: new Date().toISOString(),
  };

  return {
    ok: true,
    quote,
    vehicles: priced.vehicles,
    service: {
      ...service,
      vehicles: ensureVehicleIds(priced.vehicles.map((v, i) => ({
        ...(service.vehicles[i] || {}),
        ...v,
        vehicleId: (service.vehicles[i] && service.vehicles[i].vehicleId) || v.vehicleId || newVehicleId(),
      }))),
    },
    approvedDollars: centsToDollars(approvedCents),
  };
}

/** Canonical matrix helpers for tests / acceptance */
function canonicalCarPackagePrice(tierKey, packageId) {
  const tier = PRICING.cars?.tiers?.[tierKey];
  if (!tier) return null;
  return tier[packageId] != null ? Number(tier[packageId]) : null;
}

function canonicalAddonPrice(category, addonId) {
  const addons = PRICING[category]?.addons || PRICING.cars.addons;
  const found = addons.find((a) => a.id === addonId);
  return found ? Number(found.price) : null;
}

module.exports = {
  CATALOG_VERSION,
  inputsHash,
  applyServiceDelta,
  quoteService,
  bookingShapeFromService,
  canonicalCarPackagePrice,
  canonicalAddonPrice,
  validateAndRecalculateBookingPricing,
};
