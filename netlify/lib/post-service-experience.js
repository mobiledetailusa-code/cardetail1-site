/**
 * Post-service customer experience — completion anchor, review eligibility and
 * the 48-hour service-issue window.
 *
 * This module is the single authority for "can the customer still act on this
 * finished job?". Every answer is derived from server time and the booking's own
 * completion anchor; the browser clock is never an input. It is read-only: it
 * computes state and validates submissions, but it never writes.
 *
 * It adds one new dimension — customer resolution — that no existing enum owns.
 * Operational status (jobStatus/serviceStatus) and payment status stay exactly
 * where they are; leaving a review or reporting an issue must never rewrite them.
 */

const SERVICE_ISSUE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** none → review_available → issue_submitted → closed (issue_window_open is the live state). */
const CUSTOMER_RESOLUTION_STATUSES = [
  'none',
  'review_available',
  'issue_window_open',
  'issue_submitted',
  'closed',
];

const ISSUE_CATEGORIES = [
  'quality',
  'damage',
  'missed_area',
  'timeliness',
  'billing',
  'conduct',
  'other',
];

const ISSUE_WINDOW_CLOSED_MESSAGE =
  'The online service issue window has closed. Please contact support for further assistance.';

const REVIEW_CTA_LABEL = 'Leave a review';
const ISSUE_CTA_LABEL = 'Report a service issue';

