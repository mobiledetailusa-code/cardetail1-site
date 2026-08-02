/**
 * Schedule flexibility preference — booking data only.
 * Does not reserve multiple dates or auto-change appointments.
 */
const FLEXIBILITY_VALUES = Object.freeze(['exact', 'within_3_days', 'earliest_after_date']);

const FLEXIBILITY_LABELS = Object.freeze({
  exact: 'Exact date only',
  within_3_days: 'Flexible within 3 days — Recommended',
  earliest_after_date: 'First available on or after my selected date',
});

/**
 * Normalize flexibility for storage/read.
 * Empty/missing → exact (legacy default). Invalid → exact (safe).
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

module.exports = {
  FLEXIBILITY_VALUES,
  FLEXIBILITY_LABELS,
  normalizeScheduleFlexibility,
  scheduleFlexibilityLabel,
};
