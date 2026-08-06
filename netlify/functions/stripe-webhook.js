// netlify/functions/stripe-webhook.js
// Validates Stripe webhook signatures. Customer-balance PaymentIntent events
// are reconciled transactionally through Postgres; legacy Checkout money
// events are isolated. Non-balance operational events retain their existing
// compatibility handlers.
//
// Canonical paymentStatus enum:
//   no_payment_required_yet | authorization_pending | authorized |
//   authorization_failed | capture_pending | paid | canceled |
//   refunded | expired
//
// Dispatch rule: auction is only posted when paymentStatus transitions to
// 'authorized' (amount_capturable_updated) — never on cash/pending bookings.
//
// Env (Netlify):
//   STRIPE_WEBHOOK_SECRET  whsec_... (Stripe → Developers → Webhooks)
//   ADMIN_EMAIL + RESEND_API_KEY  (optional) → email notifications
//   BID_SECRET  (required for auction/dispatch)
//   SITE_URL    (required for bid magic links)

const crypto = require('crypto');
const { enqueueSms } = require('../lib/sms-outbox');
const { TEMPLATE_KEYS } = require('../lib/sms-templates');
let blobsStoreOverride = null;

async function blobsStore(name) {
  if (typeof blobsStoreOverride === 'function') return blobsStoreOverride(name);
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

// ── Customer subscription blob helpers ──
async function activateCustomerSubscription(sess, meta) {
  try {
    const store = await blobsStore('cd1-subscriptions');
    const stripeSubId = sess.subscription || '';
    const listing = await store.list().catch(() => ({ blobs: [] }));
    const existing = stripeSubId
      ? (await Promise.all(
          ((listing && listing.blobs) || []).map(b => store.get(b.key, { type: 'json' }).catch(() => null))
        )).find(s => s && s.stripeSubscriptionId === stripeSubId)
      : null;

    const now = new Date().toISOString();
    const { CAR_PACKAGES } = require('../lib/customer-catalog');
    const pack = CAR_PACKAGES.find(p => p.id === meta.packId);
    const id = existing ? existing.id : ('SUB-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase());
    const sub = {
      ...(existing || {}),
      id,
      customerName: meta.customerName || existing?.customerName || '',
      email: (meta.email || existing?.email || '').toLowerCase(),
      phone: String(meta.phone || existing?.phone || '').replace(/\D/g, '').slice(0, 15),
      planId: meta.packId || existing?.planId || 'maint',
      planName: pack ? pack.name : (existing?.planName || 'Maintenance Detail'),
      fleetId: meta.fleetId || existing?.fleetId || null,
      intervalMonths: 1,
      price: Number(meta.monthlyPrice) || existing?.price || 0,
      billingCycle: 'monthly',
      status: 'active',
      maxDetailsPerMonth: 1,
      vehicle: meta.vehicle || existing?.vehicle || '',
      bookingId: meta.bookingId || existing?.bookingId || '',
      stripeSubscriptionId: stripeSubId,
      stripeCustomerId: sess.customer || existing?.stripeCustomerId || null,
      stripeCheckoutSessionId: sess.id,
      activatedAt: now,
      notes: existing?.notes || 'Stripe subscription checkout — auto-activated',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await store.setJSON(id, sub);
    return { activated: true, id };
  } catch (e) {
    return { activated: false, reason: e.message };
  }
}

async function cancelSubscriptionByStripeId(stripeSubId) {
  if (!stripeSubId) return { cancelled: false, reason: 'no_stripe_sub_id' };
  try {
    const store = await blobsStore('cd1-subscriptions');
    const listing = await store.list().catch(() => ({ blobs: [] }));
    const subs = await Promise.all(
      ((listing && listing.blobs) || []).map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    );
    const sub = subs.find(s => s && s.stripeSubscriptionId === stripeSubId);
    if (!sub) return { cancelled: false, reason: 'subscription_not_found' };
    sub.status = 'cancelled';
    sub.cancelledAt = new Date().toISOString();
    sub.updatedAt = sub.cancelledAt;
    await store.setJSON(sub.id, sub);
    return { cancelled: true, id: sub.id };
  } catch (e) {
    return { cancelled: false, reason: e.message };
  }
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  let timestamp = null;
  const signatures = [];
  sigHeader.split(',').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't' && timestamp == null) timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  });
  if (!timestamp || !signatures.length || !/^\d+$/.test(timestamp)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > 300) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected);
  return signatures.some((signature) => {
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

const CUSTOMER_BALANCE_PAYMENT_INTENT_EVENTS = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.requires_action',
]);
const LEGACY_OPERATIONAL_PAYMENT_INTENT_EVENTS = new Set([
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.requires_action',
]);

