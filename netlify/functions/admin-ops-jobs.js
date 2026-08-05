// Admin-only jobs feed + admin ops actions for Admin Ops dashboard.
const { blobsStore, listAllBlobs, jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const {
  projectJobForAdmin, projectJobForAdminList, normalizeJobStatus, appendEventLog,
} = require('../lib/ops-workflow');
const { getOpsSettings } = require('../lib/ops-config');
const { createAuctionForBooking, assignAuctionWinnerToBooking } = require('../lib/auction-ops');
const { applyServerTravelAndTotal } = require('../lib/travel-fee');
const {
  applyServerOffersToBooking,
  evaluateBookingOfferPreview,
} = require('../lib/booking-offers');
const { auditEntry, appendAudit, listAuditForBooking } = require('../lib/operations-audit');
const { getBooking } = require('../lib/ops-db');
const { guardStripeOrReject } = require('../lib/stripe-mode');
const {
  setBookingStoreOverride,
  commitBooking,
  getBookingRecord,
} = require('../lib/booking-repository');
const {
  buildNextAggregate,
  normalizeAggregate,
} = require('../lib/booking-aggregate');
const { buildSyncEnvelope, syncHeaders } = require('../lib/sync-response');
const {
  supersedeOpenAttempts,
  expireSupersededAttempts,
} = require('../lib/payment-service');
const { dollarsToCents, centsToDollars } = require('../lib/historical-adapter');
const { normalizeIdempotencyKey } = require('../lib/operation-idempotency');
const {
  createAdminAppointment,
  updateCustomerContact,
  mutateVehicles,
  updateServicePackage,
  adminTechStatus,
  approveAdjustment,
  rejectAdjustment,
  setApprovedFinalAmount,
  resolveAdminCashSettlement,
  markCashReceived,
  markCardOnSite,
  generateCustomerLinks,
  reopenAppointment,
} = require('../lib/admin-booking-mutations');

const MONEY_MUTATION_ACTIONS = new Set([
  'update_service',
  'change_package',
  'update_vehicles',
  'approve_adjustment',
  'reject_adjustment',
  'set_approved_final_amount',
  'mark_cash_received',
  'mark_card_on_site',
  'apply_welcome_offer',
  'remove_welcome_offer',
  'record_job_balance',
]);

const TEST_SIGNALS = [
  b => b.isTest === true,
  b => /^test/i.test(String(b.firstName || '')),
  b => /^test/i.test(String(b.lastName || '')),
  b => /test/i.test(String(b.email || '')),
  b => /test/i.test(String(b.id || '')),
  b => /smoke|prodtest|pendtest|cashtest|validationtest/i.test(
    [b.firstName, b.lastName, b.email, b.id, b.notes, b.customerNote].join(' ')
  ),
  b => String(b.vehicle || b.vehicleCategory || '').toLowerCase().includes('test'),
  b => String(b.notes || b.customerNote || '').toLowerCase().includes('test booking'),
];

function isLikelyTestBooking(b) {
  return TEST_SIGNALS.some(fn => { try { return fn(b); } catch { return false; } });
}

function archiveBookingRecord(booking, reason) {
  const now = new Date().toISOString();
  return {
    ...booking,
    isTest: true,
    archived: true,
    archivedReason: sanitizeText(reason, 200) || 'admin_archive',
    archivedAt: now,
    archivedBy: 'admin',
    previousStatus: booking.status || '',
    status: 'archived_test',
    jobStatus: 'archived_test',
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'archived_test', by: 'admin', reason }),
  };
}

async function listJobs(q) {
  const showTest = String(q.showTest || '') === '1';
  const statusFilter = sanitizeText(q.jobStatus || q.status, 64);
  const search = sanitizeText(q.search, 120).toLowerCase();
  let store;
  try {
    store = await blobsStore('cd1-bookings');
  } catch (e) {
    console.error('[admin-ops-jobs] blobsStore(cd1-bookings) failed:', e.message);
    return [];
  }
  const blobs = await listAllBlobs(store, 'cd1-bookings');
  const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
  const { normalizeBookingKey } = require('../lib/ops-db');
  // Keep Blob key on each record so Customer lookup can resolve when key ≠ payload.id
  const keyed = [];
  for (let i = 0; i < blobs.length; i += 30) {
    const chunk = blobs.slice(i, i + 30);
    const rows = await Promise.all(chunk.map(async (blob) => {
      let raw = null;
      if (typeof store.getWithMetadata === 'function') {
        const result = await store.getWithMetadata(blob.key, {
          type: 'json',
          consistency: 'strong',
        }).catch(() => null);
        raw = result && result.data;
      }
      if (!raw) raw = await store.get(blob.key, { type: 'json' }).catch(() => null);
      if (!raw) return null;
      if (!raw.id && !raw.bookingId) raw.id = blob.key;
      raw.__blobKey = blob.key;
      return raw;
    }));
    for (const row of rows) if (row) keyed.push(row);
  }
  let jobs = keyed.filter((b) =>
    b && isVisibleSubmittedBooking(b, { includeArchivedTest: !!showTest })
  );

  if (!showTest) jobs = jobs.filter(b => !b.isTest && !b.archived && b.jobStatus !== 'archived_test');
  if (statusFilter) jobs = jobs.filter(b => normalizeJobStatus(b) === statusFilter);
  if (search) {
    jobs = jobs.filter(b => {
      const hay = [
        b.id, b.firstName, b.lastName, b.phone, b.email, b.vehicle, b.vehicleLabel,
        b.package, b.assignedTechName, b.assignedTechId,
      ].join(' ').toLowerCase();
      return hay.includes(search);
    });
  }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  // Lean list path: skip Prisma customer-account graph enrichment (no Jobs-table consumer).
  // Full identity remains available through get_job / customer portal authorities.

  return jobs.map(b => {
    try {
      const j = projectJobForAdminList(b);
      // Prefer payload id; if missing, use Blob key so Admin copy/paste matches Customer lookup.
      j.id = normalizeBookingKey(j.id || j.bookingId || b.__blobKey) || j.id;
      j.bookingId = j.bookingId || j.id;
      j.jobStatus = normalizeJobStatus(b);
      // paymentWorkflowStatus / remainingCents come from financialProjection via projectJobForAdminList.
      // Do not overwrite with normalizePaymentWorkflowStatus(raw) — that reintroduces stale Pending.
      return j;
    } catch (_) {
      // Never let one malformed record blank the entire admin feed.
      return {
        id: (b && b.id) || 'unknown',
        firstName: (b && b.firstName) || '',
        lastName: (b && b.lastName) || '',
        jobStatus: 'pending_review',
        paymentWorkflowStatus: 'no_payment_required_yet',
        pendingChangeRequestCount: 0,
        vehicleCount: 0,
        _projection: 'admin_list',
        _malformed: true,
      };
    }
  });
}

/**
 * Persist Admin mutations through CAS + ledger sync.
 * Unconditional store.setJSON is not acceptable conflict protection.
 */
async function persistMutation(store, bookingId, booking, previous, action, reason) {
  setBookingStoreOverride(store);
  const expected = Math.max(0, Math.round(Number(previous?.bookingVersion) || 0));
  const { ok: prevOk, aggregate: prevAgg } = normalizeAggregate(previous, { allowDraft: true });
  const base = prevOk ? prevAgg : previous;

  const { ok: nextOk, aggregate: mutatedAgg } = normalizeAggregate(booking, { allowDraft: true });
  const mutated = nextOk ? mutatedAgg : booking;

  const patches = { ...mutated };
  delete patches.bookingVersion;
  delete patches.__etag;
  delete patches._etag;

  let expireResult = null;
  if (MONEY_MUTATION_ACTIONS.has(action)) {
    const approvedCents = dollarsToCents(
      mutated.approvedFinalAmount != null ? mutated.approvedFinalAmount : mutated.totalPrice
    );
    let settledCents = Math.max(0, Math.round(Number(base.ledger?.settledCents) || 0));
    let creditedCents = Math.max(0, Math.round(Number(base.ledger?.creditedCents) || 0));
    const entries = Array.isArray(base.ledger?.entries) ? [...base.ledger.entries] : [];

    if (action === 'mark_cash_received') {
      // Full-balance only — handler validates amount === remaining before mutation.
      // Credit exactly remainingCents; never clamp a partial cash amount into a close.
      const remaining = Math.max(0, approvedCents - settledCents - creditedCents);
      const cashCents = dollarsToCents(
        mutated.cashReceivedAmount != null
          ? mutated.cashReceivedAmount
          : centsToDollars(remaining)
      );
      if (remaining > 0 && cashCents === remaining) {
        settledCents += remaining;
        entries.push({
          entryId: `le_admin_${action}_${Date.now()}`,
          kind: 'settlement',
          // The receipt reads this to say "Cash" rather than defaulting to Card.
          method: 'cash',
          amountCents: remaining,
          currency: 'usd',
          quoteVersion: Math.round(Number(base.quoteVersion) || 0),
          bookingVersion: expected,
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          actor: `admin_${action}`,
        });
      }
    } else if (action === 'mark_card_on_site') {
      const cashCents = dollarsToCents(
        mutated.cardOnSiteAmount != null
          ? mutated.cardOnSiteAmount
          : centsToDollars(approvedCents)
      );
      const remaining = Math.max(0, approvedCents - settledCents - creditedCents);
      const credit = Math.min(Math.max(0, cashCents), remaining);
      if (credit > 0) {
        settledCents += credit;
        entries.push({
          entryId: `le_admin_${action}_${Date.now()}`,
          kind: 'settlement',
          method: 'card',
          amountCents: credit,
          currency: 'usd',
          quoteVersion: Math.round(Number(base.quoteVersion) || 0),
          bookingVersion: expected,
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          actor: `admin_${action}`,
        });
      }
    }

    const priorApproved = Math.max(0, Math.round(Number(base.ledger?.approvedCents) || 0));
    const quoteChanged = approvedCents !== priorApproved
      || action === 'update_service'
      || action === 'change_package'
      || action === 'update_vehicles'
      || action === 'approve_adjustment'
      || action === 'reject_adjustment'
      || action === 'set_approved_final_amount'
      || action === 'apply_welcome_offer'
      || action === 'remove_welcome_offer'
      || action === 'record_job_balance';

    let paymentAttempts = Array.isArray(base.paymentAttempts) ? base.paymentAttempts : [];
    let nextQuoteVersion = Math.round(Number(base.quoteVersion || base.quote?.quoteVersion) || 0);
    if (quoteChanged) {
      nextQuoteVersion += 1;
      paymentAttempts = supersedeOpenAttempts(paymentAttempts, { quoteVersion: nextQuoteVersion });
      patches.payLink = '';
      patches.stripeCheckoutSessionId = '';
      patches.payLinkAmount = null;
      patches.payLinkInvalidatedAt = new Date().toISOString();
      patches.quoteVersion = nextQuoteVersion;
      // When the mutator minted a fresh canonical quote (quoteService), keep its
      // line items; version/amount fields below stay authoritative either way.
      const mintedQuote = mutated.quote
        && Number(mutated.quote.quoteVersion) > Number(base.quote?.quoteVersion || 0)
        ? mutated.quote
        : null;
      patches.quote = {
        ...(base.quote || {}),
        ...(mintedQuote || {}),
        quoteVersion: nextQuoteVersion,
        basedOnBookingVersion: expected,
        approvedCents,
        currency: 'usd',
        createdAt: new Date().toISOString(),
        source: `admin_${action}`,
      };
    }

    patches.ledger = {
      currency: 'usd',
      approvedCents,
      settledCents,
      creditedCents,
      pendingCents: 0,
      lastReconciledAt: base.ledger?.lastReconciledAt || null,
      entries,
    };
    patches.paymentAttempts = paymentAttempts;
    patches.approvedFinalAmount = centsToDollars(approvedCents);
    patches.totalPrice = centsToDollars(approvedCents);
    patches.amountPaid = centsToDollars(settledCents);
    patches.paidAmount = centsToDollars(settledCents);
    const dueCents = Math.max(0, approvedCents - settledCents - creditedCents);
    patches.amountDueApproved = centsToDollars(dueCents);
    patches.balanceDue = centsToDollars(dueCents);

    expireResult = await expireSupersededAttempts(paymentAttempts, process.env).catch(() => null);
  }

  const next = buildNextAggregate(base, patches);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) {
    return committed;
  }

  await appendAudit(auditEntry({
    bookingId,
    actorType: 'admin',
    actorId: 'admin',
    action,
    previousState: previous,
    resultingState: committed.booking,
    reason: reason || '',
    sourcePortal: 'admin_ops',
  })).catch(() => null);

  return { ok: true, booking: committed.booking, bookingVersion: committed.bookingVersion, expireResult };
}

/**
 * Stage 3 — free-form add-on writes through update_service are closed.
 * Add-on fields (including ID lists and free-form objects) must use addon_mutation.
 * Package/vehicle recalculation without add-on fields remains allowed.
 */
function freeFormAddonBodyRejected(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.addonOp != null || body.addon != null || Array.isArray(body.addons)) return true;
  if (body.addOnIdsToAdd != null || body.addOnIdsToRemove != null) return true;
  if (body.addonIds != null || body.addonId != null) return true;
  if (body.addonName != null || body.addonPrice != null || body.addonPriceCents != null) return true;
  return false;
}

/**
 * Package Stage 1 — any package identity field on update_service is a package
 * mutation and must route through the shared Admin package adapter (never
 * updateServicePackage / persistMutation as money authority).
 */
function bodyHasPackageMutation(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.packageId != null && String(body.packageId).trim() !== '') return true;
  if (body.pkgId != null && String(body.pkgId).trim() !== '') return true;
  if (body.package != null && String(body.package).trim() !== '') return true;
  return false;
}

