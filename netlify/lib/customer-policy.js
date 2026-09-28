'use strict';

/** One terms version for cash, card-at-service, and pay-online-later requests. */
const TERMS_POLICY_VERSION = '2026-09-dba-booking-request';

/**
 * Purpose-specific consent to charge the approved unpaid balance after the
 * appointment is completed. This is not the cancellation / card-on-file terms
 * version. The browser may only affirm the choice; the server writes this
 * version and the timestamp.
 */
const AFTER_SERVICE_CHARGE_CONSENT_VERSION = '2026-09-after-service-charge';

function stampAfterServiceChargeConsent(booking, source, now) {
  const pref = String(
    (booking && (booking.paymentMethodPreference || booking.paymentMethod))
    || (source && (source.paymentMethodPreference || source.paymentMethod))
    || ''
  ).trim();
  const affirmed = !!(
    source
    && source.acceptedAfterServiceChargeConsent === true
    && (
      source.acceptedCardOnFilePolicy === true
      || (booking && booking.acceptedCardOnFilePolicy === true)
    )
  );
  const storedVersion = String((booking && booking.afterServiceChargeConsentVersion) || '').trim();
  const storedAt = booking && booking.afterServiceChargeConsentAt
    ? String(booking.afterServiceChargeConsentAt)
    : '';
  const already = storedVersion === AFTER_SERVICE_CHARGE_CONSENT_VERSION
    && Number.isFinite(Date.parse(storedAt));
  if (pref === 'online_after_service' && (affirmed || already)) {
    return {
      afterServiceChargeConsentVersion: AFTER_SERVICE_CHARGE_CONSENT_VERSION,
      afterServiceChargeConsentAt: already ? storedAt : now,
    };
  }
  return {
    afterServiceChargeConsentVersion: null,
    afterServiceChargeConsentAt: null,
  };
}

module.exports = {
  TERMS_POLICY_VERSION,
  AFTER_SERVICE_CHARGE_CONSENT_VERSION,
  stampAfterServiceChargeConsent,
};