function classifyPaymentIntentRoute(evt, paymentIntent) {
  const type = String(evt?.type || '').trim();
  const purpose = String(paymentIntent?.metadata?.purpose || '').trim();
  if (!type.startsWith('payment_intent.')) return { route: 'not_payment_intent', purpose };
  if (purpose === 'customer_balance') {
    return CUSTOMER_BALANCE_PAYMENT_INTENT_EVENTS.has(type)
      ? { route: 'customer_balance', purpose }
      : { route: 'unsupported_customer_balance_event', purpose };
  }
  if (purpose === 'authoritative_balance') {
    return LEGACY_OPERATIONAL_PAYMENT_INTENT_EVENTS.has(type)
      ? { route: 'legacy_operational', purpose }
      : { route: 'unsupported_legacy_event', purpose };
  }
  // PaymentIntents created before purpose metadata existed remain eligible for
  // the preexisting operational handler. This compatibility path is explicit,
  // bounded to the known legacy event set, and never touches PostgreSQL money.
  if (!purpose) {
    return LEGACY_OPERATIONAL_PAYMENT_INTENT_EVENTS.has(type)
      ? { route: 'legacy_operational_unmarked', purpose }
      : { route: 'unsupported_legacy_event', purpose };
  }
  return { route: 'unknown_purpose', purpose };
}

// ── Read booking, apply updates, write back to Blobs ──
async function reconcilePostgresPaymentIntent(evt, paymentIntent) {
  const meta = paymentIntent && typeof paymentIntent.metadata === 'object'
    ? paymentIntent.metadata
    : {};
  const purpose = String(meta.purpose || '').trim();
  const bookingId = String(meta.bookingId || meta.booking_id || '').trim();
  if (purpose !== 'customer_balance') {
    return { handled: false, skipped: true, reason: 'non_balance_purpose' };
  }

  try {
    const {
      postgresPaymentEnabled,
      syncBlobCompatibilityFromProjection,
    } = require('../lib/db/operational-payment');
    if (!postgresPaymentEnabled()) {
      return { handled: false, error: 'postgres_payment_disabled', bookingId };
    }

    const {
      reconcilePaymentIntentEvent,
      getFinancialProjection,
    } = require('../lib/db/payment-authority-service');
    const result = await reconcilePaymentIntentEvent({
      stripeEventId: evt.id,
      type: evt.type,
      paymentIntent,
      eventCreatedAt: evt.created,
    });
    if (!result.ok) {
      return {
        handled: false,
        error: result.error || 'postgres_reconcile_failed',
        retryable: true,
        failureRecorded: !!result.failureRecorded,
        bookingId,
      };
    }

    const projection = result.projection || await getFinancialProjection(bookingId);
    const sync = projection
      ? await syncBlobCompatibilityFromProjection(bookingId, projection).catch(() => ({ ok: false }))
      : { ok: false };
    return {
      handled: !!projection && sync?.ok !== false,
      retryable: !projection || sync?.ok === false,
      error: !projection
        ? 'projection_unavailable'
        : (sync?.ok === false ? 'compatibility_sync_failed' : null),
      result: {
        ok: true,
        duplicate: !!result.duplicate,
        ignored: !!result.ignored,
        terminal: result.terminal || null,
      },
      projection,
      bookingId,
    };
  } catch {
    return { handled: false, error: 'postgres_reconcile_failed', retryable: true, bookingId };
  }
}