/** Vehicles for Admin add-on controls — IDs/labels/selected IDs only (no money authority). */
function adminVehiclesForAddonControls(booking) {
  const { ensureVehicleIds } = require('../lib/booking-aggregate');
  const { asArray } = require('../lib/historical-adapter');
  const { bookingVehicleCategory } = require('../lib/canonical-addon-catalog');
  const { inferPkgId } = require('../lib/booking-price-catalog');
  const raw = (booking?.service && Array.isArray(booking.service.vehicles) && booking.service.vehicles.length)
    ? booking.service.vehicles
    : (Array.isArray(booking?.vehicles) ? booking.vehicles : []);
  const vehicles = ensureVehicleIds(raw.length
    ? raw
    : [{
      vehicleLabel: booking?.vehicleLabel || booking?.vehicle || '',
      category: booking?.vehicleCategory || booking?.cat || 'cars',
      addOnIds: booking?.addOnIds || [],
      addons: booking?.addons || [],
    }]);
  return vehicles.map((v) => {
    const fromIds = asArray(v.addOnIds).map((id) => String(id || '').trim()).filter(Boolean);
    const fromObjs = asArray(v.addons)
      .map((a) => String(a?.id || '').trim())
      .filter(Boolean);
    const selectedAddonIds = fromIds.length ? fromIds : fromObjs;
    const category = bookingVehicleCategory({
      service: { vehicles: [v] },
      vehicles: [v],
      vehicleCategory: v.category || v.cat,
    });
    return {
      vehicleId: String(v.vehicleId || '').trim(),
      label: String(v.vehicleLabel || v.vehicle || v.vehicleId || 'Vehicle').trim(),
      category,
      currentPackageId: inferPkgId(v, booking) || String(v.packageId || v.pkgId || '').trim(),
      selectedAddonIds,
    };
  }).filter((v) => v.vehicleId);
}

function selectedAddonIdsForVehicle(booking, vehicleId) {
  const vehicles = adminVehiclesForAddonControls(booking);
  if (!vehicles.length) return [];
  if (vehicleId) {
    const match = vehicles.find((v) => v.vehicleId === vehicleId);
    return match ? match.selectedAddonIds.slice() : [];
  }
  return vehicles.length === 1 ? vehicles[0].selectedAddonIds.slice() : [];
}

/** Canonical add-on catalog payload for the Admin job drawer — server-serialized only. */
function adminAddonCatalogForBooking(booking) {
  const { serializeCategoryAddons } = require('../lib/canonical-addon-catalog');
  const vehicles = adminVehiclesForAddonControls(booking);
  const categories = [...new Set(vehicles.map((v) => v.category).filter(Boolean))];
  if (!categories.length) categories.push('cars');
  const byCategory = {};
  for (const cat of categories) {
    byCategory[cat] = serializeCategoryAddons(cat);
  }
  const primaryCategory = categories[0];
  const bookingVersion = Math.round(Number(booking?.bookingVersion) || 0);
  const quoteVersion = Math.round(Number(booking?.quoteVersion || booking?.quote?.quoteVersion) || 0);
  return {
    addonCatalog: {
      source: 'booking-price-catalog',
      category: primaryCategory,
      addons: byCategory[primaryCategory] || serializeCategoryAddons(primaryCategory),
      byCategory,
    },
    vehicles,
    selectedAddonIds: vehicles.length === 1 ? vehicles[0].selectedAddonIds.slice() : [],
    bookingVersion,
    quoteVersion,
  };
}

function buildAdminAddonAuditReason(facts) {
  return JSON.stringify(facts).slice(0, 500);
}

/**
 * Package change flow — display names for canonical package IDs. Keys must
 * exist in booking-price-catalog PRICING tiers / LENGTH_PRICING packages, and
 * every name must round-trip through PKG_ID_ALIASES / inferPkgId back to the
 * same id (legacy consumers re-infer pkgId from the name).
 */
const PACKAGE_DISPLAY = {
  cars: {
    maint: 'Maintenance Detail',
    interior: 'Interior Detail',
    full: 'Premium Full Detail',
    refresh: 'Exterior Refresh & Protect',
    premium: 'Paint Correction / Enhancement',
  },
  boats: {
    maint: 'Marine Wash',
    essential: 'Essential Marine Detail',
    full: 'Full Marine Detail',
    premium: 'Premium Marine Detail',
  },
  rvs: {
    maint: 'Maintenance Wash',
    maint_light: 'Exterior Wash & Protect',
    interior: 'Interior Detail',
    full_basic: 'Full RV Detail',
    premium: 'Premium Exterior Detail',
    full: 'Premium Complete Detail',
  },
  powersports: {
    wash: 'Wash & Shine',
    essential: 'Essential Detail',
    full: 'Full Detail',
    premium: 'Premium Detail',
  },
  fleet: {
    maint: 'Fleet Maintenance Wash',
    essential: 'Fleet Essential Detail',
    full: 'Fleet Full Detail',
    premium: 'Fleet Premium Protection',
    custom: 'Custom Fleet Quote',
  },
};

