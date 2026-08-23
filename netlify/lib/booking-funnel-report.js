// Pure, read-only booking-request funnel aggregation over revenue event records.

const STAGES = Object.freeze([
  { key: 'home', label: 'Homepage viewed' },
  { key: 'open', label: 'Booking opened' },
  { key: 'category', label: 'Category completed' },
  { key: 'package', label: 'Package completed' },
  { key: 'vehicle', label: 'Vehicle completed' },
  { key: 'info', label: 'Info completed' },
  { key: 'review', label: 'Review reached' },
  { key: 'submitted', label: 'Booking submitted' },
]);

const BOOKING_ID_PATTERN = /^CD1-[A-Z0-9][A-Z0-9-]{2,123}$/;

function asRecord(value) {
  if (!value || typeof value !== 'object') return null;
  return value.record && typeof value.record === 'object' ? value.record : value;
}

function stageFor(record) {
  const event = String(record.event || '');
  const props = record.properties && typeof record.properties === 'object' ? record.properties : {};
  if (event === 'page_view' && props.page_type === 'home') return 'home';
  if (event === 'booking_started') return 'open';
  if (event === 'booking_step_completed') {
    const steps = { 1: 'category', 2: 'package', 3: 'vehicle', 4: 'info' };
    return steps[Number(props.booking_step)] || null;
  }
  if (event === 'booking_review_reached' && Number(props.booking_step) === 5) return 'review';
  if (event === 'booking_submitted' && BOOKING_ID_PATTERN.test(String(props.booking_id || ''))) return 'submitted';
  return null;
}

function receivedTime(record) {
  const value = Date.parse(String(record.receivedAt || ''));
  return Number.isFinite(value) ? value : null;
}

function sessionFor(record) {
  const props = record.properties && typeof record.properties === 'object' ? record.properties : {};
  const sid = String(props.anonymous_session_id || record.anonymous_session_id || '');
  return /^sess_[A-Za-z0-9_-]{1,120}$/.test(sid) ? sid : null;
}

function emptyCounts() {
  return STAGES.reduce((out, stage) => {
    out[stage.key] = 0;
    return out;
  }, {});
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function summarize(sessionStages, cohortSessions) {
  const counts = emptyCounts();
  const bookingIds = new Set();

  for (const sid of cohortSessions) {
    const stages = sessionStages.get(sid);
    if (!stages) continue;
    for (const stage of STAGES) {
      if (stages.has(stage.key)) counts[stage.key] += 1;
    }
    const submitted = stages.get('submitted');
    if (submitted && submitted.bookingId) bookingIds.add(submitted.bookingId);
  }

  return {
    sessions: cohortSessions.size,
    counts,
    uniqueSubmittedBookings: bookingIds.size,
    ratesPercent: {
      homeToOpen: rate(counts.open, counts.home),
      openToCategory: rate(counts.category, counts.open),
      categoryToPackage: rate(counts.package, counts.category),
      packageToVehicle: rate(counts.vehicle, counts.package),
      vehicleToInfo: rate(counts.info, counts.vehicle),
      infoToReview: rate(counts.review, counts.info),
      reviewToSubmitted: rate(counts.submitted, counts.review),
      homeToSubmitted: rate(counts.submitted, counts.home),
    },
  };
}

function buildBookingFunnelReport(values, options = {}) {
  const input = Array.isArray(values) ? values : [];
  const releaseAt = Date.parse(String(options.releaseAt || ''));
  if (!Number.isFinite(releaseAt)) throw new Error('releaseAt must be a valid ISO timestamp');

  const sessionStages = new Map();
  for (const value of input) {
    const record = asRecord(value);
    if (!record) continue;
    const stage = stageFor(record);
    const sid = sessionFor(record);
    const at = receivedTime(record);
    if (!stage || !sid || at == null) continue;
    if (!sessionStages.has(sid)) sessionStages.set(sid, new Map());
    const stages = sessionStages.get(sid);
    const existing = stages.get(stage);
    if (!existing || at < existing.receivedAt) {
      const props = record.properties || {};
      stages.set(stage, {
        receivedAt: at,
        bookingId: stage === 'submitted' && BOOKING_ID_PATTERN.test(String(props.booking_id || ''))
          ? String(props.booking_id)
          : null,
      });
    }
  }

  const pre = new Set();
  const post = new Set();
  let sessionsWithoutHomepage = 0;
  for (const [sid, stages] of sessionStages) {
    const firstHome = stages.get('home');
    if (!firstHome) {
      sessionsWithoutHomepage += 1;
      continue;
    }
    (firstHome.receivedAt < releaseAt ? pre : post).add(sid);
  }

  return {
    schemaVersion: 1,
    cohortRule: 'first homepage page_view server receivedAt',
    canonicalDeduplication: 'earliest valid event per session and canonical stage',
    releaseAt: new Date(releaseAt).toISOString(),
    preRelease: summarize(sessionStages, pre),
    postRelease: summarize(sessionStages, post),
    excluded: {
      sessionsWithoutHomepage,
    },
  };
}

module.exports = {
  STAGES,
  BOOKING_ID_PATTERN,
  buildBookingFunnelReport,
  stageFor,
};
