/**
 * First-party Cardetail1 customer reviews for the homepage.
 *
 * This is a curated list we publish ourselves. It is not a live Google Places
 * widget, not a Maps scrape, and not an AggregateRating feed.
 *
 * Intentionally omitted from the public list:
 * - Empty quotes (no text to show)
 * - Duplicate bodies attributed to two different names
 * - The operator's own listing comment (not customer social proof)
 */
(function (root) {
  'use strict';

  var GOOGLE_REVIEW_URL = 'https://g.page/r/CTJwfJerrQeCEAI/review';

  var REVIEWS = [
    {
      id: 'pablo-sanchez',
      name: 'Pablo Sanchez',
      rating: 5,
      text: 'The detailer did an amazing job, very thorough and I\'m impressed with the high level of quality service he provided. The car looks brand new.',
      location: 'NJ Area',
      date: 'May 2025',
      service: 'Subaru Crosstrek · Exterior Detail',
      featured: true
    },
    {
      id: 'craig-bitman',
      name: 'Craig Bitman',
      rating: 5,
      text: 'Incredible work on my BMW. Magno was professional, punctual, and the results speak for themselves. Highly recommend Cardetail1 to anyone who takes pride in their car.',
      location: 'Craryville, NY',
      date: 'May 2025',
      service: 'BMW 4 Series · Exterior Detail',
      featured: true
    },
    {
      id: 'paul-berliner',
      name: 'Paul Berliner',
      rating: 5,
      text: 'Fantastic detailing by Magno! Super intelligent, efficient and a pleasure to deal with. My Land Rover Defender now looks brand new! Thank you Magno! My life is now better!',
      location: 'Brooklyn, NY',
      date: 'Jun 2025',
      service: 'Land Rover Defender 130 · Exterior Detail',
      featured: true
    },
    {
      id: 'patrice-zaborski',
      name: 'Patrice Zaborski',
      rating: 5,
      text: 'Magno, our detailer did a wonderful job. Our RV looks like new. He was professional, pleasant and detail oriented. He took his time to make sure all was perfect. We look forward to Magno working on our vehicle in the future. Thank you!',
      location: 'East Hampton, NY',
      date: 'Jun 2025',
      service: 'Renegade Vienna Motorhome · Full Detail',
      featured: true
    },
    {
      id: 'claudio-campos',
      name: 'Claudio Campos',
      rating: 5,
      text: 'Great job!! Highly recommended! My car looks like it just came out of the dealership.',
      location: 'NJ / NY area',
      date: 'May 2026',
      service: 'Mobile Auto Detailing',
      featured: true
    },
    {
      id: 'david-johnson',
      name: 'David Johnson',
      rating: 5,
      text: 'Excellent work! Arrived timely and was a pleasure to work with. I was thinking this would be a one time thing but it\'s been a good experience so we\'re considering getting the other car done.',
      location: 'Amityville, NY',
      date: 'Jun 2025',
      service: 'Grand Design 320G 5th Wheel · Full Detail',
      featured: false
    },
    {
      id: 'maryjane-raymond',
      name: 'MaryJane Raymond',
      rating: 5,
      text: 'Magno was excellent and efficient!!!',
      location: 'Far Hills, NJ',
      date: 'Jun 2025',
      service: 'Volvo XC60 · Full Detail',
      featured: false
    },
    {
      id: 'andy-rudin',
      name: 'Andy Rudin',
      rating: 5,
      text: 'Service was timely and the car is gorgeous.',
      location: 'Bronx, NY',
      date: 'Jun 2025',
      service: 'Honda CR-V · Full Detail',
      featured: false
    },
    {
      id: 'dani-sames',
      name: 'Dani Sames',
      rating: 5,
      text: 'My car was horrible. Now it\'s brand new, great job.',
      location: 'NJ / NY area',
      date: 'Aug 2025',
      service: 'Mobile Auto Detailing',
      featured: false
    },
    {
      id: 'rose-alves',
      name: 'Rose Alves',
      rating: 5,
      text: 'Good job. My car was terrible, now it\'s brand new.',
      location: 'NJ / NY area',
      date: 'Aug 2025',
      service: 'Mobile Auto Detailing',
      featured: false
    },
    {
      id: 'adilsom-pedro',
      name: 'Adilsom Pedro',
      rating: 5,
      text: 'Excellent work, 100% guaranteed.',
      location: 'NJ / NY area',
      date: 'May 2026',
      service: 'Mobile Auto Detailing',
      featured: false
    }
  ];

  var rvIdx = 0;
  var rvTimer = null;
  var carouselReviews = [];
  var mountedDoc = null;

  function publicList() {
    return REVIEWS.filter(function (r) {
      return r && r.name && String(r.text || '').trim();
    });
  }

  function featured() {
    return publicList().filter(function (r) { return !!r.featured; });
  }

  function carousel() {
    return publicList().filter(function (r) { return !r.featured; });
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

  function locationLabel(review) {
    var loc = String(review.location || '').trim();
    return loc || 'NJ / NY area';
  }

  function cardHtml(review, featuredCard) {
    var cls = featuredCard ? 'rv-card rv-card--featured' : 'rv-card';
    return (
      '<article class="' + cls + '" data-review-id="' + escapeHtml(review.id) + '"' +
        (featuredCard ? ' data-featured="true"' : '') + '>' +
        '<div class="rv-stars" aria-label="' + escapeHtml(review.rating) + ' out of 5 stars">' +
          stars(review.rating) +
        '</div>' +
        '<p class="rv-text">\u201c' + escapeHtml(review.text) + '\u201d</p>' +
        '<div class="rv-author">' +
          '<div class="rv-avatar" aria-hidden="true">' + escapeHtml(initials(review.name)) + '</div>' +
          '<div>' +
            '<div class="rv-name">' + escapeHtml(review.name) + '</div>' +
            '<div class="rv-meta">' + escapeHtml(locationLabel(review)) + ' \u00b7 ' + escapeHtml(review.date) + '</div>' +
            '<div class="rv-badge">' + escapeHtml(review.service) + '</div>' +
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

  function goTo(i) {
    if (!carouselReviews.length) return;
    rvIdx = ((i % carouselReviews.length) + carouselReviews.length) % carouselReviews.length;
    var documentRef = mountedDoc || root.document;
    if (!documentRef) return;
    var track = documentRef.getElementById('rv-track');
    if (track) track.style.transform = 'translateX(-' + (rvIdx * 100) + '%)';
    documentRef.querySelectorAll('#reviews .rv-dot').forEach(function (dot, j) {
      dot.classList.toggle('active', j === rvIdx);
      dot.setAttribute('aria-current', j === rvIdx ? 'true' : 'false');
    });
    var counter = documentRef.getElementById('rv-counter');
    if (counter) counter.textContent = (rvIdx + 1) + ' / ' + carouselReviews.length;
  }

  function move(dir) {
    goTo(rvIdx + dir);
  }

  function stop() {
    var view = mountedDoc && mountedDoc.defaultView;
    if (rvTimer != null) {
      if (view && typeof view.clearInterval === 'function') view.clearInterval(rvTimer);
      else clearInterval(rvTimer);
      rvTimer = null;
    }
  }

  function startAutoAdvance() {
    stop();
    if (carouselReviews.length < 2) return;
    var view = mountedDoc && mountedDoc.defaultView;
    if (!view || typeof view.setInterval !== 'function') return;
    if (prefersReducedMotion(view)) return;
    if (view.navigator && /jsdom/i.test(view.navigator.userAgent || '')) return;
    rvTimer = view.setInterval(function () { move(1); }, 5000);
  }

  function mount(doc) {
    var documentRef = doc || (root.document);
    if (!documentRef) return;
    mountedDoc = documentRef;
    var featuredRoot = documentRef.getElementById('rv-featured');
    var track = documentRef.getElementById('rv-track');
    var dots = documentRef.getElementById('rv-dots');
    var more = documentRef.getElementById('rv-more');
    var featuredReviews = featured();
    carouselReviews = carousel();

    if (featuredRoot) {
      featuredRoot.innerHTML = featuredReviews.map(function (review) {
        return cardHtml(review, true);
      }).join('');
    }

    if (track) {
      track.innerHTML = carouselReviews.map(function (review) {
        return '<div class="rv-slide">' + cardHtml(review, false) + '</div>';
      }).join('');
    }

    if (dots) {
      dots.innerHTML = carouselReviews.map(function (_, i) {
        return '<button type="button" class="rv-dot' + (i === 0 ? ' active' : '') + '"' +
          ' aria-label="Show review ' + (i + 1) + '"' +
          ' aria-current="' + (i === 0 ? 'true' : 'false') + '"' +
          ' onclick="rvGoTo(' + i + ')"></button>';
      }).join('');
    }

    if (more) {
      more.hidden = carouselReviews.length === 0;
    }

    goTo(0);
    startAutoAdvance();
  }

  var api = {
    GOOGLE_REVIEW_URL: GOOGLE_REVIEW_URL,
    all: publicList,
    featured: featured,
    carousel: carousel,
    mount: mount,
    goTo: goTo,
    move: move,
    stop: stop,
    cardHtml: cardHtml
  };

  root.CD1CustomerReviews = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
