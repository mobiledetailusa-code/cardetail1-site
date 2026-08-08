/**
 * Centralized booking visibility — drafts never appear in normal portal feeds.
 * Submitted / admin-pending bookings must remain My Garage accessible.
 */

function hasSubmissionMarkers(booking) {
  if (!booking || typeof booking !== 'object') return false;
  if (booking.finalizedAt) return true;
  if (booking.adminCreated || booking.createdByAdmin || booking.adminReviewed) return true;
  if (booking.portalReleasedAt) return true;
  if (Number(booking.bookingVersion) >= 1) return true;
  const status = String(booking.status || '').trim();
  // Finalized marketing bookings use this display status; true drafts omit it.
  if (status === 'Pending Review' || status === 'Confirmed' || status === 'Scheduled'
    || status === 'Assigned' || status === 'Paid' || status === 'Closed'
    || status === 'Rescheduled' || status === 'submitted' || status === 'Submitted') {
    return true;
  }
  const js = String(booking.jobStatus || '').toLowerCase();
  if (js === 'pending_review' || js === 'confirmed' || js === 'assigned'
    || js === 'accepted' || js === 'en_route' || js === 'arrived'
    || js === 'in_progress' || js === 'completed_pending_admin_review'
    || js === 'completed_pending_payment' || js === 'completed_paid') {
    return true;
  }
  return false;
}

function isDraftRecord(booking) {
  if (!booking || typeof booking !== 'object') return false;
  // Stale isDraft/kind must not lock out submitted appointments (Admin pending / confirmed).
  if (hasSubmissionMarkers(booking)) return false;
  if (booking.isDraft === true) return true;
  if (String(booking.kind || '').toLowerCase() === 'draft') return true;
  return false;
}

function isArchivedOrTest(booking) {
  if (!booking || typeof booking !== 'object') return false;
  if (booking.archived === true || booking.isTest === true) return true;
  const js = String(booking.jobStatus || '').toLowerCase();
  return js === 'archived_test';
}

/**
 * True only for submitted bookings that Customer/Admin/Technician normal reads may return.
 * Scoped draft endpoints must not use this gate.
 */
function isVisibleSubmittedBooking(booking, opts = {}) {
  if (!booking || typeof booking !== 'object') return false;
  if (isDraftRecord(booking)) return false;
  if (!opts.includeArchivedTest && isArchivedOrTest(booking)) return false;
  return true;
}

/**
 * Patch used when persisting Admin confirm / portal release.
 */
function portalReleasePatch(now = new Date().toISOString()) {
  return {
    isDraft: false,
    kind: 'booking',
    portalReleasedAt: now,
  };
}

module.exports = {
  hasSubmissionMarkers,
  isDraftRecord,
  isArchivedOrTest,
  isVisibleSubmittedBooking,
  portalReleasePatch,
};
