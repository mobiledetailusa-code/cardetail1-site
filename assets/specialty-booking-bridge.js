/**
 * Specialty-page booking bridge.
 *
 * Preferred: open the existing homepage booking UI in an on-page overlay iframe
 * (requires CSP frame-src 'self').
 *
 * Fallback: if the iframe is blocked (CSP / "This content is blocked"), navigate
 * to the homepage booking with the same category + package + ZIP preselected.
 *
 * Shared launcher: openCategoryPackageBooking({ categoryId, packageId, sourcePath })
 */
(function () {
  'use strict';

  var overlay = null;
  var frame = null;
  var styleInjected = false;
  var listenersBound = false;
  var loadWatchTimer = null;

  /** Real package IDs from index.html PRICING — do not invent. */
  var VALID_PACKAGES = {
    boats: { maint: 1, essential: 1, full: 1, premium: 1 },
    rvs: { exterior: 1, interior: 1, full: 1, premium: 1 },
    powersports: { wash: 1, essential: 1, full: 1, premium: 1 },
    cars: { maint: 1, essential: 1, full: 1, premium: 1 }
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
    var el = document.getElementById('specialty-booking-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'specialty-booking-error';
      el.setAttribute('role', 'alert');
      el.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;z-index:2100;max-width:520px;margin:0 auto;padding:14px 16px;border-radius:12px;background:#1a222c;border:1px solid #ef4444;color:#ece8e1;font:14px/1.45 DM Sans,sans-serif';
      document.body.appendChild(el);
    }
    el.textContent = msg || 'We could not load this package. Please try again or call/text 551-313-2956.';
    el.hidden = false;
  }

  function resolveZip() {
    var urlZip = '';
    try {
      urlZip = new URLSearchParams(window.location.search || '').get('zip') || '';
    } catch (e0) {}
    var zip = String(urlZip || localStorage.getItem('cd1_zip') || sessionStorage.getItem('cd1_zip') || '').replace(/\D/g, '');
    return zip.length === 5 ? zip : '';
  }

  function buildBookingParams(categoryId, packageId, embed) {
    var params = new URLSearchParams();
    params.set('book', categoryId);
    if (embed) params.set('embed', '1');
    if (packageId) params.set('pkg', packageId);
    var zip = resolveZip();
    if (zip) params.set('zip', zip);
    return params;
  }

  /** Same booking engine as homepage — top-level navigation (no iframe). */
  function navigateToHomepageBooking(categoryId, packageId) {
    var params = buildBookingParams(categoryId, packageId, false);
    logDiag('BOOKING_NAV_FALLBACK', categoryId, packageId);
    window.location.assign('index.html?' + params.toString());
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
      // Successful embed marks html/body with cd1-booking-embed
      if (html && html.classList && html.classList.contains('cd1-booking-embed')) {
        return false;
      }
      if (body && body.classList && body.classList.contains('cd1-booking-embed')) {
        return false;
      }
      // Loaded something that is not embed mode
      if (doc.getElementById('bk-ov')) return false;
      return true;
    } catch (e) {
      // Cross-origin / CSP denial
      return true;
    }
  }

  /**
   * Shared package launcher — validates IDs, opens existing booking UI.
   * @param {{categoryId:string, packageId?:string|null, sourcePath?:string}} opts
   */
  function openCategoryPackageBooking(opts) {
    opts = opts || {};
    var categoryId = String(opts.categoryId || '').toLowerCase();
    var packageId = opts.packageId ? String(opts.packageId) : '';

    if (!VALID_PACKAGES[categoryId]) {
      showBookingError(
        'We could not load this package. Please try again or call/text 551-313-2956.',
        'INVALID_CATEGORY',
        categoryId,
        packageId
      );
      return;
    }
    if (packageId && !VALID_PACKAGES[categoryId][packageId]) {
      showBookingError(
        'We could not load this package. Please try again or call/text 551-313-2956.',
        'INVALID_PACKAGE',
        categoryId,
        packageId
      );
      return;
    }

    // Prefer overlay; fall back to homepage booking if iframe cannot load.
    try {
      ensureOverlay();
      clearLoadWatch();
      var params = buildBookingParams(categoryId, packageId, true);
      var settled = false;

      function settleOk() {
        if (settled) return;
        settled = true;
        clearLoadWatch();
        logDiag('BOOKING_OPENED', categoryId, packageId);
      }

      function settleFallback(code) {
        if (settled) return;
        settled = true;
        clearLoadWatch();
        closeSpecialtyBooking();
        navigateToHomepageBooking(categoryId, packageId);
        logDiag(code || 'IFRAME_BLOCKED_FALLBACK', categoryId, packageId);
      }

      frame.onload = function () {
        // Give embed init a moment (openBookingFromQuery uses setTimeout 120ms)
        setTimeout(function () {
          if (settled) return;
          if (iframeLooksBlocked()) {
            settleFallback('IFRAME_BLOCKED');
            return;
          }
          settleOk();
        }, 280);
      };

      frame.onerror = function () {
        settleFallback('IFRAME_ERROR');
      };

      frame.src = 'index.html?' + params.toString();
      overlay.style.display = 'flex';
      overlay.classList.add('is-open');
      document.body.style.overflow = 'hidden';

      // Hard timeout: if CSP blocks without a useful onload, fall back.
      loadWatchTimer = setTimeout(function () {
        if (settled) return;
        if (iframeLooksBlocked()) settleFallback('IFRAME_TIMEOUT');
        else settleOk();
      }, 1800);

      setTimeout(function () {
        try { frame.focus(); } catch (e) {}
      }, 80);
    } catch (err) {
      navigateToHomepageBooking(categoryId, packageId);
    }
  }

  function openSpecialtyBooking(categoryId, packageId) {
    openCategoryPackageBooking({
      categoryId: categoryId,
      packageId: packageId || null,
      sourcePath: window.location.pathname
    });
  }

  window.openCategoryPackageBooking = openCategoryPackageBooking;
  window.openSpecialtyBooking = openSpecialtyBooking;
  window.closeSpecialtyBooking = closeSpecialtyBooking;

  if (!listenersBound) {
    listenersBound = true;

    window.addEventListener('message', function (ev) {
      if (!ev || !ev.data) return;
      if (ev.data.type === 'cd1-booking-closed') closeSpecialtyBooking();
      if (ev.data.type === 'cd1-booking-error') {
        // Prefer homepage booking over a dead overlay when embed reports failure.
        var cat = ev.data.categoryId || '';
        var pkg = ev.data.packageId || '';
        closeSpecialtyBooking();
        if (cat && VALID_PACKAGES[cat]) {
          navigateToHomepageBooking(cat, pkg || null);
          return;
        }
        showBookingError(
          ev.data.message || 'We could not load this package. Please try again or call/text 551-313-2956.',
          ev.data.code || 'IFRAME_BOOKING_ERROR',
          cat,
          pkg
        );
      }
    });

    document.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-booking-category]') : null;
      if (!btn) return;
      ev.preventDefault();
      openCategoryPackageBooking({
        categoryId: btn.getAttribute('data-booking-category'),
        packageId: btn.getAttribute('data-booking-package') || null,
        sourcePath: window.location.pathname
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
