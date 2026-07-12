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
  };

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
    state.verifyPhone = phone;
    state.verifyBookingId = id;
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
    state = { scope: null, booking: null, bookings: [], vehicles: [], session: false, verifyPhone: '', verifyBookingId: '' };
    show($('pre-auth'), true);
    show($('post-auth'), false);
  }

  function fmtMoney(n) {
    var v = Number(n) || 0;
    return '$' + v.toFixed(2);
  }

  function renderDashboard(data) {
    var b = state.booking;
    var hero = $('upcoming-panel');
    if (!hero || !b) {
      if (hero) hero.innerHTML = '<p class="empty">No upcoming appointment. <a href="index.html">Book a service</a>.</p>';
      return;
    }
    var pay = (data && data.payment) || {};
    var offer = b.offer || b.welcomeOffer || null;
    var offerHtml = '';
    if (offer && offer.eligibility_status === 'eligible' && Number(offer.discount_amount) > 0) {
      offerHtml =
        '<div><dt>' + (offer.public_name || 'Welcome offer') + '</dt><dd>-' + fmtMoney((offer.discount_amount || 0) / 100) + '</dd></div>' +
        '<div><dt>Original eligible subtotal</dt><dd>' + fmtMoney((offer.eligible_subtotal || 0) / 100) + '</dd></div>' +
        '<div><dt>Redemption status</dt><dd>' + (offer.redemption_status || 'pending') + '</dd></div>';
    }
    hero.innerHTML =
      '<div class="card">' +
      '<div class="card-kicker">' + (b.status || 'Status') + '</div>' +
      '<h2 class="card-title">' + (b.service || b.package || 'Service') + '</h2>' +
      '<dl class="meta-grid">' +
      '<div><dt>Date</dt><dd>' + (b.confirmedDate || b.preferredDate || '—') + '</dd></div>' +
      '<div><dt>Time</dt><dd>' + (b.confirmedTime || b.preferredTime || '—') + '</dd></div>' +
      '<div><dt>Location</dt><dd>' + (b.address || b.serviceLocation || '—') + '</dd></div>' +
      offerHtml +
      '<div><dt>Approved total</dt><dd>' + fmtMoney(b.approvedFinalAmount != null ? b.approvedFinalAmount : b.totalPrice) + '</dd></div>' +
      (pay.amountDueApproved ? '<div><dt>Amount due</dt><dd>' + fmtMoney(pay.amountDueApproved) + '</dd></div>' : '') +
      '</dl>' +
      (pay.canPay && pay.payLink
        ? '<a class="btn primary" href="' + pay.payLink + '" rel="noopener noreferrer" data-portal-pay>Pay Balance</a>'
        : '') +
      '</div>';

    var payBtn = hero.querySelector('[data-portal-pay]');
    if (payBtn && global.cd1PortalAnalytics) {
      payBtn.addEventListener('click', function () { global.cd1PortalAnalytics.paymentOpened(); });
    }

    renderList('appointments-list', state.bookings.length ? state.bookings : (b ? [b] : []), function (item) {
      return '<li><strong>' + (item.id || '') + '</strong> — ' + (item.status || '') + ' · ' + (item.preferredDate || '—') + '</li>';
    });

    renderList('vehicles-list', state.vehicles, function (v) {
      return '<li>' + (v.label || v.make + ' ' + v.model || 'Vehicle') + '</li>';
    });

    var hist = (state.bookings.length ? state.bookings : [b]).filter(function (x) {
      return x.status === 'Paid' || x.status === 'Completed';
    });
    renderList('history-list', hist, function (item) {
      return '<li>' + (item.preferredDate || '—') + ' · ' + (item.service || item.package || '') + '</li>';
    });

    $('payments-empty') && show($('payments-empty'), !pay.canPay);
    $('vehicles-empty') && show($('vehicles-empty'), !state.vehicles.length);
    $('history-empty') && show($('history-empty'), !hist.length);
    $('maintenance-empty') && show($('maintenance-empty'), true);
    $('comm-empty') && show($('comm-empty'), true);
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
      alert(r.data.pendingApproval ? 'Request submitted for admin review.' : 'Request saved.');
      if (state.scope === 'account') await loadAccount();
      else await loadLimited();
    } else {
      alert((r.data && r.data.message) || 'Unable to submit request. Call/text 551-313-2956.');
    }
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
  }

  async function boot() {
    bindUi();
    if (global.cd1PortalAnalytics) global.cd1PortalAnalytics.opened();

    var params = new URLSearchParams(global.location.search);
    var preId = params.get('bookingId') || params.get('id') || params.get('booking');
    var prePhone = params.get('phone');
    if (preId && $('lk-booking-id')) $('lk-booking-id').value = preId.toUpperCase();
    if (prePhone && $('lk-phone')) $('lk-phone').value = prePhone;

    var actionToken = params.get('action');
    if (actionToken) {
      var ar = await post('customer-portal-action', { action: 'view', token: actionToken });
      if (ar.data && ar.data.ok) {
        state.scope = 'booking';
        state.booking = ar.data.booking;
        history.replaceState({}, '', 'my-garage.html');
        renderDashboard({ payment: { canPay: ar.data.labels && ar.data.labels.canPay } });
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

    show($('pre-auth'), true);
    show($('post-auth'), false);
  }

  global.cd1MyGarage = {
    submitAction: submitAction,
    reload: function () {
      if (state.scope === 'account') return loadAccount();
      return loadLimited();
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
