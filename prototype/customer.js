/**
 * Customer portal prototype — shows contracted service total ONLY (no travel/fee split).
 */
(function () {
  const P = CD1Proto;
  const UI = CD1UI;
  const CUSTOMER_ID = 'cust-brody';
  let selectedDate = P.fmtDate(P.TODAY);

  function myBookings() {
    return P.jobsForCustomer(CUSTOMER_ID);
  }

  function upcoming() {
    const today = P.fmtDate(P.TODAY);
    return myBookings().filter((j) => j.date >= today && j.status !== 'cancelled' && j.status !== 'completed_paid');
  }

  function past() {
    return myBookings().filter((j) => j.status === 'completed_paid' || j.date < P.fmtDate(P.TODAY));
  }

  function nextAppt() {
    const up = upcoming().sort((a, b) => a.date.localeCompare(b.date));
    return up[0] || null;
  }

  function apptOnDate(date) {
    return myBookings().find((j) => j.date === date && j.status !== 'cancelled');
  }

  function renderHero(job) {
    if (!job) {
      document.getElementById('hero-appt').innerHTML = '<div class="empty"><div class="ei">📅</div><p>No appointment on this date</p></div>';
      document.getElementById('timeline-wrap').innerHTML = '';
      document.getElementById('map-wrap').innerHTML = '';
      return;
    }

    const total = P.customerServiceTotal(job);
    const step = UI.customerTimelineStep(job.status);

    document.getElementById('hero-appt').innerHTML = `
      <article class="job-hero">
        <div style="font-size:11px;font-weight:700;color:var(--teal);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Your Next Service</div>
        <div class="job-hero-top">
          <div>
            <div class="job-name">${job.packageName}</div>
            <div class="job-badges">
              <span class="badge badge-id mono">${job.id}</span>
              ${UI.statusBadge(job.status)}
            </div>
          </div>
        </div>
        <div class="customer-total">${P.money(total)}</div>
        <div class="customer-total-note">Total contracted service value</div>
        <div class="job-meta" style="margin-top:14px">
          <div class="meta-item"><span class="ico">📅</span><div><div class="lbl">Date</div><div class="val">${P.fmtDisplay(new Date(job.date + 'T12:00:00'))}</div></div></div>
          <div class="meta-item"><span class="ico">🕐</span><div><div class="lbl">Window</div><div class="val">${job.timeStart} – ${job.timeEnd}</div></div></div>
          <div class="meta-item"><span class="ico">🚗</span><div><div class="lbl">Vehicle</div><div class="val">${job.vehicle}</div></div></div>
          <div class="meta-item"><span class="ico">📍</span><div><div class="lbl">Service address</div><div class="val">${job.address}</div></div></div>
        </div>
        <div class="actions">
          <button type="button" class="btn btn-g" data-action="reschedule">Request New Date</button>
          ${job.amountDue > 0 ? `<button type="button" class="btn btn-p" data-action="pay">Pay Balance ${P.money(job.amountDue)}</button>` : ''}
          <button type="button" class="btn btn-g" data-action="support">Contact Support</button>
        </div>
      </article>`;

    document.getElementById('timeline-wrap').innerHTML = `
      <div class="sec-title" style="margin-top:8px">Service Status</div>
      <div class="timeline">${UI.renderTimeline(step)}</div>`;

    document.getElementById('map-wrap').innerHTML = `
      <div class="map-card">
        <iframe src="${CD1Calendar.mapEmbed(job)}" loading="lazy" title="Service location"></iframe>
      </div>`;
  }

  function renderUpcomingList() {
    const up = upcoming().filter((j) => j.date !== selectedDate);
    const el = document.getElementById('upcoming-list');
    if (!up.length) {
      el.innerHTML = '<div class="empty"><p>No other upcoming appointments</p></div>';
      return;
    }
    el.innerHTML = up.map((j) => `
      <div class="sched-item" data-date="${j.date}">
        <div class="si-time">${new Date(j.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}<br>${j.timeStart}</div>
        <div class="si-body">
          <div class="si-name">${j.packageName}</div>
          <div class="si-loc">${j.vehicle}</div>
        </div>
        <div class="si-price">${P.money(P.customerServiceTotal(j))}</div>
      </div>`).join('');
  }

  function renderPast() {
    const items = past().filter((j) => j.status === 'completed_paid');
    const el = document.getElementById('past-list');
    if (!items.length) {
      el.innerHTML = '<div class="empty"><p>No past services yet</p></div>';
      return;
    }
    el.innerHTML = items.map((j) => `
      <div class="past-card">
        <div>
          <div class="pc-name">${j.packageName}</div>
          <div class="pc-meta">${new Date(j.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · ${j.vehicle}</div>
        </div>
        <div style="font-weight:700;color:var(--green)">${P.money(P.customerServiceTotal(j))}</div>
      </div>`).join('');
  }

  function customerCalendarDays() {
    const days = P.weekDays(P.TODAY);
    return days.map((d) => {
      const hasAppt = myBookings().some((j) => j.date === d.date && j.status !== 'cancelled');
      return { ...d, jobCount: hasAppt ? 1 : 0 };
    });
  }

  function renderCalendar() {
    const container = document.getElementById('cal-strip');
    const days = customerCalendarDays();
    const sel = selectedDate;
    container.innerHTML = days.map((d) => {
      const classes = ['cal-day'];
      if (d.isToday) classes.push('today');
      if (d.date === sel) classes.push('sel');
      const label = d.jobCount ? '1 appt' : '—';
      return `<button type="button" class="${classes.join(' ')}" data-date="${d.date}">
        <div class="dn">${d.dayName}</div>
        <div class="dd">${d.dayNum}</div>
        <div class="dm">${d.month}</div>
        <div class="jc">${label}</div>
      </button>`;
    }).join('');
    container.querySelectorAll('.cal-day').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedDate = btn.dataset.date;
        refresh();
      });
    });
  }

  function refresh() {
    renderCalendar();
    CD1Calendar.renderBanner(document.getElementById('cal-banner'), selectedDate);
    const appt = apptOnDate(selectedDate) || (selectedDate === P.fmtDate(P.TODAY) ? nextAppt() : null);
    renderHero(appt);
    renderUpcomingList();
    renderPast();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const actions = {
      reschedule: 'Reschedule request submitted (prototype)',
      pay: 'Opening Stripe Payment Element (prototype)',
      support: 'Support chat opened (prototype)',
    };
    UI.toast(actions[btn.dataset.action] || 'Action (prototype)');
  });

  document.getElementById('btn-signout').addEventListener('click', () => UI.toast('Sign out (prototype)'));
  document.querySelector('.fab').addEventListener('click', () => UI.toast('Contact support (prototype)'));
  refresh();
})();
