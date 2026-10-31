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

  // Only allowlisted revenue events are forwarded. checkout_opened is already
  // booking_started from revops-booking-hooks, so it is not sent again.
  var APPROVED_FORWARD = {
    booking_submitted: 'booking_submitted',
    payment_info_saved: 'payment_method_saved',
  };
  var SUBMITTED_KEY = 'cd1_chk_submitted_refs';

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

  function sharedPreviewHost() {
    try {
      var host = String((global.location && global.location.hostname) || '').toLowerCase();
      return /^deploy-preview-\d+--[a-z0-9-]+\.netlify\.app$/.test(host)
        || /^[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/.test(host);
    } catch (ePreview) {
      return false;
    }
  }

  function bookingAlreadyCounted(txId) {
    try {
      var raw = sessionStorage.getItem(SUBMITTED_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) && arr.indexOf(String(txId)) !== -1;
    } catch (e) { return false; }
  }

  function rememberBooking(txId) {
    try {
      var raw = sessionStorage.getItem(SUBMITTED_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) arr = [];
      if (arr.indexOf(String(txId)) === -1) arr.push(String(txId));
      if (arr.length > 40) arr = arr.slice(-40);
      sessionStorage.setItem(SUBMITTED_KEY, JSON.stringify(arr));
    } catch (e) { /* ignore */ }
  }

  function emit(name, props) {
    try {
      if (sharedPreviewHost()) return;
      if (global.Cardetail1Checkout && global.Cardetail1Checkout._silent) return;
      var forward = APPROVED_FORWARD[name];
      if (!forward || !global.Cardetail1Revenue) return;
      // GA4_MAP is the name crosswalk only. This file does not call gtag:
      // that path ignored analytics consent and could emit begin_checkout
      // beside the canonical booking_started event.
      global.Cardetail1Revenue.track(forward, baseProps(props || {}));
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

  function authoritativeAmount(evidence) {
    if (!evidence || evidence.approvedFinalAmount == null || evidence.approvedFinalAmount === '') return null;
    var n = Number(evidence.approvedFinalAmount);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  /**
   * Canonical booking-success signal. Google Ads "Booking submitted" conversion
   * fires only when evidence proves durable persist + backend approvedFinalAmount.
   * evidence: { ok, bookingCreated, id|transaction_id, approvedFinalAmount }
   * The first-party event carries booking_reference for admin attribution.
   * That reference is omitted from GA4 and Clarity.
   */
  function onBookingSubmitted(evidence) {
    evidence = evidence || {};
    var txId = evidence.transaction_id || evidence.id || null;
    var approved = authoritativeAmount(evidence);
    var persisted = evidence.ok === true
      && evidence.bookingCreated === true
      && evidence.isDraft !== true
      && !!txId;
    if (persisted && !bookingAlreadyCounted(txId)) {
      var extra = {
        booking_reference: String(txId),
        currency: evidence.currency || 'USD',
      };
      if (approved != null) extra.estimated_value = approved;
      emit('booking_submitted', extra);
      if (global.Cardetail1Revenue) rememberBooking(txId);
    }
    // Google Ads AW-…/yrOD… — only after finalize persist evidence (not Page view).
    try {
      if (global.Cardetail1Revenue && typeof global.Cardetail1Revenue.trackGoogleAdsBookingConversion === 'function') {
        global.Cardetail1Revenue.trackGoogleAdsBookingConversion({
          ok: evidence.ok === true,
          bookingCreated: evidence.bookingCreated === true,
          isDraft: evidence.isDraft === true,
          id: txId,
          transaction_id: txId,
          approvedFinalAmount: approved,
          currency: evidence.currency || 'USD',
          serviceFamily: evidence.serviceFamily || null,
          paymentSucceeded: evidence.paymentSucceeded === true,
          amountPaid: evidence.amountPaid != null ? evidence.amountPaid : null,
        });
      }
    } catch (eAds) { /* never block checkout */ }
  }

  function onPaymentInfoSaved() {
    emit('payment_info_saved', { currency: 'USD' });
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
