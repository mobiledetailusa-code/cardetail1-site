/**
 * Admin Ops — Schedule dashboard. Month calendar + day detail; reads in-memory jobs only.
 */
(function (global) {
  let api = null;
  let selectedDate = '';
  let viewYear = 0;
  let viewMonth = 0;
  let heroJobId = null;
  let bound = false;
  let jobCountCache = null;

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const NEEDS_ATTENTION = new Set([
    'issue_reported', 'completed_pending_admin_review', 'completed_pending_payment', 'reopened', 'pending_review',
  ]);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseDate(str) {
    const p = String(str || '').slice(0, 10).split('-');
    if (p.length !== 3) return new Date();
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0);
  }

  function todayStr() {
    return api && api.today ? api.today() : fmtDate(new Date());
  }

  function syncViewToSelected() {
    const d = parseDate(selectedDate || todayStr());
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
  }

  function jobDate(j) {
    return String((j && (j.confirmedDate || j.preferredDate)) || '').slice(0, 10);
  }

  function parseTimeWindow(j) {
    const raw = (j && (j.confirmedTimeWindow || j.preferredTime)) || '';
    const s = String(raw).trim();
    if (!s) return { start: 'TBD', end: '' };
    const parts = s.split(/\s*[–-]\s*/);
    if (parts.length >= 2) return { start: parts[0].trim(), end: parts[1].trim() };
    return { start: s, end: '' };
  }

  function jobEta(j) {
    return (j && (j.confirmedTime || j.confirmedTimeWindow || j.preferredTime)) || parseTimeWindow(j).start;
  }

  function jobAddress(j) {
    if (!j) return '';
    if (j.address) return String(j.address).trim();
    if (j.requestedAddress) return String(j.requestedAddress).trim();
    return [j.city, j.state, j.zipCode || j.zip].filter(Boolean).join(', ');
  }

  function jobServiceTotal(j) {
    if (!j) return 0;
    if (j.approvedFinalAmount != null && Number.isFinite(Number(j.approvedFinalAmount))) {
      return Number(j.approvedFinalAmount);
    }
    if (j.approvedCents != null && Number.isFinite(Number(j.approvedCents))) {
      return Number(j.approvedCents) / 100;
    }
    return 0;
  }

  function jobTravelFee(j) {
    if (!j) return 0;
    const fee = j.travelFeeAmount != null ? j.travelFeeAmount : j.zoneSurcharge;
    return Math.max(0, Number(fee || 0));
  }

  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '$0.00';
    return '$' + v.toFixed(2);
  }

  function isHiddenJob(j) {
    const st = String((j && j.jobStatus) || '');
    return st === 'cancelled' || st === 'archived_test';
  }

  function getJobs() {
    return api && typeof api.getJobs === 'function' ? api.getJobs() : [];
  }

  function rebuildJobCache() {
    jobCountCache = new Map();
    const attention = new Map();
    getJobs().forEach((j) => {
      const d = jobDate(j);
      if (!d || isHiddenJob(j)) return;
      jobCountCache.set(d, (jobCountCache.get(d) || 0) + 1);
      if (NEEDS_ATTENTION.has(j.jobStatus) || j.customerChangePending) {
        attention.set(d, (attention.get(d) || 0) + 1);
      }
    });
    jobCountCache._attention = attention;
    return jobCountCache;
  }

  function jobCountByDate(date) {
    if (!jobCountCache) rebuildJobCache();
    return jobCountCache.get(date) || 0;
  }

  function attentionCountByDate(date) {
    if (!jobCountCache) rebuildJobCache();
    return (jobCountCache._attention && jobCountCache._attention.get(date)) || 0;
  }

  function dayJobs(date) {
    return getJobs()
      .filter((j) => jobDate(j) === date && !isHiddenJob(j))
      .sort((a, b) => String(parseTimeWindow(a).start).localeCompare(String(parseTimeWindow(b).start)));
  }

  function monthJobTotal(year, month) {
    let n = 0;
    const last = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= last; day++) {
      n += jobCountByDate(fmtDate(new Date(year, month, day)));
    }
    return n;
  }

  function monthGrid(year, month) {
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const today = todayStr();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const date = fmtDate(d);
      cells.push({
        date,
        dayNum: d.getDate(),
        inMonth: d.getMonth() === month,
        isToday: date === today,
        jobCount: jobCountByDate(date),
        attention: attentionCountByDate(date),
      });
    }
    return cells;
  }

  function weekAround(dateStr) {
    const base = parseDate(dateStr);
    const dow = base.getDay();
    const sunday = new Date(base);
    sunday.setDate(base.getDate() - dow);
    const today = todayStr();
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday);
      d.setDate(sunday.getDate() + i);
      const date = fmtDate(d);
      const jc = jobCountByDate(date);
      out.push({
        date,
        dayName: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        dayNum: d.getDate(),
        isToday: date === today,
        jobCount: jc,
      });
    }
    return out;
  }

  function selectDate(date, opts) {
    selectedDate = date;
    if (!opts || opts.syncView !== false) syncViewToSelected();
    const list = dayJobs(date);
    heroJobId = list.length ? list[0].id : null;
    render();
  }

  function renderMonthLabel() {
    const el = document.getElementById('dvMonthLabel');
    if (!el) return;
    const d = new Date(viewYear, viewMonth, 1);
    el.textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function renderStats() {
    const el = document.getElementById('dvCalStats');
    if (!el) return;
    const monthTotal = monthJobTotal(viewYear, viewMonth);
    const todayCount = jobCountByDate(todayStr());
    const selCount = jobCountByDate(selectedDate);
    el.innerHTML =
      '<div class="dv-stat accent"><div class="lbl">This month</div><div class="val">' + monthTotal + '</div></div>' +
      '<div class="dv-stat"><div class="lbl">Today</div><div class="val">' + todayCount + '</div></div>' +
      '<div class="dv-stat"><div class="lbl">Selected day</div><div class="val">' + selCount + '</div></div>';
  }

  function dotsHtml(count, attention) {
    if (!count) return '';
    if (count <= 3) {
      let html = '<div class="dv-dots">';
      const warnN = Math.min(attention || 0, count);
      for (let i = 0; i < count; i++) {
        html += '<span class="dv-dot' + (i < warnN ? ' warn' : '') + '"></span>';
      }
      html += '</div>';
      return html;
    }
    return '<div class="dv-jc">' + count + ' jobs</div>';
  }

  function renderMonthGrid() {
    const grid = document.getElementById('dvMonthGrid');
    if (!grid) return;
    const cells = monthGrid(viewYear, viewMonth);
    let html = DOW.map((d) => '<div class="dv-dow">' + d + '</div>').join('');
    html += cells.map((c) => {
      const classes = ['dv-month-cell'];
      if (!c.inMonth) classes.push('out');
      if (c.isToday) classes.push('today');
      if (c.date === selectedDate) classes.push('sel');
      if (c.jobCount) classes.push('has-jobs');
      return '<button type="button" class="' + classes.join(' ') + '" data-dv-date="' + esc(c.date) + '" aria-pressed="' + (c.date === selectedDate) + '">' +
        '<span class="num">' + c.dayNum + '</span>' +
        (c.jobCount ? '<div class="dots">' + dotsHtml(c.jobCount, c.attention) + '</div>' : '') +
        '</button>';
    }).join('');
    grid.innerHTML = html;
  }

  function renderWeekStrip() {
    const strip = document.getElementById('dvWeekStrip');
    if (!strip) return;
    const days = weekAround(selectedDate);
    strip.innerHTML = days.map((d) => {
      const classes = ['dv-week-day'];
      if (d.isToday) classes.push('today');
      if (d.date === selectedDate) classes.push('sel');
      const jc = d.jobCount === 1 ? '1 job' : (d.jobCount ? d.jobCount + ' jobs' : '—');
      return '<button type="button" class="' + classes.join(' ') + '" data-dv-date="' + esc(d.date) + '" aria-pressed="' + (d.date === selectedDate) + '">' +
        '<div class="dn">' + esc(d.dayName) + '</div>' +
        '<div class="dd">' + d.dayNum + '</div>' +
        '<div class="jc">' + esc(jc) + '</div></button>';
    }).join('');
  }

  function renderBanner(container, dateStr) {
    if (!container) return;
    const d = parseDate(dateStr);
    const isToday = dateStr === todayStr();
    const label = isToday ? 'TODAY' : d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    const count = jobCountByDate(dateStr);
    const countNote = count ? ' · ' + count + ' appointment' + (count === 1 ? '' : 's') : '';
    container.innerHTML = '<strong>' + esc(label) + '</strong> — ' +
      esc(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) +
      esc(countNote);
  }

  function mapHtml(job) {
    const addr = jobAddress(job);
    if (!addr) return '';
    const q = encodeURIComponent(addr);
    return '<div class="dv-map">' +
      '<a href="https://maps.google.com/?q=' + q + '" target="_blank" rel="noopener noreferrer">' +
      '<div class="dv-map-inner" aria-hidden="true">' +
      '<span style="font-size:24px;line-height:1">📍</span>' +
      '<span class="dv-map-addr">' + esc(addr) + '</span>' +
      '<span class="dv-map-cta">Open in Maps →</span></div>' +
      (job.id ? '<span class="dv-map-pin">' + esc(job.id) + '</span>' : '') +
      '</a></div>';
  }

  function renderHero(job) {
    const heroEl = document.getElementById('dvHero');
    const mapEl = document.getElementById('dvMap');
    if (!heroEl || !mapEl) return;
    if (!job) {
      heroEl.innerHTML = '<div class="dv-empty"><div class="ei">📅</div><p>No appointments on this day</p></div>';
      mapEl.innerHTML = '';
      return;
    }
    const total = jobServiceTotal(job) + jobTravelFee(job);
    const svc = jobServiceTotal(job);
    const fee = jobTravelFee(job);
    const vehicle = api.vehicleSummary ? api.vehicleSummary(job) : (job.vehicleLabel || job.vehicle || '—');
    const statusBadge = api.jobBadge ? api.jobBadge(job.jobStatus) : '';
    const feeNote = fee > 0 ? ' · fee ' + money(fee) : '';
    heroEl.innerHTML =
      '<article class="dv-hero" data-job="' + esc(job.id) + '">' +
      '<div class="dv-hero-top">' +
      '<div><div class="dv-hero-name">' + esc(api.customerName(job)) + '</div>' +
      '<div class="dv-hero-badges"><span class="dv-hero-id">' + esc(job.id) + '</span>' + statusBadge + '</div></div>' +
      '<div class="dv-hero-price">' + money(total) +
      '<span class="sub">svc ' + money(svc) + feeNote + '</span></div></div>' +
      '<div class="dv-meta">' +
      '<div class="dv-meta-item"><span class="ico">🕐</span><div><div class="lbl">Window</div><div class="val">' + esc(jobEta(job)) + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">🚗</span><div><div class="lbl">Vehicle</div><div class="val">' + esc(vehicle) + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">👤</span><div><div class="lbl">Technician</div><div class="val">' + esc(job.assignedTechName || '—') + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">📍</span><div><div class="lbl">Location</div><div class="val">' + esc(jobAddress(job) || '—') + '</div></div></div>' +
      '</div>' +
      '<div class="dv-actions">' +
      '<button type="button" class="btn sm" data-dv-open="' + esc(job.id) + '">Manage Appointment</button>' +
      '</div></article>';
    mapEl.innerHTML = jobAddress(job) ? mapHtml(job) : '';
  }

  function renderList(date) {
    const el = document.getElementById('dvSchedList');
    if (!el) return;
    const list = dayJobs(date);
    if (!list.length) {
      el.innerHTML = '<div class="dv-empty"><p>No appointments this day</p></div>';
      return;
    }
    el.innerHTML = '<div class="dv-sched">' + list.map((j) => {
      const tw = parseTimeWindow(j);
      const end = tw.end || tw.start;
      const active = j.id === heroJobId ? ' is-active' : '';
      const total = jobServiceTotal(j) + jobTravelFee(j);
      const loc = jobAddress(j) || (j.package || '—');
      return '<div class="dv-sched-item' + active + '" data-dv-job="' + esc(j.id) + '" tabindex="0" role="button">' +
        '<div class="si-time">' + esc(tw.start) + '<br>– ' + esc(end) + '</div>' +
        '<div class="si-body"><div class="si-name">' + esc(api.customerName(j)) + '</div>' +
        '<div class="si-loc">' + esc(loc) + '</div></div>' +
        '<div class="si-price">' + money(total) + '</div></div>';
    }).join('') + '</div>';
  }

  function onPanelClick(e) {
    const nav = e.target.closest('[data-dv-cal-nav]');
    if (nav) {
      const action = nav.getAttribute('data-dv-cal-nav');
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
    const dateBtn = e.target.closest('[data-dv-date]');
    if (dateBtn) {
      const d = dateBtn.getAttribute('data-dv-date');
      const parsed = parseDate(d);
      if (parsed.getFullYear() !== viewYear || parsed.getMonth() !== viewMonth) {
        viewYear = parsed.getFullYear();
        viewMonth = parsed.getMonth();
      }
      selectDate(d, { syncView: false });
      return;
    }
    const openBtn = e.target.closest('[data-dv-open]');
    if (openBtn && api.openJob) {
      api.openJob(openBtn.getAttribute('data-dv-open'));
      return;
    }
    const jobsTab = e.target.closest('[data-dv-goto-jobs]');
    if (jobsTab) {
      const tab = document.querySelector('#tabs .tab[data-tab="jobs"]');
      if (tab) tab.click();
      return;
    }
    const row = e.target.closest('[data-dv-job]');
    if (!row) return;
    const id = row.getAttribute('data-dv-job');
    heroJobId = id;
    const job = getJobs().find((j) => j.id === id);
    renderHero(job || null);
    renderList(selectedDate);
    if (e.type === 'click' && e.detail === 2 && api.openJob) api.openJob(id);
  }

  function bindPanel() {
    if (bound) return;
    const panel = document.getElementById('p-dayview');
    if (!panel) return;
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('dblclick', onPanelClick);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('[data-dv-job],[data-dv-date]');
      if (!row) return;
      e.preventDefault();
      onPanelClick({ target: row, type: 'click', detail: 1 });
    });
    bound = true;
  }

  function render() {
    if (!api) return;
    if (!selectedDate) selectedDate = todayStr();
    rebuildJobCache();
    renderMonthLabel();
    renderStats();
    renderMonthGrid();
    renderWeekStrip();
    renderBanner(document.getElementById('dvCalBanner'), selectedDate);
    const list = dayJobs(selectedDate);
    if (!heroJobId || !list.some((j) => j.id === heroJobId)) {
      heroJobId = list.length ? list[0].id : null;
    }
    renderHero(heroJobId ? list.find((j) => j.id === heroJobId) : null);
    renderList(selectedDate);
  }

  function isActive() {
    const panel = document.getElementById('p-dayview');
    return !!(panel && panel.classList.contains('on'));
  }

  function attach(opts) {
    api = opts || {};
    if (!selectedDate) selectedDate = todayStr();
    syncViewToSelected();
    bindPanel();
    render();
  }

  global.CD1AdminDayView = { attach, render, isActive };
})(window);
