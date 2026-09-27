// netlify/functions/submit-booking.js
// Accepts a booking, assigns a server-side ID, stores to Netlify Blobs,
// notifies admin, and optionally sends customer confirmation.
//
// Security model:
//   C-1: paymentStatus can only be set by stripe-webhook.js (HMAC-verified).
//        This endpoint never trusts client-submitted payment state.
//   C-3: Booking ID is always generated server-side. Client-submitted id/bookingId
//        are ignored. Collision-checked against Blobs before writing.
//   Draft mode: the booking flow pre-registers a minimal booking to issue a
//        signed save token and server-owned ID. Saved-card flows may then create
//        a SetupIntent; initial no-card requests finalize without Stripe.
//   Finalization: submitBooking() passes draftBookingId to merge full details into
//        an existing draft, preserving webhook-set payment fields.
//
// Canonical paymentStatus enum:
//   no_payment_required_yet | authorization_pending | authorized |
//   authorization_failed | capture_pending | paid | canceled |
//   refunded | expired
//
// This endpoint never dispatches or creates an auction.

// Fields that must never come from the browser.
// Payment state is owned exclusively by stripe-webhook.js (HMAC-verified).
// Admin/assignment state is owned by admin-authenticated endpoints.
const CLIENT_BLOCKED_FIELDS = [
  'paymentStatus', 'paymentIntentId', 'amountAuthorizedCents', 'amountCapturedCents',
  'capturedAt', 'captureInitiatedAt', 'stripeCustomerId', 'paymentMethodId',
  'stripePaymentMethodId', 'setupIntentId', 'cardOnFileSavedAt',
  // cardOnFileStatus is set exclusively by stripe-webhook (setup_intent.succeeded).
  'cardOnFileStatus', 'cardSavedAt',
  'status', 'appointmentStatus', 'jobStatus', 'adminNotes', 'assignedTech',
  'assignedTechName', 'confirmedDate', 'confirmedTimeWindow',
  'adminReviewed', 'archived',
  // The browser supplies only a strict boolean choice. Evidence metadata is
  // authored by the server at finalization and cannot be backdated/spoofed.
  'transactionalSmsConsent', 'transactionalSmsConsentTextVersion',
  'acceptedTransactionalSmsConsentAt', 'transactionalSmsConsentSource',
  'marketingSmsConsentAccepted',
  'finalizedAt', 'occupancyStatus', 'occupancyPendingAt', 'notificationsClaimedAt',
];

const PAYMENT_PREFERENCES = new Set([
  'cash_onsite',
  'card_onsite',
  'online_after_service',
]);

const CARD_ON_FILE_VERIFY_MSG =
  'Your card is still being verified. Please wait a few seconds and try again.';

function normalizeRequestPreference(value) {
  const preference = String(value || '').trim();
  if (!preference) return '';
  return PAYMENT_PREFERENCES.has(preference) ? preference : null;
}

/** Pay online later always requires card-on-file; onsite preferences never do. */
function resolveCardOnFileRequired(preference, requestedFlag) {
  const pref = normalizeRequestPreference(preference) || String(preference || '').trim();
  if (pref === 'online_after_service') return true;
  if (pref === 'cash_onsite' || pref === 'card_onsite') return false;
  if (requestedFlag === true) return true;
  if (requestedFlag === false) return false;
  return false;
}

const { applyServerTravelAndTotal } = require('../lib/travel-fee');
const {
  enforcePublicRateLimit,
  identifySubmitBookingAction,
} = require('../lib/public-rate-limit');
const {
  issueDraftSaveToken,
  verifyDraftSaveToken,
  getDraftTokenSecretStatus,
} = require('../lib/draft-save-token');
const {
  formatSiteAccessLines,
} = require('../lib/site-access');
const { validateBookingSchedule, hasSlotConflict, isActiveBookingForSlotLock, spannedSlotTimes, planCombinedAppointment, bookingHasInteriorCompanion } = require('../lib/booking-schedule');
const { applyCeramicBooking } = require('../lib/ceramic-coating');
const { listBookingsForSlotLock, normalizePhone } = require('../lib/ops-db');
const { indexedSlotConflict, syncSlotIndex, reserveBookedSpan, bookedSpanReady } = require('../lib/slot-index');
const { TERMS_POLICY_VERSION } = require('../lib/customer-policy');
const { findDuplicateBooking } = require('../lib/booking-history');
const { validateBookingRouting } = require('../lib/booking-routing-validation');
const {
  applyServerOffersToBooking,
  stripClientOfferFields,
  CLIENT_OFFER_BLOCKED_FIELDS,
} = require('../lib/booking-offers');
const { setOfferDeployHost, clearOfferDeployHost } = require('../lib/revenue-offers');
const {
  sendNotificationsDecoupled,
  attachDeliveryToBooking,
  bookingCreatedNotificationsIncomplete,
} = require('../lib/notification-delivery');
// Loaded lazily at the call site: the SMS outbox pulls Prisma and the Twilio
// dependency graph, and a cold-start failure there returns a non-JSON 500 that
// the checkout cannot parse. Notifications must never gate the booking itself.
function smsOutbox() {
  return {
    enqueueSms: require('../lib/sms-outbox').enqueueSms,
    kickSmsOutboxByIds: require('../lib/sms-outbox').kickSmsOutboxByIds,
    TEMPLATE_KEYS: require('../lib/sms-templates').TEMPLATE_KEYS,
  };
}
const { enabled } = require('../lib/twilio-runtime-policy');
const { canonicalBookingSmsConsent } = require('../lib/sms-program');
const {
  reconcileCardOnFileFromStripe,
  siIdPrefix,
} = require('../lib/card-on-file');

const BOOKING_VERIFICATION_UNAVAILABLE = 'booking_verification_unavailable';

/** Default scan budget before returning JSON 503 instead of hanging into HTML 504. */
const DEFAULT_SLOT_SCAN_TIMEOUT_MS = 8000;

function resolveSlotScanTimeoutMs(env = process.env) {
  const raw = env.SLOT_SCAN_TIMEOUT_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SLOT_SCAN_TIMEOUT_MS;
  }
  // Always bound the legacy Blobs fallback — unbounded scans hit Netlify's
  // inactivity ceiling (~30s) and return non-JSON HTML that breaks card-save.
  return DEFAULT_SLOT_SCAN_TIMEOUT_MS;
}

let slotScanTimeoutMs = resolveSlotScanTimeoutMs();

function verificationUnavailable(cause) {
  const err = new Error(BOOKING_VERIFICATION_UNAVAILABLE);
  err.code = BOOKING_VERIFICATION_UNAVAILABLE;
  if (cause) err.cause = cause;
  return err;
}

function isVerificationUnavailable(err) {
  return !!(err && (
    err.code === BOOKING_VERIFICATION_UNAVAILABLE
    || err.message === BOOKING_VERIFICATION_UNAVAILABLE
  ));
}

function withSlotScanTimeout(promise) {
  if (!slotScanTimeoutMs || slotScanTimeoutMs <= 0) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(verificationUnavailable(new Error('timeout')));
    }, slotScanTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function listRequestStoreBlobs(store) {
  if (!store || typeof store.list !== 'function') {
    throw verificationUnavailable();
  }
  try {
    const paged = await store.list({ paginate: true });
    if (paged && typeof paged[Symbol.asyncIterator] === 'function') {
      const blobs = [];
      for await (const page of paged) {
        blobs.push(...((page && page.blobs) || []));
      }
      return blobs;
    }
    if (paged && Array.isArray(paged.blobs)) return paged.blobs;
  } catch (err) {
    // Non-paginated list is the fallback only when paginate is unsupported.
    // A rejected list() is still a failed verification, not an empty store.
  }
  try {
    const listing = await store.list();
    return (listing && listing.blobs) || [];
  } catch (err) {
    throw verificationUnavailable(err);
  }
}

function toSlotLockBookings(records) {
  const { adaptHistoricalBooking } = require('../lib/historical-adapter');
  const out = [];
  for (const raw of records || []) {
    if (!raw) continue;
    const adapted = adaptHistoricalBooking(raw);
    if (!adapted.ok || !adapted.booking) continue;
    if (!isActiveBookingForSlotLock(adapted.booking)) continue;
    out.push(adapted.booking);
  }
  return out;
}

async function loadSlotLockBookings() {
  const store = await blobsStore('cd1-bookings');
  if (store && typeof store.list === 'function') {
    const { fetchBlobRecords } = require('../lib/tech-security');
    const blobs = await withSlotScanTimeout(listRequestStoreBlobs(store));
    const records = await withSlotScanTimeout(fetchBlobRecords(store, blobs));
    return toSlotLockBookings(records);
  }
  // Keep `.catch` on the named scan so checkout wiring still sees the fallback,
  // but never convert failure into "no bookings".
  return withSlotScanTimeout(listBookingsForSlotLock().catch((err) => {
    throw verificationUnavailable(err);
  }));
}

