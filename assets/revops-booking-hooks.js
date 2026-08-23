/** Canonical booking-request funnel instrumentation. No booking decisions live here. */
(function (global) {
  'use strict';

  var DEDUPE_KEY = 'cd1_canonical_funnel_v1';
  var memoryState = { session: '', marks: {} };
  var retryTimer = null;

  function revenue() {
    return global.Cardetail1Revenue || null;
  }

  function sessionId() {
    var api = revenue();
    return api && typeof api.getSessionId === 'function' ? api.getSessionId() : '';
  }

  function readState() {
    var sid = sessionId();
    var empty = { session: sid, marks: {} };
    try {
      var raw = global.sessionStorage.getItem(DEDUPE_KEY);
      if (!raw) {
        if (memoryState.session === sid) return memoryState;
        memoryState = empty;
        return empty;
      }
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.session !== sid || !parsed.marks || typeof parsed.marks !== 'object') {
        memoryState = empty;
        return empty;
      }
      memoryState = parsed;
      return parsed;
    } catch (e) {
      if (memoryState.session !== sid) memoryState = empty;
      return memoryState;
    }
  }

  function writeState(state) {
    memoryState = state;
    try { global.sessionStorage.setItem(DEDUPE_KEY, JSON.stringify(state)); } catch (e) { /* memory fallback */ }
  }

  function semanticKey(eventName, props) {
    var step = props && props.booking_step != null ? String(props.booking_step) : '';
    return eventName + ':' + step;
  }

  function emitOnce(eventName, props) {
    var api = revenue();
    if (!api || typeof api.track !== 'function') return null;
    var state = readState();
    var key = semanticKey(eventName, props);
    if (state.marks[key]) return null;
    state.marks[key] = true;
    writeState(state);
    try {
      var eventId = api.track(eventName, props || {});
      if (eventId) return eventId;
      delete state.marks[key];
      writeState(state);
      return null;
    } catch (e) {
      delete state.marks[key];
      writeState(state);
      return null;
    }
  }

  function isDelegatedEmbed() {
    try {
      return global.parent !== global
        && new URLSearchParams(global.location.search || '').get('embed') === '1';
    } catch (e) {
      return false;
    }
  }

  function activeStep() {
    try {
      var active = global.document.querySelector('.bsec.on');
      var match = active && /^bs([1-6])$/.exec(active.id || '');
      return match ? Number(match[1]) : null;
    } catch (e) {
      return null;
    }
  }

  function bookingVisible() {
    try {
      var overlay = global.document.getElementById('bk-ov');
      var active = global.document.querySelector('.bsec.on');
      if (!overlay || !active) return false;
      var embedded = global.document.body && global.document.body.classList.contains('cd1-booking-embed');
      if (!overlay.classList.contains('open') && !embedded) return false;
      if (typeof global.getComputedStyle === 'function') {
        var style = global.getComputedStyle(overlay);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function afterVisibleRender(callback) {
    var run = function () {
      try { callback(); } catch (e) { /* analytics never blocks booking */ }
    };
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(function () { global.requestAnimationFrame(run); });
    } else {
      global.setTimeout(run, 0);
    }
  }

  function bookingStarted(category) {
    afterVisibleRender(function () {
      if (!bookingVisible()) return;
      emitOnce('booking_started', { category: category || 'general' });
    });
  }

  function delegatedBookingReady(category) {
    emitOnce('booking_started', { category: category || 'general' });
  }

  function packageId() {
    var st = global.ST || {};
    return st.pkgId || (st.pkg && st.pkg.id) || null;
  }

  function transitionEvent(previous, current) {
    if (!bookingVisible()) return;
    var st = global.ST || {};
    if (previous === 1 && current === 2 && st.cat) {
      emitOnce('booking_step_completed', { booking_step: 1, category: st.cat });
    } else if (previous === 2 && current === 3 && st.pkg) {
      emitOnce('booking_step_completed', {
        booking_step: 2,
        category: st.cat || null,
        package_id: packageId(),
      });
    } else if (previous === 3 && current === 4 && st.vehicles && st.vehicles.length > 0) {
      emitOnce('booking_step_completed', { booking_step: 3, category: st.cat || null });
    } else if (previous === 4 && current === 5) {
      emitOnce('booking_step_completed', { booking_step: 4, category: st.cat || null });
    }

    if (current === 5) {
      emitOnce('booking_review_reached', { booking_step: 5, category: st.cat || null });
    }
  }

  function validBookingId(value) {
    return /^CD1-[A-Z0-9][A-Z0-9-]{2,123}$/.test(String(value || ''));
  }

  function bookingSubmitted(payload) {
    if (!payload || payload.bookingCreated !== true || !validBookingId(payload.id)) return null;
    return emitOnce('booking_submitted', { booking_id: payload.id });
  }

  function zipResult() {
    try {
      var gate = global.document.getElementById('bk-gate-msg');
      return !!(gate && gate.classList.contains('unlocked'));
    } catch (e) {
      return false;
    }
  }

  function hookOpenBooking() {
    if (typeof global.openBooking !== 'function' || global.openBooking._canonicalFunnel) return true;
    var original = global.openBooking;
    var wrapped = function (category) {
      var result = original.apply(this, arguments);
      if (category !== 'fleet' && !isDelegatedEmbed()) bookingStarted(category);
      return result;
    };
    wrapped._canonicalFunnel = true;
    global.openBooking = wrapped;
    return true;
  }

  function hookBkGoTo() {
    if (typeof global.bkGoTo !== 'function' || global.bkGoTo._canonicalFunnel) return true;
    var original = global.bkGoTo;
    var wrapped = function (next) {
      var previous = activeStep();
      var result = original.apply(this, arguments);
      var current = activeStep();
      if (current === Number(next)) transitionEvent(previous, current);
      return result;
    };
    wrapped._canonicalFunnel = true;
    global.bkGoTo = wrapped;
    return true;
  }

  function hookZipCheck() {
    if (typeof global.onBkZipInput !== 'function' || global.onBkZipInput._canonicalFunnel) return true;
    var original = global.onBkZipInput;
    var wrapped = function (value) {
      var digits = String(value || '').replace(/\D/g, '');
      if (digits.length >= 5) emitOnce('zip_check_started', { zip_zone: 'service_area_check' });
      var result = original.apply(this, arguments);
      if (digits.length >= 5) {
        if (zipResult()) emitOnce('zip_check_valid', { zip_zone: 'serviceable' });
        else emitOnce('zip_check_rejected', { zip_zone: 'outside_service_area' });
      }
      return result;
    };
    wrapped._canonicalFunnel = true;
    global.onBkZipInput = wrapped;
    return true;
  }

  function init() {
    var complete = hookBkGoTo() & hookOpenBooking() & hookZipCheck();
    if (!complete && !retryTimer) {
      retryTimer = global.setTimeout(function () { retryTimer = null; init(); }, 250);
    }
  }

  global.CD1CanonicalFunnel = {
    init: init,
    bookingStarted: bookingStarted,
    delegatedBookingReady: delegatedBookingReady,
    bookingSubmitted: bookingSubmitted,
    isBookingVisible: bookingVisible,
    _test: {
      activeStep: activeStep,
      emitOnce: emitOnce,
      transitionEvent: transitionEvent,
      validBookingId: validBookingId,
      isDelegatedEmbed: isDelegatedEmbed,
    },
  };
  global.CD1RevOpsBookingHooks = global.CD1CanonicalFunnel;
  init();
})(typeof window !== 'undefined' ? window : globalThis);
