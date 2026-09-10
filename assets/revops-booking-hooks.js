/** Booking funnel instrumentation — wraps bkGoTo/openBooking when present. */
(function (global) {
  'use strict';

  // Align with the live 6-step UI (1 Category → 2 Package → 3 Vehicle →
  // 4 Info → 5 Review → 6 Request Sent). Do not fire payment_step_viewed —
  // Step 5 is request review, not a card charge.
  var STEP_EVENTS = {
    2: 'package_view',
    3: 'vehicle_added',
    4: 'contact_captured',
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
      if (n === 3 && global.ST && global.ST.vehicles && global.ST.vehicles.length >= 2) {
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

  function hookSelectPkg() {
    if (typeof global.selectPkg !== 'function' || global.selectPkg._revopsHooked) return;
    var orig = global.selectPkg;
    global.selectPkg = function (id) {
      var prev = global.ST && global.ST.pkgId;
      orig(id);
      if (global.ST && global.ST._restoring) return;
      if (!id || id === prev) return;
      track('package_selected', {
        package_id: id,
        category: global.ST && global.ST.cat,
        booking_step: global.currentBkStep || 2,
      });
    };
    global.selectPkg._revopsHooked = true;
  }

  function zipZoneProp() {
    try {
      if (global.activeZone && global.activeZone.key) return String(global.activeZone.key);
    } catch (e) { /* ignore */ }
    return undefined;
  }

  function hookZipChecks() {
    if (typeof global.onBkZipInput === 'function' && !global.onBkZipInput._revopsHooked) {
      var origBk = global.onBkZipInput;
      var lastBkZip = '';
      global.onBkZipInput = function (val) {
        var digits = String(val || '').replace(/\D/g, '').substring(0, 5);
        if (digits.length === 5 && digits !== lastBkZip) {
          track('zip_check_started', { source_page: 'booking' });
        }
        origBk(val);
        if (digits.length >= 5 && digits !== lastBkZip) {
          lastBkZip = digits;
          if (global.activeZone) track('zip_check_valid', { zip_zone: zipZoneProp(), source_page: 'booking' });
          else track('zip_check_rejected', { source_page: 'booking' });
        }
        if (digits.length < 5) lastBkZip = '';
      };
      global.onBkZipInput._revopsHooked = true;
    }
    if (typeof global.onHeroZipSubmit === 'function' && !global.onHeroZipSubmit._revopsHooked) {
      var origHero = global.onHeroZipSubmit;
      global.onHeroZipSubmit = function () {
        var inp = global.document && global.document.getElementById('hero-zip');
        var digits = inp ? String(inp.value || '').replace(/\D/g, '').substring(0, 5) : '';
        if (digits.length >= 5) track('zip_check_started', { source_page: 'homepage' });
        origHero();
        if (digits.length >= 5) {
          if (global.activeZone) track('zip_check_valid', { zip_zone: zipZoneProp(), source_page: 'homepage' });
          else track('zip_check_rejected', { source_page: 'homepage' });
        }
      };
      global.onHeroZipSubmit._revopsHooked = true;
    }
  }

  function bindCallTextClicks() {
    if (global.document && global.document.documentElement && global.document.documentElement._revopsCallText) return;
    function onClick(e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var a = t.closest('a[href^="tel:"], a[href^="sms:"]');
      if (!a) return;
      var href = (a.getAttribute('href') || '').toLowerCase();
      if (href.indexOf('tel:') === 0) track('click_call', { source_page: global.location && global.location.pathname });
      else if (href.indexOf('sms:') === 0) track('click_text', { source_page: global.location && global.location.pathname });
    }
    if (global.document) {
      global.document.addEventListener('click', onClick, true);
      if (global.document.documentElement) global.document.documentElement._revopsCallText = true;
    }
  }

  function init() {
    hookBkGoTo();
    hookOpenBooking();
    hookSelectPkg();
    hookZipChecks();
    bindCallTextClicks();
    if (!global.bkGoTo || !global.openBooking || !global.selectPkg) {
      setTimeout(init, 500);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.CD1RevOpsBookingHooks = { init: init };
})(typeof window !== 'undefined' ? window : globalThis);
