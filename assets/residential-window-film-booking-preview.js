/**
 * Residential window film inside the existing booking form.
 * Active only for ?rwfpreview=1, and not when automotive ?wtpreview=1 is set.
 * Reuses contact and address fields. Calculates area only.
 * Does not write cd1_* storage, consult the live schedule, or create a charge.
 */
(function (root) {
  var STEPS = ['film', 'measure', 'contact', 'review'];
  var state = {
    step: 'film',
    filmId: '',
    started: false,
    disarmed: false,
    rowSeed: 1,
  };

  function catalog() {
    return root.CD1ResidentialWindowFilm;
  }

  function previewRequested() {
    try {
      var params = new URLSearchParams(root.location.search || '');
      return params.get('rwfpreview') === '1' && params.get('wtpreview') !== '1';
    } catch (e) {
      return false;
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function blockStorageKey(key) {
    return String(key || '').indexOf('cd1_') === 0;
  }

  function guardBrowser() {
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      var store = root[name];
      if (!store || store.__rwfPreviewGuarded) return;
      var setItem = store.setItem ? store.setItem.bind(store) : null;
      var removeItem = store.removeItem ? store.removeItem.bind(store) : null;
      if (setItem) {
        store.setItem = function (key, value) {
          if (blockStorageKey(key)) return;
          return setItem(key, value);
        };
      }
      if (removeItem) {
        store.removeItem = function (key) {
          if (blockStorageKey(key)) return;
          return removeItem(key);
        };
      }
      store.__rwfPreviewGuarded = true;
    });
    if (typeof root.fetch === 'function' && !root.fetch.__rwfPreviewGuarded) {
      var origFetch = root.fetch.bind(root);
      var blocked = /submit-booking|booking-availability|create-setup-intent|create-payment|ceramic-checkout|customer-balance-payment|welcome-lead|revenue-event|submit-inquiry|api\.stripe\.com|googletagmanager|google-analytics|gtag/i;
      var guarded = function (url) {
        var href = String((url && url.url) || url || '');
        if (blocked.test(href)) {
          var body = {
            ok: false,
            error: 'residential_window_film_preview_blocked',
            bookingCreated: false,
            paymentCreated: false,
          };
          return Promise.resolve({
            ok: false,
            status: 403,
            json: function () { return Promise.resolve(body); },
            text: function () { return Promise.resolve(JSON.stringify(body)); },
          });
        }
        return origFetch.apply(root, arguments);
      };
      guarded.__rwfPreviewGuarded = true;
      root.fetch = guarded;
    }
    root.gtag = function () {};
    if (document.createElement && !document.createElement.__rwfPreviewGuarded) {
      var create = document.createElement.bind(document);
      var guardedCreate = function (name) {
        var el = create(name);
        if (String(name).toLowerCase() !== 'script') return el;
        var realSrc = '';
        try {
          Object.defineProperty(el, 'src', {
            configurable: true,
            get: function () { return realSrc; },
            set: function (value) {
              var next = String(value || '');
              if (/googletagmanager|google-analytics|js\.stripe\.com|stripe\.com/i.test(next)) return;
              realSrc = next;
              el.setAttribute('src', realSrc);
            },
          });
        } catch (e) { /* property already sealed */ }
        return el;
      };
      guardedCreate.__rwfPreviewGuarded = true;
      document.createElement = guardedCreate;
    }
  }

  function disarmResume() {
    var progress = root.CD1BookingProgress;
    if (!progress || state.disarmed) return;
    state.disarmed = true;
    progress.resumeFromQuery = function () {
      return { opened: false, reason: 'residential_window_film_preview' };
    };
    progress.applySnapshot = function () { return false; };
    progress.persist = function () {};
  }

  function readValue(id) {
    var el = $(id);
    return el ? String(el.value || '').trim() : '';
  }

  function checkedValue(name) {
    var chosen = document.querySelector('#rwf-book input[name="' + name + '"]:checked');
    return chosen ? chosen.value : '';
  }

  function field(label, control) {
    var wrap = document.createElement('label');
    wrap.className = 'rwfb-field';
    var span = document.createElement('span');
    span.textContent = label;
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
  }

  function choice(name, value, label, help) {
    var wrap = document.createElement('label');
    wrap.className = 'rwfb-choice';
    var input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    var strong = document.createElement('strong');
    strong.textContent = label;
    wrap.appendChild(input);
    wrap.appendChild(strong);
    if (help) {
      var small = document.createElement('small');
      small.textContent = help;
      wrap.appendChild(small);
    }
    return wrap;
  }

  function readRows() {
    return Array.prototype.map.call(document.querySelectorAll('#rwfb-rows [data-rwfb-row]'), function (row) {
      return {
        quantity: row.querySelector('[data-field="quantity"]').value,
        width: row.querySelector('[data-field="width"]').value,
        height: row.querySelector('[data-field="height"]').value,
        unit: row.querySelector('[data-field="unit"]').value,
      };
    });
  }

  function currentMeasure() {
    var api = catalog();
    if (!api) return null;
    return api.measure({
      filmId: checkedValue('rwfb-film') || state.filmId,
      glassTypeId: checkedValue('rwfb-glass'),
      floor: readValue('rwfb-floor'),
      access: readValue('rwfb-access'),
      rows: readRows(),
      price: 1,
      enabled: true,
      commercialReady: true,
      bookable: true,
      compatible: true,
      amountCents: 1,
      durationMinutes: 15,
    });
  }

  function renderRows(rows) {
    var host = $('rwfb-rows');
    if (!host) return;
    host.replaceChildren();
    rows.forEach(function (row, index) {
      var card = document.createElement('div');
      card.className = 'rwfb-size';
      card.setAttribute('data-rwfb-row', String(index + 1));
      var qty = document.createElement('input');
      qty.type = 'number';
      qty.min = '1';
      qty.step = '1';
      qty.inputMode = 'numeric';
      qty.setAttribute('data-field', 'quantity');
      qty.value = row.quantity || '';
      var width = document.createElement('input');
      width.type = 'number';
      width.min = '0';
      width.step = '0.01';
      width.inputMode = 'decimal';
      width.setAttribute('data-field', 'width');
      width.value = row.width || '';
      var height = document.createElement('input');
      height.type = 'number';
      height.min = '0';
      height.step = '0.01';
      height.inputMode = 'decimal';
      height.setAttribute('data-field', 'height');
      height.value = row.height || '';
      var unit = document.createElement('select');
      unit.setAttribute('data-field', 'unit');
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Choose a unit';
      unit.appendChild(blank);
      catalog().UNITS.forEach(function (item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        unit.appendChild(option);
      });
      unit.value = row.unit || '';
      card.appendChild(field('Number of panes', qty));
      card.appendChild(field('Width', width));
      card.appendChild(field('Height', height));
      card.appendChild(field('Unit', unit));
      var actions = document.createElement('div');
      actions.className = 'rwfb-row';
      var repeat = document.createElement('button');
      repeat.type = 'button';
      repeat.setAttribute('data-rwfb-repeat', '');
      repeat.textContent = 'Repeat this size';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('data-rwfb-remove', '');
      remove.textContent = 'Remove this size';
      if (rows.length === 1) remove.disabled = true;
      actions.appendChild(repeat);
      actions.appendChild(remove);
      card.appendChild(actions);
      host.appendChild(card);
    });
  }

  function paintArea() {
    var host = $('rwfb-area');
    var result = currentMeasure();
    if (!host || !result) return;
    host.replaceChildren();
    var kicker = document.createElement('p');
    kicker.className = 'rwfb-kicker';
    kicker.textContent = 'Area only. No price is set.';
    var figure = document.createElement('p');
    figure.id = 'rwfb-area-figure';
    figure.className = 'rwfb-figure';
    figure.textContent = result.areaSqFt == null ? 'Measurement still needed' : catalog().formatArea(result.areaSqFt);
    host.appendChild(kicker);
    host.appendChild(figure);
    if (result.rows.length) {
      var list = document.createElement('ul');
      result.rows.forEach(function (row) {
        var item = document.createElement('li');
        item.textContent = row.quantity + ' panes · ' + row.width + ' ' + row.unitShort + ' × ' + row.height + ' ' + row.unitShort + ' · ' + catalog().formatArea(row.areaSqFt);
        list.appendChild(item);
      });
      host.appendChild(list);
    }
    if (result.nightPrivacyNote) {
      var night = document.createElement('p');
      night.id = 'rwfb-night';
      night.textContent = result.nightPrivacyNote;
      host.appendChild(night);
    }
    var fit = document.createElement('p');
    fit.textContent = 'Glass type is recorded only. This preview does not decide whether a film fits the glass.';
    host.appendChild(fit);
  }

  function showError(message) {
    var el = $('rwfb-error');
    if (el) el.textContent = message || '';
  }

  function showStep(step) {
    state.step = step;
    document.querySelectorAll('#rwf-book [data-rwfb-step]').forEach(function (panel) {
      var on = panel.getAttribute('data-rwfb-step') === step;
      panel.hidden = !on;
      if (on) {
        var title = panel.querySelector('h2');
        if (title) title.focus();
      }
    });
    document.querySelectorAll('#rwf-book [data-rwfb-tab]').forEach(function (button) {
      if (button.getAttribute('data-rwfb-tab') === step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    paintArea();
  }

  function validate(step) {
    if (step === 'film') {
      if (!checkedValue('rwfb-film')) return 'Choose a film.';
    }
    if (step === 'measure') {
      if (!checkedValue('rwfb-glass')) return 'Choose a glass type, or choose I don\'t know.';
      if (!readValue('rwfb-floor')) return 'Enter the floor.';
      if (!readValue('rwfb-access')) return 'Describe how the window is reached.';
      var result = currentMeasure();
      if (!result || result.areaSqFt == null) return 'Enter each width, height, unit, and number of panes.';
    }
    if (step === 'contact') {
      if (!readValue('f-first') || !readValue('f-last')) return 'Enter a first and last name.';
      if (readValue('f-phone').replace(/\D/g, '').length < 7) return 'Enter a phone number.';
      if (readValue('f-email').indexOf('@') === -1) return 'Enter an email address.';
      if (!readValue('f-addr')) return 'Enter a service address.';
    }
    return '';
  }

  function go(step) {
    showError('');
    showStep(step);
  }

  function next() {
    var message = validate(state.step);
    if (message) {
      showError(message);
      return;
    }
    var index = STEPS.indexOf(state.step);
    if (state.step === 'contact') paintReview();
    if (index < STEPS.length - 1) go(STEPS[index + 1]);
  }

  function back() {
    var index = STEPS.indexOf(state.step);
    if (index > 0) go(STEPS[index - 1]);
  }

  function paintReview() {
    var host = $('rwfb-review-body');
    var result = currentMeasure();
    if (!host || !result) return;
    host.replaceChildren();
    function line(text) {
      var p = document.createElement('p');
      p.textContent = text;
      host.appendChild(p);
    }
    line(result.filmName || 'Film still needed');
    line('Glass type: ' + (result.glassTypeLabel || 'Still needed'));
    line('Floor: ' + (result.floor || 'Not given'));
    line('Access: ' + (result.access || 'Not given'));
    line('Area only: ' + (result.areaSqFt == null ? 'Measurement still needed' : catalog().formatArea(result.areaSqFt)));
    line('No price is set. No time is confirmed. Compatibility is not confirmed.');
    line((readValue('f-first') + ' ' + readValue('f-last')).trim());
    line(readValue('f-addr'));
    if (result.rows.length) {
      var list = document.createElement('ul');
      result.rows.forEach(function (row) {
        var item = document.createElement('li');
        item.textContent = row.quantity + ' panes · ' + row.width + ' ' + row.unitShort + ' × ' + row.height + ' ' + row.unitShort;
        list.appendChild(item);
      });
      host.appendChild(list);
    }
    if (result.nightPrivacyNote) line(result.nightPrivacyNote);
    line('Contact and address stay in this preview. Nothing is texted, emailed, or stored as a lead.');
  }

  function finish() {
    var resultHost = $('rwfb-result');
    var result = currentMeasure();
    if (!resultHost || !result || result.areaSqFt == null) return;
    resultHost.hidden = false;
    resultHost.replaceChildren();
    var title = document.createElement('h2');
    title.textContent = 'Demo completed. No appointment was created.';
    var area = document.createElement('p');
    area.textContent = 'Area only: ' + catalog().formatArea(result.areaSqFt) + '. No price was set.';
    var quiet = document.createElement('p');
    quiet.textContent = 'No message was sent. Residential film was not added to a detailing appointment.';
    var time = document.createElement('p');
    time.textContent = 'No time is confirmed. Compatibility is not confirmed.';
    resultHost.appendChild(title);
    resultHost.appendChild(area);
    resultHost.appendChild(quiet);
    resultHost.appendChild(time);
    var button = $('rwfb-finish');
    if (button) button.disabled = true;
  }

  function moveField(id, slot) {
    var el = $(id);
    if (!el || !slot) return;
    var parent = el.closest ? el.closest('.fg') : null;
    slot.appendChild(parent || el);
  }

  function buildShell() {
    var content = document.querySelector('#bk-ov .bcontent');
    if (!content || $('rwf-book')) return;
    var shell = document.createElement('div');
    shell.id = 'rwf-book';
    shell.innerHTML = ''
      + '<p class="rwfb-banner">Residential window film preview. Area only. No price is set.</p>'
      + '<ol class="rwfb-progress">'
      + STEPS.map(function (step) {
        return '<li><button type="button" data-rwfb-tab="' + step + '">' + step + '</button></li>';
      }).join('')
      + '</ol>'
      + '<div id="rwfb-area" aria-live="polite"></div>'
      + '<p class="rwfb-error" id="rwfb-error" role="alert"></p>'
      + '<section data-rwfb-step="film"><h2 tabindex="-1">Film</h2><p id="rwfb-url-note" hidden></p><div id="rwfb-film-choices"></div><div class="rwfb-row"><button type="button" data-rwfb-next>Continue</button></div></section>'
      + '<section data-rwfb-step="measure" hidden><h2 tabindex="-1">Glass</h2><p>Enter the number of panes and the width and height with a unit. Repeat a size when the same measurement applies again. The floor and access are notes, not a price.</p><div id="rwfb-glass-choices"></div><div id="rwfb-place"></div><div id="rwfb-rows"></div><div class="rwfb-row"><button type="button" id="rwfb-add-size">Add a different size</button></div><div class="rwfb-row"><button type="button" data-rwfb-back>Back</button><button type="button" data-rwfb-next>Continue</button></div></section>'
      + '<section data-rwfb-step="contact" hidden><h2 tabindex="-1">Contact and address</h2><p>These are the detailing contact and address fields. Nothing is texted, emailed, or stored as a lead.</p><div id="rwfb-contact-slot"></div><div class="rwfb-row"><button type="button" data-rwfb-back>Back</button><button type="button" data-rwfb-next>Review</button></div></section>'
      + '<section data-rwfb-step="review" hidden><h2 tabindex="-1">Review</h2><div id="rwfb-review-body"></div><div class="rwfb-row"><button type="button" data-rwfb-back>Back</button><button type="button" id="rwfb-finish">Finish preview</button></div><div id="rwfb-result" role="status" hidden></div></section>';
    content.appendChild(shell);
    var style = document.createElement('style');
    style.textContent = ''
      + '#rwf-book{color:var(--tx,#c8d0da);font-family:var(--fb,"DM Sans",sans-serif)}'
      + '#rwf-book h2{display:inline-block;font-family:var(--fd,"Bebas Neue",sans-serif);font-weight:400;letter-spacing:.03em;color:var(--ink,#ece8e1);font-size:32px;margin:0 0 8px}'
      + '#rwf-book h2:focus{outline:2px solid #4d8fd9;outline-offset:3px}'
      + '#rwf-book .bsec{display:none!important}'
      + '.rwfb-banner,.rwfb-kicker{color:var(--gold,#c4a574);font-weight:700}'
      + '.rwfb-progress{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;padding:0;list-style:none}'
      + '.rwfb-progress button{min-height:40px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit}'
      + '.rwfb-progress button[aria-current="step"]{border-color:var(--blue,#4d8fd9);color:#fff}'
      + '.rwfb-choice,.rwfb-size,.rwfb-field input,.rwfb-field select{background:#0c1218}'
      + '#rwfb-area{border:1px solid rgba(196,165,116,.28);border-radius:16px;padding:14px;margin:0 0 12px}'
      + '.rwfb-figure{font-family:var(--fd,"Bebas Neue",sans-serif);font-size:40px;line-height:1;color:#fff;margin:6px 0}'
      + '.rwfb-choice{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;padding:12px;margin:0 0 8px;border:1px solid rgba(255,255,255,.12);border-radius:14px}'
      + '.rwfb-choice small{grid-column:2;color:#b7c2d0}'
      + '.rwfb-size{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 12px;padding:12px;border:1px solid rgba(255,255,255,.12);border-radius:14px}'
      + '.rwfb-field{display:flex;flex-direction:column;gap:6px}'
      + '.rwfb-field input,.rwfb-field select,.rwfb-row button{min-height:48px;font:inherit;color:inherit}'
      + '.rwfb-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}'
      + '.rwfb-row button{border:0;border-radius:999px;padding:12px 16px;background:var(--blue,#4d8fd9);color:#fff;cursor:pointer}'
      + '.rwfb-row [data-rwfb-back],.rwfb-row [data-rwfb-remove]{background:transparent;border:1px solid rgba(255,255,255,.28)}'
      + '.rwfb-error{color:#ffd0d0;font-weight:700;min-height:1.2em}'
      + '#rwfb-result{margin-top:12px;padding:14px;border-radius:16px;border:1px solid rgba(157,222,180,.45)}'
      + 'html.rwf-preview-mode #cd1-consent-banner{display:none!important}'
      + '@media(max-width:800px){#rwf-book .rwfb-size{grid-template-columns:1fr}#rwf-book .rwfb-row button{width:100%}}';
    document.head.appendChild(style);
  }

  function fillChoices() {
    var api = catalog();
    var films = $('rwfb-film-choices');
    var glass = $('rwfb-glass-choices');
    var place = $('rwfb-place');
    if (!api || !films || !glass || !place) return;
    films.replaceChildren();
    api.FILMS.forEach(function (film) {
      var help = film.nightPrivacy ? api.NIGHT_PRIVACY_NOTE : film.summary;
      var fieldset = choice('rwfb-film', film.id, film.name, help);
      if (film.id === state.filmId) fieldset.querySelector('input').checked = true;
      films.appendChild(fieldset);
    });
    glass.replaceChildren();
    api.GLASS_TYPES.forEach(function (item) {
      var help = item.id === 'rwf_glass_unknown'
        ? 'An acceptable answer. It does not confirm compatibility.'
        : 'Recorded only. It does not confirm compatibility.';
      glass.appendChild(choice('rwfb-glass', item.id, item.label, help));
    });
    place.replaceChildren();
    var floor = document.createElement('input');
    floor.id = 'rwfb-floor';
    floor.autocomplete = 'off';
    var access = document.createElement('input');
    access.id = 'rwfb-access';
    access.autocomplete = 'off';
    place.appendChild(field('Floor', floor));
    place.appendChild(field('Access', access));
    var accessHelp = document.createElement('p');
    accessHelp.textContent = 'For example, ground, stairs, or an elevator. This note does not add a travel charge.';
    place.appendChild(accessHelp);
    renderRows([{ quantity: '', width: '', height: '', unit: '' }]);
    var fromLink = api.selectionFromSearch(root.location.search || '');
    var note = $('rwfb-url-note');
    if (note && fromLink.ignoredOfferKeys.length) {
      note.hidden = false;
      note.textContent = 'A price or booking switch in the link was ignored.';
    }
  }

  function adoptFields() {
    ['f-first', 'f-last', 'f-phone', 'f-email', 'f-addr'].forEach(function (id) {
      moveField(id, $('rwfb-contact-slot'));
    });
    var sms = $('booking-sms-consent');
    if (sms) sms.hidden = true;
    var date = $('f-date');
    if (date) date.disabled = true;
  }

  function hideDetailing() {
    document.querySelectorAll('#bk-ov .bsec').forEach(function (panel) {
      panel.classList.remove('on');
      panel.hidden = true;
    });
    var progress = $('bprog');
    if (progress) progress.hidden = true;
    var modal = $('bk-ov');
    if (modal) modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    root.submitBooking = function () {
      return Promise.resolve({ ok: false, error: 'residential_window_film_disabled', bookingCreated: false });
    };
    root.closeBooking = function () {
      if (typeof root.forceCloseBooking === 'function') root.forceCloseBooking();
    };
  }

  function bind() {
    var shell = $('rwf-book');
    if (!shell) return;
    shell.addEventListener('click', function (event) {
      if (event.target.closest('[data-rwfb-next]')) next();
      if (event.target.closest('[data-rwfb-back]')) back();
      if (event.target.closest('[data-rwfb-repeat]')) {
        var rows = readRows();
        var card = event.target.closest('[data-rwfb-row]');
        var index = Array.prototype.indexOf.call(document.querySelectorAll('[data-rwfb-row]'), card);
        if (index >= 0) rows.splice(index + 1, 0, Object.assign({}, rows[index]));
        renderRows(rows);
        paintArea();
      }
      if (event.target.closest('[data-rwfb-remove]')) {
        var current = readRows();
        var target = event.target.closest('[data-rwfb-row]');
        var at = Array.prototype.indexOf.call(document.querySelectorAll('[data-rwfb-row]'), target);
        if (current.length > 1 && at >= 0) current.splice(at, 1);
        renderRows(current);
        paintArea();
      }
      if (event.target.id === 'rwfb-add-size') {
        var nextRows = readRows();
        nextRows.push({ quantity: '', width: '', height: '', unit: '' });
        renderRows(nextRows);
        paintArea();
      }
    });
    shell.addEventListener('input', paintArea);
    shell.addEventListener('change', paintArea);
    var finishButton = $('rwfb-finish');
    if (finishButton) finishButton.addEventListener('click', finish);
  }

  function start() {
    if (state.started || !previewRequested() || !$('bk-ov') || !catalog()) return;
    state.started = true;
    var fromLink = catalog().selectionFromSearch(root.location.search || '');
    state.filmId = fromLink.filmId || '';
    disarmResume();
    buildShell();
    fillChoices();
    adoptFields();
    hideDetailing();
    bind();
    showStep('film');
    document.documentElement.classList.add('rwf-preview-mode');
  }

  if (previewRequested()) {
    guardBrowser();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', disarmResume);
    else disarmResume();
    if ($('bk-ov')) start();
    else document.addEventListener('DOMContentLoaded', start);
  }

  root.CD1ResidentialWindowFilmPreview = {
    previewRequested: previewRequested,
    disarmResume: disarmResume,
    currentMeasure: currentMeasure,
    start: start,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
