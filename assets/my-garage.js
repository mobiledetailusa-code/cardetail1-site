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
    catalog: null,
    changeRequests: [],
    payment: null,
  };

  var modalAction = null;
  var modalMode = 'fields';
  var modalFields = [];

  function $(id) { return document.getElementById(id); }

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
    if (parts) return parts + (b.vehicleCategory ? ' · ' + b.vehicleCategory : '');
    return b.vehicleLabel || b.vehicle || '—';
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

  async function loadLimited() {
    var id = state.verifyBookingId || ($('lk-booking-id') && $('lk-booking-id').value.trim().toUpperCase());
    var phone = normalizePhoneInput(state.verifyPhone || ($('lk-phone') && $('lk-phone').value));
    if (!id || phone.length < 10) {
      setMsg($('lk-error'), 'Enter your booking ID and phone number.', true);
      return false;
    }
    var r = await post('customer-portal-data', { mode: 'limited', bookingId: id, phone: phone });
    if (!r.data || !r.data.ok) {
      setMsg($('lk-error'), (r.data && r.data.message) || 'No booking found. Check your ID and phone.', true);
      return false;
    }
    state.scope = 'booking';
    state.booking = r.data.booking;
    state.bookings = r.data.booking ? [r.data.booking] : [];
    state.verifyPhone = phone;
    state.verifyBookingId = id;
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

  async function logout() {
    await post('customer-portal-auth', { action: 'logout' });
    state = {
      scope: null, booking: null, bookings: [], vehicles: [],
      session: false, verifyPhone: '', verifyBookingId: '',
      catalog: null, changeRequests: [], payment: null,
    };
    show($('pre-auth'), true);
    show($('post-auth'), false);
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
      link.textContent = 'Pay Balance';
    }
  }

  function renderPaymentsPanel(pay) {
    var panel = $('payments-panel');
    var empty = $('payments-empty');
    if (!panel) return;
    var due = Number(pay.amountDueApproved || 0);
    var can = !!(pay.canPay || pay.canCreatePayLink);
    if (!can && !(due > 0) && !(Number(pay.approvedTotal || 0) > 0)) {
      panel.innerHTML = '';
      if (empty) show(empty, true);
      return;
    }
    if (empty) show(empty, false);
    panel.innerHTML =
      '<div class="card pay-card">' +
      '<dl class="meta-grid">' +
      '<div><dt>Payment status</dt><dd>' + esc(pay.state || '—') + '</dd></div>' +
      '<div><dt>Approved total</dt><dd>' + fmtMoney(pay.approvedTotal) + '</dd></div>' +
      '<div><dt>Amount paid</dt><dd>' + fmtMoney(pay.amountPaid) + '</dd></div>' +
      '<div><dt>Amount due</dt><dd>' + fmtMoney(due) + '</dd></div>' +
      '</dl>' +
      (can
        ? '<button type="button" class="btn primary" id="btn-pay-balance">Pay ' +
          (due > 0 ? fmtMoney(due) : 'Balance') + ' securely</button>' +
          '<p class="hint">Secure Stripe Checkout (card only). Your approved balance updates if add-ons or package changes are approved.</p>'
        : '<p class="hint">No balance is due yet, or payment is locked until admin approval.</p>') +
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
      '<div><dt>Approved total</dt><dd>' + fmtMoney(b.approvedFinalAmount != null ? b.approvedFinalAmount : b.totalPrice) + '</dd></div>' +
      (pay.amountPaid ? '<div><dt>Paid</dt><dd>' + fmtMoney(pay.amountPaid) + '</dd></div>' : '') +
      (pay.amountDueApproved ? '<div><dt>Amount due</dt><dd>' + fmtMoney(pay.amountDueApproved) + '</dd></div>' : '') +
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

  async function submitAction(action, payload) {
    if (!state.booking) return;
    var phone = state.verifyPhone || normalizePhoneInput(state.booking.phone);
    var body = Object.assign({ bookingId: state.booking.id, phone: phone, action: action }, payload || {});
    if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.changeRequested();
    var r = await post('submit-customer-action', body);
    if (r.data && r.data.ok) {
      showToast(r.data.pendingApproval ? 'Request submitted for admin review.' : 'Request saved.');
      if (state.scope === 'account') await loadAccount();
      else await loadLimited();
      return true;
    }
    showToast((r.data && r.data.message) || 'Unable to submit request. Call/text 551-313-2956.', true);
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

  async function startPayBalance() {
    if (!state.booking) {
      showToast('Open a booking first.', true);
      return;
    }
    var pay = state.payment || {};
    if (pay.payLink && pay.canPay) {
      if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.paymentOpened();
      global.location.href = pay.payLink;
      return;
    }
    if (!pay.canPay && !pay.canCreatePayLink) {
      showToast('No balance is due yet, or payment is locked until approval.', true);
      return;
    }
    var phone = state.verifyPhone || normalizePhoneInput(state.booking.phone);
    showToast('Preparing secure checkout…');
    var r = await post('customer-portal-pay', {
      bookingId: state.booking.id,
      phone: phone,
    });
    if (r.data && r.data.ok && r.data.url) {
      if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.paymentOpened();
      global.location.href = r.data.url;
      return;
    }
    showToast((r.data && r.data.message) || 'Payment is not available yet.', true);
  }

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
    var cat = getCatalog();
    var packs = cat.packages || [];
    if (!packs.length) {
      showToast('Package list unavailable. Refresh and try again.', true);
      return false;
    }
    var form = $('modal-form');
    form.innerHTML =
      '<p class="hint">Select a package. The proposed total updates from the catalog; admin approval applies it to your invoice.</p>' +
      '<div class="modal-catalog" role="radiogroup" aria-label="Packages">' +
      packs.map(function (p) {
        return '<label class="catalog-option">' +
          '<input type="radio" name="newPackId" value="' + esc(p.id) + '" required>' +
          '<span class="opt-body">' +
          '<span class="opt-name">' + esc(p.name) + '</span>' +
          '<span class="opt-price">' + fmtMoney(p.basePrice) + '</span>' +
          '<span class="opt-meta">' + esc(p.duration || '') + (p.tag ? ' · ' + esc(p.tag) : '') + '</span>' +
          '<span class="opt-desc">' + esc(p.description || '') + '</span>' +
          '</span></label>';
      }).join('') +
      '</div>' +
      '<p class="modal-live-total" id="mf-package-proposed">Proposed package price: —</p>';
    form.querySelectorAll('input[name="newPackId"]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var pack = packs.find(function (x) { return x.id === inp.value; });
        var el = $('mf-package-proposed');
        if (el && pack) el.textContent = 'Proposed package price: ' + fmtMoney(pack.basePrice) + ' (+ travel/add-ons as approved)';
      });
    });
    return true;
  }

  function updateAddonLiveTotal() {
    var form = $('modal-form');
    if (!form) return;
    var sum = 0;
    form.querySelectorAll('input[name="addonIds"]:checked').forEach(function (inp) {
      sum += Number(inp.getAttribute('data-price') || 0);
    });
    var base = bookingBaseTotal(state.booking);
    var el = $('mf-addon-total');
    if (el) {
      el.textContent = 'Add-ons: ' + fmtMoney(sum) + ' · New proposed total: ' + fmtMoney(base + sum);
    }
  }

  function renderAddonModal() {
    var cat = getCatalog();
    var addons = cat.addons || [];
    if (!addons.length) {
      showToast('Add-on list unavailable. Refresh and try again.', true);
      return false;
    }
    var form = $('modal-form');
    form.innerHTML =
      '<p class="hint">Select add-ons to request. Totals are proposed until admin approval, then locked for Stripe payment.</p>' +
      '<div class="modal-catalog">' +
      addons.map(function (a) {
        return '<label class="catalog-option">' +
          '<input type="checkbox" name="addonIds" value="' + esc(a.id) + '" data-price="' + esc(a.price) + '">' +
          '<span class="opt-body">' +
          '<span class="opt-name">' + esc(a.name) + '</span>' +
          '<span class="opt-price">+' + fmtMoney(a.price) + '</span>' +
          '<span class="opt-desc">' + esc(a.desc || '') + '</span>' +
          '</span></label>';
      }).join('') +
      '</div>' +
      '<p class="modal-live-total" id="mf-addon-total">Add-ons: $0.00 · New proposed total: ' +
      fmtMoney(bookingBaseTotal(state.booking)) + '</p>';
    form.querySelectorAll('input[name="addonIds"]').forEach(function (inp) {
      inp.addEventListener('change', updateAddonLiveTotal);
    });
    return true;
  }

  function renderVehicleModal(titleHint) {
    var cat = getCatalog();
    var cats = cat.vehicleCategories || [];
    var years = cat.vehicleYears || [];
    var form = $('modal-form');
    form.innerHTML =
      '<p class="hint">' + esc(titleHint || 'Select vehicle details. No admin approval is needed to pick category / year / make / model.') + '</p>' +
      '<label for="mf-category">Category</label>' +
      '<select class="inp" id="mf-category" name="category" required>' +
      '<option value="">Select…</option>' +
      cats.map(function (c) {
        return '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>';
      }).join('') +
      '</select>' +
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
      return { newPackId: pack.value };
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
      return { category: category, year: year, make: make, model: model };
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
    if (!modalAction) return;
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

    var ok = false;
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
    } else {
      ok = await submitAction(modalAction, payload);
    }
    if (ok) closeModal();
  }

  function bindUi() {
    var lkForm = $('lk-form');
    if (lkForm) {
      lkForm.addEventListener('submit', function (e) {
        e.preventDefault();
        loadLimited();
      });
    }
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
  }

  async function boot() {
    bindUi();
    if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.opened();

    var params = new URLSearchParams(global.location.search);
    var preId = params.get('bookingId') || params.get('id') || params.get('booking');
    var prePhone = params.get('phone');
    if (preId && $('lk-booking-id')) $('lk-booking-id').value = preId.toUpperCase();
    if (prePhone && $('lk-phone')) $('lk-phone').value = prePhone;

    if (params.get('paid') === '1') {
      showToast('Payment received. Thank you!');
    } else if (params.get('canceled') === '1') {
      showToast('Checkout canceled. You can pay anytime from My Garage.', true);
    }

    var actionToken = params.get('action');
    if (actionToken) {
      var ar = await post('customer-portal-action', { action: 'view', token: actionToken });
      if (ar.data && ar.data.ok) {
        state.scope = 'booking';
        state.booking = ar.data.booking;
        applyPortalPayload(ar.data);
        history.replaceState({}, '', 'my-garage.html');
        renderDashboard({ payment: ar.data.payment || { canPay: ar.data.labels && ar.data.labels.canPay } });
        show($('pre-auth'), false);
        show($('post-auth'), true);
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
      return;
    }

    if (preId && prePhone) {
      await loadLimited();
      return;
    }

    show($('pre-auth'), true);
    show($('post-auth'), false);
  }

  function portalReload() {
    if (state.scope === 'account') return loadAccount();
    if (state.booking) return loadLimited();
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
      shouldPoll: function () { return !!state.booking || state.session; },
    });
    portalRefresh.bindLifecycle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
