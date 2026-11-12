/**
 * Hub/city pages delegate booking to the authoritative index.html modal, which
 * has SIX customer-visible steps: 1 Category · 2 Package · 3 Vehicle · 4 Info ·
 * 5 Review & Submit · 6 Request Sent. This header previously documented a
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

  var isDelegatedHub = /-hub(?:\.html)?\/?$/i.test(path)
    || /-mobile-detailing(?:\.html)?\/?$/i.test(path)
    || /template-city(?:\.html)?\/?$/i.test(path);
  if (!isDelegatedHub) return;

  var BOOKING_FAIL_MSG = 'We could not load booking. Please try again or call/text (551) 389-3986.';
  var overlay = null;
  var frame = null;
  var styleInjected = false;

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

  // Element that opened the overlay; focus goes back to it on close (keyboard users).
  var opener = null;
  // Page siblings made inert while the dialog is open, so Tab/Shift+Tab cannot
  // leave the dialog for the page behind it. Only elements we changed are restored.
  var inerted = [];
  var inertObserver = null;

  // The consent banner (z-index above this dialog) must stay answerable while
  // booking is open; consent rules are not this bridge's to change.
  var KEEP_INTERACTIVE = { 'hub-booking-error': 1, 'cd1-consent-banner': 1 };

  function inertOne(el) {
    if (!el || el.nodeType !== 1 || el === overlay || KEEP_INTERACTIVE[el.id] || el.tagName === 'SCRIPT' || el.inert) return;
    el.inert = true;
    inerted.push(el);
  }

  function setBackgroundInert(on) {
    if (on) {
      Array.prototype.forEach.call(document.body.children, inertOne);
      // Widgets injected while the dialog is open (chat, offers) stay behind it too.
      if (!inertObserver && typeof MutationObserver === 'function') {
        inertObserver = new MutationObserver(function (records) {
          records.forEach(function (r) { Array.prototype.forEach.call(r.addedNodes, inertOne); });
        });
        inertObserver.observe(document.body, { childList: true });
      }
      return;
    }
    if (inertObserver) { inertObserver.disconnect(); inertObserver = null; }
    inerted.forEach(function (el) { el.inert = false; });
    inerted = [];
  }

  function closeHubBooking() {
    if (!overlay) return;
    var wasOpen = overlay.classList.contains('is-open');
    overlay.style.display = 'none';
    overlay.classList.remove('is-open');
    if (frame) {
      frame.onload = null; // the about:blank load below is not a booking load
      frame.src = 'about:blank';
    }
    document.body.style.overflow = '';
    setBackgroundInert(false);
    if (wasOpen && opener && document.contains(opener) && typeof opener.focus === 'function') {
      try { opener.focus(); } catch (eFocus) {}
    }
    opener = null;
  }

  // Layers inside the booking that handle Escape themselves (package details,
  // address / make / model suggestions, login). If one is open when Escape is
  // pressed, Escape belongs to it and the booking dialog stays open.
  var INNER_LAYER_OPEN = [
    '#car-pkg-detail-ov:not([hidden])',
    '#login-ov.open',
    '#bk-addr-dd:not([hidden])',
    '.srch-dd.open',
    '#g-make-dd.open',
    '#g-model-dd.open',
    '[aria-expanded="true"]',
  ].join(',');

  // The embedded homepage renders its own consent banner. When the visitor answers
  // one banner, answer the other with the same choice through its own button, so
  // the page's own consent flow runs (no rule here; the choice is the visitor's).
  function answerBanner(targetDoc, detail) {
    var banner = targetDoc && targetDoc.getElementById('cd1-consent-banner');
    if (!banner) return;
    var d = detail || {};
    var mode = d.marketing ? 'accept' : (d.analytics ? 'analytics' : 'decline');
    var btn = banner.querySelector('button[data-consent="' + mode + '"]');
    if (btn) btn.click();
  }

  function currentFrameDoc() {
    try { return frame && overlay && overlay.classList.contains('is-open') ? frame.contentDocument : null; } catch (eCross) { return null; }
  }

  var parentConsentMirrored = false;
  function wireFrameConsent() {
    var doc = currentFrameDoc();
    if (!doc || doc.__cd1HubConsent) return;
    doc.__cd1HubConsent = true;
    doc.addEventListener('cd1:consent-changed', function (ev) { answerBanner(document, ev && ev.detail); });
    if (!parentConsentMirrored) {
      parentConsentMirrored = true;
      document.addEventListener('cd1:consent-changed', function (ev) { answerBanner(currentFrameDoc(), ev && ev.detail); });
    }
  }

  function wireFrameEscape() {
    var win;
    var doc;
    try {
      win = frame.contentWindow;
      doc = frame.contentDocument;
    } catch (eCross) { return; }
    if (!win || !doc || doc.__cd1HubEscape) return;
    doc.__cd1HubEscape = true;
    var openLayers = function () {
      try { return doc.querySelectorAll(INNER_LAYER_OPEN).length; } catch (eSel) { return -1; }
    };
    var layersAtKeydown = 0;
    // Capture on the frame window runs before any handler inside the booking.
    win.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') layersAtKeydown = openLayers();
    }, true);
    // Bubble on the frame window runs after them. If an inner layer consumed
    // this Escape (it closed, or its handler prevented default), the booking
    // stays open; a second Escape then closes the booking.
    win.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || ev.defaultPrevented) return;
      var now = openLayers();
      if (layersAtKeydown < 0 || now < 0 || now < layersAtKeydown) return;
      if (overlay && overlay.classList.contains('is-open')) closeHubBooking();
    });
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
    if (pkgId) {
      params.set('pkg', pkgId);
      params.set('start', 'vehicle');
    } else if (cat) {
      params.set('start', 'package');
    }
    var zip = resolveZip();
    if (zip) params.set('zip', zip);
    return params;
  }

  function iframeReady() {
    if (!frame) return false;
    try {
      var doc = frame.contentDocument;
      if (!doc) return false;
      return !!(doc.getElementById('bk-ov') || (doc.body && doc.body.classList.contains('cd1-booking-embed')));
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
      var active = document.activeElement;
      if (active && active !== document.body && !(overlay && overlay.contains(active))) opener = active;
      ensureOverlay();
      var params = buildParams(cat, pkgId);
      var staleError = document.getElementById('hub-booking-error');
      if (staleError) staleError.hidden = true;
      frame.onload = function () {
        setTimeout(function () {
          if (!overlay.classList.contains('is-open')) return;
          if (!iframeReady()) {
            showError();
            return;
          }
          wireFrameEscape();
          wireFrameConsent();
        }, 300);
      };
      frame.src = '/?' + params.toString();
      overlay.style.display = 'flex';
      overlay.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      setBackgroundInert(true);
      // Focus the overlay's own close button (parent document): Escape keeps working
      // here, and Tab moves on into the booking frame. The embedded homepage has no
      // Escape handler of its own, so focusing the frame would strand Escape.
      setTimeout(function () {
        var closeBtn = overlay.querySelector('button[aria-label="Close booking"]');
        try { (closeBtn || frame).focus(); } catch (eFocus) {}
      }, 80);
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
    el.textContent = BOOKING_FAIL_MSG + ' ';
    var call = document.createElement('a');
    call.href = 'tel:+15513893986';
    call.textContent = 'Call / Text';
    call.style.cssText = 'color:#4da3ff;font-weight:600;text-decoration:none';
    el.appendChild(call);
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

    // Only our own booking frame may close the dialog, and only with the one
    // message the embedded homepage sends (index.html, embed mode).
    global.addEventListener('message', function (ev) {
      if (!ev || ev.origin !== global.location.origin) return;
      if (!frame || ev.source !== frame.contentWindow) return;
      if (!ev.data || typeof ev.data !== 'object' || ev.data.type !== 'cd1-booking-closed') return;
      closeHubBooking();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay && overlay.classList.contains('is-open')) closeHubBooking();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.CD1HubBookingBridge = { openDelegatedBooking: openDelegatedBooking, closeHubBooking: closeHubBooking };
})(typeof window !== 'undefined' ? window : globalThis);
