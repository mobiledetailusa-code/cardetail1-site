/**
 * Window tint inside the existing booking form.
 * Active only for ?wtpreview=1. Reuses ZIP, vehicle, contact, and address
 * fields. Does not write cd1_* storage, consult the live schedule, or
 * create a Stripe charge.
 */
(function (root) {
  var STEPS = ['zip', 'vehicle', 'tint', 'contact', 'schedule', 'pay', 'review'];
  var state = {
    step: 'zip',
    filmId: '',
    coverageId: '',
    timeId: '',
    payment: '',
    started: false,
    disarmed: false,
  };

  function catalog() {
    return root.CD1WindowTintDemo;
  }

  function previewRequested() {
    try {
      return new URLSearchParams(root.location.search || '').get('wtpreview') === '1';
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
      if (!store || store.__wtPreviewGuarded) return;
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
      store.__wtPreviewGuarded = true;
    });
    if (typeof root.fetch === 'function' && !root.fetch.__wtPreviewGuarded) {
      var origFetch = root.fetch.bind(root);
      var blocked = /submit-booking|booking-availability|create-setup-intent|create-payment|ceramic-checkout|customer-balance-payment|welcome-lead|revenue-event|submit-inquiry|api\.stripe\.com|googletagmanager|google-analytics|gtag/i;
      var guarded = function (url) {
        var href = String((url && url.url) || url || '');
        if (blocked.test(href)) {
          var body = {
            ok: false,
            error: 'window_tint_preview_blocked',
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
      guarded.__wtPreviewGuarded = true;
      root.fetch = guarded;
    }
    root.gtag = function () {};
    if (document.createElement && !document.createElement.__wtPreviewGuarded) {
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
      guardedCreate.__wtPreviewGuarded = true;
      document.createElement = guardedCreate;
    }
  }

  function disarmResume() {
    var progress = root.CD1BookingProgress;
    if (!progress || state.disarmed) return;
    state.disarmed = true;
    progress.resumeFromQuery = function () {
      return { opened: false, reason: 'window_tint_preview' };
    };
    progress.applySnapshot = function () { return false; };
    progress.persist = function () {};
  }

  function readValue(id) {
    var el = $(id);
    return el ? String(el.value || '').trim() : '';
  }

  function checkedValue(name) {
    var chosen = document.querySelector('#wt-book input[name="' + name + '"]:checked');
    return chosen ? chosen.value : '';
  }

  function extraGlass() {
    return Array.prototype.map.call(
      document.querySelectorAll('#wt-book input[name="wtb-extra"]:checked'),
      function (el) { return el.value; }
    );
  }

  function resolvedVehicle() {
    var cars = root.CD1VehicleCatalog;
    var input = {
      make: readValue('make-in'),
      model: readValue('model-sel'),
      year: readValue('year-sel'),
    };
    if (!cars || !input.make || !input.model || !input.year) return null;
    var found = cars.resolveVehicle(input);
    return found && found.ok ? found : null;
  }

  function currentQuote() {
    var api = catalog();
    var vehicle = resolvedVehicle();
    if (!api) return null;
    return api.quote({
      filmId: checkedValue('wtb-film') || state.filmId,
      coverageId: checkedValue('wtb-coverage') || state.coverageId,
      extraGlassIds: extraGlass(),
      removal: checkedValue('wtb-removal'),
      make: readValue('make-in'),
      model: readValue('model-sel'),
      year: readValue('year-sel'),
      displayClass: vehicle ? (vehicle.displayClass || vehicle.body || '') : '',
      tierKey: vehicle ? vehicle.tierKey : '',
      price: '',
      total: '',
      amountCents: '',
      durationMinutes: '',
      pkg: '',
      pkgId: '',
    });
  }

  function money(quote) {
    var api = catalog();
    if (!quote || !api) return 'Evaluation pending';
    if (quote.totalStatus === 'needs_vehicle') return 'Vehicle still needed';
    if (quote.totalCents == null) return 'Evaluation pending';
    return api.formatDollars(quote.totalCents);
  }

  function paintTotal() {
    var host = $('wtb-total');
    var quote = currentQuote();
    var api = catalog();
    if (!host || !quote || !api) return;
    host.replaceChildren();
    var kicker = document.createElement('p');
    kicker.className = 'wtb-kicker';
    kicker.textContent = api.DEMO_PRICE_LABEL;
    var figure = document.createElement('p');
    figure.className = 'wtb-figure';
    figure.id = 'wtb-total-figure';
    figure.textContent = money(quote);
    var detail = document.createElement('p');
    detail.textContent = [quote.filmName, quote.coverageLabel].filter(Boolean).join(' · ');
    host.appendChild(kicker);
    host.appendChild(figure);
    if (detail.textContent) host.appendChild(detail);
    if (quote.totalStatus === 'demo_priced' && quote.demoDurationMinutes) {
      var duration = document.createElement('p');
      duration.textContent = 'Demo duration: ' + (quote.demoDurationMinutes / 60) + ' hours. Commercial duration is not set.';
      host.appendChild(duration);
    } else if (quote.totalStatus === 'evaluation_pending') {
      var pending = document.createElement('p');
      pending.textContent = 'No price is confirmed, and no time is confirmed.';
      host.appendChild(pending);
    }
    paintGlass(quote);
  }

  function glassBlock(title, items) {
    var wrap = document.createElement('div');
    var heading = document.createElement('h3');
    heading.textContent = title;
    var list = document.createElement('ul');
    if (!items.length) {
      var empty = document.createElement('li');
      empty.textContent = 'None';
      list.appendChild(empty);
    } else {
      items.forEach(function (item) {
        var li = document.createElement('li');
        li.textContent = item.label;
        list.appendChild(li);
      });
    }
    wrap.appendChild(heading);
    wrap.appendChild(list);
    return wrap;
  }

  function paintGlass(quote) {
    var host = $('wtb-glass');
    if (!host || !quote) return;
    host.replaceChildren(
      glassBlock('Included', quote.includedGlass),
      glassBlock('Not included', quote.excludedGlass),
      glassBlock('Pending evaluation', quote.pendingGlass)
    );
  }

  function showError(message) {
    var el = $('wtb-error');
    if (!el) return;
    el.textContent = message || '';
  }

  function showStep(step) {
    state.step = step;
    document.querySelectorAll('#wt-book [data-wtb-step]').forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-wtb-step') !== step;
    });
    document.querySelectorAll('#wt-book [data-wtb-tab]').forEach(function (tab) {
      var on = tab.getAttribute('data-wtb-tab') === step;
      tab.setAttribute('aria-current', on ? 'step' : 'false');
    });
    paintTotal();
    if (step === 'schedule') paintSchedule();
    if (step === 'review') paintReview();
    var heading = document.querySelector('#wt-book [data-wtb-step="' + step + '"] h2');
    if (heading) heading.focus();
  }

  function zipNote() {
    var note = $('wtb-zip-note');
    var travel = root.CD1Travel;
    var zip = readValue('bk-zip').replace(/\D/g, '').slice(0, 5);
    if (!note) return;
    if (zip.length < 5) {
      note.textContent = 'A ZIP code does not show that a film shade is allowed.';
      return;
    }
    var miles = travel && travel.estimateMilesForZip ? travel.estimateMilesForZip(zip) : null;
    note.textContent = miles == null
      ? 'This ZIP is outside the current detailing radius. Window tint travel is not decided, and it is not added to the demo total.'
      : 'ZIP recognized. Travel is not added to the window tint total, and the ZIP does not confirm a legal shade.';
  }

  function vehicleNote() {
    var note = $('wtb-vehicle-note');
    var vehicle = resolvedVehicle();
    if (!note) return;
    if (!vehicle) {
      note.textContent = 'Choose a make, model, and year. The detailing size multiplier is not used.';
      paintTotal();
      return;
    }
    var group = catalog().vehicleGroupFor(vehicle);
    var label = vehicle.displayLabel || vehicle.tierKey || 'Vehicle';
    note.textContent = group
      ? ('Catalog size: ' + label + '. This picks the demo row only. It does not change the price by a detailing multiplier.')
      : ('Catalog size: ' + label + '. This glass configuration is not in the demo rows, so the total stays pending evaluation.');
    paintTotal();
  }

  function validate(step) {
    if (step === 'zip') {
      if (readValue('bk-zip').replace(/\D/g, '').length < 5) return 'Enter a 5-digit ZIP code.';
    }
    if (step === 'vehicle') {
      if (!resolvedVehicle()) return 'Choose a make, model, and year from the catalog.';
    }
    if (step === 'tint') {
      if (!checkedValue('wtb-film')) return 'Choose a film.';
      if (!checkedValue('wtb-coverage')) return 'Choose a coverage.';
      if (!readValue('wtb-state')) return 'Choose the state of registration.';
      if (!checkedValue('wtb-removal')) return 'Say whether film has to come off.';
    }
    if (step === 'contact') {
      if (!readValue('f-first') || !readValue('f-last')) return 'Enter a first and last name.';
      if (readValue('f-phone').replace(/\D/g, '').length < 7) return 'Enter a phone number.';
      if (readValue('f-email').indexOf('@') === -1) return 'Enter an email address.';
      if (!readValue('f-addr')) return 'Enter a service address.';
    }
    if (step === 'schedule') {
      var quote = currentQuote();
      if (quote && quote.fictionalWindows.length && !checkedValue('wtb-time')) {
        return 'Choose a demo time. It is not a real opening.';
      }
    }
    if (step === 'pay') {
      if (!checkedValue('wtb-pay')) return 'Choose a payment preference.';
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
    if (index < STEPS.length - 1) go(STEPS[index + 1]);
  }

  function back() {
    var index = STEPS.indexOf(state.step);
    if (index > 0) go(STEPS[index - 1]);
  }

  function choice(name, value, title, detail) {
    var label = document.createElement('label');
    label.className = 'wtb-choice';
    var input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    var strong = document.createElement('strong');
    strong.textContent = title;
    label.appendChild(input);
    label.appendChild(strong);
    if (detail) {
      var small = document.createElement('small');
      small.textContent = detail;
      label.appendChild(small);
    }
    return label;
  }

  function checkbox(value, title, detail) {
    var label = document.createElement('label');
    label.className = 'wtb-choice';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'wtb-extra';
    input.value = value;
    var strong = document.createElement('strong');
    strong.textContent = title;
    var small = document.createElement('small');
    small.textContent = detail;
    label.appendChild(input);
    label.appendChild(strong);
    label.appendChild(small);
    return label;
  }

  function moveField(id, slot) {
    var el = $(id);
    if (!el || !slot) return;
    var parent = el.closest ? el.closest('.fg') : null;
    slot.appendChild(parent || el);
  }

  function paintSchedule() {
    var host = $('wtb-schedule');
    var quote = currentQuote();
    if (!host || !quote) return;
    var selected = checkedValue('wtb-time');
    host.replaceChildren();
    var title = document.createElement('h2');
    title.tabIndex = -1;
    title.textContent = 'Demo schedule';
    host.appendChild(title);
    var copy = document.createElement('p');
    if (!quote.fictionalWindows.length) {
      copy.textContent = 'Evaluation pending. No time is confirmed. This preview does not check or hold a detailing appointment.';
      host.appendChild(copy);
      return;
    }
    copy.textContent = 'These times are fictional. Demo duration is ' + (quote.demoDurationMinutes / 60) + ' hours. Commercial duration is not set. The prepared installer resource is ' + quote.preparedResourceId + '. Detailing slots are not used.';
    host.appendChild(copy);
    quote.fictionalWindows.forEach(function (windowOption) {
      var field = choice('wtb-time', windowOption.id, windowOption.label, '');
      if (windowOption.id === selected || windowOption.id === state.timeId) {
        field.querySelector('input').checked = true;
      }
      host.appendChild(field);
    });
  }

  function paintReview() {
    var host = $('wtb-review-body');
    var quote = currentQuote();
    var api = catalog();
    if (!host || !quote || !api) return;
    var vehicle = resolvedVehicle();
    var removal = api.REMOVAL.find(function (item) { return item.id === checkedValue('wtb-removal'); });
    var timeInput = document.querySelector('#wt-book input[name="wtb-time"]:checked');
    var timeLabel = timeInput && timeInput.parentElement.querySelector('strong')
      ? timeInput.parentElement.querySelector('strong').textContent
      : '';
    var payLabels = {
      online_after_service: 'Card online — charged after service',
      card_onsite: 'Card at service',
      cash_onsite: 'Cash at service',
    };
    var lines = [
      vehicle ? (readValue('year-sel') + ' ' + readValue('make-in') + ' ' + readValue('model-sel')) : '',
      quote.filmName,
      quote.coverageLabel,
      'Registration state: ' + (readValue('wtb-state') || 'Not chosen'),
      'Existing film: ' + (removal ? removal.label : 'Not answered'),
      api.DEMO_PRICE_LABEL + ': ' + money(quote),
      quote.scheduleStatus === 'demo_fictional'
        ? ('Demo time: ' + (timeLabel || 'Not chosen'))
        : 'Evaluation pending. No time is confirmed.',
      'Payment preference: ' + (payLabels[checkedValue('wtb-pay')] || 'Not chosen') + '. No card is collected.',
    ].filter(Boolean);
    host.replaceChildren();
    lines.forEach(function (text) {
      var p = document.createElement('p');
      p.textContent = text;
      host.appendChild(p);
    });
    host.appendChild(glassBlock('Included', quote.includedGlass));
    host.appendChild(glassBlock('Not included', quote.excludedGlass));
    host.appendChild(glassBlock('Pending evaluation', quote.pendingGlass));
  }

  function finish() {
    var message = validate('pay');
    if (message) {
      showError(message);
      go('pay');
      return;
    }
    var quote = currentQuote();
    var result = $('wtb-result');
    if (!result || !quote) return;
    result.hidden = false;
    result.replaceChildren();
    var title = document.createElement('h2');
    title.textContent = 'Demo completed. No appointment was created.';
    var price = document.createElement('p');
    price.textContent = catalog().DEMO_PRICE_LABEL + '. ' + money(quote) + '.';
    var card = document.createElement('p');
    card.textContent = 'No card was saved and no payment was collected.';
    var quiet = document.createElement('p');
    quiet.textContent = 'No message was sent. Window tint was not added to a detailing appointment.';
    result.appendChild(title);
    result.appendChild(price);
    result.appendChild(card);
    result.appendChild(quiet);
    if (quote.scheduleStatus !== 'demo_fictional') {
      var evalNote = document.createElement('p');
      evalNote.textContent = 'Evaluation pending. No time is confirmed.';
      result.appendChild(evalNote);
    }
    var finishButton = $('wtb-finish');
    if (finishButton) finishButton.disabled = true;
  }

  function buildShell() {
    var content = document.querySelector('#bk-ov .bcontent');
    if (!content || $('wt-book')) return;
    var shell = document.createElement('div');
    shell.id = 'wt-book';
    shell.innerHTML = ''
      + '<p class="wtb-banner">Window tint preview. Demo pricing — not available for booking.</p>'
      + '<ol class="wtb-progress">'
      + STEPS.map(function (step) {
        return '<li><button type="button" data-wtb-tab="' + step + '">' + step + '</button></li>';
      }).join('')
      + '</ol>'
      + '<div class="wtb-total" id="wtb-total" aria-live="polite"></div>'
      + '<p class="wtb-error" id="wtb-error" role="alert"></p>'
      + '<section data-wtb-step="zip"><h2 tabindex="-1">ZIP code</h2><p>Same ZIP field the detailing form uses. A ZIP code does not show that a film shade is allowed, and it does not add a travel charge to this preview.</p><div id="wtb-zip-slot"></div><p id="wtb-zip-note"></p><div class="wtb-row"><button type="button" data-wtb-next>Continue</button></div></section>'
      + '<section data-wtb-step="vehicle" hidden><h2 tabindex="-1">Vehicle</h2><p>Make, model, and year come from the current catalog. This choice is kept for the rest of the preview.</p><div id="wtb-vehicle-slot"></div><p id="wtb-vehicle-note"></p><div class="wtb-row"><button type="button" data-wtb-back>Back</button><button type="button" data-wtb-next>Continue</button></div></section>'
      + '<section data-wtb-step="tint" hidden><h2 tabindex="-1">Film and coverage</h2><p id="wtb-url-note" hidden></p><div id="wtb-film-choices"></div><div id="wtb-coverage-choices"></div><label class="wtb-field"><span>State of registration</span><select id="wtb-state"></select></label><p>The registration state is saved for review. It does not prove that a shade is allowed. This preview does not collect medical documents.</p><div id="wtb-removal-choices"></div><div id="wtb-extra-choices"></div><div id="wtb-glass"></div><div class="wtb-row"><button type="button" data-wtb-back>Back</button><button type="button" data-wtb-next>Continue</button></div></section>'
      + '<section data-wtb-step="contact" hidden><h2 tabindex="-1">Contact and address</h2><p>These are the detailing contact and address fields. Nothing is texted, emailed, or stored as a lead.</p><div id="wtb-contact-slot"></div><div class="wtb-row"><button type="button" data-wtb-back>Back</button><button type="button" data-wtb-next>Continue</button></div></section>'
      + '<section data-wtb-step="schedule" hidden><div id="wtb-schedule"></div><div class="wtb-row"><button type="button" data-wtb-back>Back</button><button type="button" data-wtb-next>Continue</button></div></section>'
      + '<section data-wtb-step="pay" hidden><h2 tabindex="-1">Payment preference</h2><p>Same three choices as the detailing form. No card field is shown, no card is saved, and no payment is created.</p><div id="wtb-pay-choices"></div><p id="wtb-pay-help"></p><div class="wtb-row"><button type="button" data-wtb-back>Back</button><button type="button" data-wtb-next>Review</button></div></section>'
      + '<section data-wtb-step="review" hidden><h2 tabindex="-1">Review</h2><div id="wtb-review-body"></div><div class="wtb-row"><button type="button" data-wtb-back>Back</button><button type="button" id="wtb-finish">Finish preview</button></div><div id="wtb-result" role="status" hidden></div></section>';
    content.appendChild(shell);
    var style = document.createElement('style');
    style.textContent = ''
      + '#wt-book{color:var(--tx,#c8d0da);font-family:var(--fb,"DM Sans",sans-serif)}'
      + '#wt-book h2{font-family:var(--fd,"Bebas Neue",sans-serif);font-weight:400;letter-spacing:.03em;color:var(--ink,#ece8e1);font-size:32px;margin:0 0 8px}'
      + '#wt-book .bsec{display:none!important}'
      + '.wtb-banner,.wtb-kicker{color:var(--gold,#c4a574);font-weight:700}'
      + '.wtb-progress{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;padding:0;list-style:none}'
      + '.wtb-progress button{min-height:40px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit}'
      + '.wtb-progress button[aria-current="step"]{border-color:var(--blue,#4d8fd9);color:#fff}'
      + '.wtb-total,.wtb-choice,.wtb-field select,.wtb-field input{background:#0c1218}'
      + '.wtb-total{border:1px solid rgba(196,165,116,.28);border-radius:16px;padding:14px;margin:0 0 12px}'
      + '.wtb-figure{font-family:var(--fd,"Bebas Neue",sans-serif);font-size:40px;line-height:1;color:#fff;margin:6px 0}'
      + '.wtb-choice{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;padding:12px;margin:0 0 8px;border:1px solid rgba(255,255,255,.12);border-radius:14px}'
      + '.wtb-choice small{grid-column:2;color:#b7c2d0}'
      + '.wtb-field{display:flex;flex-direction:column;gap:6px;margin:0 0 12px}'
      + '.wtb-field select,.wtb-row button,.wt-book input,.wtb-field input{min-height:48px;font:inherit}'
      + '.wtb-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}'
      + '.wtb-row button{border:0;border-radius:999px;padding:12px 16px;background:var(--blue,#4d8fd9);color:#fff;cursor:pointer}'
      + '.wtb-row [data-wtb-back]{background:transparent;border:1px solid rgba(255,255,255,.28)}'
      + '.wtb-error{color:#ffd0d0;font-weight:700;min-height:1.2em}'
      + '#wtb-result{margin-top:12px;padding:14px;border-radius:16px;border:1px solid rgba(157,222,180,.45)}'
      + 'html.wt-preview-mode #cd1-consent-banner{display:none!important}'
      + '@media(max-width:800px){#wt-book .wtb-row button{width:100%}}';
    document.head.appendChild(style);
  }

  function fillChoices() {
    var api = catalog();
    var films = $('wtb-film-choices');
    var coverages = $('wtb-coverage-choices');
    var removal = $('wtb-removal-choices');
    var extras = $('wtb-extra-choices');
    var pay = $('wtb-pay-choices');
    var states = $('wtb-state');
    if (!api || !films) return;
    films.replaceChildren();
    api.FILMS.forEach(function (film) {
      var field = choice('wtb-film', film.id, film.name, film.summary);
      if (film.id === state.filmId) field.querySelector('input').checked = true;
      films.appendChild(field);
    });
    coverages.replaceChildren();
    api.COVERAGES.forEach(function (coverage) {
      var field = choice('wtb-coverage', coverage.id, coverage.label, coverage.summary);
      if (coverage.id === state.coverageId) field.querySelector('input').checked = true;
      coverages.appendChild(field);
    });
    removal.replaceChildren();
    api.REMOVAL.forEach(function (item) {
      removal.appendChild(choice('wtb-removal', item.id, item.label, item.id === 'no' ? '' : 'Removal stays pending evaluation and has no demo price.'));
    });
    extras.replaceChildren(
      checkbox('wt_glass_front_sides', 'Also consider front side windows', 'Asking does not confirm them. The demo total becomes evaluation pending.'),
      checkbox('wt_glass_windshield', 'Also consider the windshield', 'Specific evaluation. A checkbox does not verify or confirm it.'),
      checkbox('wt_glass_roof', 'Also consider roof glass', 'Specific evaluation. A checkbox does not verify or confirm it.')
    );
    states.replaceChildren();
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Select a state';
    states.appendChild(blank);
    api.REGISTRATION_STATES.forEach(function (pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      states.appendChild(option);
    });
    pay.replaceChildren(
      choice('wtb-pay', 'online_after_service', 'Card online — charged after service', 'Shown as a choice only. No card number is requested.'),
      choice('wtb-pay', 'card_onsite', 'Card at service', 'No card is saved.'),
      choice('wtb-pay', 'cash_onsite', 'Cash at service', 'No payment is created.')
    );
    var fromLink = api.selectionFromSearch(root.location.search || '');
    var note = $('wtb-url-note');
    if (note && fromLink.ignoredPriceKeys.length) {
      note.hidden = false;
      note.textContent = 'A price in the link was ignored.';
    }
  }

  function adoptFields() {
    var zip = $('bk-zip');
    if (zip) {
      zip.removeAttribute('oninput');
      var slot = $('wtb-zip-slot');
      if (slot) slot.appendChild(zip);
      zip.addEventListener('input', zipNote);
    }
    var vehicle = $('make-search-wrap');
    var vehicleSlot = $('wtb-vehicle-slot');
    if (vehicle && vehicleSlot) vehicleSlot.appendChild(vehicle);
    ['make-in', 'model-sel', 'year-sel'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', vehicleNote);
      el.addEventListener('input', vehicleNote);
    });
    ['f-first', 'f-last', 'f-phone', 'f-email', 'f-addr'].forEach(function (id) {
      moveField(id, $('wtb-contact-slot'));
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
      return Promise.resolve({ ok: false, error: 'window_tint_disabled', bookingCreated: false });
    };
    root.closeBooking = function () {
      if (typeof root.forceCloseBooking === 'function') root.forceCloseBooking();
    };
  }

  function bind() {
    var shell = $('wt-book');
    if (!shell) return;
    shell.addEventListener('click', function (event) {
      var nextButton = event.target.closest('[data-wtb-next]');
      var backButton = event.target.closest('[data-wtb-back]');
      if (nextButton) next();
      if (backButton) back();
    });
    shell.addEventListener('change', function (event) {
      if (event.target.name === 'wtb-time') state.timeId = event.target.value;
      if (event.target.name === 'wtb-pay') {
        state.payment = event.target.value;
        var help = $('wtb-pay-help');
        if (help) help.textContent = 'This preference is not available as a charge in this preview.';
      }
      paintTotal();
    });
    var finishButton = $('wtb-finish');
    if (finishButton) finishButton.addEventListener('click', finish);
  }

  function start() {
    if (state.started || !previewRequested() || !$('bk-ov') || !catalog()) return;
    state.started = true;
    var fromLink = catalog().selectionFromSearch(root.location.search || '');
    state.filmId = fromLink.filmId || '';
    state.coverageId = fromLink.coverageId || '';
    disarmResume();
    buildShell();
    fillChoices();
    adoptFields();
    hideDetailing();
    bind();
    zipNote();
    showStep('zip');
    document.documentElement.classList.add('wt-preview-mode');
  }

  if (previewRequested()) {
    guardBrowser();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', disarmResume);
    else disarmResume();
    if ($('bk-ov')) start();
    else document.addEventListener('DOMContentLoaded', start);
  }

  root.CD1WindowTintBookingPreview = {
    previewRequested: previewRequested,
    disarmResume: disarmResume,
    currentQuote: currentQuote,
    start: start,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
