/**
 * Customer portal — dashboard hero layer (month calendar, timeline, map).
 * Visual projection from in-memory booking data — no extra API calls.
 */
(function (global) {
  'use strict';

  var api = null;
  var selectedDate = '';
  var viewYear = 0;
  var viewMonth = 0;
  var bound = false;

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  function todayStr() {
    return api && api.todayIso ? api.todayIso() : fmtDate(new Date());
  }

  function bookingDate(b) {
    return String((b && (b.confirmedDate || b.preferredDate)) || '').slice(0, 10);
  }

  function isCancelled(b) {
    var st = String((b && (b.jobStatus || b.status)) || '').toLowerCase();
    return st === 'cancelled' || st === 'canceled';
  }

  function ownedBookings() {
    var list = api && api.getBookings ? api.getBookings() : [];
    var cur = api && api.getBooking ? api.getBooking() : null;
    if (list && list.length) return list;
    return cur ? [cur] : [];
  }

  function bookingsOnDate(date) {
    return ownedBookings().filter(function (b) {
      return b && !isCancelled(b) && bookingDate(b) === date;
    });
  }

  function apptOnDate(date) {
    var list = bookingsOnDate(date);
    if (!list.length) return null;
    var cur = api && api.getBooking ? api.getBooking() : null;
    if (cur && bookingDate(cur) === date && !isCancelled(cur)) {
      var match = list.find(function (b) { return b.id === cur.id; });
      if (match) return match;
    }
    return list[0];
  }

  function syncViewToSelected() {
    var d = parseDate(selectedDate || todayStr());
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
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

  function monthGrid(year, month) {
    var first = new Date(year, month, 1);
    var start = new Date(first);
    start.setDate(1 - first.getDay());
    var today = todayStr();
    var cells = [];
    for (var i = 0; i < 42; i += 1) {
      var d = new Date(start);
      d.setDate(start.getDate() + i);
      var date = fmtDate(d);
      var list = bookingsOnDate(date);
      cells.push({
        date: date,
        dayNum: d.getDate(),
        inMonth: d.getMonth() === month,
        isToday: date === today,
        jobCount: list.length,
      });
    }
    return cells;
  }

  function weekAround(dateStr) {
    var base = parseDate(dateStr);
    var dow = base.getDay();
    var sunday = new Date(base);
    sunday.setDate(base.getDate() - dow);
    var today = todayStr();
    var out = [];
    for (var i = 0; i < 7; i += 1) {
      var d = new Date(sunday);
      d.setDate(sunday.getDate() + i);
      var date = fmtDate(d);
      var count = bookingsOnDate(date).length;
      out.push({
        date: date,
        dayName: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        dayNum: d.getDate(),
        month: d.toLocaleDateString('en-US', { month: 'short' }),
        isToday: date === today,
        jobCount: count,
      });
    }
    return out;
  }

  function syncSelectedFromBooking() {
    var b = api && api.getBooking ? api.getBooking() : null;
    selectedDate = bookingDate(b) || todayStr();
    syncViewToSelected();
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

  function dotsHtml(count) {
    if (!count) return '';
    if (count <= 3) {
      var html = '<div class="mg-dots">';
      for (var i = 0; i < count; i += 1) html += '<span class="mg-dot"></span>';
      return html + '</div>';
    }
    return '<div class="mg-jc">' + count + '</div>';
  }

  function renderMonthLabel() {
    var el = document.getElementById('mgMonthLabel');
    if (!el) return;
    var d = new Date(viewYear, viewMonth, 1);
    el.textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function renderMonthGrid() {
    var grid = document.getElementById('mgMonthGrid');
    if (!grid) return;
    var cells = monthGrid(viewYear, viewMonth);
    var html = DOW.map(function (d) {
      return '<div class="mg-dow">' + d + '</div>';
    }).join('');
    html += cells.map(function (c) {
      var classes = ['mg-month-cell'];
      if (!c.inMonth) classes.push('out');
      if (c.isToday) classes.push('today');
      if (c.date === selectedDate) classes.push('sel');
      if (c.jobCount) classes.push('has-appt');
      var title = c.jobCount
        ? (c.jobCount === 1 ? '1 appointment' : c.jobCount + ' appointments')
        : 'No appointments';
      return '<button type="button" class="' + classes.join(' ') + '" data-mg-date="' + esc(c.date) +
        '" aria-pressed="' + (c.date === selectedDate) + '" title="' + esc(title) + '">' +
        '<span class="num">' + c.dayNum + '</span>' +
        (c.jobCount ? '<div class="dots">' + dotsHtml(c.jobCount) + '</div>' : '') +
        '</button>';
    }).join('');
    grid.innerHTML = html;
  }

  function renderCalStrip() {
    var el = document.getElementById('mgCalStrip');
    if (!el) return;
    el.innerHTML = weekAround(selectedDate).map(function (d) {
      var cls = ['mg-cal-day'];
      if (d.isToday) cls.push('today');
      if (d.date === selectedDate) cls.push('sel');
      if (d.jobCount) cls.push('has-appt');
      var jc = d.jobCount === 1 ? '1 appt' : (d.jobCount ? d.jobCount + ' appts' : '—');
      return '<button type="button" class="' + cls.join(' ') + '" data-mg-date="' + esc(d.date) +
        '" aria-pressed="' + (d.date === selectedDate) + '">' +
        '<div class="dn">' + esc(d.dayName) + '</div>' +
        '<div class="dd">' + d.dayNum + '</div>' +
        '<div class="dm">' + esc(d.month) + '</div>' +
        '<div class="jc">' + esc(jc) + '</div></button>';
    }).join('');
  }

  function renderBanner() {
    var el = document.getElementById('mgDayBanner');
    if (!el) return;
    var d = parseDate(selectedDate);
    var isToday = selectedDate === todayStr();
    var label = isToday ? 'TODAY' : d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    var list = bookingsOnDate(selectedDate);
    var tail;
    if (!list.length) {
      tail = ' · No appointment this day';
    } else if (list.length === 1) {
      tail = ' · ' + esc(list[0].service || list[0].package || 'Service');
    } else {
      tail = ' · ' + list.length + ' appointments';
    }
    el.innerHTML = '<strong>' + esc(label) + '</strong> — ' +
      esc(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) +
      tail;
  }

  function renderMonthStats() {
    var el = document.getElementById('mgMonthStats');
    if (!el) return;
    var upcoming = 0;
    var past = 0;
    var monthCount = 0;
    var today = todayStr();
    ownedBookings().forEach(function (b) {
      if (!b || isCancelled(b)) return;
      var d = bookingDate(b);
      if (!d) return;
      var parsed = parseDate(d);
      if (parsed.getFullYear() === viewYear && parsed.getMonth() === viewMonth) {
        monthCount += 1;
      }
      if (d >= today) upcoming += 1;
      else past += 1;
    });
    el.innerHTML =
      '<div class="mg-stat accent"><div class="lbl">This month</div><div class="val">' + monthCount + '</div></div>' +
      '<div class="mg-stat"><div class="lbl">Upcoming</div><div class="val">' + upcoming + '</div></div>' +
      '<div class="mg-stat"><div class="lbl">Past</div><div class="val">' + past + '</div></div>';
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

  function selectDate(date, opts) {
    selectedDate = date;
    if (!opts || opts.syncView !== false) syncViewToSelected();
    var appt = apptOnDate(date);
    if (appt && api && api.selectBookingOnDate) {
      api.selectBookingOnDate(date, appt);
      return;
    }
    render();
  }

  function onDashboardClick(e) {
    var nav = e.target.closest('[data-mg-cal-nav]');
    if (nav) {
      var action = nav.getAttribute('data-mg-cal-nav');
      if (action === 'prev') {
        viewMonth -= 1;
        if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
        render();
      } else if (action === 'next') {
        viewMonth += 1;
        if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
        render();
      } else if (action === 'today') {
        selectDate(todayStr());
      }
      return;
    }
    var btn = e.target.closest('[data-mg-date]');
    if (!btn) return;
    var date = btn.getAttribute('data-mg-date');
    if (!date) return;
    var parsed = parseDate(date);
    if (parsed.getFullYear() !== viewYear || parsed.getMonth() !== viewMonth) {
      viewYear = parsed.getFullYear();
      viewMonth = parsed.getMonth();
    }
    selectDate(date, { syncView: false });
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
    if (!viewYear) syncViewToSelected();
    renderMonthLabel();
    renderMonthStats();
    renderMonthGrid();
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
