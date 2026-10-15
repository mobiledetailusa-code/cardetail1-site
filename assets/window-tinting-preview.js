/**
 * Window tint landing preview.
 * Renders the demo comparison from the catalog and opens the existing
 * booking form. It does not collect ZIP, vehicle, contact, or payment,
 * and it does not submit, store, or charge.
 */
(function (root) {
  var state = { filmId: '', coverageId: '', booted: false };

  function catalog() {
    return root.CD1WindowTintDemo;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function selectedFilm() {
    var chosen = document.querySelector('input[name="wt-film"]:checked');
    return chosen ? chosen.value : state.filmId;
  }

  function selectedCoverage() {
    var chosen = document.querySelector('input[name="wt-coverage"]:checked');
    return chosen ? chosen.value : state.coverageId;
  }

  function syncOpenButton() {
    var button = $('wt-open-booking');
    if (!button) return;
    button.disabled = !(selectedFilm() && selectedCoverage());
  }

  function renderComparison() {
    var host = $('wt-compare');
    var api = catalog();
    if (!host || !api) return;
    var table = document.createElement('table');
    table.className = 'wt-compare';
    var caption = document.createElement('caption');
    caption.textContent = api.DEMO_PRICE_LABEL;
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Coverage', 'Carbon', 'Ceramic'].forEach(function (label) {
      var cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    var body = document.createElement('tbody');
    api.DEMO_PRICE_ROWS.forEach(function (row) {
      var tr = document.createElement('tr');
      [row.label, api.formatDollars(row.carbonCents), api.formatDollars(row.ceramicCents)].forEach(function (text) {
        var cell = document.createElement('td');
        cell.textContent = text;
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    table.appendChild(caption);
    table.appendChild(head);
    table.appendChild(body);
    var wrap = document.createElement('div');
    wrap.className = 'wt-compare-wrap';
    wrap.appendChild(table);
    host.replaceChildren(wrap);
  }

  function renderCoverage() {
    var host = $('wt-coverage-choices');
    var api = catalog();
    if (!host || !api) return;
    host.replaceChildren();
    api.COVERAGES.forEach(function (coverage) {
      var label = document.createElement('label');
      label.className = 'wt-choice';
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'wt-coverage';
      input.value = coverage.id;
      if (coverage.id === state.coverageId) input.checked = true;
      var strong = document.createElement('strong');
      strong.textContent = coverage.label;
      var small = document.createElement('small');
      small.textContent = coverage.summary;
      label.appendChild(input);
      label.appendChild(strong);
      label.appendChild(small);
      host.appendChild(label);
    });
  }

  function applySelection(filmId, coverageId) {
    if (filmId) state.filmId = filmId;
    if (coverageId) state.coverageId = coverageId;
    document.querySelectorAll('input[name="wt-film"]').forEach(function (input) {
      input.checked = input.value === state.filmId;
    });
    document.querySelectorAll('input[name="wt-coverage"]').forEach(function (input) {
      input.checked = input.value === state.coverageId;
    });
    document.querySelectorAll('[data-wt-film]').forEach(function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-wt-film') === state.filmId ? 'true' : 'false');
    });
    syncOpenButton();
  }

  function bookingUrl() {
    var params = new URLSearchParams();
    params.set('embed', '1');
    params.set('wtpreview', '1');
    params.set('film', selectedFilm());
    params.set('coverage', selectedCoverage());
    return '/?' + params.toString();
  }

  function ensureOverlay() {
    var overlay = $('wt-booking-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'wt-booking-overlay';
    overlay.className = 'wt-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Window tint preview');
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wt-overlay-close';
    closeBtn.setAttribute('aria-label', 'Close preview');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeBooking);
    var frame = document.createElement('iframe');
    frame.id = 'wt-booking-frame';
    frame.title = 'Window tint booking preview';
    overlay.appendChild(closeBtn);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeBooking() {
    var overlay = $('wt-booking-overlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.hidden = true;
    var frame = $('wt-booking-frame');
    if (frame) frame.src = 'about:blank';
    document.body.style.overflow = '';
  }

  function openBooking() {
    if (!selectedFilm() || !selectedCoverage()) return;
    var overlay = ensureOverlay();
    overlay.hidden = false;
    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    $('wt-booking-frame').src = bookingUrl();
    var closeBtn = overlay.querySelector('.wt-overlay-close');
    if (closeBtn) closeBtn.focus();
  }

  function init() {
    var api = catalog();
    if (!api || !$('wt-coverage-choices')) return;
    var fromLink = api.selectionFromSearch(root.location ? root.location.search : '');
    state.filmId = fromLink.filmId || 'wt_film_carbon';
    state.coverageId = fromLink.coverageId || '';
    renderComparison();
    renderCoverage();
    applySelection(state.filmId, state.coverageId);
    var note = $('wt-url-note');
    if (note && fromLink.ignoredPriceKeys.length) {
      note.hidden = false;
      note.textContent = 'A price in the link was ignored. Demo pricing comes only from the window tint catalog.';
    }
    document.querySelectorAll('[data-wt-film]').forEach(function (button) {
      button.addEventListener('click', function () {
        applySelection(button.getAttribute('data-wt-film'), selectedCoverage());
        var coverage = $('coverage');
        if (coverage && coverage.scrollIntoView) coverage.scrollIntoView();
      });
    });
    var choices = $('wt-coverage-choices');
    if (choices) {
      choices.addEventListener('change', function () {
        applySelection(selectedFilm(), selectedCoverage());
      });
    }
    var open = $('wt-open-booking');
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

  if ($('wt-coverage-choices')) boot();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  root.CD1WindowTintPreview = {
    bookingUrl: bookingUrl,
    selectedFilm: selectedFilm,
    selectedCoverage: selectedCoverage,
    closeBooking: closeBooking,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