function packageDisplayName(category, id) {
  const names = PACKAGE_DISPLAY[category] || {};
  if (names[id]) return names[id];
  return String(id || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Raw catalog-shaped vehicles for package pricing probes (keeps tier/length/rvType). */
function adminRawVehiclesForControls(booking) {
  const { ensureVehicleIds } = require('../lib/booking-aggregate');
  const raw = (booking?.service && Array.isArray(booking.service.vehicles) && booking.service.vehicles.length)
    ? booking.service.vehicles
    : (Array.isArray(booking?.vehicles) ? booking.vehicles : []);
  return ensureVehicleIds(raw.length
    ? raw
    : [{
      vehicleLabel: booking?.vehicleLabel || booking?.vehicle || '',
      category: booking?.vehicleCategory || booking?.cat || 'cars',
      tierLabel: booking?.vehicleTier || booking?.tierLabel || '',
      pkgId: booking?.packageId || booking?.pkgId || '',
      pkgName: booking?.package || '',
      lengthFt: booking?.vehicleLengthFt || booking?.lengthFt || 0,
      rvType: booking?.rvType || '',
      addOnIds: booking?.addOnIds || [],
      addons: booking?.addons || [],
    }]);
}

/**
 * Server-side package options for one vehicle. Every option is priced through
 * booking-price-catalog (computeVehicleSubtotal probe with add-ons stripped);
 * unpriceable or zero-priced combinations are excluded. Browser prices are
 * never read anywhere in this flow.
 */
function packageOptionsForVehicle(rawVehicle, booking) {
  const {
    PRICING,
    LENGTH_PRICING,
    computeVehicleSubtotal,
  } = require('../lib/booking-price-catalog');
  const zip = booking?.zipCode || booking?.zip || '';
  const cat = String(rawVehicle?.cat || rawVehicle?.category || 'cars').trim() || 'cars';

  const candidateIds = new Set();
  for (const tier of Object.values(PRICING[cat]?.tiers || {})) {
    for (const key of Object.keys(tier)) if (key !== 'label') candidateIds.add(key);
  }
  for (const key of Object.keys(LENGTH_PRICING[cat]?.packages || {})) candidateIds.add(key);

  const current = computeVehicleSubtotal({ ...rawVehicle, cat, category: cat }, zip, booking);
  const currentPackageId = current.ok
    ? current.pkgId
    : String(rawVehicle?.pkgId || rawVehicle?.packageId || '').trim();

  const options = [];
  for (const id of candidateIds) {
    const probe = {
      ...rawVehicle,
      cat,
      category: cat,
      pkgId: id,
      packageId: id,
      pkgName: '',
      packageName: '',
      addons: [],
      addOnIds: [],
    };
    const priced = computeVehicleSubtotal(probe, zip, booking);
    if (!priced.ok || !(priced.basePrice > 0)) continue;
    options.push({
      id,
      name: packageDisplayName(cat, id),
      priceCents: Math.round(priced.basePrice * 100),
      current: id === currentPackageId,
    });
  }
  options.sort((a, b) => a.priceCents - b.priceCents);
  return { category: cat, currentPackageId, options };
}

/** Canonical package catalog payload for the Admin job drawer — server-serialized only. */
function adminPackageCatalogForBooking(booking) {
  const vehicles = adminRawVehiclesForControls(booking).map((v) => {
    const { category, currentPackageId, options } = packageOptionsForVehicle(v, booking);
    return {
      vehicleId: String(v.vehicleId || '').trim(),
      label: String(v.vehicleLabel || v.vehicle || v.vehicleId || 'Vehicle').trim(),
      category,
      currentPackageId,
      options,
    };
  }).filter((v) => v.vehicleId);
  return { packageCatalog: { source: 'booking-price-catalog', vehicles } };
}

function adminVehicleMutationCatalog() {
  const { PRICING, LENGTH_PRICING } = require('../lib/booking-price-catalog');
  const { VEHICLE_CATEGORIES, VEHICLE_YEARS } = require('../lib/customer-catalog');
  const categories = VEHICLE_CATEGORIES.map((category) => ({ ...category }));
  const tiersByCategory = {};
  const packagesByCategory = {};
  for (const category of categories) {
    const categoryId = category.id;
    const tiers = PRICING[categoryId]?.tiers || {};
    tiersByCategory[categoryId] = Object.entries(tiers).map(([id, tier]) => ({
      id,
      label: tier.label || id,
    }));
    const ids = new Set();
    for (const tier of Object.values(tiers)) {
      for (const [id, price] of Object.entries(tier || {})) {
        if (id !== 'label' && Number(price) >= 0) ids.add(id);
      }
    }
    for (const id of Object.keys(LENGTH_PRICING[categoryId]?.packages || {})) ids.add(id);
    packagesByCategory[categoryId] = [...ids].map((id) => ({
      id,
      name: packageDisplayName(categoryId, id),
    }));
  }
  return {
    source: 'booking-price-catalog',
    categories,
    years: VEHICLE_YEARS,
    tiersByCategory,
    packagesByCategory,
    lengthCategories: Object.keys(LENGTH_PRICING),
  };
}

/**
 * Package Stage 1 — Admin package mutation adapter.
 *
 * Canonical package IDs only. Money authority is always:
 * applyPackageFinancialMutation → PaymentAuthorityService.createAdjustment
 * → PostgreSQL FinancialProjection → Blob compatibility sync.
 *
 * Browser-supplied names/prices/totals/proposedTotal/approved dollars are
 * never read. persistMutation is not package money authority.
 */
async function adminChangePackage({
  bookingId,
  body = {},
  previousBooking = null,
  env = process.env,
  auditFn = null,
}) {
  const { applyPackageFinancialMutation } = require('../lib/package-financial-mutation');
  const { financialProjection } = require('../lib/payment-service');

  // Canonical IDs only — ignore display labels and free-form package names.
  const packageId = sanitizeText(body.packageId || body.pkgId, 32);

  const record = auditFn || ((entry) => appendAudit(entry));

  async function writeAudit({
    action,
    prior,
    resulting,
    vehicleId,
    projection,
    result,
    error,
    noop,
  }) {
    const priorBookingVersion = Math.round(Number(prior?.bookingVersion) || 0);
    const resultingBookingVersion = Math.round(Number(
      resulting?.bookingVersion != null ? resulting.bookingVersion : priorBookingVersion
    ) || 0);
    const priorQuoteVersion = Math.round(Number(
      prior?.quoteVersion || prior?.quote?.quoteVersion || 0
    ) || 0);
    const resultingQuoteVersion = Math.round(Number(
      projection?.quoteVersion != null
        ? projection.quoteVersion
        : (resulting?.quoteVersion || resulting?.quote?.quoteVersion || priorQuoteVersion)
    ) || 0);
    await Promise.resolve(record(auditEntry({
      bookingId,
      actorType: 'admin',
      actorId: 'admin',
      action,
      previousState: prior,
      resultingState: resulting || prior,
      reason: buildAdminAddonAuditReason({
        op: 'change_package',
        result: error || result || (noop ? 'noop' : 'ok'),
        error: error || null,
        noop: !!noop,
        packageId: packageId || null,
        vehicleId: vehicleId || null,
        priorBookingVersion,
        bookingVersion: resultingBookingVersion,
        priorQuoteVersion,
        quoteVersion: resultingQuoteVersion,
        approvedCents: projection ? projection.approvedCents : null,
        settledCents: projection ? projection.settledCents : null,
        remainingCents: projection ? projection.remainingCents : null,
      }),
      sourcePortal: 'admin_ops',
    }))).catch(() => null);
  }

  let prior = previousBooking;
  if (!prior) {
    const rec = await getBookingRecord(bookingId);
    if (!rec.exists) return { ok: false, statusCode: 404, error: 'booking_not_found' };
    prior = rec.booking;
  }

  if (!packageId) {
    await writeAudit({
      action: 'admin_package_denied',
      prior,
      resulting: prior,
      vehicleId: body.vehicleId,
      projection: financialProjection(prior),
      error: 'package_id_required',
    });
    return { ok: false, statusCode: 400, error: 'package_id_required' };
  }

  const adminReason = sanitizeText(body.reason, 300);
  if (!adminReason) {
    return { ok: false, statusCode: 400, error: 'reason_required' };
  }

  const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey || body.requestKey);
  if (!idempotencyKey) {
    await writeAudit({
      action: 'admin_package_denied',
      prior,
      resulting: prior,
      vehicleId: body.vehicleId,
      projection: financialProjection(prior),
      error: 'idempotency_key_required',
    });
    return { ok: false, statusCode: 400, error: 'idempotency_key_required' };
  }

  if (body.expectedBookingVersion == null || body.expectedBookingVersion === '') {
    await writeAudit({
      action: 'admin_package_denied',
      prior,
      resulting: prior,
      vehicleId: body.vehicleId,
      projection: financialProjection(prior),
      error: 'expected_booking_version_required',
    });
    return { ok: false, statusCode: 400, error: 'expected_booking_version_required' };
  }

  const expected = Math.round(Number(body.expectedBookingVersion));
  const actualVersion = Math.round(Number(prior.bookingVersion) || 0);
  if (!Number.isFinite(expected)) {
    await writeAudit({
      action: 'admin_package_denied',
      prior,
      resulting: prior,
      vehicleId: body.vehicleId,
      projection: financialProjection(prior),
      error: 'version_conflict',
    });
    return {
      ok: false,
      statusCode: 409,
      error: 'version_conflict',
      actualBookingVersion: actualVersion,
      financialProjection: financialProjection(prior),
    };
  }

  const vehicles = adminRawVehiclesForControls(prior);
  let vehicleId = body.vehicleId ? sanitizeText(body.vehicleId, 64) : '';
  if (vehicles.length > 1 && !vehicleId) {
    await writeAudit({
      action: 'admin_package_denied',
      prior,
      resulting: prior,
      vehicleId: null,
      projection: financialProjection(prior),
      error: 'vehicle_target_required',
    });
    return { ok: false, statusCode: 400, error: 'vehicle_target_required' };
  }
  if (!vehicleId && vehicles.length === 1) {
    vehicleId = vehicles[0].vehicleId;
  }

  // Intentionally ignore body.price / amount / total / proposedTotal /
  // approvedCents / approvedFinalAmount — catalog + Postgres are authority.
  const result = await applyPackageFinancialMutation({
    bookingId,
    expectedBookingVersion: expected,
    target: { vehicleId: vehicleId || undefined },
    packageId,
    adminNote: adminReason,
    idempotencyKey,
    actor: 'admin',
    env,
  });

  if (!result.ok) {
    await writeAudit({
      action: 'admin_package_denied',
      prior,
      resulting: prior,
      vehicleId,
      projection: result.financialProjection || financialProjection(prior),
      error: result.error || 'package_mutation_failed',
    });
    return {
      ok: false,
      statusCode: result.statusCode || 400,
      error: result.error,
      message: result.message,
      actualBookingVersion: result.actualBookingVersion,
      packageId: result.packageId,
      validPackageIds: result.validPackageIds,
      financialProjection: result.financialProjection || null,
      projection: result.projection || null,
    };
  }

  const projection = result.postgresProjection || result.financialProjection;
  const approvedCents = projection
    ? Math.max(0, Math.round(Number(projection.approvedCents) || 0))
    : 0;
  if (!result.idempotent) {
    await writeAudit({
      action: result.noop ? 'admin_package_noop' : 'admin_change_package',
      prior,
      resulting: result.booking,
      vehicleId: result.vehicleId || vehicleId,
      projection,
      noop: !!result.noop,
      result: result.reason || (result.noop ? 'noop' : 'ok'),
    });
  }

  return {
    ok: true,
    statusCode: 200,
    bookingId,
    noop: !!result.noop,
    idempotent: !!result.idempotent,
    reason: result.reason,
    vehicleId: result.vehicleId || vehicleId || null,
    packageId: result.packageId || packageId,
    packageName: result.packageName,
    priorPackageId: result.priorPackageId || null,
    totalPrice: centsToDollars(approvedCents),
    bookingVersion: result.booking?.bookingVersion,
    quoteVersion: result.quoteVersion,
    priorQuoteVersion: result.priorQuoteVersion,
    projection,
    postgresProjection: result.postgresProjection || null,
    financialProjection: result.financialProjection,
    remainingCents: result.remainingCents,
    outstandingCreditCents: result.outstandingCreditCents || 0,
  };
}

/**
 * Stage 3 — Admin add-on mutation adapter.
 *
 * Canonical add-on IDs only; identity and price resolve server-side through
 * booking-price-catalog → applyAddonFinancialMutation → Postgres
 * createAdjustment → shared FinancialProjection. Browser-supplied
 * names/prices/totals in the body are never read.
 */
async function adminAddonMutation({
  bookingId,
  body = {},
  previousBooking = null,
  env = process.env,
  auditFn = null,
}) {
  const { parseAddonIdList } = require('../lib/canonical-addon-catalog');
  const {
    applyAddonFinancialMutation,
    settledCentsOf,
  } = require('../lib/addon-financial-mutation');
  const { financialProjection } = require('../lib/payment-service');

  // IDs only — never accept free-form addon objects or the legacy addonIds alias.
  const addOnIdsToAdd = parseAddonIdList(body.addOnIdsToAdd);
  let addOnIdsToRemove = parseAddonIdList(body.addOnIdsToRemove);
  const op = addOnIdsToRemove.length
    ? (addOnIdsToAdd.length ? 'add_remove' : 'remove')
    : 'add';

  const record = auditFn || ((entry) => appendAudit(entry));

  async function writeAudit({
    action,
    prior,
    resulting,
    vehicleId,
    projection,
    result,
    error,
    noop,
  }) {
    const priorBookingVersion = Math.round(Number(prior?.bookingVersion) || 0);
    const resultingBookingVersion = Math.round(Number(
      resulting?.bookingVersion != null ? resulting.bookingVersion : priorBookingVersion
    ) || 0);
    const priorQuoteVersion = Math.round(Number(
      prior?.quoteVersion || prior?.quote?.quoteVersion || 0
    ) || 0);
    const resultingQuoteVersion = Math.round(Number(
      projection?.quoteVersion != null
        ? projection.quoteVersion
        : (resulting?.quoteVersion || resulting?.quote?.quoteVersion || priorQuoteVersion)
    ) || 0);
    await Promise.resolve(record(auditEntry({
      bookingId,
      actorType: 'admin',
      actorId: 'admin',
      action,
      previousState: prior,
      resultingState: resulting || prior,
      reason: buildAdminAddonAuditReason({
        op,
        result: error || result || (noop ? 'noop' : 'ok'),
        error: error || null,
        noop: !!noop,
        vehicleId: vehicleId || null,
        addOnIdsToAdd,
        addOnIdsToRemove,
        priorBookingVersion,
        bookingVersion: resultingBookingVersion,
        priorQuoteVersion,
        quoteVersion: resultingQuoteVersion,
        approvedCents: projection ? projection.approvedCents : null,
        settledCents: projection ? projection.settledCents : null,
        remainingCents: projection ? projection.remainingCents : null,
      }),
      sourcePortal: 'admin_ops',
    }))).catch(() => null);
  }

  if (!addOnIdsToAdd.length && !addOnIdsToRemove.length) {
    return { ok: false, statusCode: 400, error: 'addon_ids_required' };
  }

  let prior = previousBooking;
  if (!prior) {
    const rec = await getBookingRecord(bookingId);
    if (!rec.exists) return { ok: false, statusCode: 404, error: 'booking_not_found' };
    prior = rec.booking;
  }

  const adminReason = sanitizeText(body.reason, 300);
  if (!adminReason) {
    return { ok: false, statusCode: 400, error: 'reason_required' };
  }

  const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey || body.requestKey);
  if (!idempotencyKey) {
    await writeAudit({
      action: 'admin_addon_denied',
      prior,
      resulting: prior,
      vehicleId: body.vehicleId,
      projection: financialProjection(prior),
      error: 'idempotency_key_required',
    });
    return { ok: false, statusCode: 400, error: 'idempotency_key_required' };
  }

  if (body.expectedBookingVersion == null || body.expectedBookingVersion === '') {
    await writeAudit({
      action: 'admin_addon_denied',
      prior,
      resulting: prior,
      vehicleId: body.vehicleId,
      projection: financialProjection(prior),
      error: 'expected_booking_version_required',
    });
    return { ok: false, statusCode: 400, error: 'expected_booking_version_required' };
  }

  const expected = Math.round(Number(body.expectedBookingVersion));
  const actualVersion = Math.round(Number(prior.bookingVersion) || 0);
  if (!Number.isFinite(expected)) {
    await writeAudit({
      action: 'admin_addon_denied',
      prior,
      resulting: prior,
      vehicleId: body.vehicleId,
      projection: financialProjection(prior),
      error: 'version_conflict',
    });
    return {
      ok: false,
      statusCode: 409,
      error: 'version_conflict',
      actualBookingVersion: actualVersion,
      financialProjection: financialProjection(prior),
    };
  }

  const vehicles = adminVehiclesForAddonControls(prior);
  let vehicleId = body.vehicleId ? sanitizeText(body.vehicleId, 64) : '';
  if (vehicles.length > 1 && !vehicleId) {
    await writeAudit({
      action: 'admin_addon_denied',
      prior,
      resulting: prior,
      vehicleId: null,
      projection: financialProjection(prior),
      error: 'vehicle_target_required',
    });
    return { ok: false, statusCode: 400, error: 'vehicle_target_required' };
  }
  if (!vehicleId && vehicles.length === 1) {
    vehicleId = vehicles[0].vehicleId;
  }

  const settled = settledCentsOf(prior);
  const selectedBefore = new Set(selectedAddonIdsForVehicle(prior, vehicleId));

  // Removing an absent add-on is a safe noop — never a quote bump
  // (createAdjustment always advances quoteVersion). Filter only while
  // nothing is settled; after settlement the Stage 1 denial must win.
  if (settled === 0) {
    addOnIdsToRemove = addOnIdsToRemove.filter((id) => selectedBefore.has(id));
    if (!addOnIdsToAdd.length && !addOnIdsToRemove.length) {
      const fp = financialProjection(prior);
      await writeAudit({
        action: 'admin_addon_noop',
        prior,
        resulting: prior,
        vehicleId,
        projection: fp,
        noop: true,
        result: 'addon_not_present',
      });
      return {
        ok: true,
        statusCode: 200,
        noop: true,
        reason: 'addon_not_present',
        bookingId,
        quoteVersion: prior.quoteVersion || prior.quote?.quoteVersion || 0,
        priorQuoteVersion: prior.quoteVersion || prior.quote?.quoteVersion || 0,
        bookingVersion: prior.bookingVersion || 0,
        selectedAddonIds: [...selectedBefore],
        projection: fp,
        financialProjection: fp,
      };
    }
  }

  const result = await applyAddonFinancialMutation({
    bookingId,
    expectedBookingVersion: expected,
    target: { vehicleId: vehicleId || undefined },
    addOnIdsToAdd,
    addOnIdsToRemove,
    adminNote: adminReason,
    idempotencyKey,
    actor: 'admin',
    env,
  });

  if (!result.ok) {
    await writeAudit({
      action: 'admin_addon_denied',
      prior,
      resulting: prior,
      vehicleId,
      projection: result.financialProjection || financialProjection(prior),
      error: result.error || 'addon_mutation_failed',
    });
    return {
      ok: false,
      statusCode: result.statusCode || 400,
      error: result.error,
      message: result.message,
      actualBookingVersion: result.actualBookingVersion,
      unknownAddonIds: result.unknownAddonIds,
      financialProjection: result.financialProjection || null,
    };
  }

  const projection = result.postgresProjection || result.financialProjection;
  if (!result.idempotent) {
    await writeAudit({
      action: result.noop ? 'admin_addon_noop' : `admin_addon_${op}`,
      prior,
      resulting: result.booking,
      vehicleId,
      projection,
      noop: !!result.noop,
      result: result.reason || (result.noop ? 'noop' : 'ok'),
    });
  }

  return {
    ok: true,
    statusCode: 200,
    bookingId,
    noop: !!result.noop,
    idempotent: !!result.idempotent,
    reason: result.reason,
    op,
    vehicleId: vehicleId || null,
    quoteVersion: result.quoteVersion,
    priorQuoteVersion: result.priorQuoteVersion,
    bookingVersion: result.booking?.bookingVersion,
    projection,
    postgresProjection: result.postgresProjection || null,
    financialProjection: result.financialProjection,
    selectedAddonIds: selectedAddonIdsForVehicle(result.booking || prior, vehicleId),
    outstandingCreditCents: result.outstandingCreditCents || 0,
  };
}