async function reconcilePostgresRefund(evt, refund) {
  const meta = refund && typeof refund.metadata === 'object' ? refund.metadata : {};
  const purpose = String(meta.purpose || '').trim();
  const bookingId = String(meta.bookingId || meta.booking_id || '').trim();
  if (purpose !== 'customer_refund') {
    return { handled: false, skipped: true, reason: 'non_customer_refund', bookingId };
  }
  try {
    const {
      postgresPaymentEnabled,
      syncBlobCompatibilityFromProjection,
    } = require('../lib/db/operational-payment');
    if (!postgresPaymentEnabled()) {
      return { handled: false, error: 'postgres_payment_disabled', retryable: true, bookingId };
    }
    const {
      reconcileRefundEvent,
      getFinancialProjection,
    } = require('../lib/db/payment-authority-service');
    const result = await reconcileRefundEvent({
      stripeEventId: evt.id,
      type: evt.type,
      refund,
      eventCreatedAt: evt.created,
    });
    if (!result.ok) {
      return {
        handled: false,
        error: result.error || 'refund_reconcile_failed',
        retryable: true,
        failureRecorded: !!result.failureRecorded,
        bookingId,
      };
    }
    const projection = result.projection || await getFinancialProjection(bookingId);
    const sync = projection
      ? await syncBlobCompatibilityFromProjection(bookingId, projection).catch(() => ({ ok: false }))
      : { ok: false };
    return {
      handled: !!projection && sync?.ok !== false,
      retryable: !projection || sync?.ok === false,
      error: !projection
        ? 'projection_unavailable'
        : (sync?.ok === false ? 'compatibility_sync_failed' : null),
      result,
      projection,
      bookingId,
    };
  } catch {
    return { handled: false, error: 'refund_reconcile_failed', retryable: true, bookingId };
  }
}

async function updateBookingPayment(bookingId, updates) {
  if (!bookingId || bookingId === '—') {
    return { updated: false, reason: 'no booking_id in Stripe metadata' };
  }
  try {
    const store = await blobsStore('cd1-bookings');
    const booking = await store.get(bookingId, { type: 'json' });
    if (!booking) return { updated: false, reason: 'booking not found: ' + bookingId };
    const updated = { ...booking, ...updates, updatedAt: new Date().toISOString() };
    await store.setJSON(bookingId, updated);
    return { updated: true, booking: updated };
  } catch (e) {
    return { updated: false, reason: e.message };
  }
}

async function updateSetupIntentState(evt, setupIntent, status) {
  const metadata = setupIntent && typeof setupIntent.metadata === 'object'
    ? setupIntent.metadata
    : {};
  const bookingId = String(metadata.bookingId || metadata.booking_id || '').trim();
  const purpose = String(metadata.purpose || '').trim();
  if (!bookingId || !setupIntent?.id || purpose !== 'card_on_file') {
    return { updated: false, retryable: false, reason: 'setup_intent_binding_missing' };
  }
  try {
    const store = await blobsStore('cd1-bookings');
    const {
      getBookingRecord,
      commitBooking,
    } = require('../lib/booking-repository');
    const { buildNextAggregate } = require('../lib/booking-aggregate');
    const rec = await getBookingRecord(bookingId, { storeOverride: store });
    if (!rec.exists || !rec.booking) {
      return { updated: false, retryable: true, reason: 'booking_not_found' };
    }
    const booking = rec.booking;
    if (booking.setupIntentId !== setupIntent.id) {
      return { updated: false, retryable: true, reason: 'setup_intent_mismatch' };
    }
    if (!booking.stripeCustomerId
      || !setupIntent.customer
      || booking.stripeCustomerId !== setupIntent.customer) {
      return { updated: false, retryable: false, reason: 'stripe_customer_mismatch' };
    }
    if (status === 'saved' && !/^pm_[A-Za-z0-9]+$/.test(String(setupIntent.payment_method || ''))) {
      return { updated: false, retryable: false, reason: 'payment_method_binding_missing' };
    }
    if (booking.lastSetupIntentEventId === evt.id
      || (status === 'saved'
        && booking.cardOnFileStatus === 'saved'
        && booking.stripePaymentMethodId === setupIntent.payment_method)
      || (status !== 'saved' && booking.cardOnFileStatus === 'saved')) {
      return { updated: true, duplicate: true };
    }

    const now = new Date().toISOString();
    const patch = status === 'saved'
      ? {
          cardOnFileStatus: 'saved',
          setupIntentId: setupIntent.id,
          stripeCustomerId: setupIntent.customer || booking.stripeCustomerId || null,
          stripePaymentMethodId: setupIntent.payment_method || null,
          cardOnFileSavedAt: now,
          lastSetupIntentEventId: evt.id,
          updatedAt: now,
        }
      : {
          cardOnFileStatus: 'failed',
          lastSetupIntentEventId: evt.id,
          updatedAt: now,
        };
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: Math.round(Number(booking.bookingVersion) || 0),
      nextAggregate: buildNextAggregate(booking, patch),
      storeOverride: store,
    });
    return committed.ok
      ? { updated: true, duplicate: false }
      : { updated: false, retryable: true, reason: committed.error || 'version_conflict' };
  } catch {
    return { updated: false, retryable: true, reason: 'setup_intent_state_failed' };
  }
}