async function enforceScheduleFields(b, { checkSlot = false, excludeId = null, bookedOnly = false } = {}) {
  const { getOperationalAvailability } = require('../lib/ops-config');
  const { slotsForDate, nextOpenDay } = require('../lib/booking-schedule');
  const {
    normalizeArrivalWindow,
    resolveOperationalSlot,
    eligibleOperationalSlots,
    ERROR_ARRIVAL_WINDOW_UNAVAILABLE,
  } = require('../lib/arrival-windows');
  const { normalizeScheduleFlexibility } = require('../lib/schedule-flexibility');

  const config = await getOperationalAvailability().catch(() => null);
  let bookingsForLock = null;

  // Prefer the slot index; the full-store scan stays as the fallback authority
  // whenever the index cannot answer. See netlify/lib/slot-index.js.
  // A failed/timed-out scan must NOT become [] — that used to make every slot
  // look free and let a second draft finalize.
  async function slotTaken(dateIso, slot) {
    const nowMs = Date.now();
    const indexed = await indexedSlotConflict(dateIso, slot, { excludeId, nowMs, config, bookedOnly });
    if (indexed.ok) return indexed.conflict;
    if (!bookingsForLock) {
      bookingsForLock = await loadSlotLockBookings().catch((err) => {
        throw verificationUnavailable(err);
      });
    }
    return hasSlotConflict(bookingsForLock, dateIso, slot, excludeId, { nowMs, config, bookedOnly });
  }

  function spanFor(dateIso, startSlot) {
    if (bookingHasInteriorCompanion(b)) {
      return planCombinedAppointment(dateIso, startSlot, b.appointmentDurationMinutes, config);
    }
    return spannedSlotTimes(dateIso, startSlot, b.appointmentDurationMinutes, config);
  }

  function spanDays(span, dateIso) {
    if (span && Array.isArray(span.days) && span.days.length) return span.days;
    return [{ date: dateIso, slots: (span && span.slots) || [] }];
  }

  async function spanTaken(dateIso, startSlot) {
    const span = spanFor(dateIso, startSlot);
    if (!span.ok) return { taken: true, span };
    for (const day of spanDays(span, dateIso)) {
      for (const slot of day.slots || []) {
        if (await slotTaken(day.date, slot)) return { taken: true, span };
      }
    }
    return { taken: false, span };
  }

  async function pickFreeEligibleSlot(dateIso, eligible) {
    if (!checkSlot) return { slot: eligible[0] || null, durationFailure: null };
    let durationFailure = null;
    let occupied = false;
    for (const slot of eligible) {
      const held = await spanTaken(dateIso, slot);
      if (!held.span || held.span.ok === false) {
        if (!durationFailure) {
          durationFailure = held.span || { error: 'ceramic_duration_exceeds_day' };
        }
        continue;
      }
      if (held.taken) {
        occupied = true;
        continue;
      }
      return { slot, durationFailure: null };
    }
    if (!occupied && durationFailure) return { slot: null, durationFailure };
    return { slot: null, durationFailure: null };
  }

  try {
  // Customer arrival window is preference; internal preferredTime is one operational slot.
  const rawWindow = b.preferredArrivalWindow;
  if (rawWindow != null && String(rawWindow).trim() !== '') {
    const window = normalizeArrivalWindow(rawWindow);
    if (!window) return { ok: false, error: ERROR_ARRIVAL_WINDOW_UNAVAILABLE };
    const slots = slotsForDate(b.preferredDate, config);
    const resolved = resolveOperationalSlot(b.preferredDate, window, slots);
    if (!resolved.ok) return { ok: false, error: resolved.error || ERROR_ARRIVAL_WINDOW_UNAVAILABLE };
    const picked = await pickFreeEligibleSlot(b.preferredDate, resolved.eligible || [resolved.preferredTime]);
    if (!picked.slot) {
      if (picked.durationFailure) {
        return {
          ok: false,
          error: picked.durationFailure.error || 'ceramic_duration_exceeds_day',
          userMessage: picked.durationFailure.message,
          nextValidStart: picked.durationFailure.nextValidStart || null,
        };
      }
      return {
        ok: false,
        error: checkSlot ? 'booking_slot_unavailable' : ERROR_ARRIVAL_WINDOW_UNAVAILABLE,
      };
    }
    b.preferredArrivalWindow = window;
    b.preferredTime = picked.slot;
  } else {
    // Legacy path: preferredTime remains the customer + operational value.
    b.preferredArrivalWindow = b.preferredArrivalWindow || '';
  }

  const v = validateBookingSchedule(b.preferredDate, b.preferredTime, { config });
  if (!v.ok) return { ok: false, error: v.error };
  b.preferredDate = v.preferredDate;
  b.preferredTime = v.preferredTime;

  const flex = normalizeScheduleFlexibility(b.scheduleFlexibility);
  b.scheduleFlexibility = flex;

  if (flex === 'alternate_date') {
    const altDate = String(b.alternatePreferredDate || '').trim();
    const altWinRaw = b.alternateArrivalWindow;
    if (!altDate) return { ok: false, error: 'booking_alternate_date_required' };
    if (altDate === b.preferredDate) return { ok: false, error: 'booking_alternate_date_same' };
    const altWin = normalizeArrivalWindow(altWinRaw);
    if (!altWin) return { ok: false, error: 'booking_alternate_arrival_window_required' };
    // Structural + calendar only — never a second hold or occupancy reservation.
    const altSlots = slotsForDate(altDate, config);
    if (!altSlots.length) return { ok: false, error: 'booking_alternate_date_unavailable' };
    const altEligible = eligibleOperationalSlots(altWin, altSlots);
    if (!altEligible.length) return { ok: false, error: ERROR_ARRIVAL_WINDOW_UNAVAILABLE };
    const altV = validateBookingSchedule(altDate, altEligible[0], { config });
    if (!altV.ok) return { ok: false, error: 'booking_alternate_date_unavailable' };
    b.alternatePreferredDate = altV.preferredDate;
    b.alternateArrivalWindow = altWin;
  } else if (flex === 'exact') {
    b.alternatePreferredDate = null;
    b.alternateArrivalWindow = null;
  } else {
    // Legacy flexible enums: keep readable; do not invent alternate fields.
    if (!b.alternatePreferredDate) b.alternatePreferredDate = null;
    if (!b.alternateArrivalWindow) b.alternateArrivalWindow = null;
  }

  const held = await spanTaken(v.preferredDate, v.preferredTime);
  if (!held.span || !held.span.ok) {
    return {
      ok: false,
      error: (held.span && held.span.error) || 'ceramic_duration_exceeds_day',
      userMessage: held.span && held.span.message,
      nextValidStart: held.span && held.span.nextValidStart,
    };
  }
  if (held.span.multiDay || held.span.extendedAppointment) {
    b.appointmentSchedule = {
      multiDay: !!held.span.multiDay,
      extendedAppointment: !!held.span.extendedAppointment,
      days: held.span.days || [],
      message: held.span.message || null,
    };
  } else if (b.appointmentSchedule) {
    b.appointmentSchedule = null;
  }
  if (checkSlot && held.taken) {
    if (bookingHasInteriorCompanion(b) && held.span && held.span.multiDay) {
      let cursor = v.preferredDate;
      let nextValidStart = null;
      for (let i = 0; i < 21 && cursor; i += 1) {
        const slots = slotsForDate(cursor, config);
        const start = slots[0];
        const sameFailedStart = cursor === v.preferredDate && start === v.preferredTime;
        if (start && !sameFailedStart) {
          const candidate = await spanTaken(cursor, start);
          if (!candidate.taken && candidate.span && candidate.span.ok) {
            nextValidStart = { date: cursor, time: start };
            break;
          }
        }
        const nxt = nextOpenDay(cursor, config);
        cursor = nxt && nxt.iso;
      }
      return {
        ok: false,
        error: 'booking_slot_unavailable',
        userMessage: 'That start cannot be reserved because every required service day must be open. Choose the next opening that can hold the full appointment.',
        nextValidStart,
      };
    }
    return { ok: false, error: 'booking_slot_unavailable' };
  }
  return {
    ok: true,
    weekendMode: v.weekendMode || null,
    isWeekend: !!v.isWeekend,
    slotBookings: bookingsForLock,
  };
  } catch (err) {
    if (isVerificationUnavailable(err)) {
      return { ok: false, error: 'booking_verification_unavailable' };
    }
    throw err;
  }
}

function scheduleStatus(error) {
  if (error === 'booking_slot_unavailable') return 409;
  if (error === BOOKING_VERIFICATION_UNAVAILABLE) return 503;
  return 400;
}

