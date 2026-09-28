/** Cookie/consent manager — Necessary, Analytics, Marketing categories. */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'cd1_consent_v1';
  var VERSION = '2026-07-revops-v1';
  var layoutBound = false;

  function readState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function defaultState() {
    return {
      version: VERSION,
      necessary: true,
      analytics: false,
      marketing: false,
      decided: false,
      updatedAt: null,
    };
  }

  function getConsent() {
    return readState() || defaultState();
  }

  function saveConsent(partial) {
    var prev = getConsent();
    var next = Object.assign({}, prev, partial || {}, {
      version: VERSION,
      necessary: true,
      decided: true,
      updatedAt: new Date().toISOString(),
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    document.dispatchEvent(new CustomEvent('cd1:consent-changed', { detail: next }));
    return next;
  }

  function canAnalytics() { return !!getConsent().analytics; }
  function canMarketing() { return !!getConsent().marketing; }

  function ensureLayoutStyles() {
    if (document.getElementById('cd1-consent-layout')) return;
    var style = document.createElement('style');
    style.id = 'cd1-consent-layout';
    style.textContent = [
      '#cd1-consent-banner{position:fixed;left:0;right:0;bottom:var(--cd1-consent-keyboard,0px);z-index:9999;box-sizing:border-box;background:#0a1628;border-top:1px solid rgba(77,163,255,.35);padding:14px 16px calc(14px + env(safe-area-inset-bottom,0px));font:13px/1.45 system-ui,sans-serif;color:#e8eef5}',
      'html.cd1-consent-keyboard #cd1-consent-banner{padding-bottom:14px}',
      '#cd1-consent-banner .cd1-consent-inner{max-width:960px;margin:0 auto}',
      '#cd1-consent-banner .cd1-consent-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '#cd1-consent-banner button{min-height:44px;padding:8px 14px;border-radius:8px;border:1px solid rgba(77,163,255,.4);background:transparent;color:#4da3ff;cursor:pointer;font-weight:600}',
      '#cd1-consent-banner button:focus-visible{outline:2px solid #4da3ff;outline-offset:2px}',
      'html.cd1-consent-open .booking-modal-ov{bottom:var(--cd1-consent-offset,0px)}',
      'html.cd1-consent-open .booking-modal{max-height:calc(95svh - var(--cd1-consent-offset,0px));scroll-padding-bottom:16px}',
      'html.cd1-consent-open .mobile-sticky-cta,html.cd1-consent-open .cd1-ceramic-sticky.is-on{bottom:var(--cd1-consent-offset,0px)}',
      'html.cd1-consent-open #cd-chat{bottom:calc(20px + var(--cd1-consent-offset,0px))}',
      '@media(max-width:640px){html.cd1-consent-open body{padding-bottom:calc(68px + var(--cd1-consent-offset,0px))}}',
      '@media(max-height:500px) and (max-width:900px){html.cd1-consent-open .booking-modal{max-height:calc(100svh - var(--cd1-consent-offset,0px))}}'
    ].join('');
    document.head.appendChild(style);
  }

  function keyboardInset() {
    var vv = global.visualViewport;
    if (!vv || !global.innerHeight) return 0;
    var overlap = global.innerHeight - vv.height - (vv.offsetTop || 0);
    if (overlap < 80) return 0;
    return Math.round(overlap);
  }

  function releaseOffset() {
    var root = document.documentElement;
    root.classList.remove('cd1-consent-open');
    root.classList.remove('cd1-consent-keyboard');
    root.style.removeProperty('--cd1-consent-offset');
    root.style.removeProperty('--cd1-consent-keyboard');
  }

  function syncOffset(el) {
    if (!el || !el.isConnected) {
      releaseOffset();
      return;
    }
    var root = document.documentElement;
    var keyboard = keyboardInset();
    root.classList.add('cd1-consent-open');
    root.classList.toggle('cd1-consent-keyboard', keyboard > 0);
    root.style.setProperty('--cd1-consent-keyboard', keyboard + 'px');
    var height = Math.ceil(el.getBoundingClientRect().height);
    root.style.setProperty('--cd1-consent-offset', (height + keyboard) + 'px');
  }

  function keepFocusedVisible(banner) {
    var active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return;
    if (banner.contains(active)) return;
    var tag = active.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
    var rect = active.getBoundingClientRect();
    var limit = banner.getBoundingClientRect().top - 8;
    if (rect.bottom > limit || rect.top < 8) {
      try { active.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    }
  }

  function bindLayout(el) {
    if (layoutBound) return;
    layoutBound = true;
    var onChange = function () {
      syncOffset(el);
      if (el.isConnected) keepFocusedVisible(el);
    };
    global.addEventListener('resize', onChange);
    document.addEventListener('focusin', onChange);
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', onChange);
      global.visualViewport.addEventListener('scroll', onChange);
    }
    var observer = null;
    if (typeof global.ResizeObserver === 'function') {
      observer = new global.ResizeObserver(onChange);
      observer.observe(el);
    }
    el._cd1ReleaseLayout = function () {
      global.removeEventListener('resize', onChange);
      document.removeEventListener('focusin', onChange);
      if (global.visualViewport) {
        global.visualViewport.removeEventListener('resize', onChange);
        global.visualViewport.removeEventListener('scroll', onChange);
      }
      if (observer) observer.disconnect();
      layoutBound = false;
      releaseOffset();
    };
  }

  function dismissBanner(el) {
    if (el && typeof el._cd1ReleaseLayout === 'function') el._cd1ReleaseLayout();
    else releaseOffset();
    if (el && el.parentNode) el.remove();
  }

  function renderBanner() {
    if (getConsent().decided) return;
    if (document.getElementById('cd1-consent-banner')) return;
    ensureLayoutStyles();
    var el = document.createElement('div');
    el.id = 'cd1-consent-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cookie preferences');
    el.innerHTML =
      '<div class="cd1-consent-inner">' +
      '<p><strong>Privacy choices.</strong> Necessary cookies run booking and security. Analytics and marketing are optional.</p>' +
      '<div class="cd1-consent-actions">' +
      '<button type="button" data-consent="decline">Decline optional</button>' +
      '<button type="button" data-consent="analytics">Analytics only</button>' +
      '<button type="button" data-consent="accept">Accept all</button>' +
      '</div></div>';
    el.querySelectorAll('button').forEach(function (btn) {
      btn.onclick = function () {
        var mode = btn.getAttribute('data-consent');
        if (mode === 'accept') saveConsent({ analytics: true, marketing: true });
        else if (mode === 'analytics') saveConsent({ analytics: true, marketing: false });
        else saveConsent({ analytics: false, marketing: false });
        dismissBanner(el);
        if (global.Cardetail1Revenue && global.Cardetail1Revenue.initAdapters) {
          global.Cardetail1Revenue.initAdapters();
        }
      };
    });
    document.body.appendChild(el);
    bindLayout(el);
    syncOffset(el);
  }

  global.Cardetail1Consent = {
    VERSION: VERSION,
    getConsent: getConsent,
    saveConsent: saveConsent,
    canAnalytics: canAnalytics,
    canMarketing: canMarketing,
    renderBanner: renderBanner,
  };
})(typeof window !== 'undefined' ? window : globalThis);
