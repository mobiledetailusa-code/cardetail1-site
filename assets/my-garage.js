/**
 * Shared My Garage / customer portal frontend logic.
 * Server-side authorization is required for all protected reads/writes.
 */
(function (global) {
  'use strict';

  var API = '/.netlify/functions/';
  var state = {
    scope: null,
    booking: null,
    bookings: [],
    vehicles: [],
    session: false,
    verifyPhone: '',
    verifyBookingId: '',
    actionToken: null,
    catalog: null,
    changeRequests: [],
    payment: null,
  };

  var modalAction = null;
  var modalMode = 'fields';
  var modalFields = [];
  /** One in-flight mutation per modal action — client idempotency lock. */
  var mutationPending = false;

  function $(id) { return document.getElementById(id); }

  function settledCentsFromPayment(pay) {
    var p = pay || state.payment || {};
    if (p.settledCents != null) return Math.max(0, Math.round(Number(p.settledCents) || 0));
    return Math.max(0, Math.round((Number(p.amountPaid) || 0) * 100));
  }

  function remainingCentsFromPayment(pay) {
    var p = pay || state.payment || {};
    if (p.remainingCents != null) return Math.max(0, Math.round(Number(p.remainingCents) || 0));
    return Math.max(0, Math.round((Number(p.amountDueApproved) || 0) * 100));
  }

  function approvedCentsFromPayment(pay) {
    var p = pay || state.payment || {};
    if (p.approvedCents != null) return Math.max(0, Math.round(Number(p.approvedCents) || 0));
    return Math.max(0, Math.round((Number(p.approvedTotal) || 0) * 100));
  }

  function fmtCents(cents) {
    return fmtMoney((Number(cents) || 0) / 100);
  }

  function currentBookingAddonIds() {
    var b = state.booking || {};
    var list = Array.isArray(b.addons) ? b.addons : [];
    return list.map(function (a) { return String(a.id || '').trim(); }).filter(Boolean);
  }

  function addonsForBookingCategory() {
    var cat = getCatalog();
    var key = normalizePackageCategory(
      (state.booking && (state.booking.vehicleCategory || state.booking.cat)) || 'cars'
    ) || 'cars';
    if (cat.addonsByCategory && cat.addonsByCategory[key] && cat.addonsByCategory[key].length) {
      return cat.addonsByCategory[key];
    }
    return cat.addons || [];
  }

  function setModalSubmitPending(on) {
    mutationPending = !!on;
    var btn = $('modal-submit');
    if (btn) {
      btn.disabled = !!on;
      btn.classList.toggle('is-disabled', !!on);
      btn.textContent = on ? 'Updating…' : 'Submit';
    }
  }

  function mapAddonErrorMessage(data, status) {
    var err = (data && data.error) || '';
    if (status === 429 || err === 'too_many_requests') {
      return 'Too many requests. Wait a moment and try again — your session is still active.';
    }
    if (status >= 500 || err === 'service_unavailable' || err === 'postgres_payment_disabled') {
      return 'Temporary server error. Try again shortly — your session is still active.';
    }
    if (err === 'version_conflict') {
      return 'This booking changed. Reloading the latest totals — please review and try again if needed.';
    }
    if (err === 'unknown_addon' || err === 'unknown_addon_id') {
      return 'That add-on is not available for this vehicle.';
    }
    if (err === 'duplicate_addon') {
      return 'That add-on is already on your booking.';
    }
    if (err === 'settled_addon_remove_denied') {
      return 'Paid add-ons cannot be removed online.';
    }
    if (err === 'invoice_paid') {
      return (data && data.message) || 'This change is not available after payment.';
    }
    return (data && data.message) || 'Unable to update add-ons. Call/text 551-313-2956.';
  }

  function applyAuthoritativeMoney(data) {
    if (!data) return;
    var proj = data.postgresProjection || data.financialProjection || null;
    if (proj && (proj.approvedCents != null || proj.remainingCents != null)) {
      state.payment = Object.assign({}, state.payment || {}, {
        approvedCents: proj.approvedCents,
        settledCents: proj.settledCents,
        remainingCents: proj.remainingCents,
        approvedTotal: (proj.approvedCents || 0) / 100,
        amountPaid: (proj.settledCents || 0) / 100,
        amountDueApproved: (proj.remainingCents || 0) / 100,
        state: proj.paymentStatus || (state.payment && state.payment.state) || null,
        paymentStatus: proj.paymentStatus || (state.payment && state.payment.paymentStatus) || null,
        canPay: (proj.remainingCents || 0) > 0,
        canCreatePayLink: (proj.remainingCents || 0) > 0,
        quoteVersion: data.quoteVersion != null
          ? data.quoteVersion
          : (proj.quoteVersion != null ? proj.quoteVersion : (state.payment && state.payment.quoteVersion)),
      });
    } else if (data.approvedCents != null || data.remainingCents != null) {
      state.payment = Object.assign({}, state.payment || {}, {
        approvedCents: data.approvedCents,
        settledCents: data.settledCents,
        remainingCents: data.remainingCents,
        approvedTotal: (data.approvedCents || 0) / 100,
        amountPaid: (data.settledCents || 0) / 100,
        amountDueApproved: (data.remainingCents || 0) / 100,
        canPay: (data.remainingCents || 0) > 0,
        canCreatePayLink: (data.remainingCents || 0) > 0,
        quoteVersion: data.quoteVersion != null
          ? data.quoteVersion
          : (state.payment && state.payment.quoteVersion),
      });
    }
  }

  function normalizePhoneInput(raw) {
    return String(raw || '').replace(/\D/g, '');
  }

  function show(el, on) {
    if (!el) return;
    el.hidden = !on;
    el.style.display = on ? '' : 'none';
  }

  function setMsg(el, text, isErr) {
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
    el.classList.toggle('err', !!isErr);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtMoney(n) {
    var v = Number(n) || 0;
    return '$' + v.toFixed(2);
  }

  function getCatalog() {
    return state.catalog || {
      packages: [],
      addons: [],
      maintenancePeriods: [],
      vehicleCategories: [],
      vehicleYears: [],
    };
  }

  function bookingBaseTotal(b) {
    if (!b) return 0;
    if (b.approvedFinalAmount != null) return Number(b.approvedFinalAmount) || 0;
    return Number(b.totalPrice || b.finalAmount || 0) || 0;
  }

  function vehicleLine(b) {
    if (!b) return '—';
    var parts = [b.vehicleYear, b.vehicleMake, b.vehicleModel].filter(Boolean).join(' ');
    var length = Number(b.vehicleLengthFt || b.lengthFt || 0);
    var cat = b.vehicleCategory || '';
    if (parts) {
      return parts +
        (cat ? ' · ' + cat : '') +
        (length > 0 ? ' · ' + length + ' ft' : '');
    }
    return (b.vehicleLabel || b.vehicle || '—') + (length > 0 ? ' · ' + length + ' ft' : '');
  }

  function normalizePackageCategory(raw) {
    var key = String(raw || '').toLowerCase().trim();
    if (!key) return '';
    if (key === 'boat' || key === 'boats') return 'boats';
    if (key === 'rv' || key === 'rvs' || key === 'trailer' || key === 'trailers') return 'rvs';
    if (key === 'car' || key === 'cars' || key === 'suv' || key === 'truck' || key === 'van'
      || key === 'minivan' || key === 'sedan' || key === 'coupe') {
      return 'cars';
    }
    return key;
  }

  function inferCategoryFromPackageId(packId) {
    var cat = getCatalog();
    var id = String(packId || '');
    if (!id || !cat.packagesByCategory) return '';
    var keys = Object.keys(cat.packagesByCategory);
    for (var i = 0; i < keys.length; i += 1) {
      var list = cat.packagesByCategory[keys[i]] || [];
      if (list.some(function (p) { return p && p.id === id; })) return keys[i];
    }
    return '';
  }

  function packagesForBooking() {
    var cat = getCatalog();
    var b = state.booking || {};
    var bookingCat = normalizePackageCategory(b.vehicleCategory || b.cat || '');
    var packId = b.packageId || b.pkgId || '';
    var inferred = inferCategoryFromPackageId(packId);
    // Prefer category implied by the current package so a wrong sticky "rvs" label
    // cannot force the Change Package modal into RV-only options for a car booking.
    if (inferred && inferred !== bookingCat) {
      bookingCat = inferred;
    }
    if (!bookingCat) bookingCat = inferred || 'cars';
    if (cat.packagesByCategory && cat.packagesByCategory[bookingCat] && cat.packagesByCategory[bookingCat].length) {
      return { category: bookingCat, packages: cat.packagesByCategory[bookingCat] };
    }
    return { category: 'cars', packages: cat.packages || (cat.packagesByCategory && cat.packagesByCategory.cars) || [] };
  }

  function lengthCfg(category) {
    var cat = getCatalog();
    var key = String(category || '').toLowerCase();
    if (key === 'boat') key = 'boats';
    if (key === 'rv' || key === 'trailer' || key === 'trailers') key = 'rvs';
    return (cat.lengthPricing && cat.lengthPricing[key]) || null;
  }

  function estimateLengthPrice(category, packId, lengthFt) {
    var cat = getCatalog();
    var rules = cat.lengthPackageRules && cat.lengthPackageRules[category];
    if (!rules || !rules[packId]) return null;
    var rule = rules[packId];
    var ft = Number(lengthFt) || 0;
    if (!(ft > 0)) return null;
    if (rule.base != null || rule.ratePerFoot != null) {
      var base = Number(rule.base) || 0;
      var rate = Number(rule.ratePerFoot != null ? rule.ratePerFoot : rule.perFt) || 0;
      return Math.round((base + rate * ft) * 100) / 100;
    }
    var raw = Number(rule.perFt || 0) * ft;
    return Math.max(Number(rule.min) || 0, Math.round(raw));
  }

  function lengthRulerHtml(category, currentFt) {
    var cfg = lengthCfg(category);
    if (!cfg) return '';
    var start = Number(currentFt) || cfg.defaultFt || cfg.min;
    return '<div class="length-box" id="mf-length-box">' +
      '<label for="mf-lengthFt">Length (ft) — required for accurate ' + esc(category) + ' pricing</label>' +
      '<div class="length-row">' +
      '<input type="range" id="mf-length-range" min="' + cfg.min + '" max="' + cfg.max + '" value="' + start + '">' +
      '<input class="inp length-num" id="mf-lengthFt" name="lengthFt" type="number" min="' + cfg.min + '" max="' + cfg.max + '" value="' + start + '" required>' +
      '<span class="length-val" id="mf-length-val">' + start + ' ft</span>' +
      '</div>' +
      '<p class="hint">Drag the ruler or type exact feet (' + cfg.min + '–' + cfg.max + '). Over ' + cfg.estimateOver + ' ft may need estimate confirmation.</p>' +
      '</div>';
  }

  function bindLengthRuler(onChange) {
    var range = $('mf-length-range');
    var num = $('mf-lengthFt');
    var val = $('mf-length-val');
    function sync(from) {
      var v = Number((from === 'range' ? range : num).value);
      if (range) range.value = String(v);
      if (num) num.value = String(v);
      if (val) val.textContent = v + ' ft';
      if (typeof onChange === 'function') onChange(v);
    }
    if (range) range.addEventListener('input', function () { sync('range'); });
    if (num) num.addEventListener('input', function () { sync('num'); });
  }

  function addonLines(b) {
    var list = (b && Array.isArray(b.addons)) ? b.addons : [];
    if (!list.length) return 'None';
    return list.map(function (a) {
      var name = a.name || a.id || 'Add-on';
      var price = a.price != null ? ' (' + fmtMoney(a.price) + ')' : '';
      return name + price;
    }).join(', ');
  }

  async function post(fn, body) {
    var res = await fetch(API + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    return { ok: res.ok, status: res.status, data: data };
  }

  function applyPortalPayload(data) {
    state.catalog = data.catalog || state.catalog || null;
    state.changeRequests = data.changeRequests || [];
    state.payment = data.payment || null;
  }

  async function checkSession() {
    var r = await post('customer-portal-auth', { action: 'session' });
    state.session = !!(r.data && r.data.authenticated);
    return state.session;
  }

  async function loadLimited(opts) {
    opts = opts || {};
    // Action-link scoped session: refresh via in-memory token (never re-persist to URL/localStorage)
    if (state.actionToken && !opts.fromForm) {
      var ar = await post('customer-portal-action', { action: 'view', token: state.actionToken });
      if (ar.data && ar.data.ok) {
        state.booking = ar.data.booking;
        applyPortalPayload(ar.data);
        renderDashboard({ payment: ar.data.payment || { canPay: ar.data.labels && ar.data.labels.canPay } });
        return true;
      }
      // Token expired — clear and fall through
      state.actionToken = null;
    }
    // Login form must win over sticky state — otherwise the last Booking ID stays "locked"
    // and typed IDs never reach the API.
    var formId = ($('lk-booking-id') && $('lk-booking-id').value.trim().toUpperCase()) || '';
    var formPhone = normalizePhoneInput($('lk-phone') && $('lk-phone').value);
    var bookingId = state.booking && (state.booking.id || state.booking.bookingId);
    var bookingPhone = state.booking && state.booking.phone;
    var id = opts.fromForm
      ? formId
      : (state.verifyBookingId || formId || (bookingId ? String(bookingId).toUpperCase() : ''));
    var phone = opts.fromForm
      ? formPhone
      : (normalizePhoneInput(state.verifyPhone) || formPhone || normalizePhoneInput(bookingPhone));
    if (!id || phone.length < 10) {
      if (opts.fromForm) setMsg($('lk-error'), 'Enter your booking ID and phone number.', true);
      return false;
    }
    var r = await post('customer-portal-data', { mode: 'limited', bookingId: id, phone: phone });
    if (!r.data || !r.data.ok) {
      var errCode = (r.data && r.data.error) || '';
      var errMsg = (r.data && r.data.message) || '';
      // Rate limiting is transient and not a credentials/existence problem —
      // never mislabel it as "not found" and never clear the customer's
      // session over it (that was forcing a real re-login after a burst of
      // legitimate polling, e.g. right after paying).
      if (r.status === 429 || errCode === 'rate_limited') {
        showToast('Too many requests — please wait a moment and try again.', true);
        return false;
      }
      if (!errMsg) {
        if (errCode === 'authentication_failed') errMsg = 'Phone does not match this booking.';
        else if (errCode === 'booking_not_ready') errMsg = 'Booking is not ready in My Garage yet.';
        else errMsg = 'No booking found. Check your ID and phone.';
      }
      // Soft reload (poll / post-submit): never kick the customer out of the appointment hub.
      var soft = !opts.fromForm && !!state.booking;
      var hardAuth = errCode === 'authentication_failed' || errCode === 'booking_not_found';
      if (soft && !hardAuth) {
        showToast(errMsg || 'Could not refresh booking — try again shortly.', true);
        return false;
      }
      setMsg($('lk-error'), errMsg, true);
      show($('pre-auth'), true);
      show($('post-auth'), false);
      // Drop sticky session so refresh does not re-lock the previous Booking ID.
      state.verifyBookingId = '';
      state.verifyPhone = '';
      state.actionToken = null;
      state.booking = null;
      try {
        sessionStorage.removeItem('cd1_garage_id');
        sessionStorage.removeItem('cd1_garage_phone');
      } catch (e) { /* ignore */ }
      return false;
    }
    state.scope = 'booking';
    state.booking = r.data.booking;
    state.bookings = r.data.booking ? [r.data.booking] : [];
    state.verifyPhone = phone;
    state.verifyBookingId = id;
    try {
      sessionStorage.setItem('cd1_garage_id', id);
      sessionStorage.setItem('cd1_garage_phone', phone);
    } catch (e) { /* ignore */ }
    applyPortalPayload(r.data);
    setMsg($('lk-error'), '', false);
    renderDashboard(r.data);
    show($('pre-auth'), false);
    show($('post-auth'), true);
    return true;
  }

  async function loadAccount() {
    var r = await post('customer-portal-data', { mode: 'account' });
    if (!r.data || !r.data.ok) return false;
    state.scope = 'account';
    state.bookings = r.data.bookings || [];
    state.booking = r.data.upcoming || state.bookings[0] || null;
    state.vehicles = r.data.vehicles || [];
    applyPortalPayload(r.data);
    renderDashboard(r.data);
    show($('pre-auth'), false);
    show($('post-auth'), true);
    return true;
  }

  async function startAccountAuth() {
    var email = ($('acct-email') && $('acct-email').value.trim().toLowerCase()) || '';
    var phone = normalizePhoneInput($('acct-phone') && $('acct-phone').value);
    if (!email) {
      setMsg($('acct-error'), 'Enter the email on your booking.', true);
      return;
    }
    if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.authStarted();
    var r = await post('customer-portal-auth', { action: 'start', email: email, phone: phone });
    if (r.data && r.data.ok) {
      setMsg($('acct-error'), 'Check your email for a secure sign-in link (expires in 15 minutes).', false);
    } else {
      setMsg($('acct-error'), (r.data && r.data.message) || 'Sign-in unavailable. Use booking lookup or call/text us.', true);
    }
  }

  async function verifyMagicLink(challengeId, token) {
    var r = await post('customer-portal-auth', { action: 'verify', challengeId: challengeId, token: token });
    if (r.data && r.data.ok) {
      if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.authSucceeded();
      history.replaceState({}, '', 'my-garage.html');
      await loadAccount();
    } else {
      setMsg($('acct-error'), (r.data && r.data.message) || 'This link is invalid or expired.', true);
    }
  }

  function clearLookupCredentials() {
    state.verifyPhone = '';
    state.verifyBookingId = '';
    state.actionToken = null;
    try {
      sessionStorage.removeItem('cd1_garage_id');
      sessionStorage.removeItem('cd1_garage_phone');
    } catch (e) { /* ignore */ }
    if ($('lk-booking-id')) {
      $('lk-booking-id').value = '';
      $('lk-booking-id').readOnly = false;
      $('lk-booking-id').removeAttribute('readonly');
    }
    if ($('lk-phone')) {
      $('lk-phone').value = '';
      $('lk-phone').readOnly = false;
      $('lk-phone').removeAttribute('readonly');
    }
    setMsg($('lk-error'), '', false);
  }

  async function logout() {
    await post('customer-portal-auth', { action: 'logout' });
    state = {
      scope: null, booking: null, bookings: [], vehicles: [],
      session: false, verifyPhone: '', verifyBookingId: '',
      catalog: null, changeRequests: [], payment: null, actionToken: null,
    };
    clearLookupCredentials();
    show($('pre-auth'), true);
    show($('post-auth'), false);
    try {
      var clean = 'my-garage.html';
      if (global.location.search || global.location.hash) {
        history.replaceState({}, '', clean);
      }
    } catch (e) { /* ignore */ }
  }

  function requestTypeLabel(type) {
    var map = {
      package_change_request: 'Package change',
      addon_request: 'Add-ons',
      vehicle_add_request: 'Add vehicle',
      vehicle_replace_request: 'Replace vehicle',
      reschedule_request: 'Reschedule',
      address_update: 'Address update',
      cancellation_request: 'Cancellation',
      maintenance_request: 'Maintenance plan',
      discount_request: 'Discount',
    };
    return map[type] || type || 'Request';
  }

  function summarizeRequestedState(r) {
    var rs = (r && r.requestedState) || {};
    if (r.requestType === 'package_change_request') {
      return (rs.packageName || rs.packageId || 'Package') +
        (rs.proposedTotal ? ' · proposed ' + fmtMoney(rs.proposedTotal) : '');
    }
    if (r.requestType === 'addon_request') {
      var names = (rs.addons || []).map(function (a) { return a.name || a.id; }).join(', ');
      return (names || 'Add-ons') + (rs.proposedTotal ? ' · proposed ' + fmtMoney(rs.proposedTotal) : '');
    }
    if (r.requestType === 'vehicle_add_request' || r.requestType === 'vehicle_replace_request') {
      return rs.vehicleLabel || [rs.year, rs.make, rs.model].filter(Boolean).join(' ') || 'Vehicle';
    }
    if (r.requestType === 'maintenance_request') {
      return (rs.maintenancePeriodLabel || rs.periodLabel || rs.maintenancePeriod || rs.period || 'Plan') +
        ' · ' + (rs.packageName || rs.packageId || 'Package');
    }
    if (r.requestType === 'reschedule_request') {
      return (rs.preferredDate || '') + (rs.preferredTime ? ' · ' + rs.preferredTime : '');
    }
    if (r.requestType === 'address_update') return rs.address || 'New address';
    if (r.requestType === 'cancellation_request' || r.requestType === 'cancellation') return rs.reason || 'Cancellation';
    try { return JSON.stringify(rs); } catch (e) { return ''; }
  }

  function renderPendingRequests(list) {
    var section = $('pending-requests-section');
    var el = $('pending-requests-list');
    if (!section || !el) return;
    var open = (list || []).filter(function (r) {
      var s = String(r.status || '').toLowerCase();
      return s === 'pending' || s === 'pending_approval' || s === 'needs_clarification' || s === 'awaiting_admin';
    });
    if (!open.length) {
      el.innerHTML = '';
      show(section, false);
      return;
    }
    show(section, true);
    el.innerHTML = open.map(function (r) {
      return '<li class="pending-req">' +
        '<strong>' + esc(requestTypeLabel(r.requestType)) + '</strong>' +
        ' · <span class="req-status">' + esc(r.status || 'pending') + '</span>' +
        '<div class="req-detail">' + esc(summarizeRequestedState(r)) + '</div>' +
        (r.customerVisibleResult ? '<div class="req-note">' + esc(r.customerVisibleResult) + '</div>' : '') +
        '</li>';
    }).join('');
  }

  function invoiceIsPaid(pay) {
    var p = pay || state.payment || {};
    if (p.state === 'paid') return true;
    var due = Number(p.amountDueApproved || 0);
    var paid = Number(p.amountPaid || 0);
    return paid > 0 && !(due > 0) && !(p.canPay || p.canCreatePayLink);
  }

  function syncMoneyActionButtons(pay) {
    var paid = invoiceIsPaid(pay);
    // Stage 2: additive add-ons remain available after payment; pack/vehicle stay locked.
    var moneyActionsLockedWhenPaid = {
      package_change_request: true,
      vehicle_add_request: true,
      vehicle_replace_request: true,
      maintenance_request: true,
    };
    var root = $('customer-actions');
    if (!root) return;
    root.querySelectorAll('[data-action]').forEach(function (btn) {
      var action = btn.getAttribute('data-action');
      if (action === 'addon_request') {
        btn.disabled = false;
        btn.classList.remove('is-disabled');
        btn.title = paid
          ? 'Add services — new balance due will appear after approval'
          : '';
        return;
      }
      if (!moneyActionsLockedWhenPaid[action]) return;
      btn.disabled = !!paid;
      btn.classList.toggle('is-disabled', !!paid);
      btn.title = paid
        ? 'Invoice paid — call/text Cardetail1 for a quote adjustment'
        : '';
    });
  }

  function syncPayBalanceButton(pay) {
    var link = $('pay-balance-link');
    if (!link) return;
    var due = Number(pay.amountDueApproved || 0);
    var can = !!(pay.canPay || pay.canCreatePayLink);
    link.classList.toggle('is-disabled', !can);
    link.setAttribute('aria-disabled', can ? 'false' : 'true');
    if (can && due > 0) {
      link.textContent = 'Pay Balance · ' + fmtMoney(due);
    } else if (can) {
      link.textContent = 'Pay Balance';
    } else {
      link.textContent = invoiceIsPaid(pay) ? 'Invoice paid' : 'Pay Balance';
    }
    syncMoneyActionButtons(pay);
  }

  function renderPaymentsPanel(pay) {
    var panel = $('payments-panel');
    var empty = $('payments-empty');
    if (!panel) return;
    var due = Number(pay.amountDueApproved || 0);
    var can = !!(pay.canPay || pay.canCreatePayLink);
    var paid = invoiceIsPaid(pay);
    if (!can && !(due > 0) && !(Number(pay.approvedTotal || 0) > 0) && !paid) {
      panel.innerHTML = '';
      if (empty) show(empty, true);
      return;
    }
    if (empty) show(empty, false);
    var approvedLabel = fmtCents(approvedCentsFromPayment(pay));
    var paidLabel = fmtCents(settledCentsFromPayment(pay));
    var dueLabel = fmtCents(remainingCentsFromPayment(pay));
    panel.innerHTML =
      '<div class="card pay-card">' +
      '<dl class="meta-grid">' +
      '<div><dt>Invoice status</dt><dd>' + esc(paid ? 'paid' : (pay.state || '—')) + '</dd></div>' +
      '<div><dt>Total approved</dt><dd>' + approvedLabel + '</dd></div>' +
      '<div><dt>Amount paid</dt><dd>' + paidLabel + '</dd></div>' +
      '<div><dt>Amount due</dt><dd>' + dueLabel + '</dd></div>' +
      '</dl>' +
      (can
        ? '<button type="button" class="btn primary" id="btn-pay-balance">Pay ' +
          (due > 0 ? dueLabel : 'Balance') + ' securely</button>' +
          '<p class="hint">Secure Stripe Checkout (card only). After payment your invoice closes automatically.</p>'
        : (paid
          ? '<p class="hint">Invoice paid. You can still add services — any new balance appears here. Package and vehicle changes stay closed.</p>'
          : '<p class="hint">No balance is due yet, or payment is locked until admin approval.</p>')) +
      '</div>';
    var btn = $('btn-pay-balance');
    if (btn) btn.addEventListener('click', startPayBalance);
  }

  function renderMaintenancePlans() {
    var empty = $('maintenance-empty');
    var list = $('maintenance-list');
    var cat = getCatalog();
    var pendingMaint = (state.changeRequests || []).filter(function (r) {
      return r.requestType === 'maintenance_request';
    });
    if (list) {
      if (pendingMaint.length) {
        list.innerHTML = pendingMaint.map(function (r) {
          return '<li>' + esc(summarizeRequestedState(r)) + ' · ' + esc(r.status || 'pending') + '</li>';
        }).join('');
        if (empty) show(empty, false);
      } else {
        list.innerHTML = '';
        if (empty) {
          empty.innerHTML =
            'No active maintenance plan. Choose a package and frequency — we send it to admin as a new request. ' +
            '<button type="button" class="btn ghost" data-action="maintenance_request" style="margin-top:8px">Start a plan</button>';
          show(empty, true);
        }
      }
    } else if (empty) {
      show(empty, !pendingMaint.length);
    }
    if (empty && cat.packages && cat.packages.length) {
      // catalog available for modal
    }
  }

  function renderDashboard(data) {
    var b = state.booking;
    var hero = $('upcoming-panel');
    var pay = (data && data.payment) || state.payment || {};
    state.payment = pay;

    if (!hero || !b) {
      if (hero) hero.innerHTML = '<p class="empty">No upcoming appointment. <a href="index.html">Book a service</a>.</p>';
      syncPayBalanceButton({});
      renderPaymentsPanel({});
      renderPendingRequests([]);
      return;
    }

    var offer = b.offer || b.welcomeOffer || null;
    var offerHtml = '';
    if (offer && offer.eligibility_status === 'eligible' && Number(offer.discount_amount) > 0) {
      offerHtml =
        '<div><dt>' + esc(offer.public_name || 'Welcome offer') + '</dt><dd>-' + fmtMoney((offer.discount_amount || 0) / 100) + '</dd></div>' +
        '<div><dt>Original eligible subtotal</dt><dd>' + fmtMoney((offer.eligible_subtotal || 0) / 100) + '</dd></div>' +
        '<div><dt>Redemption status</dt><dd>' + esc(offer.redemption_status || 'pending') + '</dd></div>';
    }

    var packDesc = b.packageDescription || '';
    var packDur = b.packageDuration || '';
    var pendingFlag = b.customerChangePending || (state.changeRequests || []).some(function (r) {
      var s = String(r.status || '').toLowerCase();
      return s === 'pending' || s === 'pending_approval' || s === 'needs_clarification';
    });

    hero.innerHTML =
      '<div class="card">' +
      '<div class="card-kicker">' + esc(b.status || 'Status') +
      (pendingFlag ? ' · Change pending' : '') + '</div>' +
      '<h2 class="card-title">' + esc(b.service || b.package || 'Service') + '</h2>' +
      (packDesc ? '<p class="pack-desc">' + esc(packDesc) + (packDur ? ' · ' + esc(packDur) : '') + '</p>' : '') +
      '<dl class="meta-grid">' +
      '<div><dt>Booking ID</dt><dd class="mono">' + esc(b.id || '—') + '</dd></div>' +
      '<div><dt>Vehicle</dt><dd>' + esc(vehicleLine(b)) + '</dd></div>' +
      '<div><dt>Add-ons</dt><dd>' + esc(addonLines(b)) + '</dd></div>' +
      '<div><dt>Date</dt><dd>' + esc(b.confirmedDate || b.preferredDate || '—') + '</dd></div>' +
      '<div><dt>Time</dt><dd>' + esc(b.confirmedTime || b.preferredTime || b.confirmedTimeWindow || '—') + '</dd></div>' +
      '<div><dt>Location</dt><dd>' + esc(b.address || b.serviceLocation || '—') + '</dd></div>' +
      (b.assignedTechName ? '<div><dt>Technician</dt><dd>' + esc(b.assignedTechName) + '</dd></div>' : '') +
      (b.travelFeeAmount ? '<div><dt>Travel fee</dt><dd>' + fmtMoney(b.travelFeeAmount) + '</dd></div>' : '') +
      offerHtml +
      '<div><dt>Total approved</dt><dd>' + (
        pay.approvedCents != null || pay.approvedTotal != null
          ? fmtCents(approvedCentsFromPayment(pay))
          : fmtMoney(b.approvedFinalAmount != null ? b.approvedFinalAmount : b.totalPrice)
      ) + '</dd></div>' +
      (settledCentsFromPayment(pay) > 0
        ? '<div><dt>Amount paid</dt><dd>' + fmtCents(settledCentsFromPayment(pay)) + '</dd></div>'
        : '') +
      (remainingCentsFromPayment(pay) > 0
        ? '<div><dt>Amount due</dt><dd>' + fmtCents(remainingCentsFromPayment(pay)) + '</dd></div>'
        : '') +
      '</dl>' +
      ((pay.canPay || pay.canCreatePayLink)
        ? '<button type="button" class="btn primary" data-portal-pay>Pay Balance' +
          (pay.amountDueApproved ? ' · ' + fmtMoney(pay.amountDueApproved) : '') + '</button>'
        : '') +
      '</div>';

    var payBtn = hero.querySelector('[data-portal-pay]');
    if (payBtn) payBtn.addEventListener('click', startPayBalance);

    syncPayBalanceButton(pay);
    renderPaymentsPanel(pay);
    renderPendingRequests(state.changeRequests);
    renderMaintenancePlans();

    renderList('appointments-list', state.bookings.length ? state.bookings : [b], function (item) {
      return '<li><strong class="mono">' + esc(item.id || '') + '</strong> — ' +
        esc(item.status || '') + ' · ' + esc(item.preferredDate || '—') +
        ' · ' + esc(item.service || item.package || '') +
        ' · ' + esc(vehicleLine(item)) + '</li>';
    });

    renderList('vehicles-list', state.vehicles, function (v) {
      var label = v.label || [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
      return '<li>' + esc(label) + (v.category ? ' · ' + esc(v.category) : '') + '</li>';
    });

    var hist = (state.bookings.length ? state.bookings : [b]).filter(function (x) {
      return x.status === 'Paid' || x.status === 'Completed' || x.jobStatus === 'completed';
    });
    renderList('history-list', hist, function (item) {
      return '<li>' + esc(item.preferredDate || '—') + ' · ' + esc(item.service || item.package || '') +
        ' · ' + fmtMoney(item.approvedFinalAmount != null ? item.approvedFinalAmount : item.totalPrice) + '</li>';
    });

    $('vehicles-empty') && show($('vehicles-empty'), !state.vehicles.length);
    $('history-empty') && show($('history-empty'), !hist.length);
    $('comm-empty') && show($('comm-empty'), true);
    $('vehicle-actions') && show($('vehicle-actions'), state.scope === 'account');
    var approveBtn = $('btn-approve-completion');
    var issueBtn = $('btn-report-issue');
    if (approveBtn) show(approveBtn, b.customerApprovalStatus === 'pending' || b.jobStatus === 'completed_pending_payment');
    if (issueBtn) show(issueBtn, ['completed_pending_payment', 'completed_pending_admin_review', 'awaiting_customer_action'].indexOf(b.jobStatus) >= 0 || b.serviceStatus === 'awaiting_customer_action');
  }

  function renderList(id, items, mapFn) {
    var el = $(id);
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = items.map(mapFn).join('');
  }

  async function submitAction(action, payload, opts) {
    opts = opts || {};
    if (!state.booking) return false;
    if (mutationPending && !opts.fromModal) return false;
    var phone = state.verifyPhone || normalizePhoneInput(state.booking.phone);
    var body = Object.assign({
      bookingId: state.booking.id,
      phone: phone,
      action: action,
      expectedBookingVersion: state.booking.bookingVersion,
    }, payload || {});
    // Never send browser prices/totals as authoritative for add-on money.
    delete body.price;
    delete body.priceCents;
    delete body.proposedTotal;
    delete body.approvedTotal;
    delete body.total;
    if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.changeRequested();
    var r = await post('submit-customer-action', body);

    if (r.data && r.data.ok) {
      if (r.data.noop && (r.data.reason === 'duplicate_addon' || action === 'addon_request')) {
        showToast(r.data.message || 'That add-on is already on your booking.');
      } else if (r.data.noop) {
        showToast(r.data.message || 'No change needed.');
      } else if (r.data.pendingApproval) {
        showToast('Request submitted for admin review.');
      } else if (r.data.applied) {
        applyAuthoritativeMoney(r.data);
        showToast('Appointment updated' + (
          r.data.approvedCents != null
            ? (' · total approved ' + fmtCents(r.data.approvedCents))
            : (r.data.approvedFinalAmount != null
              ? (' · new total ' + fmtMoney(Number(r.data.approvedFinalAmount)))
              : '')
        ) + '.');
      } else {
        showToast('Request saved.');
      }
      // Always reload authoritative portal projection; discard local preview totals.
      try {
        if (state.scope === 'account') await loadAccount();
        else await loadLimited({ soft: true });
      } catch (e) { /* keep session; mutation already applied server-side */ }
      return true;
    }

    var msg = mapAddonErrorMessage(r.data, r.status);
    if (r.data && r.data.error === 'version_conflict') {
      showToast(msg, true);
      try {
        if (state.scope === 'account') await loadAccount();
        else await loadLimited({ soft: true });
      } catch (e) { /* session preserved */ }
      // Do not silently replay the mutation.
      return false;
    }
    if (opts.fromModal) setMsg($('modal-error'), msg, true);
    else showToast(msg, true);
    return false;
  }

  async function submitPortalAction(action, payload) {
    var r = await post('customer-portal-action', Object.assign({ action: action }, payload || {}));
    if (r.data && r.data.ok) {
      showToast('Saved.');
      if (state.scope === 'account') await loadAccount();
      else await loadLimited();
      return true;
    }
    showToast((r.data && r.data.message) || 'Action unavailable.', true);
    return false;
  }

  async function vehicleAction(action, payload) {
    var r = await post('customer-portal-vehicles', Object.assign({ action: action }, payload || {}));
    if (r.data && r.data.ok) {
      showToast('Vehicle updated.');
      await loadAccount();
      return true;
    }
    showToast((r.data && r.data.message) || 'Vehicle update failed.', true);
    return false;
  }

  var embeddedPay = {
    stripe: null,
    elements: null,
    paymentElement: null,
    clientSecret: null,
  };

  function setEmbeddedPayMsg(text, isErr) {
    var el = $('embedded-pay-msg');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
  }

  function hideEmbeddedPay() {
    var panel = $('embedded-pay-panel');
    if (panel) panel.hidden = true;
    if (embeddedPay.paymentElement) {
      try { embeddedPay.paymentElement.unmount(); } catch (e) { /* ignore */ }
    }
    embeddedPay.paymentElement = null;
    embeddedPay.elements = null;
    embeddedPay.clientSecret = null;
    setEmbeddedPayMsg('', false);
  }

  async function loadStripePublishableKey() {
    try {
      var res = await fetch(API + 'stripe-config', { method: 'GET', credentials: 'same-origin' });
      var data = await res.json();
      return data && data.publishableKey ? data.publishableKey : null;
    } catch (e) {
      return null;
    }
  }

  async function startHostedCheckoutFallback() {
    var phone = state.verifyPhone || normalizePhoneInput(state.booking.phone);
    showToast('Opening hosted Checkout…');
    var r = await post('customer-portal-pay', {
      bookingId: state.booking.id,
      phone: phone,
      expectedQuoteVersion: state.payment && state.payment.quoteVersion,
    });
    if (r.data && r.data.ok && r.data.url) {
      if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.paymentOpened();
      global.location.href = r.data.url;
      return;
    }
    showToast((r.data && r.data.message) || 'Hosted Checkout is not available.', true);
  }

  async function startPayBalance() {
    if (!state.booking) {
      showToast('Open a booking first.', true);
      return;
    }
    var pay = state.payment || {};
    if (!pay.canPay && !pay.canCreatePayLink) {
      showToast('No balance is due yet, or payment is locked until approval.', true);
      return;
    }
    var phone = state.verifyPhone || normalizePhoneInput(state.booking.phone);
    showToast('Preparing secure payment…');

    // Prefer in-page Payment Element (Postgres authority) when available.
    var intent = await post('customer-balance-payment-intent', {
      bookingId: state.booking.id,
      phone: phone,
      expectedQuoteVersion: pay.quoteVersion,
    });

    if (intent.data && intent.data.ok && intent.data.clientSecret) {
      if (typeof global.Stripe !== 'function') {
        showToast('Stripe.js failed to load — using hosted Checkout.', true);
        return startHostedCheckoutFallback();
      }
      var pk = await loadStripePublishableKey();
      if (!pk) {
        showToast('Payment config unavailable — using hosted Checkout.', true);
        return startHostedCheckoutFallback();
      }

      embeddedPay.stripe = global.Stripe(pk);
      embeddedPay.clientSecret = intent.data.clientSecret;
      var elementsOpts = { clientSecret: intent.data.clientSecret };
      if (intent.data.customerSessionClientSecret) {
        elementsOpts.customerSessionClientSecret = intent.data.customerSessionClientSecret;
      }
      embeddedPay.elements = embeddedPay.stripe.elements(elementsOpts);
      embeddedPay.paymentElement = embeddedPay.elements.create('payment', {
        layout: 'tabs',
      });
      var mountEl = $('payment-element');
      var panel = $('embedded-pay-panel');
      var amountEl = $('embedded-pay-amount');
      if (!mountEl || !panel) {
        return startHostedCheckoutFallback();
      }
      if (amountEl) {
        var cents = intent.data.amountCents || pay.remainingCents || 0;
        amountEl.textContent = 'Pay ' + fmtMoney(cents / 100) + ' securely without leaving this page.';
      }
      panel.hidden = false;
      embeddedPay.paymentElement.mount(mountEl);
      setEmbeddedPayMsg('Enter card details to pay. Saved cards appear only when Stripe allows redisplay.', false);
      var fallbackBtn = $('embedded-pay-checkout-fallback');
      if (fallbackBtn) fallbackBtn.hidden = false;
      if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.paymentOpened();
      return;
    }

    // Controlled recovery: hosted Checkout when embedded path unavailable.
    if (intent.data && (intent.data.fallback === 'checkout' || intent.data.error === 'postgres_payment_disabled')) {
      return startHostedCheckoutFallback();
    }
    showToast((intent.data && intent.data.message) || 'Payment is not available yet.', true);
  }

  async function confirmEmbeddedPay() {
    if (!embeddedPay.stripe || !embeddedPay.elements) {
      showToast('Payment form is not ready.', true);
      return;
    }
    var submitBtn = $('embedded-pay-submit');
    if (submitBtn) submitBtn.disabled = true;
    setEmbeddedPayMsg('Processing payment…', false);
    var result = await embeddedPay.stripe.confirmPayment({
      elements: embeddedPay.elements,
      redirect: 'if_required',
      confirmParams: {
        return_url: global.location.origin + '/my-garage.html?paid=1&bookingId=' +
          encodeURIComponent(state.booking.id),
      },
    });
    if (submitBtn) submitBtn.disabled = false;
    if (result.error) {
      setEmbeddedPayMsg(result.error.message || 'Payment failed. Try again or use hosted Checkout.', true);
      return;
    }
    var status = result.paymentIntent && result.paymentIntent.status;
    if (status === 'succeeded' || status === 'processing') {
      setEmbeddedPayMsg(status === 'processing' ? 'Payment processing — confirming…' : 'Payment succeeded — confirming…', false);
      hideEmbeddedPay();
      pollPaymentSettlement();
      return;
    }
    if (status === 'requires_action') {
      setEmbeddedPayMsg('Additional authentication required. Follow the prompts.', false);
      return;
    }
    setEmbeddedPayMsg('Payment status: ' + (status || 'unknown'), true);
  }

  function bindEmbeddedPayControls() {
    var submit = $('embedded-pay-submit');
    var cancel = $('embedded-pay-cancel');
    var fallback = $('embedded-pay-checkout-fallback');
    if (submit) submit.addEventListener('click', function () { confirmEmbeddedPay(); });
    if (cancel) cancel.addEventListener('click', function () { hideEmbeddedPay(); });
    if (fallback) fallback.addEventListener('click', function () { startHostedCheckoutFallback(); });
  }
  bindEmbeddedPayControls();

  function showToast(msg, isErr) {
    var el = $('portal-toast');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  function closeModal() {
    var ov = $('action-modal');
    if (!ov) return;
    ov.classList.remove('open');
    ov.hidden = true;
    modalAction = null;
    modalMode = 'fields';
    modalFields = [];
    setMsg($('modal-error'), '', false);
  }

  function openModalShell(title) {
    $('modal-title').textContent = title;
    var ov = $('action-modal');
    ov.hidden = false;
    ov.classList.add('open');
  }

  function renderPackageModal() {
    var packInfo = packagesForBooking();
    var packs = packInfo.packages || [];
    var category = packInfo.category;
    if (!packs.length) {
      showToast('Package list unavailable. Refresh and try again.', true);
      return false;
    }
    var needsLength = !!lengthCfg(category);
    var currentFt = Number((state.booking && (state.booking.vehicleLengthFt || state.booking.lengthFt)) || 0);
    var form = $('modal-form');
    form.innerHTML =
      '<p class="hint">Select a package' +
      (needsLength ? ' and set length so pricing matches boat/RV size' : '') +
      '. Proposed total updates live; admin approval applies it to your invoice.</p>' +
      (needsLength ? lengthRulerHtml(category, currentFt) : '') +
      '<div class="modal-catalog" role="radiogroup" aria-label="Packages">' +
      packs.map(function (p) {
        var priceLabel = p.basePrice != null ? fmtMoney(p.basePrice) : (p.pricedByLength ? 'By length' : '');
        return '<label class="catalog-option">' +
          '<input type="radio" name="newPackId" value="' + esc(p.id) + '" required>' +
          '<span class="opt-body">' +
          '<span class="opt-name">' + esc(p.name) + '</span>' +
          '<span class="opt-price" data-pack-price="' + esc(p.id) + '">' + esc(priceLabel) + '</span>' +
          '<span class="opt-meta">' + esc(p.duration || '') + (p.tag ? ' · ' + esc(p.tag) : '') + '</span>' +
          '<span class="opt-desc">' + esc(p.description || '') + '</span>' +
          '</span></label>';
      }).join('') +
      '</div>' +
      '<p class="modal-live-total" id="mf-package-proposed">Proposed package price: —</p>';

    function refreshProposed() {
      var packEl = form.querySelector('input[name="newPackId"]:checked');
      var el = $('mf-package-proposed');
      if (!packEl || !el) return;
      var pack = packs.find(function (x) { return x.id === packEl.value; });
      if (!pack) return;
      var ft = Number(($('mf-lengthFt') && $('mf-lengthFt').value) || currentFt || 0);
      var priced = needsLength ? estimateLengthPrice(category, pack.id, ft) : Number(pack.basePrice || 0);
      if (needsLength) {
        form.querySelectorAll('[data-pack-price]').forEach(function (span) {
          var id = span.getAttribute('data-pack-price');
          var est = estimateLengthPrice(category, id, ft);
          span.textContent = est != null ? fmtMoney(est) : 'By length';
        });
      }
      if (priced != null) {
        el.textContent = 'Proposed package price: ' + fmtMoney(priced) +
          (needsLength ? ' · ' + ft + ' ft' : '') +
          ' (+ travel/add-ons as approved)';
      } else {
        el.textContent = 'Proposed package price: —';
      }
    }

    form.querySelectorAll('input[name="newPackId"]').forEach(function (inp) {
      inp.addEventListener('change', refreshProposed);
    });
    if (needsLength) bindLengthRuler(refreshProposed);
    refreshProposed();
    return true;
  }

  function updateAddonLiveTotal() {
    var form = $('modal-form');
    if (!form) return;
    var sumCents = 0;
    form.querySelectorAll('input[name="addonIds"]:checked').forEach(function (inp) {
      sumCents += Math.max(0, Math.round(Number(inp.getAttribute('data-price-cents') || 0)));
    });
    var el = $('mf-addon-total');
    if (el) {
      el.textContent = 'Preview only (catalog): +' + fmtCents(sumCents)
        + ' · Final totals come from the server after you submit';
    }
  }

  function bindAddonRemoveButtons(form) {
    form.querySelectorAll('[data-remove-addon]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-remove-addon');
        if (!id || mutationPending) return;
        removeAddonFromBooking(id);
      });
    });
  }

  async function removeAddonFromBooking(addonId) {
    if (mutationPending) return;
    if (settledCentsFromPayment(state.payment) > 0) {
      showToast('Paid add-ons cannot be removed online.', true);
      return;
    }
    setModalSubmitPending(true);
    setMsg($('modal-error'), '', false);
    try {
      var ok = await submitAction('addon_remove_request', { addonIds: [addonId] }, { fromModal: true });
      if (ok) {
        if (!renderAddonModal()) closeModal();
        else openModalShell('Modify service / add-ons');
      }
    } finally {
      setModalSubmitPending(false);
    }
  }

  function renderAddonModal() {
    var addons = addonsForBookingCategory();
    if (!addons.length) {
      showToast('Add-on list unavailable. Refresh and try again.', true);
      return false;
    }
    var selectedIds = currentBookingAddonIds();
    var selectedSet = {};
    selectedIds.forEach(function (id) { selectedSet[id] = true; });
    var settled = settledCentsFromPayment(state.payment);
    var canRemove = settled === 0;
    var pay = state.payment || {};

    var onBooking = addons.filter(function (a) { return selectedSet[a.id]; });
    // Also show unknown-on-catalog selected ids from booking projection
    selectedIds.forEach(function (id) {
      if (!onBooking.some(function (a) { return a.id === id; })) {
        var fromBooking = (state.booking.addons || []).find(function (a) { return a.id === id; });
        onBooking.push({
          id: id,
          name: (fromBooking && fromBooking.name) || id,
          description: '',
          priceCents: fromBooking && fromBooking.price != null
            ? Math.round(Number(fromBooking.price) * 100)
            : null,
        });
      }
    });
    var available = addons.filter(function (a) {
      return a.available !== false && !selectedSet[a.id];
    });

    var form = $('modal-form');
    form.innerHTML =
      '<p class="hint">Prices shown are from the official catalog. After you submit, My Garage shows the server Total approved / Amount paid / Amount due.</p>' +
      '<dl class="meta-grid" style="margin-bottom:12px">' +
      '<div><dt>Total approved</dt><dd>' + fmtCents(approvedCentsFromPayment(pay)) + '</dd></div>' +
      '<div><dt>Amount paid</dt><dd>' + fmtCents(settledCentsFromPayment(pay)) + '</dd></div>' +
      '<div><dt>Amount due</dt><dd>' + fmtCents(remainingCentsFromPayment(pay)) + '</dd></div>' +
      '</dl>' +
      '<h4 class="sub" style="margin:8px 0 6px">On this booking</h4>' +
      (onBooking.length
        ? '<ul class="clean" id="mf-current-addons">' + onBooking.map(function (a) {
          return '<li class="catalog-option" style="display:flex;justify-content:space-between;gap:8px;align-items:center">' +
            '<span><strong>' + esc(a.name || a.id) + '</strong>' +
            (a.priceCents != null ? ' · ' + fmtCents(a.priceCents) : '') +
            '</span>' +
            (canRemove
              ? '<button type="button" class="btn ghost" data-remove-addon="' + esc(a.id) + '"'
                + (mutationPending ? ' disabled' : '') + '>Remove</button>'
              : '<span class="hint">Paid — removal unavailable</span>') +
            '</li>';
        }).join('') + '</ul>'
        : '<p class="hint">No add-ons on this booking yet.</p>') +
      '<h4 class="sub" style="margin:14px 0 6px">Available add-ons</h4>' +
      (available.length
        ? '<div class="modal-catalog">' + available.map(function (a) {
          var cents = a.priceCents != null
            ? Math.round(Number(a.priceCents) || 0)
            : Math.round((Number(a.price) || 0) * 100);
          return '<label class="catalog-option">' +
            '<input type="checkbox" name="addonIds" value="' + esc(a.id) + '"'
            + ' data-price-cents="' + esc(cents) + '">' +
            '<span class="opt-body">' +
            '<span class="opt-name">' + esc(a.name) + '</span>' +
            '<span class="opt-price">+' + fmtCents(cents) + '</span>' +
            '<span class="opt-desc">' + esc(a.description || a.desc || '') + '</span>' +
            '</span></label>';
        }).join('') + '</div>'
        : '<p class="hint">All catalog add-ons for this vehicle are already on the booking.</p>') +
      '<p class="modal-live-total" id="mf-addon-total">Preview only (catalog): +$0.00 · Final totals come from the server after you submit</p>';

    form.querySelectorAll('input[name="addonIds"]').forEach(function (inp) {
      inp.addEventListener('change', updateAddonLiveTotal);
    });
    bindAddonRemoveButtons(form);
    return true;
  }

  function packagesForCategoryId(categoryId) {
    var cat = getCatalog();
    var key = String(categoryId || '').toLowerCase();
    if (key === 'boat') key = 'boats';
    if (key === 'rv' || key === 'trailer' || key === 'trailers') key = 'rvs';
    if (cat.packagesByCategory && cat.packagesByCategory[key]) {
      return { category: key, packages: cat.packagesByCategory[key] };
    }
    if (key === 'cars' || !key) {
      return { category: 'cars', packages: cat.packages || [] };
    }
    return { category: key, packages: [] };
  }

  function renderVehicleModal(titleHint) {
    var cat = getCatalog();
    var cats = cat.vehicleCategories || [];
    var years = cat.vehicleYears || [];
    var form = $('modal-form');
    form.innerHTML =
      '<p class="hint">' + esc(titleHint || 'Select vehicle details. Boats, RVs, and trailers need length and a package for that category.') + '</p>' +
      '<label for="mf-category">Category</label>' +
      '<select class="inp" id="mf-category" name="category" required>' +
      '<option value="">Select…</option>' +
      cats.map(function (c) {
        return '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>';
      }).join('') +
      '</select>' +
      '<div id="mf-length-host"></div>' +
      '<div id="mf-pack-host"></div>' +
      '<label for="mf-year">Year</label>' +
      '<select class="inp" id="mf-year" name="year" required>' +
      '<option value="">Select…</option>' +
      years.map(function (y) {
        return '<option value="' + esc(y) + '">' + esc(y) + '</option>';
      }).join('') +
      '</select>' +
      '<label for="mf-make">Make</label>' +
      '<input class="inp" id="mf-make" name="make" required placeholder="e.g. Toyota">' +
      '<label for="mf-model">Model</label>' +
      '<input class="inp" id="mf-model" name="model" required placeholder="e.g. Camry">';

    var catSel = $('mf-category');
    function syncCategoryExtras() {
      var host = $('mf-length-host');
      var packHost = $('mf-pack-host');
      var selected = catSel && catSel.value;
      if (host) {
        if (lengthCfg(selected)) {
          host.innerHTML = lengthRulerHtml(selected, lengthCfg(selected).defaultFt);
          bindLengthRuler();
        } else {
          host.innerHTML = '';
        }
      }
      if (packHost) {
        var packInfo = packagesForCategoryId(selected);
        var packs = packInfo.packages || [];
        var tiers = (getCatalog().carSizeTiers) || [];
        var html = '';
        if (selected === 'cars' && tiers.length) {
          html += '<label for="mf-tierKey">Vehicle size</label>' +
            '<select class="inp" id="mf-tierKey" name="tierKey" required>' +
            '<option value="">Select size…</option>' +
            tiers.map(function (t) {
              return '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>';
            }).join('') +
            '</select>';
        }
        if (selected && packs.length) {
          html +=
            '<label>Package for this vehicle</label>' +
            '<div class="modal-catalog" role="radiogroup" aria-label="Vehicle package">' +
            packs.map(function (p) {
              return '<label class="catalog-option">' +
                '<input type="radio" name="packageId" value="' + esc(p.id) + '" data-pack-name="' + esc(p.name) + '" required>' +
                '<span class="opt-body">' +
                '<span class="opt-name">' + esc(p.name) + '</span>' +
                (p.tag ? '<span class="opt-desc">' + esc(p.tag) + '</span>' : '') +
                '</span></label>';
            }).join('') +
            '</div>';
        } else if (selected && !packs.length) {
          html += '<p class="hint">No packages listed for this category. Call/text Cardetail1 to price this vehicle.</p>';
        }
        packHost.innerHTML = html;
      }
    }
    if (catSel) catSel.addEventListener('change', syncCategoryExtras);
    return true;
  }

  function renderMaintenanceModal() {
    var cat = getCatalog();
    var periods = cat.maintenancePeriods || [];
    var packs = cat.packages || [];
    if (!periods.length || !packs.length) {
      showToast('Maintenance catalog unavailable. Refresh and try again.', true);
      return false;
    }
    var form = $('modal-form');
    form.innerHTML =
      '<p class="hint">Choose how often you want service and which package. This creates a new admin request (subscription-style plan).</p>' +
      '<label for="mf-period">Service frequency</label>' +
      '<select class="inp" id="mf-period" name="period" required>' +
      '<option value="">Select…</option>' +
      periods.map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>';
      }).join('') +
      '</select>' +
      '<label>Package for the plan</label>' +
      '<div class="modal-catalog" role="radiogroup" aria-label="Plan package">' +
      packs.map(function (p) {
        return '<label class="catalog-option">' +
          '<input type="radio" name="packageId" value="' + esc(p.id) + '" required>' +
          '<span class="opt-body">' +
          '<span class="opt-name">' + esc(p.name) + '</span>' +
          '<span class="opt-price">' + fmtMoney(p.monthlyPrice != null ? p.monthlyPrice : p.basePrice) +
          (p.monthlyPrice != null ? '/mo plan rate' : '') + '</span>' +
          '<span class="opt-desc">' + esc(p.description || '') + '</span>' +
          '</span></label>';
      }).join('') +
      '</div>' +
      '<label for="mf-note">Notes (optional)</label>' +
      '<textarea class="inp" id="mf-note" name="note" rows="3" placeholder="Preferred days, fleet size, etc."></textarea>';
    return true;
  }

  function openActionModal(action) {
    var moneyLocked = {
      package_change_request: true,
      vehicle_add_request: true,
      vehicle_replace_request: true,
      maintenance_request: true,
    };
    if (moneyLocked[action] && invoiceIsPaid(state.payment)) {
      showToast('Invoice paid — call/text Cardetail1 for a quote adjustment.', true);
      return;
    }

    var simpleDefs = {
      reschedule_request: { title: 'Request new date', fields: [
        { name: 'newDate', label: 'Preferred date', type: 'date', required: true },
        { name: 'newTime', label: 'Preferred time (optional)', type: 'text' },
      ]},
      address_update: { title: 'Update address', fields: [
        { name: 'newAddress', label: 'New service address', type: 'text', required: true },
      ]},
      cancellation_request: { title: 'Cancel appointment', fields: [
        { name: 'reason', label: 'Cancellation reason', type: 'textarea', required: true },
      ]},
      approve_completion: { title: 'Approve completed service', fields: [], confirmOnly: true },
      report_issue: { title: 'Report an issue', fields: [
        { name: 'message', label: 'Describe the issue', type: 'textarea', required: true },
      ]},
    };

    modalAction = action;
    modalMode = 'fields';
    modalFields = [];

    if (action === 'package_change_request') {
      modalMode = 'package';
      if (!renderPackageModal()) { modalAction = null; return; }
      openModalShell('Change package');
      return;
    }
    if (action === 'addon_request') {
      modalMode = 'addons';
      if (!renderAddonModal()) { modalAction = null; return; }
      openModalShell('Modify service / add-ons');
      return;
    }
    if (action === 'vehicle_add_request' || action === 'vehicle_replace_request' || action === 'vehicle_add') {
      modalMode = 'vehicle';
      renderVehicleModal(
        action === 'vehicle_replace_request'
          ? 'Replace the vehicle on this appointment.'
          : action === 'vehicle_add'
            ? 'Save a vehicle to your garage for faster rebooking.'
            : 'Add another vehicle to this appointment request.'
      );
      openModalShell(
        action === 'vehicle_replace_request' ? 'Replace vehicle'
          : action === 'vehicle_add' ? 'Add vehicle to garage' : 'Add vehicle'
      );
      return;
    }
    if (action === 'maintenance_request') {
      modalMode = 'maintenance';
      if (!renderMaintenanceModal()) { modalAction = null; return; }
      openModalShell('Maintenance plan');
      return;
    }

    var def = simpleDefs[action];
    if (!def) return;
    openModalShell(def.title);
    var form = $('modal-form');
    if (def.confirmOnly) {
      form.innerHTML = '<p class="hint">Confirm you approve the completed service. Payment steps may follow if a balance is due.</p>';
      modalFields = [];
      return;
    }
    form.innerHTML = def.fields.map(function (f) {
      if (f.type === 'textarea') {
        return '<label for="mf-' + f.name + '">' + f.label + '</label><textarea class="inp" id="mf-' + f.name + '" name="' + f.name + '"' + (f.required ? ' required' : '') + '></textarea>';
      }
      return '<label for="mf-' + f.name + '">' + f.label + '</label><input class="inp" id="mf-' + f.name + '" name="' + f.name + '" type="' + (f.type || 'text') + '"' + (f.required ? ' required' : '') + '>';
    }).join('');
    modalFields = def.fields;
  }

  function collectCatalogPayload() {
    var form = $('modal-form');
    if (modalMode === 'package') {
      var pack = form.querySelector('input[name="newPackId"]:checked');
      if (!pack) {
        setMsg($('modal-error'), 'Select a package.', true);
        return null;
      }
      var packInfo = packagesForBooking();
      // Only stamp length categories — do not rewrite a car booking to rvs/boats.
      var payload = { newPackId: pack.value };
      if (packInfo.category === 'boats' || packInfo.category === 'rvs') {
        payload.vehicleCategory = packInfo.category;
      }
      if (lengthCfg(packInfo.category)) {
        var ft = Number(($('mf-lengthFt') && $('mf-lengthFt').value) || 0);
        if (!(ft > 0)) {
          setMsg($('modal-error'), 'Enter vessel / RV length in feet.', true);
          return null;
        }
        payload.lengthFt = ft;
      }
      return payload;
    }
    if (modalMode === 'addons') {
      var ids = [];
      form.querySelectorAll('input[name="addonIds"]:checked').forEach(function (inp) {
        ids.push(inp.value);
      });
      if (!ids.length) {
        setMsg($('modal-error'), 'Select at least one add-on.', true);
        return null;
      }
      return { addonIds: ids };
    }
    if (modalMode === 'vehicle') {
      var category = ($('mf-category') && $('mf-category').value) || '';
      var year = ($('mf-year') && $('mf-year').value) || '';
      var make = ($('mf-make') && $('mf-make').value.trim()) || '';
      var model = ($('mf-model') && $('mf-model').value.trim()) || '';
      if (!category || !year || !make || !model) {
        setMsg($('modal-error'), 'Complete category, year, make, and model.', true);
        return null;
      }
      var vehiclePayload = { category: category, year: year, make: make, model: model };
      if (category === 'cars') {
        var tierKey = ($('mf-tierKey') && $('mf-tierKey').value) || '';
        if (!tierKey) {
          setMsg($('modal-error'), 'Select vehicle size (SUV 2-Row, SUV 3-Row, etc.).', true);
          return null;
        }
        vehiclePayload.tierKey = tierKey;
        vehiclePayload.tier = tierKey;
      }
      if (lengthCfg(category)) {
        var lengthFt = Number(($('mf-lengthFt') && $('mf-lengthFt').value) || 0);
        if (!(lengthFt > 0)) {
          setMsg($('modal-error'), 'Enter length in feet for boats and RVs.', true);
          return null;
        }
        vehiclePayload.lengthFt = lengthFt;
      }
      var packEl = form.querySelector('input[name="packageId"]:checked');
      if (!packEl) {
        setMsg($('modal-error'), 'Select a package for this vehicle.', true);
        return null;
      }
      vehiclePayload.packageId = packEl.value;
      vehiclePayload.packageName = packEl.getAttribute('data-pack-name') || '';
      return vehiclePayload;
    }
    if (modalMode === 'maintenance') {
      var period = ($('mf-period') && $('mf-period').value) || '';
      var packageEl = form.querySelector('input[name="packageId"]:checked');
      var note = ($('mf-note') && $('mf-note').value.trim()) || '';
      if (!period || !packageEl) {
        setMsg($('modal-error'), 'Select a frequency and a package.', true);
        return null;
      }
      return { period: period, packageId: packageEl.value, note: note };
    }
    return {};
  }

  async function submitModal() {
    if (!modalAction || mutationPending) return;
    setMsg($('modal-error'), '', false);
    var payload = {};

    if (modalMode !== 'fields') {
      payload = collectCatalogPayload();
      if (!payload) return;
    } else {
      for (var i = 0; i < modalFields.length; i++) {
        var f = modalFields[i];
        var el = $('mf-' + f.name);
        var val = el ? String(el.value || '').trim() : '';
        if (f.required && !val) {
          setMsg($('modal-error'), 'Please complete: ' + f.label, true);
          return;
        }
        payload[f.name] = val;
      }
    }

    setModalSubmitPending(true);
    var ok = false;
    try {
      if (modalAction === 'vehicle_add') {
        ok = await vehicleAction('add', {
          vehicle: {
            label: [payload.year, payload.make, payload.model].join(' '),
            category: payload.category,
            year: payload.year,
            make: payload.make,
            model: payload.model,
          },
        });
      } else if (modalAction === 'approve_completion') {
        ok = await submitPortalAction('approve_completion', {
          bookingId: state.booking && state.booking.id,
          phone: state.verifyPhone || normalizePhoneInput(state.booking && state.booking.phone),
        });
      } else if (modalAction === 'report_issue') {
        ok = await submitPortalAction('report_issue', {
          bookingId: state.booking && state.booking.id,
          phone: state.verifyPhone || normalizePhoneInput(state.booking && state.booking.phone),
          note: payload.message,
        });
      } else if (modalAction === 'addon_request') {
        ok = await submitAction(modalAction, payload, { fromModal: true });
        if (ok) {
          // Re-render modal from server projection; do not keep catalog preview as final.
          if (renderAddonModal()) {
            openModalShell('Modify service / add-ons');
            return;
          }
        }
      } else {
        ok = await submitAction(modalAction, payload, { fromModal: true });
      }
      if (ok) closeModal();
    } finally {
      setModalSubmitPending(false);
    }
  }

  function bindUi() {
    var lkForm = $('lk-form');
    if (lkForm) {
      lkForm.addEventListener('submit', function (e) {
        e.preventDefault();
        loadLimited({ fromForm: true });
      });
    }
    var lkClear = $('lk-clear');
    if (lkClear) {
      lkClear.addEventListener('click', function () {
        clearLookupCredentials();
        if ($('lk-booking-id')) $('lk-booking-id').focus();
      });
    }
    // Editing the login fields clears sticky last-booking so a new code can be used.
    ['lk-booking-id', 'lk-phone'].forEach(function (fid) {
      var el = $(fid);
      if (!el) return;
      el.addEventListener('input', function () {
        state.verifyBookingId = '';
        state.verifyPhone = '';
        state.actionToken = null;
        try {
          sessionStorage.removeItem('cd1_garage_id');
          sessionStorage.removeItem('cd1_garage_phone');
        } catch (e) { /* ignore */ }
      });
    });
    var acctForm = $('acct-form');
    if (acctForm) {
      acctForm.addEventListener('submit', function (e) {
        e.preventDefault();
        startAccountAuth();
      });
    }
    var out = $('btn-logout');
    if (out) out.addEventListener('click', logout);

    var payLink = $('pay-balance-link');
    if (payLink) {
      payLink.addEventListener('click', function (e) {
        e.preventDefault();
        startPayBalance();
      });
    }

    var actions = $('customer-actions');
    if (actions) {
      actions.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        openActionModal(btn.getAttribute('data-action'));
      });
    }
    var maintEmpty = $('maintenance-empty');
    if (maintEmpty) {
      maintEmpty.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        openActionModal(btn.getAttribute('data-action'));
      });
    }
    var vehActions = $('vehicle-actions');
    if (vehActions) {
      vehActions.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-vehicle-action]');
        if (!btn) return;
        if (btn.getAttribute('data-vehicle-action') === 'add') openActionModal('vehicle_add');
      });
    }
    var modalSubmit = $('modal-submit');
    if (modalSubmit) modalSubmit.addEventListener('click', submitModal);
    var modalCancel = $('modal-cancel');
    if (modalCancel) modalCancel.addEventListener('click', closeModal);
    var modalOv = $('action-modal');
    if (modalOv) modalOv.addEventListener('click', function (e) { if (e.target === modalOv) closeModal(); });
    // Enter in address/fields must not GET-navigate away (?newAddress=…) and drop the hub session.
    var modalForm = $('modal-form');
    if (modalForm) {
      modalForm.addEventListener('submit', function (e) {
        e.preventDefault();
        submitModal();
      });
    }
  }

  async function boot() {
    bindUi();
    if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.opened();

    var params = new URLSearchParams(global.location.search);
    // Accidental modal GET submit left junk query keys — strip and recover session.
    var junkKeys = ['newAddress', 'newDate', 'newTime', 'reason', 'message', 'category', 'year', 'make', 'model'];
    var hasJunk = junkKeys.some(function (k) { return params.has(k); });
    if (hasJunk) {
      junkKeys.forEach(function (k) { params.delete(k); });
      var cleaned = params.toString();
      history.replaceState({}, '', 'my-garage.html' + (cleaned ? ('?' + cleaned) : ''));
      params = new URLSearchParams(global.location.search);
    }
    var preId = params.get('bookingId') || params.get('id') || params.get('booking');
    var prePhone = params.get('phone');
    if (preId && $('lk-booking-id')) $('lk-booking-id').value = preId.toUpperCase();
    if (prePhone && $('lk-phone')) $('lk-phone').value = prePhone;

    if (params.get('paid') === '1') {
      // Never treat ?paid=1 as verified settlement — show processing until ledger confirms
      showToast('Payment processing — refreshing your balance…');
    } else if (params.get('canceled') === '1') {
      showToast('Checkout canceled. You can pay anytime from My Garage.', true);
    }

    var actionToken = params.get('action');
    if (actionToken) {
      var ar = await post('customer-portal-action', { action: 'view', token: actionToken });
      if (ar.data && ar.data.ok) {
        state.scope = 'booking';
        state.actionToken = actionToken; // retain in memory only for focus/poll refresh
        state.booking = ar.data.booking;
        if (ar.data.booking && ar.data.booking.id) {
          state.verifyBookingId = ar.data.booking.id;
        }
        // Retain phone for hard-refresh fallback after URL credentials are stripped
        var linkPhone = normalizePhoneInput(
          (ar.data.booking && ar.data.booking.phone) || prePhone || ''
        );
        if (linkPhone.length >= 10) {
          state.verifyPhone = linkPhone;
          try {
            sessionStorage.setItem('cd1_garage_id', state.verifyBookingId);
            sessionStorage.setItem('cd1_garage_phone', linkPhone);
          } catch (e) { /* ignore */ }
        }
        applyPortalPayload(ar.data);
        history.replaceState({}, '', 'my-garage.html');
        renderDashboard({ payment: ar.data.payment || { canPay: ar.data.labels && ar.data.labels.canPay } });
        show($('pre-auth'), false);
        show($('post-auth'), true);
        if (params.get('paid') === '1') pollPaymentSettlement();
        return;
      }
    }

    var challengeId = params.get('auth');
    var token = params.get('t');
    if (challengeId && token) {
      await verifyMagicLink(challengeId, token);
      return;
    }

    if (await checkSession()) {
      await loadAccount();
      if (params.get('paid') === '1') pollPaymentSettlement();
      return;
    }

    // Auto-open only for explicit URL deep-links (incl. Stripe ?paid=1&bookingId=…).
    // Never auto-login from sessionStorage alone — that re-locked the last Booking ID on login.
    var urlHasBooking = !!(params.get('bookingId') || params.get('id') || params.get('booking'));
    if (urlHasBooking && preId) {
      if (!prePhone) {
        try { prePhone = sessionStorage.getItem('cd1_garage_phone') || ''; } catch (e) { prePhone = ''; }
      }
      if (prePhone) {
        state.verifyBookingId = String(preId).toUpperCase();
        state.verifyPhone = normalizePhoneInput(prePhone);
        var wasPaidReturn = params.get('paid') === '1';
        var autoOk = await loadLimited();
        if (autoOk) {
          history.replaceState({}, '', 'my-garage.html' + (wasPaidReturn ? '?paid=1' : ''));
          if (wasPaidReturn) pollPaymentSettlement();
          return;
        }
      }
      clearLookupCredentials();
      if ($('lk-booking-id')) $('lk-booking-id').value = String(preId).toUpperCase();
      if (prePhone && $('lk-phone')) $('lk-phone').value = prePhone;
    } else {
      // Fresh login screen — do not restore the previous Booking ID into the fields.
      clearLookupCredentials();
    }

    show($('pre-auth'), true);
    show($('post-auth'), false);
  }

  async function pollPaymentSettlement() {
    var tries = 0;
    async function tick() {
      tries += 1;
      await portalReload();
      var pay = state.payment || {};
      var settled = pay.state === 'paid' || !(pay.canPay || pay.amountDueApproved > 0);
      if (settled) {
        showToast('Payment confirmed — thank you!');
        return;
      }
      if (tries < 6) {
        setTimeout(tick, 2000);
      } else {
        showToast('Still confirming payment with the server. Tap Refresh — do not pay again.', true);
      }
    }
    setTimeout(tick, 1500);
  }

  function portalReload() {
    if (state.scope === 'account') return loadAccount();
    if (state.actionToken || state.booking) return loadLimited();
    return Promise.resolve();
  }

  global.cd1MyGarage = {
    submitAction: submitAction,
    openModal: openActionModal,
    reload: portalReload,
    startPayBalance: startPayBalance,
  };

  if (global.CD1OperationalRefresh) {
    var portalRefresh = global.CD1OperationalRefresh.createRefreshController({
      onRefresh: function () { return portalReload(); },
      onUpdated: function (d) {
        var el = $('portal-last-updated');
        if (el) el.textContent = 'Updated ' + d.toLocaleTimeString();
      },
      // Pause polling while a change modal is open so refresh cannot yank the appointment away.
      shouldPoll: function () {
        var modal = $('action-modal');
        var modalOpen = modal && !modal.hidden && modal.classList.contains('open');
        return !modalOpen && (!!state.booking || state.session);
      },
    });
    portalRefresh.bindLifecycle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
