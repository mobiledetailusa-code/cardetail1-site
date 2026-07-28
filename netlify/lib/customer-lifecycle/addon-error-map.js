'use strict';

/**
 * Map legacy add-on / booking change errors to Customer Lifecycle Phase 2 codes.
 * Preserves original code in `legacyError` for diagnostics.
 */

const PHASE2_CODES = new Set([
  'addon_not_found',
  'addon_not_compatible',
  'appointment_not_modifiable',
  'addon_already_requested',
  'stale_appointment_version',
  'stale_quote_version',
  'unauthorized_appointment',
  'validation_failed',
  'rate_limited',
]);

const LEGACY_TO_PHASE2 = {
  version_conflict: 'stale_appointment_version',
  quote_version_conflict: 'stale_quote_version',
  unknown_addon: 'addon_not_found',
  unknown_addon_id: 'addon_not_found',
  invalid_pricing: 'addon_not_found',
  addon_not_compatible: 'addon_not_compatible',
  duplicate_addon: 'addon_already_requested',
  action_not_allowed: 'appointment_not_modifiable',
  invoice_paid: 'appointment_not_modifiable',
  authentication_failed: 'unauthorized_appointment',
  booking_not_found: 'unauthorized_appointment',
  phone_not_on_file: 'unauthorized_appointment',
  validation_error: 'validation_failed',
  addon_ids_required: 'validation_failed',
  too_many_requests: 'rate_limited',
};

const MESSAGES = {
  addon_not_found: 'That add-on is not available for this vehicle.',
  addon_not_compatible: 'That add-on is not compatible with the selected package.',
  appointment_not_modifiable: 'This appointment cannot be modified online right now.',
  addon_already_requested: 'That add-on is already requested or on your booking.',
  stale_appointment_version: 'This booking changed. Refresh and try again.',
  stale_quote_version: 'The quote changed. Refresh and try again.',
  unauthorized_appointment: 'You are not authorized for this appointment.',
  validation_failed: 'Please check your selection and try again.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
};

function mapAddonLifecycleError(code, extras = {}) {
  const raw = String(code || 'request_failed');
  const mapped = PHASE2_CODES.has(raw) ? raw : (LEGACY_TO_PHASE2[raw] || raw);
  const statusCode = extras.statusCode
    || (mapped === 'stale_appointment_version' || mapped === 'stale_quote_version' ? 409
      : mapped === 'rate_limited' ? 429
        : mapped === 'unauthorized_appointment' ? 401
          : mapped === 'appointment_not_modifiable' ? 409
            : 400);
  return {
    ok: false,
    error: mapped,
    legacyError: raw !== mapped ? raw : undefined,
    message: extras.message || MESSAGES[mapped] || extras.fallbackMessage || 'Unable to update add-ons.',
    statusCode,
    ...('actualBookingVersion' in extras ? { actualBookingVersion: extras.actualBookingVersion } : {}),
    ...('changeRequestId' in extras ? { changeRequestId: extras.changeRequestId } : {}),
  };
}

module.exports = {
  PHASE2_CODES,
  LEGACY_TO_PHASE2,
  MESSAGES,
  mapAddonLifecycleError,
};
