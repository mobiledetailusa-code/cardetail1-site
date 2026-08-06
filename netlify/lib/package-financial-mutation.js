/**
 * Package Stage 1 — authoritative pre-settlement package mutations.
 *
 * Money authority: Postgres PaymentAuthorityService.createAdjustment.
 * Blob is updated as a compatibility projection from that result.
 *
 * Pre-settlement only: any settled money denies the change (no refund or
 * balance rewrite is ever performed here). Post-payment package changes are
 * explicitly out of Stage 1 scope.
 *
 * Canonical package IDs only; identity and price resolve server-side through
 * booking-price-catalog. Browser/operator-supplied names, prices, and totals
 * are never read.
 */

const { getBookingRecord, commitBooking } = require('./booking-repository');
const {
  normalizeAggregate,
  buildNextAggregate,
  materialProjection,
  remainingCents,
  ensureVehicleIds,
} = require('./booking-aggregate');
const { quoteService, applyServiceDelta } = require('./canonical-quote');
const { dollarsToCents, asArray } = require('./historical-adapter');
const {
  PRICING,
  LENGTH_PRICING,
  computeVehicleSubtotal,
} = require('./booking-price-catalog');
const { supersedeOpenAttempts, expireSupersededAttempts, financialProjection } = require('./payment-service');
const {
  postgresPaymentEnabled,
  syncBlobCompatibilityFromProjection,
  mapProjectionForPortals,
} = require('./db/operational-payment');
const { ensureBookingFinancial } = require('./db/ensure-booking-financial');
const authority = require('./db/payment-authority-service');

function settledCentsOf(aggregate) {
  return Math.max(0, Math.round(Number(aggregate?.ledger?.settledCents) || 0));
}

/**
 * Display names for canonical package IDs. Keys must exist in
 * booking-price-catalog PRICING tiers / LENGTH_PRICING packages, and every
 * name must round-trip through PKG_ID_ALIASES / inferPkgId back to the same
 * id (legacy consumers re-infer pkgId from the name).
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

/**
 * Server-priced package options for one catalog-shaped vehicle. Every option
 * is priced through booking-price-catalog (computeVehicleSubtotal probe with
 * add-ons stripped); unpriceable or zero-priced combinations are excluded.
 */
