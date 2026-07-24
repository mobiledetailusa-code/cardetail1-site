// Authenticated customer portal data — bookings, vehicles, payments (safe fields only).

const { jsonCors } = require('../lib/tech-security');
const { listRawBookings } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { authorizeBookingAccess } = require('../lib/booking-customer-auth');
const { validateCustomerSession } = require('../lib/customer-session');
const { phonesMatch, normalizeUsPhoneDigits } = require('../lib/phone-auth');
const { listVehicles } = require('../lib/customer-vehicle-service');
const { listVisibleRequestsForBooking } = require('../lib/customer-change-requests');
const { canPayBalance } = require('../lib/appointment-status-policy');
const { catalogForClient } = require('../lib/customer-catalog');
const { serializeCanonicalAddonCatalog } = require('../lib/canonical-addon-catalog');
const { serializeCanonicalPackageCatalogForBooking } = require('../lib/canonical-package-catalog');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
const { financialProjection } = require('../lib/payment-service');
const {
  postgresPaymentEnabled,
  getSharedFinancialProjection,
} = require('../lib/db/operational-payment');
const {
  listBookingIdsForAccount,
} = require('../lib/customer-account-service');
const {
  buildCustomerProjection,
  assertSafeCustomerProjection,
} = require('../lib/customer-identity-projection');
const { tryGetPrisma } = require('../lib/prisma');
const { normalizeBookingId } = require('../lib/booking-customer-auth');

/**
 * Portal catalog: subscription/marketing packages remain in customer-catalog;
 * live package quotes for Change Package come from booking-scoped packageCatalog
 * (booking-price-catalog via Stage 1 helpers). Add-ons are always canonical.
 */
function portalCatalogForClient() {
  const base = catalogForClient();
  const canonical = serializeCanonicalAddonCatalog();
  return {
    ...base,
    // Replace independently priced customer-catalog ADDONS — never authoritative.
    addons: canonical.addons,
    addonsByCategory: canonical.addonsByCategory,
    addonCatalogSource: canonical.source,
  };
}

function safePaymentStateFromProjection(booking, money, authority) {
  const due = money.remainingCents / 100;
  const payAllowed = canPayBalance(booking);
  const canPay = !!(payAllowed.ok && money.paymentStatus !== 'paid' && money.remainingCents > 0);
  const piRef = money.stripeReference || money.paymentIntentIdPrefix || null;
  return {
    state: money.paymentStatus,
    amountDueApproved: due,
    approvedTotal: money.approvedCents / 100,
    amountPaid: money.settledCents / 100,
    remainingCents: money.remainingCents,
    approvedCents: money.approvedCents,
    settledCents: money.settledCents,
    refundedCents: money.refundedCents || 0,
    paymentStatus: money.paymentStatus,
    paymentAttemptStatus: money.paymentAttemptStatus || null,
    stripeReference: money.stripeReference || null,
    paidAt: money.paidAt || null,
    bookingVersion: booking.bookingVersion || 0,
    quoteVersion: money.quoteVersion != null ? money.quoteVersion : (booking.quoteVersion || 0),
    payLink: money.paymentStatus === 'paid' ? '' : (booking.payLink || ''),
    payLinkAmount: booking.payLinkAmount != null ? Number(booking.payLinkAmount) : null,
    canPay,
    canCreatePayLink: canPay,
    embeddedPayAvailable: authority === 'postgres' && canPay,
    authority,
    stripeCheckoutSessionIdPrefix: money.stripeCheckoutSessionIdPrefix || null,
    paymentIntentIdPrefix: piRef && String(piRef).startsWith('pi_') ? String(piRef).slice(0, 12) : (money.paymentIntentIdPrefix || null),
  };
}

function safePaymentState(booking) {
  const money = financialProjection(booking);
  return safePaymentStateFromProjection(booking, money, 'blob');
}

async function safePaymentStateAsync(booking) {
  if (postgresPaymentEnabled()) {
    const shared = await getSharedFinancialProjection(booking, { reconcileUncertain: true });
    if (shared.ok && shared.projection) {
      return safePaymentStateFromProjection(booking, shared.projection, 'postgres');
    }
  }
  return safePaymentState(booking);
}

function isVisibleCustomerBooking(b) {
  return isVisibleSubmittedBooking(b, { includeArchivedTest: false });
}

function upcomingSortKey(b) {
  const date = String(b.preferredDate || b.confirmedDate || '');
  const updated = String(b.updatedAt || b.createdAt || '');
  return `${date}|${updated}|${b.id || ''}`;
}

