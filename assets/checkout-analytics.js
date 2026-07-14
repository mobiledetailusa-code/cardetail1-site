/** Checkout conversion analytics — no PII, GA4-mapped where approved. */
(function (global) {
  'use strict';

  var SESSION_KEY = 'cd1_chk_session';
  var OPENED_KEY = 'cd1_chk_opened';
  var STEP_LABELS = ['Service', 'Vehicle & Add-ons', 'Contact & Schedule', 'Secure & Submit'];

  var GA4_MAP = {
    checkout_opened: 'begin_checkout',
    payment_info_saved: 'add_payment_info',
    payment_completed: 'purchase',
  };

  function sessionId() {
    try {
      var s = sessionStorage.getItem(SESSION_KEY);
      if (s) return s;
      s = 'chk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(SESSION_KEY, s);
      return s;
    } catch (e) {
      return 'chk_fallback';
    }
  }

  function deviceType() {
    var w = global.innerWidth || 1024;
    if (w < 640) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  function baseProps(extra) {
    var st = global.ST || {};
    var out = {
      anonymous_session_id: sessionId(),
      device_type: deviceType(),
      source_page: global.location.pathname,
      category: st.cat || null,
      package_id: st.pkgId || null,
      vehicle_count_band: vehicleBand(),
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    }
    return out;
  }

  function vehicleBand() {
    try {
      var n = (global.ST && global.ST.vehicles && global.ST.vehicles.length) || 1;
      if (n >= 4) return '4+';
      return String(n);
    } catch (e) {
      return '1';
    }
  }

  function emit(name, props) {
    try {
      if (global.Cardetail1Checkout && global.Cardetail1Checkout._silent) return;
      var payload = baseProps(props || {});
      payload.checkout_event = name;
      if (global.Cardetail1Revenue) {
        global.Cardetail1Revenue.track(name, payload);
        var ga4 = GA4_MAP[name];
        if (ga4 && global.Cardetail1Revenue.trackGa4) {
          global.Cardetail1Revenue.trackGa4(ga4, payload);
        } else if (ga4 && global.gtag) {
          global.gtag('event', ga4, payload);
        }
      }
      if (global.dataLayer) {
        global.dataLayer.push(Object.assign({ event: name }, payload));
      }
    } catch (e) { /* analytics must never block checkout */ }
  }

  function estimatedValue() {
    try {
      var st = global.ST || {};
      var vehicles = st.vehicles && st.vehicles.length ? st.vehicles : [];
      var base = vehicles.reduce(function (s, v) { return s + (v.subtotal || 0); }, 0);
      if (!base && st.basePrice) base = st.basePrice + (st.addonTotal || 0);
      var fee = typeof global.getTravelFeeAmount === 'function' ? global.getTravelFeeAmount() : 0;
      var discount = st.offerPreview && st.offerPreview.discount_amount
        ? st.offerPreview.discount_amount / 100 : 0;
      return Math.max(0, Math.round((base + fee - discount) * 100) / 100);
    } catch (e) {
      return null;
    }
  }

  function onCheckoutOpened(cat) {
    try {
      if (sessionStorage.getItem(OPENED_KEY)) return;
      sessionStorage.setItem(OPENED_KEY, '1');
    } catch (e) { /* ignore */ }
    emit('checkout_opened', {
      category: cat || null,
      estimated_value: estimatedValue(),
      currency: 'USD',
    });
  }

  function onStepViewed(step) {
    emit('checkout_step_viewed', {
      checkout_step: step,
      checkout_step_label: STEP_LABELS[step - 1] || '',
      estimated_value: estimatedValue(),
    });
  }

  function onStepCompleted(step) {
    emit('checkout_step_completed', { checkout_step: step });
  }

  function onStepBack(fromStep, toStep) {
    emit('checkout_step_back', { checkout_step: fromStep, checkout_step_to: toStep });
  }

  function onValidationError(step, code) {
    emit('checkout_validation_error', { checkout_step: step, error_code: code || 'validation_failed' });
  }

  function onIdleTrigger(type) {
    emit('checkout_idle_triggered', { trigger_type: type });
  }

  function onResumed() {
    emit('checkout_resumed', {});
  }

  function onOfferEligible(offer) {
    emit('offer_eligible', {
      offer_id: offer && offer.offer_id,
      eligible_subtotal: offer && offer.eligible_subtotal,
      discount_amount: offer && offer.discount_amount,
    });
  }

  function onOfferShown(trigger) {
    emit('offer_shown', { offer_id: 'first_booking_welcome', trigger_type: trigger });
  }

  function onOfferApplied(offer, trigger) {
    emit('offer_applied', {
      offer_id: offer && offer.offer_id,
      discount_amount: offer && offer.discount_amount,
      trigger_type: trigger,
    });
  }

  function onOfferDismissed(trigger) {
    emit('offer_dismissed', { offer_id: 'first_booking_welcome', trigger_type: trigger });
  }

  function onOfferIneligible(reason) {
    emit('offer_ineligible', { offer_id: 'first_booking_welcome', error_code: reason });
  }

  function onDiscountCalculated(offer) {
    emit('discount_calculated', {
      offer_id: offer && offer.offer_id,
      eligible_subtotal: offer && offer.eligible_subtotal,
      discount_amount: offer && offer.discount_amount,
    });
  }

  function onBookingSubmitted() {
    emit('booking_submitted', { estimated_value: estimatedValue() });
  }

  function onPaymentInfoSaved() {
    emit('payment_info_saved', { estimated_value: estimatedValue() });
  }

  function onPaymentCompleted(value) {
    emit('payment_completed', { estimated_value: value, currency: 'USD' });
  }

  function hookBkGoTo() {
    if (typeof global.bkGoTo !== 'function' || global.bkGoTo._chkAnalytics) return;
    var orig = global.bkGoTo;
    var prev = null;
    global.bkGoTo = function (n) {
      if (prev && n < prev) onStepBack(prev, n);
      orig(n);
      onStepViewed(n);
      prev = n;
    };
    global.bkGoTo._chkAnalytics = true;
  }

  function hookOpenBooking() {
    if (typeof global.openBooking !== 'function' || global.openBooking._chkAnalytics) return;
    var orig = global.openBooking;
    global.openBooking = function (cat) {
      orig(cat);
      if (cat !== 'fleet') onCheckoutOpened(cat);
    };
    global.openBooking._chkAnalytics = true;
  }

  function init() {
    hookBkGoTo();
    hookOpenBooking();
    if (!global.bkGoTo) setTimeout(init, 400);
  }

  global.Cardetail1CheckoutAnalytics = {
    emit: emit,
    onCheckoutOpened: onCheckoutOpened,
    onStepViewed: onStepViewed,
    onStepCompleted: onStepCompleted,
    onStepBack: onStepBack,
    onValidationError: onValidationError,
    onIdleTrigger: onIdleTrigger,
    onResumed: onResumed,
    onOfferEligible: onOfferEligible,
    onOfferShown: onOfferShown,
    onOfferApplied: onOfferApplied,
    onOfferDismissed: onOfferDismissed,
    onOfferIneligible: onOfferIneligible,
    onDiscountCalculated: onDiscountCalculated,
    onBookingSubmitted: onBookingSubmitted,
    onPaymentInfoSaved: onPaymentInfoSaved,
    onPaymentCompleted: onPaymentCompleted,
    init: init,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