function scheduleRejectResponse(status, error, meta = {}) {
  const fallback = error === 'booking_slot_unavailable'
    ? 'That time slot is no longer available. Your card was not charged. Choose another date or time, then submit again — you do not need to re-save your card if it already shows as saved.'
    : error === BOOKING_VERIFICATION_UNAVAILABLE
      ? 'We could not verify whether this time is still available. Nothing was booked. Please wait a moment and try again.'
    : error === 'booking_date_unavailable'
      ? 'That date is unavailable. Choose another day, then continue.'
      : error === 'booking_time_unavailable'
        ? 'That time is unavailable. Choose another slot, then continue.'
        : (error === 'arrival_window_unavailable' || error === 'booking_arrival_window_unavailable')
          ? 'That arrival window is no longer available for the selected date. Choose another window, then continue.'
          : error === 'booking_alternate_date_same'
            ? 'Your alternate date must be different from your preferred date.'
            : error === 'booking_alternate_date_required' || error === 'booking_alternate_arrival_window_required'
              ? 'Please complete your alternate date and arrival window, or uncheck the alternate date option.'
              : error === 'booking_alternate_date_unavailable'
                ? 'That alternate date is unavailable. Choose another day or window.'
                : error === 'ceramic_duration_exceeds_day'
        ? (meta.userMessage || 'That start time is too late for this Ceramic Coating appointment. Choose an earlier slot so the full service fits on the schedule.')
        : 'Please choose an available date and time.';
  const userMessage = meta.userMessage || fallback;
  console.log('[submit-booking] schedule rejected', {
    error,
    responseCode: status,
    draftBookingId: meta.draftBookingId || null,
    preferredDate: meta.preferredDate || null,
    preferredTime: meta.preferredTime || null,
    preferredArrivalWindow: meta.preferredArrivalWindow || null,
    phase: meta.phase || null,
  });
  return json(status, {
    ok: false,
    bookingCreated: false,
    error,
    userMessage,
    nextValidStart: meta.nextValidStart || null,
  });
}

let blobsStoreOverride = null;
let previewTransactionGuardOverride = null;

async function blobsStore(name) {
  if (typeof blobsStoreOverride === 'function') {
    return blobsStoreOverride(name);
  }
  // Prefer shared helper: runtime Blobs context first, then explicit siteID/token.
  // Functions v1 often lack runtime context, so a valid NETLIFY_AUTH_TOKEN is required.
  const { blobsStore: sharedBlobsStore } = require('../lib/tech-security');
  return sharedBlobsStore(name);
}

function sanitizeBlobError(err) {
  const raw = String(err && (err.message || err) || 'unknown');
  return raw
    .replace(/nf[cp]_[A-Za-z0-9]+/gi, '[REDACTED_TOKEN]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[DB_URL]')
    .slice(0, 240);
}

function buildDraftRecord(b, draftId, now, existing = null) {
  const incomingPref = normalizeRequestPreference(b.paymentMethodPreference);
  const preference = incomingPref || String(b.paymentMethodPreference || '');
  const cardOnFileRequired = resolveCardOnFileRequired(
    preference,
    existing ? existing.cardOnFileRequired : b.cardOnFileRequired
  );
  const resolvedPreference = cardOnFileRequired
    ? String(preference || '')
    : (incomingPref || '');
  return {
    id: draftId,
    isDraft: true,
    bookingVersion: existing
      ? Math.max(0, Math.round(Number(existing.bookingVersion) || 0)) + 1
      : 0,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    totalPrice: Number(b.totalPrice) || 0,
    paymentMethod: resolvedPreference,
    paymentMethodPreference: resolvedPreference,
    cardOnFileRequired,
    cardOnFileStatus: cardOnFileRequired
      ? (existing ? existing.cardOnFileStatus : 'pending')
      : 'not_collected',
    paymentStatus: existing ? existing.paymentStatus : 'no_payment_required_yet',
    paymentWorkflowStatus: existing ? existing.paymentWorkflowStatus : 'no_payment_required_yet',
    appointmentStatus: existing ? existing.appointmentStatus : 'pending_review',
    jobStatus: existing ? existing.jobStatus : 'not_started',
    acceptedCardOnFilePolicy: cardOnFileRequired,
    // Backfill: drafts pre-registered before this field existed carry no consent
    // timestamp. Re-registration re-affirms the policy, so stamp it rather than
    // propagating undefined — create-setup-intent hard-rejects a missing stamp.
    acceptedCardOnFilePolicyAt: cardOnFileRequired
      ? ((existing && existing.acceptedCardOnFilePolicyAt) || now)
      : null,
    policyVersion: TERMS_POLICY_VERSION,
    setupIntentId: cardOnFileRequired && existing ? existing.setupIntentId : undefined,
    stripeCustomerId: cardOnFileRequired && existing ? existing.stripeCustomerId : undefined,
    stripePaymentMethodId: cardOnFileRequired && existing ? existing.stripePaymentMethodId : undefined,
    firstName: b.firstName || '',
    lastName: b.lastName || '',
    phone: b.phone || '',
    email: b.email || '',
    address: b.address || '',
    zipCode: b.zipCode || '',
    zone: b.zone || '',
    travelFeeMiles: b.travelFeeMiles ?? null,
    travelFeeAmount: b.travelFeeAmount ?? 0,
    zoneSurcharge: b.zoneSurcharge ?? 0,
    vehicle: b.vehicle || '',
    vehicleLabel: b.vehicleLabel || '',
    package: b.package || '',
    addons: b.addons || [],
    vehicles: b.vehicles || [],
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    preferredArrivalWindow: b.preferredArrivalWindow || '',
    scheduleFlexibility: (() => {
      const { normalizeScheduleFlexibility } = require('../lib/schedule-flexibility');
      return normalizeScheduleFlexibility(b.scheduleFlexibility);
    })(),
    alternatePreferredDate: b.alternatePreferredDate || null,
    alternateArrivalWindow: b.alternateArrivalWindow || null,
    waterAvailable: b.waterAvailable || '',
    electricityAvailable: b.electricityAvailable || '',
    serviceLocation: b.serviceLocation || '',
    accessNotes: b.accessNotes || '',
    notes: b.notes || b.customerNote || '',
    customerNote: b.notes || b.customerNote || '',
    offer: b.offer || existing?.offer || null,
    welcomeOffer: b.welcomeOffer || existing?.welcomeOffer || null,
    approvedFinalAmount: b.approvedFinalAmount ?? existing?.approvedFinalAmount ?? null,
    discountAmount: b.discountAmount ?? existing?.discountAmount ?? 0,
    // Server-computed after catalog + schedule checks. The client copies are
    // stripped or ignored; these fields are what the slot index reserves.
    appointmentDurationMinutes: Number(b.appointmentDurationMinutes) > 0
      ? Number(b.appointmentDurationMinutes)
      : null,
    appointmentSchedule: b.appointmentSchedule && typeof b.appointmentSchedule === 'object'
      ? {
          multiDay: !!b.appointmentSchedule.multiDay,
          extendedAppointment: !!b.appointmentSchedule.extendedAppointment,
          days: Array.isArray(b.appointmentSchedule.days) ? b.appointmentSchedule.days : [],
          message: b.appointmentSchedule.message || null,
        }
      : null,
    serviceFamily: b.serviceFamily || null,
    companionInterior: b.companionInterior === true,
    ceramicPaymentPlan: b.ceramicPaymentPlan || null,
    depositAmount: b.depositAmount != null ? b.depositAmount : null,
    amountPaid: b.amountPaid != null ? b.amountPaid : null,
    balanceDue: b.balanceDue != null ? b.balanceDue : null,
  };
}

