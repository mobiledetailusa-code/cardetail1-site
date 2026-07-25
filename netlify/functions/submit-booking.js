// netlify/functions/submit-booking.js
// Accepts a booking, assigns a server-side ID, stores to Netlify Blobs,
// notifies admin, and optionally sends customer confirmation.
//
// Security model:
//   C-1: paymentStatus can only be set by stripe-webhook.js (HMAC-verified).
//        This endpoint never trusts client-submitted payment state.
//   C-3: Booking ID is always generated server-side. Client-submitted id/bookingId
//        are ignored. Collision-checked against Blobs before writing.
//   Draft mode: Step 5 pre-registers a minimal booking so create-setup-intent
//        can create a SetupIntent tied to a server-owned booking ID.
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
];

const PAYMENT_PREFERENCES = new Set([
  'cash_onsite',
  'card_onsite',
  'online_after_service',
]);

const CARD_ON_FILE_VERIFY_MSG =
  'Your card is still being verified. Please wait a few seconds and try again.';

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
const { validateBookingSchedule, hasSlotConflict } = require('../lib/booking-schedule');
const { listRawBookings, normalizePhone } = require('../lib/ops-db');
const { validateBookingRouting } = require('../lib/booking-routing-validation');
const {
  applyServerOffersToBooking,
  stripClientOfferFields,
  CLIENT_OFFER_BLOCKED_FIELDS,
} = require('../lib/booking-offers');
const { setOfferDeployHost, clearOfferDeployHost } = require('../lib/revenue-offers');
const { sendNotificationsDecoupled, attachDeliveryToBooking } = require('../lib/notification-delivery');
const {
  reconcileCardOnFileFromStripe,
  siIdPrefix,
} = require('../lib/card-on-file');

async function enforceScheduleFields(b, { checkSlot = false, excludeId = null } = {}) {
  const v = validateBookingSchedule(b.preferredDate, b.preferredTime);
  if (!v.ok) return { ok: false, error: v.error };
  b.preferredDate = v.preferredDate;
  b.preferredTime = v.preferredTime;
  if (checkSlot) {
    const bookings = await listRawBookings().catch(() => []);
    if (hasSlotConflict(bookings, v.preferredDate, v.preferredTime, excludeId)) {
      return { ok: false, error: 'booking_slot_unavailable' };
    }
  }
  return { ok: true };
}

let blobsStoreOverride = null;

