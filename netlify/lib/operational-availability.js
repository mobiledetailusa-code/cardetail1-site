/**
 * Operational availability contract — UI-independent schedule authority.
 *
 * Consumed by: Admin Ops, booking client, submit-booking validation,
 * future Owner Studio / Availability, and Twilio scheduling messages.
 *
 * NOT stored in OsCatalogDraft. Persisted via ops-config availability blob.
 *
 * Fail-safe: missing or invalid config resolves to complete LEGACY behavior
 * (Saturday open with 2 slots, Sunday closed). Never partially merges bad rules.
 */

const ALLOWED_WEEKDAY_SLOTS = Object.freeze(['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM']);
const ALLOWED_SATURDAY_SLOTS = Object.freeze(['8:00 AM', '10:00 AM']);
const MIN_ADVANCE_DAYS = 3;
const DEFAULT_BUSINESS_TIMEZONE = 'America/New_York';
const CONTRACT_VERSION = 1;
const WEEKEND_MODES = Object.freeze(['legacy', 'supervised']);
const CUSTOMER_WEEKEND_LABEL = 'Limited weekend availability';

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

function earliestBookableIso(now = new Date()) {
  return toIsoLocal(addLocalDays(now, MIN_ADVANCE_DAYS));
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
  return {
    enabled,
    capacity,
    ...(arrivalWindows ? { arrivalWindows } : {}),
    ...(note ? { note } : {}),
  };
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
  const t = String(raw || '').trim();
  if (!t) return null;
  if (LEGACY_TIME_PATTERNS.some((p) => p.test(t))) return null;
  const found = ALLOWED_WEEKDAY_SLOTS.find(
    (s) => s.toLowerCase() === t.replace(/\s+/g, ' ').toLowerCase()
  );
  return found || null;
}

function getDateOverride(config, iso) {
  const cfg = normalizeAvailabilityConfig(config);
  return cfg.dateOverrides[iso] || null;
}

/**
 * Canonical slot list for a calendar date under the resolved availability mode.
 */
function slotsForDate(iso, config, now = new Date()) {
  const parts = isoDateParts(iso);
  if (!parts) return [];
  if (isClosedHoliday(parts.iso)) return [];

  const resolved = resolveActiveWeekendMode(config, now);
  const cfg = resolved.config;
  const override = cfg.dateOverrides[parts.iso];

  // Explicit override always wins for that date (weekday or weekend).
  if (override) {
    if (!override.enabled) return [];
    if (override.arrivalWindows && override.arrivalWindows.length) {
      return [...override.arrivalWindows];
    }
    // Enabled override without windows: weekend → sat slots; weekday → weekday slots
    if (parts.day === 0 || parts.day === 6) return [...ALLOWED_SATURDAY_SLOTS];
    return [...ALLOWED_WEEKDAY_SLOTS];
  }

  if (parts.day >= 1 && parts.day <= 5) {
    return [...ALLOWED_WEEKDAY_SLOTS];
  }

  // Weekend without override
  if (resolved.mode === 'supervised') {
    // Closed unless explicitly enabled above
    return [];
  }

  // Legacy: Saturday open, Sunday closed
  if (parts.day === 0) return [];
  if (parts.day === 6) return [...ALLOWED_SATURDAY_SLOTS];
  return [];
}

function capacityForSlot(iso, preferredTime, config, now = new Date()) {
  const parts = isoDateParts(iso);
  if (!parts) return 1;
  const cfg = normalizeAvailabilityConfig(config);
  const override = cfg.dateOverrides[parts.iso];
  if (override && override.enabled) {
    return Math.max(1, Number(override.capacity) || 1);
  }
  return 1;
}

