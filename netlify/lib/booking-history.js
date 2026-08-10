'use strict';

/**
 * Customer-scoped booking history for offer eligibility.
 *
 * Welcome-offer eligibility only depends on the bookings belonging to ONE
 * customer, but the Blobs side has no query primitive — the only way to answer
 * it there is listRawBookings(), which lists and hydrates every record in
 * cd1-bookings. On the live store that scan costs ~20s, and it sits inside the
 * draft pre-registration behind "save my card": submit-booking ran up against
 * the Netlify function ceiling and returned a non-JSON 502, which checkout
 * surfaces as "Booking backend returned an invalid response. Try again."
 *
 * BookingRecord already mirrors every submitted booking with indexed phone and
 * email columns, so the same question answers in milliseconds there.
 *
 * Blobs stay authoritative: whenever the mirror is disabled, unreachable, or
 * errors, this falls back to the full scan rather than guessing at a customer's
 * history. The mirror only carries bookings submitted since it shipped — run
 * `node scripts/backfill-booking-mirror.js --apply` once so pre-mirror
 * customers are not mistaken for new ones.
 */

const { normalizePhone } = require('./phone-auth');

/** One customer's lifetime bookings never approach this; it only caps a bug. */
const HISTORY_LOOKUP_LIMIT = 200;

/** Escape hatch: OFFER_HISTORY_FAST_LOOKUP=0 forces the Blobs scan. */
function fastLookupDisabled(env = process.env) {
  const flag = String(env.OFFER_HISTORY_FAST_LOOKUP || '').toLowerCase();
  return flag === '0' || flag === 'false';
}

/**
 * emailHash is the same sha256/base64url digest customer-session stores, so a
 * portal session can be scoped without ever holding the address in plain text.
 */
function normalizeIdentity({ phone, email, emailHash } = {}) {
  return {
    phone: normalizePhone(phone || ''),
    email: String(email || '').trim().toLowerCase(),
    emailHash: String(emailHash || '').trim(),
  };
}

function identityKeys(booking) {
  return normalizeIdentity({ phone: booking?.phone, email: booking?.email });
}

/**
 * Same shaping listRawBookings applies, so callers cannot tell the two sources
 * apart: historical payloads are adapted and non-submitted rows dropped.
 */
function shapeHistoryRecords(rawRecords) {
  const { adaptHistoricalBooking } = require('./historical-adapter');
  const { isVisibleSubmittedBooking } = require('./booking-visibility');
  const out = [];
  for (const raw of rawRecords) {
    if (!raw || typeof raw !== 'object') continue;
    const adapted = adaptHistoricalBooking(raw);
    if (!adapted.ok || !adapted.booking) continue;
    if (!isVisibleSubmittedBooking(adapted.booking, { includeArchivedTest: true })) continue;
    out.push(adapted.booking);
  }
  return out;
}

/**
 * @returns {Promise<object[]|null>} matching bookings, or null when the mirror
 *   cannot answer (disabled / no client) so the caller falls back to Blobs.
 */
async function mirrorHistory({ phone, email, emailHash }) {
  const { readFallbackEnabled } = require('./booking-prisma-mirror');
  if (!readFallbackEnabled()) return null;

  const { tryGetPrisma } = require('./prisma');
  const prisma = tryGetPrisma();
  if (!prisma) return null;

  // Drafts are never mirrored, but kind is filtered anyway to match the Blob
  // path. right(digits, 10) matches stored numbers that kept a country code;
  // the hash expression reproduces crypto.sha256(email).digest('base64url').
  const rows = await prisma.$queryRaw`
    SELECT payload
      FROM "BookingRecord"
     WHERE kind <> 'draft'
       AND (
            (${phone}::text <> '' AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${phone}::text)
         OR (${email}::text <> '' AND lower(coalesce(email, '')) = ${email}::text)
         OR (${emailHash}::text <> '' AND rtrim(translate(encode(sha256(convert_to(lower(trim(coalesce(email, ''))), 'UTF8')), 'base64'), '+/', '-_'), '=') = ${emailHash}::text)
           )
     ORDER BY "updatedAt" DESC
     LIMIT ${HISTORY_LOOKUP_LIMIT}
  `;

  return shapeHistoryRecords((rows || []).map((row) => row && row.payload));
}

/**
 * Bookings that could disqualify this booking from a first-time offer.
 *
 * Never throws: an unavailable mirror degrades to the Blobs scan, and an
 * unavailable store degrades to an empty list exactly as before.
 *
 * @returns {Promise<{ bookings: object[], source: 'mirror'|'blobs'|'no_identity' }>}
 */
async function listBookingsForIdentity(rawIdentity) {
  const identity = normalizeIdentity(rawIdentity);
  // Every caller matches on one of these anyway, so with none of them there is
  // nothing a full scan could legitimately surface.
  if (!identity.phone && !identity.email && !identity.emailHash) {
    return { bookings: [], source: 'no_identity' };
  }

  if (!fastLookupDisabled()) {
    try {
      const rows = await mirrorHistory(identity);
      if (rows) return { bookings: rows, source: 'mirror' };
    } catch (err) {
      console.warn('[booking-history] mirror_lookup_failed', err && err.message ? err.message : err);
    }
  }

  const { listRawBookings } = require('./ops-db');
  const bookings = await listRawBookings().catch(() => []);
  return { bookings, source: 'blobs' };
}

async function listBookingHistoryForBooking(booking) {
  return listBookingsForIdentity(identityKeys(booking));
}

/**
 * An active booking this customer already holds for the same slot.
 *
 * The slot lock is supposed to prevent this, but it fails open by design: when
 * the booking-store scan errors or times out it yields an empty list, every
 * slot reads as free, and a repeat submission goes straight through. That is
 * how a finalize that wrote the booking and then died — telling the customer it
 * failed — turns into two identical appointments when they try again.
 *
 * This check does not share that failure mode: it asks the indexed mirror for
 * one customer's bookings, and a booking created minutes ago is exactly what
 * the mirror has. Returns null when it cannot answer, so it can only ever
 * suppress a duplicate, never block a legitimate booking.
 *
 * @returns {Promise<object|null>} the existing booking, or null
 */
async function findDuplicateBooking({ phone, email, preferredDate, preferredTime, excludeId } = {}) {
  const { normalizePreferredTime, isActiveBookingForSlotLock } = require('./booking-schedule');
  const { isoDateParts } = require('./operational-availability');

  const parts = isoDateParts(preferredDate);
  const time = normalizePreferredTime(preferredTime);
  if (!parts || !time) return null;

  const identity = normalizeIdentity({ phone, email });
  if (!identity.phone && !identity.email) return null;

  const { bookings } = await listBookingsForIdentity(identity);
  const skip = String(excludeId || '').trim().toUpperCase();

  for (const booking of bookings || []) {
    if (!booking) continue;
    if (skip && String(booking.id || '').trim().toUpperCase() === skip) continue;
    if (!isActiveBookingForSlotLock(booking)) continue;
    const bookingParts = isoDateParts(booking.confirmedDate || booking.preferredDate);
    const bookingTime = normalizePreferredTime(booking.confirmedTime || booking.preferredTime);
    if (!bookingParts || !bookingTime) continue;
    if (bookingParts.iso === parts.iso && bookingTime === time) return booking;
  }
  return null;
}

module.exports = {
  HISTORY_LOOKUP_LIMIT,
  findDuplicateBooking,
  fastLookupDisabled,
  normalizeIdentity,
  identityKeys,
  shapeHistoryRecords,
  mirrorHistory,
  listBookingsForIdentity,
  listBookingHistoryForBooking,
};
