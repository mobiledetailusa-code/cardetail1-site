/**
 * Shared UI helpers for prototype (toasts, drawer, status badges).
 */
(function (global) {
  let toastTimer;

  function toast(msg, type) {
    let el = document.getElementById('proto-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'proto-toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show' + (type === 'ok' ? ' ok' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function statusBadge(status) {
    const label = global.CD1Proto.STATUS_LABELS[status] || status;
    let cls = 'badge-st';
    if (['confirmed', 'assigned', 'accepted'].includes(status)) cls = 'badge-ac';
    if (['completed_paid'].includes(status)) cls = 'badge-ok';
    if (['pending_review', 'completed_pending_payment', 'issue_reported'].includes(status)) cls = 'badge-warn';
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function openDrawer(id) {
    document.getElementById('drawer-bg').classList.add('open');
    document.getElementById(id).classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    document.querySelectorAll('.drawer').forEach((d) => d.classList.remove('open'));
    document.getElementById('drawer-bg').classList.remove('open');
    document.body.style.overflow = '';
  }

  function bindDrawerClose() {
    const bg = document.getElementById('drawer-bg');
    if (!bg) return;
    bg.addEventListener('click', (e) => { if (e.target === bg) closeDrawer(); });
    document.querySelectorAll('[data-close-drawer]').forEach((btn) => {
      btn.addEventListener('click', closeDrawer);
    });
  }

  function customerTimelineStep(status) {
    const order = ['pending_review', 'confirmed', 'assigned', 'accepted', 'en_route', 'arrived', 'in_progress', 'completed_pending_admin_review', 'completed_pending_payment', 'completed_paid'];
    const idx = order.indexOf(status);
    if (status === 'completed_paid') return 4;
    if (idx >= order.indexOf('in_progress')) return 3;
    if (idx >= order.indexOf('en_route')) return 2;
    if (idx >= order.indexOf('confirmed')) return 1;
    return 0;
  }

  function renderTimeline(activeStep) {
    return global.CD1Proto.CUSTOMER_TIMELINE.map((s, i) => {
      let cls = 'tl-step';
      if (i < activeStep) cls += ' done';
      if (i === activeStep) cls += ' active';
      const icon = i < activeStep ? '✓' : i + 1;
      return `<div class="${cls}"><div class="tl-dot">${icon}</div><div class="tl-label">${s.label}</div></div>`;
    }).join('');
  }

  global.CD1UI = { toast, statusBadge, openDrawer, closeDrawer, bindDrawerClose, customerTimelineStep, renderTimeline };
})(window);
