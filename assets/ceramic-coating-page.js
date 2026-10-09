/**
 * Ceramic landing booking launcher.
 * Opens the existing homepage booking UI in an overlay iframe.
 * Stripe and Google Ads stay on that booking page and are not loaded here.
 */
(function () {
  'use strict';

  var overlay = null;
  var frame = null;
  var lastFocus = null;

  function bookingUrl(pkg) {
    var params = new URLSearchParams();
    params.set('book', 'cars');
    params.set('embed', '1');
    if (pkg === 'ceramic_1yr' || pkg === 'ceramic_3yr') params.set('pkg', pkg);
    return '/?' + params.toString();
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'cc-booking-overlay';
    overlay.className = 'cc-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Ceramic coating booking');
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cc-overlay-close';
    closeBtn.setAttribute('aria-label', 'Close booking');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeBooking);
    frame = document.createElement('iframe');
    frame.title = 'Cardetail1 booking';
    frame.setAttribute('allow', 'payment');
    overlay.appendChild(closeBtn);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeBooking() {
    document.documentElement.classList.remove('cc-booking-open');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.hidden = true;
    if (frame) frame.src = 'about:blank';
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function openBooking(pkg, trigger) {
    lastFocus = trigger || document.activeElement;
    document.documentElement.classList.add('cc-booking-open');
    var el = ensureOverlay();
    el.hidden = false;
    el.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    frame.src = bookingUrl(pkg);
    var closeBtn = el.querySelector('.cc-overlay-close');
    if (closeBtn) closeBtn.focus();
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest('[data-ceramic-book]');
    if (!link) return;
    event.preventDefault();
    openBooking(link.getAttribute('data-ceramic-book') || '', link);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeBooking();
  });

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'cd1-booking-closed') return;
    closeBooking();
  });

  var scroller = document.getElementById('cc-projects');
  document.querySelectorAll('[data-project-nav]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!scroller) return;
      var card = scroller.querySelector('.cc-project');
      var width = card ? card.getBoundingClientRect().width : scroller.clientWidth;
      var dir = btn.getAttribute('data-project-nav') === 'next' ? 1 : -1;
      scroller.scrollBy({ left: dir * (width + 12), behavior: 'smooth' });
    });
  });

  var compare = document.querySelector('.cc-compare input[type="range"]');
  if (compare) {
    compare.addEventListener('input', function () {
      compare.setAttribute('aria-valuetext', compare.value + ' percent before');
    });
  }

  var sticky = document.querySelector('[data-cc-sticky]');
  var heroCta = document.querySelector('.cc-hero .cc-btn-primary');
  if (sticky && heroCta && 'IntersectionObserver' in window) {
    var stickyObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        sticky.classList.toggle('is-on', !entry.isIntersecting);
      });
    }, { threshold: 0.15 });
    stickyObserver.observe(heroCta);
  }

  if (window.Cardetail1Consent && typeof window.Cardetail1Consent.renderBanner === 'function') {
    window.Cardetail1Consent.renderBanner();
  }
})();
