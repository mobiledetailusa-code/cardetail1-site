/**
 * Schedule flexibility preference — booking data only.
 * Does not reserve multiple dates or auto-change appointments.
 *
 * New UI emits: exact | alternate_date
 * Legacy readable: within_3_days | earliest_after_date
 */
const FLEXIBILITY_VALUES = Object.freeze([
  'exact',
  'alternate_date',
  'within_3_days',
  'earliest_after_date',
]);

const FLEXIBILITY_LABELS = Object.freeze({
  exact: 'Exact date only',
  alternate_date: 'Has alternate date',
  within_3_days: 'Flexible within 3 days',
  earliest_after_date: 'First available on or after selected date',
});

/**
 * Normalize flexibility for storage/read.
 * Empty/missing → exact. Unknown → exact (safe).
 */
function normalizeScheduleFlexibility(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'exact';
  if (FLEXIBILITY_VALUES.includes(v)) return v;
  return 'exact';
}

function scheduleFlexibilityLabel(raw) {
  const v = normalizeScheduleFlexibility(raw);
  return FLEXIBILITY_LABELS[v] || FLEXIBILITY_LABELS.exact;
}

/** True when the customer provided an alternate preference (new or legacy flexible). */
function hasAlternatePreference(raw) {
  const v = normalizeScheduleFlexibility(raw);
  return v === 'alternate_date' || v === 'within_3_days' || v === 'earliest_after_date';
}

module.exports = {
  FLEXIBILITY_VALUES,
  FLEXIBILITY_LABELS,
  normalizeScheduleFlexibility,
  scheduleFlexibilityLabel,
  hasAlternatePreference,
};
