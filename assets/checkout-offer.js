/** WELCOME10 intent-based offer panel — server preview only. */
(function (global) {
  'use strict';

  var TRIGGER_SECONDS = 120;
  var IDLE_SECONDS = 45;
  var panelShown = false;
  var checkoutOpenedAt = 0;
  var lastActivityAt = 0;
  var backCount = 0;
  var idleTimer = null;
  var activeTimer = null;
  var previewInFlight = false;

  function backend() {
    return (global.BACKEND_BASE || '/.netlify/functions');
  }

  function now() { return Date.now(); }

  function ensureState() {
    if (!global.ST) global.ST = {};
    if (!global.ST.offerPreview) global.ST.offerPreview = null;
    if (global.ST.offerPanelDismissed == null) global.ST.offerPanelDismissed = false;
    if (global.ST.offerApplied == null) global.ST.offerApplied = false;
  }

  function panelEl() {
    return document.getElementById('bk-welcome-offer');
  }

  function showPanel(trigger) {
    if (panelShown || (global.ST && global.ST.offerPanelDismissed)) return;
    var el = panelEl();
    if (!el) return;
    if (global.ST && global.ST.offerPreview
      && global.ST.offerPreview.eligibility_status !== 'eligible') return;
    panelShown = true;
    el.hidden = false;
    el.dataset.trigger = trigger || 'timed';
    if (global.Cardetail1CheckoutAnalytics) {
      global.Cardetail1CheckoutAnalytics.onOfferShown(trigger || 'timed');
    }
  }

  function hidePanel() {
    var el = panelEl();
    if (el) el.hidden = true;
  }

  function cartAddonTotal(serviceSubtotal) {
    var addons = 0;
    try {
      var st = global.ST || {};
      if (st.vehicles && st.vehicles.length) {
        addons = st.vehicles.reduce(function (s, v) { return s + (Number(v.addonTotal) || 0); }, 0);
      } else {
        addons = Number(st.addonTotal) || 0;
      }
    } catch (e) { addons = 0; }
    return Math.min(Math.max(0, addons), Math.max(0, serviceSubtotal || 0));
  }

  function renderOfferLines(offer, serviceSubtotal, travelFee) {
    var discount = offer && offer.eligibility_status === 'eligible'
      ? (offer.discount_amount || 0) / 100 : 0;
    var total = Math.max(0, (serviceSubtotal || 0) + (travelFee || 0) - discount);
    // serviceSubtotal is server-authoritative and includes add-ons; split for display only.
    var addons = cartAddonTotal(serviceSubtotal);
    if (typeof global.renderBkFinancialSummary === 'function') {
      total = global.renderBkFinancialSummary({
        servicePrice: (serviceSubtotal || 0) - addons,
        addonTotal: addons,
        travelFee: travelFee || 0,
        discount: discount,
        discountLabel: 'New Customer Welcome — 10%',
      });
    }

    var discEl = document.getElementById('c-offer-line');
    if (discEl) {
      discEl.style.display = discount > 0 ? '' : 'none';
      discEl.innerHTML = discount > 0
        ? '<div class="or"><span class="ol">Welcome offer</span><span class="ov" style="color:var(--gr)">-' + money(discount) + '</span></div>'
        : '';
    }
    var totalEl = document.getElementById('c-total');
    if (totalEl && total > 0) totalEl.textContent = money(total);
  }

  function money(n) {
    return '$' + (Number(n) || 0).toFixed(2);
  }

  function draftPayload() {
    if (typeof global.buildBookingPayload !== 'function') return null;
    try { return global.buildBookingPayload(); } catch (e) { return null; }
  }

  async function fetchPreview(sourceTrigger) {
    if (previewInFlight) return global.ST && global.ST.offerPreview;
    var payload = draftPayload();
    if (!payload || !payload.zipCode) return null;
    previewInFlight = true;
    try {
      var res = await fetch(backend() + '/evaluate-booking-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, payload, {
          sourceTrigger: sourceTrigger || null,
          welcomeOfferAccepted: !!(global.ST && global.ST.offerApplied),
        })),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!data.ok) return null;
      ensureState();
      global.ST.offerPreview = data.offer;
      global.ST.offerServiceSubtotal = data.serviceSubtotal;
      global.ST.offerTravelFee = data.travelFee;
      renderOfferLines(data.offer, data.serviceSubtotal, data.travelFee);
      if (data.offer.eligibility_status === 'eligible') {
        if (global.Cardetail1CheckoutAnalytics) {
          global.Cardetail1CheckoutAnalytics.onOfferEligible(data.offer);
          global.Cardetail1CheckoutAnalytics.onDiscountCalculated(data.offer);
        }
      } else if (global.Cardetail1CheckoutAnalytics) {
        global.Cardetail1CheckoutAnalytics.onOfferIneligible(data.offer.eligibility_reason);
      }
      return data.offer;
    } catch (e) {
      return null;
    } finally {
      previewInFlight = false;
    }
  }

  function onActivity() {
    lastActivityAt = now();
  }

  function startTimers() {
    checkoutOpenedAt = now();
    lastActivityAt = now();
    clearTimeout(activeTimer);
    clearTimeout(idleTimer);
    activeTimer = setTimeout(function () {
      if (!global.ST || !global.ST.pkgId) return;
      fetchPreview('active_120s').then(function (offer) {
        if (offer && offer.eligibility_status === 'eligible') showPanel('active_120s');
      });
    }, TRIGGER_SECONDS * 1000);
  }

  function resetIdleWatch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      var step = global.currentBkStep || 0;
      if (step !== 4) return;
      if (now() - lastActivityAt < IDLE_SECONDS * 1000) return;
      if (global.Cardetail1CheckoutAnalytics) {
        global.Cardetail1CheckoutAnalytics.onIdleTrigger('step4_idle_45s');
      }
      fetchPreview('step4_idle_45s').then(function (offer) {
        if (offer && offer.eligibility_status === 'eligible') showPanel('step4_idle_45s');
      });
    }, IDLE_SECONDS * 1000);
  }

  function hookOpenBooking() {
    if (typeof global.openBooking !== 'function' || global.openBooking._offerHook) return;
    var orig = global.openBooking;
    global.openBooking = function (cat) {
      orig(cat);
      if (cat === 'fleet') return;
      panelShown = false;
      backCount = 0;
      ensureState();
      startTimers();
      document.addEventListener('pointerdown', onActivity, { passive: true });
      document.addEventListener('keydown', onActivity, { passive: true });
    };
    global.openBooking._offerHook = true;
  }

  function hookBkGoTo() {
    if (typeof global.bkGoTo !== 'function' || global.bkGoTo._offerHook) return;
    var orig = global.bkGoTo;
    var prev = null;
    global.bkGoTo = function (n) {
      if (prev && n < prev && global.ST && global.ST.pkgId) {
        backCount += 1;
        if (backCount >= 2) {
          fetchPreview('back_navigation').then(function (offer) {
            if (offer && offer.eligibility_status === 'eligible') showPanel('back_navigation');
          });
        }
      }
      global.currentBkStep = n;
      orig(n);
      if (n === 4) resetIdleWatch();
      if (global.ST && global.ST.pkgId) fetchPreview('step_view');
      prev = n;
    };
    global.bkGoTo._offerHook = true;
  }

  function hookSelectPkg() {
    if (typeof global.selectPkg !== 'function' || global.selectPkg._offerHook) return;
    var orig = global.selectPkg;
    global.selectPkg = function (id) {
      orig(id);
      fetchPreview('package_selected');
    };
    global.selectPkg._offerHook = true;
  }

  function hookDesktopExitIntent() {
    if (global.innerWidth < 1024) return;
    document.addEventListener('mouseout', function (e) {
      if (panelShown) return;
      if (!e || e.relatedTarget || e.clientY > 10) return;
      if (!global.ST || !global.ST.pkgId) return;
      fetchPreview('exit_intent').then(function (offer) {
        if (offer && offer.eligibility_status === 'eligible') showPanel('exit_intent');
      });
    });
  }

  function applyOffer() {
    ensureState();
    global.ST.offerApplied = true;
    global.ST.welcomeOfferSource = panelEl() && panelEl().dataset.trigger || 'panel_apply';
    hidePanel();
    fetchPreview('applied').then(function (offer) {
      if (global.Cardetail1CheckoutAnalytics && offer) {
        global.Cardetail1CheckoutAnalytics.onOfferApplied(offer, global.ST.welcomeOfferSource);
      }
    });
  }

  function dismissOffer() {
    ensureState();
    global.ST.offerPanelDismissed = true;
    hidePanel();
    if (global.Cardetail1CheckoutAnalytics) {
      global.Cardetail1CheckoutAnalytics.onOfferDismissed(
        panelEl() && panelEl().dataset.trigger || 'dismiss'
      );
    }
  }

  function init() {
    ensureState();
    hookOpenBooking();
    hookBkGoTo();
    hookSelectPkg();
    hookDesktopExitIntent();
    var applyBtn = document.getElementById('bk-offer-apply');
    var dismissBtn = document.getElementById('bk-offer-dismiss');
    if (applyBtn) applyBtn.addEventListener('click', applyOffer);
    if (dismissBtn) dismissBtn.addEventListener('click', dismissOffer);
    if (!global.openBooking) setTimeout(init, 500);
  }

  global.Cardetail1WelcomeOffer = {
    fetchPreview: fetchPreview,
    renderOfferLines: renderOfferLines,
    applyOffer: applyOffer,
    dismissOffer: dismissOffer,
    init: init,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
