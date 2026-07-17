/**
 * Centralized booking visibility — drafts never appear in normal portal feeds.
 */

function isDraftRecord(booking) {
  if (!booking || typeof booking !== 'object') return false;
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

module.exports = {
  isDraftRecord,
  isArchivedOrTest,
  isVisibleSubmittedBooking,
};
