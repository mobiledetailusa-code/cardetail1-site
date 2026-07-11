/** RevOps bootstrap — load consent, tracking, garage plan; wire page view. */
(function (global) {
  'use strict';

  function detectPageType() {
    var p = global.location.pathname || '/';
    if (p.indexOf('-hub.html') >= 0 || p.indexOf('-county-hub') >= 0) return 'hub';
    if (p.indexOf('-mobile-detailing.html') >= 0) return 'city';
    if (p.indexOf('-detailing.html') >= 0) return 'service';
    if (p === '/multi-vehicle-detailing.html') return 'service';
    return 'home';
  }

  function init() {
    if (global.Cardetail1Consent) global.Cardetail1Consent.renderBanner();
    if (global.Cardetail1Revenue) {
      global.Cardetail1Revenue.initAdapters();
      global.Cardetail1Revenue.initPageView(detectPageType());
    }
    document.querySelectorAll('[data-cd1-garage-cta]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        if (global.Cardetail1GaragePlan) global.Cardetail1GaragePlan.open();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.CD1RevOpsInit = { init: init, detectPageType: detectPageType };
})(typeof window !== 'undefined' ? window : globalThis);
