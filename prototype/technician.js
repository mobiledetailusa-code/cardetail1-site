/**
 * Technician dashboard — mock or live (tech session on Preview).
 */
(function () {
  const P = CD1Proto;
  const UI = CD1UI;
  const API = () => window.CD1PreviewApi;
  const TECH_ID = 'tech-magno';
  let selectedDate = P.fmtDate(P.TODAY);
  let jobs = [];
  let runtime = { mode: 'mock' };

  function myJobs() {
    if (runtime.mode === 'live') return jobs.filter((j) => j.status !== 'cancelled');
    return jobs.filter((j) => j.assignedTechId === TECH_ID && j.status !== 'cancelled');
  }

  function dayJobs(date) {
    return myJobs().filter((j) => j.date === date);
  }

  function renderHero(job) {
    if (!job) {
      document.getElementById('hero-job').innerHTML = '<div class="empty"><div class="ei">✅</div><p>No jobs assigned for this day</p></div>';
      document.getElementById('map-wrap').innerHTML = '';
      return;
    }
    const total = job.serviceTotal + (job.travelFee || 0);
    document.getElementById('hero-job').innerHTML = `
      <article class="job-hero">
        <div class="job-hero-top">
          <div>
            <div class="job-name">${job.customerFirst} ${job.customerLast}</div>
            <div class="job-badges">
              <span class="badge badge-id mono">${job.id}</span>
              ${UI.statusBadge(job.status)}
            </div>
          </div>
          <div class="job-price">${P.money(total)}${job.travelFee ? '<span class="sub">fee ' + P.money(job.travelFee) + '</span>' : ''}</div>
        </div>
        <div class="job-meta">
          <div class="meta-item"><span class="ico">🕐</span><div><div class="lbl">ETA</div><div class="val">${job.eta}</div></div></div>
          <div class="meta-item"><span class="ico">🚗</span><div><div class="lbl">Vehicle</div><div class="val">${job.vehicle || '—'}</div></div></div>
          <div class="meta-item"><span class="ico">📍</span><div><div class="lbl">Location</div><div class="val">${job.address || '—'}</div></div></div>
        </div>
        <div class="actions">
          ${['confirmed', 'assigned', 'accepted'].includes(job.status) ? `<button type="button" class="btn btn-p" data-action="enroute" data-id="${job.id}">Start En Route</button>` : ''}
          ${job.status === 'en_route' ? `<button type="button" class="btn btn-gr" data-action="arrive" data-id="${job.id}">Mark Arrived</button>` : ''}
          ${['arrived', 'in_progress'].includes(job.status) ? `<button type="button" class="btn btn-gr" data-action="complete" data-id="${job.id}">Complete Job</button>` : ''}
          ${job.address ? `<a class="btn btn-g" href="https://maps.google.com/?q=${encodeURIComponent(job.address)}" target="_blank" rel="noopener">Open Maps</a>` : ''}
        </div>
      </article>`;
    document.getElementById('map-wrap').innerHTML = job.address ? `
      <div class="map-card">
        <iframe src="${CD1Calendar.mapEmbed(job)}" loading="lazy" title="Job location"></iframe>
        <div class="map-pin mono">${job.id}</div>
      </div>` : '';
  }

  function renderList(date) {
    const list = dayJobs(date);
    const el = document.getElementById('sched-list');
    if (!list.length) {
      el.innerHTML = '<div class="empty"><p>No jobs today</p></div>';
      return;
    }
    el.innerHTML = list.map((j) => `
      <div class="sched-item">
        <div class="si-time">${j.timeStart}<br>– ${j.timeEnd}</div>
        <div class="si-body">
          <div class="si-name">${j.customerFirst} ${j.customerLast}</div>
          <div class="si-loc">${j.address || ''}</div>
        </div>
        <div class="si-price">${P.money(j.serviceTotal)}</div>
      </div>`).join('');
  }

  function renderUpcoming() {
    const from = new Date(selectedDate + 'T12:00:00');
    const end = P.addDays(from, 7);
    const up = myJobs().filter((j) => {
      const d = new Date(j.date + 'T12:00:00');
      return d > from && d <= end;
    });
    const el = document.getElementById('upcoming');
    if (!up.length) {
      el.innerHTML = '<div class="empty"><div class="ei">📆</div><p>No upcoming jobs this week</p></div>';
      return;
    }
    el.innerHTML = '<div class="sched-list">' + up.map((j) => `
      <div class="sched-item">
        <div class="si-time">${new Date(j.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
        <div class="si-body">
          <div class="si-name">${j.customerFirst} ${j.customerLast}</div>
          <div class="si-loc">${j.timeStart} · ${j.address || ''}</div>
        </div>
        ${UI.statusBadge(j.status)}
      </div>`).join('') + '</div>';
  }

  function renderAllJobs() {
    const active = myJobs().filter((j) => !['completed_paid', 'completed_pending_admin_review'].includes(j.status));
    document.getElementById('all-jobs').innerHTML = active.length
      ? active.map((j) => `
        <div class="job-hero" style="margin-bottom:10px">
          <div class="job-name">${j.customerFirst} ${j.customerLast}</div>
          <div class="job-badges" style="margin:8px 0"><span class="badge badge-id mono">${j.id}</span>${UI.statusBadge(j.status)}</div>
          <div class="kv" style="font-size:12px">
            <div>${j.date} · ${j.timeStart} – ${j.timeEnd}</div>
            <div>${j.vehicle || ''}</div>
            <div>${j.address || ''}</div>
          </div>
        </div>`).join('')
      : '<div class="empty"><p>No active assignments</p></div>';
  }

  function jobCountByDate(dateStr) {
    return dayJobs(dateStr).length;
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
    renderHero(list[0] || null);
    renderList(selectedDate);
    renderUpcoming();
    renderAllJobs();
  }

  async function reloadJobs() {
    if (runtime.mode === 'live') {
      jobs = await API().techFetchJobs();
    } else {
      jobs = P.JOBS.map((j) => ({ ...j }));
    }
    refresh();
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const job = jobs.find((j) => j.id === btn.dataset.id);
    if (!job) return;
    const map = { enroute: 'en_route', arrive: 'arrived', complete: 'completed_pending_admin_review' };
    const status = map[btn.dataset.action];
    if (!status) return;
    try {
      if (runtime.mode === 'live') {
        await API().techUpdateStatus(job.id, status);
        await reloadJobs();
      } else {
        job.status = status;
        refresh();
      }
      UI.toast('Status → ' + (P.STATUS_LABELS[status] || status), 'ok');
    } catch (err) {
      UI.toast('Error: ' + err.message);
    }
  });

  document.getElementById('tab-jobs').addEventListener('click', () => {
    document.getElementById('view-dash').style.display = 'none';
    document.getElementById('view-jobs').style.display = 'block';
    document.querySelectorAll('.nav-pills .pill').forEach((p) => p.classList.remove('on'));
    document.getElementById('tab-jobs').classList.add('on');
  });
  document.querySelector('.nav-pills .pill.on').addEventListener('click', () => {
    document.getElementById('view-dash').style.display = 'block';
    document.getElementById('view-jobs').style.display = 'none';
    document.querySelectorAll('.nav-pills .pill').forEach((p) => p.classList.remove('on'));
    document.querySelector('.nav-pills .pill').classList.add('on');
  });
  document.getElementById('btn-signout').addEventListener('click', () => {
    if (runtime.mode === 'live') {
      sessionStorage.removeItem('cd1_tech_token');
      location.href = runtime.loginUrl || '/technician';
      return;
    }
    UI.toast('Sign out (mock)');
  });
  document.querySelector('.fab').addEventListener('click', () => UI.toast('Support chat'));

  (async function init() {
    runtime = await API().initPortal('technician');
    API().renderModeBanner(document.querySelector('.proto-banner'), runtime);
    await reloadJobs();
    if (runtime.error) UI.toast('Live load failed — mock: ' + runtime.error);
  })();
})();
