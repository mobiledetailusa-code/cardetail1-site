/**
 * Technician dashboard prototype.
 */
(function () {
  const P = CD1Proto;
  const UI = CD1UI;
  const TECH_ID = 'tech-magno';
  let selectedDate = P.fmtDate(P.TODAY);
  let jobs = P.JOBS.map((j) => ({ ...j }));

  function myJobs() {
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
    const total = job.serviceTotal + job.travelFee;
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
          <div class="job-price">${P.money(total)}<span class="sub">fee ${P.money(job.travelFee)}</span></div>
        </div>
        <div class="job-meta">
          <div class="meta-item"><span class="ico">🕐</span><div><div class="lbl">ETA</div><div class="val">${job.eta}</div></div></div>
          <div class="meta-item"><span class="ico">🚗</span><div><div class="lbl">Vehicle</div><div class="val">${job.vehicle}</div></div></div>
          <div class="meta-item"><span class="ico">📍</span><div><div class="lbl">Location</div><div class="val">${job.address}</div></div></div>
        </div>
        <div class="actions">
          ${job.status === 'confirmed' || job.status === 'assigned' ? `<button type="button" class="btn btn-p" data-action="enroute" data-id="${job.id}">Start En Route</button>` : ''}
          ${job.status === 'en_route' ? `<button type="button" class="btn btn-gr" data-action="arrive" data-id="${job.id}">Mark Arrived</button>` : ''}
          ${job.status === 'arrived' || job.status === 'in_progress' ? `<button type="button" class="btn btn-gr" data-action="complete" data-id="${job.id}">Complete Job</button>` : ''}
          <a class="btn btn-g" href="https://maps.google.com/?q=${encodeURIComponent(job.address)}" target="_blank" rel="noopener">Open Maps</a>
        </div>
      </article>`;
    document.getElementById('map-wrap').innerHTML = `
      <div class="map-card">
        <iframe src="${CD1Calendar.mapEmbed(job)}" loading="lazy" title="Job location"></iframe>
        <div class="map-pin mono">${job.id}</div>
      </div>`;
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
          <div class="si-loc">${j.address}</div>
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
          <div class="si-loc">${j.timeStart} · ${j.address}</div>
        </div>
        ${UI.statusBadge(j.status)}
      </div>`).join('') + '</div>';
  }

  function renderAllJobs() {
    const active = myJobs().filter((j) => !['completed_paid'].includes(j.status));
    document.getElementById('all-jobs').innerHTML = active.length
      ? active.map((j) => `
        <div class="job-hero" style="margin-bottom:10px">
          <div class="job-name">${j.customerFirst} ${j.customerLast}</div>
          <div class="job-badges" style="margin:8px 0"><span class="badge badge-id mono">${j.id}</span>${UI.statusBadge(j.status)}</div>
          <div class="kv" style="font-size:12px">
            <div>${j.date} · ${j.timeStart} – ${j.timeEnd}</div>
            <div>${j.vehicle}</div>
            <div>${j.address}</div>
          </div>
        </div>`).join('')
      : '<div class="empty"><p>No active assignments</p></div>';
  }

  function refresh() {
    CD1Calendar.renderCalendar(document.getElementById('cal-strip'), {
      selectedDate,
      anchorDate: P.TODAY,
      onSelect: (d) => { selectedDate = d; refresh(); },
    });
    CD1Calendar.renderBanner(document.getElementById('cal-banner'), selectedDate);
    const list = dayJobs(selectedDate);
    renderHero(list[0] || null);
    renderList(selectedDate);
    renderUpcoming();
    renderAllJobs();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const job = jobs.find((j) => j.id === btn.dataset.id);
    if (!job) return;
    const map = { enroute: 'en_route', arrive: 'arrived', complete: 'completed_pending_admin_review' };
    if (map[btn.dataset.action]) {
      job.status = map[btn.dataset.action];
      UI.toast('Status → ' + P.STATUS_LABELS[job.status], 'ok');
      refresh();
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
  document.getElementById('btn-signout').addEventListener('click', () => UI.toast('Sign out (prototype)'));
  document.querySelector('.fab').addEventListener('click', () => UI.toast('Support chat (prototype)'));
  refresh();
})();
