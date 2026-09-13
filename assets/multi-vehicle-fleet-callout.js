/**
 * Optional Fleet Pricing callout for multi-vehicle residential booking.
 * Threshold is a suggestion only — never disables Continue / Add Another Vehicle,
 * never clears cart, never applies discounts, never forces estimate/inquiry submit.
 */
(function (global) {
  'use strict';

  var FLEET_THRESHOLD = 6;
  var CALLOUT_ID = 'cd1-optional-fleet-callout';
  var STYLE_ID = 'cd1-optional-fleet-callout-styles';
  var doc = global.document;

  function ensureStyles() {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + CALLOUT_ID + '{display:none;margin:0 0 12px;padding:14px 14px 12px;border-radius:12px;',
      'border:1px solid rgba(77,163,255,.35);background:rgba(18,32,52,.72);color:#e8eef5;',
      'font:13px/1.45 DM Sans,system-ui,sans-serif}',
      '#' + CALLOUT_ID + '.show{display:block}',
      '#' + CALLOUT_ID + ' .cd1-fleet-callout-title{font-weight:700;margin:0 0 6px;font-size:14px}',
      '#' + CALLOUT_ID + ' .cd1-fleet-callout-copy{color:#8a9bb0;margin:0 0 12px}',
      '#' + CALLOUT_ID + ' .cd1-fleet-callout-actions{display:flex;flex-wrap:wrap;gap:8px}',
      '#' + CALLOUT_ID + ' .cd1-fleet-btn{padding:10px 14px;border-radius:999px;font-weight:700;cursor:pointer;font:inherit}',
      '#' + CALLOUT_ID + ' .cd1-fleet-primary{border:0;background:#4da3ff;color:#02040a}',
      '#' + CALLOUT_ID + ' .cd1-fleet-secondary{border:1px solid rgba(77,163,255,.45);background:transparent;color:#4da3ff}',
      '@media (max-width:560px){#' + CALLOUT_ID + ' .cd1-fleet-callout-actions{flex-direction:column}',
      '#' + CALLOUT_ID + ' .cd1-fleet-btn{width:100%;text-align:center}}',
    ].join('');
    (doc.head || doc.documentElement).appendChild(style);
  }

  function vehicleCount() {
    try {
      var ST = global.ST || {};
      var n = Array.isArray(ST.vehicles) ? ST.vehicles.length : 0;
      if (ST._startingAdditionalVehicle && ST.cat && ST.pkgId) n += 1;
      return n;
    } catch (e) {
      return 0;
    }
  }

  function ensureCallout() {
    if (!doc) return null;
    ensureStyles();
    var existing = doc.getElementById(CALLOUT_ID);
    if (existing) return existing;

    var el = doc.createElement('div');
    el.id = CALLOUT_ID;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Optional fleet pricing');
    el.innerHTML = [
      '<div class="cd1-fleet-callout-title">Booking multiple vehicles?</div>',
      '<p class="cd1-fleet-callout-copy">You can continue with current pricing or ask us about custom Fleet Pricing.</p>',
      '<div class="cd1-fleet-callout-actions">',
      '<button type="button" class="cd1-fleet-btn cd1-fleet-primary" id="cd1-fleet-continue">Continue Booking</button>',
      '<button type="button" class="cd1-fleet-btn cd1-fleet-secondary" id="cd1-fleet-ask">Ask About Fleet Pricing</button>',
      '</div>',
    ].join('');

    var anchor = doc.querySelector('.btn-add-veh') || doc.getElementById('vcart') || doc.getElementById('bs3-addons');
    if (anchor && anchor.parentNode) {
      if (anchor.classList && anchor.classList.contains('btn-add-veh')) {
        anchor.parentNode.insertBefore(el, anchor);
      } else {
        anchor.appendChild(el);
      }
    } else if (doc.body) {
      doc.body.appendChild(el);
    }

    var cont = doc.getElementById('cd1-fleet-continue');
    if (cont) {
      cont.onclick = function () {
        el.classList.remove('show');
        el.setAttribute('data-dismissed', '1');
        var next = doc.getElementById('next3');
        if (next) {
          try { next.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e0) { /* ignore */ }
          try { next.focus(); } catch (e1) { /* ignore */ }
        }
      };
    }
    var ask = doc.getElementById('cd1-fleet-ask');
    if (ask) {
      ask.onclick = function () {
        if (typeof global.openCommercialInquiry === 'function') {
          global.openCommercialInquiry();
          return;
        }
        if (global.CD1BookingRoutingGate && typeof global.CD1BookingRoutingGate.openFleetInquiry === 'function') {
          global.CD1BookingRoutingGate.openFleetInquiry();
          return;
        }
        try { global.location.href = '/fleet-services.html'; } catch (e2) { /* ignore */ }
      };
    }
    return el;
  }

  function syncCallout() {
    var count = vehicleCount();
    var el = ensureCallout();
    if (!el) return;
    if (count >= FLEET_THRESHOLD && el.getAttribute('data-dismissed') !== '1') {
      el.classList.add('show');
    } else if (count < FLEET_THRESHOLD) {
      el.classList.remove('show');
      el.removeAttribute('data-dismissed');
    }
  }

  function wrap(name) {
    var orig = global[name];
    if (typeof orig !== 'function' || orig._cd1FleetCallout) return;
    global[name] = function () {
      var result = orig.apply(this, arguments);
      try { syncCallout(); } catch (e) { /* ignore */ }
      return result;
    };
    global[name]._cd1FleetCallout = true;
  }

  function install() {
    wrap('renderVehicleCart');
    wrap('addCurrentVehicleToCart');
    wrap('addCurrentVehicleAndContinue');
    wrap('removeVehicleFromCart');
    wrap('commitCurrentVehicleToCart');
    try { syncCallout(); } catch (e) { /* ignore */ }
    if (!global.renderVehicleCart) setTimeout(install, 400);
  }

  global.CD1OptionalFleetCallout = {
    FLEET_THRESHOLD: FLEET_THRESHOLD,
    sync: syncCallout,
    install: install,
  };

  // Install immediately (wraps no-ops safely) and again on DOM ready / late booking fns.
  install();
  if (doc) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', install);
    else setTimeout(install, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
