/**
 * Fast boot — show skeleton immediately, never block paint on API.
 */
(function () {
  function unboot() {
    document.documentElement.classList.remove('proto-booting');
    document.documentElement.classList.add('proto-ready');
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(unboot);
  setTimeout(unboot, 2500);
})(window);
