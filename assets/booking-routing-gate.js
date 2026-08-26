/**
 * Shared client-side booking routing gate — all entry paths pass through routeServiceIntent.
 */
(function (global) {
  'use strict';

  var ROUTING_PANEL_ID = 'cd1-routing-alt-panel';

  function getStrategy() {
    return global.Cardetail1UniversalStrategy || null;
  }

  function getZip5() {
    var zip = '';
    try {
      var ids = ['bk-zip', 'hero-zip', 'loc-zip', 'zip-input'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) {
          zip = String(el.value || '').replace(/\D/g, '').slice(0, 5);
          if (zip.length === 5) break;
        }
      }
      if (zip.length !== 5) {
        zip = String(sessionStorage.getItem('cd1_zip') || localStorage.getItem('cd1_zip') || '').replace(/\D/g, '').slice(0, 5);
      }
    } catch (e) { /* ignore */ }
    return zip.length === 5 ? zip : '';
  }

  function zipUnsupported(zip5) {
    if (!zip5 || zip5.length !== 5) return false;
    if (typeof global.resolveZipService === 'function') return !global.resolveZipService(zip5);
    return false;
  }

  function gatherContext(overrides) {
    var o = overrides || {};
    var ST = global.ST || {};
    var cat = o.category != null ? o.category : (ST.cat || null);
    var zip5 = o.zip || getZip5();
    var vehicles = Array.isArray(o.vehicles) ? o.vehicles : (ST.vehicles || []);
    var vehicleCount = Math.max(
      Number(o.vehicleCount || 0),
      vehicles.length,
      Number(ST.units || 0)
    );
    return {
      category: cat,
      vehicleCount: vehicleCount,
      vehicles: vehicles,
      zip: zip5,
      unsupportedZip: o.unsupportedZip === true || zipUnsupported(zip5),
      assetCategories: cat ? [cat] : (o.assetCategories || []),
      source: o.source || 'booking_entry',
      isCommercial: o.isCommercial === true || cat === 'fleet',
      securityViolation: o.securityViolation === true,
      explicitGaragePlan: o.explicitGaragePlan === true,
      segment: o.segment,
    };
  }

  function ensureRoutingPanel() {
    var panel = document.getElementById(ROUTING_PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = ROUTING_PANEL_ID;
    panel.setAttribute('role', 'alert');
    panel.style.cssText = [
      'display:none', 'position:fixed', 'left:16px', 'right:16px', 'bottom:16px', 'z-index:10050',
      'max-width:520px', 'margin:0 auto', 'padding:16px 18px', 'border-radius:14px',
      'background:#121a24', 'border:1px solid rgba(77,163,255,.45)', 'color:#ece8e1',
      'font:14px/1.45 DM Sans,system-ui,sans-serif', 'box-shadow:0 12px 40px rgba(0,0,0,.45)',
    ].join(';');
    document.body.appendChild(panel);
    return panel;
  }

  function showRoutingPanel(route, kind) {
    var panel = ensureRoutingPanel();
    var headline = (route.message && route.message.headline) || 'This booking path needs a different next step';
    var subline = (route.message && route.message.subline) || '';
    var ctaLabel = kind === 'fleet'
      ? 'Request Fleet Quote'
      : (kind === 'manual' ? 'Request Area / Alternative Review' : 'Contact Us');
    panel.innerHTML = [
      '<div style="font-weight:700;margin-bottom:6px">', headline, '</div>',
      '<div style="color:#8a9bb0;margin-bottom:12px">', subline, '</div>',
      '<div style="display:flex;flex-wrap:wrap;gap:8px">',
      '<button type="button" id="cd1-routing-cta" style="padding:10px 14px;border-radius:999px;border:0;background:#4da3ff;color:#02040a;font-weight:700;cursor:pointer">',
      ctaLabel, '</button>',
      '<a href="tel:5513735668" style="padding:10px 14px;border-radius:999px;border:1px solid rgba(77,163,255,.45);color:#4da3ff;text-decoration:none;font-weight:600">Call / Text</a>',
      '</div>',
    ].join('');
    panel.style.display = 'block';
    var cta = document.getElementById('cd1-routing-cta');
    if (cta) {
      cta.onclick = function () {
        panel.style.display = 'none';
        if (kind === 'fleet') openFleetInquiry();
        else if (kind === 'manual') openManualReviewInquiry();
      };
    }
  }

  function openChatHandoff(prefill) {
    try {
      if (typeof global.forceCloseBooking === 'function') global.forceCloseBooking();
    } catch (e0) { /* ignore */ }
    try {
      var launch = document.getElementById('cd-launch');
      if (!(launch && launch.classList.contains('open')) && typeof global.cdToggle === 'function') {
        global.cdToggle();
      }
    } catch (e1) { /* ignore */ }
    try {
      if (typeof global.cdOpenHandoff === 'function') global.cdOpenHandoff();
      else {
        var hf = document.getElementById('cd-handoff');
        var ir = document.getElementById('cd-input-row');
        var chips = document.getElementById('cd-chips');
        var out = document.getElementById('cd-h-out');
        if (hf) hf.style.display = 'flex';
        if (ir) ir.style.display = 'none';
        if (chips) chips.style.display = 'none';
        if (out) out.style.display = 'none';
      }
    } catch (e2) { /* ignore */ }
    var msgEl = document.getElementById('cd-h-msg');
    if (msgEl && prefill) {
      if (!String(msgEl.value || '').trim()) msgEl.value = prefill;
      else if (prefill.split('\n')[0] && msgEl.value.indexOf(prefill.split('\n')[0]) < 0) {
        msgEl.value = prefill + '\n\n' + msgEl.value;
      }
    }
    setTimeout(function () {
      var nameEl = document.getElementById('cd-h-name');
      if (nameEl) try { nameEl.focus(); } catch (e3) { /* ignore */ }
    }, 120);
  }

  function openFleetInquiry() {
    if (typeof global.openCommercialInquiry === 'function') {
      global.openCommercialInquiry();
      return;
    }
    openChatHandoff(
      'Commercial / Fleet Inquiry\n\nNeed service for multiple company vehicles? Looking for a custom service plan based on vehicle type, quantity, location and frequency.'
    );
  }

  function openManualReviewInquiry() {
    openChatHandoff(
      'Extended Area / Alternative Path Inquiry\n\nYour location or request may be available through an alternative service path. Share your ZIP, vehicle type, and preferred timing so our team can review options.'
    );
  }

  function routeIntent(ctx) {
    var Strategy = getStrategy();
    if (!Strategy || typeof Strategy.routeServiceIntent !== 'function') {
      return {
        route: 'standard_booking',
        allowed: true,
        code: null,
        routing: { standardBookingAllowed: true },
        message: { headline: '', subline: '' },
      };
    }
    return Strategy.routeServiceIntent(ctx);
  }

  function handleBlockedRoute(route) {
    if (route.route === 'fleet_quote') {
      showRoutingPanel(route, 'fleet');
      openFleetInquiry();
      return true;
    }
    if (route.route === 'manual_review') {
      showRoutingPanel(route, 'manual');
      openManualReviewInquiry();
      return true;
    }
    if (route.route === 'rejected_for_security_only') {
      showRoutingPanel(route, 'security');
      return true;
    }
    return false;
  }

  function evaluateAndMaybeBlock(ctx) {
    if (global.__cd1SkipRoutingGate) {
      return { blocked: false, route: routeIntent(ctx) };
    }
    var route = routeIntent(ctx);
    if (!route.allowed || !route.routing.standardBookingAllowed) {
      handleBlockedRoute(route);
      return { blocked: true, route: route };
    }
    return { blocked: false, route: route };
  }

  function wrapFn(name, contextBuilder) {
    var orig = global[name];
    if (typeof orig !== 'function' || orig._cd1RoutingGate) return;
    global[name] = function () {
      var ctx = contextBuilder.apply(null, arguments);
      var result = evaluateAndMaybeBlock(ctx);
      if (result.blocked) return;
      return orig.apply(this, arguments);
    };
    global[name]._cd1RoutingGate = true;
  }

  function installHooks() {
    wrapFn('openBooking', function (cat) {
      return gatherContext({ category: cat, source: 'openBooking' });
    });
    wrapFn('openBookingFromHome', function (cat) {
      return gatherContext({ category: cat, source: 'openBookingFromHome' });
    });
    wrapFn('openBookingCarPkg', function () {
      return gatherContext({ category: 'cars', source: 'openBookingCarPkg' });
    });
    wrapFn('openBookingPkg', function (cat) {
      return gatherContext({ category: cat, source: 'openBookingPkg' });
    });
    wrapFn('selectCategory', function (cat) {
      return gatherContext({ category: cat, source: 'selectCategory' });
    });
  }

  function processPendingBookQuery() {
    var pending = global.__cd1PendingBookQuery;
    if (!pending || !pending.book) return;
    global.__cd1PendingBookQuery = null;
    var allowed = pending.allowed || { cars: 1, boats: 1, rvs: 1, powersports: 1 };
    if (!allowed[pending.book]) {
      try {
        if (global.parent && global.parent !== global) {
          global.parent.postMessage({
            type: 'cd1-booking-error',
            code: 'routing_blocked',
            categoryId: pending.book,
            packageId: pending.pkg || '',
          }, '*');
        }
      } catch (e) { /* ignore */ }
      return;
    }
    var ctx = gatherContext({
      category: pending.book,
      source: 'url_query',
      zip: pending.zipQ || getZip5(),
    });
    var result = evaluateAndMaybeBlock(ctx);
    if (result.blocked) return;
    if (global.ST) {
      if (pending.pkg) global.ST._prefillPkgId = pending.pkg;
      global.ST._pendingCat = pending.book;
    }
    if (typeof global.openBookingFromHome === 'function') {
      global.__cd1SkipRoutingGate = true;
      try { global.openBookingFromHome(pending.book); }
      finally { global.__cd1SkipRoutingGate = false; }
    }
  }

  function processResumeQuery() {
    try {
      var params = new URLSearchParams(global.location.search || '');
      if (params.get('resume') !== '1') return;
      var ctx = gatherContext({ category: 'cars', source: 'resume_link' });
      var result = evaluateAndMaybeBlock(ctx);
      if (result.blocked) {
        try { global.history.replaceState({}, '', 'index.html'); } catch (e) { /* ignore */ }
      }
    } catch (e2) { /* ignore */ }
  }

  function init() {
    installHooks();
    processPendingBookQuery();
    processResumeQuery();
    if (!global.openBooking) setTimeout(init, 400);
  }

  global.CD1BookingRoutingGate = {
    gatherContext: gatherContext,
    routeIntent: routeIntent,
    evaluateAndMaybeBlock: evaluateAndMaybeBlock,
    openFleetInquiry: openFleetInquiry,
    openManualReviewInquiry: openManualReviewInquiry,
    init: init,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