async function blobsStore(name) {
  if (typeof blobsStoreOverride === 'function') {
    return blobsStoreOverride(name);
  }
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

function buildDraftRecord(b, draftId, now, existing = null) {
  const preference = String(b.paymentMethodPreference || '');
  return {
    id: draftId,
    isDraft: true,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    totalPrice: Number(b.totalPrice) || 0,
    paymentMethod: preference,
    paymentMethodPreference: preference,
    cardOnFileRequired: true,
    cardOnFileStatus: existing ? existing.cardOnFileStatus : 'pending',
    paymentStatus: existing ? existing.paymentStatus : 'no_payment_required_yet',
    appointmentStatus: existing ? existing.appointmentStatus : 'pending_review',
    jobStatus: existing ? existing.jobStatus : 'not_started',
    acceptedCardOnFilePolicy: true,
    acceptedCardOnFilePolicyAt: existing ? existing.acceptedCardOnFilePolicyAt : now,
    policyVersion: '2026-06-card-on-file',
    setupIntentId: existing ? existing.setupIntentId : undefined,
    stripeCustomerId: existing ? existing.stripeCustomerId : undefined,
    stripePaymentMethodId: existing ? existing.stripePaymentMethodId : undefined,
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
    waterAvailable: b.waterAvailable || '',
    electricityAvailable: b.electricityAvailable || '',
    serviceLocation: b.serviceLocation || '',
    accessNotes: b.accessNotes || '',
    offer: b.offer || existing?.offer || null,
    welcomeOffer: b.welcomeOffer || existing?.welcomeOffer || null,
    approvedFinalAmount: b.approvedFinalAmount ?? existing?.approvedFinalAmount ?? null,
    discountAmount: b.discountAmount ?? existing?.discountAmount ?? 0,
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
      id: draft.id,
      isDraft: true,
      draftSaveToken: tokenResult.token,
      draftSaveTokenExp: tokenResult.draftSaveTokenExp,
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
    `Payment preference: ${b.paymentMethodPreference || '—'}`,
    `Card on file: ${b.cardOnFileStatus || 'pending'}`,
    `Appointment: ${b.appointmentStatus || 'pending_review'}`,
    b.paymentIntentId ? `PaymentIntent: ${b.paymentIntentId}` : '',
    ``,
    `Customer: ${b.firstName || ''} ${b.lastName || ''}`,
    `Phone:    ${b.phone || ''}`,
    `Email:    ${b.email || ''}`,
    `Address:  ${b.address || ''}`,
    `ZIP/Zone: ${b.zipCode || ''} ${b.zone ? '· ' + b.zone : ''}`,
    `Date:     ${b.preferredDate || ''} ${b.preferredTime || ''}`,
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
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [ADMIN_EMAIL],
      reply_to: b.email || undefined,
      subject: `New Cardetail1 Booking ${b.id} — ${b.firstName || ''} ${b.lastName || ''} ($${b.totalPrice || 0}) · ${b.paymentStatus || 'pending'}`,
      text: bookingText(b),
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
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, ADMIN_SMS } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !ADMIN_SMS) return { sent: false, reason: 'sms not configured' };
  const body = new URLSearchParams({
    To: ADMIN_SMS,
    From: TWILIO_FROM,
    Body: `New booking ${b.id}: ${b.firstName || ''} ${b.lastName || ''} · ${b.package || b.service || ''} · $${b.totalPrice || 0} · ${b.preferredDate || ''} · pay:${b.paymentStatus || 'unknown'} · ${b.phone || ''}`,
  });
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `twilio ${res.status}: ${err}` };
  }
  return { sent: true };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
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

  const welcomeSource = String(b.welcomeOfferSource || b.offerSource || '').trim() || null;
  delete b.welcomeOfferSource;
  delete b.offerSource;
  delete b.welcomeOfferAccepted;

  const offerApplied = await applyServerOffersToBooking(b, {
    serviceSubtotal: travelApplied.serviceSubtotal,
    travelFee: b.travelFeeAmount || 0,
    sourceTrigger: welcomeSource,
  }).catch((e) => {
    console.warn('[submit-booking] offer apply failed:', e.message);
    return null;
  });

  const store = await blobsStore('cd1-bookings');

  // ── Draft pre-registration (supports C-2: create-payment-intent fetches amount from Blobs) ──
  if (b.isDraft) {
    const secretStatus = getDraftTokenSecretStatus();
    if (!secretStatus.ok) {
      return json(503, { ok: false, error: 'missing_draft_token_secret' });
    }

    const scheduleDraft = await enforceScheduleFields(b);
    if (!scheduleDraft.ok) {
      return json(400, { ok: false, error: scheduleDraft.error });
    }
    const preference = String(b.paymentMethodPreference || '');
    if (!PAYMENT_PREFERENCES.has(preference)) {
      return json(400, { ok: false, error: 'payment_preference_required' });
    }
    if (b.acceptedCardOnFilePolicy !== true) {
      return json(400, { ok: false, error: 'card_on_file_policy_required' });
    }

    const now = new Date().toISOString();
    const rawUpdateId = String(b.draftBookingId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);
    delete b.draftBookingId;

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
    try {
      await store.setJSON(draftId, draft);
    } catch (e) {
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
      // Idempotent finalize: already submitted booking returns same id/version
      if (existing.finalizedAt || existing.bookingVersion >= 1) {
        return json(200, {
          ok: true,
          id: existing.id,
          bookingVersion: existing.bookingVersion || 1,
          idempotent: true,
        });
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
    const preference = String(b.paymentMethodPreference || '');
    if (!PAYMENT_PREFERENCES.has(preference) || preference !== existing.paymentMethodPreference) {
      return json(400, { ok: false, error: 'invalid_payment_preference' });
    }
    if (b.acceptedCardOnFilePolicy !== true || b.acceptedBookingPolicy !== true) {
      return json(400, { ok: false, error: 'booking_policy_required' });
    }
    const scheduleFinal = await enforceScheduleFields(b, { checkSlot: true, excludeId: rawDraftId });
    if (!scheduleFinal.ok) {
      const status = scheduleFinal.error === 'booking_slot_unavailable' ? 409 : 400;
      return json(status, { ok: false, error: scheduleFinal.error });
    }
    const finalizedAt = new Date().toISOString();

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
      cardOnFileRequired: true,
      acceptedBookingPolicy: true,
      acceptedBookingPolicyAt: finalizedAt,
      acceptedCardOnFilePolicy: true,
      acceptedCardOnFilePolicyAt: existing.acceptedCardOnFilePolicyAt,
      policyVersion: '2026-06-card-on-file',
      // Payment fields: trust Blobs, not the browser
      paymentStatus:        'no_payment_required_yet',
      appointmentStatus:    'pending_review',
      // pending_review (not not_started) so Admin + Customer share the same submitted lifecycle
      jobStatus:            'pending_review',
      portalReleasedAt:     finalizedAt,
      // Card-on-file fields: set by stripe-webhook (setup_intent.succeeded)
      cardOnFileStatus:     existing.cardOnFileStatus,
      setupIntentId:        existing.setupIntentId,
      stripeCustomerId:     existing.stripeCustomerId,
      stripePaymentMethodId: existing.stripePaymentMethodId,
      cardOnFileSavedAt:    existing.cardOnFileSavedAt,
    };

    let stored = { saved: false };
    try {
      await store.setJSON(rawDraftId, b);
      stored = { saved: true };
    } catch (e) {
      return json(500, { ok: false, error: 'booking_store_failed' });
    }
    // Prisma dual-write AFTER Blob finalize — fail-open; never affects checkout response.
    try {
      const { scheduleBookingMirror } = require('../lib/booking-prisma-mirror');
      scheduleBookingMirror(b);
    } catch { /* ignore */ }

    // Admin channels stay on the legacy decoupled helper. Customer
    // request-received email/SMS go through transactional events so they include
    // a secure appointment-access link and stay idempotent by event+channel.
    const delivery = await sendNotificationsDecoupled(b, {
      adminEmail: (booking) => sendEmail(booking).catch((e) => ({ sent: false, reason: e.message })),
      adminSms: (booking) => sendSms(booking).catch((e) => ({ sent: false, reason: e.message })),
    });
    let withDelivery = attachDeliveryToBooking(b, delivery);

    try {
      const { emitRequestReceived } = require('../lib/booking-transactional-notifications');
      const txn = await emitRequestReceived(withDelivery, { event });
      if (txn && txn.booking) {
        withDelivery = txn.booking;
        const custEmailStatus = txn.delivery?.email?.sent
          ? { status: 'sent', at: new Date().toISOString(), reason: null }
          : {
            status: txn.delivery?.email?.skipped ? 'suppressed' : 'failed',
            at: new Date().toISOString(),
            reason: txn.delivery?.email?.reason || null,
          };
        const custSmsStatus = txn.delivery?.sms?.sent
          ? { status: 'sent', at: new Date().toISOString(), reason: null }
          : {
            status: txn.delivery?.sms?.skipped ? 'suppressed' : 'failed',
            at: new Date().toISOString(),
            reason: txn.delivery?.sms?.reason || 'customer_sms_not_enabled',
          };
        withDelivery = {
          ...withDelivery,
          notificationDelivery: {
            ...(withDelivery.notificationDelivery || delivery),
            customerEmail: custEmailStatus,
            customerSms: custSmsStatus,
            updatedAt: new Date().toISOString(),
          },
        };
      }
    } catch (e) {
      console.warn('[submit-booking] transactional notify failed:', e.message);
    }

    try {
      await store.setJSON(rawDraftId, withDelivery);
      try {
        const { scheduleBookingMirror } = require('../lib/booking-prisma-mirror');
        scheduleBookingMirror(withDelivery);
      } catch { /* ignore */ }
    } catch (e) {
      console.warn('[submit-booking] notification delivery persist failed:', e.message);
    }

    console.log('[submit-booking] finalize ok', {
      draftBookingId: b.id,
      setupIntentIdPrefix: siIdPrefix(b.setupIntentId),
      cardOnFileStatus: b.cardOnFileStatus || null,
      responseCode: 200,
      bookingVersion: b.bookingVersion || 1,
    });
    return json(200, {
      ok: true,
      id: b.id,
      status: b.status,
      paymentStatus: b.paymentStatus,
      stored,
      email: withDelivery.notificationDelivery?.adminEmail || delivery.adminEmail,
      customerEmail: withDelivery.notificationDelivery?.customerEmail || { status: 'pending' },
      sms: withDelivery.notificationDelivery?.adminSms || delivery.adminSms,
      notificationDelivery: withDelivery.notificationDelivery || delivery,
      appointmentStatus: b.appointmentStatus,
      cardOnFileStatus: b.cardOnFileStatus,
      bookingVersion: b.bookingVersion || 1,
      offer: b.offer || null,
      approvedFinalAmount: b.approvedFinalAmount || b.totalPrice,
    });
  }

  // ── New booking (cash/on-site or any path that didn't pre-register a draft) ──
  return json(409, { ok: false, error: 'card_on_file_required' });
  } finally {
    clearOfferDeployHost();
  }
};

exports.__test = {
  setBlobsStoreOverride(fn) {
    blobsStoreOverride = typeof fn === 'function' ? fn : null;
  },
  buildDraftRecord,
  issueDraftSaveResponse,
  reconcileCardOnFileFromStripe,
};
