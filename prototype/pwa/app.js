/**
 * Cardetail1 customer PWA prototype — tab shell + install + offline chrome.
 * Mock data only. Production portals / APIs unchanged.
 */
(function () {
  const CUSTOMER_ID = 'cust-brody';
  const P = window.CD1Proto;
  const TL_LABELS = ['Booked', 'Confirmed', 'En route', 'Done'];

  let deferredPrompt = null;
  let installDismissed = false;

  try {
    installDismissed = sessionStorage.getItem('cd1-pwa-install-dismiss') === '1';
  } catch (_) { /* ignore */ }

  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function money(n) {
    return P ? P.money(n) : `$${Number(n || 0).toFixed(0)}`;
  }

  function myJobs() {
    if (!P) return [];
    return P.jobsForCustomer(CUSTOMER_ID);
  }

  function todayStr() {
    return P ? P.fmtDate(P.TODAY) : '2026-08-28';
  }

  function upcoming() {
    const t = todayStr();
    return myJobs()
      .filter((j) => j.date >= t && !['cancelled', 'completed_paid'].includes(j.status))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  function past() {
    return myJobs()
      .filter((j) => j.status === 'completed_paid' || j.date < todayStr())
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  function timelineStep(status) {
    if (status === 'completed_paid' || status === 'completed_pending_payment') return 3;
    if (status === 'en_route' || status === 'in_progress') return 2;
    if (['confirmed', 'assigned', 'accepted'].includes(status)) return 1;
    return 0;
  }

  function statusClass(status) {
    if (status === 'completed_paid') return 'ok';
    if (['pending_review', 'completed_pending_payment', 'issue_reported'].includes(status)) return 'warn';
    return 'ac';
  }

  function statusLabel(status) {
    return (P && P.STATUS_LABELS && P.STATUS_LABELS[status]) || status;
  }

  function renderTimeline(el, step) {
    if (!el) return;
    el.innerHTML = TL_LABELS.map((label, i) => {
      let cls = 'tl-step';
      if (i < step) cls += ' done';
      if (i === step) cls += ' on';
      return `<div class="${cls}"><span>${label}</span></div>`;
    }).join('');
  }

  function renderHero() {
    const job = upcoming()[0];
    const hero = document.getElementById('next-hero');
    const tl = document.getElementById('home-timeline');
    if (!hero) return;

    if (!job) {
      hero.innerHTML = `
        <div class="kicker">No upcoming service</div>
        <div class="pkg">Book your next detail</div>
        <div class="meta">Same website funnel — app only wraps My Garage.</div>
        <div class="hero-actions">
          <a class="btn primary" href="../../index.html#book">Book on site</a>
        </div>`;
      renderTimeline(tl, 0);
      return;
    }

    const total = P.customerServiceTotal(job);
    const step = timelineStep(job.status);
    hero.innerHTML = `
      <div class="kicker">Next service</div>
      <div class="pkg">${job.packageName}</div>
      <div class="meta">${job.date} · ${job.timeStart}–${job.timeEnd} · ${job.vehicle || ''}</div>
      <div class="total">${money(total)}</div>
      <div class="total-note">Total contracted service · ${job.address || ''}</div>
      <div class="hero-actions">
        ${job.amountDue > 0 ? `<button type="button" class="btn primary" data-mock="pay">Pay ${money(job.amountDue)}</button>` : ''}
        <button type="button" class="btn" data-mock="reschedule">Request new date</button>
        <button type="button" class="btn ghost" data-mock="map">Open map</button>
      </div>`;
    renderTimeline(tl, step);
  }

  function bookingCard(job) {
    const total = P.customerServiceTotal(job);
    return `
      <article class="card">
        <div class="row">
          <div>
            <div class="title">${job.packageName}</div>
            <div class="sub">${job.date} · ${job.timeStart}<br>${job.vehicle || ''}</div>
          </div>
          <span class="badge ${statusClass(job.status)}">${statusLabel(job.status)}</span>
        </div>
        <div class="sub" style="margin-top:10px;font-weight:800;color:var(--green);font-size:15px">${money(total)}</div>
      </article>`;
  }

  function renderBookings() {
    const up = upcoming();
    const pa = past();
    const upEl = document.getElementById('list-upcoming');
    const paEl = document.getElementById('list-past');
    if (upEl) {
      upEl.innerHTML = up.length
        ? up.map(bookingCard).join('')
        : '<div class="empty">No upcoming appointments</div>';
    }
    if (paEl) {
      paEl.innerHTML = pa.length
        ? pa.map(bookingCard).join('')
        : '<div class="empty">No past services yet</div>';
    }
  }

  function renderVehicles() {
    const el = document.getElementById('list-vehicles');
    if (!el) return;
    const seen = new Map();
    myJobs().forEach((j) => {
      if (j.vehicle && !seen.has(j.vehicle)) seen.set(j.vehicle, j);
    });
    const list = [...seen.values()];
    if (!list.length) {
      el.innerHTML = '<div class="empty">No saved vehicles in mock data</div>';
      return;
    }
    el.innerHTML = list.map((j) => `
      <div class="vehicle">
        <div class="ico" aria-hidden="true">🚗</div>
        <div>
          <div class="name">${j.vehicle}</div>
          <div class="meta">Last package: ${j.packageName}</div>
        </div>
      </div>`).join('');
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.classList.toggle('on', s.dataset.screen === name);
    });
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('on', t.dataset.tab === name);
    });
    try {
      const url = new URL(location.href);
      url.searchParams.set('tab', name);
      history.replaceState(null, '', url);
    } catch (_) { /* ignore */ }
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }

  function updateAccountMeta() {
    const display = document.getElementById('acct-display');
    const swEl = document.getElementById('acct-sw');
    if (display) display.textContent = isStandalone() ? 'Installed (standalone)' : 'Browser tab';
    if (!swEl) return;
    if (!('serviceWorker' in navigator)) {
      swEl.textContent = 'Unsupported';
      return;
    }
    navigator.serviceWorker.getRegistration().then((reg) => {
      swEl.textContent = reg ? 'Active' : 'Not registered';
    }).catch(() => { swEl.textContent = 'Error'; });
  }

  function syncNetworkUi() {
    const online = navigator.onLine;
    const chip = document.getElementById('offline-chip');
    const dot = document.getElementById('net-dot');
    if (chip) chip.classList.toggle('show', !online);
    if (dot) {
      dot.classList.toggle('offline', !online);
      dot.title = online ? 'Online' : 'Offline';
    }
  }

  function maybeShowInstall() {
    const bar = document.getElementById('install-bar');
    if (!bar) return;
    const show = !isStandalone() && !installDismissed && (!!deferredPrompt || /iPhone|iPad|iPod/i.test(navigator.userAgent));
    bar.classList.toggle('show', show);
    const btn = document.getElementById('btn-install');
    if (btn && !deferredPrompt && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      btn.textContent = 'How';
    }
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) {
      updateAccountMeta();
      return;
    }
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(() => updateAccountMeta())
      .catch(() => updateAccountMeta());
  }

  function bind() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => showScreen(tab.dataset.tab));
    });

    document.querySelectorAll('[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => showScreen(btn.dataset.go));
    });

    document.getElementById('btn-support')?.addEventListener('click', () => {
      toast('Support mock — production uses SMS / portal chat later');
    });

    document.getElementById('btn-add-vehicle')?.addEventListener('click', () => {
      toast('Add vehicle is mock-only in this prototype');
    });

    document.getElementById('next-hero')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mock]');
      if (!btn) return;
      const map = {
        pay: 'Pay balance → production My Garage checkout',
        reschedule: 'Reschedule → production request flow',
        map: 'Map link would open Maps app / web',
      };
      toast(map[btn.dataset.mock] || 'Mock action');
    });

    document.getElementById('btn-dismiss-install')?.addEventListener('click', () => {
      installDismissed = true;
      try { sessionStorage.setItem('cd1-pwa-install-dismiss', '1'); } catch (_) { /* ignore */ }
      document.getElementById('install-bar')?.classList.remove('show');
    });

    document.getElementById('btn-install')?.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        deferredPrompt = null;
        document.getElementById('install-bar')?.classList.remove('show');
        toast(choice.outcome === 'accepted' ? 'Installing…' : 'Install dismissed');
        updateAccountMeta();
        return;
      }
      toast('iOS: Share → Add to Home Screen');
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      maybeShowInstall();
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      document.getElementById('install-bar')?.classList.remove('show');
      toast('My Garage installed');
      updateAccountMeta();
    });

    window.addEventListener('online', syncNetworkUi);
    window.addEventListener('offline', syncNetworkUi);
  }

  function boot() {
    if (!P) {
      document.getElementById('next-hero').innerHTML = '<div class="pkg">Mock data failed to load</div>';
      return;
    }
    renderHero();
    renderBookings();
    renderVehicles();
    bind();
    syncNetworkUi();
    maybeShowInstall();
    registerSw();
    updateAccountMeta();

    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab && ['home', 'bookings', 'garage', 'account'].includes(tab)) {
      showScreen(tab);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