// ── HMAC signature for tech bid magic links ──
function signBid(jobId, techId, secret) {
  return crypto.createHmac('sha256', secret)
    .update(String(jobId) + '|' + String(techId))
    .digest('hex');
}

// ── Create auction + optionally SMS techs (idempotent — skips if already exists) ──
// Dispatch is intentionally SMS-gated: Twilio vars must be set in production.
// In test/dev environments without Twilio, the auction record is created in
// Blobs but no messages are sent (notified: 0). This is the correct test mode
// behavior — admin can still see the auction in the dashboard.
async function triggerAuction(b) {
  const secret = process.env.BID_SECRET;
  if (!secret) return { posted: false, reason: 'BID_SECRET not set' };
  try {
    // Idempotency guard: do not create a second auction for the same booking.
    const existing = await (await blobsStore('cd1-auctions')).get(b.id, { type: 'json' });
    if (existing) return { posted: false, reason: 'auction already exists for ' + b.id };

    const roster = (await (await blobsStore('cd1-techs')).get('roster', { type: 'json' })) || [];
    // Job object stored in auction. 'total' is admin-visible; techView() in
    // auction.js strips it before returning data to technicians.
    const job = {
      package: b.package || '',
      vehicle: b.vehicle || b.vehicleCategory || '',
      date: b.preferredDate || '',
      time: b.preferredTime || '',
      area: b.zone || b.zipCode || '',
      total: b.totalPrice || 0,
    };
    await (await blobsStore('cd1-auctions')).setJSON(b.id, {
      jobId: b.id,
      status: 'open',
      job,
      bids: [],
      winner: null,
      createdAt: new Date().toISOString(),
      paymentStatus: b.paymentStatus || 'authorized',
      amountAuthorizedCents: b.amountAuthorizedCents || 0,
    });

    const base = process.env.SITE_URL || '';
    let notified = 0;
    if (base && roster.length) {
      await Promise.all(roster.map(async (t) => {
        const sig = signBid(b.id, t.id, secret);
        const link = `${base}/bid.html?job=${encodeURIComponent(b.id)}&tech=${encodeURIComponent(t.id)}&sig=${sig}`;
        const queued = await enqueueSms({
          idempotencyKey: `tech.auction:${b.id}:${t.id}`,
          audience: 'technician',
          consentGranted: t.smsConsent === true,
          toE164: t.phone,
          bookingId: b.id,
          templateKey: TEMPLATE_KEYS.TECH_AUCTION,
          templateData: {
            service: job.package,
            date: job.date,
            area: job.area,
            url: link,
          },
        });
        if (queued.ok && queued.queued) notified += 1;
      }));
    }
    return { posted: true, techs: roster.length, notified };
  } catch (e) {
    return { posted: false, reason: e.message };
  }
}

