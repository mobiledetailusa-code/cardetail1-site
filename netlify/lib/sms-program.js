'use strict';

const { normalizeUsPhoneE164 } = require('./phone-auth');

// Legal EIN-backed registrant for A2P Brand / Trust Hub. Do not rename this
// to the customer-facing DBA. Twilio Brand registration must keep the exact
// legal entity from the CP 575 / 147c notice.
const LEGAL_BUSINESS_NAME = 'Detailing Zone LLC';
const LEGAL_BUSINESS_NAME_FORMAL = 'Detailing Zone L.L.C.';
const A2P_LEGAL_BRAND = LEGAL_BUSINESS_NAME_FORMAL;

// Customer-facing DBA / SMS sender identity. Outbound customer templates,
// consent copy, and HELP/STOP disclosures use this name. Admin operational
// SMS uses ADMIN_SMS_BRAND so internal alerts are not confused with customer
// traffic.
const DBA_NAME = 'Cardetail1';
const PROGRAM_NAME = DBA_NAME;
const CUSTOMER_SMS_BRAND = DBA_NAME;
const ADMIN_SMS_BRAND = 'Cardetail1 Admin';
const DBA_DISCLOSURE = 'Cardetail1 is a registered DBA of Detailing Zone L.L.C.';

// New grants record the Cardetail1 consent text. Existing Detailing Zone
// grants remain valid so a DBA rename cannot silently unsubscribe customers.
const BOOKING_CONSENT_TEXT_VERSION = 'cd1-txn-sms-v3-2026-08-28';
const LEGACY_PROGRAM_NAME = 'Detailing Zone';
const LEGACY_BOOKING_CONSENT_TEXT_VERSION = 'dz-txn-sms-v2-2026-08-22';
const BOOKING_CONSENT_SOURCE = 'public_booking_checkbox';
const BOOKING_CONSENT_COPY = `I agree to receive text messages from ${PROGRAM_NAME} about my booking request, appointment updates, reminders, and service-related notifications. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of booking.`;

function bookingProgramNameRecognized(name) {
  return name === PROGRAM_NAME || name === LEGACY_PROGRAM_NAME;
}

function bookingConsentTextVersionRecognized(version) {
  return version === BOOKING_CONSENT_TEXT_VERSION
    || version === LEGACY_BOOKING_CONSENT_TEXT_VERSION;
}

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
    && bookingConsentTextVersionRecognized(record?.textVersion)
    && record?.source === BOOKING_CONSENT_SOURCE
    && record?.method === 'booking_checkbox'
    && bookingProgramNameRecognized(record?.programName)
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
  DBA_NAME,
  DBA_DISCLOSURE,
  CUSTOMER_SMS_BRAND,
  ADMIN_SMS_BRAND,
  LEGAL_BUSINESS_NAME,
  LEGAL_BUSINESS_NAME_FORMAL,
  A2P_LEGAL_BRAND,
  BOOKING_CONSENT_TEXT_VERSION,
  LEGACY_PROGRAM_NAME,
  LEGACY_BOOKING_CONSENT_TEXT_VERSION,
  BOOKING_CONSENT_SOURCE,
  BOOKING_CONSENT_COPY,
  bookingProgramNameRecognized,
  bookingConsentTextVersionRecognized,
  canonicalBookingSmsConsent,
  bookingSmsConsentGranted,
};
