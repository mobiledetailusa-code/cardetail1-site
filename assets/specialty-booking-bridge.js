/**
 * Specialty-page booking bridge.
 * Opens the existing homepage booking modal in an on-page overlay iframe
 * so the visitor never leaves boats/RV/powersports pages.
 */
(function () {
  'use strict';

  var overlay = null;
  var frame = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'specialty-booking-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Booking');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2000',
      'background:rgba(2,4,10,.72)', 'display:none',
      'align-items:stretch', 'justify-content:stretch'
    ].join(';');

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close booking');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = [
      'position:absolute', 'top:10px', 'right:12px', 'z-index:2',
      'width:44px', 'height:44px', 'border:0', 'border-radius:999px',
      'background:rgba(18,25,34,.92)', 'color:#ece8e1', 'font:700 22px/1 DM Sans,sans-serif',
      'cursor:pointer'
    ].join(';');
    closeBtn.addEventListener('click', closeSpecialtyBooking);

    frame = document.createElement('iframe');
    frame.title = 'Cardetail1 booking';
    frame.style.cssText = 'width:100%;height:100%;border:0;background:transparent';
    frame.setAttribute('allow', 'payment');
    overlay.appendChild(closeBtn);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeSpecialtyBooking() {
    if (!overlay) return;
    overlay.style.display = 'none';
    if (frame) frame.src = 'about:blank';
    document.body.style.overflow = '';
  }

  function openSpecialtyBooking(categoryId, packageId) {
    var allowed = { boats: 1, rvs: 1, powersports: 1, cars: 1 };
    if (!allowed[categoryId]) {
      showBookingError('This service category is unavailable. Call or text 551-313-2956.');
      return;
    }
    ensureOverlay();
    var params = new URLSearchParams();
    params.set('book', categoryId);
    params.set('embed', '1');
    if (packageId) params.set('pkg', packageId);
    try {
      var urlZip = '';
      try {
        urlZip = new URLSearchParams(window.location.search || '').get('zip') || '';
      } catch (e0) {}
      var zip = String(urlZip || localStorage.getItem('cd1_zip') || sessionStorage.getItem('cd1_zip') || '').replace(/\D/g, '');
      if (zip.length === 5) params.set('zip', zip);
    } catch (e) {}
    // Stay on the specialty page URL; booking loads inside the overlay iframe only.
    frame.src = 'index.html?' + params.toString();
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    setTimeout(function () {
      try { frame.focus(); } catch (e) {}
    }, 80);
  }

  function showBookingError(msg) {
    var el = document.getElementById('specialty-booking-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'specialty-booking-error';
      el.setAttribute('role', 'alert');
      el.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;z-index:2100;max-width:520px;margin:0 auto;padding:14px 16px;border-radius:12px;background:#1a222c;border:1px solid #ef4444;color:#ece8e1;font:14px/1.45 DM Sans,sans-serif';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
  }

  window.openSpecialtyBooking = openSpecialtyBooking;
  window.closeSpecialtyBooking = closeSpecialtyBooking;

  window.addEventListener('message', function (ev) {
    if (!ev || !ev.data) return;
    if (ev.data.type === 'cd1-booking-closed') closeSpecialtyBooking();
    if (ev.data.type === 'cd1-booking-error') {
      closeSpecialtyBooking();
      showBookingError(ev.data.message || 'Booking could not open. Call or text 551-313-2956.');
    }
  });

  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-booking-category]') : null;
    if (!btn) return;
    ev.preventDefault();
    openSpecialtyBooking(
      btn.getAttribute('data-booking-category'),
      btn.getAttribute('data-booking-package') || null
    );
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && overlay && overlay.style.display === 'flex') {
      closeSpecialtyBooking();
    }
  });
})();
