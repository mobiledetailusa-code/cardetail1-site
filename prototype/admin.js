/**
 * Admin Day View — mock data or live API on Netlify Preview (when admin session exists).
 */
(function () {
  const P = CD1Proto;
  const UI = CD1UI;
  const API = () => window.CD1PreviewApi;
  let selectedDate = P.fmtDate(P.TODAY);
  let activeJob = null;
  let jobs = [];
  let techList = P.TECHS.slice();
  let runtime = { mode: 'mock' };

  function useMock() {
    return runtime.mode !== 'live';
  }

  function techName(id, job) {
    if (job && job.assignedTechName) return job.assignedTechName;
    const t = techList.find((x) => x.id === id);
    return t ? t.name : (id ? id : 'Unassigned');
  }

  function findJob(id) {
    return jobs.find((j) => j.id === id);
  }

  function dayJobs(date) {
    return jobs.filter((j) => j.date === date && j.status !== 'cancelled');
  }

  function upcomingJobs(fromDate) {
    const from = new Date(fromDate + 'T12:00:00');
    const end = P.addDays(from, 7);
    return jobs.filter((j) => {
      const d = new Date(j.date + 'T12:00:00');
      return d > from && d <= end && j.status !== 'cancelled';
    });
  }

  function jobCountByDate(dateStr) {
    return dayJobs(dateStr).length;
  }

  function renderHero(job) {
    if (!job) {
      document.getElementById('hero-job').innerHTML = '<div class="empty"><div class="ei">📅</div><p>No jobs scheduled for this day</p></div>';
      document.getElementById('map-wrap').innerHTML = '';
      return;
    }
    const tech = techName(job.assignedTechId, job);
    const total = job.serviceTotal + (job.travelFee || 0);
    const mapAddr = job.address || 'New York';
    document.getElementById('hero-job').innerHTML = `
      <article class="job-hero" data-job="${job.id}">
        <div class="job-hero-top">
          <div>
            <div class="job-name">${job.customerFirst} ${job.customerLast}</div>
            <div class="job-badges">
              <span class="badge badge-id mono">${job.id}</span>
              ${UI.statusBadge(job.status)}
            </div>
          </div>
          <div class="job-price">
            ${P.money(total)}
            <span class="sub">svc ${P.money(job.serviceTotal)}${job.travelFee ? ' · fee ' + P.money(job.travelFee) : ''}</span>
          </div>
        </div>
        <div class="job-meta">
          <div class="meta-item"><span class="ico">🕐</span><div><div class="lbl">ETA</div><div class="val">${job.eta}</div></div></div>
          <div class="meta-item"><span class="ico">🚗</span><div><div class="lbl">Vehicle</div><div class="val">${job.vehicle || '—'}</div></div></div>
          <div class="meta-item"><span class="ico">👤</span><div><div class="lbl">Technician</div><div class="val">${tech}</div></div></div>
          <div class="meta-item"><span class="ico">📍</span><div><div class="lbl">Location</div><div class="val">${job.address || '—'}</div></div></div>
        </div>
        <div class="actions">
          <button type="button" class="btn btn-p" data-action="open-drawer" data-id="${job.id}">Manage Appointment</button>
          ${job.status === 'pending_review' ? `<button type="button" class="btn btn-gr" data-action="confirm" data-id="${job.id}">Confirm</button><button type="button" class="btn btn-rd" data-action="decline" data-id="${job.id}">Decline</button>` : ''}
          ${job.amountDue > 0 ? `<button type="button" class="btn btn-warn" data-action="settle" data-id="${job.id}">Settle ${P.money(job.amountDue)}</button>` : ''}
        </div>
      </article>`;
    document.getElementById('map-wrap').innerHTML = job.address ? `
      <div class="map-card">
        <iframe src="${CD1Calendar.mapEmbed({ address: mapAddr })}" loading="lazy" title="Job location map"></iframe>
        <div class="map-pin mono">${job.id}</div>
      </div>` : '';
  }

  function renderList(date) {
    const list = dayJobs(date);
    const el = document.getElementById('sched-list');
    if (!list.length) {
      el.innerHTML = '<div class="empty"><p>No appointments this day</p></div>';
      return;
    }
    el.innerHTML = list.map((j) => `
      <div class="sched-item" data-id="${j.id}" tabindex="0">
        <div class="si-time">${j.timeStart}<br>– ${j.timeEnd}</div>
        <div class="si-body">
          <div class="si-name">${j.customerFirst} ${j.customerLast}</div>
          <div class="si-loc">${j.address || j.packageName}</div>
        </div>
        <div class="si-price">${P.money(j.serviceTotal + (j.travelFee || 0))}</div>
      </div>`).join('');
  }

  function renderUpcoming() {
    const up = upcomingJobs(selectedDate);
    const el = document.getElementById('upcoming');
    if (!up.length) {
      el.innerHTML = '<div class="empty"><div class="ei">📆</div><p>No upcoming jobs in the next 7 days</p></div>';
      return;
    }
    el.innerHTML = '<div class="sched-list">' + up.map((j) => `
      <div class="sched-item" data-id="${j.id}">
        <div class="si-time">${new Date(j.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
        <div class="si-body">
          <div class="si-name">${j.customerFirst} ${j.customerLast}</div>
          <div class="si-loc">${j.packageName} · ${j.timeStart}</div>
        </div>
        ${UI.statusBadge(j.status)}
      </div>`).join('') + '</div>';
  }

  function renderCalendar() {
    const days = P.weekDays(P.TODAY).map((d) => ({ ...d, jobCount: jobCountByDate(d.date) }));
    const container = document.getElementById('cal-strip');
    const sel = selectedDate;
    container.innerHTML = days.map((d) => {
      const classes = ['cal-day'];
      if (d.isToday) classes.push('today');
      if (d.date === sel) classes.push('sel');
      const label = d.jobCount === 1 ? '1 job' : d.jobCount + ' jobs';
      return `<button type="button" class="${classes.join(' ')}" data-date="${d.date}">
        <div class="dn">${d.dayName}</div><div class="dd">${d.dayNum}</div><div class="dm">${d.month}</div>
        <div class="jc">${label}</div></button>`;
    }).join('');
    container.querySelectorAll('.cal-day').forEach((btn) => {
      btn.addEventListener('click', () => { selectedDate = btn.dataset.date; refresh(); });
    });
  }

  function refresh() {
    renderCalendar();
    CD1Calendar.renderBanner(document.getElementById('cal-banner'), selectedDate);
    const list = dayJobs(selectedDate);
    activeJob = list[0] || null;
    renderHero(activeJob);
    renderList(selectedDate);
    renderUpcoming();
  }

  async function reloadJobs() {
    if (runtime.mode === 'live') {
      jobs = await API().adminFetchJobs();
      if (runtime.techs && runtime.techs.length) techList = runtime.techs;
    } else {
      jobs = P.JOBS.map((j) => ({ ...j }));
      techList = P.TECHS.slice();
    }
    refresh();
  }

  function drawerContent(job) {
    const pkgOpts = P.PACKAGES.map((p) =>
      `<option value="${p.id}" ${p.id === job.packageId ? 'selected' : ''}>${p.name} — ${P.money(p.price)}</option>`
    ).join('');
    const techOpts = '<option value="">— Unassigned —</option>' + techList.map((t) =>
      `<option value="${t.id}" ${t.id === job.assignedTechId ? 'selected' : ''}>${t.name}</option>`
    ).join('');
    const liveNote = runtime.mode === 'live'
      ? '<p class="hint" style="font-size:11px;color:var(--teal);margin-bottom:10px">Live preview — mutations hit real APIs</p>' : '';

    return liveNote + `
      <div class="panel-sec">
        <h4>Summary</h4>
        <div class="kv">
          <div><b>Customer:</b> ${job.customerFirst} ${job.customerLast}</div>
          <div><b>Phone:</b> ${job.phone || '—'}</div>
          <div><b>Vehicle:</b> ${job.vehicle || '—'}</div>
          <div><b>Status:</b> ${P.STATUS_LABELS[job.status] || job.status}</div>
          <div><b>Payment:</b> ${String(job.paymentStatus || '').replace(/_/g, ' ')}</div>
          <div><b>Total:</b> ${P.money(job.serviceTotal + (job.travelFee || 0))} (due ${P.money(job.amountDue)})</div>
        </div>
      </div>
      <div class="panel-sec">
        <h4>Schedule</h4>
        <div class="form-row">
          <div class="form-group"><label for="d-date">Date</label><input type="date" id="d-date" value="${job.date}"></div>
          <div class="form-group"><label for="d-time">Time window</label>
            <select id="d-time">
              <option ${job.timeStart === '8:00 AM' ? 'selected' : ''}>8:00 AM – 10:30 AM</option>
              <option ${job.timeStart === '10:00 AM' ? 'selected' : ''}>10:00 AM – 1:00 PM</option>
              <option ${job.timeStart === '2:00 PM' ? 'selected' : ''}>2:00 PM – 4:30 PM</option>
            </select>
          </div>
        </div>
        <button type="button" class="btn btn-g btn-sm" data-action="reschedule" data-id="${job.id}">Save Schedule</button>
      </div>
      <div class="panel-sec">
        <h4>Package</h4>
        <div class="form-group"><label for="d-package">Change package</label><select id="d-package" ${runtime.mode === 'live' ? 'disabled' : ''}>${pkgOpts}</select></div>
        ${runtime.mode === 'live'
    ? '<p class="hint">Package change: use <a href="/admin-ops">Admin Ops Jobs Board</a></p>'
    : '<button type="button" class="btn btn-g btn-sm" data-action="change-pack" data-id="' + job.id + '">Apply Package Change</button>'}
      </div>
      <div class="panel-sec">
        <h4>Assignment</h4>
        <div class="form-group"><label for="d-tech">Assign technician</label><select id="d-tech">${techOpts}</select></div>
        <button type="button" class="btn btn-g btn-sm" data-action="assign" data-id="${job.id}">Assign Tech</button>
      </div>
      <div class="panel-sec">
        <h4>Payment</h4>
        <div class="actions">
          <button type="button" class="btn btn-gr btn-sm" data-action="settle-cash" data-id="${job.id}">Record Cash Payment</button>
          <button type="button" class="btn btn-warn btn-sm" data-action="send-pay-link" data-id="${job.id}">Send Pay Link</button>
        </div>
      </div>
      <div class="panel-sec">
        <h4>Customer link</h4>
        <button type="button" class="btn btn-g btn-sm" data-action="gen-link" data-id="${job.id}">Generate Customer Portal Link</button>
      </div>`;
  }

  function drawerActions(job) {
    let html = '';
    if (job.status === 'pending_review') {
      html += `<button type="button" class="btn btn-gr" data-action="confirm" data-id="${job.id}">Confirm Appointment</button>`;
      html += `<button type="button" class="btn btn-rd" data-action="decline" data-id="${job.id}">Decline</button>`;
    }
    html += `<button type="button" class="btn btn-g" data-close-drawer>Close</button>`;
    return html;
  }

  async function openDrawer(id) {
    let job = findJob(id);
    if (!job) return;
    if (runtime.mode === 'live') {
      try {
        job = await API().adminGetJob(id);
        const idx = jobs.findIndex((j) => j.id === id);
        if (idx >= 0) jobs[idx] = job;
      } catch (e) {
        UI.toast('Could not load job detail: ' + e.message);
      }
    }
    document.getElementById('drawer-title').textContent = `${job.customerFirst} ${job.customerLast}`;
    document.getElementById('drawer-id').textContent = job.id;
    document.getElementById('drawer-body').innerHTML = drawerContent(job);
    document.getElementById('drawer-actions').innerHTML = drawerActions(job);
    UI.openDrawer('job-drawer');
  }

  async function liveMutate(action, job, extra) {
    const body = Object.assign({
      action,
      bookingId: job.id,
      expectedBookingVersion: job.bookingVersion,
    }, extra || {});
    await API().adminPost(body);
    await reloadJobs();
  }

  async function handleAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const job = findJob(id);
    if (!job && action !== 'open-drawer') return;

    try {
      switch (action) {
        case 'open-drawer':
          await openDrawer(id);
          break;
        case 'confirm':
          if (useMock()) {
            job.status = 'confirmed';
            UI.toast('Appointment confirmed (mock)', 'ok');
          } else {
            await liveMutate('confirm_booking', job);
            UI.toast('Appointment confirmed', 'ok');
          }
          UI.closeDrawer();
          refresh();
          break;
        case 'decline':
          if (useMock()) {
            job.status = 'cancelled';
            UI.toast('Booking declined (mock)', 'ok');
          } else {
            await liveMutate('cancel_booking', job, { reason: 'admin_declined' });
            UI.toast('Booking cancelled', 'ok');
          }
          UI.closeDrawer();
          refresh();
          break;
        case 'reschedule': {
          const date = document.getElementById('d-date').value;
          const win = document.getElementById('d-time').value;
          const parts = win.split(/\s*[–-]\s*/);
          if (useMock()) {
            job.date = date;
            UI.toast('Schedule updated (mock)', 'ok');
          } else {
            await liveMutate('reschedule', job, {
              confirmedDate: date,
              confirmedTime: parts[0] || win,
              confirmedTimeWindow: win,
            });
            UI.toast('Schedule updated', 'ok');
          }
          selectedDate = date;
          UI.closeDrawer();
          refresh();
          break;
        }
        case 'change-pack': {
          const pkg = P.PACKAGES.find((p) => p.id === document.getElementById('d-package').value);
          if (pkg) {
            job.packageId = pkg.id;
            job.packageName = pkg.name;
            job.serviceTotal = pkg.price;
            UI.toast('Package changed (mock)', 'ok');
          }
          refresh();
          break;
        }
        case 'assign': {
          const techId = document.getElementById('d-tech').value || null;
          if (useMock()) {
            job.assignedTechId = techId;
            if (techId) job.status = 'assigned';
            UI.toast('Technician assigned (mock)', 'ok');
            refresh();
          } else if (techId) {
            await API().adminAssign(job.id, techId);
            await reloadJobs();
            UI.toast('Technician assigned', 'ok');
          } else {
            UI.toast('Select a technician');
          }
          break;
        }
        case 'settle':
        case 'settle-cash':
          if (useMock()) {
            job.amountPaid += job.amountDue;
            job.amountDue = 0;
            UI.toast('Payment recorded (mock)', 'ok');
          } else {
            await liveMutate('mark_cash_received', job);
            UI.toast('Cash payment recorded', 'ok');
          }
          UI.closeDrawer();
          refresh();
          break;
        case 'send-pay-link':
          if (useMock()) {
            UI.toast('Pay link sent (mock)');
          } else {
            const data = await API().adminPost({ action: 'generate_customer_links', bookingId: job.id });
            UI.toast(data.payLink ? 'Pay link ready' : 'Link generated');
          }
          break;
        case 'gen-link':
          if (useMock()) {
            UI.toast('Link: /my-garage?t=demo_' + job.id);
          } else {
            const data = await API().adminPost({ action: 'generate_customer_links', bookingId: job.id });
            UI.toast(data.portalLink || data.appointmentLink || 'Link generated', 'ok');
          }
          break;
        default:
          break;
      }
    } catch (err) {
      UI.toast('Error: ' + (err.message || 'failed'));
    }
  }

  document.addEventListener('click', (e) => {
    const item = e.target.closest('.sched-item');
    if (item && item.dataset.id) openDrawer(item.dataset.id);
    handleAction(e);
  });

  document.getElementById('btn-signout').addEventListener('click', () => {
    if (runtime.mode === 'live' && window.CD1AdminSession) {
      window.CD1AdminSession.clearToken();
      location.href = runtime.loginUrl || '/admin';
      return;
    }
    UI.toast('Sign out (mock)');
  });

  UI.bindDrawerClose();

  (async function init() {
    runtime = await API().initPortal('admin');
    API().renderModeBanner(document.querySelector('.proto-banner'), runtime);
    if (runtime.techs && runtime.techs.length) techList = runtime.techs;
    await reloadJobs();
    if (runtime.error) UI.toast('Live load failed — using mock: ' + runtime.error);
  })();
})();