function packageOptionsForVehicle(rawVehicle, bookingBase = {}) {
  const zip = bookingBase?.zipCode || bookingBase?.zip || '';
  const cat = String(rawVehicle?.cat || rawVehicle?.category || 'cars').trim() || 'cars';

  const candidateIds = new Set();
  for (const tier of Object.values(PRICING[cat]?.tiers || {})) {
    for (const key of Object.keys(tier)) if (key !== 'label') candidateIds.add(key);
  }
  for (const key of Object.keys(LENGTH_PRICING[cat]?.packages || {})) candidateIds.add(key);

  const current = computeVehicleSubtotal({ ...rawVehicle, cat, category: cat }, zip, bookingBase);
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
    const priced = computeVehicleSubtotal(probe, zip, bookingBase);
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

/**
 * Resolve the target vehicle and validate the requested package ID against
 * the canonical catalog for that vehicle's category/tier/length.
 */
function validatePackageIdForVehicle(service, target, packageId, bookingBase = {}) {
  const vehicles = ensureVehicleIds(service?.vehicles || []);
  let vehicleId = target?.vehicleId;
  if (!vehicleId && vehicles.length === 1) vehicleId = vehicles[0].vehicleId;
  if (!vehicleId) return { ok: false, error: 'vehicle_target_required' };
  const vehicle = vehicles.find((v) => v.vehicleId === vehicleId);
  if (!vehicle) return { ok: false, error: 'vehicle_not_found' };

  const { category, currentPackageId, options } = packageOptionsForVehicle(vehicle, bookingBase);
  const option = options.find((o) => o.id === packageId);
  if (!option) {
    return {
      ok: false,
      error: 'unknown_package_id',
      packageId,
      category,
      validPackageIds: options.map((o) => o.id),
    };
  }
  return { ok: true, vehicleId, category, currentPackageId, option };
}

/**
 * Change the service package on one vehicle, reprice via canonical-quote,
 * write a Postgres adjustment, then sync Blob compatibility from that
 * authority. Pre-settlement only.
 */
async function applyPackageFinancialMutation({
  bookingId,
  expectedBookingVersion,
  target = {},
  packageId,
  /** Optional: mark this change-request applied in the same Blob commit */
  changeRequest = null,
  adminNote = '',
  env = process.env,
}) {
  const requestedPackageId = String(packageId || '').trim();
  if (!requestedPackageId) {
    return { ok: false, error: 'package_id_required', statusCode: 400 };
  }

  const current = await getBookingRecord(bookingId);
  if (!current.exists) return { ok: false, error: 'not_found', statusCode: 404 };

  const { ok, aggregate } = normalizeAggregate(current.booking);
  if (!ok) return { ok: false, error: 'invalid_aggregate', statusCode: 400 };

  const actualVersion = Math.round(Number(aggregate.bookingVersion) || 0);
  const expected = expectedBookingVersion != null
    ? Math.round(Number(expectedBookingVersion))
    : actualVersion;
  if (actualVersion !== expected) {
    return { ok: false, error: 'version_conflict', statusCode: 409, actualBookingVersion: actualVersion };
  }

  // Pre-settlement only. A package change reprices the whole quote in either
  // direction, so any settled money denies it — no refund or balance rewrite.
  const settled = settledCentsOf(aggregate);
  if (settled > 0) {
    return {
      ok: false,
      error: 'settled_package_change_denied',
      statusCode: 409,
      message: 'Package changes are denied after settlement. No refund or balance rewrite is performed.',
      projection: materialProjection(aggregate),
      financialProjection: financialProjection(aggregate),
    };
  }

  const validated = validatePackageIdForVehicle(
    aggregate.service,
    target,
    requestedPackageId,
    aggregate
  );
  if (!validated.ok) {
    return { ...validated, statusCode: validated.error === 'vehicle_not_found' ? 404 : 400 };
  }

  if (validated.currentPackageId === requestedPackageId) {
    // Same package — no new quote version, no PG adjustment, no ledger mutation.
    if (changeRequest && (changeRequest.requestId || changeRequest.id)) {
      const reqId = changeRequest.requestId || changeRequest.id;
      const nextRequests = asArray(aggregate.changeRequests).map((r) => (
        (r.requestId || r.id) === reqId
          ? {
            ...r,
            status: 'applied',
            decision: 'approve',
            adminNote: adminNote || '',
            decidedAt: new Date().toISOString(),
            appliedBookingVersion: actualVersion + 1,
            noop: true,
            reason: 'package_unchanged',
          }
          : r
      ));
      const next = buildNextAggregate(aggregate, {
        changeRequests: nextRequests,
        customerChangePending: nextRequests.some((r) => r.status === 'pending' || r.status === 'pending_approval'),
      });
      const committed = await commitBooking({
        bookingId,
        expectedBookingVersion: expected,
        nextAggregate: next,
      });
      if (!committed.ok) return committed;
      return {
        ok: true,
        noop: true,
        reason: 'package_unchanged',
        booking: committed.booking,
        projection: materialProjection(committed.booking),
        financialProjection: financialProjection(committed.booking),
        quoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
      };
    }
    return {
      ok: true,
      noop: true,
      reason: 'package_unchanged',
      booking: aggregate,
      projection: materialProjection(aggregate),
      financialProjection: financialProjection(aggregate),
      quoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
    };
  }

  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', statusCode: 503 };
  }

  const applied = applyServiceDelta(
    aggregate.service,
    { vehicleId: validated.vehicleId },
    {
      packageId: requestedPackageId,
      packageName: validated.option.name,
    }
  );
  if (!applied.ok) return { ok: false, error: applied.error, statusCode: 400 };

  const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
  const quoted = quoteService(applied.service, {
    basedOnBookingVersion: actualVersion,
    previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
    travelCents,
    bookingBase: aggregate,
  });
  if (!quoted.ok) return { ok: false, error: quoted.error || 'invalid_pricing', statusCode: 400 };

  // Seed Postgres from current Blob (preserves any existing history).
  const ensured = await ensureBookingFinancial(aggregate);
  if (!ensured.ok) return { ok: false, error: ensured.error || 'ensure_failed', statusCode: 503 };

  const priorProjection = await authority.getFinancialProjection(bookingId);
  const priorQuoteVersion = priorProjection?.quoteVersion || ensured.quoteVersion || 1;

  const adjustment = await authority.createAdjustment({
    bookingId,
    newApprovedCents: quoted.quote.approvedCents,
    reason: 'package_change',
    adjustmentId: `pkg_${bookingId}_${actualVersion}_${quoted.quote.approvedCents}`.slice(0, 96),
    expectedQuoteVersion: priorQuoteVersion,
    approvedBy: changeRequest ? 'customer_request_approved' : 'admin',
  });
  if (!adjustment.ok) {
    return { ok: false, error: adjustment.error || 'adjustment_failed', statusCode: 500 };
  }

  const pgProjection = adjustment.after || await authority.getFinancialProjection(bookingId);
  if (!pgProjection) {
    return { ok: false, error: 'projection_unavailable', statusCode: 500 };
  }

  const ledgerEntries = asArray(aggregate.ledger?.entries);
  const nextLedger = {
    ...aggregate.ledger,
    currency: 'usd',
    approvedCents: pgProjection.approvedCents,
    settledCents: pgProjection.settledCents,
    creditedCents: Math.max(0, Math.round(Number(aggregate.ledger?.creditedCents) || 0)),
    refundedCents: Math.max(0, Math.round(Number(pgProjection.refundedCents) || 0)),
    entries: ledgerEntries,
  };

  const nextQuoteVersion = pgProjection.quoteVersion;
  const nextQuote = {
    ...quoted.quote,
    quoteVersion: nextQuoteVersion,
    approvedCents: pgProjection.approvedCents,
  };

  const paymentAttempts = supersedeOpenAttempts(aggregate.paymentAttempts, {
    quoteVersion: nextQuoteVersion,
  });

  // Compatibility status from authoritative projection (package path only).
  const compatPaymentStatus = pgProjection.paymentStatus === 'paid'
    ? 'paid'
    : pgProjection.paymentStatus === 'processing'
      ? 'processing'
      : pgProjection.paymentStatus === 'refunded'
        ? 'refunded'
        : pgProjection.paymentStatus === 'due'
          ? 'due'
          : (aggregate.paymentStatus || 'no_payment_required_yet');
  const compatWorkflow = pgProjection.paymentStatus === 'paid'
    ? (String(aggregate.paymentWorkflowStatus || '').toLowerCase() === 'cash_paid'
      ? 'cash_paid'
      : 'payment_succeeded')
    : pgProjection.paymentStatus === 'processing'
      ? 'awaiting_customer_payment'
      : pgProjection.paymentStatus === 'due'
        ? 'awaiting_customer_payment'
        : (aggregate.paymentWorkflowStatus || null);

  const appliedBookingVersion = actualVersion + 1;
  let nextChangeRequests = asArray(aggregate.changeRequests);
  if (changeRequest && (changeRequest.requestId || changeRequest.id)) {
    const reqId = changeRequest.requestId || changeRequest.id;
    const found = nextChangeRequests.some((r) => (r.requestId || r.id) === reqId);
    const appliedRow = {
      ...changeRequest,
      status: 'applied',
      decision: 'approve',
      adminNote: adminNote || changeRequest.adminNote || '',
      decidedAt: new Date().toISOString(),
      appliedBookingVersion,
    };
    nextChangeRequests = found
      ? nextChangeRequests.map((r) => ((r.requestId || r.id) === reqId ? { ...r, ...appliedRow } : r))
      : [...nextChangeRequests, appliedRow];
  }

  // When an unpaid delta remains, clear legacy Paid/completed_paid markers so
  // adaptHistoricalBooking/_historicalPaidClosed cannot force settled=approved
  // and zero out remaining. Limited to this package adjustment path.
  const openDeltaPatches = {};
  if (pgProjection.remainingCents > 0) {
    openDeltaPatches._historicalPaidClosed = false;
    openDeltaPatches.paymentStatus = compatPaymentStatus;
    openDeltaPatches.paymentWorkflowStatus = compatWorkflow;
    if (String(aggregate.status || '') === 'Paid' || String(aggregate.status || '') === 'Closed') {
      openDeltaPatches.status = 'Confirmed';
    }
    if (String(aggregate.jobStatus || '').toLowerCase() === 'completed_paid') {
      openDeltaPatches.jobStatus = 'confirmed';
    }
  }

  const next = buildNextAggregate(aggregate, {
    service: quoted.service,
    quote: nextQuote,
    quoteVersion: nextQuoteVersion,
    ledger: nextLedger,
    paymentAttempts,
    changeRequests: nextChangeRequests,
    customerChangePending: nextChangeRequests.some((r) => r.status === 'pending' || r.status === 'pending_approval'),
    payLink: '',
    stripeCheckoutSessionId: '',
    payLinkAmount: null,
    paymentStatus: compatPaymentStatus,
    paymentWorkflowStatus: compatWorkflow,
    packageUpdatedAt: new Date().toISOString(),
    ...openDeltaPatches,
  });

  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;

  await syncBlobCompatibilityFromProjection(bookingId, pgProjection).catch(() => {});

  const refreshed = await getBookingRecord(bookingId);
  const booking = refreshed.exists ? refreshed.booking : committed.booking;
  const blobFp = financialProjection(booking);
  const material = materialProjection(booking);

  await expireSupersededAttempts(paymentAttempts, env).catch(() => {});

  return {
    ok: true,
    noop: false,
    booking,
    packageId: requestedPackageId,
    packageName: validated.option.name,
    priorPackageId: validated.currentPackageId || null,
    vehicleId: validated.vehicleId,
    quoteVersion: nextQuoteVersion,
    priorQuoteVersion,
    postgresProjection: mapProjectionForPortals(pgProjection),
    projection: material,
    financialProjection: blobFp,
    remainingCents: remainingCents(booking.ledger || nextLedger),
    adjustment,
  };
}

module.exports = {
  applyPackageFinancialMutation,
  validatePackageIdForVehicle,
  packageOptionsForVehicle,
  packageDisplayName,
  PACKAGE_DISPLAY,
  settledCentsOf,
};
