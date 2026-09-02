/**
 * Admin Ops — Day View tab. Reads the in-memory jobs array; no extra API calls.
 */
(function (global) {
  let api = null;
  let selectedDate = '';
  let heroJobId = null;
  let bound = false;

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

  function todayStr() {
    return api && api.today ? api.today() : fmtDate(new Date());
  }

  function weekDays(anchor) {
    const base = anchor ? new Date(anchor + 'T12:00:00') : new Date();
    const dow = base.getDay();
    const monday = new Date(base);
    monday.setDate(base.getDate() - ((dow + 6) % 7));
    const today = todayStr();
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const date = fmtDate(d);
      out.push({
        date,
        dayName: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        dayNum: d.getDate(),
        month: d.toLocaleDateString('en-US', { month: 'short' }),
        isToday: date === today,
      });
    }
    return out;
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

  function dayJobs(date) {
    return getJobs()
      .filter((j) => jobDate(j) === date && !isHiddenJob(j))
      .sort((a, b) => {
        const ta = parseTimeWindow(a).start;
        const tb = parseTimeWindow(b).start;
        return String(ta).localeCompare(String(tb));
      });
  }

  function upcomingJobs(fromDate) {
    const from = new Date(fromDate + 'T12:00:00');
    const end = new Date(from);
    end.setDate(end.getDate() + 7);
    return getJobs()
      .filter((j) => {
        const d = jobDate(j);
        if (!d || isHiddenJob(j)) return false;
        const jd = new Date(d + 'T12:00:00');
        return jd > from && jd <= end;
      })
      .sort((a, b) => jobDate(a).localeCompare(jobDate(b)));
  }

  function jobCountByDate(date) {
    return dayJobs(date).length;
  }

  function renderBanner(container, dateStr) {
    if (!container) return;
    const d = new Date(dateStr + 'T12:00:00');
    const isToday = dateStr === todayStr();
    const label = isToday ? 'TODAY' : d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    container.innerHTML = 'Schedule for <strong>' + esc(label) + '</strong> ' +
      esc(d.toLocaleDateString('en-US', { weekday: 'long', month: 'numeric', day: 'numeric', year: '2-digit' }));
  }

  function mapHtml(job) {
    const addr = jobAddress(job);
    if (!addr) return '';
    const q = encodeURIComponent(addr);
    return '<div class="dv-map">' +
      '<a href="https://maps.google.com/?q=' + q + '" target="_blank" rel="noopener noreferrer" aria-label="Open in Maps">' +
      '<div class="dv-map-inner" aria-hidden="true">' +
      '<span style="font-size:28px;line-height:1">📍</span>' +
      '<span class="dv-map-addr">' + esc(addr) + '</span>' +
      '<span class="dv-map-cta">Open in Maps →</span>' +
      '</div>' +
      (job.id ? '<span class="dv-map-pin">' + esc(job.id) + '</span>' : '') +
      '</a></div>';
  }

  function renderCalendar() {
    const strip = document.getElementById('dvCalStrip');
    if (!strip) return;
    const days = weekDays(selectedDate).map((d) => Object.assign({}, d, { jobCount: jobCountByDate(d.date) }));
    strip.innerHTML = days.map((d) => {
      const classes = ['dv-cal-day'];
      if (d.isToday) classes.push('today');
      if (d.date === selectedDate) classes.push('sel');
      const label = d.jobCount === 1 ? '1 job' : d.jobCount + ' jobs';
      return '<button type="button" class="' + classes.join(' ') + '" data-date="' + esc(d.date) + '" aria-pressed="' + (d.date === selectedDate) + '">' +
        '<div class="dn">' + esc(d.dayName) + '</div>' +
        '<div class="dd">' + d.dayNum + '</div>' +
        '<div class="dm">' + esc(d.month) + '</div>' +
        '<div class="jc">' + esc(label) + '</div>' +
        '</button>';
    }).join('');
    strip.querySelectorAll('.dv-cal-day').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedDate = btn.dataset.date;
        const list = dayJobs(selectedDate);
        heroJobId = list.length ? list[0].id : null;
        render();
      });
    });
  }

  function renderHero(job) {
    const heroEl = document.getElementById('dvHero');
    const mapEl = document.getElementById('dvMap');
    if (!heroEl || !mapEl) return;
    if (!job) {
      heroEl.innerHTML = '<div class="dv-empty"><div class="ei">📅</div><p>No jobs scheduled for this day</p></div>';
      mapEl.innerHTML = '';
      return;
    }
    const tw = parseTimeWindow(job);
    const total = jobServiceTotal(job) + jobTravelFee(job);
    const svc = jobServiceTotal(job);
    const fee = jobTravelFee(job);
    const tech = (job.assignedTechName || '—');
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
      '<div class="dv-meta-item"><span class="ico">👤</span><div><div class="lbl">Technician</div><div class="val">' + esc(tech) + '</div></div></div>' +
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

  function renderUpcoming() {
    const el = document.getElementById('dvUpcoming');
    if (!el) return;
    const up = upcomingJobs(selectedDate);
    if (!up.length) {
      el.innerHTML = '<div class="dv-empty"><div class="ei">📆</div><p>No upcoming jobs in the next 7 days</p></div>';
      return;
    }
    el.innerHTML = '<div class="dv-sched">' + up.map((j) => {
      const tw = parseTimeWindow(j);
      const d = new Date(jobDate(j) + 'T12:00:00');
      const statusBadge = api.jobBadge ? api.jobBadge(j.jobStatus) : '';
      return '<div class="dv-sched-item" data-dv-job="' + esc(j.id) + '" tabindex="0" role="button">' +
        '<div class="si-time">' + esc(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</div>' +
        '<div class="si-body"><div class="si-name">' + esc(api.customerName(j)) + '</div>' +
        '<div class="si-loc">' + esc(j.package || '—') + ' · ' + esc(tw.start) + '</div></div>' +
        statusBadge + '</div>';
    }).join('') + '</div>';
  }

  function onPanelClick(e) {
    const openBtn = e.target.closest('[data-dv-open]');
    if (openBtn && api.openJob) {
      api.openJob(openBtn.getAttribute('data-dv-open'));
      return;
    }
    const row = e.target.closest('[data-dv-job]');
    if (!row) return;
    const id = row.getAttribute('data-dv-job');
    heroJobId = id;
    const job = getJobs().find((j) => j.id === id);
    renderHero(job || null);
    renderList(selectedDate);
    if (e.type === 'click' && e.detail === 2 && api.openJob) {
      api.openJob(id);
    }
  }

  function bindPanel() {
    if (bound) return;
    const panel = document.getElementById('p-dayview');
    if (!panel) return;
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('dblclick', onPanelClick);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('[data-dv-job]');
      if (!row) return;
      e.preventDefault();
      onPanelClick({ target: row, type: 'click', detail: 1 });
    });
    bound = true;
  }

  function render() {
    if (!api) return;
    if (!selectedDate) selectedDate = todayStr();
    renderCalendar();
    renderBanner(document.getElementById('dvCalBanner'), selectedDate);
    const list = dayJobs(selectedDate);
    if (!heroJobId || !list.some((j) => j.id === heroJobId)) {
      heroJobId = list.length ? list[0].id : null;
    }
    const hero = heroJobId ? list.find((j) => j.id === heroJobId) : null;
    renderHero(hero || null);
    renderList(selectedDate);
    renderUpcoming();
  }

  function isActive() {
    const panel = document.getElementById('p-dayview');
    return !!(panel && panel.classList.contains('on'));
  }

  function attach(opts) {
    api = opts || {};
    if (!selectedDate) selectedDate = todayStr();
    bindPanel();
    render();
  }

  global.CD1AdminDayView = {
    attach,
    render,
    isActive,
  };
})(window);
