/** Booking funnel instrumentation — wraps bkGoTo/openBooking when present. */
(function (global) {
  'use strict';

  var STEP_EVENTS = {
    1: 'package_view',
    2: 'vehicle_added',
    3: 'contact_captured',
    4: 'payment_step_viewed',
  };

  function track(event, props) {
    if (global.Cardetail1Revenue) global.Cardetail1Revenue.track(event, props || {});
  }

  function vehicleCountBand() {
    try {
      if (global.ST && global.ST.vehicles && global.ST.vehicles.length) {
        var n = global.ST.vehicles.length;
        if (global.Cardetail1Segments) return global.Cardetail1Segments.vehicleCountBand(n);
        return String(n);
      }
    } catch (e) { /* ignore */ }
    return '1';
  }

  function hookBkGoTo() {
    if (typeof global.bkGoTo !== 'function' || global.bkGoTo._revopsHooked) return;
    var orig = global.bkGoTo;
    global.bkGoTo = function (n) {
      orig(n);
      track('booking_step_viewed', { booking_step: n, category: global.ST && global.ST.cat });
      if (STEP_EVENTS[n]) track(STEP_EVENTS[n], { booking_step: n, category: global.ST && global.ST.cat });
      if (n === 2 && global.ST && global.ST.vehicles && global.ST.vehicles.length >= 2) {
        track('multi_vehicle_detected', { vehicle_count_band: vehicleCountBand(), multi_vehicle_band: vehicleCountBand() });
      }
    };
    global.bkGoTo._revopsHooked = true;
  }

  function hookOpenBooking() {
    if (typeof global.openBooking !== 'function' || global.openBooking._revopsHooked) return;
    var orig = global.openBooking;
    global.openBooking = function (cat) {
      orig(cat);
      if (cat !== 'fleet') track('booking_started', { category: cat || 'general' });
    };
    global.openBooking._revopsHooked = true;
  }

  function init() {
    hookBkGoTo();
    hookOpenBooking();
    if (!global.bkGoTo || !global.openBooking) {
      setTimeout(init, 500);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.CD1RevOpsBookingHooks = { init: init };
})(typeof window !== 'undefined' ? window : globalThis);