/** Canonical Admin add/edit/remove vehicle operation over PR2 money authority. */
async function adminVehicleMutation({
  bookingId,
  body = {},
  previousBooking = null,
  env = process.env,
  auditFn = null,
}) {
  const { applyVehicleFinancialMutation } = require('../lib/vehicle-financial-mutation');
  const { financialProjection } = require('../lib/payment-service');
  let prior = previousBooking;
  if (!prior) {
    const rec = await getBookingRecord(bookingId);
    if (!rec.exists) return { ok: false, statusCode: 404, error: 'booking_not_found' };
    prior = rec.booking;
  }
  const op = sanitizeText(body.vehicleOp || body.op, 16).toLowerCase();
  if (!['add', 'replace', 'remove'].includes(op)) {
    return { ok: false, statusCode: 400, error: 'invalid_vehicle_op' };
  }
  const reason = sanitizeText(body.reason, 300);
  if (!reason) return { ok: false, statusCode: 400, error: 'reason_required' };
  const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey || body.requestKey);
  if (!idempotencyKey) {
    return { ok: false, statusCode: 400, error: 'idempotency_key_required' };
  }
  if (body.expectedBookingVersion == null || body.expectedBookingVersion === '') {
    return { ok: false, statusCode: 400, error: 'expected_booking_version_required' };
  }
  const expected = Math.round(Number(body.expectedBookingVersion));
  const actual = Math.round(Number(prior.bookingVersion) || 0);
  if (!Number.isFinite(expected)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'version_conflict',
      actualBookingVersion: actual,
      financialProjection: financialProjection(prior),
    };
  }

  const result = await applyVehicleFinancialMutation({
    bookingId,
    expectedBookingVersion: expected,
    op,
    target: { vehicleId: sanitizeText(body.vehicleId || body.targetVehicleId, 64) || undefined },
    vehicle: body.vehicle && typeof body.vehicle === 'object' ? body.vehicle : body,
    adminNote: reason,
    idempotencyKey,
    actor: 'admin',
    env,
  });

  if (!(result.ok && result.idempotent)) {
    const record = auditFn || ((entry) => appendAudit(entry));
    await Promise.resolve(record(auditEntry({
      bookingId,
      actorType: 'admin',
      actorId: 'admin',
      action: result.ok ? `admin_vehicle_${op}` : 'admin_vehicle_denied',
      previousState: prior,
      resultingState: result.booking || prior,
      reason: JSON.stringify({
        reason,
        result: result.ok ? (result.reason || 'ok') : (result.error || 'failed'),
        vehicleId: result.vehicleId || body.vehicleId || null,
        priorBookingVersion: actual,
        bookingVersion: result.booking?.bookingVersion ?? actual,
        quoteVersion: result.quoteVersion || prior.quoteVersion || 0,
        outstandingCreditCents: result.outstandingCreditCents || 0,
      }),
      sourcePortal: 'admin_ops',
    }))).catch(() => null);
  }

  if (!result.ok) {
    return {
      ok: false,
      statusCode: result.statusCode || 400,
      error: result.error,
      message: result.message,
      actualBookingVersion: result.actualBookingVersion,
      financialProjection: result.financialProjection || null,
    };
  }
  return {
    ok: true,
    statusCode: 200,
    bookingId,
    op,
    vehicleId: result.vehicleId,
    noop: !!result.noop,
    idempotent: !!result.idempotent,
    bookingVersion: result.booking?.bookingVersion,
    quoteVersion: result.quoteVersion,
    projection: result.postgresProjection || result.financialProjection,
    postgresProjection: result.postgresProjection || null,
    financialProjection: result.financialProjection,
    remainingCents: result.remainingCents,
    outstandingCreditCents: result.outstandingCreditCents || 0,
  };
}

/**
 * One place that answers "what can Admin do to this job right now, and if not,
 * why not". Buttons render from this rather than re-deriving rules client-side,
 * so a disabled control always carries the server's actual reason.
 */
function reconcileRecoveryCapability(projection, nowMs = Date.now()) {
  const updatedMs = Date.parse(projection?.paymentAttemptUpdatedAt || '');
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : 0;
  const delayed = projection?.paymentStatus === 'processing'
    && !!projection?.stripeReference
    && ageMs >= 30_000;
  return {
    enabled: delayed,
    ageMs,
    explanation: delayed
      ? 'A Stripe payment has remained unresolved for at least 30 seconds. Recovery reconcile is available.'
      : 'Webhook delivery is authoritative. Reconcile appears only for a demonstrably delayed in-flight payment.',
  };
}

function jobsSyncResponse(jobs, cursor) {
  const payload = { ok: true, count: jobs.length, jobs };
  const envelope = buildSyncEnvelope(payload, { ifSyncVersion: cursor });
  return jsonCors(200, envelope.body, syncHeaders(envelope.syncVersion));
}

function adminOperationalControls(booking, projection = null) {
  const { financialProjection } = require('../lib/payment-service');
  const { paymentMethodCapability } = require('../lib/payment-method-policy');
  const { adjustmentStatement } = require('../lib/price-adjustments');
  const { postServiceState } = require('../lib/post-service-experience');
  const { canReopenService, normalizeServiceStatus } = require('../lib/operations-lifecycle');

  const fin = projection && projection.remainingCents != null
    ? projection
    : financialProjection(booking);
  const remainingCents = Math.max(0, Math.round(Number(fin.remainingCents) || 0));
  const settledCents = Math.max(0, Math.round(Number(fin.settledCents) || 0));
  const refundableCents = Math.max(0, Math.round(Number(fin.refundableCents) || 0));
  const pendingRefundCents = Math.max(0, Math.round(Number(fin.pendingRefundCents) || 0));
  const reopenable = canReopenService(booking);
  const post = postServiceState(booking);

  return {
    jobStatus: booking.jobStatus || '',
    serviceStatus: normalizeServiceStatus(booking),
    paymentStatus: fin.paymentStatus || '',
    approvedCents: Math.max(0, Math.round(Number(fin.approvedCents) || 0)),
    settledCents,
    remainingCents,
    reopen: {
      enabled: reopenable,
      requiresReason: true,
      explanation: reopenable
        ? 'Reopens the job operationally. Payments, receipts and the balance are left exactly as they are.'
        : `This job is ${normalizeServiceStatus(booking).replace(/_/g, ' ')} — only a completed, closed or disputed job can be reopened.`,
    },
    paymentMethod: paymentMethodCapability(booking, { authoritativeProjection: fin }),
    recordCash: {
      enabled: remainingCents > 0,
      requiresAmount: true,
      requiresConfirmation: true,
      expectedAmountCents: remainingCents,
      // Part-payment is refused rather than silently rounded up: crediting a
      // partial amount would run the operational close that full settlement
      // owns. See docs/audit/admin-payment-operations-audit.md.
      partialSupported: false,
      explanation: remainingCents > 0
        ? `Records cash against the ledger and emails the customer a confirmation. No Stripe object is created or changed. The amount must settle the full remaining balance of ${(remainingCents / 100).toFixed(2)}.`
        : 'There is no remaining balance to collect.',
    },
    reconcileStripe: reconcileRecoveryCapability(fin),
    refund: {
      enabled: refundableCents > 0 && pendingRefundCents === 0,
      refundableCents,
      pendingRefundCents,
      status: fin.refundRequestStatus || null,
      explanation: pendingRefundCents > 0
        ? 'A Stripe refund is already awaiting webhook confirmation.'
        : (refundableCents > 0
          ? 'Issues an idempotent Stripe refund. The ledger changes only after the signed webhook.'
          : 'There is no refundable Stripe payment balance.'),
    },
    priceAdjustment: {
      enabled: true,
      requiresAdjustmentRecord: settledCents > 0,
      explanation: settledCents > 0
        ? 'A payment has been recorded, so the price changes through an adjustment with a reason and an approval trail.'
        : 'No payment recorded yet — an approved adjustment revises the total directly.',
      statement: adjustmentStatement(booking, { authoritativeProjection: fin }),
    },
    completeJob: {
      enabled: !post.completed,
      consequences: [
        'Sets the completion time, which starts the customer’s 48-hour service issue window.',
        'Makes the review action available to the customer.',
        'Sends the completion email once.',
      ],
    },
    postService: post,
    receipts: {
      paymentReceiptAvailable: settledCents > 0,
      finalReceiptAvailable: post.completed && settledCents > 0 && remainingCents === 0,
    },
  };
}

