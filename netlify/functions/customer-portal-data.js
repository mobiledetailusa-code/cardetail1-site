// Authenticated customer portal data — bookings, profile, payments (safe fields only).
// Saved-vehicle garage hydration is intentionally omitted from the current release.

const crypto = require('crypto');
const { jsonCors } = require('../lib/tech-security');
const { listRawBookings } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { authorizeBookingAccess } = require('../lib/booking-customer-auth');
const { validateCustomerSession } = require('../lib/customer-session');
const { phonesMatch, normalizeUsPhoneDigits } = require('../lib/phone-auth');
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

/** Durable account link written to the booking aggregate at token exchange. */
function blobAccountIdOf(b) {
  const id = String((b && b.customerAccountId) || '').trim();
  return id || null;
}

function emailHashOf(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('base64url');
}

/**
 * Legacy discovery only: normalized verified contact match used to surface
 * bookings that predate account linkage. Never the primary authorization model.
 */
function contactMatchesSession(booking, session) {
  const bookingPhone = normalizeUsPhoneDigits(booking.phone || booking.customerPhone || '');
  if (session.phoneDigits && bookingPhone && phonesMatch(session.phoneDigits, bookingPhone)) {
    return true;
  }
  const bookingEmailHash = emailHashOf(booking.email);
  return !!(session.emailHash && bookingEmailHash && session.emailHash === bookingEmailHash);
}

function upcomingSortKey(b) {
  const date = String(b.preferredDate || b.confirmedDate || '');
  const updated = String(b.updatedAt || b.createdAt || '');
  return `${date}|${updated}|${b.id || ''}`;
}

// Paid invoice is NOT terminal for the appointment hub — customer must still see the job.
const TERMINAL_STATUSES = new Set(['Cancelled', 'Canceled', 'Completed']);
const TERMINAL_JOB_STATUSES = new Set(['cancelled', 'completed_paid', 'archived_test']);
const ACTIONABLE_JOB_STATUSES = new Set([
  'in_progress',
  'en_route',
  'on_site',
  'awaiting_customer_action',
  'completed_pending_payment',
  'completed_pending_admin_review',
]);

function appointmentDate(b) {
  return String(b.confirmedDate || b.preferredDate || '');
}

function isActionableAppointment(b) {
  if (ACTIONABLE_JOB_STATUSES.has(String(b.jobStatus || '').toLowerCase())) return true;
  if (String(b.serviceStatus || '').toLowerCase() === 'awaiting_customer_action') return true;
  return b.customerApprovalStatus === 'pending';
}

/**
 * A job awaiting customer payment or approval projects as "Completed" but is
 * still live work, so actionable state is evaluated first.
 */
function isTerminalAppointment(b) {
  if (isActionableAppointment(b)) return false;
  return TERMINAL_STATUSES.has(String(b.status || ''))
    || TERMINAL_JOB_STATUSES.has(String(b.jobStatus || '').toLowerCase());
}

function todayIsoDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Newest first when dates tie, so a freshly created booking is never buried. */
function byDateAscending(a, b) {
  const cmp = appointmentDate(a).localeCompare(appointmentDate(b));
  if (cmp !== 0) return cmp;
  return upcomingSortKey(b).localeCompare(upcomingSortKey(a));
}

function byDateDescending(a, b) {
  const cmp = appointmentDate(b).localeCompare(appointmentDate(a));
  if (cmp !== 0) return cmp;
  return upcomingSortKey(b).localeCompare(upcomingSortKey(a));
}

/**
 * Deterministic current-appointment selection.
 *
 * 1. actionable/current appointment
 * 2. nearest upcoming pending-review or confirmed appointment
 * 3. most recent non-terminal appointment already in the past
 * 4. most recently completed/cancelled appointment
 *
 * Selection never removes an appointment from the returned collection.
 */
