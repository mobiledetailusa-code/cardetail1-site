'use strict';

/**
 * How long a Quick Ops link (admin /ops/q or technician /ops/t) stays valid.
 * A fixed 48 hours breaks jobs booked days ahead: the link from the booking
 * text is dead by the service day. Links now last until two days after the
 * service date, never less than the base TTL and never more than MAX_TTL_MS.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_AFTER_SERVICE_MS = 2 * DAY_MS;
const MAX_TTL_MS = 45 * DAY_MS;

function serviceDateMs(booking) {
  const raw = String(booking && (booking.confirmedDate || booking.preferredDate) || '').trim();
  if (!raw) return NaN;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (ymd) return Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 23, 59, 59);
  return Date.parse(raw);
}

function linkTtlMsForBooking(booking, baseTtlMs, now = Date.now()) {
  const base = Math.max(60_000, Number(baseTtlMs) || 0);
  const serviceMs = serviceDateMs(booking);
  if (!Number.isFinite(serviceMs)) return base;
  const untilAfterService = serviceMs + GRACE_AFTER_SERVICE_MS - now;
  return Math.min(MAX_TTL_MS, Math.max(base, untilAfterService));
}

module.exports = {
  linkTtlMsForBooking,
  serviceDateMs,
  MAX_TTL_MS,
  GRACE_AFTER_SERVICE_MS,
};