async function handleAdminAction(body) {
  const action = sanitizeText(body.action, 40);

  if (action === 'create_appointment') {
    const store = await blobsStore('cd1-bookings');
    const result = await createAdminAppointment(store, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    await appendAudit(auditEntry({
      bookingId: result.bookingId,
      actorType: 'admin',
      actorId: 'admin',
      action: 'create_appointment',
      previousState: null,
      resultingState: result.booking,
      reason: sanitizeText(body.reason, 300) || 'admin_create',
      sourcePortal: 'admin_ops',
    })).catch(() => null);
    return jsonCors(200, { ok: true, bookingId: result.bookingId, booking: projectJobForAdmin(result.booking) });
  }

  if (action === 'list_audit') {
    const bookingId = sanitizeText(body.bookingId, 48);
    if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });
    const rows = await listAuditForBooking(bookingId, Number(body.limit) || 100);
    return jsonCors(200, { ok: true, bookingId, audit: rows });
  }

  const bookingId = sanitizeText(body.bookingId, 48);
  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });

  const store = await blobsStore('cd1-bookings');
  setBookingStoreOverride(store);
  const bookingRec = await getBookingRecord(bookingId);
  let booking = bookingRec.booking || await store.get(bookingId, { type: 'json' }).catch(() => null);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });

  const now = new Date().toISOString();

  if (action === 'get_job') {
    const {
      reconcileOpenCheckoutFromProvider,
      financialProjection,
    } = require('../lib/payment-service');
    const {
      postgresPaymentEnabled,
      getSharedFinancialProjection,
      adminReconcileWithStripe,
    } = require('../lib/db/operational-payment');

    let reconciled = { ok: true, skipped: true, reason: 'not_run' };
    let projection = null;
    let authority = 'blob';

    if (postgresPaymentEnabled()) {
      const shared = await getSharedFinancialProjection(booking, { reconcileUncertain: false });
      if (shared.ok && shared.projection) {
        projection = shared.projection;
        authority = 'postgres';
        reconciled = {
          ok: true,
          skipped: true,
          reason: 'webhook_authority_normal_flow',
        };
      }
    }

    if (!projection) {
      projection = financialProjection(booking);
      reconciled = { ok: false, skipped: true, reason: 'postgres_payment_unavailable' };
      authority = 'unavailable';
    }

    const job = projectJobForAdmin(booking);
    return jsonCors(200, {
      ok: true,
      job,
      projection,
      authority,
      reconciled: !reconciled.skipped && !!reconciled.ok,
      reconcileSkipped: !!reconciled.skipped,
      reconcileReason: reconciled.reason || reconciled.error || null,
      // Capability state travels with the job so every Admin button reflects what
      // the server would actually allow, instead of guessing from a status string.
      operationalControls: adminOperationalControls(booking, projection),
      ...adminAddonCatalogForBooking(booking),
      ...adminPackageCatalogForBooking(booking),
      vehicleCatalog: adminVehicleMutationCatalog(),
    });
  }

  if (action === 'addon_mutation') {
    const result = await adminAddonMutation({ bookingId, body, previousBooking: booking });
    const { statusCode, ...payload } = result;
    return jsonCors(statusCode || (result.ok ? 200 : 400), payload);
  }

  if (action === 'change_package') {
    const result = await adminChangePackage({ bookingId, body, previousBooking: booking });
    const { statusCode, ...payload } = result;
    return jsonCors(statusCode || (result.ok ? 200 : 400), payload);
  }

  if (action === 'reconcile_with_stripe') {
    const {
      postgresPaymentEnabled,
      adminReconcileWithStripe,
      getSharedFinancialProjection,
    } = require('../lib/db/operational-payment');
    const {
      reconcileOpenCheckoutFromProvider,
      financialProjection,
    } = require('../lib/payment-service');

    if (postgresPaymentEnabled()) {
      const expected = Math.round(Number(body.expectedBookingVersion));
      const actual = Math.round(Number(booking.bookingVersion) || 0);
      if (body.expectedBookingVersion == null || body.expectedBookingVersion === ''
        || !Number.isFinite(expected) || expected !== actual) {
        return jsonCors(409, {
          ok: false,
          error: 'version_conflict',
          expectedBookingVersion: Number.isFinite(expected) ? expected : null,
          actualBookingVersion: actual,
        });
      }
      const before = await getSharedFinancialProjection(booking, { reconcileUncertain: false });
      const capability = reconcileRecoveryCapability(before.projection);
      if (!before.ok || !capability.enabled) {
        return jsonCors(409, {
          ok: false,
          error: 'reconcile_not_recommended',
          reason: before.error || capability.explanation,
          projection: before.projection || null,
        });
      }
      const result = await adminReconcileWithStripe({ booking });
      const shared = await getSharedFinancialProjection(booking, { reconcileUncertain: false });
      const refreshed = await getBookingRecord(bookingId);
      if (refreshed.exists) booking = refreshed.booking;
      await appendAudit(auditEntry({
        bookingId,
        actorType: 'admin',
        actorId: 'admin',
        action: 'reconcile_with_stripe',
        previousState: { payment: before.projection },
        resultingState: { payment: shared.projection || result.projection || null },
        reason: sanitizeText(body.reason, 300) || 'delayed_webhook_recovery',
        sourcePortal: 'admin_ops',
      })).catch(() => null);
      return jsonCors(200, {
        ok: !!result.ok,
        action: 'reconcile_with_stripe',
        authority: 'postgres',
        projection: shared.projection || result.projection || null,
        skipped: !!result.skipped,
        reason: result.reason || result.error || null,
        job: projectJobForAdmin(booking),
      });
    }

    return jsonCors(503, {
      ok: false,
      error: 'postgres_payment_disabled',
      reason: 'Reconcile requires the PostgreSQL payment authority.',
    });

    const reconciled = await reconcileOpenCheckoutFromProvider({
      booking,
      bookingId,
      getBookingRecord,
      commitBooking,
    });
    booking = reconciled.booking || booking;
    return jsonCors(200, {
      ok: !!reconciled.ok,
      action: 'reconcile_with_stripe',
      authority: 'blob',
      projection: reconciled.projection || financialProjection(booking),
      skipped: !!reconciled.skipped,
      reason: reconciled.reason || reconciled.error || null,
      job: projectJobForAdmin(booking),
    });
  }

  if (action === 'apply_welcome_offer') {
    const reason = sanitizeText(body.reason, 300);
    const forceEligible = body.forceEligible === true;
    if (forceEligible && !reason) {
      return jsonCors(400, { ok: false, error: 'reason_required_for_override' });
    }
    const travel = applyServerTravelAndTotal({ ...booking }, { skipMismatchCheck: true });
    if (!travel.ok) return jsonCors(400, { ok: false, error: travel.error || 'invalid_booking' });
    const preview = await evaluateBookingOfferPreview(booking, { sourceTrigger: 'admin_apply' });
    if (preview.offer.eligibility_status !== 'eligible' && !forceEligible) {
      return jsonCors(409, {
        ok: false,
        error: 'offer_ineligible',
        reason: preview.offer.eligibility_reason,
        offer: preview.offer,
      });
    }
    const working = { ...booking };
    if (forceEligible && preview.offer.eligibility_status !== 'eligible') {
      working.welcomeOfferSource = 'admin_override';
    }
    const applied = await applyServerOffersToBooking(working, {
      serviceSubtotal: travel.serviceSubtotal,
      travelFee: working.travelFeeAmount || 0,
      sourceTrigger: forceEligible ? 'admin_override' : 'admin_apply',
    });
    const updated = {
      ...working,
      offerAudit: [
        ...(Array.isArray(booking.offerAudit) ? booking.offerAudit : []),
        {
          at: now,
          by: 'admin',
          action: 'apply_welcome_offer',
          reason: reason || null,
          forceEligible,
          discount: applied.discountDollars,
        },
      ],
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'welcome_offer_applied',
        by: 'admin',
        discount: applied.discountDollars,
        reason: reason || null,
      }),
    };
    const persisted = await persistMutation(
      store,
      bookingId,
      updated,
      booking,
      'apply_welcome_offer',
      reason || 'admin_apply'
    );
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      offer: persisted.booking.offer,
      totalPrice: persisted.booking.totalPrice,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'remove_welcome_offer') {
    const reason = sanitizeText(body.reason, 300);
    if (!reason) return jsonCors(400, { ok: false, error: 'reason_required' });
    const travel = applyServerTravelAndTotal({ ...booking }, { skipMismatchCheck: true });
    if (!travel.ok) return jsonCors(400, { ok: false, error: travel.error || 'invalid_booking' });
    const preDiscount = Math.round((travel.serviceSubtotal + (booking.travelFeeAmount || 0)) * 100) / 100;
    const updated = {
      ...booking,
      offer: null,
      welcomeOffer: null,
      discountAmount: 0,
      approvedDiscount: 0,
      totalPrice: preDiscount,
      approvedFinalAmount: preDiscount,
      finalAmount: preDiscount,
      offerAudit: [
        ...(Array.isArray(booking.offerAudit) ? booking.offerAudit : []),
        { at: now, by: 'admin', action: 'remove_welcome_offer', reason },
      ],
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'welcome_offer_removed', by: 'admin', reason }),
    };
    const persisted = await persistMutation(store, bookingId, updated, booking, 'remove_welcome_offer', reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      totalPrice: persisted.booking.totalPrice,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'admin_note') {
    const note = sanitizeText(body.note, 1000);
    if (!note) return jsonCors(400, { ok: false, error: 'note_required' });
    await store.setJSON(bookingId, {
      ...booking,
      adminNotes: ((booking.adminNotes || '') + '\n[' + now.slice(0, 16) + '] ' + note).trim(),
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'admin_note', by: 'admin', note }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'approve_completion') {
    if (booking.jobStatus !== 'completed_pending_admin_review') {
      return jsonCors(409, { ok: false, error: 'not_pending_admin_review' });
    }
    const { postServiceState } = require('../lib/post-service-experience');
    let patched = {
      ...booking,
      adminReviewRequired: false,
      adminReviewedAt: now,
      adminReviewed: true,
      jobStatus: 'completed_pending_payment',
      paymentWorkflowStatus: 'payment_action_required',
      // Write-once. This is the anchor for the review action and the 48-hour
      // service-issue window, so re-approving a completion cannot restart it.
      completedAt: booking.completedAt || booking.techCompletedAt || now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'completion_approved', by: 'admin' }),
    };
    let persisted = await persistMutation(store, bookingId, patched, booking, 'approve_completion', 'admin_review');
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    patched = persisted.booking;
    // Idempotent by the notification ledger: a second approve_completion for the
    // same state key does not send a second completion email.
    try {
      const { emitCustomerActionRequired } = require('../lib/booking-transactional-notifications');
      const txn = await emitCustomerActionRequired(patched, { event });
      if (txn && txn.booking) {
        const after = await persistMutation(
          store, bookingId, txn.booking, patched, 'completion_notification', 'completion_notify'
        ).catch(() => null);
        if (after && after.ok) patched = after.booking;
      }
    } catch (e) {
      console.warn('[admin-ops-jobs] action-required notify failed:', e.message);
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      jobStatus: patched.jobStatus,
      completedAt: patched.completedAt,
      bookingVersion: patched.bookingVersion,
      postService: postServiceState(patched),
    });
  }

  // `reopen_job` and `reopen_appointment` are the same operation reached from two
  // Admin surfaces. Both go through the versioned, audited path — the older
  // unconditional setJSON here silently lost concurrent writes and never moved
  // bookingVersion, so neither portal learned the job had reopened.
  if (action === 'reopen_job' || action === 'reopen_appointment') {
    return handleReopen({ store, bookingId, booking, body });
  }

  if (action === 'request_correction') {
    const msg = sanitizeText(body.message, 500);
    await store.setJSON(bookingId, {
      ...booking,
      jobStatus: 'in_progress',
      adminReviewRequired: true,
      correctionRequestedAt: now,
      correctionRequestNote: msg,
      completionSubmitted: false,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'correction_requested', by: 'admin', message: msg }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'confirm_booking') {
    const { confirmBookingTransition } = require('../lib/booking-confirm');
    const transition = await confirmBookingTransition({
      bookingId,
      now,
      by: 'admin',
    });
    if (!transition.ok) {
      return jsonCors(transition.statusCode || 409, {
        ok: false,
        error: transition.error || 'confirm_failed',
      });
    }

    let patched = transition.booking;

    // Customer confirmation notification (email + optional SMS). Failures must
    // not roll back the confirmed booking — delivery is tracked for retry.
    // Idempotent: already-confirmed retries share the same confirmationEventId.
    try {
      const { emitConfirmed } = require('../lib/booking-transactional-notifications');
      const txn = await emitConfirmed(patched, { event });
      if (txn && txn.booking) {
        patched = txn.booking;
        await store.setJSON(bookingId, patched).catch(() => {});
      }
    } catch (e) {
      console.warn('[admin-ops-jobs] confirm notify failed:', e.message);
    }

    const settings = await getOpsSettings();
    let auctionResult = null;
    // Only auto-dispatch auction on the authoritative first transition.
    if (
      transition.transitioned
      && (settings.autoPostToAuctionOnConfirm || settings.dispatchMode === 'auction')
    ) {
      auctionResult = await createAuctionForBooking(patched, { notifySms: true, notifyEmail: true });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      jobStatus: patched.jobStatus,
      idempotent: !!transition.idempotent,
      transitioned: !!transition.transitioned,
      auction: auctionResult && auctionResult.ok
        ? { posted: true, bidMax: auctionResult.bidMax, closesAt: auctionResult.closesAt }
        : null,
    });
  }

  if (action === 'post_to_auction') {
    const result = await createAuctionForBooking(booking, { notifySms: body.notifySms !== false, notifyEmail: body.notifyEmail !== false });
    if (!result.ok) return jsonCors(503, { ok: false, error: result.error || 'auction_failed' });
    await store.setJSON(bookingId, {
      ...booking,
      auctionPostedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'posted_to_auction', by: 'admin', bidMax: result.bidMax }),
    });
    return jsonCors(200, { ok: true, bookingId, bidMax: result.bidMax, closesAt: result.closesAt, notifiedSms: result.notifiedSms });
  }

  if (action === 'assign_auction_winner') {
    const result = await assignAuctionWinnerToBooking(bookingId, sanitizeText(body.note, 300));
    if (!result.ok) return jsonCors(409, { ok: false, error: result.error });
    return jsonCors(200, { ok: true, ...result });
  }

  if (action === 'update_payment_preference') {
    const { resolvePaymentMethodChange } = require('../lib/payment-method-policy');
    const resolved = resolvePaymentMethodChange(booking, body);
    if (!resolved.ok) {
      return jsonCors(resolved.statusCode || 400, {
        ok: false,
        error: resolved.error,
        message: resolved.message,
        capability: resolved.capability,
        supportedMethods: resolved.supportedMethods,
        expectedBookingVersion: resolved.expectedBookingVersion,
        actualBookingVersion: resolved.actualBookingVersion,
      });
    }
    const patched = {
      ...booking,
      ...resolved.patch,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'payment_preference_updated',
        by: 'admin',
        preference: resolved.method,
        scope: resolved.scope,
      }),
    };
    // Not a money mutation: the ledger and every settled entry keep the method
    // they were actually taken with.
    const persisted = await persistMutation(
      store, bookingId, patched, booking, 'update_payment_preference', body.reason
    );
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      bookingVersion: persisted.bookingVersion,
      paymentMethodPreference: resolved.method,
      scope: resolved.scope,
      capability: resolved.capability,
    });
  }

  if (action === 'correct_payment_method') {
    const { resolvePaymentMethodCorrection } = require('../lib/payment-method-policy');
    const resolved = resolvePaymentMethodCorrection(booking, body);
    if (!resolved.ok) {
      return jsonCors(resolved.statusCode || 400, {
        ok: false,
        error: resolved.error,
        message: resolved.message,
        supportedMethods: resolved.supportedMethods,
        expectedBookingVersion: resolved.expectedBookingVersion,
        actualBookingVersion: resolved.actualBookingVersion,
      });
    }
    const patched = {
      ...booking,
      ...resolved.patch,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'payment_method_corrected',
        by: 'admin',
        correctedMethod: resolved.method,
      }),
    };
    const persisted = await persistMutation(
      store, bookingId, patched, booking, 'correct_payment_method', body.reason
    );
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      bookingVersion: persisted.bookingVersion,
      correctedMethod: resolved.method,
      note: 'Recorded as a correction alongside the original settlement. The ledger entry itself is unchanged.',
    });
  }

  if (action === 'set_payment_link') {
    const payLink = sanitizeText(body.payLink, 500);
    if (!payLink.startsWith('http')) return jsonCors(400, { ok: false, error: 'invalid_pay_link' });
    const { moneyConflict } = require('../lib/payment-service');
    const money = moneyConflict(booking);
    if (money.conflict || !money.payable || !(money.remainingCents > 0)) {
      return jsonCors(409, {
        ok: false,
        error: 'not_payable',
        reason: money.reason || 'zero_balance',
        message: 'Booking is already paid or has no remaining balance. Manual pay links are blocked.',
      });
    }
    // Manual external reference only — not an authoritative Stripe payment attempt.
    // Do NOT set payLink/awaiting_customer_payment (those drive Pay Balance CTAs).
    const patched = {
      ...booking,
      manualPayLink: payLink,
      manualPayLinkAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'manual_payment_link_set',
        by: 'admin',
        note: 'external_manual_reference_not_authoritative',
      }),
    };
    const persisted = await persistMutation(store, bookingId, patched, booking, 'set_payment_link', 'manual_link');
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      bookingVersion: persisted.bookingVersion,
      authoritative: false,
      note: 'Manual link stored as external reference only; Generate Stripe link remains the authoritative path.',
    });
  }

  if (action === 'generate_stripe_pay_link') {
    return jsonCors(410, {
      ok: false,
      error: 'legacy_checkout_disabled',
      message: 'Hosted Checkout is isolated. The customer pays with Payment Element in My Garage.',
    });
    const stripeGuard = guardStripeOrReject(process.env, { purpose: 'admin_pay_link' });
    if (stripeGuard.blocked) {
      return jsonCors(stripeGuard.statusCode, stripeGuard.body);
    }
    const { prepareBalanceCheckout, buildPaymentAttempt } = require('../lib/payment-service');
    const { getBookingRecord, commitBooking } = require('../lib/booking-repository');
    const { buildNextAggregate, normalizeAggregate } = require('../lib/booking-aggregate');
    const { applyPayLinkMoney } = require('../lib/portal-money-sync');
    const { centsToDollars } = require('../lib/historical-adapter');

    const freshRec = await getBookingRecord(bookingId);
    const freshBooking = freshRec.booking || (await getBooking(bookingId)) || booking;
    // Reject operator amount override — derive remaining only
    if (body.amount != null || body.amountCents != null) {
      return jsonCors(400, { ok: false, error: 'amount_override_rejected' });
    }
    const prepared = prepareBalanceCheckout(freshBooking, {
      expectedBookingVersion: body.expectedBookingVersion,
      expectedQuoteVersion: body.expectedQuoteVersion,
    }, process.env);
    if (!prepared.ok) {
      return jsonCors(prepared.statusCode || 400, {
        ok: false,
        error: prepared.error,
        reason: prepared.reason,
        message: prepared.error === 'not_payable' || prepared.error === 'zero_balance'
          ? 'Booking is already paid or has no remaining balance. A new Stripe link was not created.'
          : undefined,
      });
    }
    const amountDollars = centsToDollars(prepared.amountCents);
    if (prepared.amountCents < 50) return jsonCors(400, { ok: false, error: 'amount_too_low' });

    const { ok: nOk, aggregate: nAgg } = normalizeAggregate(freshBooking);
    const baseAgg = nOk ? nAgg : freshBooking;
    // Reuse matching open Checkout — never mint a second payable session for the same balance.
    const open = (Array.isArray(baseAgg.paymentAttempts) ? baseAgg.paymentAttempts : [])
      .find((a) => a
        && a.status === 'open'
        && a.amountCents === prepared.amountCents
        && a.quoteVersion === prepared.quoteVersion
        && a.providerObjectId
        && baseAgg.payLink);
    if (open && baseAgg.payLink) {
      return jsonCors(200, {
        ok: true,
        bookingId,
        url: baseAgg.payLink,
        id: open.providerObjectId,
        amountDueApproved: amountDollars,
        remainingCents: prepared.amountCents,
        bookingVersion: prepared.bookingVersion,
        quoteVersion: prepared.quoteVersion,
        reused: true,
      });
    }

    // Expire any other open sessions before creating a new one (prevents dual Checkout windows).
    const superseded = supersedeOpenAttempts(baseAgg.paymentAttempts, {
      quoteVersion: prepared.quoteVersion,
      forceAll: true,
    });
    await expireSupersededAttempts(superseded, process.env);

    const base = process.env.SITE_URL || 'https://cardetail1.netlify.app';
    const form = new URLSearchParams({
      mode: 'payment',
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Cardetail1 · ${bookingId}`,
      'line_items[0][price_data][unit_amount]': String(prepared.amountCents),
      'line_items[0][quantity]': '1',
      success_url: `${base}/my-garage.html?paid=1&bookingId=${encodeURIComponent(bookingId)}`,
      cancel_url: `${base}/my-garage.html?canceled=1&bookingId=${encodeURIComponent(bookingId)}`,
    });
    if (freshBooking.email) form.append('customer_email', freshBooking.email);
    form.append('metadata[booking_id]', bookingId);
    form.append('metadata[purpose]', 'customer_balance');
    form.append('metadata[amount_due]', String(amountDollars));
    form.append('metadata[bookingVersion]', String(prepared.bookingVersion));
    form.append('metadata[quoteVersion]', String(prepared.quoteVersion));
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${prepared.secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': prepared.idempotencyKey,
      },
      body: form,
    });
    const sess = await res.json().catch(() => ({}));
    if (!res.ok) {
      return jsonCors(res.status, { ok: false, error: (sess.error && sess.error.message) || 'stripe_error' });
    }
    const attempt = buildPaymentAttempt({
      bookingId,
      bookingVersion: prepared.bookingVersion,
      quoteVersion: prepared.quoteVersion,
      amountCents: prepared.amountCents,
      providerObjectId: sess.id,
      type: 'customer_balance',
      idempotencyKey: prepared.idempotencyKey,
    });
    attempt.status = 'open';
    const next = buildNextAggregate(baseAgg, {
      ...applyPayLinkMoney(baseAgg, amountDollars, sess.url, sess.id),
      paymentAttempts: [...superseded, attempt],
      payLinkSentAt: now,
      eventLog: appendEventLog(baseAgg, { action: 'stripe_pay_link_generated', by: 'admin', amount: amountDollars }),
    });
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: baseAgg.bookingVersion || 0,
      nextAggregate: next,
    });
    if (!committed.ok) {
      try {
        await fetch(`https://api.stripe.com/v1/checkout/sessions/${sess.id}/expire`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${prepared.secret}` },
        });
      } catch { /* ignore */ }
      return jsonCors(409, { ok: false, error: 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      url: sess.url,
      id: sess.id,
      amountDueApproved: amountDollars,
      remainingCents: prepared.amountCents,
      bookingVersion: committed.bookingVersion,
      quoteVersion: prepared.quoteVersion,
    });
  }

  if (action === 'charge_policy_fee') {
    return jsonCors(410, {
      ok: false,
      error: 'policy_charge_pending_authoritative_ledger',
      message: 'Off-session policy charges are disabled until they use the PostgreSQL payment authority.',
    });
    const stripeGuard = guardStripeOrReject(process.env, { purpose: 'policy_charge' });
    if (stripeGuard.blocked) {
      return jsonCors(stripeGuard.statusCode, stripeGuard.body);
    }
    const js = normalizeJobStatus(booking);
    const cancelled = js === 'cancelled'
      || String(booking.appointmentStatus || '').toLowerCase() === 'canceled'
      || String(booking.appointmentStatus || '').toLowerCase() === 'cancelled'
      || String(booking.cancellationRequestStatus || '').toLowerCase() === 'approved'
      || String(booking.status || '').toLowerCase() === 'cancelled'
      || String(booking.status || '').toLowerCase() === 'canceled';
    const completed = [
      'completed_paid',
      'completed_pending_admin_review',
      'completed_pending_payment',
    ].includes(js);
    if (cancelled || completed) {
      return jsonCors(409, {
        ok: false,
        error: 'policy_charge_blocked',
        message: cancelled
          ? 'Policy fee blocked — appointment is cancelled within terms / already cancelled.'
          : 'Policy fee blocked — job is already completed.',
      });
    }
    const secret = stripeGuard.secret;
    const feeType = sanitizeText(body.feeType, 32);
    const preset = { no_show: 75, late_cancel: 50 };
    const cap = preset[feeType] || 50;
    if (booking.policyChargeStatus === 'charged' && body.forceRetry !== true) {
      return jsonCors(409, { ok: false, error: 'policy_already_charged' });
    }
    let amountDollars;
    if (body.amount != null) {
      amountDollars = Math.round(Number(body.amount) * 100) / 100;
      if (amountDollars > cap) {
        return jsonCors(400, { ok: false, error: 'amount_exceeds_policy_cap', max: cap });
      }
    } else {
      amountDollars = cap;
    }
    const amountCents = Math.round(amountDollars * 100);
    const customerId = booking.stripeCustomerId;
    const pmId = booking.stripePaymentMethodId;
    if (!customerId || !pmId) {
      return jsonCors(409, { ok: false, error: 'no_card_on_file', message: 'Booking has no saved Stripe customer/payment method.' });
    }
    const form = new URLSearchParams({
      amount: String(amountCents),
      currency: 'usd',
      customer: customerId,
      payment_method: pmId,
      off_session: 'true',
      confirm: 'true',
      description: `Cardetail1 policy fee · ${bookingId} · ${feeType || 'policy'}`,
      'metadata[booking_id]': bookingId,
      'metadata[fee_type]': feeType || 'policy',
    });
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const pi = await res.json().catch(() => ({}));
    if (!res.ok) {
      return jsonCors(res.status, { ok: false, error: (pi.error && pi.error.message) || 'stripe_charge_failed' });
    }
    const succeeded = pi.status === 'succeeded';
    await store.setJSON(bookingId, {
      ...booking,
      policyChargeStatus: succeeded ? 'charged' : pi.status,
      policyChargeAmount: amountDollars,
      policyChargeType: feeType || 'policy',
      policyChargeAt: now,
      policyPaymentIntentId: pi.id,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'policy_fee_charged', by: 'admin', feeType, amount: amountDollars, status: pi.status,
      }),
    });
    return jsonCors(200, { ok: true, bookingId, paymentIntentId: pi.id, status: pi.status, amount: amountDollars });
  }

  if (action === 'record_refund_request') {
    const reason = sanitizeText(body.reason, 500);
    const amountNumber = Number(body.amount);
    const amountCents = Math.round(amountNumber * 100);
    const expectedBookingVersion = Math.round(Number(body.expectedBookingVersion));
    const actualBookingVersion = Math.round(Number(booking.bookingVersion) || 0);
    if (!reason) return jsonCors(400, { ok: false, error: 'reason_required' });
    if (!Number.isFinite(amountNumber) || !(amountCents > 0)) {
      return jsonCors(400, { ok: false, error: 'invalid_refund_amount' });
    }
    if (body.expectedBookingVersion == null
      || !Number.isFinite(expectedBookingVersion)
      || expectedBookingVersion !== actualBookingVersion) {
      return jsonCors(409, {
        ok: false,
        error: 'version_conflict',
        expectedBookingVersion: Number.isFinite(expectedBookingVersion) ? expectedBookingVersion : null,
        actualBookingVersion,
      });
    }
    const { postgresPaymentEnabled } = require('../lib/db/operational-payment');
    if (!postgresPaymentEnabled()) {
      return jsonCors(503, { ok: false, error: 'postgres_payment_disabled' });
    }
    const { ensureBookingFinancial } = require('../lib/db/ensure-booking-financial');
    const ensured = await ensureBookingFinancial(booking);
    if (!ensured.ok) return jsonCors(503, { ok: false, error: ensured.error || 'ensure_failed' });
    const authority = require('../lib/db/payment-authority-service');
    const projection = await authority.getFinancialProjection(bookingId);
    const result = await authority.createRefund({
      bookingId,
      amountCents,
      reason,
      requestKey: sanitizeText(body.requestKey, 96),
      expectedQuoteVersion: body.expectedQuoteVersion || projection?.quoteVersion,
      requestedBy: 'admin',
    });
    if (!result.ok) {
      return jsonCors(result.statusCode || 400, {
        ok: false,
        error: result.error,
        retryable: !!result.retryable,
        actualQuoteVersion: result.actualQuoteVersion,
      });
    }
    return jsonCors(202, {
      ok: true,
      bookingId,
      refundStatus: result.refundRequest.status,
      refundRequestId: result.refundRequest.id,
      refundRequestIds: (result.refundRequests || [result.refundRequest]).map((request) => request.id),
      amountCents: (result.refundRequests || [result.refundRequest])
        .reduce((sum, request) => sum + request.amountCents, 0),
      splitAcrossPayments: !!result.splitAcrossPayments,
      awaitingWebhook: !!result.awaitingWebhook,
      note: 'Stripe accepted the request. The ledger changes only after the signed refund webhook.',
    });
  }

  if (action === 'vehicle_mutation') {
    const result = await adminVehicleMutation({ bookingId, body, previousBooking: booking });
    const { statusCode, ...payload } = result;
    return jsonCors(statusCode || (result.ok ? 200 : 400), payload);
  }

  if (action === 'mark_refunded') {
    return jsonCors(410, {
      ok: false,
      error: 'manual_refund_status_disabled',
      message: 'Use Issue Stripe refund. Only the signed Stripe webhook can record a refund in the ledger.',
    });
  }

  if (action === 'record_job_balance') {
    const techPayout = body.techPayoutAmount != null ? Math.round(Number(body.techPayoutAmount) * 100) / 100 : booking.techPayoutAmount;
    const finalAmount = body.finalAmount != null ? Math.round(Number(body.finalAmount) * 100) / 100 : booking.finalAmount;
    const platformFee = (finalAmount != null && techPayout != null)
      ? Math.round((finalAmount - techPayout) * 100) / 100 : null;
    const patched = {
      ...booking,
      finalAmount: finalAmount != null ? finalAmount : booking.finalAmount,
      techPayoutAmount: techPayout != null ? techPayout : booking.techPayoutAmount,
      platformFeeAmount: platformFee,
      balanceRecordedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'job_balance_recorded', by: 'admin', finalAmount, techPayout, platformFee }),
    };
    if (finalAmount != null) {
      patched.approvedFinalAmount = finalAmount;
      patched.totalPrice = finalAmount;
    }
    const persisted = await persistMutation(store, bookingId, patched, booking, 'record_job_balance', 'admin_balance');
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, platformFee, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'reschedule') {
    const confirmedDate = sanitizeText(body.confirmedDate || body.date, 32);
    const confirmedTime = sanitizeText(body.confirmedTime || body.time, 32);
    const confirmedTimeWindow = sanitizeText(body.confirmedTimeWindow || body.timeWindow, 64);
    if (!confirmedDate) return jsonCors(400, { ok: false, error: 'date_required' });
    const patched = {
      ...booking,
      confirmedDate,
      preferredDate: confirmedDate,
      ...(confirmedTime ? { confirmedTime, preferredTime: confirmedTime } : {}),
      ...(confirmedTimeWindow ? { confirmedTimeWindow } : {}),
      jobStatus: ['cancelled', 'archived_test', 'completed_paid'].includes(booking.jobStatus) ? booking.jobStatus : 'confirmed',
      appointmentStatus: 'confirmed',
      status: 'Rescheduled',
      rescheduledByAdmin: true,
      rescheduledByAdminAt: now,
      rescheduledByClient: false,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'admin_reschedule', by: 'admin', confirmedDate, confirmedTime, confirmedTimeWindow,
      }),
    };
    await store.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId, confirmedDate });
  }

  if (action === 'update_address') {
    const address = sanitizeText(body.address, 300);
    const zipCode = sanitizeText(body.zipCode || body.zip, 16);
    if (!address) return jsonCors(400, { ok: false, error: 'address_required' });
    const patched = {
      ...booking,
      address,
      ...(zipCode ? { zipCode } : {}),
      addressChangedByClient: false,
      addressUpdatedByAdmin: true,
      addressUpdatedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'admin_address_update', by: 'admin', address, zipCode }),
    };
    await store.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'cancel_booking') {
    const reason = sanitizeText(body.reason, 500);
    const patched = {
      ...booking,
      jobStatus: 'cancelled',
      appointmentStatus: 'canceled',
      status: 'Cancelled',
      canceledAt: now,
      cancellationReason: reason || booking.cancellationReason || 'admin_cancelled',
      cancellationRequestStatus: booking.cancellationRequestStatus === 'requested' ? 'resolved_approved' : booking.cancellationRequestStatus,
      cancellationResolvedAt: now,
      cancellationResolvedNote: reason || 'Cancelled by admin',
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'booking_cancelled', by: 'admin', reason }),
    };
    await store.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId, jobStatus: 'cancelled' });
  }

  if (action === 'resolve_cancellation') {
    const decision = sanitizeText(body.decision, 24);
    if (!['approved', 'denied'].includes(decision)) {
      return jsonCors(400, { ok: false, error: 'decision_must_be_approved_or_denied' });
    }
    const note = sanitizeText(body.note, 500);
    if (decision === 'approved') {
      const patched = {
        ...booking,
        jobStatus: 'cancelled',
        appointmentStatus: 'canceled',
        status: 'Cancelled',
        canceledAt: now,
        cancellationRequestStatus: 'resolved_approved',
        cancellationResolvedAt: now,
        cancellationResolvedNote: note,
        updatedAt: now,
        eventLog: appendEventLog(booking, { action: 'cancellation_approved', by: 'admin', note }),
      };
      await store.setJSON(bookingId, patched);
      return jsonCors(200, { ok: true, bookingId, jobStatus: 'cancelled' });
    }
    await store.setJSON(bookingId, {
      ...booking,
      cancellationRequestStatus: 'resolved_denied',
      cancellationResolvedAt: now,
      cancellationResolvedNote: note,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'cancellation_denied', by: 'admin', note }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'apply_customer_request') {
    const requestType = sanitizeText(body.requestType, 32);
    if (requestType === 'reschedule' && booking.rescheduledByClient) {
      const confirmedDate = sanitizeText(booking.rescheduleRequestedDate || body.confirmedDate, 32);
      const confirmedTime = sanitizeText(booking.rescheduleRequestedTime || body.confirmedTime, 32);
      if (!confirmedDate) return jsonCors(400, { ok: false, error: 'no_reschedule_request' });
      const patched = {
        ...booking,
        confirmedDate,
        preferredDate: confirmedDate,
        ...(confirmedTime ? { confirmedTime, preferredTime: confirmedTime } : {}),
        jobStatus: 'confirmed',
        appointmentStatus: 'confirmed',
        status: 'Rescheduled',
        rescheduledByClient: false,
        rescheduleRequestAppliedAt: now,
        updatedAt: now,
        eventLog: appendEventLog(booking, { action: 'customer_reschedule_applied', by: 'admin' }),
      };
      await store.setJSON(bookingId, patched);
      return jsonCors(200, { ok: true, bookingId });
    }
    if (requestType === 'address' && (booking.addressChangedByClient || booking.requestedAddress)) {
      const address = sanitizeText(booking.requestedAddress || body.address, 300);
      if (!address) return jsonCors(400, { ok: false, error: 'no_address_request' });
      const service = {
        ...(booking.service && typeof booking.service === 'object' ? booking.service : {}),
        serviceAddress: address,
        vehicles: (booking.service && Array.isArray(booking.service.vehicles))
          ? booking.service.vehicles
          : (booking.vehicles || []),
      };
      const changeRequests = (Array.isArray(booking.changeRequests) ? booking.changeRequests : []).map((r) => {
        const type = r.requestType || r.type;
        const open = ['pending', 'pending_approval'].includes(String(r.status || '').toLowerCase());
        if (type === 'address_update' && open) {
          return {
            ...r,
            status: 'applied',
            decision: 'approve',
            decidedAt: now,
            customerVisibleResult: 'Address updated.',
          };
        }
        return r;
      });
      const patched = {
        ...booking,
        address,
        service,
        requestedAddress: '',
        addressChangedByClient: false,
        addressRequestAppliedAt: now,
        changeRequests,
        customerChangePending: changeRequests.some((r) => ['pending', 'pending_approval', 'needs_clarification'].includes(String(r.status || '').toLowerCase())),
        updatedAt: now,
        eventLog: appendEventLog(booking, { action: 'customer_address_applied', by: 'admin' }),
      };
      const persisted = await persistMutation(store, bookingId, patched, booking, 'customer_address_applied', 'admin_apply');
      if (!persisted.ok) {
        return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
      }
      try {
        const { rebuildRequestIndex } = require('../lib/booking-commands');
        await Promise.all(changeRequests
          .filter((r) => (r.requestType || r.type) === 'address_update' && r.status === 'applied')
          .map((r) => rebuildRequestIndex({
            ...r,
            id: r.requestId || r.id,
            bookingId,
            status: 'applied',
            adminDecision: 'approve',
            decidedAt: now,
          })));
      } catch { /* fail-open */ }
      return jsonCors(200, { ok: true, bookingId, bookingVersion: persisted.bookingVersion });
    }
    return jsonCors(400, { ok: false, error: 'no_pending_customer_request' });
  }

  if (action === 'archive_test') {
    const reason = sanitizeText(body.reason, 200) || 'admin_archive_test';
    await store.setJSON(bookingId, archiveBookingRecord(booking, reason));
    return jsonCors(200, { ok: true, bookingId, archived: true });
  }

  if (action === 'update_customer') {
    const result = updateCustomerContact(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'update_customer', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'update_vehicles') {
    return jsonCors(410, {
      ok: false,
      error: 'legacy_vehicle_mutation_disabled',
      message: 'Use vehicle_mutation with a stable vehicleId, expectedBookingVersion, and idempotencyKey.',
    });
  }

  if (action === 'update_service') {
    if (freeFormAddonBodyRejected(body)) {
      return jsonCors(400, {
        ok: false,
        error: 'addon_mutation_required',
        message: 'Add-on changes must use action addon_mutation with canonical add-on IDs only.',
      });
    }
    // Package-bearing update_service uses the same Postgres-authoritative
    // adapter as change_package — never the legacy service-edit mutator or
    // Blob persist as package money authority.
    if (bodyHasPackageMutation(body)) {
      const result = await adminChangePackage({ bookingId, body, previousBooking: booking });
      const { statusCode, ...payload } = result;
      return jsonCors(statusCode || (result.ok ? 200 : 400), payload);
    }
    const result = await updateServicePackage(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'update_service', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      totalPrice: persisted.booking.totalPrice,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'admin_tech_status') {
    const result = adminTechStatus(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'admin_tech_status', body.statusAction);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, jobStatus: persisted.booking.jobStatus, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'approve_adjustment') {
    const result = approveAdjustment(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'approve_adjustment', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      approvedFinalAmount: persisted.booking.approvedFinalAmount,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'reject_adjustment') {
    const reason = sanitizeText(body.reason, 500);
    if (!reason) return jsonCors(400, { ok: false, error: 'reason_required' });
    const result = rejectAdjustment(booking, body);
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'reject_adjustment', reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'price_adjustment') {
    const {
      createAdjustment, decideAdjustment, applyAdjustment, adjustmentStatement,
    } = require('../lib/price-adjustments');
    const op = sanitizeText(body.op, 32) || 'create';
    const handlers = { create: createAdjustment, decide: decideAdjustment, apply: applyAdjustment };
    const handler = handlers[op];
    if (!handler) {
      return jsonCors(400, { ok: false, error: 'invalid_adjustment_op', ops: Object.keys(handlers) });
    }

    const result = handler(booking, { ...body, actorId: 'admin' });
    if (!result.ok) {
      return jsonCors(result.statusCode || 400, {
        ok: false,
        error: result.error,
        message: result.message,
        status: result.status,
        types: result.types,
        approvedCents: result.approvedCents,
        expectedBookingVersion: result.expectedBookingVersion,
        actualBookingVersion: result.actualBookingVersion,
      });
    }
    if (result.alreadyApplied) {
      return jsonCors(200, {
        ok: true,
        bookingId,
        idempotent: true,
        adjustment: result.adjustment,
        statement: adjustmentStatement(booking),
      });
    }

    let authoritativeAdjustment = null;
    if (op === 'apply') {
      const { postgresPaymentEnabled } = require('../lib/db/operational-payment');
      const { ensureBookingFinancial } = require('../lib/db/ensure-booking-financial');
      const authority = require('../lib/db/payment-authority-service');
      if (!postgresPaymentEnabled()) {
        return jsonCors(503, { ok: false, error: 'postgres_payment_disabled' });
      }
      const ensured = await ensureBookingFinancial(booking);
      if (!ensured.ok) {
        return jsonCors(503, { ok: false, error: ensured.error || 'ensure_failed' });
      }
      authoritativeAdjustment = await authority.createAdjustment({
        bookingId,
        newApprovedCents: result.approvedCents,
        reason: result.adjustment.reason,
        adjustmentId: result.adjustment.adjustmentId,
        expectedQuoteVersion: result.adjustment.quoteVersion,
        approvedBy: result.adjustment.decidedBy || 'admin',
      });
      if (!authoritativeAdjustment.ok) {
        return jsonCors(authoritativeAdjustment.statusCode || 409, {
          ok: false,
          error: authoritativeAdjustment.error || 'adjustment_failed',
          expectedQuoteVersion: authoritativeAdjustment.expectedQuoteVersion,
          actualQuoteVersion: authoritativeAdjustment.actualQuoteVersion,
        });
      }
      const pg = authoritativeAdjustment.after;
      result.patch = {
        ...result.patch,
        quoteVersion: pg.quoteVersion,
        quote: {
          ...(booking.quote || {}),
          quoteVersion: pg.quoteVersion,
          approvedCents: pg.approvedCents,
          currency: 'usd',
          adjustmentId: result.adjustment.adjustmentId,
          adjustmentReason: result.adjustment.reason,
        },
        ledger: {
          ...(booking.ledger || {}),
          currency: 'usd',
          approvedCents: pg.approvedCents,
          settledCents: pg.settledCents,
          refundedCents: pg.refundedCents,
        },
        approvedFinalAmount: pg.approvedCents / 100,
        finalAmount: pg.approvedCents / 100,
        totalPrice: pg.approvedCents / 100,
        amountPaid: pg.settledCents / 100,
        paidAmount: pg.settledCents / 100,
        amountDueApproved: pg.remainingCents / 100,
        balanceDue: pg.remainingCents / 100,
      };
    }

    const patched = {
      ...booking,
      ...result.patch,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: `price_adjustment_${op}`,
        by: 'admin',
        adjustmentId: result.adjustment.adjustmentId,
        type: result.adjustment.type,
        amountCents: result.adjustment.amountCents,
      }),
    };
    // PostgreSQL already minted the immutable quote for apply. This Blob write
    // is compatibility state only and must not create a second quote.
    const persistAction = 'price_adjustment';
    const persisted = await persistMutation(
      store, bookingId, patched, booking, persistAction,
      result.adjustment.reason || sanitizeText(body.reason, 500)
    );
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
      adjustment: result.adjustment,
      outcome: result.outcome || result.adjustment.projectedOutcome,
      supplementalDueCents: result.supplementalDueCents || 0,
      refundReviewRequired: !!persisted.booking.refundReviewRequired,
      outstandingCreditCents: authoritativeAdjustment?.outstandingCreditCents || 0,
      statement: adjustmentStatement(persisted.booking),
    });
  }

  if (action === 'set_approved_final_amount') {
    const { guardDirectTotalMutation } = require('../lib/price-adjustments');
    // Typing a new total over settled money loses the reason and the approval.
    const guard = guardDirectTotalMutation(booking, body);
    if (!guard.ok) {
      return jsonCors(guard.statusCode || 409, {
        ok: false,
        error: guard.error,
        message: guard.message,
        status: guard.status,
        settledCents: guard.settledCents,
      });
    }
    const result = setApprovedFinalAmount(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'set_approved_final_amount', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      approvedFinalAmount: persisted.booking.approvedFinalAmount,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'mark_cash_received') {
    const result = await adminMarkCashReceived({
      bookingId,
      body,
      previousBooking: booking,
      store,
    });
    if (!result.ok) {
      return jsonCors(result.statusCode || 400, {
        ok: false,
        error: result.error || 'cash_settlement_failed',
        expectedAmountCents: result.expectedAmountCents,
        receivedAmountCents: result.receivedAmountCents,
        reason: result.reason || undefined,
        projection: result.projection || undefined,
        authority: result.authority || undefined,
        postgresProjection: result.postgresProjection || undefined,
        settlementRecorded: result.settlementRecorded || undefined,
        syncError: result.syncError || undefined,
      });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      paymentStatus: result.paymentStatus,
      bookingVersion: result.bookingVersion,
      projection: result.projection,
      authority: result.authority || undefined,
      postgresProjection: result.postgresProjection || undefined,
      settledAmountCents: result.settledAmountCents,
      // Delivery outcome is surfaced, not swallowed: Admin must be able to see
      // that the money landed but the email did not.
      notification: result.notification || undefined,
      noop: result.noop || undefined,
    });
  }

  if (action === 'mark_card_on_site') {
    const result = await adminMarkCardOnSite({
      bookingId,
      body,
      previousBooking: booking,
      store,
    });
    if (!result.ok) {
      return jsonCors(result.statusCode || 400, {
        ok: false,
        error: result.error || 'card_on_site_settlement_failed',
        expectedAmountCents: result.expectedAmountCents,
        receivedAmountCents: result.receivedAmountCents,
        projection: result.projection || undefined,
        authority: result.authority || undefined,
      });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      paymentStatus: result.paymentStatus,
      bookingVersion: result.bookingVersion,
      projection: result.projection,
      authority: result.authority,
      settledAmountCents: result.settledAmountCents,
      notification: result.notification || undefined,
      noop: result.noop || undefined,
    });
  }

  if (action === 'generate_customer_link') {
    const siteUrl = process.env.DEPLOY_PRIME_URL || process.env.URL || '';
    const result = await generateCustomerLinks(booking, body, siteUrl);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const patch = {
      ...booking,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'customer_link_generated', by: 'admin', linkType: result.linkType }),
    };
    if (result.linkType === 'completion') {
      patch.completionLinkUrl = result.url;
      patch.completionLinkExpiresAt = result.expiresAt;
    } else {
      patch.myGarageLinkUrl = result.url;
    }
    const persisted = await persistMutation(store, bookingId, patch, booking, 'generate_customer_link', result.linkType);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, url: result.url, linkType: result.linkType, expiresAt: result.expiresAt || null, bookingVersion: persisted.bookingVersion });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
}

