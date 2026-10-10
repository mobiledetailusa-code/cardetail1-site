/**
 * Ceramic landing interactions.
 * Booking opens the existing homepage UI in an overlay iframe.
 * Stripe and Google Ads stay on that booking page and are not loaded here.
 * The ownership guide only highlights a package. It stores nothing.
 */
(function () {
  'use strict';

  var overlay = null;
  var frame = null;
  var lastFocus = null;
  var lastLookFocus = null;
  var look = document.getElementById('cc-look');

  var guideCopy = {
    short: {
      text: 'Up to 1 Year is a simple place to start.',
      targets: ['year1']
    },
    mid: {
      text: 'Up to 3 Years is our most popular balance of protection and value.',
      targets: ['year3']
    },
    long: {
      text: 'Take a look at our long-term options. We’ll confirm what fits the vehicle and application location.',
      targets: ['year5', 'year9']
    },
    unsure: {
      text: 'No problem. The 3-Year option is a good place to compare, or you can ask us before choosing.',
      targets: ['year3']
    }
  };

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

  function lookOpen() {
    return !!(look && !look.hidden);
  }

  function lookFocusable() {
    if (!look) return [];
    return Array.prototype.filter.call(
      look.querySelectorAll('button, a[href]'),
      function (el) {
        return !el.disabled && !el.closest('[hidden]');
      }
    );
  }

  function openLook(article, trigger) {
    if (!look || !article) return;
    lastLookFocus = trigger || document.activeElement;
    var photos = document.getElementById('cc-look-photos');
    photos.replaceChildren();
    article.querySelectorAll('img').forEach(function (img) {
      var copy = document.createElement('img');
      copy.src = img.getAttribute('src');
      copy.alt = img.getAttribute('alt') || '';
      copy.width = Number(img.getAttribute('width')) || img.width;
      copy.height = Number(img.getAttribute('height')) || img.height;
      copy.decoding = 'async';
      photos.appendChild(copy);
    });
    document.getElementById('cc-look-title').textContent = article.getAttribute('data-vehicle') || '';
    document.getElementById('cc-look-line').textContent = article.getAttribute('data-line') || '';
    look.hidden = false;
    document.documentElement.classList.add('cc-look-open');
    document.body.style.overflow = 'hidden';
    var closeBtn = document.getElementById('cc-look-close');
    if (closeBtn) closeBtn.focus();
  }

  function closeLook() {
    if (!lookOpen()) return;
    look.hidden = true;
    document.documentElement.classList.remove('cc-look-open');
    if (!overlay || !overlay.classList.contains('is-open')) document.body.style.overflow = '';
    var photos = document.getElementById('cc-look-photos');
    if (photos) photos.replaceChildren();
    if (lastLookFocus && lastLookFocus.focus) lastLookFocus.focus();
  }

  function selectGuide(button) {
    var choice = guideCopy[button.getAttribute('data-keep')];
    if (!choice) return;
    document.querySelectorAll('.cc-guide-btn').forEach(function (item) {
      item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
    });
    document.querySelectorAll('[data-recommend]').forEach(function (card) {
      card.classList.toggle('is-recommended', choice.targets.indexOf(card.getAttribute('data-recommend')) !== -1);
    });
    var result = document.getElementById('cc-guide-result');
    if (result) result.textContent = choice.text;
  }

  document.addEventListener('click', function (event) {
    var guideBtn = event.target.closest('.cc-guide-btn');
    if (guideBtn) {
      selectGuide(guideBtn);
      return;
    }
    var lookBtn = event.target.closest('[data-look]');
    if (lookBtn) {
      openLook(lookBtn.closest('.cc-project'), lookBtn);
      return;
    }
    var link = event.target.closest('[data-ceramic-book]');
    if (!link) return;
    event.preventDefault();
    openBooking(link.getAttribute('data-ceramic-book') || '', link);
  });

  if (look) {
    look.addEventListener('click', function (event) {
      if (event.target === look) closeLook();
    });
    var lookClose = document.getElementById('cc-look-close');
    if (lookClose) lookClose.addEventListener('click', closeLook);
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (lookOpen()) {
        event.preventDefault();
        closeLook();
        return;
      }
      closeBooking();
      return;
    }
    if (event.key !== 'Tab' || !lookOpen()) return;
    var items = lookFocusable();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    if (event.shiftKey && (active === first || !look.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !look.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'cd1-booking-closed') return;
    closeBooking();
  });

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