async function notifyAdmin(subject, text) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [ADMIN_EMAIL],
        subject,
        text,
      }),
    });
  } catch (e) { console.warn('[webhook] email error:', e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — rejecting all events');
    return { statusCode: 503, body: 'Webhook secret not configured' };
  }
  const sigValid = verifyStripeSignature(raw, sig, webhookSecret);
  console.log('[stripe-webhook] received', { bodyLength: raw.length, signatureValid: sigValid });
  if (!sigValid) {
    console.error('[stripe-webhook] signature verification FAILED — check STRIPE_WEBHOOK_SECRET matches the endpoint signing secret in Stripe Dashboard');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let evt;
  try { evt = JSON.parse(raw); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const pi = (evt.data && evt.data.object) ? evt.data.object : {};
  const bookingId = (pi.metadata && (pi.metadata.booking_id || pi.metadata.bookingId)) || '—';
  const dollars = pi.amount != null ? (pi.amount / 100).toFixed(2) : '?';
  const results = {};

  // Route every PaymentIntent exactly once. Customer balances use PostgreSQL;
  // the explicitly identified legacy operational/auction flow stays on its
  // preexisting Blob handler until all in-flight legacy intents have expired.
  if (String(evt.type || '').startsWith('payment_intent.')) {
    const paymentRoute = classifyPaymentIntentRoute(evt, pi);
    if (paymentRoute.route === 'unknown_purpose'
      || paymentRoute.route === 'unsupported_customer_balance_event'
      || paymentRoute.route === 'unsupported_legacy_event') {
      console.warn('[stripe-webhook] PaymentIntent ignored by explicit router', {
        type: evt.type,
        route: paymentRoute.route,
        purpose: paymentRoute.purpose || 'missing',
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ received: true, ignored: true, reason: paymentRoute.route }),
      };
    }
    if (paymentRoute.route === 'customer_balance') {
      const postgres = await reconcilePostgresPaymentIntent(evt, pi);
      if (!postgres.handled) {
        console.warn('[stripe-webhook] authoritative payment retry requested', {
          type: evt.type,
          error: postgres.error || 'processing_failed',
          failureRecorded: !!postgres.failureRecorded,
        });
        return {
          statusCode: 500,
          body: JSON.stringify({
            received: false,
            retryable: true,
            error: postgres.error || 'processing_failed',
          }),
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          received: true,
          type: evt.type,
          route: paymentRoute.route,
          duplicate: !!postgres.result?.duplicate,
        }),
      };
    }
    results.paymentIntentRoute = paymentRoute.route;
  }

  // Hosted Checkout never settles a booking balance. Old sessions are
  // acknowledged and isolated so they cannot become a second ledger writer.
  if (evt.type === 'checkout.session.completed'
    && String(pi.metadata?.purpose || '') === 'customer_balance') {
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, ignored: true, reason: 'legacy_checkout_isolated' }),
    };
  }

  if (['refund.created', 'refund.updated', 'refund.failed'].includes(evt.type)) {
    const refund = evt.data?.object || {};
    const postgres = await reconcilePostgresRefund(evt, refund);
    if (!postgres.handled) {
      if (postgres.skipped) {
        return {
          statusCode: 200,
          body: JSON.stringify({ received: true, ignored: true, reason: postgres.reason }),
        };
      }
      return {
        statusCode: 500,
        body: JSON.stringify({
          received: false,
          retryable: true,
          error: postgres.error || 'refund_reconcile_failed',
        }),
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true,
        type: evt.type,
        duplicate: !!postgres.result?.duplicate,
      }),
    };
  }

  // charge.refunded is only a summary and can represent multiple partial
  // refunds. Stripe recommends refund.created for refund-level information.
  if (evt.type === 'charge.refunded') {
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, ignored: true, reason: 'refund_detail_event_preferred' }),
    };
  }

  switch (evt.type) {

    case 'payment_intent.amount_capturable_updated': {
      // capture_method=manual: card is authorized (hold placed). This is the
      // signal that dispatch is now allowed.
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'authorized',
        paymentIntentId: pi.id,
        amountAuthorizedCents: pi.amount,
      });
      // Trigger auction only if the Blobs write succeeded.
      if (results.update.updated) {
        results.auction = await triggerAuction(results.update.booking);
      }
      await notifyAdmin(
        `Cardetail1 — card authorized $${dollars} · ${bookingId}`,
        `Card hold authorized for booking ${bookingId}.\n` +
        `Amount: $${dollars}\nPaymentIntent: ${pi.id}\n` +
        `Dispatch triggered: ${results.auction ? JSON.stringify(results.auction) : 'n/a'}\n\n` +
        `Capture the final amount after service via the admin panel.`
      );
      break;
    }

    case 'payment_intent.succeeded': {
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'paid',
        paymentIntentId: pi.id,
        amountCapturedCents: pi.amount_received != null ? pi.amount_received : pi.amount,
        capturedAt: new Date().toISOString(),
      });
      await notifyAdmin(
        `Cardetail1 — payment captured $${dollars} · ${bookingId}`,
        `Payment of $${dollars} captured for booking ${bookingId}.\nPaymentIntent: ${pi.id}`
      );
      break;
    }

    case 'payment_intent.payment_failed': {
      const reason = (pi.last_payment_error && pi.last_payment_error.message) || 'unknown';
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'authorization_failed',
        paymentIntentId: pi.id,
        paymentFailureReason: reason,
      });
      await notifyAdmin(
        `Cardetail1 — payment FAILED · ${bookingId}`,
        `Payment failed for booking ${bookingId}.\nPaymentIntent: ${pi.id}`
      );
      break;
    }

    case 'payment_intent.canceled': {
      const cancelReason = pi.cancellation_reason || 'unknown';
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'canceled',
        paymentIntentId: pi.id,
        paymentCancelReason: cancelReason,
      });
      await notifyAdmin(
        `Cardetail1 — payment CANCELED · ${bookingId}`,
        `PaymentIntent canceled for booking ${bookingId}.\nPaymentIntent: ${pi.id}`
      );
      break;
    }

    case 'payment_intent.requires_action': {
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'authorization_pending',
        paymentWorkflowStatus: 'payment_action_required',
        paymentIntentId: pi.id,
      });
      break;
    }

    case 'setup_intent.succeeded': {
      // Customer saved card on file. Update booking with cardOnFileStatus.
      // This does NOT set paymentStatus — card-on-file is tracked separately.
      // Admin may charge the saved card only according to the cancellation/no-show policy.
      const si = evt.data.object;
      const siBookingId = (si.metadata && (si.metadata.bookingId || si.metadata.booking_id)) || '—';
      console.log('[stripe-webhook] setup_intent.succeeded received');
      results.update = await updateSetupIntentState(evt, si, 'saved');
      if (!results.update.updated) {
        return {
          statusCode: results.update.retryable ? 500 : 400,
          body: JSON.stringify({ received: false, error: results.update.reason }),
        };
      }
      await notifyAdmin(
        `Cardetail1 — card on file saved · ${siBookingId}`,
        `Customer saved card on file for booking ${siBookingId}.\n` +
        `Payment method reference stored. No charge applied.\n` +
        `Admin may only charge per the posted cancellation/no-show policy.`
      );
      break;
    }

    case 'setup_intent.setup_failed': {
      const si = evt.data.object;
      const siBookingId = (si.metadata && (si.metadata.bookingId || si.metadata.booking_id)) || '—';
      results.update = await updateSetupIntentState(evt, si, 'failed');
      if (!results.update.updated) {
        return {
          statusCode: results.update.retryable ? 500 : 400,
          body: JSON.stringify({ received: false, error: results.update.reason }),
        };
      }
      console.log('[stripe-webhook] setup_intent.setup_failed received');
      break;
    }

    case 'checkout.session.completed': {
      const sess = evt.data.object;
      const meta = sess.metadata || {};
      if (meta.type === 'customer_subscription' &&
          sess.mode === 'subscription' &&
          sess.payment_status === 'paid' &&
          sess.subscription) {
        results.subscription = await activateCustomerSubscription(sess, meta);
        await notifyAdmin(
          `Cardetail1 — subscription activated · ${meta.email || '—'}`,
          `Customer subscription checkout completed.\nPlan: ${meta.packId || '—'}\nEmail: ${meta.email || '—'}\nVehicle: ${meta.vehicle || '—'}\nStripe sub: ${sess.subscription || '—'}`
        );
      } else if (meta.purpose === 'customer_balance' && sess.payment_status === 'paid') {
        const bookingId = String(meta.booking_id || meta.bookingId || '').trim();
        if (bookingId) {
          // Prefer Postgres PI reconcile when the session produced a PaymentIntent
          // that PaymentAuthorityService reserved (embedded pay path).
          const piId = typeof sess.payment_intent === 'string'
            ? sess.payment_intent
            : (sess.payment_intent && sess.payment_intent.id) || null;
          if (piId) {
            results.postgres = await reconcilePostgresPaymentIntent(evt, {
              id: piId,
              status: 'succeeded',
              amount_received: sess.amount_total,
              amount: sess.amount_total,
              metadata: {
                bookingId,
                booking_id: bookingId,
                purpose: 'customer_balance',
                quoteVersion: meta.quoteVersion,
              },
            });
          }

          if (!(results.postgres && results.postgres.handled)) {
            const {
              applyCustomerBalanceReconciliation,
              financialProjection,
              logPaymentReconciliation,
            } = require('../lib/payment-service');
            const { getBookingRecord, commitBooking } = require('../lib/booking-repository');
            const beforeRec = await getBookingRecord(bookingId);
            const localBefore = beforeRec.exists ? financialProjection(beforeRec.booking) : null;
            const applied = await applyCustomerBalanceReconciliation({
              bookingId,
              session: sess,
              getBookingRecord,
              commitBooking,
              stripeEventId: evt.id,
            });
            const localAfter = applied.booking
              ? financialProjection(applied.booking)
              : (applied.projection || localBefore);
            logPaymentReconciliation({
              bookingId,
              stripeEventId: evt.id,
              checkoutSessionId: sess.id,
              paymentIntentId: sess.payment_intent,
              localBefore,
              providerState: { payment_status: sess.payment_status, type: evt.type },
              localAfter,
              adminProjection: localAfter,
            });
            if (applied.ok) {
              results.customerBalance = {
                ok: true,
                duplicate: !!applied.duplicate,
                creditCents: applied.creditCents,
                attempts: applied.attempts,
                projection: localAfter,
              };
            } else if (applied.quarantined) {
              results.customerBalance = { ok: false, quarantined: true, error: applied.error };
              console.warn('[stripe-webhook] customer_balance quarantined', bookingId, applied.error);
            } else if (applied.retryable || applied.error === 'version_conflict' || applied.error === 'not_found') {
              results.customerBalance = {
                ok: false,
                retryable: true,
                error: applied.error,
                statusCode: applied.statusCode || 500,
              };
              console.warn('[stripe-webhook] customer_balance retryable failure', bookingId, applied.error);
              return {
                statusCode: 500,
                body: JSON.stringify({ received: false, retryable: true, ...results }),
              };
            } else {
              results.customerBalance = { ok: false, error: applied.error, statusCode: applied.statusCode };
            }
          } else {
            results.customerBalance = {
              ok: true,
              authority: 'postgres',
              projection: results.postgres.projection,
            };
          }
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const stripeSub = evt.data.object;
      results.subscription = await cancelSubscriptionByStripeId(stripeSub.id);
      break;
    }

    default:
      // Log unexpected event types to help with future debugging.
      if (evt.type) console.log('[stripe-webhook] unhandled event type:', evt.type);
      break;
  }

  console.log('[stripe-webhook] processed', {
    type: evt.type,
    bookingMutation: !!results.update?.updated,
    subscriptionMutation: !!results.subscription,
  });
  return {
    statusCode: 200,
    body: JSON.stringify({
      received: true,
      type: evt.type,
      ...(results.paymentIntentRoute ? { route: results.paymentIntentRoute } : {}),
    }),
  };
};

exports.__test = {
  verifyStripeSignature,
  classifyPaymentIntentRoute,
  updateSetupIntentState,
  setBlobsStoreOverride(fn) {
    blobsStoreOverride = typeof fn === 'function' ? fn : null;
  },
};
