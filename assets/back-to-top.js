/** Single shared Back to Top — one listener, chat-safe z-index, reduced-motion aware. */
(function (global) {
  'use strict';

  if (global.__CD1_BTT_INIT__) return;
  global.__CD1_BTT_INIT__ = true;

  var THRESHOLD = 420;
  var btn = null;

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function scrollToTop() {
    if (prefersReducedMotion()) {
      global.scrollTo(0, 0);
    } else {
      global.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function syncVisibility() {
    if (!btn) return;
    var on = global.scrollY > THRESHOLD;
    btn.classList.toggle('cd1-btt-on', on);
    btn.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  function ensureButton() {
    if (document.getElementById('cd1-btt')) {
      btn = document.getElementById('cd1-btt');
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
    btn.addEventListener('click', scrollToTop);
    document.body.appendChild(btn);
    return btn;
  }

  function init() {
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

  global.cd1SyncBackToTop = syncVisibility;
})(window);
