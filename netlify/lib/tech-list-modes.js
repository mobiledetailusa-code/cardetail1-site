/**
 * Technician list mode helpers for Admin Ops.
 * Separates lightweight Assign options from full management projections.
 */
'use strict';

function resolveTechListMode(body) {
  const raw = body && (body.mode != null ? body.mode : body.projection);
  // Backward compatible: callers with no mode get the full management projection.
  if (raw == null || String(raw).trim() === '') return 'management';
  const mode = String(raw).toLowerCase().trim();
  if (mode === 'assign_options' || mode === 'assign' || mode === 'lean') return 'assign_options';
  if (mode === 'management' || mode === 'full' || mode === 'admin') return 'management';
  // Unknown modes fail closed to management (still Admin-auth gated).
  return 'management';
}

/**
 * Booking-count enrichment is expensive (full cd1-bookings scan).
 * Only management screens that display Jobs counts should request it.
 */
function shouldAttachAssignedJobCounts(body, mode) {
  if (body && body.includeAssignedCounts === true) return true;
  if (body && body.includeAssignedCounts === false) return false;
  return mode === 'management';
}

function projectTechAssignOption(t) {
  if (!t || typeof t !== 'object') {
    return { techId: '', fullName: '', active: false };
  }
  return {
    techId: String(t.techId || t.id || ''),
    fullName: String(t.fullName || t.name || ''),
    active: t.active !== false,
  };
}

function isLeanAssignOption(row) {
  if (!row || typeof row !== 'object') return false;
  const keys = Object.keys(row);
  const allowed = new Set(['techId', 'fullName', 'active']);
  return keys.every((k) => allowed.has(k)) && !!row.techId;
}

module.exports = {
  resolveTechListMode,
  shouldAttachAssignedJobCounts,
  projectTechAssignOption,
  isLeanAssignOption,
};
