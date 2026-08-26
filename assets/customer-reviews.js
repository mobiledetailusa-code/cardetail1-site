/**
 * Homepage reviews: static Google snapshot + first-party Cardetail1 channel.
 *
 * This is NOT a Google Places / Business Profile API integration.
 * Google cards are a one-time static snapshot of the public listing.
 * If Google is offline, these cards still render from this file.
 *
 * Listing snapshot (2026-08-25):
 *   Name: Cardetail1
 *   Phone: (551) 313-2956
 *   Site: cardetail1.com
 *   Maps: https://maps.google.com/maps/place/cardetail1/data=!4m2!3m1!1s0x4f36d27550a90189:0x8207adab977c7032
 *   CID:  0x8207adab977c7032
 *   Review link already used by the site: https://g.page/r/CTJwfJerrQeCEAI/review
 *   Google rating: 5.0 from 9 written reviews
 *
 * ORDERING (deterministic, never shuffled):
 *   1. Published Cardetail1 reviews from public-reviews, newest createdAt first
 *   2. Static Google snapshot in listing recency as of 2026-08-25
 *   3. Legacy curated job testimonials (not labeled Google or Verified)
 *   Dedup by id and normalized review body.
 *
 * Source labels:
 *   google     → "Google review"
 *   cardetail1 → "Verified Cardetail1 customer"
 *   legacy     → "Customer" (known job quote, not independently Google-verified)
 */
