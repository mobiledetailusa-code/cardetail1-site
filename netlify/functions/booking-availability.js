/**
 * Public booking availability contract for the customer calendar.
 * Same canonical resolver as submit-booking (server remains authoritative).
 *
 * Read-only: GET only. No Blob/DB mutations. No Stripe/payment imports.
 * Cache-Control: no-store (via jsonCors) so capacity-sensitive nearby/check
 * responses are never served stale from an intermediary cache after a booking.
 */
const { jsonCors } = require('../lib/tech-security');
const { getOperationalAvailability } = require('../lib/ops-config');
const {
  projectPublicAvailability,
  findNearbyOpenings,
  slotsForDate,
  validateBookingSchedule,
  isoDateParts,
} = require('../lib/operational-availability');
const { buildOccupancyMap, hasSlotConflict } = require('../lib/booking-schedule');
const { listBookingsForSlotLock } = require('../lib/ops-db');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

const MAX_NEARBY_LIMIT = 8;
const MAX_NEARBY_HORIZON_DAYS = 28;
const DEFAULT_NEARBY_HORIZON_DAYS = 21;

function queryOf(event) {
  return (event && event.queryStringParameters) || {};
}

function clampInt(raw, { min, max, fallback }) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function publicJson(status, body) {
  // jsonCors already sets Cache-Control: no-store
  return jsonCors(status, body);
}

function safeError(status, error) {
  return publicJson(status, { ok: false, error });
}

/** The ISO days findNearbyOpenings can reach, so the slot index is read once per day. */
function horizonDates(fromDate, horizonDays) {
  const start = isoDateParts(fromDate);
  if (!start) return [];
  const dates = [];
  const cursor = new Date(Date.UTC(start.y, start.mo - 1, start.d));
  for (let i = 0; i <= horizonDays; i += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return publicJson(204, {});
    if (event.httpMethod !== 'GET') {
      return safeError(405, 'method_not_allowed');
    }

    const rate = await enforcePublicRateLimit(event, {
      endpoint: 'booking-availability',
      cors: true,
    }).catch(() => ({ blocked: false, allowed: true }));
    if (rate && rate.blocked) {
      return rate.response || safeError(429, 'rate_limited');
    }

    const config = await getOperationalAvailability().catch(() => null);
    const q = queryOf(event);
    const action = String(q.action || 'snapshot').trim() || 'snapshot';

    if (action === 'snapshot' || action === 'resolve') {
      return publicJson(200, projectPublicAvailability(config));
    }

    if (action === 'slots_for_date') {
      const iso = String(q.date || '').trim();
      if (!isoDateParts(iso)) return safeError(400, 'invalid_date');
      const slots = slotsForDate(iso, config);
      return publicJson(200, {
        ok: true,
        date: iso,
        slots,
      });
    }

    if (action === 'validate') {
      const date = String(q.preferredDate || q.date || '').trim();
      const time = String(q.preferredTime || q.time || '').trim();
      if (!isoDateParts(date)) return safeError(400, 'invalid_date');
      const v = validateBookingSchedule(date, time, { config });
      return publicJson(200, { ok: true, validation: v });
    }

    if (action === 'nearby') {
      const fromDate = String(q.fromDate || q.preferredDate || q.date || '').trim();
      if (fromDate && !isoDateParts(fromDate)) return safeError(400, 'invalid_date');
      const limit = clampInt(q.limit, { min: 1, max: MAX_NEARBY_LIMIT, fallback: 6 });
      const horizonDays = clampInt(q.horizonDays, {
        min: 7,
        max: MAX_NEARBY_HORIZON_DAYS,
        fallback: DEFAULT_NEARBY_HORIZON_DAYS,
      });
      let occupancy = {};
      try {
        const { indexedOccupancyForDates } = require('../lib/slot-index');
        const indexed = await indexedOccupancyForDates(horizonDates(fromDate, horizonDays));
        if (indexed.ok) {
          occupancy = indexed.occupancy;
        } else {
          const bookings = await listBookingsForSlotLock().catch(() => []);
          occupancy = buildOccupancyMap(bookings);
        }
      } catch (_) { /* recovery still works without occupancy */ }
      const openings = findNearbyOpenings(fromDate, config, {
        limit,
        horizonDays,
        occupancy,
      });
      return publicJson(200, { ok: true, openings });
    }

    if (action === 'check_slot') {
      const date = String(q.preferredDate || q.date || '').trim();
      const time = String(q.preferredTime || q.time || '').trim();
      if (!isoDateParts(date)) return safeError(400, 'invalid_date');
      const v = validateBookingSchedule(date, time, { config });
      if (!v.ok) {
        return publicJson(200, { ok: true, available: false, error: v.error, validation: v });
      }
      let conflict = false;
      try {
        const { indexedSlotConflict } = require('../lib/slot-index');
        const indexed = await indexedSlotConflict(v.preferredDate, v.preferredTime, {
          excludeId: q.excludeId || null,
          config,
        });
        if (indexed.ok) {
          conflict = indexed.conflict;
        } else {
          const bookings = await listBookingsForSlotLock().catch(() => []);
          conflict = hasSlotConflict(
            bookings,
            v.preferredDate,
            v.preferredTime,
            q.excludeId || null,
            Date.now(),
            config
          );
        }
      } catch (_) { /* soft */ }
      return publicJson(200, {
        ok: true,
        available: !conflict,
        error: conflict ? 'booking_slot_unavailable' : null,
        validation: v,
      });
    }

    return safeError(400, 'unknown_action');
  } catch (_) {
    return safeError(500, 'availability_unavailable');
  }
};
