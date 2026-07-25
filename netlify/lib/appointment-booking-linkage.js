/**
 * Durable booking ↔ CustomerAccount linkage and server-authoritative resend
 * generations.
 *
 * Both operations mutate the authoritative booking aggregate, so they go
 * through the versioned repository (CAS + bookingVersion + eventLog) rather
 * than an unconditional Blob set. A booking already owned by a different
 * CustomerAccount is never reassigned.
 */

'use strict';

const { getBookingRecord } = require('./booking-repository');
const { patchBooking } = require('./ops-db');

const MAX_COMMIT_ATTEMPTS = 3;
/** Concurrent clicks inside this window share one resend generation. */
const RESEND_GENERATION_COOLDOWN_MS = 60_000;

const LINK_RESULT = {
  LINKED: 'linked',
  ALREADY_LINKED: 'already_linked',
  OWNED_BY_OTHER_ACCOUNT: 'owned_by_other_account',
  BOOKING_NOT_FOUND: 'booking_not_found',
  CONFLICT: 'conflict',
  INVALID_ARGS: 'invalid_args',
};

function accountIdOf(booking) {
  const raw = booking && booking.customerAccountId;
  const id = String(raw == null ? '' : raw).trim();
  return id || null;
}

/**
 * Link a booking to a CustomerAccount in the Blob aggregate.
 *
 * Idempotent: re-linking to the same account performs no write. Fails closed
 * when the booking already belongs to a different account.
 */
async function linkBookingToAccountDurably({
  bookingId,
  customerAccountId,
  actor = 'system:appointment-access',
} = {}) {
  const id = String(bookingId || '').trim();
  const accountId = String(customerAccountId || '').trim();
  if (!id || !accountId) {
    return { ok: false, result: LINK_RESULT.INVALID_ARGS };
  }

  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const current = await getBookingRecord(id);
    if (!current.exists || !current.booking) {
      return { ok: false, result: LINK_RESULT.BOOKING_NOT_FOUND };
    }

    const existing = accountIdOf(current.booking);
    if (existing === accountId) {
      return { ok: true, result: LINK_RESULT.ALREADY_LINKED, booking: current.booking };
    }
    if (existing) {
      return {
        ok: false,
        result: LINK_RESULT.OWNED_BY_OTHER_ACCOUNT,
        booking: current.booking,
      };
    }

    const committed = await patchBooking(
      id,
      {
        customerAccountId: accountId,
        customerAccountLinkedAt: new Date().toISOString(),
      },
      {
        actor,
        action: 'customer_account.booking_linked',
        at: new Date().toISOString(),
        detail: { customerAccountId: accountId },
      }
    );
    if (committed) {
      return { ok: true, result: LINK_RESULT.LINKED, booking: committed };
    }
    // Lost the CAS race — re-read and re-classify.
  }

  return { ok: false, result: LINK_RESULT.CONFLICT };
}

/**
 * Allocate the resend generation for a booking.
 *
 * Requests inside the cooldown reuse the current generation so concurrent
 * clicks collapse to a single delivery, while a later legitimate resend gets a
 * fresh generation that no terminal ledger entry can suppress.
 */
async function allocateResendGeneration({
  bookingId,
  cooldownMs = RESEND_GENERATION_COOLDOWN_MS,
  now = Date.now(),
} = {}) {
  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'invalid_args', generation: null };

  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const current = await getBookingRecord(id);
    if (!current.exists || !current.booking) {
      return { ok: false, error: 'booking_not_found', generation: null };
    }

    const booking = current.booking;
    const generation = Math.max(0, Math.floor(Number(booking.appointmentAccessResendGeneration) || 0));
    const lastAt = Date.parse(booking.appointmentAccessResendRequestedAt || '');
    const withinCooldown = generation > 0
      && Number.isFinite(lastAt)
      && now - lastAt < cooldownMs;

    if (withinCooldown) {
      return { ok: true, generation, reused: true, booking };
    }

    const nextGeneration = generation + 1;
    const committed = await patchBooking(
      id,
      {
        appointmentAccessResendGeneration: nextGeneration,
        appointmentAccessResendRequestedAt: new Date(now).toISOString(),
      },
      {
        actor: 'system:appointment-access',
        action: 'appointment_access.resend_requested',
        at: new Date(now).toISOString(),
        detail: { resendGeneration: nextGeneration },
      }
    );
    if (committed) {
      return { ok: true, generation: nextGeneration, reused: false, booking: committed };
    }
    // Lost the CAS race — another click may have already allocated a generation.
  }

  return { ok: false, error: 'conflict', generation: null };
}

module.exports = {
  LINK_RESULT,
  RESEND_GENERATION_COOLDOWN_MS,
  linkBookingToAccountDurably,
  allocateResendGeneration,
};
