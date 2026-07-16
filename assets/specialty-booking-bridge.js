/**
 * Specialty-page booking bridge.
 *
 * Opens the existing homepage booking UI in an on-page overlay iframe
 * (requires CSP frame-src 'self'). Embed mode hides homepage chrome and shows
 * only #bk-ov (see index.html cd1-booking-embed styles).
 *
 * On failure: inline recoverable error on the current page — never redirects
 * to homepage or falls back to Cars.
 *
 * Shared launcher: openCategoryPackageBooking({ categoryId, packageId, sourcePath })
 */
(function () {
  'use strict';

  var BOOKING_FAIL_MSG = 'We could not load this booking option. Please try again or call/text 551-313-2956.';
  var overlay = null;
  var frame = null;
  var styleInjected = false;
  var listenersBound = false;
  var loadWatchTimer = null;

  /** Real package IDs from index.html PRICING — do not invent. */
  var VALID_PACKAGES = {
    boats: { maint: 1, essential: 1, full: 1, premium: 1 },
    rvs: { maint: 1, maint_light: 1, interior: 1, premium: 1, full: 1 },
    powersports: { wash: 1, essential: 1, full: 1, premium: 1 }
  };

  function ensureFocusStyles() {
    if (styleInjected) return;
    styleInjected = true;
    var style = document.createElement('style');
    style.id = 'specialty-booking-bridge-css';
    style.textContent = [
      '.package-booking-cta:focus-visible,',
      '[data-booking-category]:focus-visible{',
      'outline:2px solid #4da3ff;outline-offset:3px;',
      '}',
      '#specialty-booking-overlay.is-open{display:flex!important}',
      '#specialty-booking-error[hidden]{display:none!important}'
    ].join('');
    document.head.appendChild(style);
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    ensureFocusStyles();
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
    frame.id = 'specialty-booking-frame';
    frame.title = 'Cardetail1 booking';
    frame.style.cssText = 'width:100%;height:100%;border:0;background:#02040a';
    frame.setAttribute('allow', 'payment');
    overlay.appendChild(closeBtn);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    return overlay;
  }

  function clearLoadWatch() {
    if (loadWatchTimer) {
      clearTimeout(loadWatchTimer);
      loadWatchTimer = null;
    }
  }

  function closeSpecialtyBooking() {
    clearLoadWatch();
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.classList.remove('is-open');
    if (frame) {
      frame.onload = null;
      frame.onerror = null;
      frame.src = 'about:blank';
    }
    document.body.style.overflow = '';
  }

  function logDiag(code, categoryId, packageId) {
    try {
      console.info('[cd1-booking]', {
        code: code,
        source: String(window.location.pathname || ''),
        categoryId: categoryId || '',
        packageId: packageId || ''
      });
    } catch (e) {}
  }

  function showBookingError(msg, code, categoryId, packageId) {
    logDiag(code || 'BOOKING_INIT_FAILED', categoryId, packageId);
    closeSpecialtyBooking();
    var el = document.getElementById('specialty-booking-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'specialty-booking-error';
      el.setAttribute('role', 'alert');
      el.style.cssText = [
        'position:fixed', 'bottom:16px', 'left:16px', 'right:16px', 'z-index:2100',
        'max-width:520px', 'margin:0 auto', 'padding:14px 16px', 'border-radius:12px',
        'background:#1a222c', 'border:1px solid #ef4444', 'color:#ece8e1',
        'font:14px/1.45 DM Sans,sans-serif'
      ].join(';');
      document.body.appendChild(el);
    }
    el.innerHTML = (msg || BOOKING_FAIL_MSG) +
      ' <a href="tel:5513132956" style="color:#4da3ff;font-weight:600;text-decoration:none">Call / Text</a>';
    el.hidden = false;
    try { el.focus(); } catch (e2) {}
  }

  function resolveZip() {
    var urlZip = '';
    try {
      urlZip = new URLSearchParams(window.location.search || '').get('zip') || '';
    } catch (e0) {}
    var zip = String(urlZip || localStorage.getItem('cd1_zip') || sessionStorage.getItem('cd1_zip') || '').replace(/\D/g, '');
    return zip.length === 5 ? zip : '';
  }

  function buildBookingParams(categoryId, packageId, embed, multiVehicle, lengthFt) {
    var params = new URLSearchParams();
    params.set('book', categoryId);
    if (embed) params.set('embed', '1');
    if (packageId) params.set('pkg', packageId);
    if (multiVehicle) params.set('multi', '1');
    var zip = resolveZip();
    if (zip) params.set('zip', zip);
    var ft = Number(lengthFt || 0);
    if (!ft) {
      try {
        ft = Number(sessionStorage.getItem('cd1_rv_length') || localStorage.getItem('cd1_rv_length') || 0);
      } catch (e1) { ft = 0; }
    }
    if (categoryId === 'rvs' && ft >= 12 && ft <= 45) params.set('length', String(ft));
    return params;
  }

  function iframeLooksBlocked() {
    if (!frame) return true;
    try {
      var doc = frame.contentDocument;
      if (!doc) return true;
      var html = doc.documentElement;
      var body = doc.body;
      var text = String((body && body.innerText) || '');
      if (/This content is blocked|refused to display|X-Frame-Options|frame-ancestors/i.test(text)) {
        return true;
      }
      if (html && html.classList && html.classList.contains('cd1-booking-embed')) {
        return false;
      }
      if (body && body.classList && body.classList.contains('cd1-booking-embed')) {
        return false;
      }
      if (doc.getElementById('bk-ov')) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  function failBooking(categoryId, packageId, code) {
    showBookingError(BOOKING_FAIL_MSG, code || 'BOOKING_INIT_FAILED', categoryId, packageId);
  }

  /**
   * Shared package launcher — validates IDs, opens existing booking UI.
   * @param {{categoryId:string, packageId?:string|null, sourcePath?:string, multiVehicle?:boolean}} opts
   */
  function openCategoryPackageBooking(opts) {
    opts = opts || {};
    var categoryId = String(opts.categoryId || '').toLowerCase();
    var packageId = opts.packageId ? String(opts.packageId) : '';
    var multiVehicle = opts.multiVehicle === true;
    var lengthFt = opts.lengthFt != null ? Number(opts.lengthFt) : 0;

    if (categoryId === 'cars' || categoryId === 'fleet') {
      failBooking(categoryId, packageId, 'INVALID_CATEGORY');
      return;
    }
    // Soft diagnostics only — never block specialty Book CTAs on the parent page.
    // CD1BookingRoutingGate / routeServiceIntent still run inside the embed.
    // Fleet / multi-vehicle intent uses Book Multiple Vehicles (alternative service path).
    try {
      if (window.CD1BookingRoutingGate && typeof window.CD1BookingRoutingGate.gatherContext === 'function') {
        window.CD1BookingRoutingGate.gatherContext({
          category: categoryId,
          source: 'specialty_bridge',
          vehicleCount: multiVehicle ? 2 : 0,
        });
      }
    } catch (eGate) { /* non-blocking */ }
    if (!VALID_PACKAGES[categoryId]) {
      failBooking(categoryId, packageId, 'INVALID_CATEGORY');
      return;
    }
    if (packageId && !VALID_PACKAGES[categoryId][packageId]) {
      failBooking(categoryId, packageId, 'INVALID_PACKAGE');
      return;
    }

    var errEl = document.getElementById('specialty-booking-error');
    if (errEl) errEl.hidden = true;

    try {
      ensureOverlay();
      clearLoadWatch();
      var params = buildBookingParams(categoryId, packageId, true, multiVehicle, lengthFt);
      var settled = false;

      function settleOk() {
        if (settled) return;
        settled = true;
        clearLoadWatch();
        logDiag('BOOKING_OPENED', categoryId, packageId);
      }

      function settleFail(code) {
        if (settled) return;
        settled = true;
        clearLoadWatch();
        failBooking(categoryId, packageId, code);
      }

      frame.onload = function () {
        setTimeout(function () {
          if (settled) return;
          if (iframeLooksBlocked()) {
            settleFail('IFRAME_BLOCKED');
            return;
          }
          settleOk();
        }, 450);
      };

      frame.onerror = function () {
        settleFail('IFRAME_ERROR');
      };

      frame.src = 'index.html?' + params.toString();
      overlay.style.display = 'flex';
      overlay.classList.add('is-open');
      document.body.style.overflow = 'hidden';

      loadWatchTimer = setTimeout(function () {
        if (settled) return;
        // Prefer success once overlay is visible — transient iframe probe races should not kill booking.
        if (overlay && overlay.classList.contains('is-open') && frame && frame.src && frame.src.indexOf('index.html') >= 0) {
          settleOk();
          return;
        }
        if (iframeLooksBlocked()) settleFail('IFRAME_TIMEOUT');
        else settleOk();
      }, 3200);

      setTimeout(function () {
        try { frame.focus(); } catch (e) {}
      }, 80);
    } catch (err) {
      failBooking(categoryId, packageId, 'BOOKING_OVERLAY_ERROR');
    }
  }

  function openSpecialtyBooking(categoryId, packageId) {
    openCategoryPackageBooking({
      categoryId: categoryId,
      packageId: packageId || null,
      sourcePath: window.location.pathname
    });
  }

  /** Stable helper for specialty + homepage dual CTAs. */
  function openCategoryBooking(category, opts) {
    opts = opts || {};
    openCategoryPackageBooking({
      categoryId: category,
      packageId: opts.packageId || null,
      multiVehicle: opts.multiVehicle === true,
      sourcePath: window.location.pathname
    });
  }

  window.openCategoryPackageBooking = openCategoryPackageBooking;
  window.openSpecialtyBooking = openSpecialtyBooking;
  window.openCategoryBooking = openCategoryBooking;
  window.closeSpecialtyBooking = closeSpecialtyBooking;
  window.launchBooking = function launchBooking(opts) {
    opts = opts || {};
    var cat = typeof opts === 'string' ? opts : (opts.category || opts.cat || '');
    openCategoryPackageBooking({
      categoryId: cat,
      packageId: opts.packageId || null,
      multiVehicle: opts.multiVehicle === true,
      sourcePath: window.location.pathname
    });
  };

  if (!listenersBound) {
    listenersBound = true;

    window.addEventListener('message', function (ev) {
      if (!ev || !ev.data) return;
      if (ev.data.type === 'cd1-booking-closed') closeSpecialtyBooking();
      if (ev.data.type === 'cd1-booking-error') {
        failBooking(
          ev.data.categoryId || '',
          ev.data.packageId || '',
          ev.data.code || 'IFRAME_BOOKING_ERROR'
        );
      }
    });

    document.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-booking-category]') : null;
      if (!btn) return;
      // Progressive enhancement: anchors still navigate if JS throws before preventDefault settles.
      ev.preventDefault();
      openCategoryPackageBooking({
        categoryId: btn.getAttribute('data-booking-category'),
        packageId: btn.getAttribute('data-booking-package') || null,
        multiVehicle: btn.getAttribute('data-booking-multi') === '1',
        lengthFt: btn.getAttribute('data-booking-length') || null,
        sourcePath: String(window.location.pathname || '')
      });
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay && overlay.classList.contains('is-open')) {
        closeSpecialtyBooking();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureFocusStyles);
  } else {
    ensureFocusStyles();
  }
})();