/**
 * Operational reopen.
 *
 * Deliberately routed through persistMutation with an action name that is NOT in
 * MONEY_MUTATION_ACTIONS: the ledger, settled total, remaining balance, payment
 * attempts, receipts and Stripe objects are copied forward untouched. A reopen
 * that resurrected the original balance would be indistinguishable from billing
 * the customer twice.
 */
async function handleReopen({ store, bookingId, booking, body }) {
  const reason = sanitizeText(body.reason, 500);
  if (!reason) {
    return jsonCors(400, {
      ok: false,
      error: 'reason_required',
      message: 'Record why this job is being reopened.',
    });
  }

  if (body.expectedBookingVersion != null && body.expectedBookingVersion !== '') {
    const expected = Math.round(Number(body.expectedBookingVersion));
    const actual = Math.round(Number(booking.bookingVersion) || 0);
    if (!Number.isFinite(expected) || expected !== actual) {
      return jsonCors(409, {
        ok: false,
        error: 'version_conflict',
        expectedBookingVersion: expected,
        actualBookingVersion: actual,
      });
    }
  }

  const result = reopenAppointment(booking, body);
  if (!result.ok) {
    return jsonCors(result.statusCode || 400, {
      ok: false,
      error: result.error,
      from: result.from,
      message: result.message,
    });
  }

  const persisted = await persistMutation(store, bookingId, result.booking, booking, 'reopen_appointment', reason);
  if (!persisted.ok) {
    return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
  }

  // Customer is told only when Admin asks for it — a reopen is often an internal
  // correction the customer neither expects nor needs to hear about.
  let customerNotified = false;
  let notifyError = null;
  if (body.notifyCustomer === true) {
    try {
      const { emitCustomerActionRequired } = require('../lib/booking-transactional-notifications');
      const txn = await emitCustomerActionRequired(persisted.booking, {});
      customerNotified = !!(txn && txn.delivery && txn.delivery.email && txn.delivery.email.sent);
      if (txn && txn.booking) {
        await persistMutation(
          store, bookingId, txn.booking, persisted.booking, 'reopen_notification', 'reopen_notify'
        ).catch(() => null);
      }
    } catch (e) {
      notifyError = 'notification_failed';
      console.warn('[admin-ops-jobs] reopen notify failed:', e.message);
    }
  }

  const { financialProjection } = require('../lib/payment-service');
  return jsonCors(200, {
    ok: true,
    bookingId,
    jobStatus: persisted.booking.jobStatus,
    serviceStatus: persisted.booking.serviceStatus,
    bookingVersion: persisted.bookingVersion,
    reopenedAt: persisted.booking.reopenedAt,
    previousCompletedAt: persisted.booking.previousCompletedAt || null,
    reopenCount: persisted.booking.reopenCount || 1,
    // Returned so the caller can assert the money did not move.
    projection: financialProjection(persisted.booking),
    customerNotified,
    notifyError,
  });
}

