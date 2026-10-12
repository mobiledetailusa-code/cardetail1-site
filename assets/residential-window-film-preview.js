/**
 * Residential window film landing preview.
 * Opens the existing booking form with the selected film.
 * It does not price, store, submit, or charge.
 */
(function (root) {
  var state = { filmId: '', booted: false };

  function catalog() {
    return root.CD1ResidentialWindowFilm;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function selectedFilm() {
    var pressed = document.querySelector('[data-rwf-film][aria-pressed="true"]');
    return pressed ? pressed.getAttribute('data-rwf-film') : state.filmId;
  }

  function syncOpenButton() {
    var button = $('rwf-open-booking');
    if (!button) return;
    button.disabled = !selectedFilm();
  }

  function applySelection(filmId) {
    state.filmId = filmId || '';
    document.querySelectorAll('[data-rwf-film]').forEach(function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-rwf-film') === state.filmId ? 'true' : 'false');
    });
    syncOpenButton();
  }

  function bookingUrl() {
    var params = new URLSearchParams();
    params.set('embed', '1');
    params.set('rwfpreview', '1');
    params.set('film', selectedFilm());
    return '/?' + params.toString();
  }

  function ensureOverlay() {
    var overlay = $('rwf-booking-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'rwf-booking-overlay';
    overlay.className = 'wt-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Residential window film preview');
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wt-overlay-close';
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', closeBooking);
    var frame = document.createElement('iframe');
    frame.id = 'rwf-booking-frame';
    frame.title = 'Residential window film preview';
    overlay.appendChild(closeBtn);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeBooking() {
    var overlay = $('rwf-booking-overlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.hidden = true;
    var frame = $('rwf-booking-frame');
    if (frame) frame.src = 'about:blank';
    document.body.style.overflow = '';
  }

  function openBooking() {
    if (!selectedFilm()) return;
    var overlay = ensureOverlay();
    overlay.hidden = false;
    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    $('rwf-booking-frame').src = bookingUrl();
    var closeBtn = overlay.querySelector('.wt-overlay-close');
    if (closeBtn) closeBtn.focus();
  }

  function init() {
    var api = catalog();
    if (!api || !$('rwf-open-booking')) return;
    var fromLink = api.selectionFromSearch(root.location ? root.location.search : '');
    applySelection(fromLink.filmId || '');
    var note = $('rwf-url-note');
    if (note && fromLink.ignoredOfferKeys.length) {
      note.hidden = false;
      note.textContent = 'A price or booking switch in the link was ignored. This preview calculates area only.';
    }
    document.querySelectorAll('[data-rwf-film]').forEach(function (button) {
      button.addEventListener('click', function () {
        applySelection(button.getAttribute('data-rwf-film'));
        var measure = $('measure');
        if (measure && measure.scrollIntoView) measure.scrollIntoView();
      });
    });
    var open = $('rwf-open-booking');
    if (open) open.addEventListener('click', openBooking);
    root.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'cd1-booking-closed') return;
      closeBooking();
    });
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    init();
  }

  if ($('rwf-open-booking')) boot();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  root.CD1ResidentialWindowFilmPreview = {
    bookingUrl: bookingUrl,
    selectedFilm: selectedFilm,
    closeBooking: closeBooking,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
