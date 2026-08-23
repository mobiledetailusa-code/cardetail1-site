/**
 * Hub/city pages delegate booking to the authoritative index.html modal, which
 * has SIX customer-visible steps: 1 Category · 2 Package · 3 Vehicle · 4 Info ·
 * 5 Review · 6 Confirm. This header previously documented a
 * different step count; 6 is the value verified against BK_VISIBLE_STEPS in
 * index.html, and tests/booking-copy-drift.test.js keeps the two in sync.
 *
 * Each delegated page still carries its own inline checkout DOM (#bk-ov). When
 * this bridge takes control it hides that DOM via .cd1-hub-booking-delegated and
 * iframes index.html instead, so the inline copy is not customer-visible.
 *
 * The inline DOM is NOT dead, but it covers exactly one failure mode:
 *
 *   - this script never executes (asset 404, CSP/extension block, an earlier JS
 *     error, scripts disabled) -> the hiding CSS is never injected, #bk-ov stays
 *     visible and the inline modal handles booking. This is the fallback.
 *
 *   - this script executes but the iframe fails -> #bk-ov was ALREADY hidden by
 *     ensureStyles() before the frame was attached, so the customer gets
 *     #hub-booking-error and the phone number, NOT the inline modal. There is no
 *     booking form in this path.
 *
 * Read artifacts/reports/LEGACY_BOOKING_FALLBACK.md before changing or removing
 * either side of this.
 *
 * Documentation only — no runtime behavior is described here that the code does
 * not already do.
 */
