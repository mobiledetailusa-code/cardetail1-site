/**
 * Card-on-file reconciliation helpers.
 * Never trusts browser proof — only persisted setupIntentId + Stripe API status.
 */

function siIdPrefix(id) {
  const s = String(id || '');
  return s ? s.slice(0, 15) : 'none';
}

/**
 * When webhook is delayed, verify SetupIntent directly with Stripe and persist saved state.
 * @returns {Promise<object>} updated booking (or original on no-op/failure)
 */
async function reconcileCardOnFileFromStripe(store, existing, env = process.env, fetchImpl = globalThis.fetch) {
  if (!existing || existing.cardOnFileStatus === 'saved') return existing;
  const setupIntentId = String(existing.setupIntentId || '').trim();
  if (!setupIntentId) {
    console.log('[card-on-file] reconcile skipped: missing setupIntentId', {
      draftBookingId: existing.id || null,
      cardOnFileStatus: existing.cardOnFileStatus || null,
    });
    return existing;
  }

  const { guardStripeOrReject } = require('./stripe-mode');
  const stripeGuard = guardStripeOrReject(env, { purpose: 'setup_intent_lookup' });
  if (stripeGuard.blocked) {
    console.log('[card-on-file] reconcile blocked by stripe-mode', {
      draftBookingId: existing.id || null,
      setupIntentIdPrefix: siIdPrefix(setupIntentId),
      error: stripeGuard.body?.error || 'blocked',
    });
    return existing;
  }

  const beforeStatus = existing.cardOnFileStatus || 'pending';
  try {
    const res = await fetchImpl(
      `https://api.stripe.com/v1/setup_intents/${encodeURIComponent(setupIntentId)}`,
      { headers: { Authorization: `Bearer ${stripeGuard.secret}` } }
    );
    if (!res.ok) {
      console.log('[card-on-file] reconcile Stripe lookup failed', {
        draftBookingId: existing.id || null,
        setupIntentIdPrefix: siIdPrefix(setupIntentId),
        httpStatus: res.status,
        cardOnFileStatusBefore: beforeStatus,
      });
      return existing;
    }
    const si = await res.json().catch(() => null);
    if (!si || si.status !== 'succeeded') {
      console.log('[card-on-file] reconcile SetupIntent not succeeded', {
        draftBookingId: existing.id || null,
        setupIntentIdPrefix: siIdPrefix(setupIntentId),
        setupIntentStatus: si ? si.status : 'missing',
        cardOnFileStatusBefore: beforeStatus,
      });
      return existing;
    }

    const metaBooking = si.metadata && (si.metadata.bookingId || si.metadata.booking_id);
    if (metaBooking && String(metaBooking) !== String(existing.id)) {
      console.log('[card-on-file] reconcile bookingId metadata mismatch', {
        draftBookingId: existing.id || null,
        setupIntentIdPrefix: siIdPrefix(setupIntentId),
        metaBookingId: String(metaBooking).slice(0, 48),
      });
      return existing;
    }

    const savedAt = existing.cardOnFileSavedAt || new Date().toISOString();
    const updated = {
      ...existing,
      cardOnFileStatus: 'saved',
      setupIntentId: si.id,
      stripeCustomerId: si.customer || existing.stripeCustomerId || null,
      stripePaymentMethodId: si.payment_method || existing.stripePaymentMethodId || null,
      cardOnFileSavedAt: savedAt,
      updatedAt: new Date().toISOString(),
    };
    await store.setJSON(existing.id, updated);
    console.log('[card-on-file] reconcile succeeded', {
      draftBookingId: existing.id || null,
      setupIntentIdPrefix: siIdPrefix(setupIntentId),
      setupIntentStatus: 'succeeded',
      cardOnFileStatusBefore: beforeStatus,
      cardOnFileStatusAfter: 'saved',
    });
    return updated;
  } catch (e) {
    console.log('[card-on-file] reconcile exception', {
      draftBookingId: existing.id || null,
      setupIntentIdPrefix: siIdPrefix(setupIntentId),
      message: e && e.message ? String(e.message).slice(0, 120) : 'unknown',
    });
    return existing;
  }
}

module.exports = {
  reconcileCardOnFileFromStripe,
  siIdPrefix,
};
