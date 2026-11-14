/* Homepage A+ (Dark Refined Optimized) — presentation behaviour only.
 *
 * 1. Vehicle size selector on the package cards (display only). It re-renders
 *    the starting prices through the page's own _updateHomeFromPrices(), so the
 *    numbers keep coming from PRICING + applyRichPrice + the ZIP travel fee.
 *    It never sets the booking vehicle class: booking still classifies the
 *    vehicle from make / model / year through the vehicle catalog.
 * 2. Mobile sticky bar and header CTA never duplicate a primary CTA that is
 *    already on screen ([data-primary]: hero ZIP form, final CTA).
 *
 * No network calls, no analytics events, no booking state changes.
 */
(function () {
  'use strict';

  var TIER_NOTE = {
    small: 'a sedan / coupe',
    suv2: 'a 2-row SUV',
    suv3: 'a 3-row SUV or minivan',
    truck: 'a pickup truck'
  };
  var TIER_LABEL = {
    small: 'sedan / coupe',
    suv2: '2-row SUV',
    suv3: '3-row SUV / minivan',
    truck: 'pickup truck'
  };

  function initTierSelector() {
    var group = document.querySelector('[data-home-tier]');
    if (!group) return;
    var radios = Array.prototype.slice.call(group.querySelectorAll('[data-tier]'));
    var note = document.querySelector('[data-home-tier-note]');

    function select(btn, focus) {
      var tier = btn.getAttribute('data-tier');
      radios.forEach(function (r) {
        var on = r === btn;
        r.setAttribute('aria-checked', on ? 'true' : 'false');
        r.tabIndex = on ? 0 : -1;
      });
      if (focus) btn.focus();
      window.CD1HomeTier = tier;
      window.CD1HomeTierLabel = TIER_LABEL[tier] || '';
      if (note) note.textContent = 'Starting prices for ' + (TIER_NOTE[tier] || 'your vehicle') + '.';
      if (typeof window._updateHomeFromPrices === 'function') window._updateHomeFromPrices();
    }

    radios.forEach(function (r, i) {
      r.tabIndex = r.getAttribute('aria-checked') === 'true' ? 0 : -1;
      r.addEventListener('click', function () { select(r, false); });
      r.addEventListener('keydown', function (e) {
        var k = e.key, n = radios.length, j = -1;
        if (k === 'ArrowRight' || k === 'ArrowDown') j = (i + 1) % n;
        else if (k === 'ArrowLeft' || k === 'ArrowUp') j = (i - 1 + n) % n;
        else if (k === 'Home') j = 0;
        else if (k === 'End') j = n - 1;
        if (j < 0) return;
        e.preventDefault();
        select(radios[j], true);
      });
    });
  }

  function initStickyGuard() {
    var sticky = document.getElementById('mobile-sticky-cta');
    var navCta = document.querySelector('#main-nav .nav-cta');
    var primaries = Array.prototype.slice.call(document.querySelectorAll('[data-primary]'));
    if (!sticky) return;

    function setSticky(show) {
      sticky.classList.toggle('is-on', show);
      sticky.setAttribute('aria-hidden', show ? 'false' : 'true');
      if ('inert' in sticky) sticky.inert = !show;
      Array.prototype.forEach.call(sticky.querySelectorAll('a,button'), function (el) {
        el.tabIndex = show ? 0 : -1;
      });
    }

    if (!('IntersectionObserver' in window) || !primaries.length) {
      setSticky(true);
      return;
    }

    // Header CTA is only toggled on the desktop bar; in the mobile menu it stays.
    var desktop = window.matchMedia ? window.matchMedia('(min-width: 761px)') : { matches: true };
    var onScreen = new Set();

    function sync() {
      var primaryVisible = onScreen.size > 0;
      setSticky(!primaryVisible);
      if (navCta) {
        var hide = primaryVisible && desktop.matches;
        navCta.classList.toggle('is-off', hide);
        navCta.tabIndex = hide ? -1 : 0;
        if (hide) navCta.setAttribute('aria-hidden', 'true'); else navCta.removeAttribute('aria-hidden');
      }
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) onScreen.add(e.target); else onScreen.delete(e.target);
      });
      sync();
    }, { threshold: 0 });
    primaries.forEach(function (el) { io.observe(el); });
    if (desktop.addEventListener) desktop.addEventListener('change', sync);
  }

  // Escape closes the hero 'Explore other services' disclosure and returns focus.
  function initHeroMore() {
    var d = document.getElementById('hero-more');
    if (!d) return;
    d.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !d.open) return;
      d.open = false;
      var s = d.querySelector('summary');
      if (s) s.focus();
    });
  }

  function init() {
    initTierSelector();
    initStickyGuard();
    initHeroMore();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
