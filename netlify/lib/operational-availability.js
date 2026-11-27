/**
 * Operational availability contract — UI-independent schedule authority.
 *
 * Consumed by: Admin Ops, booking client, submit-booking validation,
 * future Owner Studio / Availability, and Twilio scheduling messages.
 *
 * NOT stored in OsCatalogDraft. Persisted via ops-config availability blob.
 *
 * Pure layer: a null / never-saved config resolves to complete LEGACY behavior
 * (Saturday open with 2 slots, Sunday closed) and never partially merges bad
 * rules. A config that EXISTS but cannot be read or is structurally invalid is
 * NOT legacy: ops-config.loadOperationalAvailability() reports it as
 * unavailable and callers fail closed (see docs/availability/README.md).
 *
 * Rule precedence for one calendar date (highest first):
 *   1. [Phase 2] emergency booking suspension (blocks NEW bookings only)
 *   2. date override — closed override always closes the date
 *   3. explicit holiday opening — an open override with holidayOpening:true
 *   4. holiday closure — an open override WITHOUT holidayOpening stays closed
 *   5. [Phase 2] seasonal schedule
 *   6. [Phase 2] recurring weekly schedule
 *   7. open date override on an ordinary date
 *   8. base rule: weekdays open; weekends per legacy / supervised mode
 *   then same-day lead filtering, then capacity and existing reservations.
 */

const ALLOWED_WEEKDAY_SLOTS = Object.freeze(['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM']);
const ALLOWED_SATURDAY_SLOTS = Object.freeze(['8:00 AM', '10:00 AM']);
/** Full inventory the owner may enable per date (includes optional late 4:00 PM). */
const KNOWN_OPERATIONAL_SLOTS = Object.freeze(['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM']);
/** Same-day booking is allowed; remaining slots still respect SAME_DAY_LEAD_MINUTES. */
const MIN_ADVANCE_DAYS = 0;
/**
 * Same-day slots must start at least this many minutes from "now" in the
 * business timezone. Example: at 10:00 AM, 8/10 AM drop and 12:00 PM remains.
 */
const SAME_DAY_LEAD_MINUTES = 120;
/** Last standard weekday arrival window (2:00 PM start / arrive by 5:00 PM). */
const SAME_DAY_LATE_SLOT = '2:00 PM';
const DEFAULT_BUSINESS_TIMEZONE = 'America/New_York';
const CONTRACT_VERSION = 1;
const WEEKEND_MODES = Object.freeze(['legacy', 'supervised']);
const CUSTOMER_WEEKEND_LABEL = 'Limited weekend availability';

const SLOT_START_MINUTES = Object.freeze({
  '8:00 AM': 480,
  '10:00 AM': 600,
  '12:00 PM': 720,
  '2:00 PM': 840,
  '4:00 PM': 960,
});

