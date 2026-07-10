/**
 * Specialty-page booking bridge.
 * Opens the existing homepage booking modal in an on-page overlay iframe
 * so the visitor never leaves boats/RV/powersports pages.
 *
 * Shared launcher: openCategoryPackageBooking({ categoryId, packageId, sourcePath })
 * Alias: openSpecialtyBooking(categoryId, packageId)
 */
(function () {
  'use strict';

  var overlay = null;
  var frame = null;
  var styleInjected = false;
  var listenersBound = false;

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
    overlay.className = '';
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

  function closeSpecialtyBooking() {
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.classList.remove('is-open');
    if (frame) frame.src = 'about:blank';
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

  /**
   * Shared package launcher — validates IDs, opens existing booking UI locally.
   * @param {{categoryId:string, packageId?:string|null, sourcePath?:string}} opts
   */
  function openCategoryPackageBooking(opts) {
    opts = opts || {};
    var categoryId = String(opts.categoryId || '').toLowerCase();
    var packageId = opts.packageId ? String(opts.packageId) : '';
    var sourcePath = opts.sourcePath || String(window.location.pathname || '');

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

    try {
      ensureOverlay();
      var params = new URLSearchParams();
      params.set('book', categoryId);
      params.set('embed', '1');
      if (packageId) params.set('pkg', packageId);
      var zip = resolveZip();
      if (zip) params.set('zip', zip);
      // Stay on the specialty page URL; booking loads inside the overlay iframe only.
      frame.onload = function () {
        try {
          var doc = frame.contentDocument;
          if (!doc) return;
          var embedOk = doc.documentElement && doc.documentElement.classList.contains('cd1-booking-embed');
          var bk = doc.getElementById('bk-ov');
          if (!embedOk || !bk) {
            showBookingError(
              'We could not load this package. Please try again or call/text 551-313-2956.',
              'EMBED_INIT_FAILED',
              categoryId,
              packageId
            );
            closeSpecialtyBooking();
          }
        } catch (e) {
          /* same-origin expected; ignore cross-origin edge cases */
        }
      };
      frame.src = 'index.html?' + params.toString();
      overlay.style.display = 'flex';
      overlay.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      setTimeout(function () {
        try { frame.focus(); } catch (e) {}
      }, 80);
      logDiag('BOOKING_OPENED', categoryId, packageId);
    } catch (err) {
      showBookingError(
        'We could not load this package. Please try again or call/text 551-313-2956.',
        'LAUNCHER_EXCEPTION',
        categoryId,
        packageId
      );
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
        closeSpecialtyBooking();
        showBookingError(
          ev.data.message || 'We could not load this package. Please try again or call/text 551-313-2956.',
          ev.data.code || 'IFRAME_BOOKING_ERROR',
          ev.data.categoryId,
          ev.data.packageId
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
