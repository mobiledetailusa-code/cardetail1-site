/** Back-to-top button + click-to-zoom gallery for specialty service pages. */
(function (global) {
  'use strict';

  function initBackToTop() {
    if (document.getElementById('btt')) return;
    var btn = document.createElement('button');
    btn.id = 'btt';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back to top');
    btn.textContent = '\u2191';
    btn.addEventListener('click', function () {
      global.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(btn);
    global.addEventListener('scroll', function () {
      btn.classList.toggle('btt-on', global.scrollY > 420);
    }, { passive: true });
    btn.classList.toggle('btt-on', global.scrollY > 420);
  }

  function initGalleryLightbox() {
    var overlay = document.getElementById('cd1-lightbox');
    var img = document.getElementById('cd1-lightbox-img');
    var closeBtn = document.getElementById('cd1-lightbox-close');
    if (!overlay || !img) return;

    function open(src, alt) {
      img.src = src;
      img.alt = alt || '';
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      if (closeBtn) closeBtn.focus();
    }

    function close() {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      img.removeAttribute('src');
    }

    document.querySelectorAll('.ba-showcase img, .gallery-card img, .gallery-grid img, .media-grid img').forEach(function (el) {
      if (el.closest('video')) return;
      el.classList.add('cd1-gallery-zoom');
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', 'View full size: ' + (el.alt || 'photo'));
      function activate() {
        var full = el.getAttribute('data-full-src') || el.currentSrc || el.src;
        if (full) open(full, el.alt);
      }
      el.addEventListener('click', activate);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    });

    if (closeBtn) closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    });
  }

  function injectLightboxShell() {
    if (document.getElementById('cd1-lightbox')) return;
    var shell = document.createElement('div');
    shell.id = 'cd1-lightbox';
    shell.className = 'cd1-lightbox';
    shell.setAttribute('aria-hidden', 'true');
    shell.innerHTML =
      '<button type="button" class="cd1-lightbox-close" id="cd1-lightbox-close" aria-label="Close">\u00d7</button>' +
      '<img id="cd1-lightbox-img" alt="">';
    document.body.appendChild(shell);
  }

  function init() {
    injectLightboxShell();
    initBackToTop();
    initGalleryLightbox();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
