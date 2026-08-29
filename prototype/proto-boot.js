/**
 * Fast boot — show skeleton immediately, never block paint on API.
 */
(function () {
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    document.documentElement.classList.remove('proto-booting');
    document.documentElement.classList.add('proto-ready');
  });
})(window);
