/**
 * Public booking availability contract for the customer calendar.
 * Same canonical resolver as submit-booking (server remains authoritative).
 *
 * Read-only: GET only. No Blob/DB mutations. No Stripe/payment imports.
 * Cache-Control: no-store (via jsonCors) so capacity-sensitive nearby/check
 * responses are never served stale from an intermediary cache after a booking.
 */
const { jsonCors } = require('../lib/tech-security');
const { loadOperationalAvailability } = require('../lib/ops-config');
const {
  projectPublicAvailability,
  findNearbyOpenings,
  slotsForDate,
  validateBookingSchedule,
  isoDateParts,
} = require('../lib/operational-availability');
const { buildOccupancyMap, hasSlotConflict, startFitsDemand, pickEligibleStart } = require('../lib/booking-schedule');
const { resolveOperationalSlot, arrivalWindowForSlot } = require('../lib/arrival-windows');
const { listBookingsForSlotLockStrict } = require('../lib/ops-db');
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

/** Customer-safe recovery message when the schedule configuration cannot be read. */
const AVAILABILITY_UNAVAILABLE_MESSAGE = 'Live scheduling is temporarily unavailable, so no dates can be offered right now. Please try again in a minute, or call or text (551) 389-3986 and we will book you directly.';

function availabilityUnavailable(loaded) {
  return publicJson(503, {
    ok: false,
    status: 'unavailable',
    error: 'availability_unavailable',
    retryable: loaded && loaded.retryable !== false,
    userMessage: AVAILABILITY_UNAVAILABLE_MESSAGE,
  });
}

function safeError(status, error) {
  return publicJson(status, { ok: false, error });
}

function demandFromQuery(q) {
  return {
    durationMinutes: clampInt(q.durationMinutes, { min: 0, max: 24 * 60, fallback: 0 }),
    companionInterior: q.companionInterior === '1' || q.companionInterior === 'true',
  };
}

/** Bound on the legacy full-store scan (same default as submit-booking). */
const DEFAULT_OCCUPANCY_SCAN_TIMEOUT_MS = 8000;

function occupancyScanTimeoutMs(env = process.env) {
  const raw = env.SLOT_SCAN_TIMEOUT_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Math.round(Number(raw));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_OCCUPANCY_SCAN_TIMEOUT_MS;
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('occupancy_scan_timeout')), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Occupancy for recovery suggestions. Fails closed: when neither the slot
 * index nor a complete, bounded store scan can answer, the result is
 * { ok: false } — never an empty map that would make occupied windows look
 * free. The index answers all requested dates or nothing (one failed date
 * fails the whole read), so partial occupancy is never returned.
 */
async function occupancyForDates(dates) {
  let indexReason = null;
  try {
    const { indexedOccupancyForDates } = require('../lib/slot-index');
    const indexed = await indexedOccupancyForDates(dates);
    if (indexed.ok) return { ok: true, occupancy: indexed.occupancy, source: 'index' };
    indexReason = indexed.reason || 'index_unavailable';
  } catch (err) {
    indexReason = 'index_threw';
  }
  try {
    const bookings = await withTimeout(listBookingsForSlotLockStrict(), occupancyScanTimeoutMs());
    return { ok: true, occupancy: buildOccupancyMap(bookings), source: 'scan' };
  } catch (err) {
    console.warn('[booking-availability] occupancy_unverified', {
      index: indexReason,
      scan: err && err.message ? String(err.message).slice(0, 120) : 'scan_failed',
    });
    return { ok: false, reason: 'occupancy_unverified' };
  }
}

/** Customer-safe message when live openings cannot be verified. */
const OCCUPANCY_UNVERIFIED_MESSAGE = 'We could not check which times are still open right now, so no time was suggested. Please try again in a minute, or call or text (551) 389-3986 and we will book you directly.';

function occupancyUnverified() {
  return publicJson(503, {
    ok: false,
    error: 'booking_verification_unavailable',
    retryable: true,
    userMessage: OCCUPANCY_UNVERIFIED_MESSAGE,
  });
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

    // Fail closed: a configuration we could not read must never become the
    // legacy calendar (that would silently reopen closed dates).
    const loaded = await loadOperationalAvailability();
    if (!loaded.ok) return availabilityUnavailable(loaded);
    const config = loaded.config;
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
      const demand = demandFromQuery(q);
      const occ = await occupancyForDates(horizonDates(fromDate, horizonDays));
      if (!occ.ok) return occupancyUnverified();
      const occupancy = occ.occupancy;
      const openings = findNearbyOpenings(fromDate, config, {
        limit,
        horizonDays,
        occupancy,
        acceptsStart: demand.durationMinutes > 120
          ? (iso, slot) => startFitsDemand(iso, slot, {
            durationMinutes: demand.durationMinutes,
            companionInterior: demand.companionInterior,
            occupancy,
            config,
          }).ok
          : null,
      }).map((opening) => ({
        ...opening,
        preferredArrivalWindow: arrivalWindowForSlot(opening.preferredTime) || null,
      }));
      return publicJson(200, { ok: true, openings });
    }

    if (action === 'selection') {
      const date = String(q.preferredDate || q.date || '').trim();
      const window = String(q.preferredArrivalWindow || q.window || '').trim();
      if (!isoDateParts(date)) return safeError(400, 'invalid_date');
      const demand = demandFromQuery(q);
      const slots = slotsForDate(date, config);
      const resolved = resolveOperationalSlot(date, window, slots);
      if (!resolved.ok) {
        return publicJson(200, { ok: true, available: false, error: resolved.error });
      }
      const occ = await occupancyForDates(horizonDates(date, 7));
      if (!occ.ok) return occupancyUnverified();
      const occupancy = occ.occupancy;
      const picked = pickEligibleStart(date, resolved.eligible, {
        durationMinutes: demand.durationMinutes,
        companionInterior: demand.companionInterior,
        occupancy,
        config,
      });
      if (!picked.slot) {
        const failure = picked.durationFailure;
        return publicJson(200, {
          ok: true,
          available: false,
          error: failure ? (failure.error || 'ceramic_duration_exceeds_day') : 'booking_slot_unavailable',
          userMessage: (failure && failure.userMessage) || null,
          nextValidStart: (failure && failure.nextValidStart) || null,
          preferredDate: date,
          preferredArrivalWindow: window,
        });
      }
      return publicJson(200, {
        ok: true,
        available: true,
        preferredDate: date,
        preferredTime: picked.slot,
        preferredArrivalWindow: window,
      });
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
          const bookings = await withTimeout(listBookingsForSlotLockStrict(), occupancyScanTimeoutMs());
          conflict = hasSlotConflict(
            bookings,
            v.preferredDate,
            v.preferredTime,
            q.excludeId || null,
            Date.now(),
            config
          );
        }
      } catch (err) {
        // Fail closed: an unverifiable slot is never reported as available.
        console.warn('[booking-availability] check_slot_unverified', err && err.message ? String(err.message).slice(0, 120) : 'failed');
        return occupancyUnverified();
      }
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