(function (root) {
  'use strict';

  var GOOGLE_REVIEW_URL = 'https://g.page/r/CTJwfJerrQeCEAI/review';
  var PORTAL_REVIEWS_URL = '/.netlify/functions/public-reviews';
  var READ_MORE_LINES = 5;

  var GOOGLE_LISTING = {
    name: 'Cardetail1',
    phone: '(551) 313-2956',
    website: 'https://cardetail1.com',
    mapsPlaceUrl: 'https://maps.google.com/maps/place/cardetail1/data=!4m2!3m1!1s0x4f36d27550a90189:0x8207adab977c7032',
    reviewUrl: GOOGLE_REVIEW_URL,
    rating: 5,
    ratingLabel: '5.0',
    reviewCount: 9,
    snapshotDate: '2026-08-25',
    cid: '0x8207adab977c7032'
  };

  // Exact public Google review text as shown on the listing on 2026-08-25.
  // Do not rewrite grammar, ratings, names, or wording.
  var GOOGLE_REVIEWS = [
    {
      id: 'g-john-daquila',
      name: 'John Daquila',
      rating: 5,
      text: 'White BMW 760 ! First time booking and I couldn\'t be happier! Car is showroom new inside and out. I have a vinyl wrap on my exterior and it isn\'t the easiest to work with but not for Magno! He did and incredible job and will absolutely be booking again in the near future! 10/10 experience would recommend to everyone',
      date: 'Aug 2026',
      relativeDate: 'a week ago',
      source: 'google',
      sort: 10
    },
    {
      id: 'g-carol-gladis',
      name: 'Carol Gladis',
      rating: 5,
      text: 'The car looks terrific...excellent job!! Thanks!',
      date: 'Aug 2026',
      relativeDate: 'a week ago',
      source: 'google',
      sort: 20
    },
    {
      id: 'g-scott-rosenwald',
      name: 'Scott Rosenwald',
      rating: 5,
      text: 'Great service !! Fantastic job !! Highly recommend. Very professional.',
      date: 'Aug 2026',
      relativeDate: 'a week ago',
      source: 'google',
      sort: 30
    },
    {
      id: 'g-gerard-baltazar',
      name: 'Gerard Baltazar',
      rating: 5,
      text: 'Truly impressive work! They stayed extra long to do a thorough job! I\'ve never experienced such excellent skill and dedication for detailing! This is my family commuter car, and we have a dog! They made my car look and feel like new!',
      date: 'Jul 2026',
      relativeDate: 'a month ago',
      source: 'google',
      sort: 40
    },
    {
      id: 'g-claudio-campos',
      name: 'Claudio Campos',
      rating: 5,
      text: 'Great Job !! Highly recommended ! My car looks like it came out of the new lot! Thank You so much 😊',
      date: 'May 2026',
      relativeDate: '3 months ago',
      source: 'google',
      sort: 50
    },
    {
      id: 'g-adilsom-pedro',
      name: 'Adilsom pedro',
      rating: 5,
      text: 'Excellent work, 100% guaranteed.',
      date: 'May 2026',
      relativeDate: '3 months ago',
      source: 'google',
      sort: 60
    },
    {
      id: 'g-mj-oliveira',
      name: 'M. J oliveira',
      rating: 5,
      text: 'My cars looked like new! Guy did a great job. Very satisfied would recommend',
      date: 'May 2026',
      relativeDate: 'Edited 3 months ago',
      source: 'google',
      sort: 70
    },
    {
      id: 'g-dani-sames',
      name: 'Dani Sames',
      rating: 5,
      text: 'My car was horrible. Now it\'s brand new, great job',
      date: 'Aug 2025',
      relativeDate: 'a year ago',
      source: 'google',
      sort: 80
    },
    {
      id: 'g-rose-alves',
      name: 'Rose Alves',
      rating: 5,
      text: 'Good job, my was car was terrible , now is brand new.',
      date: 'Aug 2025',
      relativeDate: 'a year ago',
      source: 'google',
      sort: 90
    }
  ];

  // Named job quotes already on the site, not present on the current Google
  // listing. Keep as legacy social proof. Do not label Google or Verified.
  var LEGACY_REVIEWS = [
    {
      id: 'legacy-pablo-sanchez',
      name: 'Pablo Sanchez',
      rating: 5,
      text: 'The detailer did an amazing job, very thorough and I\'m impressed with the high level of quality service he provided. The car looks brand new.',
      location: 'NJ Area',
      date: 'May 2025',
      service: 'Subaru Crosstrek · Exterior Detail',
      source: 'legacy',
      sort: 200
    },
    {
      id: 'legacy-craig-bitman',
      name: 'Craig Bitman',
      rating: 5,
      text: 'Incredible work on my BMW. Magno was professional, punctual, and the results speak for themselves. Highly recommend Cardetail1 to anyone who takes pride in their car.',
      location: 'Craryville, NY',
      date: 'May 2025',
      service: 'BMW 4 Series · Exterior Detail',
      source: 'legacy',
      sort: 210
    },
    {
      id: 'legacy-paul-berliner',
      name: 'Paul Berliner',
      rating: 5,
      text: 'Fantastic detailing by Magno! Super intelligent, efficient and a pleasure to deal with. My Land Rover Defender now looks brand new! Thank you Magno! My life is now better!',
      location: 'Brooklyn, NY',
      date: 'Jun 2025',
      service: 'Land Rover Defender 130 · Exterior Detail',
      source: 'legacy',
      sort: 220
    },
    {
      id: 'legacy-patrice-zaborski',
      name: 'Patrice Zaborski',
      rating: 5,
      text: 'Magno, our detailer did a wonderful job. Our RV looks like new. He was professional, pleasant and detail oriented. He took his time to make sure all was perfect. We look forward to Magno working on our vehicle in the future. Thank you!',
      location: 'East Hampton, NY',
      date: 'Jun 2025',
      service: 'Renegade Vienna Motorhome · Full Detail',
      source: 'legacy',
      sort: 230
    },
    {
      id: 'legacy-david-johnson',
      name: 'David Johnson',
      rating: 5,
      text: 'Excellent work! Arrived timely and was a pleasure to work with. I was thinking this would be a one time thing but it\'s been a good experience so we\'re considering getting the other car done.',
      location: 'Amityville, NY',
      date: 'Jun 2025',
      service: 'Grand Design 320G 5th Wheel · Full Detail',
      source: 'legacy',
      sort: 240
    },
    {
      id: 'legacy-maryjane-raymond',
      name: 'MaryJane Raymond',
      rating: 5,
      text: 'Magno was excellent and efficient!!!',
      location: 'Far Hills, NJ',
      date: 'Jun 2025',
      service: 'Volvo XC60 · Full Detail',
      source: 'legacy',
      sort: 250
    },
    {
      id: 'legacy-andy-rudin',
      name: 'Andy Rudin',
      rating: 5,
      text: 'Service was timely and the car is gorgeous.',
      location: 'Bronx, NY',
      date: 'Jun 2025',
      service: 'Honda CR-V · Full Detail',
      source: 'legacy',
      sort: 260
    }
  ];

  var rvIdx = 0;
  var carouselReviews = [];
  var mountedDoc = null;
  var portalReviews = [];
  var overlayMode = null;
  var lastFocus = null;

  function cloneReview(review) {
    var copy = {};
    Object.keys(review || {}).forEach(function (key) { copy[key] = review[key]; });
    return copy;
  }

  function googleReviews() {
    return GOOGLE_REVIEWS.map(cloneReview);
  }

  function legacyReviews() {
    return LEGACY_REVIEWS.map(cloneReview);
  }

  function publicList() {
    return googleReviews().concat(legacyReviews()).filter(function (r) {
      return r && r.name && String(r.text || '').trim();
    });
  }

  function normalizeBody(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function isHiddenOrInternal(item) {
    var status = String(item && item.status || '').toLowerCase();
    if (item && (item.hidden === true || item.internal === true)) return true;
    return status === 'hidden' || status === 'pending_moderation' || status === 'internal';
  }

  function portalCard(item) {
    if (!item || isHiddenOrInternal(item)) return null;
    var text = String(item.text || item.comment || '').trim();
    var name = String(item.name || '').trim();
    var rating = Math.round(Number(item.rating != null ? item.rating : item.stars) || 0);
    if (!name || text.length < 12 || rating < 4 || rating > 5) return null;
    return {
      id: String(item.id || ''),
      name: name,
      rating: rating,
      text: text,
      location: String(item.location || '').trim(),
      date: String(item.date || '').trim(),
      service: String(item.service || '').trim() || 'Mobile Auto Detailing',
      source: 'cardetail1',
      createdAt: String(item.createdAt || ''),
      sort: 0
    };
  }

  function mixed() {
    var seenIds = {};
    var seenBodies = {};
    var out = [];

    function take(review) {
      if (!review || !review.id || !review.name || !String(review.text || '').trim()) return;
      if (seenIds[review.id]) return;
      var body = normalizeBody(review.text);
      if (!body || seenBodies[body]) return;
      seenIds[review.id] = true;
      seenBodies[body] = true;
      out.push(review);
    }

    portalReviews.slice().sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    }).forEach(take);

    googleReviews().forEach(take);
    legacyReviews().forEach(take);
    return out;
  }

  function featured() {
    return [];
  }

  function carousel() {
    return mixed();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initials(name) {
    return String(name || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(function (word) { return word.charAt(0); })
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  function stars(rating) {
    var n = Math.max(0, Math.min(5, Number(rating) || 0));
    return '\u2605'.repeat(n) + '\u2606'.repeat(5 - n);
  }

  function sourceLabel(review) {
    var source = String(review && review.source || '');
    if (source === 'google') return 'Google review';
    if (source === 'cardetail1') return 'Verified Cardetail1 customer';
    return 'Customer';
  }

  function metaLine(review) {
    var bits = [];
    if (review.location) bits.push(review.location);
    if (review.date) bits.push(review.date);
    return bits.join(' \u00b7 ');
  }

  function needsReadMore(text) {
    return String(text || '').length > 180 || String(text || '').split(/\s+/).length > 36;
  }

  function cardHtml(review, opts) {
    opts = opts || {};
    var full = !!opts.full;
    var source = String(review.source || '');
    var label = sourceLabel(review);
    var meta = metaLine(review);
    var more = !full && needsReadMore(review.text);
    var cls = 'rv-card' + (full ? ' rv-card--full' : '');
    return (
      '<article class="' + cls + '" data-review-id="' + escapeHtml(review.id) + '"' +
        ' data-source="' + escapeHtml(source) + '"' +
        ' data-rating="' + escapeHtml(review.rating) + '">' +
        '<div class="rv-stars" aria-label="' + escapeHtml(review.rating) + ' out of 5 stars">' +
          '<span aria-hidden="true">' + stars(review.rating) + '</span>' +
          '<span class="rv-vh">' + escapeHtml(review.rating) + ' out of 5 stars</span>' +
        '</div>' +
        '<p class="rv-text rv-quote"' + (full ? '' : ' data-clamp="5"') + '>' +
          escapeHtml(review.text) +
        '</p>' +
        (more
          ? '<button type="button" class="rv-read-more" data-review-open="' + escapeHtml(review.id) + '">Read more</button>'
          : '') +
        '<div class="rv-author">' +
          '<div class="rv-avatar" aria-hidden="true">' + escapeHtml(initials(review.name)) + '</div>' +
          '<div>' +
            '<div class="rv-name">' + escapeHtml(review.name) + '</div>' +
            (meta ? '<div class="rv-meta">' + escapeHtml(meta) + '</div>' : '') +
            (review.service && source !== 'google'
              ? '<div class="rv-badge">' + escapeHtml(review.service) + '</div>'
              : '') +
            '<div class="rv-source' + (source === 'google' || source === 'cardetail1' ? ' rv-source--' + source : '') + '">' +
              escapeHtml(label) +
            '</div>' +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  function prefersReducedMotion(view) {
    try {
      var media = view && view.matchMedia;
      return !!(media && media.call(view, '(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  }

  function viewportEl() {
    var documentRef = mountedDoc || root.document;
    return documentRef ? documentRef.getElementById('rv-viewport') : null;
  }

  function visibleCount(width) {
    var w = Number(width);
    if (!Number.isFinite(w) || w <= 0) {
      var vp = viewportEl();
      if (vp && vp.clientWidth) w = vp.clientWidth;
      else if (mountedDoc && mountedDoc.defaultView) w = mountedDoc.defaultView.innerWidth || 1440;
      else w = 1440;
    }
    if (w <= 640) return 1;
    if (w <= 900) return 2;
    return 3;
  }

  function pageCount() {
    var vis = visibleCount();
    if (!carouselReviews.length) return 0;
    return Math.max(1, Math.ceil(carouselReviews.length / vis));
  }

  function currentPage() {
    var vis = visibleCount();
    return Math.floor(rvIdx / vis);
  }

  function cardStepPx() {
    var vp = viewportEl();
    if (!vp) return 0;
    var slide = vp.querySelector('.rv-slide');
    if (!slide) return 0;
    var styles = (mountedDoc.defaultView && mountedDoc.defaultView.getComputedStyle)
      ? mountedDoc.defaultView.getComputedStyle(vp)
      : null;
    var gap = styles ? parseFloat(styles.columnGap || styles.gap || '0') : 0;
    return slide.getBoundingClientRect().width + (Number.isFinite(gap) ? gap : 0);
  }

  function syncDots() {
    var documentRef = mountedDoc || root.document;
    if (!documentRef) return;
    var page = currentPage();
    documentRef.querySelectorAll('#reviews .rv-dot').forEach(function (dot, j) {
      dot.classList.toggle('active', j === page);
      dot.setAttribute('aria-current', j === page ? 'true' : 'false');
    });
    var prev = documentRef.getElementById('rv-prev');
    var next = documentRef.getElementById('rv-next');
    var atStart = rvIdx <= 0;
    var atEnd = rvIdx >= Math.max(0, carouselReviews.length - visibleCount());
    if (prev) prev.disabled = atStart;
    if (next) next.disabled = atEnd;
  }

  function goTo(i) {
    if (!carouselReviews.length) return;
    var max = Math.max(0, carouselReviews.length - visibleCount());
    rvIdx = Math.max(0, Math.min(i, max));
    var vp = viewportEl();
    if (!vp) return;
    var step = cardStepPx();
    var behavior = prefersReducedMotion(mountedDoc && mountedDoc.defaultView) ? 'auto' : 'smooth';
    if (typeof vp.scrollTo === 'function') {
      try {
        vp.scrollTo({ left: rvIdx * step, behavior: behavior });
      } catch (_) {
        vp.scrollLeft = rvIdx * step;
      }
    } else {
      vp.scrollLeft = rvIdx * step;
    }
    syncDots();
  }

  function move(dir) {
    goTo(rvIdx + dir);
  }

  function stop() {
    // No autoplay. Kept so existing callers remain safe.
  }

  function ensureOverlay(documentRef) {
    var overlay = documentRef.getElementById('rv-overlay');
    if (overlay) return overlay;
    overlay = documentRef.createElement('div');
    overlay.id = 'rv-overlay';
    overlay.className = 'rv-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'rv-overlay-title');
    overlay.innerHTML =
      '<div class="rv-overlay-backdrop" data-rv-close="true"></div>' +
      '<div class="rv-overlay-panel">' +
        '<div class="rv-overlay-bar">' +
          '<h2 class="rv-overlay-title" id="rv-overlay-title">Reviews</h2>' +
          '<button type="button" class="rv-overlay-close" data-rv-close="true" aria-label="Close reviews">Close</button>' +
        '</div>' +
        '<div class="rv-overlay-body" id="rv-overlay-body"></div>' +
      '</div>';
    documentRef.body.appendChild(overlay);
    return overlay;
  }

  function closeOverlay() {
    var documentRef = mountedDoc || root.document;
    if (!documentRef) return;
    var overlay = documentRef.getElementById('rv-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.remove('is-open');
    overlayMode = null;
    var view = documentRef.defaultView;
    if (view && view.document && view.document.body) {
      view.document.body.classList.remove('rv-overlay-lock');
    }
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (_) {}
    }
    lastFocus = null;
  }

  function openOverlay(title, html, mode) {
    var documentRef = mountedDoc || root.document;
    if (!documentRef) return;
    var overlay = ensureOverlay(documentRef);
    var titleEl = overlay.querySelector('#rv-overlay-title');
    var body = overlay.querySelector('#rv-overlay-body');
    if (titleEl) titleEl.textContent = title;
    if (body) body.innerHTML = html;
    overlay.hidden = false;
    overlay.classList.add('is-open');
    overlayMode = mode;
    lastFocus = documentRef.activeElement;
    if (documentRef.body) documentRef.body.classList.add('rv-overlay-lock');
    var closeBtn = overlay.querySelector('.rv-overlay-close');
    if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  }

  function findReview(id) {
    var key = String(id || '');
    for (var i = 0; i < carouselReviews.length; i++) {
      if (String(carouselReviews[i].id) === key) return carouselReviews[i];
    }
    return null;
  }

  function openReview(id) {
    var review = findReview(id);
    if (!review) return;
    openOverlay('Review', cardHtml(review, { full: true }), 'detail');
  }

  function viewAll() {
    var html = mixed().map(function (review) {
      return cardHtml(review, { full: true });
    }).join('');
    openOverlay('All reviews', html || '<p class="rv-empty">No published reviews yet.</p>', 'all');
  }

  function paint() {
    var documentRef = mountedDoc;
    if (!documentRef) return;
    var track = documentRef.getElementById('rv-track');
    var dots = documentRef.getElementById('rv-dots');
    carouselReviews = carousel();

    if (track) {
      track.innerHTML = carouselReviews.map(function (review) {
        return '<div class="rv-slide">' + cardHtml(review, { full: false }) + '</div>';
      }).join('');
    }

    if (dots) {
      var pages = pageCount();
      var html = '';
      for (var i = 0; i < pages; i++) {
        html += '<button type="button" class="rv-dot' + (i === 0 ? ' active' : '') + '"' +
          ' aria-label="Show reviews page ' + (i + 1) + '"' +
          ' aria-current="' + (i === 0 ? 'true' : 'false') + '"' +
          ' data-rv-page="' + i + '"></button>';
      }
      dots.innerHTML = html;
    }

    var viewAllBtn = documentRef.getElementById('rv-view-all');
    if (viewAllBtn) viewAllBtn.hidden = carouselReviews.length === 0;

    var keep = rvIdx;
    goTo(keep);
  }

  function applyPortalItems(items) {
    portalReviews = (Array.isArray(items) ? items : []).map(portalCard).filter(Boolean);
    paint();
    return portalReviews.slice();
  }

  function fetchPortalReviews() {
    var view = mountedDoc && mountedDoc.defaultView;
    if (!view || typeof view.fetch !== 'function') return;
    if (view.navigator && /jsdom/i.test(view.navigator.userAgent || '')) return;
    view.fetch(PORTAL_REVIEWS_URL)
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.ok && Array.isArray(data.items)) {
          applyPortalItems(data.items);
        }
      })
      .catch(function () {});
  }

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-rv-close]')) {
      closeOverlay();
      return;
    }
    var more = target.closest('[data-review-open]');
    if (more) {
      openReview(more.getAttribute('data-review-open'));
      return;
    }
    var pageBtn = target.closest('[data-rv-page]');
    if (pageBtn) {
      goTo(Number(pageBtn.getAttribute('data-rv-page')) * visibleCount());
    }
  }

  function onKey(event) {
    if (!event) return;
    if (event.key === 'Escape' && overlayMode) {
      closeOverlay();
      return;
    }
    var vp = viewportEl();
    if (!vp) return;
    var active = mountedDoc && mountedDoc.activeElement;
    if (active !== vp && !(active && vp.contains(active))) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      goTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      goTo(carouselReviews.length);
    }
  }

  function onScroll() {
    var vp = viewportEl();
    if (!vp) return;
    var step = cardStepPx();
    if (!step) return;
    var next = Math.round(vp.scrollLeft / step);
    if (next !== rvIdx) {
      var max = Math.max(0, carouselReviews.length - visibleCount());
      rvIdx = Math.max(0, Math.min(next, max));
      syncDots();
    }
  }

  function onResize() {
    var documentRef = mountedDoc;
    if (!documentRef) return;
    var dots = documentRef.getElementById('rv-dots');
    if (dots) {
      var pages = pageCount();
      var page = currentPage();
      var html = '';
      for (var i = 0; i < pages; i++) {
        html += '<button type="button" class="rv-dot' + (i === page ? ' active' : '') + '"' +
          ' aria-label="Show reviews page ' + (i + 1) + '"' +
          ' aria-current="' + (i === page ? 'true' : 'false') + '"' +
          ' data-rv-page="' + i + '"></button>';
      }
      dots.innerHTML = html;
    }
    goTo(rvIdx);
  }

  function bind(documentRef) {
    if (documentRef._cd1ReviewsBound) return;
    documentRef._cd1ReviewsBound = true;
    documentRef.addEventListener('click', onClick);
    documentRef.addEventListener('keydown', onKey);
    var vp = documentRef.getElementById('rv-viewport');
    if (vp) {
      vp.addEventListener('scroll', onScroll, { passive: true });
    }
    var view = documentRef.defaultView;
    if (view && typeof view.addEventListener === 'function') {
      view.addEventListener('resize', onResize);
    }
    ensureOverlay(documentRef);
  }

  function mount(doc, opts) {
    var documentRef = doc || (root.document);
    if (!documentRef) return;
    mountedDoc = documentRef;
    rvIdx = 0;
    bind(documentRef);
    paint();
    if (!opts || opts.fetch !== false) fetchPortalReviews();
  }

  var api = {
    GOOGLE_REVIEW_URL: GOOGLE_REVIEW_URL,
    GOOGLE_LISTING: GOOGLE_LISTING,
    PORTAL_REVIEWS_URL: PORTAL_REVIEWS_URL,
    READ_MORE_LINES: READ_MORE_LINES,
    all: publicList,
    googleReviews: googleReviews,
    legacyReviews: legacyReviews,
    featured: featured,
    carousel: carousel,
    mixed: mixed,
    mount: mount,
    goTo: goTo,
    move: move,
    stop: stop,
    cardHtml: cardHtml,
    applyPortalItems: applyPortalItems,
    visibleCount: visibleCount,
    sourceLabel: sourceLabel,
    viewAll: viewAll,
    openReview: openReview,
    closeOverlay: closeOverlay,
    escapeHtml: escapeHtml
  };

  root.CD1CustomerReviews = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
