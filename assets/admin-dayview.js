/**
 * Admin Ops — Schedule command center. Rich operational projection from in-memory jobs.
 */
(function (global) {
  let api = null;
  let selectedDate = '';
  let viewYear = 0;
  let viewMonth = 0;
  let heroJobId = null;
  let dayFilter = 'all';
  let daySearch = '';
  let bound = false;
  let opsCache = null;

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PIPELINE_DAYS = 14;
  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs action' },
    { id: 'unassigned', label: 'Unassigned' },
    { id: 'balance', label: 'Balance due' },
    { id: 'pending_review', label: 'Pending review' },
  ];

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
    if (!s) return { start: 'TBD', end: '', raw: s };
    const parts = s.split(/\s*[–-]\s*/);
    if (parts.length >= 2) return { start: parts[0].trim(), end: parts[1].trim(), raw: s };
    return { start: s, end: '', raw: s };
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

  function jobTotal(j) {
    return jobServiceTotal(j) + jobTravelFee(j);
  }

  function jobBalanceDue(j) {
    if (!j) return 0;
    if (j.remainingCents != null && Number.isFinite(Number(j.remainingCents))) {
      return Math.max(0, Number(j.remainingCents) / 100);
    }
    if (j.amountDueApproved != null && Number.isFinite(Number(j.amountDueApproved))) {
      return Math.max(0, Number(j.amountDueApproved));
    }
    return 0;
  }

  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '$0.00';
    return '$' + v.toFixed(2);
  }

  function moneyShort(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '';
    if (v >= 1000) return '$' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return '$' + Math.round(v);
  }

  function isHiddenJob(j) {
    const st = String((j && j.jobStatus) || '');
    return st === 'cancelled' || st === 'archived_test';
  }

  function isUnassigned(j) {
    return !(j && (j.assignedTechId || j.assignedTech || j.assignedTechName));
  }

  function isPaid(j) {
    if (!j) return false;
    const st = String(j.paymentWorkflowStatus || j.financialPaymentStatus || '').toLowerCase();
    if (st === 'payment_succeeded' || st === 'cash_paid' || st === 'paid') return true;
    if (j.invoicePaid) return true;
    return jobBalanceDue(j) <= 0 && jobTotal(j) > 0;
  }

  function clientSignals(j) {
    if (!j) return [];
    const out = [];
    if (j.rescheduledByClient) out.push({ cls: 'sig-resched', label: 'Client rescheduled' });
    if (j.addressChangedByClient || j.requestedAddress) {
      out.push({ cls: 'sig-addr', label: j.requestedAddress ? 'Address change pending' : 'Address change' });
    }
    if (j.cancellationRequestStatus && j.cancellationRequestStatus !== 'none') {
      out.push({ cls: 'sig-cancel', label: 'Cancel: ' + String(j.cancellationRequestStatus).replace(/_/g, ' ') });
    }
    if (j.hasPendingVehicleRemoval) out.push({ cls: 'sig-vehicle', label: 'Vehicle removal pending' });
    return out;
  }

  function telHref(phone) {
    const digits = String(phone || '').replace(/[^\d+]/g, '');
    return digits ? 'tel:' + digits : '';
  }

  function smsHref(phone) {
    const digits = String(phone || '').replace(/[^\d+]/g, '');
    return digits ? 'sms:' + digits : '';
  }

  function jobHaystack(j) {
    return [
      j && j.id, j && j.bookingId, j && j.firstName, j && j.lastName, j && j.email, j && j.phone,
      j && j.package, j && j.vehicleLabel, j && j.vehicle, j && j.assignedTechName,
      api && api.customerName ? api.customerName(j) : '',
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function matchesDaySearch(j) {
    const q = String(daySearch || '').trim().toLowerCase();
    if (!q) return true;
    return jobHaystack(j).includes(q);
  }

  function needsAttention(j) {
    if (api && api.jobNeedsAttention) return api.jobNeedsAttention(j);
    const st = String((j && j.jobStatus) || '');
    return st === 'pending_review' || st === 'issue_reported' || st === 'completed_pending_admin_review'
      || st === 'completed_pending_payment' || st === 'reopened' || !!(j && j.customerChangePending);
  }

  function pendingRequests(j) {
    if (api && api.pendingRequestCount) return api.pendingRequestCount(j) || 0;
    return 0;
  }

  function getJobs() {
    return api && typeof api.getJobs === 'function' ? api.getJobs() : [];
  }

  function emptyDayOps() {
    return {
      count: 0, revenue: 0, balanceDue: 0, unassigned: 0, attention: 0,
      pendingReview: 0, jobs: [],
    };
  }

  function rebuildOpsCache() {
    const byDate = new Map();
    const monthRollup = {
      count: 0, revenue: 0, balanceDue: 0, unassigned: 0, attention: 0, pendingReview: 0,
    };
    const alerts = [];

    getJobs().forEach((j) => {
      const d = jobDate(j);
      if (!d || isHiddenJob(j)) return;
      if (!byDate.has(d)) byDate.set(d, emptyDayOps());
      const bucket = byDate.get(d);
      bucket.count += 1;
      bucket.revenue += jobTotal(j);
      bucket.balanceDue += jobBalanceDue(j);
      if (isUnassigned(j)) bucket.unassigned += 1;
      if (needsAttention(j)) bucket.attention += 1;
      if (j.jobStatus === 'pending_review') bucket.pendingReview += 1;
      bucket.jobs.push(j);

      const parsed = parseDate(d);
      if (parsed.getFullYear() === viewYear && parsed.getMonth() === viewMonth) {
        monthRollup.count += 1;
        monthRollup.revenue += jobTotal(j);
        monthRollup.balanceDue += jobBalanceDue(j);
        if (isUnassigned(j)) monthRollup.unassigned += 1;
        if (needsAttention(j)) monthRollup.attention += 1;
        if (j.jobStatus === 'pending_review') monthRollup.pendingReview += 1;
      }
    });

    byDate.forEach((bucket, d) => {
      if (bucket.attention > 0 || bucket.unassigned > 0) {
        alerts.push({ date: d, bucket: bucket });
      }
    });
    alerts.sort((a, b) => a.date.localeCompare(b.date));

    opsCache = { byDate: byDate, monthRollup: monthRollup, alerts: alerts };
    return opsCache;
  }

  function dayOps(date) {
    if (!opsCache) rebuildOpsCache();
    return opsCache.byDate.get(date) || emptyDayOps();
  }

  function jobCountByDate(date) {
    return dayOps(date).count;
  }

  function attentionCountByDate(date) {
    return dayOps(date).attention;
  }

  function dayJobs(date) {
    let list = dayOps(date).jobs.slice();
    if (dayFilter === 'attention') list = list.filter(needsAttention);
    else if (dayFilter === 'unassigned') list = list.filter(isUnassigned);
    else if (dayFilter === 'balance') list = list.filter((j) => jobBalanceDue(j) > 0);
    else if (dayFilter === 'pending_review') list = list.filter((j) => j.jobStatus === 'pending_review');
    if (daySearch.trim()) list = list.filter(matchesDaySearch);
    return list.sort((a, b) => String(parseTimeWindow(a).start).localeCompare(String(parseTimeWindow(b).start)));
  }

  function heatLevel(count) {
    if (!count) return '';
    if (count >= 6) return 'heat-high';
    if (count >= 3) return 'heat-mid';
    return 'heat-low';
  }

  function dayStatusBreakdown(jobs) {
    const map = new Map();
    jobs.forEach((j) => {
      const st = String((j && j.jobStatus) || 'unknown').replace(/_/g, ' ');
      map.set(st, (map.get(st) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  function dayPackageMix(jobs) {
    const map = new Map();
    jobs.forEach((j) => {
      const pkg = String((j && j.package) || '—').trim() || '—';
      map.set(pkg, (map.get(pkg) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }

  function dayReadiness(ops) {
    if (!ops.count) return { assigned: 100, paid: 100, score: 100 };
    const assigned = Math.round(((ops.count - ops.unassigned) / ops.count) * 100);
    const paidN = ops.jobs.filter(isPaid).length;
    const paid = Math.round((paidN / ops.count) * 100);
    const score = Math.round((assigned * 0.55) + (paid * 0.45));
    return { assigned, paid, score };
  }

  function pipelineJobs(fromDate) {
    const from = parseDate(fromDate);
    const end = new Date(from);
    end.setDate(end.getDate() + PIPELINE_DAYS);
    const out = [];
    getJobs().forEach((j) => {
      const d = jobDate(j);
      if (!d || isHiddenJob(j)) return;
      const jd = parseDate(d);
      if (jd > from && jd <= end) out.push(j);
    });
    return out.sort((a, b) => jobDate(a).localeCompare(jobDate(b)));
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
      const ops = dayOps(date);
      cells.push({
        date,
        dayNum: d.getDate(),
        inMonth: d.getMonth() === month,
        isToday: date === today,
        jobCount: ops.count,
        attention: ops.attention,
        unassigned: ops.unassigned,
        revenue: ops.revenue,
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
      const ops = dayOps(date);
      out.push({
        date,
        dayName: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        dayNum: d.getDate(),
        isToday: date === today,
        jobCount: ops.count,
        revenue: ops.revenue,
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
    if (!el || !opsCache) return;
    const m = opsCache.monthRollup;
    el.innerHTML =
      '<div class="dv-stat accent"><div class="lbl">Jobs (month)</div><div class="val">' + m.count + '</div></div>' +
      '<div class="dv-stat rev"><div class="lbl">Revenue (month)</div><div class="val">' + money(m.revenue) + '</div></div>' +
      '<div class="dv-stat warn"><div class="lbl">Needs action</div><div class="val">' + m.attention + '</div></div>' +
      '<div class="dv-stat"><div class="lbl">Unassigned</div><div class="val">' + m.unassigned + '</div></div>' +
      '<div class="dv-stat"><div class="lbl">Balance due</div><div class="val">' + money(m.balanceDue) + '</div></div>' +
      '<div class="dv-stat"><div class="lbl">Pending review</div><div class="val">' + m.pendingReview + '</div></div>';
  }

  function renderOpsPulse() {
    const el = document.getElementById('dvOpsPulse');
    if (!el) return;
    const n = getJobs().length;
    el.innerHTML =
      '<span class="dv-pulse-dot"></span>' +
      '<span class="dv-pulse-text">Live ops projection · ' + n + ' jobs in memory · zero extra API calls</span>';
  }

  function dotsHtml(count, attention, unassigned) {
    if (!count) return '';
    if (count <= 4) {
      let html = '<div class="dv-dots">';
      const warnN = Math.min(attention || 0, count);
      const unN = Math.min(unassigned || 0, count - warnN);
      for (let i = 0; i < count; i++) {
        let cls = '';
        if (i < warnN) cls = ' warn';
        else if (i < warnN + unN) cls = ' unassigned';
        html += '<span class="dv-dot' + cls + '"></span>';
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
      if (c.attention) classes.push('has-warn');
      const heat = heatLevel(c.jobCount);
      if (heat) classes.push(heat);
      const rev = c.revenue > 0 ? '<div class="dv-cell-rev">' + esc(moneyShort(c.revenue)) + '</div>' : '';
      return '<button type="button" class="' + classes.join(' ') + '" data-dv-date="' + esc(c.date) + '" aria-pressed="' + (c.date === selectedDate) + '" title="' + esc(c.jobCount + ' jobs' + (c.revenue ? ' · ' + money(c.revenue) : '')) + '">' +
        '<span class="num">' + c.dayNum + '</span>' +
        (c.jobCount ? '<div class="dots">' + dotsHtml(c.jobCount, c.attention, c.unassigned) + '</div>' : '') +
        rev + '</button>';
    }).join('');
    grid.innerHTML = html;
  }

  function renderWeekStrip() {
    const strip = document.getElementById('dvWeekStrip');
    if (!strip) return;
    strip.innerHTML = weekAround(selectedDate).map((d) => {
      const classes = ['dv-week-day'];
      if (d.isToday) classes.push('today');
      if (d.date === selectedDate) classes.push('sel');
      const jc = d.jobCount === 1 ? '1 job' : (d.jobCount ? d.jobCount + ' jobs' : '—');
      const rev = d.revenue > 0 ? moneyShort(d.revenue) : '';
      return '<button type="button" class="' + classes.join(' ') + '" data-dv-date="' + esc(d.date) + '" aria-pressed="' + (d.date === selectedDate) + '">' +
        '<div class="dn">' + esc(d.dayName) + '</div>' +
        '<div class="dd">' + d.dayNum + '</div>' +
        '<div class="jc">' + esc(jc) + (rev ? ' · ' + esc(rev) : '') + '</div></button>';
    }).join('');
  }

  function renderOpsAlerts() {
    const el = document.getElementById('dvOpsAlerts');
    if (!el || !opsCache) return;
    const alerts = opsCache.alerts.filter((a) => {
      const p = parseDate(a.date);
      return p.getFullYear() === viewYear && p.getMonth() === viewMonth;
    }).slice(0, 8);
    if (!alerts.length) {
      el.innerHTML = '<div class="dv-alert-empty">No unassigned or attention flags this month</div>';
      return;
    }
    el.innerHTML = alerts.map((a) => {
      const d = parseDate(a.date);
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const parts = [];
      if (a.bucket.attention) parts.push(a.bucket.attention + ' need action');
      if (a.bucket.unassigned) parts.push(a.bucket.unassigned + ' unassigned');
      return '<button type="button" class="dv-alert-row" data-dv-date="' + esc(a.date) + '">' +
        '<span class="dv-alert-date">' + esc(label) + '</span>' +
        '<span class="dv-alert-msg">' + esc(parts.join(' · ')) + '</span>' +
        '<span class="dv-alert-go">→</span></button>';
    }).join('');
  }

  function renderBanner(container, dateStr) {
    if (!container) return;
    const d = parseDate(dateStr);
    const isToday = dateStr === todayStr();
    const label = isToday ? 'TODAY' : d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    const ops = dayOps(dateStr);
    container.innerHTML = '<strong>' + esc(label) + '</strong> — ' +
      esc(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) +
      (ops.count ? ' · ' + ops.count + ' appt' + (ops.count === 1 ? '' : 's') + ' · ' + money(ops.revenue) + ' booked' : '');
  }

  function renderDayIntel() {
    const el = document.getElementById('dvDayIntel');
    if (!el) return;
    const ops = dayOps(selectedDate);
    if (!ops.count) {
      el.innerHTML = '';
      return;
    }
    const ready = dayReadiness(ops);
    const statuses = dayStatusBreakdown(ops.jobs);
    const packages = dayPackageMix(ops.jobs);
    const paidN = ops.jobs.filter(isPaid).length;
    const clientN = ops.jobs.filter((j) => clientSignals(j).length > 0).length;
    el.innerHTML =
      '<div class="dv-intel-grid">' +
      '<div class="dv-intel-card dv-readiness">' +
      '<div class="dv-intel-head"><span>Ops readiness</span><strong class="dv-score">' + ready.score + '%</strong></div>' +
      '<div class="dv-meter"><div class="dv-meter-fill" style="width:' + ready.score + '%"></div></div>' +
      '<div class="dv-intel-sub">' + (ops.count - ops.unassigned) + '/' + ops.count + ' assigned · ' + paidN + '/' + ops.count + ' settled</div>' +
      '</div>' +
      '<div class="dv-intel-card">' +
      '<div class="dv-intel-head"><span>Status mix</span></div>' +
      '<div class="dv-bars">' + statuses.map(([label, n]) => {
        const pct = Math.round((n / ops.count) * 100);
        return '<div class="dv-bar-row"><span class="dv-bar-lbl">' + esc(label) + '</span>' +
          '<div class="dv-bar-track"><div class="dv-bar-fill" style="width:' + pct + '%"></div></div>' +
          '<span class="dv-bar-n">' + n + '</span></div>';
      }).join('') + '</div></div>' +
      '<div class="dv-intel-card">' +
      '<div class="dv-intel-head"><span>Package mix</span></div>' +
      '<div class="dv-pkg-chips">' + packages.map(([pkg, n]) =>
        '<span class="dv-pkg-chip">' + esc(pkg) + '<em>' + n + '</em></span>'
      ).join('') + '</div>' +
      (clientN ? '<div class="dv-intel-foot">' + clientN + ' job' + (clientN === 1 ? '' : 's') + ' with client signals</div>' : '') +
      '</div></div>';
  }

  function renderDayOps() {
    const el = document.getElementById('dvDayOps');
    if (!el) return;
    const ops = dayOps(selectedDate);
    if (!ops.count) {
      el.innerHTML = '<div class="dv-chip muted">No operational load this day</div>';
      return;
    }
    const chips = [
      { cls: '', label: ops.count + ' jobs' },
      { cls: 'rev', label: money(ops.revenue) + ' revenue' },
    ];
    if (ops.balanceDue > 0) chips.push({ cls: 'bal', label: money(ops.balanceDue) + ' balance due' });
    if (ops.unassigned) chips.push({ cls: 'un', label: ops.unassigned + ' unassigned' });
    if (ops.attention) chips.push({ cls: 'warn', label: ops.attention + ' need action' });
    if (ops.pendingReview) chips.push({ cls: 'pending', label: ops.pendingReview + ' pending review' });
    el.innerHTML = chips.map((c) => '<span class="dv-chip ' + c.cls + '">' + esc(c.label) + '</span>').join('');
  }

  function renderFilters() {
    const el = document.getElementById('dvFilters');
    if (!el) return;
    const ops = dayOps(selectedDate);
    el.innerHTML = FILTERS.map((f) => {
      let count = ops.count;
      if (f.id === 'attention') count = ops.attention;
      else if (f.id === 'unassigned') count = ops.unassigned;
      else if (f.id === 'balance') count = ops.jobs.filter((j) => jobBalanceDue(j) > 0).length;
      else if (f.id === 'pending_review') count = ops.pendingReview;
      const on = dayFilter === f.id;
      return '<button type="button" class="dv-filter' + (on ? ' on' : '') + '" data-dv-filter="' + f.id + '" aria-pressed="' + on + '">' +
        esc(f.label) + '<span class="dv-fc">' + count + '</span></button>';
    }).join('');
  }

  function renderTimeline() {
    const el = document.getElementById('dvTimeline');
    if (!el) return;
    const list = dayOps(selectedDate).jobs.slice().sort((a, b) =>
      String(parseTimeWindow(a).start).localeCompare(String(parseTimeWindow(b).start)));
    if (!list.length) {
      el.innerHTML = '<div class="dv-timeline-empty">No time blocks scheduled</div>';
      return;
    }
    el.innerHTML = '<div class="dv-timeline-track">' + list.map((j) => {
      const tw = parseTimeWindow(j);
      const warn = needsAttention(j) ? ' warn' : '';
      const un = isUnassigned(j) ? ' unassigned' : '';
      const active = j.id === heroJobId ? ' active' : '';
      const tech = (j.assignedTechName || '').split(' ')[0] || '—';
      return '<button type="button" class="dv-tl-block' + warn + un + active + '" data-dv-job="' + esc(j.id) + '" title="' + esc(api.customerName(j)) + '">' +
        '<div class="dv-tl-time">' + esc(tw.start) + '</div>' +
        '<div class="dv-tl-name">' + esc(api.customerName(j)) + '</div>' +
        '<div class="dv-tl-meta">' + esc(tech) + ' · ' + moneyShort(jobTotal(j)) + '</div></button>';
    }).join('') + '</div>';
  }

  function renderTechLoad() {
    const el = document.getElementById('dvTechLoad');
    if (!el) return;
    const byTech = new Map();
    dayOps(selectedDate).jobs.forEach((j) => {
      const key = j.assignedTechName || (isUnassigned(j) ? 'Unassigned' : 'Unknown');
      if (!byTech.has(key)) byTech.set(key, { name: key, jobs: [], revenue: 0 });
      const row = byTech.get(key);
      row.jobs.push(j);
      row.revenue += jobTotal(j);
    });
    const rows = [...byTech.values()].sort((a, b) => {
      if (a.name === 'Unassigned') return 1;
      if (b.name === 'Unassigned') return -1;
      return b.jobs.length - a.jobs.length;
    });
    if (!rows.length) {
      el.innerHTML = '<div class="dv-empty"><p>No technician assignments</p></div>';
      return;
    }
    el.innerHTML = '<div class="dv-tech-grid">' + rows.map((r) => {
      const un = r.name === 'Unassigned';
      return '<div class="dv-tech-card' + (un ? ' unassigned' : '') + '">' +
        '<div class="dv-tech-head"><strong>' + esc(r.name) + '</strong><span>' + r.jobs.length + ' · ' + money(r.revenue) + '</span></div>' +
        '<ul class="dv-tech-list">' + r.jobs.map((j) => {
          const tw = parseTimeWindow(j);
          return '<li data-dv-job="' + esc(j.id) + '" tabindex="0" role="button">' + esc(tw.start) + ' — ' + esc(api.customerName(j)) + '</li>';
        }).join('') + '</ul></div>';
    }).join('') + '</div>';
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
      heroEl.innerHTML = '<div class="dv-empty"><div class="ei">📅</div><p>Select a job or pick a day with appointments</p></div>';
      mapEl.innerHTML = '';
      return;
    }
    const total = jobTotal(job);
    const svc = jobServiceTotal(job);
    const fee = jobTravelFee(job);
    const bal = jobBalanceDue(job);
    const vehicle = api.vehicleSummary ? api.vehicleSummary(job) : (job.vehicleLabel || job.vehicle || '—');
    const statusBadge = api.jobBadge ? api.jobBadge(job.jobStatus) : '';
    const payBadge = api.payBadge ? api.payBadge(job.paymentWorkflowStatus) : '';
    const balLabel = api.balanceLabel ? api.balanceLabel(job) : money(bal);
    const dtLabel = api.dateTimeLabel ? api.dateTimeLabel(job) : jobEta(job);
    const reqN = pendingRequests(job);
    const feeNote = fee > 0 ? ' · fee ' + money(fee) : '';
    const signals = clientSignals(job);
    const fleet = Number(job.vehicleCount || 0) > 1 ? '<span class="dv-flag fleet">' + job.vehicleCount + ' vehicles</span>' : '';
    const flags = [];
    if (isUnassigned(job)) flags.push('<span class="dv-flag un">Unassigned</span>');
    if (needsAttention(job)) flags.push('<span class="dv-flag warn">Needs action</span>');
    if (reqN > 0) flags.push('<span class="dv-flag req">' + reqN + ' change request' + (reqN === 1 ? '' : 's') + '</span>');
    if (bal > 0) flags.push('<span class="dv-flag bal">Balance ' + esc(balLabel) + '</span>');
    if (fleet) flags.push(fleet);
    signals.forEach((s) => flags.push('<span class="dv-flag ' + s.cls + '">' + esc(s.label) + '</span>'));
    const phone = job.phone ? String(job.phone).trim() : '';
    const email = job.email ? String(job.email).trim() : '';
    const contactBtns = [
      phone ? '<a class="btn ghost sm" href="' + esc(telHref(phone)) + '">Call</a>' : '',
      email ? '<a class="btn ghost sm" href="mailto:' + esc(email) + '">Email</a>' : '',
      phone ? '<a class="btn ghost sm" href="' + esc(smsHref(phone)) + '">SMS</a>' : '',
    ].filter(Boolean).join('');
    const issueBlock = job.issueNotes
      ? '<div class="dv-issue-note"><span class="lbl">Issue reported</span><p>' + esc(job.issueNotes) + '</p></div>'
      : '';
    const addrPending = job.addressChangedByClient && job.requestedAddress
      ? '<div class="dv-pending-addr"><span class="lbl">Requested address</span><p>' + esc(job.requestedAddress) + '</p></div>'
      : '';

    heroEl.innerHTML =
      '<article class="dv-hero" data-job="' + esc(job.id) + '">' +
      '<div class="dv-hero-top">' +
      '<div><div class="dv-hero-name">' + esc(api.customerName(job)) + '</div>' +
      '<div class="dv-hero-badges"><span class="dv-hero-id">' + esc(job.id) + '</span>' + statusBadge + payBadge + '</div>' +
      (flags.length ? '<div class="dv-flags">' + flags.join('') + '</div>' : '') +
      '</div>' +
      '<div class="dv-hero-price">' + money(total) +
      '<span class="sub">svc ' + money(svc) + feeNote + '</span></div></div>' +
      '<div class="dv-meta dv-meta-wide">' +
      '<div class="dv-meta-item"><span class="ico">🕐</span><div><div class="lbl">Schedule</div><div class="val">' + esc(dtLabel) + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">📦</span><div><div class="lbl">Package</div><div class="val">' + esc(job.package || job.packageId || '—') + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">🚗</span><div><div class="lbl">Vehicle</div><div class="val">' + esc(vehicle) + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">👤</span><div><div class="lbl">Technician</div><div class="val">' + esc(job.assignedTechName || 'Unassigned') + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">📞</span><div><div class="lbl">Phone</div><div class="val">' + esc(job.phone || '—') + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">✉️</span><div><div class="lbl">Email</div><div class="val">' + esc(job.email || '—') + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">📍</span><div><div class="lbl">Location</div><div class="val">' + esc(jobAddress(job) || '—') + '</div></div></div>' +
      '<div class="dv-meta-item"><span class="ico">💳</span><div><div class="lbl">Balance</div><div class="val">' + esc(balLabel) + '</div></div></div>' +
      '</div>' +
      issueBlock + addrPending +
      '<div class="dv-actions">' +
      contactBtns +
      '<button type="button" class="btn sm" data-dv-open="' + esc(job.id) + '">Manage Appointment</button>' +
      (job.jobStatus === 'pending_review' ? '<button type="button" class="btn ghost sm" data-dv-goto-jobs>Review on Jobs Board</button>' : '') +
      '</div></article>';
    mapEl.innerHTML = jobAddress(job) ? mapHtml(job) : '';
  }

  function renderList(date) {
    const el = document.getElementById('dvSchedList');
    if (!el) return;
    const list = dayJobs(date);
    if (!list.length) {
      el.innerHTML = '<div class="dv-empty"><p>No appointments match this filter</p></div>';
      return;
    }
    el.innerHTML = '<div class="dv-sched">' + list.map((j) => {
      const tw = parseTimeWindow(j);
      const end = tw.end || tw.start;
      const active = j.id === heroJobId ? ' is-active' : '';
      const total = jobTotal(j);
      const loc = jobAddress(j) || (j.package || '—');
      const statusBadge = api.jobBadge ? api.jobBadge(j.jobStatus) : '';
      const payBadge = api.payBadge ? api.payBadge(j.paymentWorkflowStatus) : '';
      const warn = needsAttention(j) ? '<span class="dv-mini-warn" title="Needs attention">!</span>' : '';
      const un = isUnassigned(j) ? '<span class="dv-mini-un">○</span>' : '';
      return '<div class="dv-sched-item' + active + '" data-dv-job="' + esc(j.id) + '" tabindex="0" role="button">' +
        '<div class="si-time">' + esc(tw.start) + '<br>– ' + esc(end) + '</div>' +
        '<div class="si-body"><div class="si-name">' + warn + un + esc(api.customerName(j)) +
        '<span class="si-badges">' + statusBadge + payBadge + '</span></div>' +
        '<div class="si-loc">' + esc(loc) + ' · ' + esc(j.assignedTechName || 'Unassigned') + '</div></div>' +
        '<div class="si-price">' + money(total) + '</div></div>';
    }).join('') + '</div>';
  }

  function renderPipeline() {
    const el = document.getElementById('dvPipeline');
    if (!el) return;
    const up = pipelineJobs(selectedDate);
    if (!up.length) {
      el.innerHTML = '<div class="dv-empty"><p>Nothing scheduled in the next ' + PIPELINE_DAYS + ' days</p></div>';
      return;
    }
    el.innerHTML = '<div class="dv-pipeline">' + up.map((j) => {
      const d = parseDate(jobDate(j));
      const tw = parseTimeWindow(j);
      const flags = [];
      if (needsAttention(j)) flags.push('action');
      if (isUnassigned(j)) flags.push('unassigned');
      return '<button type="button" class="dv-pipe-row' + (flags.length ? ' flagged' : '') + '" data-dv-date="' + esc(jobDate(j)) + '" data-dv-job="' + esc(j.id) + '">' +
        '<span class="dv-pipe-date">' + esc(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })) + '</span>' +
        '<span class="dv-pipe-body">' + esc(api.customerName(j)) + ' · ' + esc(tw.start) + '</span>' +
        '<span class="dv-pipe-amt">' + moneyShort(jobTotal(j)) + '</span></button>';
    }).join('') + '</div>';
  }

  function focusJob(id) {
    heroJobId = id;
    const job = getJobs().find((j) => j.id === id);
    renderHero(job || null);
    renderList(selectedDate);
    renderTimeline();
    document.querySelectorAll('.dv-sched-item, .dv-tl-block').forEach((n) => {
      n.classList.toggle('is-active', n.getAttribute('data-dv-job') === id);
      n.classList.toggle('active', n.getAttribute('data-dv-job') === id);
    });
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
      } else if (action === 'today') selectDate(todayStr());
      return;
    }
    const filterBtn = e.target.closest('[data-dv-filter]');
    if (filterBtn) {
      dayFilter = filterBtn.getAttribute('data-dv-filter') || 'all';
      const list = dayJobs(selectedDate);
      heroJobId = list.length ? list[0].id : null;
      renderDayOps();
      renderDayIntel();
      renderFilters();
      renderTimeline();
      renderHero(heroJobId ? list.find((j) => j.id === heroJobId) : null);
      renderList(selectedDate);
      return;
    }
    const dateBtn = e.target.closest('[data-dv-date]');
    if (dateBtn && !e.target.closest('[data-dv-job]')) {
      const d = dateBtn.getAttribute('data-dv-date');
      const parsed = parseDate(d);
      if (parsed.getFullYear() !== viewYear || parsed.getMonth() !== viewMonth) {
        viewYear = parsed.getFullYear();
        viewMonth = parsed.getMonth();
      }
      selectDate(d, { syncView: false });
      return;
    }
    const pipeRow = e.target.closest('.dv-pipe-row');
    if (pipeRow) {
      const d = pipeRow.getAttribute('data-dv-date');
      const id = pipeRow.getAttribute('data-dv-job');
      if (d) {
        const parsed = parseDate(d);
        viewYear = parsed.getFullYear();
        viewMonth = parsed.getMonth();
        selectedDate = d;
      }
      focusJob(id);
      render();
      return;
    }
    const openBtn = e.target.closest('[data-dv-open]');
    if (openBtn && api.openJob) {
      api.openJob(openBtn.getAttribute('data-dv-open'));
      return;
    }
    if (e.target.closest('[data-dv-goto-jobs]')) {
      const tab = document.querySelector('#tabs .tab[data-tab="jobs"]');
      if (tab) tab.click();
      return;
    }
    const row = e.target.closest('[data-dv-job]');
    if (!row) return;
    const id = row.getAttribute('data-dv-job');
    focusJob(id);
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
      const row = e.target.closest('[data-dv-job],[data-dv-date],.dv-pipe-row');
      if (!row) return;
      e.preventDefault();
      onPanelClick({ target: row, type: 'click', detail: 1 });
    });
    const searchEl = document.getElementById('dvDaySearch');
    if (searchEl && !searchEl._dvBound) {
      searchEl._dvBound = true;
      let t = null;
      searchEl.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          daySearch = searchEl.value || '';
          const list = dayJobs(selectedDate);
          heroJobId = list.length ? list[0].id : null;
          renderFilters();
          renderTimeline();
          renderHero(heroJobId ? list.find((j) => j.id === heroJobId) : null);
          renderList(selectedDate);
        }, 120);
      });
    }
    bound = true;
  }

  function render() {
    if (!api) return;
    if (!selectedDate) selectedDate = todayStr();
    rebuildOpsCache();
    renderMonthLabel();
    renderStats();
    renderOpsPulse();
    renderMonthGrid();
    renderWeekStrip();
    renderOpsAlerts();
    renderBanner(document.getElementById('dvCalBanner'), selectedDate);
    renderDayOps();
    renderDayIntel();
    renderFilters();
    const list = dayJobs(selectedDate);
    if (!heroJobId || !list.some((j) => j.id === heroJobId)) {
      heroJobId = list.length ? list[0].id : null;
    }
    renderTimeline();
    renderHero(heroJobId ? list.find((j) => j.id === heroJobId) : null);
    renderTechLoad();
    renderList(selectedDate);
    renderPipeline();
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