const LEGACY_TIME_PATTERNS = [
  /^any available/i,
  /^morning\s*\(/i,
  /^midday\s*\(/i,
  /^afternoon\s*\(/i,
];

/** Complete legacy defaults — used when config is missing or invalid. */
const LEGACY_AVAILABILITY = Object.freeze({
  version: CONTRACT_VERSION,
  businessTimezone: DEFAULT_BUSINESS_TIMEZONE,
  weekendMode: 'legacy',
  supervisedEffectiveDate: null,
  dateOverrides: Object.freeze({}),
  updatedAt: null,
  updatedBy: null,
});

function isoDateParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return { y, mo, d, day: date.getDay(), iso: `${m[1]}-${m[2]}-${m[3]}` };
}

function toIsoLocal(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function addLocalDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function earliestBookableIso(now = new Date(), timezone = DEFAULT_BUSINESS_TIMEZONE) {
  const today = businessTodayIso(timezone, now);
  const parts = isoDateParts(today);
  if (!parts) return toIsoLocal(addLocalDays(now, MIN_ADVANCE_DAYS));
  return toIsoLocal(addLocalDays(new Date(parts.y, parts.mo - 1, parts.d), MIN_ADVANCE_DAYS));
}

/** Business-calendar "today" in the configured timezone (fallback: local). */
function businessTodayIso(timezone, now = new Date()) {
  const tz = String(timezone || DEFAULT_BUSINESS_TIMEZONE).trim() || DEFAULT_BUSINESS_TIMEZONE;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA yields YYYY-MM-DD
    return fmt.format(now);
  } catch (_) {
    return toIsoLocal(now);
  }
}

/** Minutes since local midnight in the business timezone. */
function businessMinutesNow(timezone, now = new Date()) {
  const tz = String(timezone || DEFAULT_BUSINESS_TIMEZONE).trim() || DEFAULT_BUSINESS_TIMEZONE;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return (hour * 60) + minute;
  } catch (_) {
    return (now.getHours() * 60) + now.getMinutes();
  }
}

function slotStartMinutes(slotLabel) {
  const normalized = normalizePreferredTime(slotLabel) || String(slotLabel || '').trim();
  if (Object.prototype.hasOwnProperty.call(SLOT_START_MINUTES, normalized)) {
    return SLOT_START_MINUTES[normalized];
  }
  return null;
}

/**
 * Drop same-day slots that are already too close to start (or already passed).
 * Future dates are returned unchanged.
 */
function filterSameDaySlots(iso, slots, now = new Date(), timezone = DEFAULT_BUSINESS_TIMEZONE) {
  const list = Array.isArray(slots) ? slots.slice() : [];
  const parts = isoDateParts(iso);
  if (!parts || !list.length) return list;
  const today = businessTodayIso(timezone, now);
  if (parts.iso !== today) return list;
  const cutoff = businessMinutesNow(timezone, now) + SAME_DAY_LEAD_MINUTES;
  return list.filter((slot) => {
    const start = slotStartMinutes(slot);
    return start != null && start >= cutoff;
  });
}

function isSameDayLateSlot(iso, preferredTime, now = new Date(), timezone = DEFAULT_BUSINESS_TIMEZONE) {
  const parts = isoDateParts(iso);
  if (!parts) return false;
  if (parts.iso !== businessTodayIso(timezone, now)) return false;
  return normalizePreferredTime(preferredTime) === SAME_DAY_LATE_SLOT;
}

function computeEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function nthWeekdayInMonth(year, monthIndex, weekday, n) {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const dt = new Date(year, monthIndex, day);
    if (dt.getMonth() !== monthIndex) break;
    if (dt.getDay() === weekday) {
      count += 1;
      if (count === n) return toIsoLocal(dt);
    }
  }
  return null;
}

function lastWeekdayInMonth(year, monthIndex, weekday) {
  for (let day = 31; day >= 1; day--) {
    const dt = new Date(year, monthIndex, day);
    if (dt.getMonth() !== monthIndex) continue;
    if (dt.getDay() === weekday) return toIsoLocal(dt);
  }
  return null;
}

function getHolidaySet(year) {
  const easter = computeEasterSunday(year);
  return new Set([
    `${year}-01-01`,
    toIsoLocal(easter),
    lastWeekdayInMonth(year, 4, 1),
    `${year}-07-04`,
    nthWeekdayInMonth(year, 8, 1, 1),
    nthWeekdayInMonth(year, 10, 4, 4),
    `${year}-12-24`,
    `${year}-12-25`,
    `${year}-12-31`,
  ]);
}

function isClosedHoliday(iso) {
  const parts = isoDateParts(iso);
  if (!parts) return false;
  return getHolidaySet(parts.y).has(parts.iso);
}