function issueDraftSaveResponse(draft) {
  const tokenResult = issueDraftSaveToken({
    bookingId: draft.id,
    phone: draft.phone,
  });
  if (!tokenResult.ok) {
    const err = tokenResult.error === 'invalid_draft_token_inputs'
      ? 'invalid_phone'
      : (tokenResult.error || 'missing_draft_token_secret');
    const status = err === 'missing_draft_token_secret' ? 503 : 400;
    return { ok: false, status, body: { ok: false, error: err } };
  }
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      bookingCreated: false,
      id: draft.id,
      isDraft: true,
      draftSaveToken: tokenResult.token,
      draftSaveTokenExp: tokenResult.draftSaveTokenExp,
      bookingVersion: Math.max(0, Math.round(Number(draft.bookingVersion) || 0)),
    },
  };
}

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// C-3: Generate a collision-resistant server-side booking ID.
function generateId() {
  return 'CD1-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// C-3: Ensure the generated ID doesn't already exist in Blobs.
async function newUniqueId(store) {
  for (let i = 0; i < 5; i++) {
    const id = generateId();
    const existing = await store.get(id, { type: 'json' }).catch(() => null);
    if (!existing) return id;
  }
  return generateId(); // unlikely collision after 5 tries; proceed anyway
}

function bookingText(b) {
  const vehicles = (b.vehicles || [])
    .map(v => `  • ${v.vehicleLabel || v.vehicle || 'Vehicle'} — ${v.pkgName || ''} ($${v.subtotal || 0})`)
    .join('\n');

  const PAY_STATUS_LABEL = {
    authorized:              'Card authorized (hold) — dispatch allowed',
    paid:                    'Captured / Paid',
    authorization_pending:   'Card not yet authorized — awaiting payment',
    authorization_failed:    'Authorization failed',
    no_payment_required_yet: 'No payment required yet',
    capture_pending:         'Authorized — capture pending after service',
    canceled:                'Canceled',
    refunded:                'Refunded',
    expired:                 'Authorization expired',
  };
  const payLabel = PAY_STATUS_LABEL[b.paymentStatus] || (b.paymentStatus || 'Unknown');
  const authorizedAmt = b.amountAuthorizedCents
    ? ' ($' + (b.amountAuthorizedCents / 100).toFixed(2) + ' held)'
    : '';

  const accessLines = formatSiteAccessLines(b);

  return [
    `NEW BOOKING — ${b.id}`,
    `Status: ${b.status || 'Pending Review'}`,
    `Payment: ${payLabel}${authorizedAmt}`,
    `Payment plan: ${b.paymentMethodPreference || 'To be selected later'}`,
    `Card on file: ${b.cardOnFileRequired === false ? 'Not collected (not required)' : (b.cardOnFileStatus || 'pending')}`,
    `Appointment: ${b.appointmentStatus || 'pending_review'}`,
    b.paymentIntentId ? `PaymentIntent: ${b.paymentIntentId}` : '',
    ``,
    `Customer: ${b.firstName || ''} ${b.lastName || ''}`,
    `Phone:    ${b.phone || ''}`,
    `Email:    ${b.email || ''}`,
    `Address:  ${b.address || ''}`,
    `ZIP/Zone: ${b.zipCode || ''} ${b.zone ? '· ' + b.zone : ''}`,
    `Date:     ${b.preferredDate || ''} ${b.preferredTime || ''}`,
    `Arrival:  ${(() => {
      try {
        const { arrivalWindowLabel } = require('../lib/arrival-windows');
        return arrivalWindowLabel(b.preferredArrivalWindow) || b.preferredArrivalWindow || '—';
      } catch (_) {
        return b.preferredArrivalWindow || '—';
      }
    })()}`,
    `Flexibility: ${(() => {
      try {
        const { scheduleFlexibilityLabel } = require('../lib/schedule-flexibility');
        return scheduleFlexibilityLabel(b.scheduleFlexibility);
      } catch (_) {
        return b.scheduleFlexibility || 'exact';
      }
    })()}`,
    ...(b.alternatePreferredDate ? [
      `Alternate: ${b.alternatePreferredDate} ${(() => {
        try {
          const { arrivalWindowLabel } = require('../lib/arrival-windows');
          return arrivalWindowLabel(b.alternateArrivalWindow) || b.alternateArrivalWindow || '';
        } catch (_) {
          return b.alternateArrivalWindow || '';
        }
      })()}`,
    ] : []),
    ``,
    `Service:  ${b.package || b.service || ''}`,
    vehicles ? `Vehicles:\n${vehicles}` : '',
    `Add-ons:  ${(b.addons || []).map(a => a.name).join(', ') || 'None'}`,
    `TOTAL:    $${b.totalPrice || 0}`,
    ...(accessLines.length ? ['', ...accessLines] : []),
    ``,
    `Notes:    ${b.notes || '—'}`,
  ].filter(Boolean).join('\n');
}

async function sendEmail(b) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return { sent: false, reason: 'email not configured' };
  let text = bookingText(b);
  try {
    const { appendAdminOpsEmailLink } = require('../lib/admin-quick-ops-token');
    text = await appendAdminOpsEmailLink(text, b.id);
  } catch { /* admin email still sends without the ops link */ }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [ADMIN_EMAIL],
      reply_to: b.email || undefined,
      subject: `New Cardetail1 Booking ${b.id} — ${b.firstName || ''} ${b.lastName || ''} ($${b.totalPrice || 0}) · ${b.paymentStatus || 'pending'}`,
      text,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `resend ${res.status}: ${err}` };
  }
  return { sent: true };
}

async function sendCustomerEmail(b) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!RESEND_API_KEY) return { sent: false, reason: 'email not configured' };
  if (!b.email) return { sent: false, reason: 'no customer email' };

  const name = [b.firstName, b.lastName].filter(Boolean).join(' ');
  const service = b.package || b.service || 'Detailing Service';
  const vehicle = b.vehicle || b.vehicleCategory || '—';
  const dateTime = [b.preferredDate, b.preferredTime].filter(Boolean).join(' ') || '—';
  const zip = b.zipCode || b.zone || '—';

  const text = [
    `Hi ${name},`,
    ``,
    `Your card was securely saved with Stripe. No charge has been made today.`,
    `Your booking request was received. This is not yet a confirmed appointment.`,
    ``,
    `Our team will review your location, vehicle condition, service type, weather, access, and availability before confirming. You will receive a separate confirmation once your appointment is approved.`,
    ``,
    `Requested details:`,
    ``,
    `  * Service: ${service}`,
    `  * Vehicle: ${vehicle}`,
    `  * Preferred date/time: ${dateTime}`,
    `  * Location/ZIP: ${zip}`,
    `  * Booking ID: ${b.id}`,
    ``,
    `What to expect next:`,
    `  * Our team reviews your request (usually within a few hours during business hours).`,
    `  * You will receive a confirmation with your confirmed date and time window.`,
    `  * Cancellation/no-show policy applies after appointment confirmation.`,
    ``,
    `Please make sure the vehicle will be accessible, legally parked, and has enough working space around it on the day of service.`,
    ``,
    `Cardetail1 Mobile Detailing`,
    `https://cardetail1.com`,
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [b.email],
        subject: 'Cardetail1 — Booking Request Received',
        text,
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.log('[submit-booking] customer email failed:', res.status, err.slice(0, 200));
      return { sent: false, reason: `resend ${res.status}` };
    }
    console.log('[submit-booking] customer email sent to:', b.email);
    return { sent: true };
  } catch (e) {
    console.log('[submit-booking] customer email error:', e.message);
    return { sent: false, reason: e.message };
  }
}

async function sendSms(b) {
  // Admin SMS is independent of customer consent, portal access, verified phone,
  // and /a?t=. The booking id/name/phone here are alert copy only — not gates.
  const { enqueueSms, TEMPLATE_KEYS } = smsOutbox();
  const queued = await enqueueSms({
    idempotencyKey: `admin.booking:${b.id}`,
    audience: 'admin',
    consentGranted: enabled(process.env.ADMIN_SMS_CONSENT_GRANTED),
    toE164: process.env.ADMIN_SMS,
    bookingId: b.id,
    templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
    templateData: await (async () => {
      const { adminBookingTemplateData } = require('../lib/sms-templates');
      const data = adminBookingTemplateData(b, {
        bookingRef: b.id,
        customerName: [b.firstName, b.lastName].filter(Boolean).join(' '),
        customerPhone: b.phone || '',
      });
      try {
        const { mintQuickOpsUrl } = require('../lib/admin-quick-ops-token');
        const opsUrl = await mintQuickOpsUrl(b.id);
        if (opsUrl) data.opsUrl = opsUrl;
      } catch { /* alert still sends without the ops link */ }
      return data;
    })(),
  });
  if (!queued.ok) return { sent: false, reason: queued.error || 'sms_outbox_failed' };
  if (!queued.queued) return { sent: false, skipped: true, reason: queued.reason || 'sms_not_queued' };
  return { sent: false, accepted: true, queued: true, outboxId: queued.outbox?.id || null };
}

function applyCustomerTxnDelivery(booking, delivery, txn) {
  const now = new Date().toISOString();
  const custEmailStatus = txn.delivery?.email?.sent
    ? { status: 'sent', at: now, reason: null }
    : {
      status: txn.delivery?.email?.skipped ? 'suppressed' : 'failed',
      at: now,
      reason: txn.delivery?.email?.reason || null,
    };
  const custSmsStatus = txn.delivery?.sms?.accepted || txn.delivery?.sms?.queued
    ? {
      status: 'accepted',
      at: now,
      reason: null,
      outboxId: txn.delivery?.sms?.outboxId || null,
    }
    : txn.delivery?.sms?.sent
      ? { status: 'sent', at: now, reason: null }
      : {
        status: txn.delivery?.sms?.skipped ? 'suppressed' : 'failed',
        at: now,
        reason: txn.delivery?.sms?.reason || 'customer_sms_not_enabled',
      };
  return {
    ...booking,
    notificationDelivery: {
      ...(booking.notificationDelivery || delivery),
      customerEmail: custEmailStatus,
      customerSms: custSmsStatus,
      updatedAt: now,
    },
  };
}

/**
 * Booking-authority notification orchestration. Runs AFTER persist. Never
 * throws into the checkout response. Portal / My Garage / /a?t= are not
 * callers of this function.
 */
