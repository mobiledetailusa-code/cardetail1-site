'use strict';

/**
 * Bulk availability planning (Admin Ops) — pure, deterministic, bounded.
 *
 * A bulk request opens or closes a bounded date range for selected weekdays
 * by writing explicit date overrides (contract v1). It never touches bookings.
 *
 * Safety rules:
 *   - the range is bounded (MAX_BULK_DAYS) — permanent recurring schedules are
 *     Phase 2 (weekly / seasonal rules), not an unbounded pile of overrides;
 *   - protected dates are skipped unless explicitly selected in
 *     `includeProtected`:
 *       opening → holidays and existing explicit closures,
 *       closing → existing explicit openings;
 *   - closing a date that already holds reservations needs
 *     `acknowledgeReservations: true`; reservations stay booked;
 *   - apply must present the planHash from the preview, recomputed against the
 *     configuration and reservations at apply time (stale preview → refused).
 */

const crypto = require('crypto');
const {
  KNOWN_OPERATIONAL_SLOTS,
  RULE_SOURCES,
  isoDateParts,
  businessTodayIso,
  horizonIsoDates,
  normalizeAvailabilityConfig,
  normalizeArrivalWindows,
  normalizeDateOverride,
  resolveDateAvailability,
  resolveActiveWeekendMode,
} = require('./operational-availability');

const MAX_BULK_DAYS = 120;
const MAX_FUTURE_OVERRIDES = 400;
const MAX_CAPACITY = 20;
const BULK_ACTIONS = Object.freeze(['open', 'close']);
const WEEKDAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

