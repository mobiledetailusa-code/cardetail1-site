/** Cookie/consent manager — Necessary, Analytics, Marketing categories. */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'cd1_consent_v1';
  var VERSION = '2026-07-revops-v1';

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

  function renderBanner() {
    if (getConsent().decided) return;
    if (document.getElementById('cd1-consent-banner')) return;
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
    el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#0a1628;border-top:1px solid rgba(77,163,255,.35);padding:14px 16px;font:13px/1.45 system-ui,sans-serif;color:#e8eef5';
    el.querySelector('.cd1-consent-inner').style.maxWidth = '960px';
    el.querySelector('.cd1-consent-inner').style.margin = '0 auto';
    el.querySelector('.cd1-consent-actions').style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';
    el.querySelectorAll('button').forEach(function (btn) {
      btn.style.cssText = 'padding:8px 14px;border-radius:8px;border:1px solid rgba(77,163,255,.4);background:transparent;color:#4da3ff;cursor:pointer;font-weight:600';
      btn.onclick = function () {
        var mode = btn.getAttribute('data-consent');
        if (mode === 'accept') saveConsent({ analytics: true, marketing: true });
        else if (mode === 'analytics') saveConsent({ analytics: true, marketing: false });
        else saveConsent({ analytics: false, marketing: false });
        el.remove();
        if (global.Cardetail1Revenue && global.Cardetail1Revenue.initAdapters) {
          global.Cardetail1Revenue.initAdapters();
        }
      };
    });
    document.body.appendChild(el);
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