(function (global) {
  'use strict';

  var path = String(global.location.pathname || '');
  if (global.document.body && global.document.body.classList.contains('cd1-booking-embed')) return;
  if (/^\/$/.test(path) || /index\.html$/i.test(path)) return;

  var isDelegatedHub = /-hub\.html$/i.test(path)
    || /-mobile-detailing\.html$/i.test(path)
    || /template-city\.html$/i.test(path);
  if (!isDelegatedHub) return;

  var BOOKING_FAIL_MSG = 'We could not load booking. Please try again or call/text 551-313-2956.';
  var overlay = null;
  var frame = null;
  var styleInjected = false;
  var pendingCategory = null;

  function ensureStyles() {
    if (styleInjected) return;
    styleInjected = true;
    global.document.documentElement.classList.add('cd1-hub-booking-delegated');
    var style = document.createElement('style');
    style.id = 'hub-booking-bridge-css';
    style.textContent = [
      'html.cd1-hub-booking-delegated #bk-ov{display:none!important;visibility:hidden!important;pointer-events:none!important}',
      '#hub-booking-overlay.is-open{display:flex!important}',
      '#hub-booking-error[hidden]{display:none!important}',
    ].join('');
    document.head.appendChild(style);
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    ensureStyles();
    overlay = document.createElement('div');
    overlay.id = 'hub-booking-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Booking');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2000',
      'background:rgba(2,4,10,.72)', 'display:none',
      'align-items:stretch', 'justify-content:stretch',
    ].join(';');

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close booking');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = [
      'position:absolute', 'top:10px', 'right:12px', 'z-index:2',
      'width:44px', 'height:44px', 'border:0', 'border-radius:999px',
      'background:rgba(18,25,34,.92)', 'color:#ece8e1', 'font:700 22px/1 DM Sans,sans-serif',
      'cursor:pointer',
    ].join(';');
    closeBtn.addEventListener('click', closeHubBooking);

    frame = document.createElement('iframe');
    frame.id = 'hub-booking-frame';
    frame.title = 'Cardetail1 booking';
    frame.style.cssText = 'width:100%;height:100%;border:0;background:#02040a';
    frame.setAttribute('allow', 'payment');
    overlay.appendChild(closeBtn);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeHubBooking() {
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.classList.remove('is-open');
    if (frame) frame.src = 'about:blank';
    document.body.style.overflow = '';
  }

  function resolveZip() {
    var urlZip = '';
    try { urlZip = new URLSearchParams(global.location.search || '').get('zip') || ''; } catch (e0) {}
    var zip = String(urlZip || localStorage.getItem('cd1_zip') || sessionStorage.getItem('cd1_zip') || '').replace(/\D/g, '');
    return zip.length === 5 ? zip : '';
  }

  function buildParams(cat, pkgId) {
    var params = new URLSearchParams();
    params.set('embed', '1');
    if (cat) params.set('book', cat);
    if (pkgId) params.set('pkg', pkgId);
    var zip = resolveZip();
    if (zip) params.set('zip', zip);
    try {
      var sid = global.Cardetail1Revenue && global.Cardetail1Revenue.getSessionId();
      if (/^sess_[A-Za-z0-9_-]{8,120}$/.test(String(sid || ''))) params.set('cd1_session', sid);
    } catch (e) { /* booking still opens without analytics */ }
    return params;
  }

  function iframeReady() {
    if (!frame) return false;
    try {
      var doc = frame.contentDocument;
      if (!doc) return false;
      var booking = doc.getElementById('bk-ov');
      var active = doc.querySelector('.bsec.on');
      if (!booking || !active || !doc.body || !doc.body.classList.contains('cd1-booking-embed')) return false;
      var style = frame.contentWindow && frame.contentWindow.getComputedStyle
        ? frame.contentWindow.getComputedStyle(booking)
        : null;
      return !(style && (style.display === 'none' || style.visibility === 'hidden'));
    } catch (e) {
      return false;
    }
  }

  function openDelegatedBooking(cat, pkgId) {
    if (cat === 'fleet') {
      if (typeof global.openCommercialInquiry === 'function') global.openCommercialInquiry();
      return;
    }
    try {
      ensureOverlay();
      pendingCategory = cat || 'general';
      var params = buildParams(cat, pkgId);
      frame.onload = function () {
        setTimeout(function () {
          if (!iframeReady()) {
            showError();
            return;
          }
          if (global.CD1CanonicalFunnel && typeof global.CD1CanonicalFunnel.delegatedBookingReady === 'function') {
            global.CD1CanonicalFunnel.delegatedBookingReady(pendingCategory);
          }
        }, 300);
      };
      frame.src = 'index.html?' + params.toString();
      overlay.style.display = 'flex';
      overlay.classList.add('is-open');
      document.body.style.overflow = 'hidden';
    } catch (err) {
      showError();
    }
  }

  function showError() {
    closeHubBooking();
    var el = document.getElementById('hub-booking-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hub-booking-error';
      el.setAttribute('role', 'alert');
      el.style.cssText = [
        'position:fixed', 'bottom:16px', 'left:16px', 'right:16px', 'z-index:2100',
        'max-width:520px', 'margin:0 auto', 'padding:14px 16px', 'border-radius:12px',
        'background:#1a222c', 'border:1px solid #ef4444', 'color:#ece8e1',
        'font:14px/1.45 DM Sans,sans-serif',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = BOOKING_FAIL_MSG;
    el.hidden = false;
  }

  function wrap(name, fn) {
    if (typeof fn !== 'function' || fn._hubBridge) return;
    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      if (name === 'openBooking' && args[0] === 'fleet') {
        return fn.apply(global, args);
      }
      if (name === 'openBookingFromHome') {
        return openDelegatedBooking(args[0] || null, null);
      }
      if (name === 'openBookingCarPkg') {
        return openDelegatedBooking('cars', args[0] || null);
      }
      return openDelegatedBooking(args[0] || null, null);
    };
    wrapped._hubBridge = true;
    global[name] = wrapped;
  }

  function init() {
    ensureStyles();
    wrap('openBooking', global.openBooking);
    wrap('openBookingFromHome', global.openBookingFromHome);
    wrap('openBookingCarPkg', global.openBookingCarPkg);

    global.addEventListener('message', function (ev) {
      if (!ev || !ev.data) return;
      if (ev.data.type === 'cd1-booking-closed') closeHubBooking();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay && overlay.classList.contains('is-open')) closeHubBooking();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.CD1HubBookingBridge = { openDelegatedBooking: openDelegatedBooking, closeHubBooking: closeHubBooking };
})(typeof window !== 'undefined' ? window : globalThis);
