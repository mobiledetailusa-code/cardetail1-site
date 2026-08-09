/**
 * Shared My Detailing Portal / customer portal frontend logic.
 * Server-side authorization is required for all protected reads/writes.
 */
(function (global) {
  'use strict';

  var API = '/.netlify/functions/';
  var state = {
    scope: null,
    booking: null,
    bookings: [],
    session: false,
    verifyPhone: '',
    verifyBookingId: '',
    actionToken: null,
    catalog: null,
    packageCatalog: null,
    changeRequests: [],
    payment: null,
    customer: null,
    accountVersion: null,
    appointmentFocusRef: null,
    focusedAppointment: null,
    syncVersion: '',
    serverTime: null,
  };

  var modalAction = null;
  var modalMode = 'fields';
  var modalFields = [];
  /** One in-flight mutation per modal action — client idempotency lock. */
  var mutationPending = false;
  /** Retain a key across timeout/5xx so an uncertain retry cannot duplicate a write. */
  var mutationRequestKeys = Object.create(null);
  /** Focus restore target when the action modal closes. */
  var modalOpenerEl = null;
  /** Selected vehicleId inside the Change Package modal (multi-vehicle). */
  var packageModalVehicleId = '';
  /** Profile / address edit UI state (account scope only). */
  var profileEditing = false;
  var addressEditingId = null;
  var profileAddressBusy = false;
  var portalRefresh = null;
  var portalLastLoadOutcome = { ok: true, status: 0 };
  var paymentConfirmationPending = false;

  /**
   * Portal boot / magic-link hydration — single state machine (avoid boolean soup).
   * idle → validating_link → establishing_session → loading_portal → ready
   *                                      ↘ temporarily_unavailable | failed
   */
  var PORTAL_PHASE = {
    IDLE: 'idle',
    VALIDATING_LINK: 'validating_link',
    ESTABLISHING_SESSION: 'establishing_session',
    LOADING_PORTAL: 'loading_portal',
    READY: 'ready',
    TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable',
    FAILED: 'failed',
  };
  var PORTAL_SLOW_MS = 4000;
  /** Cold Netlify + portal-data often exceeds 10s; keep UI honest without killing success. */
  var PORTAL_TIMEOUT_MS = 30000;
  var portalHydration = {
    phase: PORTAL_PHASE.IDLE,
    generation: 0,
    inFlight: false,
    slowTimer: null,
    timeoutTimer: null,
    lastError: null,
    /** True only after verify succeeded (token consumed server-side). */
    magicLinkConsumed: false,
    /** In-memory magic-link credentials until verify settles — never written to DOM/storage. */
    pendingMagic: null,
  };

  function $(id) { return document.getElementById(id); }

  function isBlockingPortalPhase(phase) {
    return phase === PORTAL_PHASE.VALIDATING_LINK
      || phase === PORTAL_PHASE.ESTABLISHING_SESSION
      || phase === PORTAL_PHASE.LOADING_PORTAL;
  }

  function isErrorPortalPhase(phase) {
    return phase === PORTAL_PHASE.FAILED
      || phase === PORTAL_PHASE.TEMPORARILY_UNAVAILABLE;
  }

  function clearPortalHydrationTimers() {
    if (portalHydration.slowTimer) {
      clearTimeout(portalHydration.slowTimer);
      portalHydration.slowTimer = null;
    }
    if (portalHydration.timeoutTimer) {
      clearTimeout(portalHydration.timeoutTimer);
      portalHydration.timeoutTimer = null;
    }
  }

  function setPortalLoadingMessage(text) {
    var el = $('portal-loading-status');
    if (el) el.textContent = text || '';
  }

  function defaultMessageForPhase(phase) {
    if (phase === PORTAL_PHASE.VALIDATING_LINK || phase === PORTAL_PHASE.ESTABLISHING_SESSION) {
      return 'Signing you in...';
    }
    if (phase === PORTAL_PHASE.LOADING_PORTAL) {
      return 'Loading your garage...';
    }
    if (phase === PORTAL_PHASE.TEMPORARILY_UNAVAILABLE) {
      return 'Your account is temporarily unavailable. Please try again.';
    }
    if (phase === PORTAL_PHASE.FAILED) {
      return "We're having trouble loading your account.";
    }
    return '';
  }

  function renderPortalPhase(phase, opts) {
    opts = opts || {};
    var shell = $('portal-shell');
    var loading = $('portal-loading');
    var pre = $('pre-auth');
    var post = $('post-auth');
    var blocking = isBlockingPortalPhase(phase);
    var errored = isErrorPortalPhase(phase);
    var showLoading = blocking || errored;

    if (shell) {
      shell.setAttribute('data-portal-phase', phase);
      if (blocking) shell.setAttribute('aria-busy', 'true');
      else shell.removeAttribute('aria-busy');
    }
    if (loading) {
      loading.classList.toggle('is-visible', showLoading);
      loading.classList.toggle('is-error', errored);
      loading.hidden = !showLoading;
      loading.setAttribute('aria-busy', blocking ? 'true' : 'false');
    }
    if (post) {
      post.setAttribute('aria-busy', blocking ? 'true' : 'false');
    }

    if (showLoading) {
      show(pre, false);
      show(post, false);
    } else if (phase === PORTAL_PHASE.READY) {
      show(pre, false);
      show(post, true);
    } else {
      show(pre, true);
      show(post, false);
    }

    if (opts.message != null) setPortalLoadingMessage(opts.message);
    else if (showLoading) setPortalLoadingMessage(defaultMessageForPhase(phase));

    if (blocking) {
      try { document.documentElement.classList.add('cd1-portal-booting'); } catch (e) { /* ignore */ }
    } else {
      try { document.documentElement.classList.remove('cd1-portal-booting'); } catch (e) { /* ignore */ }
    }
  }

  function startPortalHydrationTimers(generation) {
    clearPortalHydrationTimers();
    portalHydration.slowTimer = setTimeout(function () {
      if (generation !== portalHydration.generation) return;
      if (!isBlockingPortalPhase(portalHydration.phase)) return;
      setPortalLoadingMessage('Still loading your account...');
    }, PORTAL_SLOW_MS);
    portalHydration.timeoutTimer = setTimeout(function () {
      if (generation !== portalHydration.generation) return;
      if (!isBlockingPortalPhase(portalHydration.phase)) return;
      // Soft timeout: show recovery UI but do NOT bump generation.
      // A late successful verify/loadAccount must still reach ready if the user
      // has not started a newer retry / return-to-sign-in (those bump generation).
      portalHydration.lastError = 'timeout';
      setPortalPhase(PORTAL_PHASE.FAILED);
    }, PORTAL_TIMEOUT_MS);
  }

  function focusPortalRecoveryAction() {
    try {
      var btn = $('portal-retry');
      if (btn && typeof btn.focus === 'function') btn.focus();
    } catch (e) { /* ignore */ }
  }

  function setPortalPhase(phase, opts) {
    opts = opts || {};
    portalHydration.phase = phase;
    if (isBlockingPortalPhase(phase)) {
      if (opts.restartTimers !== false) {
        startPortalHydrationTimers(portalHydration.generation);
      }
    } else {
      clearPortalHydrationTimers();
      // Soft-timeout keeps inFlight so a late success can still settle to ready
      // without a parallel retry racing the same magic-link/session request.
      if (!opts.keepInFlight) portalHydration.inFlight = false;
    }
    renderPortalPhase(phase, opts);
    if (isErrorPortalPhase(phase) && !opts.keepInFlight) focusPortalRecoveryAction();
    return phase;
  }

  function stripMagicLinkParamsFromUrl() {
    try {
      var params = new URLSearchParams(global.location.search);
      if (!params.has('auth') && !params.has('t')) return;
      params.delete('auth');
      params.delete('t');
      var cleaned = params.toString();
      var next = 'my-garage.html' + (cleaned ? ('?' + cleaned) : '') + (global.location.hash || '');
      history.replaceState({}, '', next);
    } catch (e) { /* ignore */ }
  }

  function stripAppointmentFocusFromUrl() {
    try {
      var params = new URLSearchParams(global.location.search);
      if (!params.has('appointment')) return;
      params.delete('appointment');
      // Never leave access tokens in the address bar.
      params.delete('token');
      var cleaned = params.toString();
      var next = 'my-garage.html' + (cleaned ? ('?' + cleaned) : '') + (global.location.hash || '');
      history.replaceState({}, '', next);
    } catch (e) { /* ignore */ }
  }

  function appointmentStatusLabel(b) {
    if (!b) return 'Status';
    return b.customerStatus || b.status || 'Status';
  }

  var ACTIONABLE_JOB_STATUSES = [
    'in_progress', 'en_route', 'on_site', 'awaiting_customer_action',
    'completed_pending_payment', 'completed_pending_admin_review',
  ];

  function appointmentNeedsAttention(b) {
    if (!b) return false;
    if (ACTIONABLE_JOB_STATUSES.indexOf(String(b.jobStatus || '').toLowerCase()) >= 0) return true;
    if (String(b.serviceStatus || '').toLowerCase() === 'awaiting_customer_action') return true;
    return b.customerApprovalStatus === 'pending';
  }

  /** Past services are finished and need nothing from the customer. */
  function appointmentIsPast(b) {
    if (!b) return false;
    if (appointmentNeedsAttention(b)) return false;
    var status = String(b.status || '');
    var job = String(b.jobStatus || '').toLowerCase();
    var pwf = String(b.paymentWorkflowStatus || '').toLowerCase();
    var paySt = String(b.paymentStatus || '').toLowerCase();
    // Settled invoices belong in History even when the operational status label
    // still says Confirmed/submitted (common after card_on_site / webhook lag).
    if (paySt === 'paid' || paySt === 'paid_cash' || paySt === 'paid_card_on_site'
      || pwf === 'payment_succeeded' || pwf === 'cash_paid' || pwf === 'paid') {
      return true;
    }
    if (b.invoicePaid === true) return true;
    var settled = Number(b.amountPaid || b.paidAmount || 0);
    var due = Number(b.amountDueApproved != null ? b.amountDueApproved : b.balanceDue);
    if (settled > 0 && !(due > 0) && (job === 'completed' || job === 'completed_paid' || /paid|complete/i.test(status))) {
      return true;
    }
    return status === 'Paid' || status === 'Completed' || status === 'Cancelled' || status === 'Canceled'
      || job === 'completed_paid' || job === 'completed' || job === 'cancelled';
  }

  /**
   * One primary action per appointment state — everything else stays secondary
   * so the customer never has to choose between equally loud buttons.
   */
  function primaryActionLabel(b, pay) {
    if (!b) return 'View Details';
    if (appointmentNeedsAttention(b) && !(pay && (pay.canPay || pay.canCreatePayLink))) {
      return 'Review Required Action';
    }
    if (pay && (pay.canPay || pay.canCreatePayLink)) return 'Pay securely';
    var status = String(b.customerStatus || b.status || '');
    if (/pending/i.test(status)) return 'View Request';
    if (/confirm|reschedul/i.test(status)) return 'View Appointment';
    if (/paid/i.test(status)) return 'View Details';
    // No receipt label until receipt authority exists (Slice 3) — a customer must
    // never be offered a receipt action that resolves to nothing.
    if (/complete/i.test(status)) return 'View Details';
    return 'View Details';
  }

  function applyAppointmentFocus(data) {
    if (!data) return;
    state.focusedAppointment = data.focusedAppointment || null;
    if (data.focusError === 'invalid_focus') {
      // Consume opaque focus param after a safe miss — do not keep a bad ref.
      stripAppointmentFocusFromUrl();
      state.appointmentFocusRef = null;
      state.focusedAppointment = null;
      showToast('That appointment link could not be opened.', true);
      return;
    }
    if (state.focusedAppointment) {
      // Sticky selection: never let selectUpcoming()'s default replace the hero.
      // focusedAppointment from the server is intentionally sparse (ref + status) —
      // resolve the full booking from upcoming/bookings so the hero keeps vehicles.
      var retainedRef = state.focusedAppointment.appointmentPublicRef
        || state.appointmentFocusRef
        || null;
      if (retainedRef) state.appointmentFocusRef = retainedRef;
      function matchesFocusRef(row) {
        if (!row || !retainedRef) return false;
        var ref = String(retainedRef);
        return String(row.appointmentPublicRef || '') === ref
          || String(row.id || '') === ref
          || String(row.bookingId || '') === ref;
      }
      var full = null;
      if (matchesFocusRef(data.upcoming)) full = data.upcoming;
      else if (Array.isArray(state.bookings)) {
        full = state.bookings.find(matchesFocusRef) || null;
      }
      if (full) state.booking = full;
      // Strip from the address bar only. Keep the opaque ref in memory so soft
      // reloads / polling cannot replace this appointment with selectUpcoming().
      stripAppointmentFocusFromUrl();
      return;
    }
    if (state.appointmentFocusRef && Array.isArray(state.bookings) && state.bookings.length) {
      var ref = String(state.appointmentFocusRef);
      var match = state.bookings.find(function (row) {
        if (!row) return false;
        return String(row.appointmentPublicRef || '') === ref
          || String(row.id || '') === ref
          || String(row.bookingId || '') === ref;
      });
      if (match) {
        state.booking = match;
        return;
      }
    }
    if (data.upcoming) state.booking = data.upcoming;
  }

  function highlightFocusedAppointment() {
    var hero = $('upcoming-panel');
    if (!hero) return;
    var card = hero.querySelector('.card');
    if (!card) return;
    if (state.focusedAppointment) {
      card.classList.add('appointment-focus');
      try {
        card.setAttribute('tabindex', '-1');
        card.focus({ preventScroll: true });
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { /* ignore */ }
    } else {
      card.classList.remove('appointment-focus');
    }
  }

  function isTemporarilyUnavailableResponse(r) {
    if (!r) return false;
    if (r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500) return true;
    var err = r.data && r.data.error;
    return err === 'temporarily_unavailable'
      || err === 'service_unavailable'
      || err === 'rate_limited'
      || err === 'timeout';
  }

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

  function bookingVehiclesForActions() {
    var b = state.booking || {};
    if (b.service && Array.isArray(b.service.vehicles) && b.service.vehicles.length) {
      return b.service.vehicles;
    }
    return Array.isArray(b.vehicles) ? b.vehicles : [];
  }

  function selectedAddonVehicle() {
    var vehicles = bookingVehiclesForActions();
    if (!vehicles.length) return null;
    if (vehicles.length === 1) return vehicles[0];
    return vehicles.find(function (v) {
      return String(v.vehicleId || '') === String(packageModalVehicleId || '');
    }) || null;
  }

  function currentBookingAddonIds() {
    var b = state.booking || {};
    var vehicle = selectedAddonVehicle();
    var ids = vehicle && Array.isArray(vehicle.addOnIds) ? vehicle.addOnIds : [];
    if (ids.length) return ids.map(function (id) { return String(id || '').trim(); }).filter(Boolean);
    var list = vehicle && Array.isArray(vehicle.addons)
      ? vehicle.addons
      : (Array.isArray(b.addons) ? b.addons : []);
    return list.map(function (a) { return String(a.id || '').trim(); }).filter(Boolean);
  }

  function addonsForBookingCategory() {
    var cat = getCatalog();
    var vehicle = selectedAddonVehicle();
    var key = normalizePackageCategory(
      (vehicle && (vehicle.category || vehicle.cat))
        || (state.booking && (state.booking.vehicleCategory || state.booking.cat))
        || 'cars'
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
    if (err === 'duplicate_vehicle') {
      return (data && data.message)
        || 'This booking already has a vehicle with the same size and service. Edit that vehicle instead of adding another identical one.';
    }
    if (err === 'duplicate_pending_request') {
      return (data && data.message)
        || 'A request for this change is already pending review.';
    }
    if (err === 'settled_addon_remove_denied') {
      return 'Paid add-ons cannot be removed online.';
    }
    if (err === 'invoice_paid') {
      return (data && data.message) || 'This change is not available after payment.';
    }
    return (data && data.message) || 'Unable to update add-ons. Call/text 551-313-2956.';
  }

  function mapPackageErrorMessage(data, status) {
    var err = (data && data.error) || '';
    if (status === 429 || err === 'too_many_requests') {
      return 'Too many requests. Wait a moment and try again — your session is still active.';
    }
    if (status >= 500 || err === 'service_unavailable' || err === 'postgres_payment_disabled') {
      return 'Temporary server error. Try again shortly — your session is still active.';
    }
    if (err === 'version_conflict') {
      return 'This booking changed. Reloading the latest package options — review and try again if needed.';
    }
    if (err === 'settled_package_change_denied') {
      return 'Package changes are unavailable after any payment has been recorded.';
    }
    if (err === 'invoice_paid') {
      return (data && data.message)
        || 'Package changes are unavailable after any payment has been recorded.';
    }
    if (err === 'vehicle_target_required') {
      return 'Select which vehicle this package change applies to.';
    }
    if (err === 'unknown_package_id') {
      return 'That package is not available for this vehicle.';
    }
    if (err === 'invalid_pricing') {
      return 'Selected package could not be priced with your current add-ons. Your package and add-ons were not changed.';
    }
    if (err === 'package_unchanged') {
      return 'That package is already on your booking — no change needed.';
    }
    if (err === 'request_pending' || err === 'mutation_pending') {
      return 'A package change is already in progress. Wait for it to finish, then try again.';
    }
    return (data && data.message) || 'Unable to change package. Call/text 551-313-2956.';
  }

  function packageChangeUnavailableReason() {
    var pending = (state.changeRequests || []).some(function (r) {
      if (r.requestType !== 'package_change_request') return false;
      var s = String(r.status || '').toLowerCase();
      return s === 'pending' || s === 'pending_approval' || s === 'needs_clarification' || s === 'awaiting_admin';
    });
    if (pending) {
      return 'A package change request is already pending. Wait for it to finish before submitting another.';
    }
    return '';
  }

  function getPackageCatalog() {
    return state.packageCatalog || { source: '', vehicles: [], packageCatalogByVehicle: {} };
  }

  function packageVehicles() {
    var cat = getPackageCatalog();
    return Array.isArray(cat.vehicles) ? cat.vehicles : [];
  }

  function selectedPackageVehicle() {
    var list = packageVehicles();
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    var id = packageModalVehicleId || '';
    return list.find(function (v) { return v.vehicleId === id; }) || null;
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

  /**
   * True when the label already states this length, so we never render the
   * duplicated "22 ft · 22 ft". Digit boundaries keep a model number like
   * "222S" from matching a 22 ft boat.
   */
  function labelStatesLength(label, len) {
    if (!len) return false;
    return new RegExp('(^|[^0-9.])' + len + "\\s*(ft\\b|ft\\.|feet\\b|')", 'i').test(String(label || ''));
  }

  /** Append a dimension only when the label does not already carry it. */
  function withDimensions(label, cat, length) {
    var out = String(label || '');
    if (cat && out.toLowerCase().indexOf(String(cat).toLowerCase()) === -1) out += ' · ' + cat;
    if (length > 0 && !labelStatesLength(out, length)) out += ' · ' + length + ' ft';
    return out;
  }

  function vehicleLine(b) {
    if (!b) return '—';
    var parts = [b.vehicleYear, b.vehicleMake, b.vehicleModel].filter(Boolean).join(' ');
    var length = Number(b.vehicleLengthFt || b.lengthFt || 0);
    var cat = b.vehicleCategory || '';
    if (parts) return withDimensions(parts, cat, length);
    return withDimensions(b.vehicleLabel || b.vehicle || '—', '', length);
  }

  /** True when booking.vehicles[] is usable for per-vehicle itemization. */
  function hasUsableVehicleProjection(b) {
    if (!b || !Array.isArray(b.vehicles) || !b.vehicles.length) return false;
    return b.vehicles.some(function (v) {
      if (!v || typeof v !== 'object') return false;
      return !!(v.vehicleId || v.vehicleLabel || v.pkgName || v.packageName
        || v.packageId || v.pkgId || v.year || v.make || v.model
        || v.category || v.cat || v.subtotal != null || v.basePrice != null);
    });
  }

  function projectedVehicleLabel(v) {
    if (!v) return 'Vehicle';
    var parts = [v.year, v.make, v.model].filter(Boolean).join(' ');
    var length = Number(v.lengthFt || 0);
    var cat = v.category || v.cat || '';
    if (parts) return withDimensions(parts, cat, length);
    var label = v.vehicleLabel || 'Vehicle';
    return withDimensions(label, label === 'Vehicle' ? cat : '', length);
  }

  function safeMoneyOrNull(n) {
    var v = Number(n);
    return Number.isFinite(v) ? v : null;
  }

  /**
   * Itemized per-vehicle breakdown from server projection only.
   * Formats server dollars; does not consult the client pricing catalog.
   */
  function pendingRemovalForVehicle(vehicleId) {
    var vid = String(vehicleId || '');
    if (!vid) return null;
    return (state.changeRequests || []).find(function (r) {
      if ((r.requestType || r.type) !== 'vehicle_remove_request') return false;
      var st = String(r.status || '').toLowerCase();
      if (st !== 'pending' && st !== 'pending_approval' && st !== 'needs_clarification' && st !== 'awaiting_admin') {
        return false;
      }
      var targetId = (r.target && r.target.vehicleId)
        || (r.requestedState && r.requestedState.target && r.requestedState.target.vehicleId)
        || (r.requestedState && r.requestedState.vehicleSnapshot && r.requestedState.vehicleSnapshot.vehicleId)
        || '';
      return String(targetId) === vid;
    }) || null;
  }

  function renderPackageDetailsPanel(v, panelId) {
    var details = v.packageDetails || null;
    var packName = (details && details.name) || v.pkgName || v.packageName || 'Package';
    if (!details || details.available === false) {
      var msg = (details && details.unavailableMessage)
        || 'Package details are unavailable for this older booking. Contact us if you need clarification.';
      return '<div id="' + esc(panelId) + '" class="package-details-panel" hidden>' +
        '<p class="package-details-unavailable">' + esc(msg) + '</p>' +
        '</div>';
    }
    var included = Array.isArray(details.includedServices) ? details.includedServices : [];
    var includedHtml = included.length
      ? '<ul class="package-details-list">' + included.map(function (s) {
        return '<li>' + esc(s) + '</li>';
      }).join('') + '</ul>'
      : '<p class="hint">No itemized inclusion list is on file for this package.</p>';
    var addons = Array.isArray(details.addons) ? details.addons : [];
    var addonHtml;
    if (!addons.length) {
      addonHtml = '<p class="hint">None</p>';
    } else {
      addonHtml = '<ul class="package-details-list">' + addons.map(function (a) {
        var priceBit = a.price != null && Number.isFinite(Number(a.price))
          ? ' · ' + fmtMoney(a.price) : '';
        var qtyBit = Number(a.qty) > 1 ? ' × ' + Number(a.qty) : '';
        return '<li>' + esc(a.name || 'Add-on') + qtyBit + priceBit + '</li>';
      }).join('') + '</ul>';
    }
    var pkgPrice = details.packagePrice != null ? details.packagePrice
      : (v.basePrice != null ? v.basePrice : v.packagePrice);
    var sub = details.vehicleSubtotal != null ? details.vehicleSubtotal : v.subtotal;
    return '<div id="' + esc(panelId) + '" class="package-details-panel" hidden>' +
      '<p class="package-details-name">' + esc(packName) + '</p>' +
      (details.description
        ? '<p class="package-details-desc">' + esc(details.description) + '</p>' : '') +
      '<h4 class="package-details-h">What\'s included</h4>' + includedHtml +
      (function () {
        var limits = Array.isArray(details.limitations)
          ? details.limitations
          : (details.limitations ? [String(details.limitations)] : []);
        if (!limits.length) return '';
        return '<h4 class="package-details-h">Important details</h4><ul class="package-details-list">' +
          limits.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
          '</ul>';
      }()) +
      '<h4 class="package-details-h">Selected add-ons</h4>' + addonHtml +
      (pkgPrice != null
        ? '<p class="package-details-money"><span>Package price</span><strong>' + fmtMoney(pkgPrice) + '</strong></p>'
        : '') +
      (sub != null
        ? '<p class="package-details-money"><span>Vehicle subtotal</span><strong>' + fmtMoney(sub) + '</strong></p>'
        : '') +
      '</div>';
  }

  function renderVehicleActionsHtml(b, v, idx) {
    var vehicleId = String(v.vehicleId || '');
    var label = projectedVehicleLabel(v);
    var pending = pendingRemovalForVehicle(vehicleId);
    var vehicleCount = (b.vehicles || []).length;
    var actions = [];
    actions.push(
      '<button type="button" class="btn ghost sm vehicle-action" data-action="package_change_request" data-vehicle-id="' +
      esc(vehicleId) + '" data-vehicle-label="' + esc(label) + '">Change package</button>'
    );
    actions.push(
      '<button type="button" class="btn ghost sm vehicle-action" data-action="addon_request" data-vehicle-id="' +
      esc(vehicleId) + '" data-vehicle-label="' + esc(label) + '">Manage add-ons</button>'
    );
    actions.push(
      '<button type="button" class="btn ghost sm vehicle-action" data-action="vehicle_replace_request" data-vehicle-id="' +
      esc(vehicleId) + '" data-vehicle-label="' + esc(label) + '">Edit / replace vehicle</button>'
    );
    if (pending) {
      actions.push(
        '<span class="vehicle-removal-pending" role="status">Removal requested — Pending review</span>'
      );
    } else if (vehicleCount <= 1) {
      actions.push(
        '<button type="button" class="btn ghost sm vehicle-action" data-action="vehicle_remove_request" data-vehicle-id="' +
        esc(vehicleId) + '" data-vehicle-label="' + esc(label) +
        '" data-last-vehicle="1">Request vehicle removal</button>'
      );
    } else {
      actions.push(
        '<button type="button" class="btn ghost sm vehicle-action" data-action="vehicle_remove_request" data-vehicle-id="' +
        esc(vehicleId) + '" data-vehicle-label="' + esc(label) +
        '" data-subtotal="' + esc(String(v.subtotal != null ? v.subtotal : '')) +
        '">Request vehicle removal</button>'
      );
    }
    return '<div class="vehicle-actions" aria-label="Actions for ' + esc(label) + '">' +
      actions.join('') + '</div>';
  }

  function renderVehicleBreakdownHtml(b) {
    if (!hasUsableVehicleProjection(b)) return '';
    return b.vehicles.map(function (v, idx) {
      var label = projectedVehicleLabel(v);
      var packName = v.pkgName || v.packageName || 'Package';
      var base = safeMoneyOrNull(v.basePrice != null ? v.basePrice : v.packagePrice);
      var sub = safeMoneyOrNull(v.subtotal);
      var addons = Array.isArray(v.addons) ? v.addons : [];
      var vehicleId = String(v.vehicleId || ('idx-' + idx));
      var panelId = 'pkg-details-' + String(b.id || 'booking').replace(/[^\w-]/g, '') + '-' +
        vehicleId.replace(/[^\w-]/g, '');
      var addonBlock;
      if (!addons.length) {
        addonBlock = '<div><dt>Add-ons</dt><dd>None</dd></div>';
      } else {
        addonBlock = '<div><dt>Add-ons</dt><dd><ul class="vehicle-addon-list">' +
          addons.map(function (a) {
            var name = a.name || a.id || 'Add-on';
            var qty = Number(a.qty) > 0 ? Number(a.qty) : 1;
            var price = safeMoneyOrNull(a.price);
            var qtyBit = qty > 1 ? ' × ' + qty : '';
            var priceBit = price != null ? ' · ' + fmtMoney(price) : '';
            return '<li>' + esc(name) + qtyBit + priceBit + '</li>';
          }).join('') +
          '</ul></dd></div>';
      }
      return '<section class="vehicle-breakdown" data-vehicle-id="' + esc(vehicleId) +
        '" aria-label="' + esc('Vehicle ' + (idx + 1) + ': ' + label) + '">' +
        '<h3 class="vehicle-breakdown-title">' + esc(label) + '</h3>' +
        '<dl class="meta-grid">' +
        '<div class="package-row"><dt>Package</dt><dd>' +
          '<span class="package-name-text">' + esc(packName) + '</span> ' +
          '<button type="button" class="btn ghost sm package-details-toggle" ' +
          'aria-expanded="false" aria-controls="' + esc(panelId) + '" ' +
          'data-panel="' + esc(panelId) + '">' +
          '<span class="package-toggle-label">View services</span> ▾</button>' +
        '</dd></div>' +
        (base != null ? '<div><dt>Package price</dt><dd>' + fmtMoney(base) + '</dd></div>' : '') +
        addonBlock +
        (sub != null ? '<div><dt>Vehicle subtotal</dt><dd>' + fmtMoney(sub) + '</dd></div>' : '') +
        '</dl>' +
        renderPackageDetailsPanel(v, panelId) +
        renderVehicleActionsHtml(b, v, idx) +
        '</section>';
    }).join('');
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

  function retryAfterMs(res, data) {
    var fromBody = Number(data && data.retryAfterSec);
    if (Number.isFinite(fromBody) && fromBody > 0) return Math.round(fromBody * 1000);
    var raw = res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('Retry-After')
      : '';
    var seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  }

  async function post(fn, body, opts) {
    opts = opts || {};
    var res = await fetch(API + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body || {}),
      signal: opts.signal || undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401 && isAuthenticatedPortalCall(fn, body)) {
      clearAuthenticatedCustomerState({ reason: 'http_401' });
    }
    return {
      ok: res.ok,
      status: res.status,
      data: data,
      retryAfterMs: retryAfterMs(res, data),
    };
  }

  function isAuthenticatedPortalCall(fn, body) {
    if (fn === 'customer-portal-profile') return true;
    if (fn === 'customer-portal-data' && body && String(body.mode || '').toLowerCase() === 'account') return true;
    if (fn === 'customer-portal-auth' && body && String(body.action || '') === 'session') return false;
    if (fn === 'customer-portal-auth' && body && String(body.action || '') === 'logout') return false;
    return false;
  }

  /**
   * Immediately clear rendered authenticated customer/profile/address/booking
   * state. Does not clear unrelated public booking lookup form values unless
   * switchToLogin is true (logout path).
   */
  function clearAuthenticatedCustomerState(opts) {
    opts = opts || {};
    profileEditing = false;
    addressEditingId = null;
    profileAddressBusy = false;
    closeModalQuiet();
    state.scope = null;
    state.booking = null;
    state.bookings = [];
    state.session = false;
    state.customer = null;
    state.accountVersion = null;
    state.catalog = null;
    state.packageCatalog = null;
    state.changeRequests = [];
    state.payment = null;
    state.postService = null;
    state.postServiceByBooking = null;
    state.priceAdjustments = null;
    state.actionToken = null;
    state.appointmentFocusRef = null;
    state.focusedAppointment = null;
    state.syncVersion = '';
    state.serverTime = null;
    if (portalRefresh) portalRefresh.stopPolling();
    if (opts.clearLookup !== false) {
      state.verifyPhone = '';
      state.verifyBookingId = '';
    }
    clearProfileAddressDom();
    // Hydration shell owns visibility during boot/error phases.
    if (!isBlockingPortalPhase(portalHydration.phase) && !isErrorPortalPhase(portalHydration.phase)) {
      show($('pre-auth'), true);
      show($('post-auth'), false);
    } else {
      show($('post-auth'), false);
    }
    var upcoming = $('upcoming-panel');
    if (upcoming) upcoming.innerHTML = '';
    var appts = $('appointments-list');
    if (appts) appts.innerHTML = '';
    var hist = $('history-list');
    if (hist) hist.innerHTML = '';
    var payPanel = $('payments-panel');
    if (payPanel) payPanel.innerHTML = '';
    show($('profile-section'), false);
    show($('addresses-section'), false);
  }

  function clearProfileAddressDom() {
    var pv = $('profile-view');
    if (pv) pv.innerHTML = '';
    var pe = $('profile-edit');
    if (pe) {
      pe.hidden = true;
      pe.reset && pe.reset();
    }
    show($('profile-actions'), true);
    setMsg($('profile-msg'), '', false);
    var al = $('addresses-list');
    if (al) al.innerHTML = '';
    var af = $('address-form');
    if (af) {
      af.hidden = true;
      af.reset && af.reset();
    }
    show($('address-actions'), true);
    setMsg($('address-msg'), '', false);
  }

  function closeModalQuiet() {
    try {
      var modal = $('action-modal');
      if (modal) {
        modal.hidden = true;
        modal.style.display = 'none';
      }
      mutationPending = false;
    } catch (e) { /* ignore */ }
  }

  function applyCustomerProjection(customer) {
    if (!customer) {
      state.customer = null;
      state.accountVersion = null;
      return;
    }
    state.customer = customer;
    state.accountVersion = customer.accountVersion != null ? customer.accountVersion : state.accountVersion;
  }

  function applyPortalPayload(data) {
    state.catalog = data.catalog || state.catalog || null;
    state.packageCatalog = data.packageCatalog || null;
    state.changeRequests = data.changeRequests || [];
    state.payment = data.payment || null;
    state.postService = data.postService || null;
    state.postServiceByBooking = data.postServiceByBooking || null;
    state.priceAdjustments = data.priceAdjustments || null;
    if (data.syncVersion) state.syncVersion = data.syncVersion;
    if (data.serverTime) state.serverTime = data.serverTime;
    if (data.customer) applyCustomerProjection(data.customer);
  }

  function applyCanonicalBookingProjection(booking) {
    if (!booking || !booking.id) return false;
    state.booking = booking;
    var found = false;
    state.bookings = (state.bookings || []).map(function (item) {
      if (String(item && item.id) !== String(booking.id)) return item;
      found = true;
      return booking;
    });
    if (!found) state.bookings.push(booking);
    renderDashboard({ payment: state.payment || {} });
    return true;
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
        portalLastLoadOutcome = { ok: true, status: ar.status, notModified: false };
        state.booking = ar.data.booking;
        applyPortalPayload(ar.data);
        renderDashboard({ payment: ar.data.payment || { canPay: ar.data.labels && ar.data.labels.canPay } });
        if (portalRefresh) portalRefresh.startPolling();
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
    var requestBody = { mode: 'limited', bookingId: id, phone: phone };
    if (!opts.fromForm && state.syncVersion) requestBody.ifSyncVersion = state.syncVersion;
    var r = await post('customer-portal-data', requestBody, { signal: opts.signal });
    portalLastLoadOutcome = {
      ok: !!(r.ok && r.data && r.data.ok),
      status: r.status,
      retryAfterMs: r.retryAfterMs,
      error: r.data && r.data.error,
      notModified: !!(r.data && r.data.notModified),
    };
    if (r.ok && r.data && r.data.notModified) {
      if (r.data.syncVersion) state.syncVersion = r.data.syncVersion;
      if (r.data.serverTime) state.serverTime = r.data.serverTime;
      if (portalRefresh) portalRefresh.startPolling();
      return true;
    }
    if (!r.data || !r.data.ok) {
      var errCode = (r.data && r.data.error) || '';
      var errMsg = (r.data && r.data.message) || '';
      // Rate limiting is transient and not a credentials/existence problem —
      // never mislabel it as "not found" and never clear the customer's
      // session over it (that was forcing a real re-login after a burst of
      // legitimate polling, e.g. right after paying).
      if (r.status === 429 || errCode === 'rate_limited') {
        showToast('Updates are temporarily slowed — your current appointment remains available.', true);
        return false;
      }
      if (isTemporarilyUnavailableResponse(r)) {
        var transientMsg = 'Could not refresh right now. Showing your last update and retrying automatically.';
        if (opts.fromForm) setMsg($('lk-error'), transientMsg, true);
        else showToast(transientMsg, true);
        return false;
      }
      if (!errMsg) {
        if (errCode === 'authentication_failed') errMsg = 'Phone does not match this booking.';
        else if (errCode === 'booking_not_ready') errMsg = 'Booking is not ready in your portal yet.';
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
    if (portalRefresh) portalRefresh.startPolling();
    return true;
  }

  async function loadAccount(opts) {
    opts = opts || {};
    var generation = opts.generation != null ? opts.generation : portalHydration.generation;
    portalHydration.lastError = null;
    var payload = { mode: 'account' };
    var focusRef = opts.appointmentFocusRef || state.appointmentFocusRef;
    if (focusRef) payload.appointment = focusRef;
    if (state.syncVersion) payload.ifSyncVersion = state.syncVersion;
    var r = await post('customer-portal-data', payload, { signal: opts.signal });
    portalLastLoadOutcome = {
      ok: !!(r.ok && r.data && r.data.ok),
      status: r.status,
      retryAfterMs: r.retryAfterMs,
      error: r.data && r.data.error,
      notModified: !!(r.data && r.data.notModified),
    };
    if (generation !== portalHydration.generation) return false;
    if (r.ok && r.data && r.data.notModified) {
      if (r.data.syncVersion) state.syncVersion = r.data.syncVersion;
      if (r.data.serverTime) state.serverTime = r.data.serverTime;
      if (portalRefresh) portalRefresh.startPolling();
      return true;
    }
    if (r.status === 401) {
      clearAuthenticatedCustomerState({ reason: 'http_401' });
      portalHydration.lastError = 'authentication_failed';
      return false;
    }
    if (isTemporarilyUnavailableResponse(r)) {
      portalHydration.lastError = 'temporarily_unavailable';
      return false;
    }
    if (!r.data || !r.data.ok) {
      portalHydration.lastError = (r.data && r.data.error) || 'load_failed';
      return false;
    }
    state.scope = 'account';
    state.session = true;
    state.bookings = r.data.bookings || [];
    // Apply sticky focus before falling back to server selectUpcoming().
    applyAppointmentFocus(r.data);
    if (!state.booking) {
      state.booking = r.data.upcoming || state.bookings[0] || null;
    }
    applyPortalPayload(r.data);
    renderDashboard(r.data);
    highlightFocusedAppointment();
    if (opts.managePhase !== false && portalHydration.phase !== PORTAL_PHASE.READY
      && !isBlockingPortalPhase(portalHydration.phase)
      && !isErrorPortalPhase(portalHydration.phase)) {
      // Non-boot reloads (profile/address mutations) keep the dashboard visible.
      show($('pre-auth'), false);
      show($('post-auth'), true);
    }
    if (portalRefresh) portalRefresh.startPolling();
    return true;
  }

  /**
   * Session + account hydration for boot/retry. Never replays magic-link tokens.
   */
  async function hydrateAuthenticatedPortal(opts) {
    opts = opts || {};
    if (portalHydration.inFlight && opts.force !== true) return false;
    portalHydration.generation += 1;
    var generation = portalHydration.generation;
    portalHydration.inFlight = true;
    portalHydration.lastError = null;

    var initialPhase = opts.phase || PORTAL_PHASE.LOADING_PORTAL;
    var initialMessage = opts.message || defaultMessageForPhase(initialPhase);
    setPortalPhase(initialPhase, { message: initialMessage });

    try {
      var authed = await checkSession();
      if (generation !== portalHydration.generation) return false;
      if (!authed) {
        if (opts.allowIdle !== false) {
          setPortalPhase(PORTAL_PHASE.IDLE);
        } else {
          clearPortalHydrationTimers();
          portalHydration.inFlight = false;
        }
        return false;
      }

      // Keep the same wall-clock timeout across session → garage load.
      setPortalPhase(PORTAL_PHASE.LOADING_PORTAL, {
        message: 'Loading your garage...',
        restartTimers: false,
      });

      var ok = await loadAccount({
        generation: generation,
        managePhase: false,
        appointmentFocusRef: state.appointmentFocusRef || null,
      });
      if (generation !== portalHydration.generation) return false;
      if (ok) {
        setPortalPhase(PORTAL_PHASE.READY);
        return true;
      }
      if (portalHydration.lastError === 'temporarily_unavailable') {
        setPortalPhase(PORTAL_PHASE.TEMPORARILY_UNAVAILABLE);
      } else if (portalHydration.lastError === 'authentication_failed') {
        setPortalPhase(PORTAL_PHASE.IDLE);
      } else {
        setPortalPhase(PORTAL_PHASE.FAILED);
      }
      return false;
    } catch (e) {
      if (generation !== portalHydration.generation) return false;
      portalHydration.lastError = 'load_failed';
      setPortalPhase(PORTAL_PHASE.FAILED);
      return false;
    } finally {
      if (generation === portalHydration.generation) {
        portalHydration.inFlight = false;
      }
    }
  }

  async function retryPortalHydration() {
    if (portalHydration.inFlight) return false;
    // Snapshot pending magic before hydrate bumps generation / clears timers.
    var pending = portalHydration.pendingMagic;

    var ok = await hydrateAuthenticatedPortal({
      force: true,
      phase: PORTAL_PHASE.LOADING_PORTAL,
      message: 'Loading your garage...',
      allowIdle: false,
    });
    if (ok) return true;
    if (isErrorPortalPhase(portalHydration.phase)) return false;

    // If verify never established a session (timeout/network before consume),
    // retry the in-memory magic link once — never from the URL.
    if (pending && pending.challengeId && pending.token && !portalHydration.magicLinkConsumed) {
      return verifyMagicLink(pending.challengeId, pending.token);
    }

    if (portalHydration.phase !== PORTAL_PHASE.READY) {
      setPortalPhase(PORTAL_PHASE.IDLE);
    }
    return false;
  }

  function returnToPortalSignIn() {
    portalHydration.generation += 1;
    portalHydration.inFlight = false;
    portalHydration.lastError = null;
    portalHydration.pendingMagic = null;
    clearPortalHydrationTimers();
    stripMagicLinkParamsFromUrl();
    setPortalPhase(PORTAL_PHASE.IDLE);
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
    portalHydration.generation += 1;
    var generation = portalHydration.generation;
    portalHydration.inFlight = true;
    portalHydration.lastError = null;
    // Keep credentials in memory until verify settles; strip from URL immediately.
    portalHydration.pendingMagic = { challengeId: String(challengeId || ''), token: String(token || '') };
    portalHydration.magicLinkConsumed = false;
    setPortalPhase(PORTAL_PHASE.VALIDATING_LINK, { message: 'Signing you in...' });
    stripMagicLinkParamsFromUrl();

    var r;
    try {
      r = await post('customer-portal-auth', {
        action: 'verify',
        challengeId: challengeId,
        token: token,
      });
    } catch (e) {
      if (generation !== portalHydration.generation) return false;
      portalHydration.inFlight = false;
      portalHydration.lastError = 'load_failed';
      setPortalPhase(PORTAL_PHASE.FAILED);
      return false;
    }
    if (generation !== portalHydration.generation) return false;

    if (isTemporarilyUnavailableResponse(r)) {
      portalHydration.lastError = 'temporarily_unavailable';
      setPortalPhase(PORTAL_PHASE.TEMPORARILY_UNAVAILABLE);
      return false;
    }

    if (r.data && r.data.ok) {
      // Token consumed server-side — do not replay on retry.
      portalHydration.magicLinkConsumed = true;
      portalHydration.pendingMagic = null;
      if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.authSucceeded();
      setPortalPhase(PORTAL_PHASE.ESTABLISHING_SESSION, {
        message: 'Signing you in...',
        restartTimers: false,
      });
      setPortalPhase(PORTAL_PHASE.LOADING_PORTAL, {
        message: 'Loading your garage...',
        restartTimers: false,
      });
      var ok = await loadAccount({
        generation: generation,
        managePhase: false,
        appointmentFocusRef: state.appointmentFocusRef || null,
      });
      if (generation !== portalHydration.generation) return false;
      if (ok) {
        setPortalPhase(PORTAL_PHASE.READY);
        return true;
      }
      if (portalHydration.lastError === 'temporarily_unavailable') {
        setPortalPhase(PORTAL_PHASE.TEMPORARILY_UNAVAILABLE);
      } else if (portalHydration.lastError === 'authentication_failed') {
        setPortalPhase(PORTAL_PHASE.IDLE);
        setMsg($('acct-error'), 'Your session could not be established. Request a new sign-in link.', true);
      } else {
        setPortalPhase(PORTAL_PHASE.FAILED);
      }
      return false;
    }

    // Definitive auth failure — drop pending token so retry does not hammer a dead link.
    portalHydration.pendingMagic = null;
    portalHydration.inFlight = false;
    setPortalPhase(PORTAL_PHASE.IDLE);
    var failMsg = (r.data && r.data.message) || 'This link is invalid or expired.';
    if (/token|challenge|stack|ECONN|prisma/i.test(String(failMsg))) {
      failMsg = 'This link is invalid or expired.';
    }
    setMsg($('acct-error'), failMsg, true);
    return false;
  }

  function clearLookupCredentials() {
    state.verifyPhone = '';
    state.verifyBookingId = '';
    state.actionToken = null;
    state.syncVersion = '';
    state.serverTime = null;
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
    try {
      await post('customer-portal-auth', { action: 'logout' });
    } catch (e) { /* still clear local state */ }
    portalHydration.generation += 1;
    portalHydration.inFlight = false;
    clearPortalHydrationTimers();
    clearAuthenticatedCustomerState({ reason: 'logout', clearLookup: true });
    clearLookupCredentials();
    try {
      var clean = 'my-garage.html';
      if (global.location.search || global.location.hash) {
        history.replaceState({}, '', clean);
      }
    } catch (e) { /* ignore */ }
    setPortalPhase(PORTAL_PHASE.IDLE);
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
    // Paid catalog/vehicle changes remain available as Admin-reviewed requests.
    var moneyActionsLockedWhenPaid = {
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
      var lock = !!paid;
      btn.disabled = !!lock;
      btn.classList.toggle('is-disabled', !!lock);
      btn.title = paid ? 'Maintenance plan changes require direct support after payment.' : '';
    });
  }

  /**
   * Portal Lite: there is exactly one primary payment action per viewport —
   * the inline "Pay securely" button in Payment & Receipts on desktop, and the
   * sticky bar on phones. Both call the same startPayBalance() controller, so
   * this only decides which one is on screen and what it says.
   */
  function syncPayBalanceButton(pay) {
    var due = Number(pay.amountDueApproved || 0);
    var can = !!(pay.canPay || pay.canCreatePayLink) && due > 0;
    syncStickyPayBar(can, due);
    syncMoneyActionButtons(pay);
  }

  /** Mobile-only affordance so a due balance is always one tap away. */
  function syncStickyPayBar(canPay, due) {
    var bar = $('pay-sticky-bar');
    var btn = $('pay-sticky-btn');
    if (!bar || !btn) return;
    var on = !!canPay;
    bar.hidden = !on;
    if (btn) btn.textContent = payCtaLabel(on, due);
    try {
      document.body.classList.toggle('pay-sticky-on', on);
    } catch (e) { /* ignore */ }
  }

  /** Single source of truth for what the one payment CTA says. */
  function payCtaLabel(can, due) {
    if (embeddedPay && embeddedPay.starting) return 'Processing payment…';
    if (!can) return 'Pay securely';
    return due > 0 ? 'Pay securely · ' + fmtMoney(due) : 'Pay securely';
  }

  function renderPaymentsPanel(pay) {
    var panel = $('payments-panel');
    var empty = $('payments-empty');
    if (!panel) return;
    var due = Number(pay.amountDueApproved || 0);
    var can = !!(pay.canPay || pay.canCreatePayLink) && due > 0;
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
        ? '<button type="button" class="btn primary" id="btn-pay-balance">' +
          esc(payCtaLabel(true, due)) + '</button>' +
          '<p class="hint">Secure Stripe payment (card only). After payment your invoice closes automatically.</p>'
        : (paid
          ? '<p class="pay-settled" data-pay-settled><strong>Paid</strong></p>' +
            '<p class="hint">Invoice paid. You can still add services — any new balance appears here. Package and vehicle changes stay closed.</p>'
          : '<p class="hint">No balance is due yet, or payment is locked until admin approval.</p>')) +
      receiptActionsHtml(pay) +
      '</div>';
    var btn = $('btn-pay-balance');
    if (btn) btn.addEventListener('click', startPayBalance);
  }

  /** True once the appointment is completed through the established status authority. */
  function serviceIsCompleted(b) {
    if (!b) return false;
    if (b.completedAt) return true;
    var key = String(b.customerStatusKey || '').toLowerCase();
    if (key === 'completed' || key === 'completed_paid') return true;
    return /complete/i.test(String(b.customerStatus || b.jobStatus || b.status || ''));
  }

  /**
   * Receipt actions mirror the server's eligibility rules so the customer is
   * never offered a receipt that does not exist. The server re-derives and
   * enforces eligibility and ownership — this only decides what to show.
   */
  function receiptActionsHtml(pay) {
    var b = state.booking;
    if (!b || !b.id) return '';
    var settled = settledCentsFromPayment(pay);
    if (!(settled > 0)) return '';

    var remaining = remainingCentsFromPayment(pay);
    var links = '<a class="btn ghost" data-receipt-link href="receipt.html?bookingId=' +
      encodeURIComponent(b.id) + '&type=payment">View payment receipt</a>';

    if (serviceIsCompleted(b) && remaining === 0) {
      links += '<a class="btn ghost" data-receipt-link href="receipt.html?bookingId=' +
        encodeURIComponent(b.id) + '&type=final">View final receipt</a>';
    }
    return '<div class="actions receipt-actions" style="margin-top:12px">' + links + '</div>';
  }

  function renderMaintenancePlans() {
    var empty = $('maintenance-empty');
    var list = $('maintenance-list');
    // Portal Lite: the Maintenance Plans module is hidden until it is
    // operational. Skip rendering entirely so it cannot inject a customer-facing
    // "Start a plan" action into a section nobody can see.
    var section = $('maintenance-section');
    if (section && section.hidden) {
      if (list) list.innerHTML = '';
      if (empty) empty.innerHTML = '';
      return;
    }
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
    if (data && data.customer) applyCustomerProjection(data.customer);

    renderProfileAndAddresses();

    if (!hero || !b) {
      if (hero) hero.innerHTML = '<p class="empty">No upcoming appointment. <a href="index.html">Book a service</a>.</p>';
      syncPayBalanceButton({});
      renderPaymentsPanel({});
      renderPendingRequests([]);
      if (state.scope === 'account') {
        renderList('appointments-list', state.bookings || [], function (item) {
          return '<li><strong class="mono">' + esc(item.id || '') + '</strong> — ' +
            esc(item.status || '') + ' · ' + esc(item.preferredDate || '—') +
            ' · ' + esc(item.service || item.package || '') + '</li>';
        });
      }
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
    var vehicleSections = renderVehicleBreakdownHtml(b);
    var legacyVehicleRows = vehicleSections
      ? ''
      : '<div><dt>Vehicle</dt><dd>' + esc(vehicleLine(b)) + '</dd></div>' +
        '<div><dt>Add-ons</dt><dd>' + esc(addonLines(b)) + '</dd></div>';

    var statusLabel = appointmentStatusLabel(b);
    var arrivalLabels = {
      '08:00-11:00': '8:00 AM – 11:00 AM',
      '09:00-12:00': '9:00 AM – 12:00 PM',
      '10:00-13:00': '10:00 AM – 1:00 PM',
      '11:00-14:00': '11:00 AM – 2:00 PM',
      '12:00-15:00': '12:00 PM – 3:00 PM',
      '13:00-16:00': '1:00 PM – 4:00 PM',
      '14:00-17:00': '2:00 PM – 5:00 PM',
      '15:00-18:00': '3:00 PM – 6:00 PM',
      '16:00-19:00': '4:00 PM – 7:00 PM',
      anytime: 'Any time that day — Best availability',
    };
    var confirmedArrival = b.confirmedTimeWindow || b.confirmedTime || '';
    var preferredArrival = b.preferredArrivalWindow
      ? (arrivalLabels[b.preferredArrivalWindow] || b.preferredArrivalWindow)
      : (b.preferredTime || '—');
    var arrivalDisplay = confirmedArrival
      ? confirmedArrival
      : 'Pending confirmation';
    var waterLabels = {
      yes: 'Yes — outdoor faucet or hose connection',
      no: 'No',
      unsure: 'Not sure',
    };
    var electricLabels = {
      yes: 'Yes — standard outlet nearby',
      no: 'No',
      unsure: 'Not sure',
    };
    var flexLabels = {
      exact: 'Exact date only',
      alternate_date: 'Has alternate date',
      within_3_days: 'Flexible within 3 days',
      earliest_after_date: 'First available on or after selected date',
    };
    var flex = b.scheduleFlexibility || 'exact';
    var siteRows = '';
    siteRows += '<div><dt>Preferred date</dt><dd>' + esc(b.preferredDate || '—') + '</dd></div>';
    siteRows += '<div><dt>Preferred arrival window</dt><dd>' + esc(preferredArrival) + '</dd></div>';
    if (b.alternatePreferredDate) {
      siteRows += '<div><dt>Alternate date</dt><dd>' + esc(b.alternatePreferredDate) +
        (b.alternateArrivalWindow ? ' · ' + esc(arrivalLabels[b.alternateArrivalWindow] || b.alternateArrivalWindow) : '') +
        '</dd></div>';
    }
    siteRows += '<div><dt>Confirmed date / window</dt><dd>' + esc(b.confirmedDate || '—') +
      (confirmedArrival ? ' · ' + esc(confirmedArrival) : ' · ' + esc(arrivalDisplay)) + '</dd></div>';
    if (b.waterAvailable) {
      siteRows += '<div><dt>Water</dt><dd>' + esc(waterLabels[b.waterAvailable] || b.waterAvailable) + '</dd></div>';
    }
    if (b.electricityAvailable) {
      siteRows += '<div><dt>Electricity</dt><dd>' + esc(electricLabels[b.electricityAvailable] || b.electricityAvailable) + '</dd></div>';
    }
    if (b.accessNotes) {
      siteRows += '<div><dt>Access notes (legacy)</dt><dd>' + esc(b.accessNotes) + '</dd></div>';
    }
    if (b.notes || b.customerNote) {
      siteRows += '<div><dt>Additional notes</dt><dd>' + esc(b.notes || b.customerNote) + '</dd></div>';
    }
    siteRows += '<div><dt>Date flexibility</dt><dd>' + esc(flexLabels[flex] || flex) + '</dd></div>';
    var focusClass = state.focusedAppointment ? ' appointment-focus' : '';
    hero.innerHTML =
      '<div class="card' + focusClass + '" id="focused-appointment-card">' +
      '<div class="card-kicker">' + esc(statusLabel) +
      (pendingFlag ? ' · Change pending' : '') + '</div>' +
      '<h2 class="card-title">' + esc(b.service || b.package || 'Service') + '</h2>' +
      (packDesc ? '<p class="pack-desc">' + esc(packDesc) + (packDur ? ' · ' + esc(packDur) : '') + '</p>' : '') +
      '<dl class="meta-grid">' +
      '<div><dt>Status</dt><dd>' + esc(statusLabel) + '</dd></div>' +
      '<div><dt>Date</dt><dd>' + esc(b.confirmedDate || b.preferredDate || '—') + '</dd></div>' +
      '<div><dt>Arrival window</dt><dd>' + esc(arrivalDisplay) + '</dd></div>' +
      legacyVehicleRows +
      '<div><dt>Service</dt><dd>' + esc(b.service || b.package || '—') + '</dd></div>' +
      '<div><dt>Location</dt><dd>' + esc(b.address || b.serviceLocation || '—') + '</dd></div>' +
      siteRows +
      (b.assignedTechName ? '<div><dt>Technician</dt><dd>' + esc(b.assignedTechName) + '</dd></div>' : '') +
      (b.travelFeeAmount ? '<div><dt>Travel fee</dt><dd>' + fmtMoney(b.travelFeeAmount) + '</dd></div>' : '') +
      offerHtml +
      '</dl>' +
      vehicleSections +
      '<dl class="meta-grid booking-financial-summary" aria-label="Booking totals">' +
      '<div><dt>Approved total</dt><dd>' + (
        pay.approvedCents != null || pay.approvedTotal != null
          ? fmtCents(approvedCentsFromPayment(pay))
          : fmtMoney(b.approvedFinalAmount != null ? b.approvedFinalAmount : b.totalPrice)
      ) + '</dd></div>' +
      '<div><dt>Paid amount</dt><dd>' + fmtCents(settledCentsFromPayment(pay)) + '</dd></div>' +
      '<div><dt>Remaining balance</dt><dd>' + fmtCents(remainingCentsFromPayment(pay)) + '</dd></div>' +
      '</dl>' +
      // Portal Lite: the appointment header states the balance but carries no
      // payment button — the single primary CTA lives in Payment & Receipts
      // (or the mobile sticky bar), so the customer never sees two.
      ((pay.canPay || pay.canCreatePayLink)
        ? ''
        : '<p class="hint" data-primary-action-label>' + esc(primaryActionLabel(b, pay)) + '</p>') +
      '</div>';

    syncPayBalanceButton(pay);
    renderPaymentsPanel(pay);
    renderPendingRequests(state.changeRequests);
    renderMaintenancePlans();

    // Selection only decides which appointment is expanded above — every owned
    // appointment stays reachable in one of the two collections below.
    var owned = state.bookings.length ? state.bookings : [b];
    var currentId = String(b.id || '');
    var upcoming = owned.filter(function (x) {
      return !appointmentIsPast(x) && String(x.id || '') !== currentId;
    });
    var hist = owned.filter(appointmentIsPast);

    renderList('appointments-list', upcoming, function (item) {
      return appointmentRowHtml(item, { focusable: true });
    });
    renderList('history-list', hist, function (item) {
      return appointmentRowHtml(item, { showTotal: true });
    });
    bindAppointmentRowActions();

    // Portal Lite: an empty list is not a card. Hide the whole section rather
    // than showing an empty-state placeholder the customer cannot act on.
    $('appointments-empty') && show($('appointments-empty'), false);
    $('history-empty') && show($('history-empty'), false);
    $('appointments-section') && show($('appointments-section'), !!upcoming.length);
    $('history-section') && show($('history-section'), !!hist.length);
    $('comm-empty') && show($('comm-empty'), true);
    var approveBtn = $('btn-approve-completion');
    if (approveBtn) show(approveBtn, b.customerApprovalStatus === 'pending' || b.jobStatus === 'completed_pending_payment');
    renderPostServiceActions(b);
  }

  /**
   * Review and service-issue actions are rendered from the server's decision,
   * never from a locally computed deadline — the 48-hour window is measured on
   * server time, so a device with a wrong clock still sees the truth.
   */
  function postServiceFor(booking) {
    var id = String((booking && booking.id) || '');
    if (state.postServiceByBooking && id && state.postServiceByBooking[id]) {
      return state.postServiceByBooking[id];
    }
    return state.postService || null;
  }

  function renderPostServiceActions(booking) {
    var reviewBtn = $('btn-leave-review');
    var issueBtn = $('btn-report-issue');
    var note = $('post-service-note');
    var ps = postServiceFor(booking);

    if (!ps) {
      if (reviewBtn) show(reviewBtn, false);
      if (issueBtn) show(issueBtn, false);
      if (note) show(note, false);
      return;
    }

    if (reviewBtn) show(reviewBtn, !!(ps.review && ps.review.available));
    if (issueBtn) show(issueBtn, !!(ps.serviceIssue && ps.serviceIssue.available));

    if (!note) return;
    var text = '';
    if (ps.serviceIssue && ps.serviceIssue.available) {
      var hrs = Number(ps.serviceIssue.hoursRemaining) || 0;
      text = hrs > 0
        ? 'You have ' + hrs + (hrs === 1 ? ' hour' : ' hours') + ' left to report a service issue online.'
        : 'Less than an hour left to report a service issue online.';
    } else if (ps.serviceIssue && ps.serviceIssue.submitted) {
      text = 'We have your service issue report and will be in touch.';
    } else if (ps.serviceIssue && ps.serviceIssue.closedMessage) {
      text = ps.serviceIssue.closedMessage;
    } else if (ps.review && ps.review.submitted) {
      text = 'Thanks for your review.';
    }
    if (text) { note.textContent = text; show(note, true); }
    else show(note, false);
  }

  function accountVersionForMutation() {
    return (state.customer && state.customer.accountVersion)
      || state.accountVersion
      || null;
  }

  function renderProfileAndAddresses() {
    var accountScope = state.scope === 'account' && !!state.session;
    var profileSection = $('profile-section');
    var addrSection = $('addresses-section');
    if (!accountScope || !state.customer) {
      show(profileSection, false);
      show(addrSection, false);
      return;
    }
    show(profileSection, true);
    show(addrSection, true);
    renderProfileView();
    renderAddressesView();
  }

  function renderProfileView() {
    var c = state.customer || {};
    var p = c.profile || {};
    var view = $('profile-view');
    var edit = $('profile-edit');
    if (!view) return;
    var smsConsent = (Array.isArray(c.consents) ? c.consents : []).find(function (row) {
      return row && row.channel === 'sms_transactional';
    });
    if ($('sms-consent-toggle')) $('sms-consent-toggle').checked = smsConsent && smsConsent.status === 'granted';

    if (profileEditing) {
      show(view, false);
      if (edit) {
        edit.hidden = false;
        $('pf-first') && ($('pf-first').value = p.firstName || '');
        $('pf-last') && ($('pf-last').value = p.lastName || '');
        $('pf-display') && ($('pf-display').value = p.displayName || '');
        $('pf-channel') && ($('pf-channel').value = p.preferredContactChannel || '');
        $('pf-tz') && ($('pf-tz').value = p.timezone || '');
      }
      show($('profile-actions'), false);
      return;
    }

    if (edit) edit.hidden = true;
    show(view, true);
    show($('profile-actions'), true);
    var name = p.displayName || [p.firstName, p.lastName].filter(Boolean).join(' ') || '—';
    view.innerHTML =
      '<dl class="meta-grid">' +
      '<div><dt>Name</dt><dd>' + esc(name) + '</dd></div>' +
      '<div><dt>Email (verified)</dt><dd>' + esc(p.email || '—') + '</dd></div>' +
      '<div><dt>Phone (verified)</dt><dd>' + esc(p.phone || '—') + '</dd></div>' +
      '<div><dt>Preferred contact</dt><dd>' + esc(p.preferredContactChannel || '—') + '</dd></div>' +
      '<div><dt>Timezone</dt><dd>' + esc(p.timezone || '—') + '</dd></div>' +
      '</dl>';
  }

  function formatAddressLine(a) {
    return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.postalCode]
      .filter(Boolean).join(' · ');
  }

  function renderAddressesView() {
    var c = state.customer || {};
    var list = Array.isArray(c.addresses) ? c.addresses : [];
    var ul = $('addresses-list');
    var empty = $('addresses-empty');
    var form = $('address-form');
    if (empty) show(empty, !list.length && !addressEditingId && !(form && !form.hidden));
    if (!ul) return;

    if (form && addressEditingId !== null) {
      // Keep form visible while adding/editing; list still shown behind.
    } else if (form) {
      form.hidden = true;
      show($('address-actions'), true);
    }

    ul.innerHTML = list.map(function (a) {
      var def = a.isDefault ? ' <span class="card-kicker">Default</span>' : '';
      var label = a.label ? '<strong>' + esc(a.label) + '</strong> · ' : '';
      return '<li data-address-id="' + esc(a.id) + '">' +
        label + esc(formatAddressLine(a)) + def +
        '<div class="actions" style="margin-top:8px">' +
        (!a.isDefault
          ? '<button type="button" class="btn ghost" data-addr-action="default" data-address-id="' + esc(a.id) + '">Make default</button>'
          : '') +
        '<button type="button" class="btn ghost" data-addr-action="edit" data-address-id="' + esc(a.id) + '">Edit</button>' +
        '<button type="button" class="btn ghost" data-addr-action="archive" data-address-id="' + esc(a.id) + '">Archive</button>' +
        '</div></li>';
    }).join('');
  }

  function requestId() {
    return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  async function portalProfileAction(action, payload) {
    var body = Object.assign({
      action: action,
      expectedVersion: state.accountVersion,
      requestId: requestId(),
    }, payload || {});
    return post('customer-portal-profile', body);
  }

  function mapProfileError(data, status) {
    var err = (data && data.error) || '';
    if (status === 409 || err === 'version_conflict') {
      return 'Your profile was updated in another session. Reloading the latest version — please review and try again.';
    }
    if (err === 'contact_change_requires_verification') {
      return 'Email and phone cannot be changed here. Contact changes require verification.';
    }
    if (status === 401 || err === 'authentication_failed') {
      return 'Your session expired. Please sign in again.';
    }
    if (status === 429 || err === 'rate_limited' || err === 'too_many_requests') {
      return 'Too many requests. Wait a moment and try again.';
    }
    return (data && data.message) || 'Unable to save. Call/text 551-313-2956.';
  }

  async function saveProfile(e) {
    if (e) e.preventDefault();
    if (profileAddressBusy) return;
    profileAddressBusy = true;
    setMsg($('profile-msg'), 'Saving…', false);
    var r = await portalProfileAction('update_profile', {
      patch: {
        firstName: ($('pf-first') && $('pf-first').value) || '',
        lastName: ($('pf-last') && $('pf-last').value) || '',
        displayName: ($('pf-display') && $('pf-display').value) || '',
        preferredContactChannel: ($('pf-channel') && $('pf-channel').value) || '',
        timezone: ($('pf-tz') && $('pf-tz').value) || '',
      },
    });
    profileAddressBusy = false;
    if (r.status === 401) return;
    if (!r.ok || !r.data || !r.data.ok) {
      setMsg($('profile-msg'), mapProfileError(r.data, r.status), true);
      if (r.status === 409) {
        await loadAccount();
        profileEditing = true;
        renderProfileView();
      }
      return;
    }
    applyCustomerProjection(r.data.customer);
    profileEditing = false;
    setMsg($('profile-msg'), 'Profile saved.', false);
    renderProfileAndAddresses();
    showToast('Profile updated.', false);
  }

  function cancelProfileEdit() {
    profileEditing = false;
    setMsg($('profile-msg'), '', false);
    renderProfileView();
  }

  function openAddressForm(address) {
    var form = $('address-form');
    if (!form) return;
    addressEditingId = address ? address.id : '';
    form.hidden = false;
    show($('address-actions'), false);
    $('ad-label') && ($('ad-label').value = (address && address.label) || '');
    $('ad-line1') && ($('ad-line1').value = (address && address.line1) || '');
    $('ad-line2') && ($('ad-line2').value = (address && address.line2) || '');
    $('ad-city') && ($('ad-city').value = (address && address.city) || '');
    $('ad-state') && ($('ad-state').value = (address && address.state) || '');
    $('ad-postal') && ($('ad-postal').value = (address && address.postalCode) || '');
    $('ad-country') && ($('ad-country').value = (address && address.country) || 'US');
    $('ad-default') && ($('ad-default').checked = !!(address && address.isDefault));
    setMsg($('address-msg'), '', false);
    $('ad-line1') && $('ad-line1').focus();
  }

  function cancelAddressForm() {
    addressEditingId = null;
    var form = $('address-form');
    if (form) {
      form.hidden = true;
      form.reset && form.reset();
    }
    show($('address-actions'), true);
    setMsg($('address-msg'), '', false);
    renderAddressesView();
  }

  async function saveAddress(e) {
    if (e) e.preventDefault();
    if (profileAddressBusy) return;
    var line1 = ($('ad-line1') && $('ad-line1').value.trim()) || '';
    if (!line1) {
      setMsg($('address-msg'), 'Street address is required.', true);
      return;
    }
    profileAddressBusy = true;
    setMsg($('address-msg'), 'Saving…', false);
    var payload = {
      address: {
        label: ($('ad-label') && $('ad-label').value) || '',
        line1: line1,
        line2: ($('ad-line2') && $('ad-line2').value) || '',
        city: ($('ad-city') && $('ad-city').value) || '',
        state: ($('ad-state') && $('ad-state').value) || '',
        postalCode: ($('ad-postal') && $('ad-postal').value) || '',
        country: ($('ad-country') && $('ad-country').value) || 'US',
        isDefault: !!($('ad-default') && $('ad-default').checked),
      },
    };
    var r;
    if (addressEditingId) {
      payload.addressId = addressEditingId;
      r = await portalProfileAction('update_address', payload);
    } else {
      r = await portalProfileAction('create_address', payload);
    }
    profileAddressBusy = false;
    if (r.status === 401) return;
    if (!r.ok || !r.data || !r.data.ok) {
      setMsg($('address-msg'), mapProfileError(r.data, r.status), true);
      if (r.status === 409) await loadAccount();
      return;
    }
    applyCustomerProjection(r.data.customer);
    cancelAddressForm();
    setMsg($('address-msg'), 'Address saved.', false);
    renderProfileAndAddresses();
    showToast('Address saved.', false);
  }

  async function setDefaultAddress(addressId) {
    if (profileAddressBusy || !addressId) return;
    profileAddressBusy = true;
    var r = await portalProfileAction('set_default_address', { addressId: addressId });
    profileAddressBusy = false;
    if (r.status === 401) return;
    if (!r.ok || !r.data || !r.data.ok) {
      setMsg($('address-msg'), mapProfileError(r.data, r.status), true);
      if (r.status === 409) await loadAccount();
      return;
    }
    applyCustomerProjection(r.data.customer);
    renderProfileAndAddresses();
    showToast('Default address updated.', false);
  }

  async function archiveAddress(addressId) {
    if (profileAddressBusy || !addressId) return;
    if (!global.confirm('Archive this service address? It will no longer appear in your active list.')) return;
    profileAddressBusy = true;
    var r = await portalProfileAction('archive_address', { addressId: addressId });
    profileAddressBusy = false;
    if (r.status === 401) return;
    if (!r.ok || !r.data || !r.data.ok) {
      setMsg($('address-msg'), mapProfileError(r.data, r.status), true);
      if (r.status === 409) await loadAccount();
      return;
    }
    applyCustomerProjection(r.data.customer);
    renderProfileAndAddresses();
    showToast('Address archived.', false);
  }

  /**
   * Compact collapsed row. Money authority stays server-side, so the row shows
   * the projected total only and defers to a reload for anything payable.
   */
  function appointmentRowHtml(item, opts) {
    opts = opts || {};
    var focused = opts.focusable
      && state.focusedAppointment
      && item.appointmentPublicRef
      && state.focusedAppointment.appointmentPublicRef === item.appointmentPublicRef;
    var date = item.confirmedDate || item.preferredDate || '—';
    var total = item.approvedFinalAmount != null ? item.approvedFinalAmount : item.totalPrice;
    var meta = [esc(item.service || item.package || 'Service'), esc(date)].join(' · ');
    var tail = [esc(appointmentStatusLabel(item))];
    if (opts.showTotal && total != null) tail.push(fmtMoney(total));
    var ref = item.appointmentPublicRef || '';
    return '<li class="appt-row' + (focused ? ' appointment-focus' : '') + '">' +
      '<span class="appt-row-main">' + esc(vehicleLine(item)) + '</span>' +
      '<span class="appt-row-action">' +
      (ref
        ? '<button type="button" class="btn ghost" data-appt-ref="' + esc(ref) + '">View Details</button>'
        : '') +
      '</span>' +
      '<span class="appt-row-meta">' + meta + ' · ' + tail.join(' · ') + '</span>' +
      '</li>';
  }

  function bindAppointmentRowActions() {
    ['appointments-list', 'history-list'].forEach(function (id) {
      var root = $(id);
      if (!root) return;
      root.querySelectorAll('[data-appt-ref]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          selectAppointmentByRef(btn.getAttribute('data-appt-ref'));
        });
      });
    });
  }

  /**
   * Re-select through the server so the expanded appointment carries its own
   * authoritative payment state rather than the previous booking's.
   */
  async function selectAppointmentByRef(ref) {
    if (!ref || state.scope !== 'account') return;
    state.appointmentFocusRef = ref;
    var ok = await loadAccount({ appointmentFocusRef: ref, managePhase: false });
    if (!ok) showToast('Could not open that appointment.', true);
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
    var signatureKeys = Object.keys(payload || {}).sort();
    var requestSignature = action + ':' + JSON.stringify(payload || {}, signatureKeys);
    var idempotencyKey = mutationRequestKeys[requestSignature];
    if (!idempotencyKey) {
      idempotencyKey = global.crypto && typeof global.crypto.randomUUID === 'function'
        ? global.crypto.randomUUID()
        : ('op_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      mutationRequestKeys[requestSignature] = idempotencyKey;
    }
    var body = Object.assign({
      bookingId: state.booking.id,
      phone: phone,
      action: action,
      expectedBookingVersion: state.booking.bookingVersion,
      idempotencyKey: idempotencyKey,
    }, payload || {});
    // Never send browser prices/totals as authoritative for package/add-on money.
    delete body.price;
    delete body.priceCents;
    delete body.proposedTotal;
    delete body.approvedTotal;
    delete body.approvedCents;
    delete body.total;
    delete body.amount;
    delete body.amountCents;
    if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.changeRequested();
    var r;
    try {
      r = await post('submit-customer-action', body);
    } catch (networkError) {
      var uncertain = 'Connection interrupted. Your request may have reached the server. Reconnect and retry to safely check it.';
      if (opts.fromModal) setMsg($('modal-error'), uncertain, true);
      else showToast(uncertain, true);
      return false;
    }

    if (r.data && r.data.ok) {
      // Keep vehicle_add fingerprint for this session so an identical resubmit
      // reuses the same idempotency key (server replay) instead of appending twins.
      if (action !== 'vehicle_add_request') {
        delete mutationRequestKeys[requestSignature];
      }
      // Mutations return a safe canonical booking projection. Paint it now,
      // then use the shared poller to converge secondary projections.
      if (r.data.booking) applyCanonicalBookingProjection(r.data.booking);
      if (portalRefresh) portalRefresh.markPending(30000);
      if (r.data.noop && (r.data.reason === 'package_unchanged' || action === 'package_change_request')) {
        showToast(r.data.message || 'That package is already on your booking — no change needed.');
      } else if (r.data.noop && (r.data.reason === 'duplicate_addon' || action === 'addon_request')) {
        showToast(r.data.message || 'That add-on is already on your booking.');
      } else if (r.data.noop) {
        showToast(r.data.message || 'No change needed.');
      } else if (r.data.pendingApproval) {
        showToast(action === 'package_change_request'
          ? 'Package change submitted for review.'
          : action === 'vehicle_remove_request'
            ? (r.data.message || 'Removal requested — Pending review')
            : 'Request submitted for admin review.');
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

    var msg = action === 'package_change_request'
      ? mapPackageErrorMessage(r.data, r.status)
      : mapAddonErrorMessage(r.data, r.status);
    if (r.data && r.data.error === 'version_conflict') {
      delete mutationRequestKeys[requestSignature];
      showToast(msg, true);
      if (portalRefresh) portalRefresh.markPending(15000);
      try {
        if (state.scope === 'account') await loadAccount();
        else await loadLimited({ soft: true });
      } catch (e) { /* session preserved */ }
      // Do not silently replay the mutation.
      return false;
    }
    if (!isTemporarilyUnavailableResponse(r)) {
      delete mutationRequestKeys[requestSignature];
    }
    if (opts.fromModal) setMsg($('modal-error'), msg, true);
    else showToast(msg, true);
    return false;
  }

  /**
   * Review submission. Eligibility and the one-per-booking rule are the server's
   * call — this only reports what it says back.
   */
  async function submitReview(payload) {
    var r = await post('submit-review', {
      bookingId: state.booking && state.booking.id,
      phone: state.verifyPhone || normalizePhoneInput(state.booking && state.booking.phone),
      stars: Number(payload.stars),
      comment: payload.comment || '',
    });
    if (r.data && r.data.ok) {
      showToast('Thanks for your review.');
      if (state.scope === 'account') await loadAccount();
      else await loadLimited();
      return true;
    }
    setMsg($('modal-error'), (r.data && r.data.message) || 'Review unavailable.', true);
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

  var embeddedPay = {
    stripe: null,
    elements: null,
    paymentElement: null,
    clientSecret: null,
    bookingId: null,
    // Set for the whole duration of a start attempt so a double tap cannot
    // request a second PaymentIntent or mount a second Payment Element.
    starting: false,
  };

  /**
   * Bring the payment panel into view and hand the customer focus. Called on
   * every "Pay securely" entry point, including the reuse path.
   */
  function revealPaymentPanel() {
    var panel = $('embedded-pay-panel');
    if (!panel) return;
    panel.hidden = false;
    var reduceMotion = false;
    try {
      reduceMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { /* ignore */ }
    try {
      panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    } catch (e) {
      try { panel.scrollIntoView(); } catch (e2) { /* ignore */ }
    }
    var heading = $('embedded-pay-h');
    var target = heading && typeof heading.focus === 'function' ? heading : panel;
    if (target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    try { target.focus({ preventScroll: true }); } catch (e) {
      try { target.focus(); } catch (e2) { /* ignore */ }
    }
  }

  /** Keeps the appointment and amount visible next to the card fields. */
  function setPaymentContext(cents) {
    var ctx = $('embedded-pay-context');
    if (!ctx) return;
    var b = state.booking || {};
    var parts = ['Balance due: ' + fmtMoney((Number(cents) || 0) / 100)];
    var vehicle = vehicleLine(b);
    if (vehicle && vehicle !== '—') parts.push(vehicle);
    var service = b.service || b.package;
    if (service) parts.push(service);
    ctx.textContent = parts.join(' · ');
  }

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
    embeddedPay.bookingId = null;
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
    if (phone) { /* keep the verified-session read on this recovery path */ }
    showToast('Secure payment could not load. Check your connection and try again.', true);
  }

  async function saveSmsConsent() {
    if (profileAddressBusy) return;
    profileAddressBusy = true;
    var button = $('sms-consent-save');
    if (button) button.disabled = true;
    setMsg($('sms-consent-msg'), 'Saving…', false);
    var r = await portalProfileAction('update_sms_consent', {
      granted: !!($('sms-consent-toggle') && $('sms-consent-toggle').checked),
    });
    profileAddressBusy = false;
    if (button) button.disabled = false;
    if (r.status === 401) return;
    if (!r.ok || !r.data || !r.data.ok) {
      setMsg($('sms-consent-msg'), mapProfileError(r.data, r.status), true);
      if (r.status === 409) await loadAccount();
      renderProfileView();
      return;
    }
    applyCustomerProjection(r.data.customer);
    setMsg(
      $('sms-consent-msg'),
      $('sms-consent-toggle') && $('sms-consent-toggle').checked
        ? 'Transactional text consent saved.'
        : 'Transactional text consent revoked.',
      false
    );
    renderProfileAndAddresses();
  }

  async function startPayBalance() {
    if (embeddedPay.starting) return;
    if (!state.booking) {
      showToast('Open a booking first.', true);
      return;
    }
    var pay = state.payment || {};
    var due = Number(pay.amountDueApproved || 0);
    if ((!pay.canPay && !pay.canCreatePayLink) || !(due > 0)) {
      showToast('No balance is due yet, or payment is locked until approval.', true);
      return;
    }

    // Already mounted for this booking: reveal it again rather than asking the
    // server for a second PaymentIntent.
    if (embeddedPay.paymentElement
      && embeddedPay.clientSecret
      && embeddedPay.bookingId === String(state.booking.id || '')) {
      revealPaymentPanel();
      return;
    }

    embeddedPay.starting = true;
    refreshPayCtaLabels(pay);
    try {
      await startPayBalanceInner(pay);
    } finally {
      embeddedPay.starting = false;
      refreshPayCtaLabels(pay);
    }
  }

  /**
   * Keep whichever payment CTA is on screen in step with the controller state.
   * Re-entry is already blocked by embeddedPay.starting; this only makes that
   * visible, and disables the control so a second tap cannot queue a request.
   */
  function refreshPayCtaLabels(pay) {
    var due = Number((pay && pay.amountDueApproved) || 0);
    var can = !!(pay && (pay.canPay || pay.canCreatePayLink));
    var busy = !!(embeddedPay && embeddedPay.starting);
    [$('btn-pay-balance'), $('pay-sticky-btn')].forEach(function (el) {
      if (!el) return;
      el.textContent = payCtaLabel(can, due);
      el.disabled = busy;
      el.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
  }

  async function startPayBalanceInner(pay) {
    var phone = state.verifyPhone || normalizePhoneInput(state.booking.phone);
    showToast('Preparing secure payment…');

    // Prefer in-page Payment Element (Postgres authority) when available.
    var intent = await post('customer-balance-payment-intent', {
      bookingId: state.booking.id,
      phone: phone,
      expectedQuoteVersion: pay.quoteVersion,
      expectedBookingVersion: state.booking.bookingVersion,
    });

    if (intent.data && intent.data.error === 'already_paid') {
      showToast('This appointment is already paid.', true);
      hideEmbeddedPay();
      pollPaymentSettlement();
      return;
    }

    if (intent.data && intent.data.ok && intent.data.clientSecret) {
      if (typeof global.Stripe !== 'function') {
        showToast('Stripe.js failed to load. Check your connection and try again.', true);
        return startHostedCheckoutFallback();
      }
      var pk = await loadStripePublishableKey();
      if (!pk) {
        showToast('Payment config is temporarily unavailable. Try again shortly.', true);
        return startHostedCheckoutFallback();
      }

      // Tear down any prior element before creating another one.
      hideEmbeddedPay();
      embeddedPay.stripe = global.Stripe(pk);
      embeddedPay.clientSecret = intent.data.clientSecret;
      embeddedPay.bookingId = String(state.booking.id || '');
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
      var cents = intent.data.amountCents || pay.remainingCents || 0;
      if (amountEl) {
        amountEl.textContent = 'Pay ' + fmtMoney(cents / 100) + ' securely without leaving this page.';
      }
      setPaymentContext(cents);
      var submitBtn = $('embedded-pay-submit');
      if (submitBtn) submitBtn.textContent = 'Pay ' + fmtMoney(cents / 100);
      panel.hidden = false;
      embeddedPay.paymentElement.mount(mountEl);
      setEmbeddedPayMsg('Enter card details to pay. Saved cards appear only when Stripe allows redisplay.', false);
      revealPaymentPanel();
      if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.paymentOpened();
      return;
    }

    showToast(
      (intent.data && intent.data.message)
        || (intent.data && intent.data.error === 'stale_quote_version' && 'Your quote was updated. Refresh and try again.')
        || (intent.data && intent.data.error === 'already_paid' && 'This invoice is already paid.')
        || (intent.data && intent.data.error === 'zero_balance' && 'No balance is due for this appointment.')
        || 'Payment is not available yet.',
      true
    );
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
      setEmbeddedPayMsg(result.error.message || 'Payment failed. Try again.', true);
      return;
    }
    var status = result.paymentIntent && result.paymentIntent.status;
    if (status === 'succeeded' || status === 'processing') {
      setEmbeddedPayMsg(status === 'processing' ? 'Payment processing — confirming…' : 'Payment succeeded — confirming…', false);
      hideEmbeddedPay();
      // Pin the paid booking so multi-email selectUpcoming cannot swap the hero.
      if (state.booking) {
        state.appointmentFocusRef = state.booking.appointmentPublicRef
          || state.booking.id
          || state.appointmentFocusRef;
      }
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
    var sticky = $('pay-sticky-btn');
    if (submit) submit.addEventListener('click', function () { confirmEmbeddedPay(); });
    if (cancel) cancel.addEventListener('click', function () { hideEmbeddedPay(); });
    if (sticky) sticky.addEventListener('click', function () { startPayBalance(); });
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
    packageModalVehicleId = '';
    setMsg($('modal-error'), '', false);
    var submitBtn = $('modal-submit');
    if (submitBtn) submitBtn.textContent = 'Submit request';
    var cancelBtn = $('modal-cancel');
    if (cancelBtn) cancelBtn.textContent = 'Cancel';
    var opener = modalOpenerEl;
    modalOpenerEl = null;
    if (opener && typeof opener.focus === 'function') {
      try { opener.focus(); } catch (e) { /* ignore */ }
    }
  }

  function openModalShell(title) {
    $('modal-title').textContent = title;
    var ov = $('action-modal');
    ov.hidden = false;
    ov.classList.add('open');
    // Initial focus: first meaningful control inside the form, else the submit button.
    setTimeout(function () {
      var form = $('modal-form');
      var first = form && form.querySelector(
        'select:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), button:not([disabled])'
      );
      if (first && typeof first.focus === 'function') first.focus();
      else if ($('modal-submit')) $('modal-submit').focus();
    }, 0);
  }

  function currentAddonsPreservationHtml() {
    var ids = currentBookingAddonIds();
    if (!ids.length) {
      return '<p class="hint">No add-ons on this booking. Compatible selected add-ons stay attached when you change package.</p>';
    }
    var names = ids.map(function (id) {
      var fromBooking = ((state.booking && state.booking.addons) || []).find(function (a) {
        return a && a.id === id;
      });
      return (fromBooking && fromBooking.name) || id;
    });
    return '<p class="hint"><strong>Current add-ons stay on the booking</strong> unless they are incompatible with the new package: '
      + esc(names.join(', ')) + '.</p>';
  }

  function renderPackageModal() {
    var catalog = getPackageCatalog();
    var vehicles = packageVehicles();
    if (!vehicles.length || catalog.source !== 'booking-price-catalog') {
      showToast('Package list unavailable. Refresh and try again.', true);
      return false;
    }

    if (vehicles.length === 1) {
      packageModalVehicleId = vehicles[0].vehicleId;
    } else if (!packageModalVehicleId
      || !vehicles.some(function (v) { return v.vehicleId === packageModalVehicleId; })) {
      packageModalVehicleId = '';
    }

    var selected = selectedPackageVehicle();
    var form = $('modal-form');
    var vehiclePicker = '';
    if (vehicles.length > 1) {
      vehiclePicker =
        '<label for="mf-package-vehicle">Vehicle <span class="req">*</span></label>' +
        '<select class="inp" id="mf-package-vehicle" name="vehicleId" required>' +
        '<option value="">Select a vehicle</option>' +
        vehicles.map(function (v) {
          return '<option value="' + esc(v.vehicleId) + '"'
            + (v.vehicleId === packageModalVehicleId ? ' selected' : '') + '>'
            + esc(v.label || v.vehicleId)
            + (v.currentPackageId ? ' · current: ' + esc(v.currentPackageId) : '')
            + '</option>';
        }).join('') +
        '</select>';
    }

    if (!selected) {
      form.innerHTML =
        '<p class="hint">Choose which vehicle to update. Package prices come from the official booking catalog.</p>' +
        vehiclePicker +
        currentAddonsPreservationHtml() +
        '<p class="hint" id="mf-package-proposed">Select a vehicle to see package options.</p>';
      var vehSelEmpty = $('mf-package-vehicle');
      if (vehSelEmpty) {
        vehSelEmpty.addEventListener('change', function () {
          packageModalVehicleId = String(vehSelEmpty.value || '').trim();
          renderPackageModal();
          openModalShell('Change package');
        });
      }
      return true;
    }

    var packs = selected.options || [];
    var category = selected.category || 'cars';
    var needsLength = !!selected.lengthPriced || !!lengthCfg(category);
    var currentFt = Number(
      selected.lengthFt
      || (state.booking && (state.booking.vehicleLengthFt || state.booking.lengthFt))
      || 0
    );
    if (!packs.length) {
      showToast('No package options available for this vehicle.', true);
      return false;
    }

    form.innerHTML =
      '<p class="hint">Select a package'
      + (needsLength ? ' and confirm length. Length-based totals are finalized by the server after you submit' : '')
      + '. Changes apply to your appointment when accepted — totals come from the server catalog, not a browser estimate.</p>'
      + vehiclePicker
      + currentAddonsPreservationHtml()
      + (needsLength ? lengthRulerHtml(category, currentFt) : '')
      + '<div class="modal-catalog" role="radiogroup" aria-label="Packages">'
      + packs.map(function (p) {
        var packId = p.packageId || p.id;
        var priceLabel = p.priceCents != null
          ? fmtCents(p.priceCents)
          : (p.pricedByLength ? 'By length' : '');
        var meta = [];
        if (selected.tierKey) meta.push(selected.tierKey);
        if (p.current) meta.push('current');
        return '<label class="catalog-option">' +
          '<input type="radio" name="newPackId" value="' + esc(packId) + '"'
          + (p.current ? ' data-current="1"' : '') + ' required>' +
          '<span class="opt-body">' +
          '<span class="opt-name">' + esc(p.label || p.name || packId) + '</span>' +
          '<span class="opt-price" data-pack-price="' + esc(packId) + '">' + esc(priceLabel) + '</span>' +
          (meta.length ? '<span class="opt-meta">' + esc(meta.join(' · ')) + '</span>' : '') +
          '<span class="opt-desc">' + esc(p.description || '') + '</span>' +
          '</span></label>';
      }).join('') +
      '</div>' +
      '<p class="modal-live-total" id="mf-package-proposed">'
      + (needsLength
        ? 'Catalog price at current length shown above. If you change length, the authoritative total is confirmed after submit.'
        : 'Catalog package price shown above. Final invoice total comes from the server after you submit.')
      + '</p>';

    function refreshProposed() {
      var packEl = form.querySelector('input[name="newPackId"]:checked');
      var el = $('mf-package-proposed');
      if (!el) return;
      var ft = Number(($('mf-lengthFt') && $('mf-lengthFt').value) || currentFt || 0);
      var lengthChanged = needsLength && currentFt > 0 && ft !== currentFt;
      if (!packEl) {
        el.textContent = needsLength
          ? 'Select a package. Length-based totals are confirmed by the server after submit.'
          : 'Select a package. Final totals come from the server after you submit.';
        return;
      }
      var pack = packs.find(function (x) { return (x.packageId || x.id) === packEl.value; });
      if (!pack) return;
      if (needsLength && lengthChanged) {
        el.textContent = 'Length updated to ' + ft
          + ' ft — authoritative package total will be confirmed by the server after submit'
          + ' (+ travel/add-ons as approved).';
        form.querySelectorAll('[data-pack-price]').forEach(function (span) {
          span.textContent = 'By length';
        });
        return;
      }
      if (pack.priceCents != null) {
        el.textContent = 'Catalog package price: ' + fmtCents(pack.priceCents)
          + (needsLength && ft > 0 ? ' · ' + ft + ' ft' : '')
          + ' (+ travel/add-ons as approved). Final invoice total comes from the server.';
      } else {
        el.textContent = 'Catalog pricing basis shown. Final total comes from the server after you submit.';
      }
    }

    form.querySelectorAll('input[name="newPackId"]').forEach(function (inp) {
      inp.addEventListener('change', refreshProposed);
    });
    var vehSel = $('mf-package-vehicle');
    if (vehSel) {
      vehSel.addEventListener('change', function () {
        packageModalVehicleId = String(vehSel.value || '').trim();
        renderPackageModal();
        openModalShell('Change package');
      });
    }
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
    setModalSubmitPending(true);
    setMsg($('modal-error'), '', false);
    try {
      var ok = await submitAction('addon_remove_request', {
        addonIds: [addonId],
        vehicleId: packageModalVehicleId || undefined,
      }, { fromModal: true });
      if (ok) {
        if (!renderAddonModal()) closeModal();
        else openModalShell('Modify service / add-ons');
      }
    } finally {
      setModalSubmitPending(false);
    }
  }

  function renderAddonModal() {
    var targetVehicles = bookingVehiclesForActions();
    if (targetVehicles.length === 1) packageModalVehicleId = String(targetVehicles[0].vehicleId || '');
    var multiVehicle = targetVehicles.length > 1;
    var vehicleSelectorHtml = multiVehicle
      ? '<div><label for="mf-addon-vehicle">Vehicle</label><select id="mf-addon-vehicle">' +
        '<option value="">Select a vehicle</option>' +
        targetVehicles.map(function (vehicle) {
          var id = String(vehicle.vehicleId || '');
          return '<option value="' + esc(id) + '"' + (id === packageModalVehicleId ? ' selected' : '') + '>' +
            esc(projectedVehicleLabel(vehicle)) + '</option>';
        }).join('') + '</select></div>'
      : '';
    var form = $('modal-form');
    if (multiVehicle && !selectedAddonVehicle()) {
      form.innerHTML = vehicleSelectorHtml + '<p class="hint">Select which vehicle you want to update.</p>';
      var emptySelector = $('mf-addon-vehicle');
      if (emptySelector) emptySelector.addEventListener('change', function () {
        packageModalVehicleId = String(emptySelector.value || '').trim();
        renderAddonModal();
        openModalShell('Modify service / add-ons');
      });
      return true;
    }
    var addons = addonsForBookingCategory();
    if (!addons.length) {
      showToast('Add-on list unavailable. Refresh and try again.', true);
      return false;
    }
    var selectedIds = currentBookingAddonIds();
    var selectedSet = {};
    selectedIds.forEach(function (id) { selectedSet[id] = true; });
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
    var targetVehicle = selectedAddonVehicle() || {};
    var targetPackageId = String(targetVehicle.packageId || targetVehicle.pkgId || '').trim();
    var included = addons.filter(function (a) {
      return Array.isArray(a.includedInPackageIds)
        && a.includedInPackageIds.indexOf(targetPackageId) >= 0;
    });
    var available = addons.filter(function (a) {
      return a.available !== false && !selectedSet[a.id] && included.indexOf(a) < 0;
    });

    form.innerHTML =
      vehicleSelectorHtml +
      '<p class="hint">Prices shown are from the official catalog. After you submit, your portal shows the server Total approved / Amount paid / Amount due.</p>' +
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
            '<button type="button" class="btn ghost" data-remove-addon="' + esc(a.id) + '"'
              + (mutationPending ? ' disabled' : '') + '>Remove</button>' +
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
        : '<p class="hint">All separately billable add-ons for this vehicle are already selected.</p>') +
      (included.length
        ? '<p class="hint">Already included in this package: ' + included.map(function (a) { return esc(a.name); }).join(', ') + '.</p>'
        : '') +
      '<p class="modal-live-total" id="mf-addon-total">Preview only (catalog): +$0.00 · Final totals come from the server after you submit</p>';

    var targetSelector = $('mf-addon-vehicle');
    if (targetSelector) targetSelector.addEventListener('change', function () {
      packageModalVehicleId = String(targetSelector.value || '').trim();
      renderAddonModal();
      openModalShell('Modify service / add-ons');
    });
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

  async function openVehicleRemovalConfirm(openerEl) {
    modalOpenerEl = openerEl || document.activeElement || null;
    var vehicleId = openerEl && openerEl.getAttribute
      ? String(openerEl.getAttribute('data-vehicle-id') || '').trim()
      : '';
    var vehicleLabel = openerEl && openerEl.getAttribute
      ? String(openerEl.getAttribute('data-vehicle-label') || 'this vehicle').trim()
      : 'this vehicle';
    var isLast = openerEl && openerEl.getAttribute
      && openerEl.getAttribute('data-last-vehicle') === '1';
    if (!vehicleId) {
      showToast('Could not identify which vehicle to remove.', true);
      return;
    }
    if (isLast) {
      showToast('To remove the final vehicle, cancel the appointment or contact us.', true);
      return;
    }
    if (pendingRemovalForVehicle(vehicleId)) {
      showToast('A removal request for this vehicle is already pending review.');
      return;
    }
    var b = state.booking || {};
    var vehicles = Array.isArray(b.vehicles) ? b.vehicles : [];
    var target = null;
    for (var i = 0; i < vehicles.length; i += 1) {
      if (String(vehicles[i].vehicleId || '') === vehicleId) { target = vehicles[i]; break; }
    }
    var vehicleSubtotal = target && target.subtotal != null ? Number(target.subtotal) : null;
    var bookingTotal = Number(
      b.approvedFinalAmount != null ? b.approvedFinalAmount
        : (b.totalPrice != null ? b.totalPrice : (b.finalAmount != null ? b.finalAmount : 0))
    );
    var estimateRemaining = (Number.isFinite(bookingTotal) && vehicleSubtotal != null)
      ? Math.max(0, bookingTotal - vehicleSubtotal)
      : null;

    modalAction = 'vehicle_remove_request';
    modalMode = 'fields';
    modalFields = [];
    var form = $('modal-form');
    if (!form) return;
    form.innerHTML =
      '<p><strong>Remove ' + esc(vehicleLabel) + ' from this appointment?</strong></p>' +
      '<p class="hint">This will also remove the selected package and every add-on attached to that vehicle.</p>' +
      '<dl class="meta-grid" style="margin:12px 0">' +
        (vehicleSubtotal != null
          ? '<div><dt>Current vehicle subtotal</dt><dd>' + fmtMoney(vehicleSubtotal) + '</dd></div>'
          : '') +
        (estimateRemaining != null
          ? '<div><dt>Estimated booking total after removal</dt><dd>' + fmtMoney(estimateRemaining) + '</dd></div>'
          : '') +
      '</dl>' +
      '<p class="hint">The estimate above is informational only. The server recalculates the official total if approved.</p>' +
      '<input type="hidden" id="mf-remove-vehicle-id" value="' + esc(vehicleId) + '">';
    var submitBtn = $('modal-submit');
    if (submitBtn) submitBtn.textContent = 'Request removal';
    var cancelBtn = $('modal-cancel');
    if (cancelBtn) cancelBtn.textContent = 'Keep vehicle';
    openModalShell('Request vehicle removal');
  }

  function openActionModal(action, openerEl) {
    modalOpenerEl = openerEl || document.activeElement || null;
    var moneyLocked = {
      maintenance_request: true,
    };
    if (action === 'package_change_request') {
      var packageBlock = packageChangeUnavailableReason();
      if (packageBlock) {
        showToast(packageBlock, true);
        modalOpenerEl = null;
        return;
      }
    } else if (moneyLocked[action] && invoiceIsPaid(state.payment)) {
      showToast('Invoice paid — call/text Cardetail1 for a quote adjustment.', true);
      modalOpenerEl = null;
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
      leave_review: { title: 'Leave a review', fields: [
        { name: 'stars', label: 'Rating (1–5)', type: 'text', required: true },
        { name: 'comment', label: 'What stood out? (optional)', type: 'textarea' },
      ]},
      report_issue: { title: 'Report a service issue', fields: [
        { name: 'category', label: 'What is the issue about? (quality, damage, missed_area, timeliness, billing, conduct, other)', type: 'text', required: true },
        { name: 'description', label: 'Describe the issue', type: 'textarea', required: true },
      ]},
    };

    modalAction = action;
    modalMode = 'fields';
    modalFields = [];

    if (action === 'package_change_request') {
      modalMode = 'package';
      packageModalVehicleId = '';
      if (openerEl && openerEl.getAttribute) {
        packageModalVehicleId = String(openerEl.getAttribute('data-vehicle-id') || '').trim();
      }
      if (!renderPackageModal()) { modalAction = null; modalOpenerEl = null; return; }
      openModalShell('Change package');
      return;
    }
    if (action === 'addon_request') {
      modalMode = 'addons';
      if (openerEl && openerEl.getAttribute) {
        // Prefer targeted vehicle when opened from a vehicle card.
        var addonVid = String(openerEl.getAttribute('data-vehicle-id') || '').trim();
        if (addonVid) packageModalVehicleId = addonVid;
      }
      if (!renderAddonModal()) { modalAction = null; return; }
      openModalShell('Modify service / add-ons');
      return;
    }
    if (action === 'vehicle_remove_request') {
      openVehicleRemovalConfirm(openerEl);
      return;
    }
    if (action === 'vehicle_add_request' || action === 'vehicle_replace_request' || action === 'vehicle_add') {
      if (action === 'vehicle_replace_request' && (!openerEl || !openerEl.getAttribute('data-vehicle-id'))) {
        var selectableVehicles = state.booking && Array.isArray(state.booking.vehicles)
          ? state.booking.vehicles : [];
        if (selectableVehicles.length > 1) {
          showToast('Choose Edit / replace vehicle on the vehicle you want to change.', true);
          modalOpenerEl = null;
          return;
        }
      }
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
      var vehicles = packageVehicles();
      var selected = selectedPackageVehicle();
      if (vehicles.length > 1 && !selected) {
        setMsg($('modal-error'), 'Select which vehicle this package change applies to.', true);
        return null;
      }
      if (!selected) {
        setMsg($('modal-error'), 'Package options unavailable. Refresh and try again.', true);
        return null;
      }
      var pack = form.querySelector('input[name="newPackId"]:checked');
      if (!pack) {
        setMsg($('modal-error'), 'Select a package.', true);
        return null;
      }
      // Identity only — never send browser prices/totals as authoritative.
      var payload = {
        newPackId: pack.value,
        vehicleId: selected.vehicleId,
      };
      var category = selected.category || '';
      if (category === 'boats' || category === 'rvs') {
        payload.vehicleCategory = category;
      }
      if (selected.tierKey) {
        payload.tierKey = selected.tierKey;
        payload.tier = selected.tierKey;
      }
      if (selected.lengthPriced || lengthCfg(category)) {
        var ft = Number(($('mf-lengthFt') && $('mf-lengthFt').value) || selected.lengthFt || 0);
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
      return { addonIds: ids, vehicleId: packageModalVehicleId || undefined };
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
      if (modalAction === 'vehicle_replace_request' && modalOpenerEl && modalOpenerEl.getAttribute) {
        vehiclePayload.vehicleId = String(modalOpenerEl.getAttribute('data-vehicle-id') || '').trim();
      }
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
      if (modalAction === 'vehicle_remove_request') {
        var removeId = ($('mf-remove-vehicle-id') && $('mf-remove-vehicle-id').value) || '';
        if (!removeId) {
          setMsg($('modal-error'), 'Missing vehicle id.', true);
          return;
        }
        ok = await submitAction('vehicle_remove_request', { vehicleId: removeId }, { fromModal: true });
      } else if (modalAction === 'approve_completion') {
        ok = await submitPortalAction('approve_completion', {
          bookingId: state.booking && state.booking.id,
          phone: state.verifyPhone || normalizePhoneInput(state.booking && state.booking.phone),
          expectedBookingVersion: state.booking && state.booking.bookingVersion,
        });
      } else if (modalAction === 'report_issue') {
        ok = await submitPortalAction('report_issue', {
          bookingId: state.booking && state.booking.id,
          phone: state.verifyPhone || normalizePhoneInput(state.booking && state.booking.phone),
          category: String(payload.category || '').trim().toLowerCase(),
          description: payload.description,
        });
      } else if (modalAction === 'leave_review') {
        ok = await submitReview(payload);
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

    var pfEdit = $('pf-edit-btn');
    if (pfEdit) {
      pfEdit.addEventListener('click', function () {
        profileEditing = true;
        setMsg($('profile-msg'), '', false);
        renderProfileView();
        $('pf-first') && $('pf-first').focus();
      });
    }
    var pfCancel = $('pf-cancel');
    if (pfCancel) pfCancel.addEventListener('click', cancelProfileEdit);
    var pfForm = $('profile-edit');
    if (pfForm) pfForm.addEventListener('submit', saveProfile);
    var smsConsentSave = $('sms-consent-save');
    if (smsConsentSave) smsConsentSave.addEventListener('click', saveSmsConsent);

    var adAdd = $('ad-add-btn');
    if (adAdd) {
      adAdd.addEventListener('click', function () {
        openAddressForm(null);
      });
    }
    var adCancel = $('ad-cancel');
    if (adCancel) adCancel.addEventListener('click', cancelAddressForm);
    var adForm = $('address-form');
    if (adForm) adForm.addEventListener('submit', saveAddress);
    var addrList = $('addresses-list');
    if (addrList) {
      addrList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-addr-action]');
        if (!btn) return;
        var id = btn.getAttribute('data-address-id');
        var action = btn.getAttribute('data-addr-action');
        if (action === 'default') setDefaultAddress(id);
        else if (action === 'archive') archiveAddress(id);
        else if (action === 'edit') {
          var addresses = (state.customer && state.customer.addresses) || [];
          var found = null;
          for (var i = 0; i < addresses.length; i += 1) {
            if (addresses[i].id === id) { found = addresses[i]; break; }
          }
          if (found) openAddressForm(found);
        }
      });
    }

    var actions = $('customer-actions');
    if (actions) {
      actions.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        openActionModal(btn.getAttribute('data-action'), btn);
      });
    }
    // Per-vehicle package accordion + vehicle-scoped actions (hero / upcoming card)
    document.addEventListener('click', function (e) {
      var toggle = e.target.closest('.package-details-toggle');
      if (toggle) {
        e.preventDefault();
        var panelId = toggle.getAttribute('data-panel') || toggle.getAttribute('aria-controls');
        var panel = panelId ? document.getElementById(panelId) : null;
        if (!panel) return;
        var expanded = toggle.getAttribute('aria-expanded') === 'true';
        var next = !expanded;
        toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
        if (next) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        var labelEl = toggle.querySelector('.package-toggle-label');
        if (labelEl) labelEl.textContent = next ? 'Hide services' : 'View services';
        else {
          toggle.textContent = next ? 'Hide services ▴' : 'View services ▾';
        }
        return;
      }
      var vBtn = e.target.closest('.vehicle-action[data-action]');
      if (vBtn) {
        e.preventDefault();
        openActionModal(vBtn.getAttribute('data-action'), vBtn);
      }
    });
    var maintEmpty = $('maintenance-empty');
    if (maintEmpty) {
      maintEmpty.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        openActionModal(btn.getAttribute('data-action'), btn);
      });
    }
    var modalSubmit = $('modal-submit');
    if (modalSubmit) modalSubmit.addEventListener('click', submitModal);
    var modalCancel = $('modal-cancel');
    if (modalCancel) modalCancel.addEventListener('click', function () {
      if (mutationPending) return;
      closeModal();
    });
    var modalOv = $('action-modal');
    if (modalOv) {
      modalOv.addEventListener('click', function (e) {
        if (e.target === modalOv && !mutationPending) closeModal();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var ov = $('action-modal');
      if (!ov || ov.hidden || !ov.classList.contains('open')) return;
      if (mutationPending) return;
      e.preventDefault();
      closeModal();
    });
    // Enter in address/fields must not GET-navigate away (?newAddress=…) and drop the hub session.
    var modalForm = $('modal-form');
    if (modalForm) {
      modalForm.addEventListener('submit', function (e) {
        e.preventDefault();
        submitModal();
      });
    }

    var portalRetry = $('portal-retry');
    if (portalRetry) {
      portalRetry.addEventListener('click', function () {
        retryPortalHydration();
      });
    }
    var portalReturn = $('portal-return-signin');
    if (portalReturn) {
      portalReturn.addEventListener('click', function (e) {
        e.preventDefault();
        returnToPortalSignIn();
      });
    }
  }

  async function boot() {
    bindUi();
    if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.opened();

    // Block login/dashboard flash until auth/session resolution completes.
    setPortalPhase(PORTAL_PHASE.LOADING_PORTAL, { message: 'Signing you in...' });

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
    var appointmentFocus = params.get('appointment');
    if (appointmentFocus) state.appointmentFocusRef = appointmentFocus;
    if (preId && $('lk-booking-id')) $('lk-booking-id').value = preId.toUpperCase();
    if (prePhone && $('lk-phone')) $('lk-phone').value = prePhone;

    if (params.get('paid') === '1') {
      // Never treat ?paid=1 as verified settlement — show processing until ledger confirms
      showToast('Payment processing — refreshing your balance…');
    } else if (params.get('canceled') === '1') {
      showToast('Checkout canceled. You can pay anytime from your portal.', true);
    }

    var actionToken = params.get('action');
    if (actionToken) {
      var actionGen = portalHydration.generation;
      setPortalPhase(PORTAL_PHASE.LOADING_PORTAL, { message: 'Loading your garage...' });
      actionGen = portalHydration.generation;
      var ar = await post('customer-portal-action', { action: 'view', token: actionToken });
      if (actionGen !== portalHydration.generation) return;
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
        setPortalPhase(PORTAL_PHASE.READY);
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

    var hydrated = await hydrateAuthenticatedPortal({
      force: true,
      phase: PORTAL_PHASE.LOADING_PORTAL,
      message: 'Signing you in...',
      allowIdle: false,
    });
    if (hydrated) {
      if (params.get('paid') === '1') pollPaymentSettlement();
      return;
    }
    if (portalHydration.phase === PORTAL_PHASE.TEMPORARILY_UNAVAILABLE
      || portalHydration.phase === PORTAL_PHASE.FAILED) {
      return;
    }

    // Auto-open only for explicit URL deep-links (incl. Stripe ?paid=1&bookingId=…).
    // Never auto-login from sessionStorage alone — that re-locked the last Booking ID on login.
    var urlHasBooking = !!(params.get('bookingId') || params.get('id') || params.get('booking'));
    if (urlHasBooking && preId) {
      var bookingGen = portalHydration.generation;
      setPortalPhase(PORTAL_PHASE.LOADING_PORTAL, { message: 'Loading your garage...' });
      bookingGen = portalHydration.generation;
      if (!prePhone) {
        try { prePhone = sessionStorage.getItem('cd1_garage_phone') || ''; } catch (e) { prePhone = ''; }
      }
      if (prePhone) {
        state.verifyBookingId = String(preId).toUpperCase();
        state.verifyPhone = normalizePhoneInput(prePhone);
        var wasPaidReturn = params.get('paid') === '1';
        var autoOk = await loadLimited();
        if (bookingGen !== portalHydration.generation) return;
        if (autoOk) {
          history.replaceState({}, '', 'my-garage.html' + (wasPaidReturn ? '?paid=1' : ''));
          setPortalPhase(PORTAL_PHASE.READY);
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

    setPortalPhase(PORTAL_PHASE.IDLE);
  }

  async function pollPaymentSettlement() {
    paymentConfirmationPending = true;
    showToast('Confirming payment with the server — do not pay again.');
    if (portalRefresh) {
      portalRefresh.markPending(20000);
      return portalRefresh.refresh('payment_settlement', { supersede: true });
    }
    return portalReload();
  }

  function portalReload(context) {
    context = context || {};
    if (state.scope === 'account') {
      return loadAccount({
        managePhase: false,
        signal: context.signal,
        // Re-send retained focus so auto-refresh cannot swap the hero booking.
        appointmentFocusRef: state.appointmentFocusRef || null,
      });
    }
    if (state.actionToken || state.booking) return loadLimited({ signal: context.signal });
    return Promise.resolve();
  }

  function portalHasPendingState() {
    var pay = state.payment || {};
    var paymentPending = paymentConfirmationPending
      || ['creating', 'open', 'processing', 'pending_webhook'].indexOf(String(pay.paymentAttemptStatus || '')) >= 0
      || Number(pay.pendingRefundCents || 0) > 0;
    var requestPending = (state.changeRequests || []).some(function (request) {
      return ['pending', 'pending_approval', 'needs_clarification', 'awaiting_admin']
        .indexOf(String(request && request.status || '').toLowerCase()) >= 0;
    });
    return paymentPending || requestPending || mutationPending;
  }

  function portalSyncState(info) {
    var el = $('portal-sync-status');
    if (!el || !info) return;
    el.setAttribute('data-state', info.state || 'idle');
    if (info.state === 'updating') {
      // Idle background polls stay quiet — only show "Updating…" when something
      // is actually pending (payment settle, mutation, open request).
      if (portalHasPendingState()) el.textContent = 'Updating…';
    } else if (info.state === 'current') {
      el.textContent = info.lastUpdated
        ? ('Last updated ' + info.lastUpdated.toLocaleTimeString())
        : 'Up to date';
    } else if (info.state === 'retrying') {
      el.textContent = info.status === 429
        ? 'Updates slowed by the server — retrying automatically.'
        : 'Could not refresh — showing the last update and retrying.';
    } else if (info.state === 'offline') {
      el.textContent = 'Offline — showing the last update. Reconnect to refresh.';
    } else if (info.state === 'unauthorized') {
      el.textContent = 'Session expired — sign in again.';
    } else if (info.state === 'paused') {
      el.textContent = 'Updates paused.';
    }
  }

  async function refreshPortalProjection(context) {
    var ok = await portalReload(context);
    if (ok === undefined && !state.booking && !state.session && !state.actionToken) {
      return { ok: true, notModified: true, pending: false };
    }
    if (!ok) {
      var outcome = portalLastLoadOutcome || {};
      var err = new Error(outcome.error || (outcome.status === 429 ? 'rate_limited' : 'refresh_failed'));
      err.status = outcome.status || 0;
      err.retryAfterMs = outcome.retryAfterMs || 0;
      throw err;
    }
    return {
      ok: true,
      notModified: !!portalLastLoadOutcome.notModified,
      changed: !portalLastLoadOutcome.notModified,
      pending: portalHasPendingState(),
    };
  }

  global.cd1MyGarage = {
    submitAction: submitAction,
    openModal: openActionModal,
    reload: portalReload,
    startPayBalance: startPayBalance,
    getPortalPhase: function () { return portalHydration.phase; },
    retryHydration: retryPortalHydration,
    returnToSignIn: returnToPortalSignIn,
    // Test/release helpers — do not call vehicle garage APIs.
    loadAccount: loadAccount,
    hydrateAuthenticatedPortal: hydrateAuthenticatedPortal,
    state: state,
    renderDashboard: renderDashboard,
    syncPayBalanceButton: syncPayBalanceButton,
    primaryActionLabel: primaryActionLabel,
    selectAppointmentByRef: selectAppointmentByRef,
  };

  if (global.CD1OperationalRefresh) {
    portalRefresh = global.CD1OperationalRefresh.createRefreshController({
      controllerKey: 'my-garage',
      activePollMs: 2500,
      stablePollMs: 15000,
      maxBackoffMs: 60000,
      onRefresh: refreshPortalProjection,
      onUpdated: function () {
        var pay = state.payment || {};
        var settled = pay.state === 'paid' || !(pay.canPay || Number(pay.amountDueApproved || 0) > 0);
        if (paymentConfirmationPending && settled) {
          paymentConfirmationPending = false;
          if (state.booking) {
            state.appointmentFocusRef = state.booking.appointmentPublicRef
              || state.booking.id
              || state.appointmentFocusRef;
          }
          showToast('Payment confirmed — thank you!');
        }
      },
      onStateChange: portalSyncState,
      isPending: portalHasPendingState,
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