async function deliverBookingCreatedNotifications(booking, event) {
  const delivery = await sendNotificationsDecoupled(booking, {
    adminEmail: (row) => sendEmail(row).catch((e) => ({ sent: false, reason: e.message })),
    adminSms: (row) => sendSms(row).catch((e) => ({ sent: false, reason: e.message })),
  });
  let withDelivery = attachDeliveryToBooking(booking, delivery);
  try {
    const { emitRequestReceived } = require('../lib/booking-transactional-notifications');
    const txn = await emitRequestReceived(withDelivery, { event, source: 'booking_persist' });
    if (txn && txn.booking) {
      withDelivery = applyCustomerTxnDelivery(txn.booking, delivery, txn);
    }
  } catch (e) {
    console.warn('[submit-booking] transactional notify failed:', e.message);
  }

  const outboxIds = [
    withDelivery.notificationDelivery?.adminSms?.outboxId,
    withDelivery.notificationDelivery?.customerSms?.outboxId,
  ].filter(Boolean);
  if (outboxIds.length) {
    try {
      const { kickSmsOutboxByIds } = smsOutbox();
      await kickSmsOutboxByIds(outboxIds);
    } catch (e) {
      console.warn('[submit-booking] sms outbox kick failed:', e.message);
    }
  }
  return withDelivery;
}

function mergeNotificationFields(latest, notified) {
  if (!notified) return latest;
  if (!latest) return notified;
  return {
    ...latest,
    notificationDelivery: notified.notificationDelivery || latest.notificationDelivery,
    transactionalNotifications: notified.transactionalNotifications || latest.transactionalNotifications,
    lastTransactionalNotificationAt:
      notified.lastTransactionalNotificationAt || latest.lastTransactionalNotificationAt,
    lastTransactionalNotificationEvent:
      notified.lastTransactionalNotificationEvent || latest.lastTransactionalNotificationEvent,
    customerAccountId: latest.customerAccountId || notified.customerAccountId || null,
    appointmentPublicRef: latest.appointmentPublicRef || notified.appointmentPublicRef,
    appointmentPublicRefAt: latest.appointmentPublicRefAt || notified.appointmentPublicRefAt,
    bookingVersion: latest.bookingVersion,
    quoteVersion: latest.quoteVersion,
  };
}

let bookingNotificationAttempts = 0;
const NOTIFICATION_CLAIM_MS = 2 * 60 * 1000;

function occupancyFailureBody(bookingId, error) {
  const conflict = error === 'booking_slot_unavailable';
  return {
    ok: false,
    bookingCreated: false,
    error: conflict ? 'booking_slot_unavailable' : 'occupancy_incomplete',
    draftBookingId: bookingId || null,
    recoverable: !conflict,
    retryable: !conflict,
    userMessage: conflict
      ? 'That time is no longer available. Choose another slot and submit again. No payment was collected.'
      : 'The appointment was not confirmed. Submit the request again to finish reserving every required time. No payment was collected.',
  };
}

function pendingOccupancyRecord(existing, prepared) {
  const pending = {
    ...existing,
    preferredDate: prepared.preferredDate,
    preferredTime: prepared.preferredTime,
    preferredArrivalWindow: prepared.preferredArrivalWindow,
    appointmentDurationMinutes: prepared.appointmentDurationMinutes,
    appointmentSchedule: prepared.appointmentSchedule,
    companionInterior: prepared.companionInterior,
    serviceFamily: prepared.serviceFamily,
    ceramicPaymentPlan: prepared.ceramicPaymentPlan,
    vehicles: prepared.vehicles || existing.vehicles,
    totalPrice: prepared.totalPrice,
    isDraft: true,
    kind: 'draft',
    occupancyStatus: 'pending',
    occupancyPendingAt: existing.occupancyPendingAt || new Date().toISOString(),
  };
  delete pending.finalizedAt;
  delete pending.notificationsClaimedAt;
  delete pending.draftSaveTokenRevokedAt;
  return pending;
}

function notificationClaimIsFresh(booking, nowMs = Date.now()) {
  const claimed = Date.parse(booking && booking.notificationsClaimedAt || '');
  return Number.isFinite(claimed) && (nowMs - claimed) < NOTIFICATION_CLAIM_MS;
}

function shouldRepairConfirmedNotifications(booking) {
  if (!booking || booking.isDraft || !booking.finalizedAt) return false;
  if (!bookingCreatedNotificationsIncomplete(booking)) return false;
  if (notificationClaimIsFresh(booking)) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONFIRMATION_CLAIM_STALE_MS = 15 * 1000;
const confirmationGates = new Map();

function withConfirmationGate(bookingId, work) {
  const previous = confirmationGates.get(bookingId) || Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  const settled = run.then(() => {}, () => {});
  confirmationGates.set(bookingId, settled);
  settled.then(() => {
    if (confirmationGates.get(bookingId) === settled) confirmationGates.delete(bookingId);
  });
  return run;
}

async function claimConfirmation(store, bookingId) {
  const key = `occupancy-claim/${bookingId}`;
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({ at: new Date().toISOString(), nonce });
  if (!store || typeof store.set !== 'function') return { owner: true, nonce: null, key };
  try {
    let result = await store.set(key, payload, { onlyIfNew: true });
    if (result && result.modified === false) {
      const existing = await store.get(key, { type: 'json' }).catch(() => null);
      const age = Date.now() - Date.parse(existing && existing.at || '');
      const current = await store.get(bookingId, { type: 'json' }).catch(() => null);
      if (!recordIsConfirmed(current) && Number.isFinite(age) && age > CONFIRMATION_CLAIM_STALE_MS) {
        await store.delete(key);
        result = await store.set(key, payload, { onlyIfNew: true });
      }
    }
    if (result && result.modified === false) return { owner: false, nonce, key };
    const seen = await store.get(key, { type: 'text' }).catch(() => null);
    if (seen && !String(seen).includes(nonce)) return { owner: false, nonce, key };
    return { owner: true, nonce, key };
  } catch (err) {
    console.warn('[submit-booking] occupancy claim failed', err && err.message ? err.message : err);
    return { owner: false, nonce, key };
  }
}

async function waitForConfirmedBooking(store, bookingId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (recordIsConfirmed(current)) return current;
    await sleep(50);
  }
  return store.get(bookingId, { type: 'json' }).catch(() => null);
}

async function readBookingMeta(store, bookingId) {
  if (!store || typeof store.getWithMetadata !== 'function') return null;
  return store.getWithMetadata(bookingId, { type: 'json' }).catch(() => null);
}

function recordIsConfirmed(booking) {
  return !!(booking && booking.isDraft === false && booking.finalizedAt);
}

async function notifyConfirmedBooking(store, booking, event) {
  bookingNotificationAttempts += 1;
  try {
    const notified = await deliverBookingCreatedNotifications(booking, event);
    return await persistNotificationFields(store, booking.id, notified);
  } catch (e) {
    console.warn('[submit-booking] transactional notify failed:', e.message);
    return booking;
  }
}

function confirmedBookingResponse(booking, { idempotent = false, stored = null, withDelivery = null } = {}) {
  const row = withDelivery || booking;
  return json(200, {
    ok: true,
    bookingCreated: true,
    id: booking.id,
    status: booking.status || 'Pending Review',
    paymentStatus: booking.paymentStatus,
    stored,
    idempotent,
    email: row.notificationDelivery?.adminEmail || null,
    customerEmail: row.notificationDelivery?.customerEmail || { status: 'pending' },
    sms: row.notificationDelivery?.adminSms || null,
    notificationDelivery: row.notificationDelivery || booking.notificationDelivery || null,
    appointmentStatus: booking.appointmentStatus,
    cardOnFileStatus: booking.cardOnFileStatus || null,
    bookingVersion: booking.bookingVersion || 1,
    quoteVersion: booking.quoteVersion || 1,
    offer: booking.offer || null,
    approvedFinalAmount: booking.approvedFinalAmount ?? booking.totalPrice ?? null,
    totalPrice: booking.totalPrice ?? null,
    amountPaid: booking.amountPaid != null ? booking.amountPaid : 0,
    balanceDue: booking.balanceDue != null ? booking.balanceDue : null,
    depositAmount: booking.depositAmount != null ? booking.depositAmount : null,
    serviceFamily: booking.serviceFamily || null,
    paymentSucceeded: booking.serviceFamily === 'ceramic_coating'
      ? (booking.paymentStatus === 'paid' || booking.paymentStatus === 'partially_paid')
      : undefined,
    ceramicChargeAmount: booking.ceramic?.chargeAmount != null ? booking.ceramic.chargeAmount : null,
    appointmentDurationMinutes: booking.appointmentDurationMinutes || null,
  });
}

async function respondIfSpanConfirmed(store, booking, event, { idempotent = false } = {}) {
  const ready = await bookedSpanReady(booking);
  if (!ready.ok || !ready.complete) {
    const error = ready.ok ? 'occupancy_incomplete' : 'booking_verification_unavailable';
    return json(ready.ok ? 503 : 503, occupancyFailureBody(booking.id, error));
  }
  let current = booking;
  if (shouldRepairConfirmedNotifications(current)) {
    current = await notifyConfirmedBooking(store, current, event);
  }
  return confirmedBookingResponse(current, { idempotent, withDelivery: current });
}

