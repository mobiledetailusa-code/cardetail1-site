/**
 * Customer portal — dashboard hero layer (calendar, timeline, map).
 * Visual projection from in-memory booking data — no extra API calls.
 */
(function (global) {
  'use strict';

  var api = null;
  var selectedDate = '';
  var bound = false;

  var TIMELINE = [
    { key: 'booked', label: 'Booked' },
    { key: 'confirmed', label: 'Confirmed' },
    { key: 'en_route', label: 'Tech en route' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'completed_paid', label: 'Complete' },
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseDate(str) {
    var p = String(str || '').slice(0, 10).split('-');
    if (p.length !== 3) return new Date();
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
  }

  function bookingDate(b) {
    return String((b && (b.confirmedDate || b.preferredDate)) || '').slice(0, 10);
  }

  function ownedBookings() {
    var list = api && api.getBookings ? api.getBookings() : [];
    var cur = api && api.getBooking ? api.getBooking() : null;
    if (list && list.length) return list;
    return cur ? [cur] : [];
  }

  function apptOnDate(date) {
    return ownedBookings().find(function (b) {
      if (!b) return false;
      var st = String(b.jobStatus || b.status || '').toLowerCase();
      if (st === 'cancelled' || st === 'canceled') return false;
      return bookingDate(b) === date;
    }) || null;
  }

  function timelineStep(b) {
    var st = String((b && (b.jobStatus || b.status)) || '').toLowerCase();
    if (st === 'completed_paid' || st === 'completed') return 4;
    if (['completed_pending_payment', 'completed_pending_admin_review', 'in_progress', 'on_site'].indexOf(st) >= 0) {
      return 3;
    }
    if (['en_route', 'arrived'].indexOf(st) >= 0) return 2;
    if (['confirmed', 'assigned', 'accepted'].indexOf(st) >= 0) return 1;
    return 0;
  }

  function weekAround(dateStr) {
    var base = parseDate(dateStr);
    var dow = base.getDay();
    var sunday = new Date(base);
    sunday.setDate(base.getDate() - dow);
    var today = api && api.todayIso ? api.todayIso() : fmtDate(new Date());
    var out = [];
    for (var i = 0; i < 7; i += 1) {
      var d = new Date(sunday);
      d.setDate(sunday.getDate() + i);
      var date = fmtDate(d);
      out.push({
        date: date,
        dayName: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        dayNum: d.getDate(),
        month: d.toLocaleDateString('en-US', { month: 'short' }),
        isToday: date === today,
        hasAppt: !!apptOnDate(date),
      });
    }
    return out;
  }

  function syncSelectedFromBooking() {
    var b = api && api.getBooking ? api.getBooking() : null;
    selectedDate = bookingDate(b) || (api && api.todayIso ? api.todayIso() : fmtDate(new Date()));
  }

  function jobAddress(b) {
    if (!b) return '';
    if (b.address) return String(b.address).trim();
    if (b.serviceLocation) return String(b.serviceLocation).trim();
    return [b.city, b.state, b.zipCode || b.zip].filter(Boolean).join(', ');
  }

  function mapHtml(b) {
    var addr = jobAddress(b);
    if (!addr) return '';
    var q = encodeURIComponent(addr);
    return '<div class="mg-map">' +
      '<a href="https://maps.google.com/?q=' + q + '" target="_blank" rel="noopener noreferrer">' +
      '<div class="mg-map-inner" aria-hidden="true">' +
      '<span style="font-size:22px;line-height:1">📍</span>' +
      '<span class="mg-map-addr">' + esc(addr) + '</span>' +
      '<span class="mg-map-cta">Open in Maps →</span></div></a></div>';
  }

  function renderCalStrip() {
    var el = document.getElementById('mgCalStrip');
    if (!el) return;
    el.innerHTML = weekAround(selectedDate).map(function (d) {
      var cls = ['mg-cal-day'];
      if (d.isToday) cls.push('today');
      if (d.date === selectedDate) cls.push('sel');
      if (d.hasAppt) cls.push('has-appt');
      return '<button type="button" class="' + cls.join(' ') + '" data-mg-date="' + esc(d.date) + '" aria-pressed="' + (d.date === selectedDate) + '">' +
        '<div class="dn">' + esc(d.dayName) + '</div>' +
        '<div class="dd">' + d.dayNum + '</div>' +
        '<div class="dm">' + esc(d.month) + '</div>' +
        '<div class="jc">' + (d.hasAppt ? '1 appt' : '—') + '</div></button>';
    }).join('');
  }

  function renderBanner() {
    var el = document.getElementById('mgDayBanner');
    if (!el) return;
    var d = parseDate(selectedDate);
    var today = api && api.todayIso ? api.todayIso() : fmtDate(new Date());
    var isToday = selectedDate === today;
    var label = isToday ? 'TODAY' : d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    var appt = apptOnDate(selectedDate);
    var tail = appt
      ? ' · ' + esc(appt.service || appt.package || 'Service')
      : ' · No appointment this day';
    el.innerHTML = '<strong>' + esc(label) + '</strong> — ' +
      esc(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) +
      tail;
  }

  function renderTimeline() {
    var wrap = document.getElementById('mgTimelineWrap');
    var el = document.getElementById('mgTimeline');
    if (!el || !wrap) return;
    var b = api && api.getBooking ? api.getBooking() : null;
    if (!b || bookingDate(b) !== selectedDate) {
      wrap.hidden = true;
      el.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    var step = timelineStep(b);
    el.innerHTML = TIMELINE.map(function (s, i) {
      var cls = 'mg-tl-step';
      if (i < step) cls += ' done';
      if (i === step) cls += ' active';
      var icon = i < step ? '✓' : String(i + 1);
      return '<div class="' + cls + '"><div class="mg-tl-dot">' + icon + '</div>' +
        '<div class="mg-tl-label">' + esc(s.label) + '</div></div>';
    }).join('');
  }

  function renderMap() {
    var el = document.getElementById('mgMap');
    if (!el) return;
    var b = api && api.getBooking ? api.getBooking() : null;
    if (!b || bookingDate(b) !== selectedDate) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = mapHtml(b);
  }

  function renderContractedTotal() {
    var hero = document.getElementById('upcoming-panel');
    if (!hero) return;
    var existing = hero.querySelector('.mg-contracted-total');
    if (existing) existing.remove();
    var b = api && api.getBooking ? api.getBooking() : null;
    if (!b || bookingDate(b) !== selectedDate) return;
    var total = api && api.contractedTotal ? api.contractedTotal(b) : 0;
    if (!total && total !== 0) return;
    var el = document.createElement('div');
    el.className = 'mg-contracted-total';
    el.innerHTML =
      '<div class="mg-total-val">' + esc(api.fmtMoney(total)) + '</div>' +
      '<div class="mg-total-lbl">Total contracted service value</div>';
    var card = hero.querySelector('.card');
    if (card) hero.insertBefore(el, card);
    else hero.insertBefore(el, hero.firstChild);
  }

  function onDashboardClick(e) {
    var btn = e.target.closest('[data-mg-date]');
    if (!btn) return;
    var date = btn.getAttribute('data-mg-date');
    if (!date) return;
    selectedDate = date;
    var appt = apptOnDate(date);
    if (appt && api && api.selectBookingOnDate) {
      api.selectBookingOnDate(date, appt);
      return;
    }
    render();
  }

  function bindPanel() {
    if (bound) return;
    var root = document.getElementById('mg-dashboard');
    if (!root) return;
    root.addEventListener('click', onDashboardClick);
    bound = true;
  }

  function render() {
    if (!api) return;
    var shell = document.getElementById('mg-dashboard');
    var b = api.getBooking ? api.getBooking() : null;
    if (shell) shell.hidden = !b;
    if (!b) return;
    if (!selectedDate) syncSelectedFromBooking();
    renderCalStrip();
    renderBanner();
    renderTimeline();
    renderMap();
    renderContractedTotal();
  }

  function attach(opts) {
    api = opts || {};
    syncSelectedFromBooking();
    bindPanel();
    render();
  }

  global.CD1GarageDashboard = { attach: attach, render: render };
})(window);