function selectUpcoming(projected) {
  // Paid invoice is NOT terminal for the appointment hub — customer must still see the job.
  const terminalStatus = new Set(['Cancelled', 'Canceled', 'Completed']);
  const terminalJob = new Set(['cancelled', 'completed_paid', 'archived_test']);
  const active = projected
    .filter((b) => !terminalStatus.has(String(b.status || '')))
    .filter((b) => !terminalJob.has(String(b.jobStatus || '').toLowerCase()))
    .sort((a, b) => upcomingSortKey(a).localeCompare(upcomingSortKey(b)));
  return active[0] || projected[0] || null;
}

/** Test / inspect seam — production traffic uses exports.handler only. */
exports.portalCatalogForClient = portalCatalogForClient;
exports.serializeCanonicalPackageCatalogForBooking = serializeCanonicalPackageCatalogForBooking;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'lookup-booking', cors: true });
  if (rateLimit.blocked) return rateLimit.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error' }); }

  const mode = String(body.mode || 'limited').toLowerCase();
  const catalog = portalCatalogForClient();

  if (mode === 'limited') {
    const auth = await authorizeBookingAccess(event, {
      bookingId: body.bookingId,
      phone: body.phone || body.customerPhone,
    });
    if (!auth.ok) {
      return jsonCors(auth.statusCode || 200, {
        ok: false,
        error: auth.error || 'authentication_failed',
        message: auth.message,
      });
    }
    if (!isVisibleCustomerBooking(auth.booking)) {
      const draftLike = auth.booking && (
        auth.booking.isDraft === true
        || String(auth.booking.kind || '').toLowerCase() === 'draft'
      );
      return jsonCors(200, {
        ok: false,
        error: 'booking_not_ready',
        message: draftLike
          ? 'This booking is still being finalized. Complete checkout first, or call/text 551-313-2956.'
          : 'This booking is not available in My Garage yet. If Admin just created it, ask them to Confirm booking, or call/text 551-313-2956.',
      });
    }
    const projected = projectBookingForCustomer(auth.booking);
    const payment = await safePaymentStateAsync(auth.booking);
    const packageCatalog = serializeCanonicalPackageCatalogForBooking(auth.booking);
    return jsonCors(200, {
      ok: true,
      scope: 'booking',
      booking: projected,
      payment,
      catalog,
      packageCatalog,
      packageCatalogByVehicle: packageCatalog.packageCatalogByVehicle,
      changeRequests: await listVisibleRequestsForBooking(auth.booking),
    });
  }

  const session = await validateCustomerSession(event);
  if (!session.ok) {
    return jsonCors(401, { ok: false, error: 'authentication_failed', message: 'Sign in required.' });
  }

  // Ignore any caller-supplied account id — session is authoritative.
  void body.customerAccountId;
  void body.browserCustomerAccountId;

  const all = await listRawBookings();
  const phoneDigits = session.phoneDigits;
  const sessionBookingIds = new Set(
    (session.bookingIds || []).map((id) => normalizeBookingId(id)).filter(Boolean)
  );

  // Dual-read order:
  // 1) relational CustomerAccount / Booking.customerAccountId
  // 2) session bookingIds
  // 3) Blob phone/email scan fallback
  let linkedAccountBookingIds = new Set();
  if (session.customerAccountId) {
    try {
      const ids = await listBookingIdsForAccount(session.customerAccountId);
      linkedAccountBookingIds = new Set(ids.map((id) => normalizeBookingId(id)).filter(Boolean));
    } catch {
      linkedAccountBookingIds = new Set();
    }
  }

  // Candidate ids from Blob phone/session before ownership filter.
  const phoneMatchedIds = [];
  for (const b of all) {
    if (!isVisibleCustomerBooking(b)) continue;
    const bid = normalizeBookingId(b.id || b.bookingId);
    if (!bid) continue;
    if (sessionBookingIds.has(bid) || linkedAccountBookingIds.has(bid)) {
      phoneMatchedIds.push(bid);
      continue;
    }
    const bPhone = normalizeUsPhoneDigits(b.phone || b.customerPhone || '');
    if (phoneDigits && bPhone && phonesMatch(phoneDigits, bPhone)) phoneMatchedIds.push(bid);
  }

  let bookingOwnerById = new Map();
  try {
    const prisma = tryGetPrisma();
    if (prisma && phoneMatchedIds.length) {
      const rows = await prisma.booking.findMany({
        where: {
          id: { in: [...new Set(phoneMatchedIds)] },
          customerAccountId: { not: null },
        },
        select: { id: true, customerAccountId: true },
      });
      bookingOwnerById = new Map(
        rows.map((r) => [normalizeBookingId(r.id), r.customerAccountId])
      );
    }
  } catch {
    bookingOwnerById = new Map();
  }

  const bookings = all.filter((b) => {
    if (!isVisibleCustomerBooking(b)) return false;
    const bid = normalizeBookingId(b.id || b.bookingId);
    if (!bid) return false;

    const ownerAccountId = bookingOwnerById.get(bid) || null;
    // No account may access another account's booking.
    if (ownerAccountId && session.customerAccountId && ownerAccountId !== session.customerAccountId) {
      return false;
    }

    if (linkedAccountBookingIds.has(bid)) return true;
    if (sessionBookingIds.has(bid)) {
      // Session snapshot may still show legacy bookings; block if owned by another account.
      if (ownerAccountId && session.customerAccountId && ownerAccountId !== session.customerAccountId) {
        return false;
      }
      return true;
    }

    const bPhone = normalizeUsPhoneDigits(b.phone || b.customerPhone || '');
    if (!(phoneDigits && bPhone && phonesMatch(phoneDigits, bPhone))) return false;
    if (ownerAccountId && session.customerAccountId && ownerAccountId !== session.customerAccountId) {
      return false;
    }
    return true;
  });

  const projected = bookings
    .map((b) => projectBookingForCustomer(b))
    .sort((a, b) => upcomingSortKey(a).localeCompare(upcomingSortKey(b)));
  let vehicles = [];
  let vehiclesError = null;
  let accountVersion = null;
  if (session.customerAccountId) {
    try {
      const vehicleList = await listVehicles(session.customerAccountId, {
        phoneDigits: phoneDigits || null,
      });
      if (vehicleList.ok) {
        vehicles = vehicleList.vehicles || [];
        if (vehicleList.accountVersion != null) accountVersion = vehicleList.accountVersion;
      } else {
        // Do not substitute an empty garage for dependency/schema failures.
        vehiclesError = vehicleList.error === 'temporarily_unavailable'
          || vehicleList.error === 'unavailable'
          || vehicleList.error === 'schema_unavailable'
          ? (vehicleList.error === 'schema_unavailable' ? 'server_error' : 'temporarily_unavailable')
          : (vehicleList.error || 'temporarily_unavailable');
        vehicles = [];
        if (vehicleList.accountVersion != null) accountVersion = vehicleList.accountVersion;
      }
    } catch (err) {
      vehicles = [];
      vehiclesError = 'temporarily_unavailable';
      console.error(JSON.stringify({
        scope: 'customer_portal_data',
        error: 'vehicle_list_exception',
        causeCode: String(err && err.code || 'exception').slice(0, 32),
      }));
    }
  }
  const upcoming = selectUpcoming(projected);
  const payment = upcoming
    ? await safePaymentStateAsync(bookings.find((b) => (b.id || b.bookingId) === upcoming.id) || {})
    : { state: 'not_due', amountDueApproved: 0, canPay: false, payLink: '', authority: 'none' };

  let changeRequests = [];
  let rawUpcoming = null;
  if (upcoming?.id) {
    rawUpcoming = bookings.find((b) => (b.id || b.bookingId) === upcoming.id) || null;
    try {
      changeRequests = await listVisibleRequestsForBooking(rawUpcoming || upcoming);
    } catch { changeRequests = []; }
  }

  const packageCatalog = rawUpcoming
    ? serializeCanonicalPackageCatalogForBooking(rawUpcoming)
    : { source: 'booking-price-catalog', vehicles: [], packageCatalogByVehicle: {} };

  let customer = null;
  if (session.customerAccountId) {
    try {
      customer = assertSafeCustomerProjection(
        await buildCustomerProjection(session.customerAccountId, {
          linkedBookingCount: linkedAccountBookingIds.size || bookings.length,
        })
      );
      if (customer && customer.accountVersion != null) accountVersion = customer.accountVersion;
    } catch {
      customer = null;
    }
  }

  // Optimistic concurrency token for garage mutations — always expose when session has an account,
  // even if the richer customer projection failed.
  if (accountVersion == null && session.customerAccountId) {
    try {
      const prisma = tryGetPrisma();
      if (prisma) {
        const row = await prisma.customerAccount.findUnique({
          where: { id: String(session.customerAccountId) },
          select: { version: true },
        });
        if (row && row.version != null) accountVersion = row.version;
      }
    } catch {
      /* leave null — client will ask the user to refresh */
    }
  }

  return jsonCors(200, {
    ok: true,
    scope: 'account',
    customerAccountId: session.customerAccountId || null,
    accountVersion,
    customer,
    bookings: projected,
    upcoming,
    vehicles,
    vehiclesError,
    payment,
    catalog,
    packageCatalog,
    packageCatalogByVehicle: packageCatalog.packageCatalogByVehicle,
    changeRequests,
    sections: {
      appointments: projected.length > 0,
      vehicles: vehicles.length > 0,
      history: projected.some((b) => ['Paid', 'Completed'].includes(b.status)),
      maintenancePlans: projected.some((b) => b.maintenanceRequested || b.maintenancePeriod),
      payments: !!(payment.canPay || payment.payLink || projected.some((b) => Number(b.amountDueApproved || 0) > 0)),
      communicationPreferences: false,
    },
  });
};
