/**
 * Canonical submitted booking aggregate — schemaVersion, bookingVersion, service, quote, ledger.
 */

const crypto = require('crypto');
const { CURRENT_SCHEMA_VERSION, asArray, dollarsToCents, centsToDollars } = require('./historical-adapter');
const { isDraftRecord } = require('./booking-visibility');

function newVehicleId() {
  return `veh_${crypto.randomBytes(6).toString('hex')}`;
}

function remainingCents(ledger) {
  const approved = Math.max(0, Math.round(Number(ledger?.approvedCents) || 0));
  const settled = Math.max(0, Math.round(Number(ledger?.settledCents) || 0));
  const credited = Math.max(0, Math.round(Number(ledger?.creditedCents) || 0));
  return Math.max(0, approved - settled - credited);
}

function ensureVehicleIds(vehicles) {
  return asArray(vehicles).map((v, idx) => {
    const vehicleId = String(v.vehicleId || v.id || '').trim() || newVehicleId();
    return {
      ...v,
      vehicleId,
      category: v.category || v.cat || 'cars',
      cat: v.cat || v.category || 'cars',
      packageId: v.packageId || v.pkgId || '',
      pkgId: v.pkgId || v.packageId || '',
      addOnIds: Array.isArray(v.addOnIds)
        ? v.addOnIds
        : asArray(v.addons).map((a) => a.id || a.addonId).filter(Boolean),
      addons: asArray(v.addons),
      _index: idx,
    };
  });
}

function deriveCompatibilityService(service) {
  const vehicles = asArray(service?.vehicles);
  const primary = vehicles[0] || {};
  const packageName = primary.pkgName || primary.packageName || '';
  const packageId = primary.packageId || primary.pkgId || '';
  const addons = vehicles.flatMap((v) => asArray(v.addons));
  return {
    package: packageName,
    // Legacy alias for package name — do NOT overwrite canonical service object
    serviceLabel: packageName,
    packageId,
    addons,
    vehicleCategory: primary.category || primary.cat || '',
    vehicle: primary.vehicleLabel || primary.vehicle || '',
    vehicleLabel: primary.vehicleLabel || primary.vehicle || '',
    vehicleMake: primary.make || primary.vehicleMake || '',
    vehicleModel: primary.model || primary.vehicleModel || '',
    vehicleYear: primary.year || primary.vehicleYear || '',
    vehicleLengthFt: primary.lengthFt || primary.vehicleLengthFt || 0,
    vehicles,
  };
}

function deriveMoneyCompatibility(ledger) {
  const approved = centsToDollars(ledger.approvedCents);
  const settled = centsToDollars(ledger.settledCents);
  const due = centsToDollars(remainingCents(ledger));
  return {
    approvedFinalAmount: approved,
    totalPrice: approved,
    amountPaid: settled,
    paidAmount: settled,
    amountDueApproved: due,
    balanceDue: due,
  };
}

/**
 * Normalize any booking-shaped record into the Release A aggregate shape (in memory).
 * Does not write to the store.
 */
