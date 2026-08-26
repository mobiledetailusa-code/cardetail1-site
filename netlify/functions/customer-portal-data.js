// Authenticated customer portal data — bookings, profile, payments (safe fields only).
// Saved-vehicle garage hydration is intentionally omitted from the current release.

const crypto = require('crypto');
const { jsonCors } = require('../lib/tech-security');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { authorizeBookingAccess } = require('../lib/booking-customer-auth');
const { validateCustomerSession } = require('../lib/customer-session');
const { phonesMatch, normalizeUsPhoneDigits } = require('../lib/phone-auth');
const { listVisibleRequestsForBooking } = require('../lib/customer-change-requests');
const { canPayBalance } = require('../lib/appointment-status-policy');
const { catalogForClient } = require('../lib/customer-catalog');
const { serializeCanonicalAddonCatalog } = require('../lib/canonical-addon-catalog');
const { serializeCanonicalPackageCatalogForBooking } = require('../lib/canonical-package-catalog');
const { enforcePublicRateLimit, hashRateLimitSubject } = require('../lib/public-rate-limit');
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
const { postServiceState } = require('../lib/post-service-experience');
const { adjustmentStatement } = require('../lib/price-adjustments');
const { buildSyncEnvelope, syncHeaders } = require('../lib/sync-response');

function syncJson(payload, ifSyncVersion) {
  const envelope = buildSyncEnvelope(payload, { ifSyncVersion });
  return jsonCors(200, envelope.body, syncHeaders(envelope.syncVersion));
}

async function enforcePortalSyncLimit(event, subject) {
  return enforcePublicRateLimit(event, {
    endpoint: 'customer-portal-sync',
    cors: true,
    subject: hashRateLimitSubject('portal-sync', subject),
  });
}

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
  // Postgres is the money authority the payment endpoint validates against.
  // When it is enabled but unreachable, the Blob mirror's quoteVersion is not
  // that authority — offering it as payable produces a permanent 409, so the
  // balance is reported as temporarily unpayable instead.
  const degraded = authority === 'blob_degraded';
  const canPay = !!(payAllowed.ok && money.paymentStatus !== 'paid' && money.remainingCents > 0 && !degraded);
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
    pendingRefundCents: money.pendingRefundCents || 0,
    refundRequestStatus: money.refundRequestStatus || null,
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
    paymentAuthorityDegraded: degraded,
    authority: degraded ? 'blob' : authority,
    stripeCheckoutSessionIdPrefix: money.stripeCheckoutSessionIdPrefix || null,
    paymentIntentIdPrefix: piRef && String(piRef).startsWith('pi_') ? String(piRef).slice(0, 12) : (money.paymentIntentIdPrefix || null),
  };
}

function safePaymentState(booking, { degraded = false } = {}) {
  const money = financialProjection(booking);
  return safePaymentStateFromProjection(booking, money, degraded ? 'blob_degraded' : 'blob');
}