async function bulkArchiveTests(store, includeAlreadyArchived) {
  const blobs = await listAllBlobs(store, 'cd1-bookings');
  let archived = 0;
  let skipped = 0;
  const ids = [];
  for (const blob of blobs) {
    const booking = await store.get(blob.key, { type: 'json' }).catch(() => null);
    if (!booking || booking.isDraft) { skipped++; continue; }
    if (!includeAlreadyArchived && (booking.archived || booking.jobStatus === 'archived_test')) { skipped++; continue; }
    if (!isLikelyTestBooking(booking)) { skipped++; continue; }
    await store.setJSON(blob.key, archiveBookingRecord(booking, 'bulk_test_cleanup'));
    archived++;
    ids.push(blob.key);
  }
  return { archived, skipped, ids: ids.slice(0, 50) };
}

/**
 * Customer payment confirmation after a settlement has been recorded.
 *
 * Called only once the money is committed, and it can only ever fail *forward*:
 * a bounced email, a missing Resend key or a Blob write error is reported in the
 * response and recorded on the booking, never converted into a rollback. The
 * customer has paid; that fact does not depend on our mail provider.
 */
async function notifyPaymentReceived({
  store,
  bookingId,
  booking,
  method = 'cash',
  amountCents,
  projection,
}) {
  const status = { attempted: true, sent: false, reason: null, channel: 'email' };
  try {
    const { emitPaymentReceived } = require('../lib/booking-transactional-notifications');
    const { receiptEligibility } = require('../lib/receipt-projection');

    let receiptUrl = '';
    try {
      const el = receiptEligibility(booking);
      if (el.payment) {
        const base = String(process.env.DEPLOY_PRIME_URL || process.env.URL || '').replace(/\/$/, '');
        const type = el.final ? 'final' : 'payment';
        receiptUrl = base
          ? `${base}/receipt.html?bookingId=${encodeURIComponent(bookingId)}&type=${type}`
          : '';
      }
    } catch { /* receipt link is a nicety, not a precondition */ }

    const txn = await emitPaymentReceived(booking, {
      method,
      amountCents: Math.max(0, Math.round(Number(amountCents) || 0)),
      approvedCents: Math.max(0, Math.round(Number(projection?.approvedCents) || 0)),
      remainingCents: Math.max(0, Math.round(Number(projection?.remainingCents) || 0)),
      settledCentsAfter: Math.max(0, Math.round(Number(projection?.settledCents) || 0)),
      recordedAt: new Date().toISOString(),
      settlementId: `${bookingId}:${projection?.settledCents || 0}:${method}`,
      receiptUrl,
    });

    if (txn && txn.delivery && txn.delivery.email) {
      status.sent = !!txn.delivery.email.sent;
      status.reason = txn.delivery.email.reason || null;
      status.skipped = !!txn.delivery.email.skipped;
    } else {
      status.reason = (txn && txn.error) || 'notify_failed';
    }

    if (txn && txn.booking && store) {
      const persisted = await persistMutation(
        store, bookingId, txn.booking, booking, 'payment_notification', 'cash_receipt_email'
      ).catch(() => null);
      if (!persisted || !persisted.ok) {
        // Delivery already happened; only the ledger of *what we sent* is stale.
        status.ledgerPersisted = false;
      } else {
        status.ledgerPersisted = true;
        status.booking = persisted.booking;
      }
    }
  } catch (e) {
    status.reason = 'notify_failed';
    console.warn('[admin-ops-jobs] payment notification failed:', e.message);
  }
  return status;
}

