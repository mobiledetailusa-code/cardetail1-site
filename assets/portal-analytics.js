/** Safe portal analytics — no customer PII in dataLayer payloads. */
(function (global) {
  'use strict';

  function emit(eventName) {
    if (!eventName || typeof eventName !== 'string') return;
    try {
      if (global.dataLayer && Array.isArray(global.dataLayer)) {
        global.dataLayer.push({ event: eventName, portal_surface: 'my_garage' });
      }
    } catch (_) { /* noop */ }
  }

  global.cd1PortalAnalytics = {
    opened: function () { emit('portal_opened'); },
    authStarted: function () { emit('portal_auth_started'); },
    authSucceeded: function () { emit('portal_auth_succeeded'); },
    changeRequested: function () { emit('booking_change_requested'); },
    paymentOpened: function () { emit('payment_session_opened'); },
    rebookingStarted: function () { emit('rebooking_started'); },
  };
})(window);
