/**
 * Customer preferred arrival windows — separate from internal operational slots.
 *
 * preferredArrivalWindow  = customer-facing three-hour preference
 * preferredTime           = one internal operational slot (capacity / soft-hold / conflict)
 * confirmedTimeWindow     = admin-confirmed window (unchanged)
 *
 * A window means the tech may arrive anytime within the range — not service duration.
 * Internal inventory is discrete (e.g. 8:00 / 10:00 / 12:00 / 2:00 / optional 4:00).
 */
const ARRIVAL_WINDOW_VALUES = Object.freeze([
  '08:00-11:00',
  '09:00-12:00',
  '10:00-13:00',
  '11:00-14:00',
  '12:00-15:00',
  '13:00-16:00',
  '14:00-17:00',
  '15:00-18:00',
  '16:00-19:00',
  'anytime',
]);

const ARRIVAL_WINDOW_LABELS = Object.freeze({
  '08:00-11:00': '8:00 AM – 11:00 AM',
  '09:00-12:00': '9:00 AM – 12:00 PM',
  '10:00-13:00': '10:00 AM – 1:00 PM',
  '11:00-14:00': '11:00 AM – 2:00 PM',
  '12:00-15:00': '12:00 PM – 3:00 PM',
  '13:00-16:00': '1:00 PM – 4:00 PM',
  '14:00-17:00': '2:00 PM – 5:00 PM',
  '15:00-18:00': '3:00 PM – 6:00 PM',
  '16:00-19:00': '4:00 PM – 7:00 PM',
  anytime: 'Any time that day',
});

/** Window bounds in minutes from midnight (inclusive start and end for slot starts). */
const WINDOW_BOUNDS_MINUTES = Object.freeze({
  '08:00-11:00': [8 * 60, 11 * 60],
  '09:00-12:00': [9 * 60, 12 * 60],
  '10:00-13:00': [10 * 60, 13 * 60],
  '11:00-14:00': [11 * 60, 14 * 60],
  '12:00-15:00': [12 * 60, 15 * 60],
  '13:00-16:00': [13 * 60, 16 * 60],
  '14:00-17:00': [14 * 60, 17 * 60],
  '15:00-18:00': [15 * 60, 18 * 60],
  '16:00-19:00': [16 * 60, 19 * 60],
});

/**
 * Known operational slot labels (display form used in bookings).
 * 4:00 PM is supported when owner enables it for a date — not a legacy default.
 */
const KNOWN_OPERATIONAL_SLOTS = Object.freeze([
  '8:00 AM',
  '10:00 AM',
  '12:00 PM',
  '2:00 PM',
  '4:00 PM',
]);

const SLOT_MINUTES = Object.freeze({
  '8:00 AM': 8 * 60,
  '10:00 AM': 10 * 60,
  '12:00 PM': 12 * 60,
  '2:00 PM': 14 * 60,
  '4:00 PM': 16 * 60,
});

const ERROR_ARRIVAL_WINDOW_UNAVAILABLE = 'arrival_window_unavailable';

function normalizeArrivalWindow(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (ARRIVAL_WINDOW_VALUES.includes(v)) return v;
  return '';
}

function arrivalWindowLabel(raw) {
  const v = normalizeArrivalWindow(raw);
  return v ? (ARRIVAL_WINDOW_LABELS[v] || v) : '';
}

function slotStartMinutes(slotLabel) {
  const key = String(slotLabel || '').replace(/\s+/g, ' ').trim();
  if (Object.prototype.hasOwnProperty.call(SLOT_MINUTES, key)) return SLOT_MINUTES[key];
  // Accept 24h forms from admin custom input (e.g. "16:00")
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(key);
  if (m24) {
    const h = +m24[1];
    const min = +m24[2];
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return h * 60 + min;
  }
  return null;
}

/**
 * Operational slots whose start falls inside the customer arrival window.
 * anytime → all provided slots (order preserved).
 */
function eligibleOperationalSlots(arrivalWindow, allowedSlots) {
  const window = normalizeArrivalWindow(arrivalWindow);
  const allowed = Array.isArray(allowedSlots) ? allowedSlots.filter(Boolean) : [];
  if (!window || !allowed.length) return [];

  if (window === 'anytime') return [...allowed];

  const bounds = WINDOW_BOUNDS_MINUTES[window];
  if (!bounds) return [];
  const [start, end] = bounds;
  return allowed.filter((slot) => {
    const mins = slotStartMinutes(slot);
    if (mins == null) return false;
    return mins >= start && mins <= end;
  });
}

/**
 * Which customer windows have at least one compatible operational slot.
 */
function availableArrivalWindows(allowedSlots) {
  return ARRIVAL_WINDOW_VALUES.filter(
    (w) => eligibleOperationalSlots(w, allowedSlots).length > 0
  );
}

/**
 * Resolve one internal operational slot for a customer arrival window.
 * Does not silently map to an incompatible slot.
 * @param {string} preferredDate ISO date (unused for math; kept for call-site clarity)
 * @param {string} arrivalWindow enum
 * @param {string[]} allowedSlots slots already filtered for that date (and ideally free)
 * @returns {{ ok: true, preferredTime: string, preferredArrivalWindow: string, eligible: string[] }
 *   | { ok: false, error: string }}
 */
function resolveOperationalSlot(preferredDate, arrivalWindow, allowedSlots) {
  const window = normalizeArrivalWindow(arrivalWindow);
  if (!window) return { ok: false, error: ERROR_ARRIVAL_WINDOW_UNAVAILABLE };

  const allowed = Array.isArray(allowedSlots) ? allowedSlots : [];
  if (!allowed.length) return { ok: false, error: 'booking_date_unavailable' };

  const eligible = eligibleOperationalSlots(window, allowed);
  if (!eligible.length) {
    return { ok: false, error: ERROR_ARRIVAL_WINDOW_UNAVAILABLE };
  }

  return {
    ok: true,
    preferredTime: eligible[0],
    preferredArrivalWindow: window,
    eligible,
  };
}

function isValidArrivalWindow(raw) {
  return !!normalizeArrivalWindow(raw);
}

/** Structural compatibility only — used by UI to enable/disable options. */
function windowCompatibleWithSlots(arrivalWindow, allowedSlots) {
  return eligibleOperationalSlots(arrivalWindow, allowedSlots).length > 0;
}

module.exports = {
  ARRIVAL_WINDOW_VALUES,
  ARRIVAL_WINDOW_LABELS,
  WINDOW_BOUNDS_MINUTES,
  KNOWN_OPERATIONAL_SLOTS,
  SLOT_MINUTES,
  ERROR_ARRIVAL_WINDOW_UNAVAILABLE,
  normalizeArrivalWindow,
  arrivalWindowLabel,
  slotStartMinutes,
  eligibleOperationalSlots,
  availableArrivalWindows,
  resolveOperationalSlot,
  isValidArrivalWindow,
  windowCompatibleWithSlots,
};