function normalizeAggregate(raw, opts = {}) {
  const b = raw && typeof raw === 'object' ? { ...raw } : {};
  if (isDraftRecord(b) && !opts.allowDraft) {
    return { ok: false, error: 'draft_not_aggregate', aggregate: null };
  }

  const schemaVersion = Number.isFinite(Number(b.schemaVersion))
    ? Number(b.schemaVersion)
    : (opts.forceCurrent ? CURRENT_SCHEMA_VERSION : 0);
  const bookingVersion = Math.max(0, Math.round(Number(b.bookingVersion) || 0));

  let vehicles = ensureVehicleIds(
    Array.isArray(b.service?.vehicles) && b.service.vehicles.length
      ? b.service.vehicles
      : (Array.isArray(b.vehicles) ? b.vehicles : [])
  );

  if (!vehicles.length && (b.package || b.packageId || b.vehicleCategory)) {
    vehicles = ensureVehicleIds([{
      vehicleId: b.primaryVehicleId || newVehicleId(),
      category: b.vehicleCategory || b.cat || 'cars',
      cat: b.vehicleCategory || b.cat || 'cars',
      tier: b.vehicleTier || b.tierLabel || '',
      tierLabel: b.vehicleTier || b.tierLabel || '',
      make: b.vehicleMake || b.make || '',
      model: b.vehicleModel || b.model || '',
      year: b.vehicleYear || b.year || '',
      packageId: b.packageId || b.pkgId || '',
      pkgId: b.packageId || b.pkgId || '',
      pkgName: b.package || b.service || '',
      lengthFt: b.vehicleLengthFt || b.lengthFt || 0,
      vehicleLabel: b.vehicleLabel || b.vehicle || '',
      addons: asArray(b.addons),
      addOnIds: asArray(b.addons).map((a) => a.id).filter(Boolean),
    }]);
  }

  // Top-level address wins over nested service.serviceAddress so admin/customer
  // address applies are not reverted on the next normalize/strong read.
  const service = {
    serviceAddress: (b.address && String(b.address).trim())
      || (b.service && typeof b.service === 'object' ? b.service.serviceAddress : null)
      || '',
    zip: (b.zipCode && String(b.zipCode).trim())
      || (b.zip && String(b.zip).trim())
      || (b.service && typeof b.service === 'object' ? b.service.zip : null)
      || '',
    vehicles,
  };

  let ledger = b.ledger && typeof b.ledger === 'object'
    ? {
        currency: b.ledger.currency || 'usd',
        approvedCents: Math.max(0, Math.round(Number(b.ledger.approvedCents) || 0)),
        settledCents: Math.max(0, Math.round(Number(b.ledger.settledCents) || 0)),
        creditedCents: Math.max(0, Math.round(Number(b.ledger.creditedCents) || 0)),
        pendingCents: Math.max(0, Math.round(Number(b.ledger.pendingCents) || 0)),
        lastReconciledAt: b.ledger.lastReconciledAt || null,
        entries: asArray(b.ledger.entries),
      }
    : {
        currency: 'usd',
        approvedCents: dollarsToCents(
          b.approvedFinalAmount != null ? b.approvedFinalAmount : (b.totalPrice || 0)
        ),
        settledCents: dollarsToCents(b.amountPaid || b.paidAmount || 0),
        creditedCents: 0,
        pendingCents: 0,
        lastReconciledAt: null,
        entries: [],
      };

  if (b._historicalPaidClosed) {
    ledger = {
      ...ledger,
      settledCents: Math.max(ledger.settledCents, ledger.approvedCents),
    };
  }

  const quote = b.quote && typeof b.quote === 'object'
    ? { ...b.quote }
    : {
        quoteVersion: Math.max(0, Math.round(Number(b.quoteVersion) || 0)),
        basedOnBookingVersion: bookingVersion,
        catalogVersion: 'booking-price-catalog',
        currency: 'usd',
        approvedCents: ledger.approvedCents,
        lineItems: [],
        createdAt: b.updatedAt || b.createdAt || null,
      };

  const money = deriveMoneyCompatibility(ledger);

  const compat = deriveCompatibilityService(service);

  const aggregate = {
    ...b,
    kind: 'booking',
    schemaVersion: opts.forceCurrent ? CURRENT_SCHEMA_VERSION : Math.max(schemaVersion, 0),
    bookingVersion,
    quoteVersion: quote.quoteVersion || 0,
    quote,
    ledger,
    changeRequests: asArray(b.changeRequests),
    paymentAttempts: asArray(b.paymentAttempts),
    events: asArray(b.events || b.eventLog),
    // Derived compatibility — never independent write authorities when using commands
    ...compat,
    ...money,
    // Canonical service object MUST win over legacy package-name "service" alias
    service,
    // Keep legacy package-name readable as top-level package / serviceLabel only
    package: compat.package || b.package || '',
    zipCode: service.zip || b.zipCode || '',
    address: service.serviceAddress || b.address || '',
  };

  // Legacy consumers still read booking.service as package name string
  if (typeof b.service === 'string' && b.service && !compat.package) {
    aggregate.package = b.service;
  }

  return { ok: true, aggregate };
}

/**
 * Build next aggregate after a mutation. Preserves unknown/Technician fields from previous.
 */
function buildNextAggregate(previous, patches, { incrementVersion = true } = {}) {
  const base = previous && typeof previous === 'object' ? { ...previous } : {};
  const nextVersion = incrementVersion
    ? Math.max(0, Math.round(Number(base.bookingVersion) || 0)) + 1
    : Math.max(0, Math.round(Number(base.bookingVersion) || 0));

  const merged = {
    ...base,
    ...patches,
    bookingVersion: nextVersion,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    kind: 'booking',
    updatedAt: patches.updatedAt || new Date().toISOString(),
  };

  // Re-derive service/money if ledger or service provided
  if (patches.ledger) {
    Object.assign(merged, deriveMoneyCompatibility(patches.ledger));
  }
  if (patches.service) {
    Object.assign(merged, deriveCompatibilityService(patches.service));
    merged.vehicles = patches.service.vehicles;
  }
  if (patches.quote) {
    merged.quoteVersion = patches.quote.quoteVersion;
  }

  return merged;
}

function materialProjection(aggregate) {
  const { ok, aggregate: norm } = normalizeAggregate(aggregate, { forceCurrent: false });
  if (!ok) return null;
  const rem = remainingCents(norm.ledger);
  return {
    bookingId: norm.id || norm.bookingId,
    bookingVersion: norm.bookingVersion,
    schemaVersion: norm.schemaVersion,
    quoteVersion: norm.quoteVersion || norm.quote?.quoteVersion || 0,
    effectiveLifecycle: norm.appointmentStatus || norm.jobStatus || norm.status || '',
    service: norm.service,
    approvedCents: norm.ledger.approvedCents,
    settledCents: norm.ledger.settledCents,
    creditedCents: norm.ledger.creditedCents,
    remainingCents: rem,
    requestSummaries: asArray(norm.changeRequests).map((r) => ({
      requestId: r.requestId || r.id,
      requestVersion: r.requestVersion,
      status: r.status,
      appliedBookingVersion: r.appliedBookingVersion || null,
      type: r.type || r.requestType,
    })),
    updatedAt: norm.updatedAt || '',
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  newVehicleId,
  remainingCents,
  ensureVehicleIds,
  deriveCompatibilityService,
  deriveMoneyCompatibility,
  normalizeAggregate,
  buildNextAggregate,
  materialProjection,
};