/**
 * Admin "Mark cash received" — full remaining balance settlement only.
 * When PostgreSQL payment authority is enabled, settle in Postgres first,
 * then sync only Blob payment compatibility (no second Blob money credit and
 * no implicit service/job close). When Postgres is disabled, fail closed.
 */
async function adminMarkCashReceived({
  bookingId,
  body = {},
  previousBooking = null,
  store = null,
  syncBlob = null,
  env = process.env,
} = {}) {
  const { financialProjection } = require('../lib/payment-service');
  const {
    postgresPaymentEnabled,
    settleAdminCashFullBalance,
    syncBlobCompatibilityFromProjection,
  } = require('../lib/db/operational-payment');
  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'bookingId_required', statusCode: 400 };
  const reason = sanitizeText(body.reason, 500);
  if (!reason) return { ok: false, error: 'reason_required', statusCode: 400 };

  let booking = previousBooking;
  if (!booking) {
    const rec = await getBookingRecord(id);
    booking = rec.booking;
  }
  if (!booking) return { ok: false, error: 'booking_not_found', statusCode: 404 };

  // Financial mutations always require an explicit version from the caller.
  const expected = Math.round(Number(body.expectedBookingVersion));
  const actual = Math.round(Number(booking.bookingVersion) || 0);
  if (body.expectedBookingVersion == null || body.expectedBookingVersion === ''
    || !Number.isFinite(expected) || expected !== actual) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: Number.isFinite(expected) ? expected : null,
      actualBookingVersion: actual,
      projection: financialProjection(booking),
    };
  }

  if (store) setBookingStoreOverride(store);

  if (!postgresPaymentEnabled(env)) {
    return {
      ok: false,
      error: 'postgres_payment_disabled',
      statusCode: 503,
      authority: 'unavailable',
      projection: financialProjection(booking),
    };
  }

  if (postgresPaymentEnabled(env)) {
    const result = await settleAdminCashFullBalance({
      booking,
      body,
      env,
      syncBlob: typeof syncBlob === 'function' ? syncBlob : syncBlobCompatibilityFromProjection,
    });
    if (!result.ok) {
      return {
        ...result,
        bookingVersion: result.bookingVersion != null
          ? result.bookingVersion
          : Math.round(Number(booking.bookingVersion) || 0),
        quoteVersion: result.quoteVersion != null
          ? result.quoteVersion
          : Math.round(Number(booking.quoteVersion || booking.quote?.quoteVersion) || 0),
      };
    }
    // Settlement is committed in Postgres before we go anywhere near email.
    const pgNotification = await notifyPaymentReceived({
      store,
      bookingId: id,
      booking: result.booking || booking,
      method: 'cash',
      amountCents: result.settledAmountCents,
      projection: result.postgresProjection || result.projection,
    });
    return { ...result, notification: pgNotification };
  }

  return { ok: false, error: 'postgres_payment_disabled', statusCode: 503 };
}

/** Test / inspect seams — production traffic uses exports.handler only. */
async function adminMarkCardOnSite({
  bookingId,
  body = {},
  previousBooking = null,
  store = null,
  env = process.env,
} = {}) {
  const id = String(bookingId || '').trim();
  const reason = sanitizeText(body.reason, 500);
  const reference = sanitizeText(body.reference, 120);
  if (!id) return { ok: false, error: 'bookingId_required', statusCode: 400 };
  if (!reference) return { ok: false, error: 'reference_required', statusCode: 400 };
  if (!reason) return { ok: false, error: 'reason_required', statusCode: 400 };

  let booking = previousBooking;
  if (!booking) {
    const rec = await getBookingRecord(id);
    booking = rec.booking;
  }
  if (!booking) return { ok: false, error: 'booking_not_found', statusCode: 404 };

  const expected = Math.round(Number(body.expectedBookingVersion));
  const actual = Math.round(Number(booking.bookingVersion) || 0);
  if (body.expectedBookingVersion == null || body.expectedBookingVersion === ''
    || !Number.isFinite(expected) || expected !== actual) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: Number.isFinite(expected) ? expected : null,
      actualBookingVersion: actual,
    };
  }

  if (store) setBookingStoreOverride(store);
  const {
    postgresPaymentEnabled,
    settleAdminOnSiteFullBalance,
  } = require('../lib/db/operational-payment');
  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', statusCode: 503, authority: 'unavailable' };
  }

  const result = await settleAdminOnSiteFullBalance({
    booking,
    body: { ...body, reason, reference },
    method: 'card_on_site',
    env,
  });
  if (!result.ok) return result;

  const notification = await notifyPaymentReceived({
    store,
    bookingId: id,
    booking: result.booking || booking,
    method: 'card',
    amountCents: result.settledAmountCents,
    projection: result.postgresProjection || result.projection,
  });
  return { ...result, notification };
}

exports.adminAddonMutation = adminAddonMutation;
exports.adminVehicleMutation = adminVehicleMutation;
exports.adminAddonCatalogForBooking = adminAddonCatalogForBooking;
exports.freeFormAddonBodyRejected = freeFormAddonBodyRejected;
exports.bodyHasPackageMutation = bodyHasPackageMutation;
exports.adminChangePackage = adminChangePackage;
exports.adminPackageCatalogForBooking = adminPackageCatalogForBooking;
exports.packageOptionsForVehicle = packageOptionsForVehicle;
exports.adminMarkCashReceived = adminMarkCashReceived;
exports.adminMarkCardOnSite = adminMarkCardOnSite;
exports.resolveAdminCashSettlement = resolveAdminCashSettlement;
exports.adminOperationalControls = adminOperationalControls;
exports.reconcileRecoveryCapability = reconcileRecoveryCapability;
exports.notifyPaymentReceived = notifyPaymentReceived;
exports.jobsSyncResponse = jobsSyncResponse;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(auth.error === 'missing_admin_password_config' ? 503 : 401, { ok: false, error: auth.error });

  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }
    if (body.action && body.action !== 'list') {
      if (body.action === 'bulk_archive_tests') {
        try {
          const store = await blobsStore('cd1-bookings');
          const result = await bulkArchiveTests(store, body.includeArchived === true);
          return jsonCors(200, { ok: true, ...result });
        } catch {
          return jsonCors(500, { ok: false, error: 'bulk_archive_failed' });
        }
      }
      if (body.action === 'preview_test_cleanup') {
        try {
          const store = await blobsStore('cd1-bookings');
          const blobs = await listAllBlobs(store, 'cd1-bookings');
          const matches = [];
          for (const blob of blobs) {
            const booking = await store.get(blob.key, { type: 'json' }).catch(() => null);
            if (!booking || booking.isDraft || booking.archived) continue;
            if (isLikelyTestBooking(booking)) {
              matches.push({
                id: booking.id || blob.key,
                customer: [booking.firstName, booking.lastName].filter(Boolean).join(' '),
                email: booking.email || '',
              });
            }
          }
          return jsonCors(200, { ok: true, count: matches.length, matches: matches.slice(0, 100) });
        } catch {
          return jsonCors(500, { ok: false, error: 'preview_failed' });
        }
      }
      return handleAdminAction(body);
    }
    try {
      const jobs = await listJobs(body);
      return jobsSyncResponse(jobs, body.ifSyncVersion || body.cursor);
    } catch (e) {
      console.error('[admin-ops-jobs] failed_to_load_jobs (POST):', e.message, e.stack);
      return jsonCors(500, { ok: false, error: 'failed_to_load_jobs' });
    }
  }

  try {
    const jobs = await listJobs(event.queryStringParameters || {});
    const query = event.queryStringParameters || {};
    return jobsSyncResponse(jobs, query.ifSyncVersion || query.cursor);
  } catch (e) {
    console.error('[admin-ops-jobs] failed_to_load_jobs (GET):', e.message, e.stack);
    return jsonCors(500, { ok: false, error: 'failed_to_load_jobs' });
  }
};
