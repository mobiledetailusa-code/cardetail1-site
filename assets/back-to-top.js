/** Single authoritative Back to Top — scrolls document.scrollingElement. */
(function (global) {
  'use strict';

  if (global.__CD1_BTT_INIT__) return;
  global.__CD1_BTT_INIT__ = true;

  var THRESHOLD = 420;
  var btn = null;
  var scrollRoot = null;

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function getScrollRoot() {
    return global.document.scrollingElement || global.document.documentElement || global.document.body;
  }

  function scrollToTop() {
    var root = getScrollRoot();
    var reduce = prefersReducedMotion();
    try {
      if (!reduce && typeof global.scrollTo === 'function') {
        global.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (_) { /* ignore */ }
    // Hard reset all known roots — some browsers keep documentElement.scrollTop
    // even after window.scrollTo, and automation shells can race smooth scroll.
    root.scrollTop = 0;
    if (global.document.documentElement) global.document.documentElement.scrollTop = 0;
    if (global.document.body) global.document.body.scrollTop = 0;
    try { global.scrollTo(0, 0); } catch (_) { /* ignore */ }
  }

  function onActivate(e) {
    if (e.type === 'keydown') {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
    }
    scrollToTop();
  }

  function syncVisibility() {
    if (!btn) return;
    var root = getScrollRoot();
    var y = root.scrollTop || global.scrollY || 0;
    var on = y > THRESHOLD;
    btn.classList.toggle('cd1-btt-on', on);
    btn.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  function ensureButton() {
    var existing = document.getElementById('cd1-btt');
    if (existing) {
      btn = existing;
      return btn;
    }
    var legacy = document.getElementById('btt');
    if (legacy) legacy.remove();

    btn = document.createElement('button');
    btn.id = 'cd1-btt';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back to top');
    btn.setAttribute('aria-hidden', 'true');
    btn.textContent = '\u2191';
    btn.addEventListener('click', onActivate);
    btn.addEventListener('keydown', onActivate);
    document.body.appendChild(btn);
    return btn;
  }

  function init() {
    scrollRoot = getScrollRoot();
    ensureButton();
    syncVisibility();
    global.addEventListener('scroll', syncVisibility, { passive: true });
    global.addEventListener('resize', syncVisibility, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.cd1ScrollToTop = scrollToTop;
  global.cd1SyncBackToTop = syncVisibility;
  global.cd1GetScrollRoot = getScrollRoot;
})(window);