function validateBookingSchedule(preferredDate, preferredTime, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const config = opts.config;
  const parts = isoDateParts(preferredDate);
  if (!parts) return { ok: false, error: 'booking_date_unavailable' };

  if (isClosedHoliday(parts.iso)) {
    return { ok: false, error: 'booking_date_unavailable' };
  }

  const cfg = normalizeAvailabilityConfig(config);
  const minIso = earliestBookableIso(now);
  if (parts.iso < minIso) {
    return { ok: false, error: 'booking_date_unavailable' };
  }

  const normalizedTime = normalizePreferredTime(preferredTime);
  if (!normalizedTime) return { ok: false, error: 'booking_time_unavailable' };

  const allowed = slotsForDate(parts.iso, cfg, now);
  if (!allowed.length) {
    return { ok: false, error: 'booking_date_unavailable' };
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

/**
 * Public/safe projection for booking clients (no internal notes).
 */
function projectPublicAvailability(config, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const horizonDays = Math.min(120, Math.max(14, Number(opts.horizonDays) || 90));
  const resolved = resolveActiveWeekendMode(config, now);
  const cfg = resolved.config;
  const minIso = earliestBookableIso(now);
  const today = businessTodayIso(cfg.businessTimezone, now);

  const publicOverrides = {};
  const start = isoDateParts(today) || isoDateParts(toIsoLocal(now));
  if (start) {
    let d = new Date(start.y, start.mo - 1, start.d);
    for (let i = 0; i < horizonDays; i += 1) {
      const iso = toIsoLocal(d);
      d = addLocalDays(d, 1);
      const ov = cfg.dateOverrides[iso];
      // Public surface: only enabled overrides (no closed-date leakage, no notes).
      if (!ov || !ov.enabled) continue;
      publicOverrides[iso] = {
        enabled: true,
        capacity: ov.capacity || 1,
        arrivalWindows: ov.arrivalWindows ? [...ov.arrivalWindows] : undefined,
      };
    }
  }

  return {
    ok: true,
    contractVersion: CONTRACT_VERSION,
    businessTimezone: cfg.businessTimezone,
    weekendMode: resolved.mode,
    supervisedActivated: resolved.activated,
    customerWeekendLabel: resolved.customerWeekendLabel,
    minAdvanceDays: MIN_ADVANCE_DAYS,
    earliestBookable: minIso,
    weekdaySlots: [...ALLOWED_WEEKDAY_SLOTS],
    saturdaySlots: [...ALLOWED_SATURDAY_SLOTS],
    dateOverrides: publicOverrides,
    today,
  };
}

/**
 * Admin projection includes internal notes + full overrides.
 */
function projectAdminAvailability(config) {
  const cfg = normalizeAvailabilityConfig(config);
  return {
    ...cfg,
    contractVersion: CONTRACT_VERSION,
    defaults: {
      weekdaySlots: [...ALLOWED_WEEKDAY_SLOTS],
      saturdaySlots: [...ALLOWED_SATURDAY_SLOTS],
      minAdvanceDays: MIN_ADVANCE_DAYS,
      businessTimezone: DEFAULT_BUSINESS_TIMEZONE,
      weekendModes: [...WEEKEND_MODES],
    },
    customerWeekendLabel: CUSTOMER_WEEKEND_LABEL,
  };
}

module.exports = {
  CONTRACT_VERSION,
  ALLOWED_WEEKDAY_SLOTS,
  ALLOWED_SATURDAY_SLOTS,
  MIN_ADVANCE_DAYS,
  DEFAULT_BUSINESS_TIMEZONE,
  LEGACY_AVAILABILITY,
  CUSTOMER_WEEKEND_LABEL,
  WEEKEND_MODES,
  isoDateParts,
  toIsoLocal,
  addLocalDays,
  earliestBookableIso,
  businessTodayIso,
  getHolidaySet,
  isClosedHoliday,
  normalizePreferredTime,
  normalizeAvailabilityConfig,
  normalizeDateOverride,
  resolveActiveWeekendMode,
  getDateOverride,
  slotsForDate,
  capacityForSlot,
  validateBookingSchedule,
  findNearbyOpenings,
  projectPublicAvailability,
  projectAdminAvailability,
};