function toMillis(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * Server clock. An unparseable or absent argument falls back to now rather than
 * to zero — the window must never accidentally spring open because a caller
 * passed something odd.
 */
function serverNow(now) {
  const t = toMillis(now);
  return t == null ? Date.now() : t;
}

function parseInstant(value) {
  return toMillis(value);
}

/**
 * The completion anchor. `completedAt` is written once when Admin completes the
 * job and is deliberately preserved through a reopen, so a reopen can never
 * silently restart or extend a customer's 48-hour window.
 */
function completionAnchor(booking) {
  if (!booking) return null;
  return parseInstant(
    booking.completedAt
    || booking.jobCompletedAt
    || booking.techCompletedAt
    || null
  );
}

function isCompleted(booking) {
  if (!booking) return false;
  if (completionAnchor(booking) != null) return true;
  const js = String(booking.jobStatus || '').toLowerCase();
  const svc = String(booking.serviceStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  return js === 'completed_paid'
    || js === 'completed_pending_payment'
    || js === 'completed_pending_admin_review'
    || svc === 'closed'
    || svc === 'service_completed'
    || svc === 'awaiting_customer_action'
    || st === 'completed';
}

function reviewRecord(booking) {
  if (!booking) return null;
  if (booking.review && typeof booking.review === 'object') return booking.review;
  if (booking.reviewId || booking.reviewLeft === true) {
    return {
      reviewId: booking.reviewId || '',
      stars: Number(booking.reviewStars) || 0,
      submittedAt: booking.reviewSubmittedAt || null,
      legacy: true,
    };
  }
  return null;
}

function issueRecords(booking) {
  const rows = Array.isArray(booking && booking.serviceIssues) ? booking.serviceIssues : [];
  if (rows.length) return rows;
  // Legacy single-note issue captured before structured issues existed.
  if (booking && booking.customerIssueNote) {
    return [{
      issueId: booking.customerIssueId || 'legacy',
      category: 'other',
      description: String(booking.customerIssueNote),
      createdAt: booking.customerIssueAt || booking.updatedAt || null,
      status: booking.customerIssueStatus || 'open',
      legacy: true,
    }];
  }
  return [];
}

/**
 * Full post-service state for one booking, evaluated against server time.
 * Callers project this to Admin and My Garage so both portals agree.
 */
function postServiceState(booking, now = Date.now()) {
  const at = serverNow(now);
  const completedAtMs = completionAnchor(booking);
  const completed = isCompleted(booking);
  const review = reviewRecord(booking);
  const issues = issueRecords(booking);

  const issueWindowClosesAtMs = completedAtMs != null
    ? completedAtMs + SERVICE_ISSUE_WINDOW_MS
    : null;
  const issueWindowOpen = issueWindowClosesAtMs != null && at <= issueWindowClosesAtMs;
  const issueWindowMsRemaining = issueWindowOpen
    ? Math.max(0, issueWindowClosesAtMs - at)
    : 0;

  // A review stays available after the issue window closes — only completion and
  // the one-review-per-booking rule gate it.
  const reviewAvailable = completed && !review;
  const issueAvailable = completed && issueWindowOpen;

  let customerResolutionStatus = 'none';
  if (issues.length) customerResolutionStatus = 'issue_submitted';
  else if (issueAvailable) customerResolutionStatus = 'issue_window_open';
  else if (reviewAvailable) customerResolutionStatus = 'review_available';
  else if (completed) customerResolutionStatus = 'closed';

  return {
    completed,
    completedAt: completedAtMs != null ? new Date(completedAtMs).toISOString() : null,
    customerResolutionStatus,
    review: {
      available: reviewAvailable,
      submitted: !!review,
      label: REVIEW_CTA_LABEL,
      reviewId: review ? String(review.reviewId || '') : '',
      stars: review ? Number(review.stars) || 0 : 0,
      submittedAt: review ? (review.submittedAt || null) : null,
    },
    serviceIssue: {
      available: issueAvailable,
      label: ISSUE_CTA_LABEL,
      windowOpen: issueWindowOpen,
      windowClosesAt: issueWindowClosesAtMs != null
        ? new Date(issueWindowClosesAtMs).toISOString()
        : null,
      // hoursRemaining is stable enough for sync hashing; msRemaining and nested
      // serverTime change every poll and poison notModified (portal flicker).
      hoursRemaining: Math.floor(issueWindowMsRemaining / 3600000),
      submitted: issues.length > 0,
      count: issues.length,
      closedMessage: (completed && !issueWindowOpen) ? ISSUE_WINDOW_CLOSED_MESSAGE : '',
    },
  };
}

/**
 * Review gate. One review per completed booking; a booking that has not been
 * completed has nothing to review yet.
 */
function evaluateReviewSubmission(booking, { stars, comment } = {}, now = Date.now()) {
  const state = postServiceState(booking, now);
  if (!state.completed) {
    return {
      ok: false,
      error: 'review_not_available',
      statusCode: 409,
      message: 'A review can be left once the service is completed.',
      state,
    };
  }
  if (state.review.submitted) {
    return {
      ok: false,
      error: 'review_already_submitted',
      statusCode: 409,
      message: 'A review has already been left for this appointment.',
      state,
    };
  }
  const rating = Math.round(Number(stars));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return {
      ok: false,
      error: 'invalid_rating',
      statusCode: 400,
      message: 'Choose a rating between 1 and 5 stars.',
      state,
    };
  }
  return {
    ok: true,
    stars: rating,
    comment: String(comment || '').trim().slice(0, 2000),
    state,
  };
}

/**
 * Service-issue gate. Server time is the only authority for the 48-hour window;
 * a client-supplied timestamp is never accepted as an input here.
 */
function evaluateIssueSubmission(booking, { category, description } = {}, now = Date.now()) {
  const state = postServiceState(booking, now);
  if (!state.completed) {
    return {
      ok: false,
      error: 'issue_not_available',
      statusCode: 409,
      message: 'A service issue can be reported once the service is completed.',
      state,
    };
  }
  if (!state.serviceIssue.windowOpen) {
    return {
      ok: false,
      error: 'issue_window_closed',
      statusCode: 409,
      message: ISSUE_WINDOW_CLOSED_MESSAGE,
      state,
    };
  }
  const cat = String(category || '').trim().toLowerCase();
  if (!ISSUE_CATEGORIES.includes(cat)) {
    return {
      ok: false,
      error: 'invalid_category',
      statusCode: 400,
      message: 'Choose what the issue is about.',
      categories: ISSUE_CATEGORIES,
      state,
    };
  }
  const text = String(description || '').trim();
  if (text.length < 10) {
    return {
      ok: false,
      error: 'description_required',
      statusCode: 400,
      message: 'Tell us what went wrong so we can put it right.',
      state,
    };
  }
  return {
    ok: true,
    category: cat,
    description: text.slice(0, 2000),
    state,
  };
}

module.exports = {
  SERVICE_ISSUE_WINDOW_MS,
  CUSTOMER_RESOLUTION_STATUSES,
  ISSUE_CATEGORIES,
  ISSUE_WINDOW_CLOSED_MESSAGE,
  REVIEW_CTA_LABEL,
  ISSUE_CTA_LABEL,
  completionAnchor,
  isCompleted,
  reviewRecord,
  issueRecords,
  postServiceState,
  evaluateReviewSubmission,
  evaluateIssueSubmission,
};