function fail(error, userMessage) {
  return { ok: false, error, userMessage };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stableOverride(ov) {
  if (!ov) return null;
  const out = { enabled: !!ov.enabled, capacity: ov.capacity || 1 };
  if (ov.arrivalWindows && ov.arrivalWindows.length) out.arrivalWindows = [...ov.arrivalWindows];
  if (ov.holidayOpening === true) out.holidayOpening = true;
  if (ov.note) out.note = ov.note;
  return out;
}

/** Validate and normalize a bulk request. */
function normalizeBulkRequest(raw, { now = new Date(), timezone } = {}) {
  if (!raw || typeof raw !== 'object') return fail('invalid_request', 'Missing bulk request.');
  const action = String(raw.action || raw.operation || '').trim();
  if (!BULK_ACTIONS.includes(action)) return fail('invalid_bulk_action', 'Choose open or close.');
  const from = isoDateParts(raw.from);
  const to = isoDateParts(raw.to);
  if (!from || !to) return fail('invalid_date_range', 'Choose a start and an end date.');
  const today = businessTodayIso(timezone, now);
  if (from.iso < today) return fail('date_range_in_past', 'The range cannot start before today.');
  if (to.iso < from.iso) return fail('invalid_date_range', 'The end date must be on or after the start date.');
  const span = horizonIsoDates(from.iso, MAX_BULK_DAYS + 1);
  if (span[span.length - 1] <= to.iso) {
    return fail('date_range_too_long', `One bulk change can cover at most ${MAX_BULK_DAYS} days. Recurring schedules are planned for Phase 2.`);
  }
  const weekdays = [...new Set((Array.isArray(raw.weekdays) ? raw.weekdays : [])
    .map((d) => Math.floor(Number(d)))
    .filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (!weekdays.length) return fail('weekdays_required', 'Select at least one day of the week.');

  let arrivalWindows = null;
  let capacity = 1;
  if (action === 'open') {
    if (raw.arrivalWindows != null && raw.arrivalWindows !== '') {
      if (!Array.isArray(raw.arrivalWindows)) return fail('invalid_arrival_windows', 'Arrival windows must be a list.');
      arrivalWindows = normalizeArrivalWindows(raw.arrivalWindows);
      if (!arrivalWindows || arrivalWindows.length !== raw.arrivalWindows.length) {
        return fail('invalid_arrival_windows', `Use only: ${KNOWN_OPERATIONAL_SLOTS.join(', ')}.`);
      }
      arrivalWindows = KNOWN_OPERATIONAL_SLOTS.filter((s) => arrivalWindows.includes(s));
    }
    if (raw.capacity != null && raw.capacity !== '') {
      const n = Math.floor(Number(raw.capacity));
      if (!Number.isFinite(n) || n < 1 || n > MAX_CAPACITY) {
        return fail('invalid_capacity', `Capacity must be between 1 and ${MAX_CAPACITY} per arrival window.`);
      }
      capacity = n;
    }
  }
  const includeProtected = [...new Set((Array.isArray(raw.includeProtected) ? raw.includeProtected : [])
    .map((d) => isoDateParts(d))
    .filter(Boolean)
    .map((p) => p.iso))].sort();
  const note = String(raw.note || '').trim().slice(0, 500);
  return {
    ok: true,
    request: {
      action,
      from: from.iso,
      to: to.iso,
      weekdays,
      arrivalWindows,
      capacity,
      includeProtected,
      note,
    },
  };
}

function desiredOverride(request, holiday) {
  if (request.action === 'close') {
    return normalizeDateOverride({ enabled: false, capacity: 1, note: request.note });
  }
  return normalizeDateOverride({
    enabled: true,
    capacity: request.capacity,
    arrivalWindows: request.arrivalWindows || undefined,
    holidayOpening: holiday ? true : undefined,
    note: request.note,
  });
}

function protectionFor(request, before) {
  const ov = before.override;
  if (request.action === 'open') {
    if (ov && !ov.enabled) return 'closure_exception';
    if (before.holiday && before.source !== RULE_SOURCES.HOLIDAY_OPENING) return 'holiday';
    return null;
  }
  if (ov && ov.enabled) return 'opening_exception';
  return null;
}

/**
 * Plan a bulk change. `reservationsByDate` maps ISO date → number of booked
 * reservations (from the slot index). Pure: no I/O.
 */
function planBulkAvailability(config, rawRequest, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const cfg = normalizeAvailabilityConfig(config);
  const normalized = normalizeBulkRequest(rawRequest, { now, timezone: cfg.businessTimezone });
  if (!normalized.ok) return normalized;
  const request = normalized.request;
  const reservationsByDate = opts.reservationsByDate || {};
  const active = resolveActiveWeekendMode(cfg, now);
  const pendingActivation = cfg.weekendMode === 'supervised' && !active.activated
    ? cfg.supervisedEffectiveDate
    : null;

  const dates = [];
  const nextOverrides = { ...cfg.dateOverrides };
  const summary = {
    matchedDates: 0,
    create: 0,
    update: 0,
    unchanged: 0,
    protectedSkipped: 0,
    protectedIncluded: 0,
    withReservations: 0,
    closingWithReservations: 0,
  };
  const range = horizonIsoDates(request.from, MAX_BULK_DAYS + 1).filter((iso) => iso <= request.to);
  for (const iso of range) {
    const before = resolveDateAvailability(iso, cfg, now);
    if (!request.weekdays.includes(before.day)) continue;
    summary.matchedDates += 1;
    const reservations = Math.max(0, Math.floor(Number(reservationsByDate[iso]) || 0));
    if (reservations > 0) summary.withReservations += 1;
    const protectedReason = protectionFor(request, before);
    const included = !protectedReason || request.includeProtected.includes(iso);
    const desired = desiredOverride(request, before.holiday);
    const existing = cfg.dateOverrides[iso] || null;

    let change;
    if (!included) {
      change = 'protected_skipped';
      summary.protectedSkipped += 1;
    } else {
      if (protectedReason) summary.protectedIncluded += 1;
      const flipsOnActivation = pendingActivation && iso >= pendingActivation
        && resolveDateAvailability(iso, cfg, now, { mode: 'supervised' }).open !== before.open;
      const baseMatches = !existing
        && !flipsOnActivation
        && !before.holiday
        && (request.action === 'close'
          ? !before.open
          : (before.open
            && sameJson(before.windows, desired.arrivalWindows || before.windows)
            && desired.capacity === before.capacity
            && !desired.note));
      // An existing exception that already yields the same result (same open
      // state, windows, capacity and note) is left as it is.
      let existingMatches = false;
      if (existing) {
        const candidate = resolveDateAvailability(iso, { ...cfg, dateOverrides: { ...cfg.dateOverrides, [iso]: desired } }, now);
        existingMatches = candidate.open === before.open
          && sameJson(candidate.windows, before.windows)
          && candidate.capacity === before.capacity
          && (existing.note || '') === (desired.note || '');
      }
      if (baseMatches || existingMatches) {
        change = 'unchanged';
        summary.unchanged += 1;
      } else {
        change = existing ? 'update' : 'create';
        summary[change] += 1;
        nextOverrides[iso] = desired;
      }
    }
    const afterCfg = { ...cfg, dateOverrides: nextOverrides };
    const after = resolveDateAvailability(iso, afterCfg, now);
    const closesWithReservations = request.action === 'close'
      && reservations > 0
      && (change === 'create' || change === 'update')
      && before.open;
    if (closesWithReservations) summary.closingWithReservations += 1;
    dates.push({
      date: iso,
      weekday: WEEKDAY_NAMES[before.day],
      holiday: before.holiday,
      protected: protectedReason,
      included,
      change,
      reservations,
      closesWithReservations,
      before: { open: before.open, windows: before.windows, capacity: before.capacity, source: before.source },
      after: { open: after.open, windows: after.windows, capacity: after.capacity, source: after.source },
    });
  }

  const today = businessTodayIso(cfg.businessTimezone, now);
  const futureOverrides = Object.keys(nextOverrides).filter((iso) => iso >= today).length;
  const changes = dates
    .filter((d) => d.change === 'create' || d.change === 'update')
    .map((d) => ({ date: d.date, override: stableOverride(nextOverrides[d.date]) }));
  const planHash = crypto.createHash('sha256').update(JSON.stringify({
    revision: cfg.revision || 0,
    request,
    changes,
    reservations: dates.map((d) => [d.date, d.reservations]),
  })).digest('hex').slice(0, 32);

  return {
    ok: true,
    request,
    revision: cfg.revision || 0,
    pendingActivation,
    summary,
    dates,
    changes,
    requiresReservationAck: summary.closingWithReservations > 0,
    futureOverrides,
    overrideLimitExceeded: futureOverrides > MAX_FUTURE_OVERRIDES,
    planHash,
    nextOverrides,
  };
}

/** Public-safe preview payload (drops the full override map). */
function previewPayload(plan) {
  if (!plan || !plan.ok) return plan;
  const { nextOverrides, ...rest } = plan;
  return rest;
}

module.exports = {
  MAX_BULK_DAYS,
  MAX_FUTURE_OVERRIDES,
  MAX_CAPACITY,
  BULK_ACTIONS,
  normalizeBulkRequest,
  planBulkAvailability,
  previewPayload,
};