async function safePaymentStateAsync(booking) {
  let degraded = false;
  try {
    if (postgresPaymentEnabled()) {
      const shared = await getSharedFinancialProjection(booking, { reconcileUncertain: false });
      if (shared.ok && shared.projection) {
        return safePaymentStateFromProjection(booking, shared.projection, 'postgres');
      }
      // Blob quoteVersion is a mirror, not the authority the PaymentIntent
      // endpoint checks — do not present it as a payable quote.
      degraded = true;
    }
  } catch (e) {
    degraded = postgresPaymentEnabled();
    console.warn('[customer-portal-data] payment_projection_fallback', {
      bookingIdPrefix: String(booking?.id || booking?.bookingId || '').slice(0, 12),
      error: String(e && e.message || e).slice(0, 160),
    });
  }
  return safePaymentState(booking, { degraded });
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

/**
 * Bookings this session could own, without hydrating the whole store:
 * verified-contact matches (phone / session email hash) unioned with the ids
 * the session and its CustomerAccount already reference. Deduplicated by id.
 */
async function buildCandidateBookings(session, sessionBookingIds, linkedAccountBookingIds) {
  const { listBookingsForIdentity } = require('../lib/booking-history');
  const { getBookingsByIds } = require('../lib/ops-db');

  const byId = new Map();
  const add = (booking) => {
    const bid = normalizeBookingId(booking && (booking.id || booking.bookingId));
    if (bid && !byId.has(bid)) byId.set(bid, booking);
  };

  const contact = await listBookingsForIdentity({
    phone: session.phoneDigits,
    emailHash: session.emailHash,
  }).catch(() => ({ bookings: [] }));
  for (const booking of contact.bookings || []) add(booking);

  const ids = [...new Set([...sessionBookingIds, ...linkedAccountBookingIds])]
    .filter((id) => !byId.has(id));
  if (ids.length) {
    const resolved = await getBookingsByIds(ids).catch(() => new Map());
    for (const booking of resolved.values()) if (booking) add(booking);
  }

  return [...byId.values()];
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

/** Open balance / payment pending — prefer as hero over an older settled-paid Confirmed. */
function hasOpenPayableBalance(b) {
  const remaining = Number(b.remainingCents != null ? b.remainingCents : Math.round(Number(b.amountDueApproved || 0) * 100));
  if (Number.isFinite(remaining) && remaining > 0) return true;
  const pwf = String(b.paymentWorkflowStatus || '').toLowerCase();
  return pwf === 'due' || pwf === 'awaiting_customer_payment' || pwf === 'pending_webhook';
}

/**
 * Settled paid invoice stays in the list but must not steal the hero from a
 * sibling that still needs payment or action.
 */
function isSettledPaidHero(b) {
  if (isActionableAppointment(b)) return false;
  if (hasOpenPayableBalance(b)) return false;
  const pwf = String(b.paymentWorkflowStatus || '').toLowerCase();
  if (pwf === 'payment_succeeded' || pwf === 'cash_paid' || pwf === 'paid') return true;
  const remaining = Number(b.remainingCents != null ? b.remainingCents : Math.round(Number(b.amountDueApproved || 0) * 100));
  const settled = Number(b.settledCents != null ? b.settledCents : Math.round(Number(b.amountPaid || 0) * 100));
  return Number.isFinite(remaining) && remaining <= 0 && settled > 0;
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
 * 2. nearest upcoming appointment with an open balance
 * 3. nearest upcoming non-settled appointment
 * 4. most recent past appointment with an open balance
 * 5. most recent non-terminal past appointment
 * 6. settled-paid only when nothing else competes
 * 7. most recently completed/cancelled appointment
 *
 * The date horizon outranks the balance: an open balance decides between
 * siblings on the same side of today, but a years-old unpaid invoice never
 * displaces the customer's next appointment.
 *
 * Selection never removes an appointment from the returned collection.
 */
function selectUpcoming(projected, { now = Date.now() } = {}) {
  if (!Array.isArray(projected) || !projected.length) return null;
  const today = todayIsoDate(now);

  const actionable = projected.filter(isActionableAppointment).sort(byDateAscending);
  if (actionable.length) return actionable[0];

  const active = projected.filter((b) => !isTerminalAppointment(b));
  const isUpcoming = (b) => !appointmentDate(b) || appointmentDate(b) >= today;

  const ranked = [
    active.filter((b) => isUpcoming(b) && hasOpenPayableBalance(b)).sort(byDateAscending),
    active.filter((b) => isUpcoming(b) && !isSettledPaidHero(b)).sort(byDateAscending),
    active.filter((b) => !isUpcoming(b) && hasOpenPayableBalance(b)).sort(byDateDescending),
    active.filter((b) => !isUpcoming(b) && !isSettledPaidHero(b)).sort(byDateDescending),
    active.filter(isSettledPaidHero).sort(byDateDescending),
  ];
  for (const bucket of ranked) {
    if (bucket.length) return bucket[0];
  }

  return [...projected].sort(byDateDescending)[0] || null;
}

/** Test / inspect seam — production traffic uses exports.handler only. */
exports.portalCatalogForClient = portalCatalogForClient;
exports.serializeCanonicalPackageCatalogForBooking = serializeCanonicalPackageCatalogForBooking;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error' }); }

  try {
    return await handlePortalData(event, body);
  } catch (e) {
    console.warn('[customer-portal-data] unhandled', {
      error: String(e && e.message || e).slice(0, 200),
    });
    return jsonCors(503, {
      ok: false,
      error: 'service_unavailable',
      message: 'Your account is temporarily unavailable. Please try again.',
    });
  }
};

async function handlePortalData(event, body) {
  const mode = String(body.mode || 'limited').toLowerCase();
  const catalog = portalCatalogForClient();

  if (mode === 'limited') {
    const auth = await authorizeBookingAccess(event, {
      bookingId: body.bookingId,
      phone: body.phone || body.customerPhone,
    });
    if (!auth.ok) {
      // Failed credential guesses use the strict lookup bucket. Successfully
      // authorized refreshes use a separate, subject-scoped read bucket below.
      const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'lookup-booking', cors: true });
      if (rateLimit.blocked) return rateLimit.response;
      return jsonCors(auth.statusCode || 200, {
        ok: false,
        error: auth.error || 'authentication_failed',
        message: auth.message,
      });
    }
    const syncLimit = await enforcePortalSyncLimit(
      event,
      `booking:${normalizeBookingId(auth.booking.id || auth.booking.bookingId)}`
    );
    if (syncLimit.blocked) return syncLimit.response;
    if (!isVisibleCustomerBooking(auth.booking)) {
      const draftLike = auth.booking && (
        auth.booking.isDraft === true
        || String(auth.booking.kind || '').toLowerCase() === 'draft'
      );
      return jsonCors(200, {
        ok: false,
        error: 'booking_not_ready',
        message: draftLike
          ? 'This booking is still being finalized. Complete checkout first, or call/text 551-373-5668.'
          : 'This booking is not available in My Garage yet. If Admin just created it, ask them to Confirm booking, or call/text 551-373-5668.',
      });
    }
    const projected = projectBookingForCustomer(auth.booking);
    const payment = await safePaymentStateAsync(auth.booking);
    const packageCatalog = serializeCanonicalPackageCatalogForBooking(auth.booking);
    return syncJson({
      ok: true,
      scope: 'booking',
      booking: projected,
      payment,
      catalog,
      packageCatalog,
      packageCatalogByVehicle: packageCatalog.packageCatalogByVehicle,
      changeRequests: await listVisibleRequestsForBooking(auth.booking),
      // Server-decided review / issue-window availability. My Garage renders the
      // actions from this and never computes the 48-hour deadline itself.
      postService: postServiceState(auth.booking),
      priceAdjustments: adjustmentStatement(auth.booking),
    }, body.ifSyncVersion);
  }

  const session = await validateCustomerSession(event);
  if (!session.ok) {
    const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'lookup-booking', cors: true });
    if (rateLimit.blocked) return rateLimit.response;
    return jsonCors(401, { ok: false, error: 'authentication_failed', message: 'Sign in required.' });
  }
  const syncLimit = await enforcePortalSyncLimit(event, `session:${session.sessionId}`);
  if (syncLimit.blocked) return syncLimit.response;

  // Ignore any caller-supplied account id — session is authoritative.
  void body.customerAccountId;
  void body.browserCustomerAccountId;

  const sessionBookingIds = new Set(
    (session.bookingIds || []).map((id) => normalizeBookingId(id)).filter(Boolean)
  );

  // Dual-read order:
  // 1) relational CustomerAccount / Booking.customerAccountId
  // 2) session bookingIds
  // 3) Blob phone/email scan fallback
  // A partially resolved ownership set still answers 200/ok. The client must be
  // able to tell that apart from a real removal, or a transient Postgres outage
  // silently deletes the customer's history from the rendered portal.
  let ownershipComplete = true;
  let linkedAccountBookingIds = new Set();
  if (session.customerAccountId) {
    try {
      const ids = await listBookingIdsForAccount(session.customerAccountId);
      linkedAccountBookingIds = new Set(ids.map((id) => normalizeBookingId(id)).filter(Boolean));
    } catch {
      ownershipComplete = false;
      linkedAccountBookingIds = new Set();
    }
  }

  // Candidate set, scoped instead of scanning cd1-bookings: everything this
  // session could possibly own is reachable by verified contact (phone or the
  // session's email hash) or by an id it already carries. The ownership filter
  // below is unchanged, so a narrower candidate set can never widen access.
  const all = await buildCandidateBookings(session, sessionBookingIds, linkedAccountBookingIds);

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
    ownershipComplete = false;
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

  return syncJson({
    ok: true,
    scope: 'account',
    customerAccountId: session.customerAccountId || null,
    customer,
    bookings: projected,
    // False when an ownership source failed: the collection may be short, so the
    // client must merge it into its cache instead of replacing it.
    bookingsComplete: ownershipComplete,
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
    postService: rawUpcoming ? postServiceState(rawUpcoming) : null,
    priceAdjustments: rawUpcoming ? adjustmentStatement(rawUpcoming) : null,
    // Every owned booking carries its own window state so a completed job further
    // down the list still shows the right action after a refresh.
    postServiceByBooking: Object.fromEntries(
      bookings
        .map((b) => [String(b.id || b.bookingId || ''), postServiceState(b)])
        .filter(([id]) => !!id)
    ),
    sections: {
      appointments: projected.length > 0,
      history: projected.some((b) => ['Paid', 'Completed'].includes(b.status)),
      maintenancePlans: projected.some((b) => b.maintenanceRequested || b.maintenancePeriod),
      payments: !!(payment.canPay || payment.payLink || projected.some((b) => Number(b.amountDueApproved || 0) > 0)),
      communicationPreferences: false,
    },
  }, body.ifSyncVersion);
}

exports.syncJson = syncJson;
exports.__test = {
  safePaymentStateAsync,
  safePaymentState,
  safePaymentStateFromProjection,
  handlePortalData,
  selectUpcoming,
  hasOpenPayableBalance,
  isSettledPaidHero,
  isTerminalAppointment,
  isActionableAppointment,
};