function normalizeArrivalWindows(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = [];
  for (const item of raw) {
    const n = normalizePreferredTime(item);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.length ? out : null;
}

function normalizeDateOverride(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const enabled = raw.enabled === true;
  const capacityNum = Math.floor(Number(raw.capacity));
  const capacity = Number.isFinite(capacityNum) && capacityNum >= 1 ? Math.min(capacityNum, 20) : 1;
  const arrivalWindows = normalizeArrivalWindows(raw.arrivalWindows);
  const note = String(raw.note || '').trim().slice(0, 500) || '';
  // Opening a protected holiday needs its own explicit flag; a plain open
  // override on a holiday keeps the holiday closed (pre-Phase-1 behavior).
  const holidayOpening = enabled && raw.holidayOpening === true;
  return {
    enabled,
    capacity,
    ...(arrivalWindows ? { arrivalWindows } : {}),
    ...(holidayOpening ? { holidayOpening: true } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeRevision(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Structural check used by the loader to tell a real, saved configuration
 * from one that cannot be trusted. Mirrors every branch where
 * normalizeAvailabilityConfig would discard the saved rules.
 */
function inspectAvailabilityConfig(raw) {
  if (raw == null) return { valid: true, reason: 'not_configured' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, reason: 'not_an_object' };
  const version = Math.floor(Number(raw.version));
  if (!Number.isFinite(version) || version < 1 || version > CONTRACT_VERSION) {
    return { valid: false, reason: 'unsupported_version' };
  }
  const weekendMode = String(raw.weekendMode || 'legacy').trim();
  if (!WEEKEND_MODES.includes(weekendMode)) return { valid: false, reason: 'invalid_weekend_mode' };
  if (raw.supervisedEffectiveDate != null && String(raw.supervisedEffectiveDate).trim() !== ''
    && !isoDateParts(raw.supervisedEffectiveDate)) {
    return { valid: false, reason: 'invalid_effective_date' };
  }
  if (weekendMode === 'supervised' && !isoDateParts(raw.supervisedEffectiveDate)) {
    // Would silently demote to legacy and reopen Saturdays.
    return { valid: false, reason: 'supervised_missing_effective_date' };
  }
  const tz = String(raw.businessTimezone || DEFAULT_BUSINESS_TIMEZONE).trim() || DEFAULT_BUSINESS_TIMEZONE;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch (_) {
    return { valid: false, reason: 'invalid_timezone' };
  }
  if (raw.dateOverrides != null && (typeof raw.dateOverrides !== 'object' || Array.isArray(raw.dateOverrides))) {
    return { valid: false, reason: 'invalid_date_overrides' };
  }
  return { valid: true, reason: null };
}

/**
 * Normalize persisted config. On ANY structural failure, return complete legacy
 * defaults (do not partially combine invalid new rules with legacy rules).
 */
function normalizeAvailabilityConfig(raw) {
  if (raw == null) return { ...LEGACY_AVAILABILITY, dateOverrides: {} };
  if (typeof raw !== 'object') return { ...LEGACY_AVAILABILITY, dateOverrides: {} };

  try {
    const version = Math.floor(Number(raw.version));
    if (!Number.isFinite(version) || version < 1 || version > CONTRACT_VERSION) {
      return { ...LEGACY_AVAILABILITY, dateOverrides: {} };
    }

    const weekendMode = String(raw.weekendMode || 'legacy').trim();
    if (!WEEKEND_MODES.includes(weekendMode)) {
      return { ...LEGACY_AVAILABILITY, dateOverrides: {} };
    }

    let supervisedEffectiveDate = null;
    if (raw.supervisedEffectiveDate != null && String(raw.supervisedEffectiveDate).trim() !== '') {
      const parts = isoDateParts(raw.supervisedEffectiveDate);
      if (!parts) return { ...LEGACY_AVAILABILITY, dateOverrides: {} };
      supervisedEffectiveDate = parts.iso;
    }

    if (weekendMode === 'supervised' && !supervisedEffectiveDate) {
      // Supervised without effective date must not activate — treat as legacy.
      return {
        version: CONTRACT_VERSION,
        businessTimezone: DEFAULT_BUSINESS_TIMEZONE,
        weekendMode: 'legacy',
        supervisedEffectiveDate: null,
        dateOverrides: {},
        updatedAt: raw.updatedAt || null,
        updatedBy: raw.updatedBy || null,
        _normalizedFrom: 'supervised_missing_effective_date',
      };
    }

    const tz = String(raw.businessTimezone || DEFAULT_BUSINESS_TIMEZONE).trim() || DEFAULT_BUSINESS_TIMEZONE;
    // Validate timezone early
    try {
      Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    } catch (_) {
      return { ...LEGACY_AVAILABILITY, dateOverrides: {} };
    }

    const dateOverrides = {};
    const srcOverrides = raw.dateOverrides && typeof raw.dateOverrides === 'object'
      ? raw.dateOverrides
      : {};
    for (const [key, value] of Object.entries(srcOverrides)) {
      const parts = isoDateParts(key);
      if (!parts) continue;
      const normalized = normalizeDateOverride(value);
      if (!normalized) continue;
      dateOverrides[parts.iso] = normalized;
    }

    return {
      version: CONTRACT_VERSION,
      businessTimezone: tz,
      weekendMode,
      supervisedEffectiveDate,
      dateOverrides,
      revision: normalizeRevision(raw.revision),
      updatedAt: raw.updatedAt || null,
      updatedBy: raw.updatedBy || null,
    };
  } catch (_) {
    return { ...LEGACY_AVAILABILITY, dateOverrides: {} };
  }
}

/**
 * Resolve the active weekend mode for a given instant.
 * Supervised only activates on/after supervisedEffectiveDate.
 */
function resolveActiveWeekendMode(config, now = new Date()) {
  const cfg = normalizeAvailabilityConfig(config);
  if (cfg.weekendMode !== 'supervised' || !cfg.supervisedEffectiveDate) {
    return {
      mode: 'legacy',
      config: cfg,
      activated: false,
      customerWeekendLabel: null,
    };
  }
  const today = businessTodayIso(cfg.businessTimezone, now);
  if (today < cfg.supervisedEffectiveDate) {
    return {
      mode: 'legacy',
      config: cfg,
      activated: false,
      customerWeekendLabel: null,
      activatesOn: cfg.supervisedEffectiveDate,
    };
  }
  return {
    mode: 'supervised',
    config: cfg,
    activated: true,
    customerWeekendLabel: CUSTOMER_WEEKEND_LABEL,
  };
}

function normalizePreferredTime(raw) {
  const t = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (LEGACY_TIME_PATTERNS.some((p) => p.test(t))) return null;
  const found = KNOWN_OPERATIONAL_SLOTS.find(
    (s) => s.toLowerCase() === t.toLowerCase()
  );
  if (found) return found;
  // Accept 24h admin shorthand for the optional late slot
  if (/^16:00$/.test(t) || /^4:00\s*pm$/i.test(t)) return '4:00 PM';
  return null;
}

function getDateOverride(config, iso) {
  const cfg = normalizeAvailabilityConfig(config);
  return cfg.dateOverrides[iso] || null;
}

/** Rule sources reported by resolveDateAvailability (admin preview, tests, logs). */
const RULE_SOURCES = Object.freeze({
  OVERRIDE_CLOSED: 'override_closed',
  HOLIDAY_OPENING: 'holiday_opening',
  HOLIDAY: 'holiday',
  OVERRIDE_OPEN: 'override_open',
  WEEKDAY: 'weekday',
  LEGACY_SATURDAY: 'legacy_saturday',
  LEGACY_SUNDAY: 'legacy_sunday_closed',
  SUPERVISED_WEEKEND: 'supervised_weekend_closed',
});

function defaultWindowsForDay(day) {
  return (day === 0 || day === 6) ? [...ALLOWED_SATURDAY_SLOTS] : [...ALLOWED_WEEKDAY_SLOTS];
}

/**
 * Single precedence authority for one calendar date (see the file header).
 * Returns the date's windows BEFORE same-day lead filtering, its capacity per
 * window and the rule that decided it. `opts.mode` forces 'legacy' or
 * 'supervised' (used to preview a future activation); by default the mode
 * active at `now` applies.
 */
function resolveDateAvailability(iso, config, now = new Date(), opts = {}) {
  const parts = isoDateParts(iso);
  if (!parts) return null;
  const resolved = resolveActiveWeekendMode(config, now);
  const cfg = resolved.config;
  const mode = opts.mode === 'legacy' || opts.mode === 'supervised' ? opts.mode : resolved.mode;
  const holiday = isClosedHoliday(parts.iso);
  const override = cfg.dateOverrides[parts.iso] || null;
  const out = (open, windows, source, capacity = 1) => ({
    date: parts.iso,
    day: parts.day,
    open: open && windows.length > 0,
    windows: open ? windows : [],
    capacity: open ? capacity : 0,
    source,
    holiday,
    mode,
    override: override ? { ...override } : null,
  });
  const overrideWindows = () => (override.arrivalWindows && override.arrivalWindows.length
    ? [...override.arrivalWindows]
    : defaultWindowsForDay(parts.day));
  const overrideCapacity = () => Math.max(1, Number(override.capacity) || 1);

  // 2. A closed override always closes the date.
  if (override && !override.enabled) return out(false, [], RULE_SOURCES.OVERRIDE_CLOSED);
  if (holiday) {
    // 3. Only an explicitly authorized holiday opening reopens a holiday.
    if (override && override.enabled && override.holidayOpening === true) {
      return out(true, overrideWindows(), RULE_SOURCES.HOLIDAY_OPENING, overrideCapacity());
    }
    // 4. Holiday closure beats a plain open override.
    return out(false, [], RULE_SOURCES.HOLIDAY);
  }
  // 7. Open override on an ordinary date.
  if (override && override.enabled) {
    return out(true, overrideWindows(), RULE_SOURCES.OVERRIDE_OPEN, overrideCapacity());
  }
  // 8. Base rule.
  if (parts.day >= 1 && parts.day <= 5) return out(true, [...ALLOWED_WEEKDAY_SLOTS], RULE_SOURCES.WEEKDAY);
  if (mode === 'supervised') return out(false, [], RULE_SOURCES.SUPERVISED_WEEKEND);
  if (parts.day === 6) return out(true, [...ALLOWED_SATURDAY_SLOTS], RULE_SOURCES.LEGACY_SATURDAY);
  return out(false, [], RULE_SOURCES.LEGACY_SUNDAY);
}

/**
 * Canonical slot list for a calendar date under the resolved availability mode.
 */
function slotsForDate(iso, config, now = new Date()) {
  const r = resolveDateAvailability(iso, config, now);
  if (!r || !r.open) return [];
  const cfg = normalizeAvailabilityConfig(config);
  return filterSameDaySlots(r.date, r.windows, now, cfg.businessTimezone);
}

/** Capacity per arrival window (1 unless an applicable open override sets it). */
function capacityForSlot(iso, preferredTime, config, now = new Date()) {
  const r = resolveDateAvailability(iso, config, now);
  if (!r || !r.open) return 1;
  return Math.max(1, Number(r.capacity) || 1);
}

function validateBookingSchedule(preferredDate, preferredTime, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const config = opts.config;
  const parts = isoDateParts(preferredDate);
  if (!parts) return { ok: false, error: 'booking_date_unavailable' };

  // Holidays are decided by resolveDateAvailability (through slotsForDate), so
  // an explicitly authorized holiday opening is honored here as well.
  const cfg = normalizeAvailabilityConfig(config);
  const minIso = earliestBookableIso(now, cfg.businessTimezone);
  if (parts.iso < minIso) {
    return { ok: false, error: 'booking_date_unavailable' };
  }

  const normalizedTime = normalizePreferredTime(preferredTime);
  if (!normalizedTime) return { ok: false, error: 'booking_time_unavailable' };

  const allowed = slotsForDate(parts.iso, cfg, now);
  if (!allowed.length) {
    // Same-day with only past/too-soon slots left reads as a time miss when a
    // concrete time was supplied; otherwise the date itself is closed.
    return {
      ok: false,
      error: parts.iso === businessTodayIso(cfg.businessTimezone, now)
        ? 'booking_time_unavailable'
        : 'booking_date_unavailable',
    };
  }
  if (!allowed.includes(normalizedTime)) {
    return { ok: false, error: 'booking_time_unavailable' };
  }

  const resolved = resolveActiveWeekendMode(cfg, now);
  return {
    ok: true,
    preferredDate: parts.iso,
    preferredTime: normalizedTime,
    weekendMode: resolved.mode,
    isWeekend: parts.day === 0 || parts.day === 6,
    capacity: capacityForSlot(parts.iso, normalizedTime, cfg, now),
    sameDayLateSlot: isSameDayLateSlot(parts.iso, normalizedTime, now, cfg.businessTimezone),
  };
}

/**
 * Find nearby open slots after a preferred date (for recovery UX).
 * Does not auto-select; returns candidates only.
 */
function findNearbyOpenings(fromDate, config, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 6));
  const horizonDays = Math.min(60, Math.max(7, Number(opts.horizonDays) || 21));
  const occupancy = opts.occupancy || {}; // { 'YYYY-MM-DD|8:00 AM': count }
  const acceptsStart = typeof opts.acceptsStart === 'function' ? opts.acceptsStart : null;
  const cfg = normalizeAvailabilityConfig(config);
  const startParts = isoDateParts(fromDate) || isoDateParts(earliestBookableIso(now));
  if (!startParts) return [];

  const minIso = earliestBookableIso(now);
  const results = [];
  let cursor = new Date(startParts.y, startParts.mo - 1, startParts.d);

  for (let i = 0; i < horizonDays && results.length < limit; i += 1) {
    const iso = toIsoLocal(cursor);
    cursor = addLocalDays(cursor, 1);
    if (iso < minIso) continue;
    if (iso < startParts.iso && opts.earliestAfterOnly !== false) {
      // include fromDate itself when scanning "nearby"
    }
    const slots = slotsForDate(iso, cfg, now);
    for (const slot of slots) {
      const cap = capacityForSlot(iso, slot, cfg, now);
      const used = Number(occupancy[`${iso}|${slot}`]) || 0;
      if (used >= cap) continue;
      if (acceptsStart && !acceptsStart(iso, slot)) continue;
      results.push({
        preferredDate: iso,
        preferredTime: slot,
        isWeekend: (() => {
          const p = isoDateParts(iso);
          return !!(p && (p.day === 0 || p.day === 6));
        })(),
        remaining: cap - used,
      });
      if (results.length >= limit) break;
    }
  }
  return results;
}

/** Public reasons a date is closed (weekend base rules are derivable client-side). */
const PUBLIC_CLOSED_SOURCES = new Set([RULE_SOURCES.OVERRIDE_CLOSED, RULE_SOURCES.HOLIDAY]);

function horizonIsoDates(fromIso, days) {
  const start = isoDateParts(fromIso);
  if (!start) return [];
  const out = [];
  let d = new Date(start.y, start.mo - 1, start.d);
  for (let i = 0; i < days; i += 1) {
    out.push(toIsoLocal(d));
    d = addLocalDays(d, 1);
  }
  return out;
}

/**
 * Public/safe projection for booking clients (no internal notes).
 * `closedDates` lists every date in the horizon that is closed by an explicit
 * closure or a holiday, so the calendar never offers a known closed date.
 */
function projectPublicAvailability(config, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const horizonDays = Math.min(120, Math.max(14, Number(opts.horizonDays) || 90));
  const resolved = resolveActiveWeekendMode(config, now);
  const cfg = resolved.config;
  const minIso = earliestBookableIso(now);
  const today = businessTodayIso(cfg.businessTimezone, now);

  const publicOverrides = {};
  const closedDates = [];
  const dates = horizonIsoDates(today, horizonDays);
  for (const iso of dates) {
    const r = resolveDateAvailability(iso, cfg, now);
    if (!r) continue;
    if (!r.open && PUBLIC_CLOSED_SOURCES.has(r.source)) closedDates.push(iso);
    const ov = cfg.dateOverrides[iso];
    // Public surface: only enabled overrides that actually apply (no notes).
    if (!ov || !ov.enabled) continue;
    if (r.source !== RULE_SOURCES.OVERRIDE_OPEN && r.source !== RULE_SOURCES.HOLIDAY_OPENING) continue;
    publicOverrides[iso] = {
      enabled: true,
      capacity: ov.capacity || 1,
      arrivalWindows: ov.arrivalWindows ? [...ov.arrivalWindows] : undefined,
      ...(r.source === RULE_SOURCES.HOLIDAY_OPENING ? { holidayOpening: true } : {}),
    };
  }

  return {
    ok: true,
    status: 'available',
    contractVersion: CONTRACT_VERSION,
    businessTimezone: cfg.businessTimezone,
    weekendMode: resolved.mode,
    supervisedActivated: resolved.activated,
    customerWeekendLabel: resolved.customerWeekendLabel,
    minAdvanceDays: MIN_ADVANCE_DAYS,
    sameDayLeadMinutes: SAME_DAY_LEAD_MINUTES,
    earliestBookable: minIso,
    weekdaySlots: [...ALLOWED_WEEKDAY_SLOTS],
    saturdaySlots: [...ALLOWED_SATURDAY_SLOTS],
    dateOverrides: publicOverrides,
    closedDates,
    horizonStart: dates[0] || today,
    horizonEnd: dates[dates.length - 1] || today,
    today,
  };
}

/**
 * Admin projection includes internal notes + full overrides.
 */
function projectAdminAvailability(config, opts = {}) {
  const cfg = normalizeAvailabilityConfig(config);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const active = resolveActiveWeekendMode(cfg, now);
  return {
    ...cfg,
    contractVersion: CONTRACT_VERSION,
    activeMode: active.mode,
    supervisedActivated: active.activated,
    defaults: {
      weekdaySlots: [...ALLOWED_WEEKDAY_SLOTS],
      saturdaySlots: [...ALLOWED_SATURDAY_SLOTS],
      knownSlots: [...KNOWN_OPERATIONAL_SLOTS],
      minAdvanceDays: MIN_ADVANCE_DAYS,
      sameDayLeadMinutes: SAME_DAY_LEAD_MINUTES,
      businessTimezone: DEFAULT_BUSINESS_TIMEZONE,
      weekendModes: [...WEEKEND_MODES],
    },
    customerWeekendLabel: CUSTOMER_WEEKEND_LABEL,
  };
}

/**
 * Admin effective calendar: what a customer can book on each date right now,
 * why, how much is already reserved, and what changes once a scheduled
 * supervised-weekend activation takes effect.
 */
function projectEffectiveCalendar(config, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const days = Math.min(120, Math.max(1, Math.floor(Number(opts.days)) || 56));
  const resolved = resolveActiveWeekendMode(config, now);
  const cfg = resolved.config;
  const today = businessTodayIso(cfg.businessTimezone, now);
  const from = isoDateParts(opts.from) && opts.from >= today ? opts.from : today;
  const occupancy = opts.occupancy || {};
  const pendingActivation = cfg.weekendMode === 'supervised'
    && cfg.supervisedEffectiveDate
    && !resolved.activated
    ? cfg.supervisedEffectiveDate
    : null;

  const out = horizonIsoDates(from, days).map((iso) => {
    const r = resolveDateAvailability(iso, cfg, now);
    const windows = r.open ? filterSameDaySlots(iso, r.windows, now, cfg.businessTimezone) : [];
    const perWindow = {};
    let booked = 0;
    for (const slot of KNOWN_OPERATIONAL_SLOTS) {
      const n = Number(occupancy[`${iso}|${slot}`]) || 0;
      if (n > 0) {
        perWindow[slot] = n;
        booked += n;
      }
    }
    const row = {
      date: iso,
      day: r.day,
      open: windows.length > 0,
      windows,
      capacity: r.open ? r.capacity : 0,
      source: r.source,
      holiday: r.holiday,
      note: r.override && r.override.note ? r.override.note : null,
      booked,
      bookedByWindow: perWindow,
    };
    if (pendingActivation && iso >= pendingActivation) {
      const after = resolveDateAvailability(iso, cfg, now, { mode: 'supervised' });
      if (after.open !== r.open) {
        row.afterActivation = {
          activatesOn: pendingActivation,
          open: after.open,
          windows: after.windows,
          source: after.source,
        };
      }
    }
    return row;
  });

  return {
    today,
    activeMode: resolved.mode,
    configuredMode: cfg.weekendMode,
    supervisedEffectiveDate: cfg.supervisedEffectiveDate,
    pendingActivation,
    days: out,
  };
}

module.exports = {
  CONTRACT_VERSION,
  ALLOWED_WEEKDAY_SLOTS,
  ALLOWED_SATURDAY_SLOTS,
  KNOWN_OPERATIONAL_SLOTS,
  MIN_ADVANCE_DAYS,
  SAME_DAY_LEAD_MINUTES,
  SAME_DAY_LATE_SLOT,
  DEFAULT_BUSINESS_TIMEZONE,
  LEGACY_AVAILABILITY,
  CUSTOMER_WEEKEND_LABEL,
  WEEKEND_MODES,
  RULE_SOURCES,
  isoDateParts,
  toIsoLocal,
  addLocalDays,
  earliestBookableIso,
  businessTodayIso,
  businessMinutesNow,
  slotStartMinutes,
  filterSameDaySlots,
  isSameDayLateSlot,
  getHolidaySet,
  isClosedHoliday,
  normalizePreferredTime,
  normalizeArrivalWindows,
  normalizeAvailabilityConfig,
  normalizeDateOverride,
  inspectAvailabilityConfig,
  resolveActiveWeekendMode,
  resolveDateAvailability,
  getDateOverride,
  slotsForDate,
  capacityForSlot,
  validateBookingSchedule,
  findNearbyOpenings,
  horizonIsoDates,
  projectPublicAvailability,
  projectEffectiveCalendar,
  projectAdminAvailability,
};
