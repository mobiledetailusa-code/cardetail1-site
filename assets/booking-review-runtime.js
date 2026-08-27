/*!
 * Cardetail1 — canonical booking review / submit / success runtime.
 *
 * One file feeds homepage, hub, and city-page booking surfaces so:
 *   - bkMoney is never missing
 *   - estimated totals use the same cart + travel-fee total that the payload sends
 *   - a persisted booking never renders as "not submitted"
 *   - payment preference is metadata only (no Stripe)
 *
 * This module NEVER prices a package and NEVER creates Stripe/ledger/receipt objects.
 *
 * UMD: window.Cardetail1BookingReview and CommonJS.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Cardetail1BookingReview = api;
  if (typeof root.bkMoney !== 'function') root.bkMoney = api.money;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { api.install(root); });
    } else {
      api.install(root);
    }
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var REQUEST_PREFERENCES = Object.freeze({
    online_after_service: {
      id: 'pc-online',
      value: 'online_after_service',
      label: 'Pay online later',
      button: 'Pay online later',
    },
    card_onsite: {
      id: 'pc-onsite',
      value: 'card_onsite',
      label: 'Card at service',
      button: 'Card at service',
    },
    cash_onsite: {
      id: 'pc-cash',
      value: 'cash_onsite',
      label: 'Cash at service',
      button: 'Cash at service',
    },
  });

  var PREFERENCE_VALUES = Object.keys(REQUEST_PREFERENCES);
  var NETWORK_RE = /failed to fetch|networkerror|load failed|network request failed|abort|timeout/i;
  var SUBMIT_FAILURE_CODES = {
    draft_token_invalid: 'Your booking session expired. Please submit the request again.',
    booking_policy_required: 'Please accept the Terms & Conditions before submitting.',
    booking_store_unavailable: 'Booking storage is temporarily unavailable. Please try again in a moment.',
    booking_slot_unavailable: 'That time slot is no longer available. Choose another date or time and submit again. No payment was collected.',
    booking_time_unavailable: 'That time is unavailable. Choose another slot and submit again.',
    booking_date_unavailable: 'That date is unavailable. Choose another day and submit again.',
    booking_not_persisted: 'Your booking request was not created. Please submit again or choose another time.',
    'Draft booking not found': 'Your booking session expired. Please submit the request again.',
    rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
    payment_preference_required: 'Please choose a preferred payment method.',
    invalid_payment_preference: 'Please choose a preferred payment method.',
  };

  function money(n) {
    return '$' + (Number(n) || 0).toFixed(2);
  }

  function preferenceLabel(value) {
    var key = String(value || '').trim();
    return (REQUEST_PREFERENCES[key] && REQUEST_PREFERENCES[key].label) || '';
  }

  function isKnownPreference(value) {
    return PREFERENCE_VALUES.indexOf(String(value || '').trim()) !== -1;
  }

  function num(n) {
    var v = Number(n);
    return Number.isFinite(v) ? v : 0;
  }

  function roundMoney(n) {
    return Math.max(0, Math.round(num(n) * 100) / 100);
  }

  function text(id, value) {
    var el = root.document && root.document.getElementById(id);
    if (el) el.textContent = value == null ? '' : String(value);
    return el;
  }

  function html(id, value) {
    var el = root.document && root.document.getElementById(id);
    if (el) el.innerHTML = value == null ? '' : String(value);
    return el;
  }

  function cartVehicles() {
    var ST = root.ST || {};
    var list = (ST.vehicles && ST.vehicles.length)
      ? ST.vehicles
      : [(typeof root.buildCurrentVehicleItem === 'function' ? root.buildCurrentVehicleItem() : null)].filter(Boolean);
    return list;
  }

  /**
   * Canonical presentation totals from the same cart + travel fee the payload uses.
   * Does not invent catalog prices.
   */
  function presentationTotals(source) {
    var ST = root.ST || {};
    var vehicles = Array.isArray(source && source.vehicles)
      ? source.vehicles
      : (source && source.payload && Array.isArray(source.payload.vehicles) ? source.payload.vehicles : cartVehicles());
    var service = 0;
    var addons = 0;
    var cartBase = 0;
    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i] || {};
      service += num(v.basePrice);
      addons += num(v.addonTotal);
      cartBase += v.subtotal != null ? num(v.subtotal) : (num(v.basePrice) + num(v.addonTotal));
    }
    if (!vehicles.length && source) {
      service = num(source.packagePrice != null ? source.packagePrice : source.servicePrice);
      addons = num(source.addonTotal);
      cartBase = num(source.totalPrice) || (service + addons);
    }
    var fee = 0;
    if (source && (source.travelFeeAmount != null || source.zoneSurcharge != null || source.travelFee != null)) {
      fee = num(source.travelFeeAmount != null ? source.travelFeeAmount : (source.zoneSurcharge != null ? source.zoneSurcharge : source.travelFee));
    } else if (typeof root.getTravelFeeAmount === 'function') {
      fee = num(root.getTravelFeeAmount());
    }
    var discount = 0;
    var discountLabel = 'New Customer Welcome — 10%';
    if (source && source.discount != null) {
      discount = num(source.discount);
      if (source.discountLabel) discountLabel = source.discountLabel;
    } else if (ST.offerPreview && ST.offerPreview.eligibility_status === 'eligible') {
      discount = num(ST.offerPreview.discount_amount) / 100;
    }
    var payloadTotal = roundMoney(source && source.totalPrice != null && source.vehicles ? source.totalPrice : (cartBase + fee));
    var estimatedTotal = roundMoney(cartBase + fee - discount);
    return {
      vehicles: vehicles,
      service: roundMoney(service),
      addons: roundMoney(addons),
      fee: roundMoney(fee),
      discount: roundMoney(discount),
      discountLabel: discountLabel,
      cartBase: roundMoney(cartBase),
      payloadTotal: payloadTotal,
      estimatedTotal: estimatedTotal,
    };
  }

  function finRow(label, val, cls) {
    return '<div class="bk-fin-row' + (cls ? ' bk-fin-' + cls : '') + '"><span>' + label + '</span><span>' + val + '</span></div>';
  }

  function renderBkFinancialSummary(o) {
    o = o || {};
    var totals = presentationTotals({
      servicePrice: o.servicePrice,
      packagePrice: o.servicePrice,
      addonTotal: o.addonTotal,
      travelFee: o.travelFee,
      discount: o.discount,
      discountLabel: o.discountLabel,
      totalPrice: (num(o.servicePrice) + num(o.addonTotal) + num(o.travelFee)),
    });
    if (o.servicePrice != null || o.addonTotal != null || o.travelFee != null) {
      totals.service = roundMoney(o.servicePrice);
      totals.addons = roundMoney(o.addonTotal);
      totals.fee = roundMoney(o.travelFee);
      totals.discount = roundMoney(o.discount);
      if (o.discountLabel) totals.discountLabel = o.discountLabel;
      totals.estimatedTotal = roundMoney(totals.service + totals.addons + totals.fee - totals.discount);
      totals.payloadTotal = roundMoney(totals.service + totals.addons + totals.fee);
    }
    var amtEl = root.document && root.document.getElementById('bk-total-amount');
    if (amtEl) amtEl.textContent = totals.estimatedTotal > 0 ? money(totals.estimatedTotal) : 'Estimate';
    var okTotal = root.document && root.document.getElementById('ok-total');
    if (okTotal && okTotal.getAttribute('data-locked') !== '1') {
      /* review live total only; success lock is set after persist */
    }
    var cTotal = root.document && root.document.getElementById('c-total');
    if (cTotal) cTotal.textContent = totals.estimatedTotal > 0 ? money(totals.estimatedTotal) : 'Estimate';
    var inclEl = root.document && root.document.getElementById('bk-total-incl');
    if (inclEl) {
      inclEl.textContent = totals.fee > 0
        ? 'Includes the mobile service adjustment for your location.'
        : 'Mobile service included.';
    }
    var lines = root.document && root.document.getElementById('bk-financial-lines');
    if (lines) {
      var htmlLines = finRow('Service price', money(totals.service));
      if (totals.addons > 0) htmlLines += finRow('Selected add-ons', money(totals.addons));
      if (totals.fee > 0) htmlLines += finRow('Mobile service adjustment', money(totals.fee));
      if (totals.discount > 0) htmlLines += finRow(totals.discountLabel, '-' + money(totals.discount), 'discount');
      htmlLines += finRow('Estimated total', money(totals.estimatedTotal), 'total');
      lines.innerHTML = htmlLines;
    }
    return totals.estimatedTotal;
  }

  function formatArrival(windowVal, timeVal) {
    var w = String(windowVal || '').trim();
    if (w === 'anytime') return 'Any time that day';
    if (w && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(w)) {
      function fmt(hhmm) {
        var p = hhmm.split(':');
        var h = Number(p[0]);
        var m = p[1];
        var ampm = h >= 12 ? 'PM' : 'AM';
        var h12 = h % 12 || 12;
        return h12 + ':' + m + ' ' + ampm;
      }
      var parts = w.split('-');
      return fmt(parts[0]) + ' – ' + fmt(parts[1]);
    }
    return w || timeVal || '—';
  }

  function formatDateLabel(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return iso || '—';
    try {
      var dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  function val(id) {
    var el = root.document && root.document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  function fillReviewSubmit() {
    var ST = root.ST || {};
    var totals = presentationTotals();
    renderBkFinancialSummary({
      servicePrice: totals.service,
      addonTotal: totals.addons,
      travelFee: totals.fee,
      discount: totals.discount,
      discountLabel: totals.discountLabel,
    });
    var vehicles = totals.vehicles;
    var project = (typeof root.bkProjectVehicles === 'function')
      ? root.bkProjectVehicles(vehicles)
      : { items: vehicles };
    var cards = root.document && root.document.getElementById('c-vehicle-cards');
    if (cards && typeof root.bkRenderVehicleSummary === 'function') {
      cards.innerHTML = root.bkRenderVehicleSummary(project.items || vehicles);
    }
    var first = vehicles[0] || {};
    var visualEl = root.document && root.document.getElementById('c-visual');
    if (visualEl && typeof root.getVehicleVisualKey === 'function' && root.VEHICLE_VISUALS) {
      var visualKey = vehicles.length === 1 ? (first.visualKey || root.getVehicleVisualKey()) : '';
      var visual = root.VEHICLE_VISUALS[visualKey || root.getVehicleVisualKey()]
        || (root.CATEGORY_VISUALS && root.CATEGORY_VISUALS[first.cat || ST.cat])
        || root.VEHICLE_VISUALS.sedan;
      visualEl.style.display = vehicles.length > 1 ? 'none' : '';
      visualEl.innerHTML = vehicles.length > 1 ? '' : '<img src="' + visual.img + '" alt="' + (visual.alt || '') + '" width="720" height="720" loading="lazy" decoding="async">';
    }
    var titleEl = root.document && root.document.getElementById('c-service-title');
    if (titleEl) titleEl.textContent = vehicles.length > 1 ? ('Service · ' + vehicles.length + ' vehicles') : 'Service';
    var travelLine = root.document && root.document.getElementById('c-travel-line');
    if (travelLine) {
      travelLine.innerHTML = totals.fee > 0
        ? '<div class="or"><span class="ol">Mobile service adjustment</span><span class="ov">+' + money(totals.fee) + '</span></div>'
        : '';
    }
    var offerLine = root.document && root.document.getElementById('c-offer-line');
    if (offerLine) {
      offerLine.style.display = totals.discount > 0 ? '' : 'none';
      offerLine.innerHTML = totals.discount > 0
        ? '<div class="or"><span class="ol">' + totals.discountLabel + '</span><span class="ov" style="color:var(--gr)">-' + money(totals.discount) + '</span></div>'
        : '';
    }
    if (root.Cardetail1WelcomeOffer && typeof root.Cardetail1WelcomeOffer.renderOfferLines === 'function') {
      root.Cardetail1WelcomeOffer.renderOfferLines(ST.offerPreview, totals.cartBase, totals.fee);
    }
    text('c-name', (val('f-first') + ' ' + val('f-last')).trim() || '—');
    text('c-phone', val('f-phone') || '—');
    text('c-email', val('f-email') || '—');
    text('c-addr', val('f-addr') || '—');
    var dateIso = val('f-date');
    var windowVal = val('f-arrival-window');
    var timeVal = val('f-time');
    text('c-date', (formatDateLabel(dateIso) + ' · ' + formatArrival(windowVal, timeVal)).replace(/^ · /, '') || '—');
    var pmEl = root.document && root.document.getElementById('c-pay-method');
    if (pmEl) pmEl.textContent = preferenceLabel(ST.payMethod) || 'Select a preference';
    syncPreferenceButtons(ST.payMethod);
    return totals;
  }

  function syncPreferenceButtons(value) {
    var selected = String(value || '');
    PREFERENCE_VALUES.forEach(function (key) {
      var meta = REQUEST_PREFERENCES[key];
      var el = root.document && root.document.getElementById(meta.id);
      if (el) {
        var on = selected === key;
        el.classList.toggle('sel', on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    });
  }

  function selectRequestPaymentPreference(preference) {
    if (!isKnownPreference(preference)) return;
    var ST = root.ST || (root.ST = {});
    ST.payMethod = preference;
    syncPreferenceButtons(preference);
    var pmEl = root.document && root.document.getElementById('c-pay-method');
    if (pmEl) pmEl.textContent = preferenceLabel(preference);
    var err = root.document && root.document.getElementById('bk-pay-pref-err');
    if (err) { err.textContent = ''; err.hidden = true; }
  }

  function showFallbackSuccess(payload) {
    var b = payload || {};
    var id = b.id || (root.ST && root.ST.bookingId) || '';
    try {
      if (typeof root.bkGoTo === 'function') root.bkGoTo(6, { noScroll: false, success: true });
    } catch (e1) { /* still paint fallback */ }
    var ok = root.document && (root.document.getElementById('bs6') || root.document.getElementById('bs-ok'));
    if (ok) {
      ok.classList.add('on');
      var others = root.document.querySelectorAll('.bsec');
      for (var i = 0; i < others.length; i++) {
        if (others[i] !== ok) others[i].classList.remove('on');
      }
    }
    text('ok-title', 'Request received');
    var sub = 'Your booking request was received.';
    if (id) sub += ' Reference: ' + id + '.';
    sub += ' No payment was collected today.';
    text('ok-sub', sub);
    try {
      text('ok-total', (b.totalPrice || 0) ? money(b.totalPrice) : 'Estimate');
      text('ok-date', formatDateLabel(b.preferredDate) + (b.preferredArrivalWindow || b.preferredTime ? ' · ' + formatArrival(b.preferredArrivalWindow, b.preferredTime) : ''));
      text('ok-ref', id || '—');
      text('ok-pay', preferenceLabel(b.paymentMethodPreference || b.paymentMethod) || '—');
    } catch (e2) { /* minimal fallback already shown */ }
    return { ok: true, fallback: true, id: id };
  }

  function showSuccess(payload) {
    var ST = root.ST || {};
    var b = payload || root.__lastBookingPayload || {};
    ST.bookingPersisted = true;
    ST.bookingCreated = true;
    ST.lastPersistedBooking = b;
    try {
      if (typeof root.clearDraftSaveTokenState === 'function') root.clearDraftSaveTokenState();
    } catch (e0) { /* non-blocking */ }
    var totals = presentationTotals(b);
    var displayTotal = b.totalPrice != null ? num(b.totalPrice) : totals.estimatedTotal;
    try {
      var tabs = root.document && root.document.querySelectorAll('.bpt');
      if (tabs) {
        for (var t = 0; t < tabs.length; t++) {
          tabs[t].classList.remove('active');
          tabs[t].classList.add('done');
        }
      }
      if (typeof root.bkGoTo === 'function') {
        root.bkGoTo(6, { noScroll: false, success: true });
      } else {
        var sections = root.document.querySelectorAll('.bsec');
        for (var s = 0; s < sections.length; s++) sections[s].classList.remove('on');
        var successEl = root.document.getElementById('bs6') || root.document.getElementById('bs-ok');
        if (successEl) successEl.classList.add('on');
      }
      var okCards = root.document && root.document.getElementById('ok-vehicle-cards');
      if (okCards && typeof root.bkRenderVehicleSummary === 'function' && typeof root.bkProjectVehicles === 'function') {
        okCards.innerHTML = root.bkRenderVehicleSummary(root.bkProjectVehicles(b).items);
      }
      var okTotalEl = root.document && root.document.getElementById('ok-total');
      if (okTotalEl) {
        okTotalEl.setAttribute('data-locked', '1');
        okTotalEl.textContent = displayTotal ? money(displayTotal) : 'Estimate';
      }
      text('ok-date', formatDateLabel(b.preferredDate || val('f-date')) + ' · ' + formatArrival(b.preferredArrivalWindow || val('f-arrival-window'), b.preferredTime || val('f-time')));
      text('ok-ref', b.id || '—');
      text('ok-pay', preferenceLabel(b.paymentMethodPreference || b.paymentMethod || ST.payMethod) || '—');
      text('ok-title', 'Request received');
      var titleEl = root.document && root.document.getElementById('ok-title');
      if (titleEl) titleEl.textContent = 'Request received';
      var subEl = root.document && root.document.getElementById('ok-sub');
      if (subEl) {
        var ref = b.id ? (' Booking reference: ' + b.id + '.') : '';
        var notify = b.notificationState && b.notificationState.status === 'failed'
          ? ' We could not send the confirmation email automatically — your booking is still saved and our team can resend your access link.'
          : '';
        subEl.textContent = 'Your booking request was received.' + ref + ' No payment was collected today. We\'ll review your request and notify you when the appointment is confirmed. If you opted in for SMS, updates may be sent by text.' + notify;
      }
      var em = root.document && root.document.getElementById('ok-email');
      if (em && typeof root.mailtoForBooking === 'function') em.href = root.mailtoForBooking(b);
      var sm = root.document && root.document.getElementById('ok-sms');
      if (sm && typeof root.smsForBooking === 'function') sm.href = root.smsForBooking(b);
    } catch (renderErr) {
      if (typeof console !== 'undefined' && console.warn) console.warn('Booking success render failed:', renderErr && renderErr.message);
      return showFallbackSuccess(b);
    }
    return { ok: true, fallback: false, id: b.id || '' };
  }

  function classifyError(err, ctx) {
    ctx = ctx || {};
    if (ctx.persisted) return { kind: 'ui_after_persist', retry: false };
    var code = String((err && err.message) || err || '');
    if (ctx.networkAmbiguous) return { kind: 'ambiguous', retry: true, code: code };
    if (SUBMIT_FAILURE_CODES[code] || /booking_submit_failed_|booking_draft_failed_/.test(code)) {
      return { kind: 'rejected', retry: true, code: code };
    }
    if (NETWORK_RE.test(code)) return { kind: 'ambiguous', retry: true, code: code };
    return { kind: 'rejected', retry: true, code: code };
  }

  function notSubmittedMessage(code) {
    return SUBMIT_FAILURE_CODES[code] || ('Your booking request was not submitted. No payment was collected. Please try again.');
  }

  function applyPersistedFields(payload, data) {
    payload.id = data.id;
    payload.status = data.status || 'Pending Review';
    payload.paymentStatus = data.paymentStatus || 'no_payment_required_yet';
    payload.appointmentStatus = data.appointmentStatus || 'pending_review';
    payload.jobStatus = 'pending_review';
    payload.paymentWorkflowStatus = 'no_payment_required_yet';
    payload.cardOnFileStatus = data.cardOnFileStatus || 'not_collected';
    payload.cardOnFileRequired = false;
    payload.cloudSaved = true;
    payload.bookingCreated = true;
    payload.notificationState = data.customerEmail || (data.notificationDelivery && data.notificationDelivery.customerEmail) || null;
    return payload;
  }

  function attachPreference(payload) {
    var ST = root.ST || {};
    var pref = String(ST.payMethod || payload.paymentMethodPreference || '').trim();
    if (isKnownPreference(pref)) {
      payload.paymentMethodPreference = pref;
      payload.paymentMethod = pref;
    } else {
      payload.paymentMethodPreference = '';
      payload.paymentMethod = '';
    }
    payload.cardOnFileRequired = false;
    return payload;
  }

  function backend() {
    return root.BACKEND_BASE || '/.netlify/functions';
  }

  function headers() {
    if (typeof root.bookingRequestHeaders === 'function') return root.bookingRequestHeaders();
    return { 'Content-Type': 'application/json' };
  }

  async function postBooking(body) {
    return fetch(backend() + '/submit-booking', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
  }

  function isPersistedResponse(res, data) {
    if (!data) return false;
    if (data.bookingCreated === true && data.id) return true;
    if (data.ok && data.idempotent && data.id) return true;
    if (res && res.ok && data.ok && data.id && data.bookingCreated !== false && data.idempotent) return true;
    return false;
  }

  async function submit(win) {
    win = win || root;
    var ST = win.ST || (win.ST = {});
    if (win.OS_PREVIEW_ACTIVE) {
      alert('Preview mode — bookings and payments are disabled.');
      return { ok: false, kind: 'preview' };
    }
    if (ST.submitInFlight) return { ok: false, kind: 'in_flight' };
    if (ST.bookingPersisted && ST.lastPersistedBooking) {
      showSuccess(ST.lastPersistedBooking);
      return { ok: true, kind: 'already_persisted', id: ST.lastPersistedBooking.id };
    }

    var termsOk = win.document.getElementById('terms-ok');
    if (termsOk && !termsOk.checked) {
      alert('Please agree to the Terms & Conditions before submitting your booking request.');
      return { ok: false, kind: 'rejected' };
    }
    if (!isKnownPreference(ST.payMethod)) {
      var prefErr = win.document.getElementById('bk-pay-pref-err');
      if (prefErr) {
        prefErr.hidden = false;
        prefErr.textContent = 'Please choose a preferred payment method.';
      } else {
        alert('Please choose a preferred payment method.');
      }
      return { ok: false, kind: 'rejected', code: 'payment_preference_required' };
    }

    var btn = win.document.getElementById('sub-btn');
    ST.submitInFlight = true;
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }

    var payload = attachPreference(win.buildBookingPayload());
    var persisted = false;
    try {
      if (!ST.draftRegistered) {
        var draftPayload = Object.assign({}, payload, { isDraft: true });
        delete draftPayload.draftBookingId;
        delete draftPayload.draftSaveToken;
        var draftRes = await postBooking(draftPayload);
        var draftData = await draftRes.json().catch(function () { return {}; });
        if (!draftRes.ok || !draftData.ok) {
          throw new Error(draftData.error || draftData.message || ('booking_draft_failed_' + draftRes.status));
        }
        if (typeof win.captureDraftSaveResponse === 'function') win.captureDraftSaveResponse(draftData);
        payload = attachPreference(win.buildBookingPayload());
      }

      var res = await postBooking(payload);
      var data = await res.json().catch(function () { return {}; });
      if (!isPersistedResponse(res, data)) {
        if (data.error === 'booking_slot_unavailable' || data.error === 'booking_date_unavailable' || data.error === 'booking_time_unavailable') {
          alert(data.userMessage || 'That time is unavailable. Choose another slot and submit again. No payment was collected.');
          return { ok: false, kind: 'rejected', code: data.error };
        }
        throw new Error(data.error || data.message || ('booking_submit_failed_' + res.status));
      }
      if (data.bookingCreated !== true && !data.idempotent) {
        throw new Error('booking_not_persisted');
      }
      persisted = true;
      ST.bookingPersisted = true;
      payload = applyPersistedFields(payload, data);
      ST.lastPersistedBooking = payload;
      if (typeof win.saveLocalBooking === 'function') win.saveLocalBooking(payload);
      if (win.Cardetail1CheckoutAnalytics && typeof win.Cardetail1CheckoutAnalytics.onBookingSubmitted === 'function') {
        win.Cardetail1CheckoutAnalytics.onBookingSubmitted();
      }
      try {
        showSuccess(payload);
      } catch (renderErr) {
        if (typeof console !== 'undefined' && console.warn) console.warn('Booking success render failed:', renderErr && renderErr.message);
        showFallbackSuccess(payload);
      }
      return { ok: true, kind: 'persisted', id: payload.id };
    } catch (e) {
      if (persisted || ST.bookingPersisted) {
        showFallbackSuccess(ST.lastPersistedBooking || payload);
        return { ok: true, kind: 'ui_after_persist', id: (ST.lastPersistedBooking && ST.lastPersistedBooking.id) || payload.id };
      }
      var code = String((e && e.message) || '');
      if (NETWORK_RE.test(code) && ST.draftRegistered) {
        try {
          var retryRes = await postBooking(attachPreference(win.buildBookingPayload()));
          var retryData = await retryRes.json().catch(function () { return {}; });
          if (isPersistedResponse(retryRes, retryData)) {
            persisted = true;
            ST.bookingPersisted = true;
            payload = applyPersistedFields(attachPreference(win.buildBookingPayload()), retryData);
            ST.lastPersistedBooking = payload;
            if (typeof win.saveLocalBooking === 'function') win.saveLocalBooking(payload);
            showSuccess(payload);
            return { ok: true, kind: 'reconciled', id: payload.id };
          }
        } catch (e2) { /* still ambiguous */ }
        alert('We could not confirm whether your booking request was received. Please wait a moment and check My Garage or contact us before submitting again. No payment was collected.');
        return { ok: false, kind: 'ambiguous' };
      }
      if (typeof console !== 'undefined' && console.warn) console.warn('Booking submission failed:', code);
      alert(notSubmittedMessage(code));
      return { ok: false, kind: 'rejected', code: code };
    } finally {
      ST.submitInFlight = false;
      if (btn && !ST.bookingPersisted) {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    }
  }

  function wrapGoTo(win) {
    var orig = win.bkGoTo;
    if (typeof orig !== 'function' || orig._reviewRuntime) return;
    var wrapped = function (n, opts) {
      opts = opts || {};
      var ST = win.ST || {};
      n = Number(n) || 1;
      if (n === 6 && !opts.success && !ST.bookingPersisted) n = 5;
      if (ST.bookingPersisted && n < 6 && !opts.force) n = 6;
      var result = orig.call(win, n, opts);
      try {
        if (n === 5 && !ST.bookingPersisted) fillReviewSubmit();
      } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('Review render failed:', e && e.message);
      }
      return result;
    };
    wrapped._reviewRuntime = true;
    win.bkGoTo = wrapped;
  }

  function install(win) {
    win = win || root;
    if (!win || win.__cd1BookingReviewInstalled) {
      wrapGoTo(win);
      return api;
    }
    win.bkMoney = money;
    win.renderBkFinancialSummary = renderBkFinancialSummary;
    win.selectRequestPaymentPreference = selectRequestPaymentPreference;
    win.showSuccess = function (payload) { return showSuccess(payload); };
    win.submitBooking = function () { return submit(win); };
    var origFill = win.fillConfirm;
    win.fillConfirm = function () { return fillReviewSubmit(); };
    if (typeof origFill === 'function') win._origFillConfirm = origFill;
    wrapGoTo(win);
    win.__cd1BookingReviewInstalled = true;
    return api;
  }

  var api = {
    money: money,
    bkMoney: money,
    REQUEST_PREFERENCES: REQUEST_PREFERENCES,
    PREFERENCE_VALUES: PREFERENCE_VALUES,
    preferenceLabel: preferenceLabel,
    isKnownPreference: isKnownPreference,
    presentationTotals: presentationTotals,
    renderBkFinancialSummary: renderBkFinancialSummary,
    fillReviewSubmit: fillReviewSubmit,
    selectRequestPaymentPreference: selectRequestPaymentPreference,
    showSuccess: showSuccess,
    showFallbackSuccess: showFallbackSuccess,
    classifyError: classifyError,
    notSubmittedMessage: notSubmittedMessage,
    isPersistedResponse: isPersistedResponse,
    submit: submit,
    install: install,
    formatArrival: formatArrival,
    formatDateLabel: formatDateLabel,
  };
  return api;
}));
