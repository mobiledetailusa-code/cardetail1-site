'use strict';

const { normalizeUsPhoneE164 } = require('./phone-auth');

// Keep the public consent surface, durable evidence and outbound templates on
// one program identity. The current repository and Twilio-readiness contract
// consistently use "Detailing Zone"; the Twilio registration itself still
// requires owner verification before activation.
const PROGRAM_NAME = 'Detailing Zone';
const LEGAL_BUSINESS_NAME = 'Detailing Zone LLC';
const BOOKING_CONSENT_TEXT_VERSION = 'dz-txn-sms-v2-2026-08-22';
const BOOKING_CONSENT_SOURCE = 'public_booking_checkbox';
const BOOKING_CONSENT_COPY = `I agree to receive text messages from ${PROGRAM_NAME} about my booking request, appointment updates, reminders, and service-related notifications. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of booking.`;

function canonicalBookingSmsConsent(granted, recordedAt, phoneRaw) {
  const phoneE164 = granted === true ? normalizeUsPhoneE164(phoneRaw) : null;
  return {
    granted: granted === true,
    recordedAt: String(recordedAt || ''),
    textVersion: BOOKING_CONSENT_TEXT_VERSION,
    source: BOOKING_CONSENT_SOURCE,
    method: 'booking_checkbox',
    programName: PROGRAM_NAME,
    // Bind consent evidence to the submitted booking phone (E.164). Null when
    // declined or when the submitted value cannot be normalized.
    phoneE164: phoneE164 || null,
  };
}

function bookingSmsConsentGranted(booking) {
  const record = booking && booking.transactionalSmsConsent;
  const base = booking?.transactionalSmsConsentAccepted === true
    && record?.granted === true
    && record?.textVersion === BOOKING_CONSENT_TEXT_VERSION
    && record?.source === BOOKING_CONSENT_SOURCE
    && record?.method === 'booking_checkbox'
    && record?.programName === PROGRAM_NAME
    && Number.isFinite(Date.parse(record?.recordedAt || ''));
  if (!base) return false;
  // When consent evidence includes a phone, it must match the booking phone.
  // Legacy rows without phoneE164 remain valid (phone lives on booking.phone).
  if (record.phoneE164) {
    const bookingPhone = normalizeUsPhoneE164(booking.phone || booking.customerPhone || '');
    if (!bookingPhone || bookingPhone !== normalizeUsPhoneE164(record.phoneE164)) {
      return false;
    }
  }
  return true;
}

module.exports = {
  PROGRAM_NAME,
  LEGAL_BUSINESS_NAME,
  BOOKING_CONSENT_TEXT_VERSION,
  BOOKING_CONSENT_SOURCE,
  BOOKING_CONSENT_COPY,
  canonicalBookingSmsConsent,
  bookingSmsConsentGranted,
};