async function persistNotificationFields(store, bookingId, notified) {
  const latest = await store.get(bookingId, { type: 'json' }).catch(() => null);
  const merged = mergeNotificationFields(latest, notified);
  await store.setJSON(bookingId, merged);
  try {
    const { scheduleBookingMirror } = require('../lib/booking-prisma-mirror');
    scheduleBookingMirror(merged);
  } catch { /* ignore */ }
  return merged;
}

function requestHostname(event) {
  const headers = (event && event.headers) || {};
  const raw = headers['x-forwarded-host'] || headers['X-Forwarded-Host'] || headers.host || headers.Host || '';
  return String(raw).split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

/**
 * Deploy previews call getStore(), the site-wide blob store production uses.
 * Refuse the write here so a preview test cannot create a live reservation.
 * Production and local dev are unchanged.
 */
function refuseSharedPreviewBooking(event) {
  const { deployContext } = require('../lib/trusted-site-origin');
  const ctx = deployContext();
  const previewHost = /^deploy-preview-\d+--[a-z0-9-]+\.netlify\.app$/.test(requestHostname(event));
  if (ctx !== 'deploy-preview' && !previewHost) return null;
  return json(403, {
    ok: false,
    bookingCreated: false,
    error: 'preview_booking_disabled',
    userMessage: 'This preview cannot create bookings because it uses the same storage as the live site.',
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const previewRefusal = refuseSharedPreviewBooking(event);
  if (previewRefusal) return previewRefusal;
  const previewCheck = await (previewTransactionGuardOverride
    || require('../lib/owner-studio/preview-transaction-guard').checkPreviewTransactionRequest)(event);
  if (previewCheck.previewRequest) {
    if (!previewCheck.authorized) {
      return json(403, { ok: false, error: previewCheck.error || 'preview_request_denied' });
    }
    return json(403, {
      ok: false,
      error: 'preview_transactions_disabled',
      message: 'Preview mode does not allow bookings or payments.',
    });
  }
  setOfferDeployHost(event.headers?.['x-forwarded-host'] || event.headers?.Host || event.headers?.host || '');
  try {
  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'submit-booking',
    action: identifySubmitBookingAction(b),
  });
  if (rateLimit.blocked) return rateLimit.response;

  // C-1: Strip all fields the browser must never control.
  for (const f of CLIENT_BLOCKED_FIELDS) delete b[f];
  for (const f of CLIENT_OFFER_BLOCKED_FIELDS) delete b[f];
  stripClientOfferFields(b);
  // C-3: Ignore any client-submitted ID entirely.
  delete b.id;
  delete b.bookingId;

  // Schedule flexibility is preference-only (never auto-changes the date).
  {
    const { normalizeScheduleFlexibility } = require('../lib/schedule-flexibility');
    b.scheduleFlexibility = normalizeScheduleFlexibility(b.scheduleFlexibility);
  }

  if (!b.firstName || !b.phone) return json(400, { ok: false, error: 'Missing customer name or phone' });
  if (normalizePhone(b.phone).length < 7) {
    return json(400, { ok: false, error: 'invalid_phone' });
  }

  const zip = String(b.zipCode || b.zip || '').replace(/\D/g, '').slice(0, 5);
  if (zip.length < 5) return json(400, { ok: false, error: 'zip_required' });

  const routingCheck = validateBookingRouting(b);
  if (!routingCheck.ok) {
    return json(403, { ok: false, error: routingCheck.error });
  }

  const isDraftRequest = !!b.isDraft;
  const travelApplied = applyServerTravelAndTotal(
    b,
    isDraftRequest ? { skipMismatchCheck: true } : {}
  );
  if (!travelApplied.ok) {
    return json(400, { ok: false, error: travelApplied.error || 'out_of_service_area' });
  }

  const ceramicApplied = applyCeramicBooking(b, { finalize: !isDraftRequest });
  if (!ceramicApplied.ok) {
    return json(400, {
      ok: false,
      bookingCreated: false,
      error: ceramicApplied.error,
      message: ceramicApplied.message || null,
      userMessage: ceramicApplied.message || null,
      route: ceramicApplied.route || null,
      packageId: ceramicApplied.packageId || null,
      depositsEnabled: ceramicApplied.depositsEnabled === false ? false : undefined,
    });
  }

  const welcomeSource = String(b.welcomeOfferSource || b.offerSource || '').trim() || null;
  delete b.welcomeOfferSource;
  delete b.offerSource;
  delete b.welcomeOfferAccepted;

  // Finalize (non-draft) claims one-time WELCOME10 redemption. Drafts price the
  // offer for display but must not consume redemption.
  const claimRedemption = !b.isDraft;
  const redemptionBookingId = String(b.draftBookingId || b.id || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);

  try {
    await applyServerOffersToBooking(b, {
      serviceSubtotal: travelApplied.serviceSubtotal,
      travelFee: b.travelFeeAmount || 0,
      sourceTrigger: welcomeSource,
      claimRedemption,
      redemptionBookingId: claimRedemption ? redemptionBookingId : null,
    });
  } catch (e) {
    const code = (e && e.code) || 'offer_application_unavailable';
    console.warn('[submit-booking] offer apply failed:', e && e.message ? e.message : e);
    const retryable = code !== 'offer_already_redeemed';
    const status = code === 'offer_already_redeemed' ? 409 : 503;
    return json(status, {
      ok: false,
      error: code === 'offer_evaluation_failed' ? 'offer_application_unavailable' : code,
      retryable,
      userMessage: retryable
        ? 'We could not verify your welcome offer. Please try again in a moment. Your booking was not submitted.'
        : 'This welcome offer was already used. Refresh the review total and submit again. Your booking was not submitted.',
    });
  }

  const store = await blobsStore('cd1-bookings');

  // ── Draft pre-registration (supports C-2: create-payment-intent fetches amount from Blobs) ──
  if (b.isDraft) {
    const secretStatus = getDraftTokenSecretStatus();
    if (!secretStatus.ok) {
      return json(503, { ok: false, error: 'missing_draft_token_secret' });
    }

    const preference = String(b.paymentMethodPreference || '');
    const cardOnFileRequired = resolveCardOnFileRequired(preference, b.cardOnFileRequired);
    if (preference === 'online_after_service' && b.cardOnFileRequired === false) {
      return json(400, { ok: false, error: 'card_on_file_required' });
    }
    if (cardOnFileRequired) {
      if (!PAYMENT_PREFERENCES.has(preference)) {
        return json(400, { ok: false, error: 'payment_preference_required' });
      }
      if (b.acceptedCardOnFilePolicy !== true) {
        return json(400, { ok: false, error: 'card_on_file_policy_required' });
      }
    } else if (preference && !PAYMENT_PREFERENCES.has(preference)) {
      return json(400, { ok: false, error: 'invalid_payment_preference' });
    }

    const now = new Date().toISOString();
    const rawUpdateId = String(b.draftBookingId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);
    delete b.draftBookingId;

    // Reject taken slots before SetupIntent / card save so customers never
    // save a card against a time that cannot be finalized.
    const scheduleDraft = await enforceScheduleFields(b, {
      checkSlot: true,
      excludeId: rawUpdateId || null,
    });
    if (!scheduleDraft.ok) {
      const status = scheduleStatus(scheduleDraft.error);
      return scheduleRejectResponse(status, scheduleDraft.error, {
        draftBookingId: rawUpdateId || null,
        preferredDate: b.preferredDate || null,
        preferredTime: b.preferredTime || null,
        phase: 'draft',
        userMessage: scheduleDraft.userMessage,
        nextValidStart: scheduleDraft.nextValidStart,
      });
    }

    let draftId;
    let existing = null;
    if (rawUpdateId) {
      existing = await store.get(rawUpdateId, { type: 'json' }).catch(() => null);
      if (!existing || !existing.isDraft) {
        return json(404, { ok: false, error: 'Draft booking not found' });
      }
      const tokenCheck = verifyDraftSaveToken({
        token: b.draftSaveToken,
        bookingId: rawUpdateId,
        phone: existing.phone || b.phone,
      });
      delete b.draftSaveToken;
      if (!tokenCheck.ok) {
        return json(401, { ok: false, error: 'draft_token_invalid' });
      }
      draftId = rawUpdateId;
    } else {
      draftId = await newUniqueId(store);
    }

    const draft = buildDraftRecord(b, draftId, now, existing);
    // Index-first for drafts: an entry with no record makes the slot look busy
    // (fail-closed) and expires on its own; a record with no entry would let a
    // second customer save a card against the same time.
    const indexed = await syncSlotIndex(draft, { previous: existing });
    const multiDay = !!(draft.appointmentSchedule && draft.appointmentSchedule.multiDay);
    if (multiDay && indexed && indexed.ok === false) {
      return json(409, {
        ok: false,
        bookingCreated: false,
        error: 'schedule_reservation_failed',
        userMessage: 'Every required service day could not be reserved. Nothing was booked.',
      });
    }
    try {
      await store.setJSON(draftId, draft);
    } catch (e) {
      const detail = sanitizeBlobError(e);
      console.error('[submit-booking] draft blob persist failed', {
        stage: 'booking_persistence',
        errorClass: e && e.name ? e.name : 'Error',
        detail,
      });
      return json(500, { ok: false, error: 'Failed to pre-register booking' });
    }

    const issued = issueDraftSaveResponse(draft);
    if (!issued.ok) return json(issued.status, issued.body);
    return json(issued.status, issued.body);
  }

  // ── Draft finalization: merge full booking into an existing draft ──
  // Preserves webhook-set payment fields (paymentStatus, paymentIntentId, amounts).
  const rawDraftId = String(b.draftBookingId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);
  if (rawDraftId) {
    delete b.draftBookingId;
    let existing = await store.get(rawDraftId, { type: 'json' }).catch(() => null);
    if (!existing) return json(404, { ok: false, error: 'Draft booking not found' });
    if (!existing.isDraft) {
      // Idempotent finalize: already submitted booking returns same id/version.
      // If the first attempt persisted then died before notify, repair now —
      // still booking-authority (signed draft token), never a portal trigger.
      if (existing.finalizedAt || existing.bookingVersion >= 1) {
        const tokenCheck = verifyDraftSaveToken({
          token: b.draftSaveToken,
          bookingId: rawDraftId,
          phone: existing.phone || b.phone,
        });
        let ready = await bookedSpanReady(existing);
        if (!ready.ok || !ready.complete) {
          // A legacy finalized record with a missing span stays untouched.
          // Only a record that already entered the pending-occupancy protocol
          // may finish its own slots on retry.
          if (!existing.occupancyPendingAt) {
            return json(503, occupancyFailureBody(
              existing.id || rawDraftId,
              ready.ok ? 'occupancy_incomplete' : 'booking_verification_unavailable'
            ));
          }
          const repaired = await reserveBookedSpan(existing);
          if (!repaired || repaired.ok === false) {
            const error = (repaired && repaired.error) || 'occupancy_incomplete';
            const status = error === 'booking_slot_unavailable' ? 409 : 503;
            return json(status, occupancyFailureBody(existing.id || rawDraftId, error));
          }
          ready = await bookedSpanReady(existing);
          if (!ready.ok || !ready.complete) {
            return json(503, occupancyFailureBody(
              existing.id || rawDraftId,
              ready.ok ? 'occupancy_incomplete' : 'booking_verification_unavailable'
            ));
          }
        }
        let booking = existing;
        if (tokenCheck.ok && shouldRepairConfirmedNotifications(existing)) {
          const claimed = {
            ...existing,
            notificationsClaimedAt: new Date().toISOString(),
          };
          try {
            await store.setJSON(existing.id || rawDraftId, claimed);
            booking = await notifyConfirmedBooking(store, claimed, event);
          } catch (err) {
            console.warn('[submit-booking] confirmed notification claim failed', err && err.message ? err.message : err);
          }
        }
        return confirmedBookingResponse(booking, { idempotent: true, withDelivery: booking });
      }
      return json(409, { ok: false, error: 'Booking already finalized' });
    }
    const finalizeTokenPresent = !!String(b.draftSaveToken || '').trim();
    const tokenCheck = verifyDraftSaveToken({
      token: b.draftSaveToken,
      bookingId: rawDraftId,
      phone: existing.phone || b.phone,
    });
    delete b.draftSaveToken;
    if (!tokenCheck.ok) {
      console.log('[submit-booking] finalize draft_token_invalid', {
        draftBookingId: rawDraftId,
        setupIntentIdPrefix: siIdPrefix(existing.setupIntentId),
        cardOnFileStatus: existing.cardOnFileStatus || null,
        tokenPresent: finalizeTokenPresent,
        responseCode: 401,
      });
      return json(401, { ok: false, error: 'draft_token_invalid' });
    }
    const preference = String(b.paymentMethodPreference || existing.paymentMethodPreference || '');
    const cardOnFileRequired = resolveCardOnFileRequired(
      preference,
      existing.cardOnFileRequired
    );
    if (preference === 'online_after_service' && existing.cardOnFileRequired === false) {
      return json(400, { ok: false, error: 'card_on_file_required' });
    }
    if (cardOnFileRequired) {
      const cofBefore = existing.cardOnFileStatus || 'pending';
      if (existing.cardOnFileStatus !== 'saved') {
        existing = await reconcileCardOnFileFromStripe(store, existing);
      }
      console.log('[submit-booking] finalize card-on-file gate', {
        draftBookingId: rawDraftId,
        setupIntentIdPrefix: siIdPrefix(existing.setupIntentId),
        cardOnFileStatusBefore: cofBefore,
        cardOnFileStatusAfter: existing.cardOnFileStatus || null,
      });
      if (existing.cardOnFileStatus !== 'saved') {
        console.log('[submit-booking] finalize rejected card_on_file_not_saved', {
          draftBookingId: rawDraftId,
          setupIntentIdPrefix: siIdPrefix(existing.setupIntentId),
          cardOnFileStatus: existing.cardOnFileStatus || null,
          responseCode: 409,
        });
        return json(409, {
          ok: false,
          error: 'card_on_file_not_saved',
          userMessage: CARD_ON_FILE_VERIFY_MSG,
        });
      }
    }
    if (cardOnFileRequired && (!PAYMENT_PREFERENCES.has(preference) || preference !== existing.paymentMethodPreference)) {
      return json(400, { ok: false, error: 'invalid_payment_preference' });
    }
    if (!cardOnFileRequired && preference && !PAYMENT_PREFERENCES.has(preference)) {
      return json(400, { ok: false, error: 'invalid_payment_preference' });
    }
    if (b.acceptedBookingPolicy !== true || (cardOnFileRequired && b.acceptedCardOnFilePolicy !== true)) {
      return json(400, { ok: false, error: 'booking_policy_required' });
    }
    const scheduleFinal = await enforceScheduleFields(b, {
      checkSlot: true,
      excludeId: rawDraftId,
      bookedOnly: true,
    });
    if (!scheduleFinal.ok) {
      const status = scheduleStatus(scheduleFinal.error);
      return scheduleRejectResponse(status, scheduleFinal.error, {
        draftBookingId: rawDraftId,
        preferredDate: b.preferredDate || null,
        preferredTime: b.preferredTime || null,
        phase: 'finalize',
        userMessage: scheduleFinal.userMessage,
        nextValidStart: scheduleFinal.nextValidStart,
      });
    }
    const finalizedAt = new Date().toISOString();
    const transactionalSmsConsentAccepted = b.transactionalSmsConsentAccepted === true;

    // Preserve fields the webhook may have already set on the draft.
    b = {
      ...b,
      id: rawDraftId,
      status: 'Pending Review',
      isDraft: false,
      kind: 'booking',
      schemaVersion: 1,
      bookingVersion: 1,
      quoteVersion: 1,
      createdAt: existing.createdAt,
      finalizedAt,
      draftSaveTokenRevokedAt: finalizedAt,
      paymentMethod: preference,
      paymentMethodPreference: preference,
      cardOnFileRequired,
      acceptedBookingPolicy: true,
      acceptedBookingPolicyAt: finalizedAt,
      acceptedCardOnFilePolicy: cardOnFileRequired,
      acceptedCardOnFilePolicyAt: cardOnFileRequired ? existing.acceptedCardOnFilePolicyAt : null,
      policyVersion: TERMS_POLICY_VERSION,
      transactionalSmsConsentAccepted,
      transactionalSmsConsent: canonicalBookingSmsConsent(
        transactionalSmsConsentAccepted,
        finalizedAt,
        transactionalSmsConsentAccepted ? (b.phone || b.customerPhone) : null
      ),
      // Transactional consent never implies promotional consent.
      marketingSmsConsentAccepted: false,
      // Payment fields: trust Blobs, not the browser
      paymentStatus:        'no_payment_required_yet',
      paymentWorkflowStatus:'no_payment_required_yet',
      appointmentStatus:    'pending_review',
      // pending_review (not not_started) so Admin + Customer share the same submitted lifecycle
      jobStatus:            'pending_review',
      portalReleasedAt:     finalizedAt,
      ...(b.serviceFamily === 'ceramic_coating'
        ? {
          paymentStatus: b.amountPaid > 0
            ? (b.balanceDue > 0 ? 'partially_paid' : 'paid')
            : 'unpaid',
          paymentWorkflowStatus: 'awaiting_customer_payment',
          serviceFamily: 'ceramic_coating',
        }
        : {}),
      ...(cardOnFileRequired
        ? {
          // Set only by stripe-webhook (setup_intent.succeeded).
          cardOnFileStatus: existing.cardOnFileStatus,
          setupIntentId: existing.setupIntentId,
          stripeCustomerId: existing.stripeCustomerId,
          stripePaymentMethodId: existing.stripePaymentMethodId,
          cardOnFileSavedAt: existing.cardOnFileSavedAt,
        }
        : { cardOnFileStatus: 'not_collected' }),
    };

    // Duplicate matching reuses the occupancy scan when the legacy Blobs path
    // ran. When the slot index answered occupancy (slotBookings stays null),
    // use the identity mirror only — do NOT 503 merely because full-store
    // hydration was skipped, and do NOT fall into an unbounded Blobs history
    // scan (the 504 path PR #314 removed). Fail-closed still holds for
    // schedule: scheduleFinal already 503'd when index+scan both failed.
    let duplicateCheck;
    if (Array.isArray(scheduleFinal.slotBookings)) {
      duplicateCheck = await findDuplicateBooking({
        phone: b.phone || existing.phone,
        email: b.email || existing.email,
        preferredDate: b.preferredDate,
        preferredTime: b.preferredTime,
        excludeId: rawDraftId,
        bookings: scheduleFinal.slotBookings,
      });
    } else {
      const {
        mirrorHistory,
        normalizeIdentity,
        matchDuplicateBooking,
      } = require('../lib/booking-history');
      const identity = normalizeIdentity({
        phone: b.phone || existing.phone,
        email: b.email || existing.email,
      });
      let mirrorRows = null;
      try {
        mirrorRows = await mirrorHistory(identity);
      } catch (err) {
        console.warn('[submit-booking] finalize mirror duplicate lookup failed', err && err.message ? err.message : err);
      }
      if (Array.isArray(mirrorRows)) {
        duplicateCheck = {
          ok: true,
          duplicate: matchDuplicateBooking(mirrorRows, {
            phone: b.phone || existing.phone,
            email: b.email || existing.email,
            preferredDate: b.preferredDate,
            preferredTime: b.preferredTime,
            excludeId: rawDraftId,
          }),
        };
      } else {
        // Index confirmed capacity; identity mirror unavailable. Prefer a
        // completed booking over re-introducing the Blobs scan that times out.
        console.warn('[submit-booking] finalize indexed path: identity mirror unavailable; continuing');
        duplicateCheck = { ok: true, duplicate: null };
      }
    }
    if (!duplicateCheck.ok) {
      return scheduleRejectResponse(503, BOOKING_VERIFICATION_UNAVAILABLE, {
        draftBookingId: rawDraftId,
        preferredDate: b.preferredDate || null,
        preferredTime: b.preferredTime || null,
        phase: 'finalize',
      });
    }
    if (duplicateCheck.duplicate) {
      return scheduleRejectResponse(409, 'booking_slot_unavailable', {
        draftBookingId: rawDraftId,
        preferredDate: b.preferredDate || null,
        preferredTime: b.preferredTime || null,
        phase: 'finalize',
      });
    }

    const pending = pendingOccupancyRecord(existing, b);
    try {
      const meta = await readBookingMeta(store, rawDraftId);
      const fresh = meta && meta.data;
      if (recordIsConfirmed(fresh)) {
        return respondIfSpanConfirmed(store, fresh, event, { idempotent: true });
      }
      if (meta && meta.etag) {
        const writeResult = await store.setJSON(rawDraftId, pending, { onlyIfMatch: meta.etag });
        if (writeResult && writeResult.modified === false) {
          const raced = await store.get(rawDraftId, { type: 'json' }).catch(() => null);
          if (recordIsConfirmed(raced)) {
            return respondIfSpanConfirmed(store, raced, event, { idempotent: true });
          }
        }
      } else {
        await store.setJSON(rawDraftId, pending);
      }
    } catch (e) {
      return json(500, { ok: false, bookingCreated: false, error: 'booking_store_failed' });
    }

    const indexed = await reserveBookedSpan(b);
    if (!indexed || indexed.ok === false) {
      const error = (indexed && indexed.error) || 'occupancy_incomplete';
      const status = error === 'booking_slot_unavailable' ? 409 : 503;
      console.warn('[submit-booking] finalize occupancy incomplete', {
        draftBookingId: rawDraftId,
        error,
      });
      return json(status, occupancyFailureBody(rawDraftId, error));
    }

    return withConfirmationGate(rawDraftId, async () => {
      const claim = await claimConfirmation(store, rawDraftId);
      if (!claim.owner) {
        const current = await waitForConfirmedBooking(store, rawDraftId);
        if (recordIsConfirmed(current)) {
          return respondIfSpanConfirmed(store, current, event, { idempotent: true });
        }
        return json(503, occupancyFailureBody(rawDraftId, 'occupancy_incomplete'));
      }

      b.occupancyStatus = 'complete';
      b.occupancyPendingAt = existing.occupancyPendingAt || pending.occupancyPendingAt;
      const readyBeforeConfirm = await bookedSpanReady(b);
      if (!readyBeforeConfirm.ok || !readyBeforeConfirm.complete) {
        return json(503, occupancyFailureBody(
          rawDraftId,
          readyBeforeConfirm.ok ? 'occupancy_incomplete' : 'booking_verification_unavailable'
        ));
      }
      if (claim.nonce) {
        const seen = await store.get(claim.key, { type: 'text' }).catch(() => null);
        if (seen && !String(seen).includes(claim.nonce)) {
          const current = await store.get(rawDraftId, { type: 'json' }).catch(() => null);
          if (recordIsConfirmed(current)) {
            return respondIfSpanConfirmed(store, current, event, { idempotent: true });
          }
          return json(503, occupancyFailureBody(rawDraftId, 'occupancy_incomplete'));
        }
      }

      b.notificationsClaimedAt = new Date().toISOString();
      let stored = { saved: false };
      try {
        const meta = await readBookingMeta(store, rawDraftId);
        const fresh = meta && meta.data;
        if (recordIsConfirmed(fresh)) {
          return respondIfSpanConfirmed(store, fresh, event, { idempotent: true });
        }
        if (meta && meta.etag) {
          const writeResult = await store.setJSON(rawDraftId, b, { onlyIfMatch: meta.etag });
          if (writeResult && writeResult.modified === false) {
            const raced = await store.get(rawDraftId, { type: 'json' }).catch(() => null);
            if (recordIsConfirmed(raced)) {
              return respondIfSpanConfirmed(store, raced, event, { idempotent: true });
            }
            return json(503, occupancyFailureBody(rawDraftId, 'occupancy_incomplete'));
          }
          stored = { saved: true };
        }
        if (!stored.saved) {
          await store.setJSON(rawDraftId, b);
          stored = { saved: true };
        }
      } catch (e) {
        return json(503, occupancyFailureBody(rawDraftId, 'occupancy_incomplete'));
      }

      const ready = await bookedSpanReady(b);
      if (!ready.ok || !ready.complete) {
        try { await store.setJSON(rawDraftId, pending); } catch { /* retry uses occupancyPendingAt when the revert does not land */ }
        return json(503, occupancyFailureBody(
          rawDraftId,
          ready.ok ? 'occupancy_incomplete' : 'booking_verification_unavailable'
        ));
      }

      try {
        const { scheduleBookingMirror } = require('../lib/booking-prisma-mirror');
        scheduleBookingMirror(b);
      } catch { /* ignore */ }

      const withDelivery = await notifyConfirmedBooking(store, b, event);
      console.log('[submit-booking] finalize ok', {
        draftBookingId: b.id,
        setupIntentIdPrefix: siIdPrefix(b.setupIntentId),
        cardOnFileStatus: b.cardOnFileStatus || null,
        responseCode: 200,
        bookingVersion: b.bookingVersion || 1,
      });
      return confirmedBookingResponse(withDelivery, { stored, withDelivery });
    });
  }

  // Unsigned direct creates remain disabled. Both no-card requests and saved-card
  // flows must use the signed draft/finalize protocol above.
  return json(409, { ok: false, error: 'card_on_file_required' });
  } finally {
    clearOfferDeployHost();
  }
};

exports.__test = {
  setPreviewTransactionGuardOverride(fn) {
    previewTransactionGuardOverride = typeof fn === 'function' ? fn : null;
  },
  setBlobsStoreOverride(fn) {
    blobsStoreOverride = typeof fn === 'function' ? fn : null;
  },
  setSlotScanTimeoutMs(ms) {
    slotScanTimeoutMs = Math.max(0, Math.round(Number(ms) || 0));
  },
  resolveSlotScanTimeoutMs,
  buildDraftRecord,
  issueDraftSaveResponse,
  reconcileCardOnFileFromStripe,
  deliverBookingCreatedNotifications,
  bookingCreatedNotificationsIncomplete,
  notificationAttempts() { return bookingNotificationAttempts; },
  resetNotificationAttempts() { bookingNotificationAttempts = 0; },
};