function selectUpcoming(projected, { now = Date.now() } = {}) {
  if (!Array.isArray(projected) || !projected.length) return null;
  const today = todayIsoDate(now);

  const actionable = projected.filter(isActionableAppointment).sort(byDateAscending);
  if (actionable.length) return actionable[0];

  const active = projected.filter((b) => !isTerminalAppointment(b));

  const future = active
    .filter((b) => !appointmentDate(b) || appointmentDate(b) >= today)
    .sort(byDateAscending);
  if (future.length) return future[0];

  const past = active.sort(byDateDescending);
  if (past.length) return past[0];

  return [...projected].sort(byDateDescending)[0] || null;
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

  // Candidate ids from Blob account link / session / phone before ownership filter.
  const contactMatchedIds = [];
  for (const b of all) {
    if (!isVisibleCustomerBooking(b)) continue;
    const bid = normalizeBookingId(b.id || b.bookingId);
    if (!bid) continue;
    if (
      sessionBookingIds.has(bid)
      || linkedAccountBookingIds.has(bid)
      || blobAccountIdOf(b)
    ) {
      contactMatchedIds.push(bid);
      continue;
    }
    if (contactMatchesSession(b, session)) contactMatchedIds.push(bid);
  }

  let bookingOwnerById = new Map();
  try {
    const prisma = tryGetPrisma();
    if (prisma && contactMatchedIds.length) {
      const rows = await prisma.booking.findMany({
        where: {
          id: { in: [...new Set(contactMatchedIds)] },
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

  // Ownership model: the durable customerAccountId link is authoritative.
  // Verified contact matching only discovers older bookings that were never
  // linked to any account.
  const bookings = all.filter((b) => {
    if (!isVisibleCustomerBooking(b)) return false;
    const bid = normalizeBookingId(b.id || b.bookingId);
    if (!bid) return false;

    const ownerAccountId = bookingOwnerById.get(bid) || blobAccountIdOf(b);
    if (ownerAccountId) {
      if (session.customerAccountId) return ownerAccountId === session.customerAccountId;
      // Sessions without an account id may only see their own snapshot ids.
      return sessionBookingIds.has(bid);
    }

    if (linkedAccountBookingIds.has(bid)) return true;
    if (sessionBookingIds.has(bid)) return true;
    return contactMatchesSession(b, session);
  });

  const projected = bookings
    .map((b) => projectBookingForCustomer(b))
    .sort((a, b) => upcomingSortKey(a).localeCompare(upcomingSortKey(b)));

  // Opaque appointment focus — resolve server-side under authenticated ownership only.
  // Never accept raw booking IDs / phones / emails as the focus parameter.
  let focused = null;
  let focusError = null;
  const focusRef = String(body.appointment || body.appointmentFocus || '').trim();
  if (focusRef) {
    const { FOCUS_PREFIX, resolveFocusRef } = require('../lib/appointment-access-token');
    if (!focusRef.startsWith(FOCUS_PREFIX)) {
      focusError = 'invalid_focus';
    } else {
      let targetBookingId = null;
      const resolved = await resolveFocusRef(focusRef);
      if (resolved && resolved.bookingId) {
        targetBookingId = normalizeBookingId(resolved.bookingId);
        if (
          resolved.customerAccountId
          && session.customerAccountId
          && resolved.customerAccountId !== session.customerAccountId
        ) {
          targetBookingId = null;
          focusError = 'invalid_focus';
        }
      }
      if (!targetBookingId) {
        const byRef = bookings.find((b) => String(b.appointmentPublicRef || '') === focusRef);
        if (byRef) targetBookingId = normalizeBookingId(byRef.id || byRef.bookingId);
      }
      if (targetBookingId) {
        focused = projected.find((b) => normalizeBookingId(b.id) === targetBookingId) || null;
        if (!focused) focusError = 'invalid_focus';
      } else if (!focusError) {
        focusError = 'invalid_focus';
      }
    }
  }

  const upcoming = focused || selectUpcoming(projected);
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
    } catch {
      customer = null;
    }
  }

  return jsonCors(200, {
    ok: true,
    scope: 'account',
    customerAccountId: session.customerAccountId || null,
    customer,
    bookings: projected,
    upcoming,
    focusedAppointment: focused
      ? {
        appointmentPublicRef: focused.appointmentPublicRef || focusRef,
        customerStatus: focused.customerStatus || focused.status || null,
      }
      : null,
    focusError,
    payment,
    catalog,
    packageCatalog,
    packageCatalogByVehicle: packageCatalog.packageCatalogByVehicle,
    changeRequests,
    sections: {
      appointments: projected.length > 0,
      history: projected.some((b) => ['Paid', 'Completed'].includes(b.status)),
      maintenancePlans: projected.some((b) => b.maintenanceRequested || b.maintenancePeriod),
      payments: !!(payment.canPay || payment.payLink || projected.some((b) => Number(b.amountDueApproved || 0) > 0)),
      communicationPreferences: false,
    },
  });
};
