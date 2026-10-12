/**
 * Window tint preview flow.
 * Reuses the vehicle catalog and ZIP travel table for recognition only.
 * Does not submit, store, charge, or ask the schedule for a slot.
 */
(function (root) {
  var STEPS = ['zip', 'vehicle', 'film', 'details', 'contact', 'review'];
  var STEP_LABELS = {
    zip: 'ZIP',
    vehicle: 'Vehicle',
    film: 'Film',
    details: 'Details',
    contact: 'Contact',
    review: 'Review',
  };
  var state = {
    step: 'zip',
    filmId: '',
    finished: false,
    booted: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function catalog() {
    return root.CD1WindowTintDemo;
  }

  function readField(id) {
    var el = $(id);
    return el ? String(el.value || '').trim() : '';
  }

  function selectedFilm() {
    var chosen = document.querySelector('input[name="wt-film"]:checked');
    return chosen ? chosen.value : '';
  }

  function selectedGlass() {
    return Array.prototype.map.call(
      document.querySelectorAll('input[name="wt-glass"]:checked'),
      function (el) { return el.value; }
    );
  }

  function selectedValue(name) {
    var chosen = document.querySelector('input[name="' + name + '"]:checked');
    return chosen ? chosen.value : '';
  }

  function vehicleInput() {
    return {
      make: readField('wt-make'),
      model: readField('wt-model'),
      year: readField('wt-year'),
    };
  }

  function resolvedVehicle() {
    var cars = root.CD1VehicleCatalog;
    var input = vehicleInput();
    if (!cars || !input.make || !input.model || !input.year) return null;
    var found = cars.resolveVehicle(input);
    return found && found.ok ? found : null;
  }

  function quoteInput() {
    var vehicle = resolvedVehicle();
    return {
      filmId: selectedFilm(),
      glassIds: selectedGlass(),
      removal: selectedValue('wt-removal'),
      tierKey: vehicle ? vehicle.tierKey : '',
      price: '',
      total: '',
      amountCents: '',
      durationMinutes: '',
      pkg: '',
      pkgId: '',
    };
  }

  function currentQuote() {
    return catalog().quote(quoteInput());
  }

  function statusLabel(confirmation) {
    if (confirmation === 'requested') return 'Requested — not priced';
    if (confirmation === 'rules_review') return 'Not confirmed';
    if (confirmation === 'specific_evaluation') return 'Specific evaluation';
    if (confirmation === 'needs_choice') return 'Needs a choice';
    return 'Not confirmed';
  }

  function renderTotal() {
    var host = $('wt-total');
    if (!host) return;
    var quote = currentQuote();
    var figure = quote.totalStatus === 'demo_sum' && quote.totalCents != null
      ? '$' + (quote.totalCents / 100).toFixed(2)
      : 'Not priced';
    var items = quote.lines.map(function (line) {
      return '<li><span>' + escapeHtml(line.label) + '</span><span class="wt-status">' + escapeHtml(statusLabel(line.confirmation)) + '</span></li>';
    }).join('');
    host.innerHTML = ''
      + '<h3>Demonstration total</h3>'
      + '<p class="wt-total-figure" id="wt-total-figure">' + escapeHtml(figure) + '</p>'
      + '<p class="wt-note">Vehicle size is not applied. A price in the page link is ignored. This total is not a quote and cannot be booked.</p>'
      + (items ? '<ul class="wt-lines">' + items + '</ul>' : '');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setError(message) {
    var el = $('wt-error');
    if (el) el.textContent = message || '';
  }

  function validate(step) {
    if (step === 'zip') {
      if (!/^\d{5}$/.test(readField('wt-zip'))) return 'Enter a 5-digit ZIP code.';
      return '';
    }
    if (step === 'vehicle') {
      var input = vehicleInput();
      if (!input.make || !input.model || !input.year) return 'Choose the vehicle make, model, and year.';
      if (!root.CD1VehicleCatalog) return 'The vehicle catalog did not load.';
      if (!resolvedVehicle()) return 'Choose a vehicle from the catalog.';
      return '';
    }
    if (step === 'film') {
      if (!selectedFilm()) return 'Choose Carbon, Ceramic, or Help me choose.';
      if (!selectedGlass().length) return 'Choose the glass to include, or mark that you are not sure.';
      return '';
    }
    if (step === 'details') {
      if (!readField('wt-state')) return 'Choose the state where the vehicle is registered.';
      if (!selectedValue('wt-removal')) return 'Tell us whether existing film needs to come off.';
      return '';
    }
    if (step === 'contact') {
      if (!readField('wt-first') || !readField('wt-last')) return 'Enter a first and last name.';
      var phone = readField('wt-phone').replace(/\D/g, '');
      if (phone.length < 10) return 'Enter a phone number.';
      if (!/^\S+@\S+\.\S+$/.test(readField('wt-email'))) return 'Enter an email address.';
      if (readField('wt-address').length < 5) return 'Enter the service address.';
      if (!selectedValue('wt-contact')) return 'Choose how you prefer to be contacted.';
      if (!selectedValue('wt-payment')) return 'Choose a payment preference to see it in the demonstration.';
      return '';
    }
    return '';
  }

  function validateThrough(step) {
    var index = STEPS.indexOf(step);
    for (var i = 0; i < index; i += 1) {
      var message = validate(STEPS[i]);
      if (message) return { step: STEPS[i], message: message };
    }
    return null;
  }

  function showStep(step, focusHeading) {
    state.step = step;
    STEPS.forEach(function (name) {
      var panel = document.querySelector('[data-wt-step="' + name + '"]');
      if (panel) panel.hidden = name !== step;
      var tab = document.querySelector('[data-wt-tab="' + name + '"]');
      if (tab) {
        if (name === step) tab.setAttribute('aria-current', 'step');
        else tab.removeAttribute('aria-current');
      }
    });
    renderVehicleRecap();
    renderPaymentHelp();
    renderTotal();
    if (!focusHeading) return;
    var heading = document.querySelector('[data-wt-step="' + step + '"] h3');
    if (heading) heading.focus();
  }

  function go(step) {
    var blocked = validateThrough(step);
    if (blocked) {
      showStep(blocked.step, true);
      setError(blocked.message);
      return;
    }
    setError('');
    showStep(step, true);
  }

  function next() {
    var message = validate(state.step);
    if (message) {
      setError(message);
      return;
    }
    setError('');
    var index = STEPS.indexOf(state.step);
    if (index < STEPS.length - 1) showStep(STEPS[index + 1], true);
  }

  function back() {
    setError('');
    var index = STEPS.indexOf(state.step);
    if (index > 0) showStep(STEPS[index - 1], true);
  }

  function fillMakes() {
    var select = $('wt-make');
    var cars = root.CD1VehicleCatalog;
    if (!select || !cars) return;
    var current = select.value;
    select.innerHTML = '<option value="">Select a make</option>';
    cars.getMakes().forEach(function (make) {
      var option = document.createElement('option');
      option.value = make;
      option.textContent = make;
      select.appendChild(option);
    });
    select.value = current;
  }

  function fillModels() {
    var select = $('wt-model');
    var cars = root.CD1VehicleCatalog;
    if (!select || !cars) return;
    var make = readField('wt-make');
    select.innerHTML = '<option value="">Select a model</option>';
    select.disabled = !make;
    if (!make) return;
    cars.modelsForMake(make).forEach(function (model) {
      var option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    });
  }

  function fillYears() {
    var select = $('wt-year');
    if (!select) return;
    var policy = (root.CD1_CARS_VEHICLE_CATALOG && root.CD1_CARS_VEHICLE_CATALOG.yearPolicy) || {};
    var min = Number(policy.selectableMin) || 1990;
    var max = Number(policy.selectableMax) || 2027;
    var current = select.value;
    select.innerHTML = '<option value="">Select a year</option>';
    select.disabled = !readField('wt-model');
    if (select.disabled) return;
    for (var year = max; year >= min; year -= 1) {
      var option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      select.appendChild(option);
    }
    if (current) select.value = current;
  }

  function renderVehicleNote() {
    var note = $('wt-vehicle-note');
    if (!note) return;
    var vehicle = resolvedVehicle();
    if (!vehicle) {
      note.textContent = 'The size class from the vehicle catalog is recorded and is not used to price window tint.';
      return;
    }
    var label = vehicle.displayLabel || 'On file';
    note.textContent = 'Catalog size: ' + label + '. This size does not change the window tint total.';
  }

  function renderVehicleRecap() {
    var recap = $('wt-vehicle-recap');
    if (!recap) return;
    var input = vehicleInput();
    if (!input.make) {
      recap.textContent = 'Vehicle details appear here after the vehicle step.';
      return;
    }
    recap.textContent = [input.year, input.make, input.model].filter(Boolean).join(' ');
  }

  function renderZipNote() {
    var note = $('wt-zip-note');
    if (!note) return;
    var zip = readField('wt-zip');
    if (!/^\d{5}$/.test(zip)) {
      note.textContent = 'Use the same 5-digit ZIP as the detailing form. Travel fee is not added to window tint.';
      return;
    }
    var travel = root.CD1Travel;
    if (!travel || typeof travel.estimateMilesForZip !== 'function') {
      note.textContent = 'ZIP length is checked. The travel table did not load, and no travel fee is added.';
      return;
    }
    var miles = travel.estimateMilesForZip(zip);
    if (miles == null) {
      note.textContent = 'This ZIP is not in the detailing travel table. You can continue the demonstration. A visit to this address is not promised, and no travel fee is added.';
    } else {
      note.textContent = 'This ZIP is in the detailing travel table. The travel fee is not added to the window tint total.';
    }
  }

  function renderPaymentHelp() {
    var help = $('wt-payment-help');
    if (!help) return;
    var choice = selectedValue('wt-payment');
    if (choice === 'online_after_service') {
      help.textContent = 'Card online is one of the detailing choices. Saving a card is not available in this preview, and nothing is charged.';
    } else if (choice === 'card_onsite') {
      help.textContent = 'Card at service is one of the detailing choices. This preview does not collect a card.';
    } else if (choice === 'cash_onsite') {
      help.textContent = 'Cash at service is one of the detailing choices. This preview does not collect payment.';
    } else {
      help.textContent = 'These are the detailing payment choices. None of them can charge a card from this preview.';
    }
  }

  function fillStates() {
    var select = $('wt-state');
    var demo = catalog();
    if (!select || !demo) return;
    demo.REGISTRATION_STATES.forEach(function (row) {
      var option = document.createElement('option');
      option.value = row[0];
      option.textContent = row[1];
      select.appendChild(option);
    });
  }

  function applyUrlSelection() {
    var demo = catalog();
    var selection = demo.selectionFromSearch(root.location ? root.location.search : '');
    var note = $('wt-url-note');
    if (note) {
      note.hidden = selection.ignoredPriceKeys.length === 0;
      note.textContent = selection.ignoredPriceKeys.length
        ? 'A price in the page link was ignored.'
        : '';
    }
    if (!selection.filmId) return;
    state.filmId = selection.filmId;
    var radio = document.querySelector('input[name="wt-film"][value="' + selection.filmId + '"]');
    if (radio) radio.checked = true;
  }

  function selectFilm(filmId) {
    state.filmId = filmId;
    var radio = document.querySelector('input[name="wt-film"][value="' + filmId + '"]');
    if (radio) radio.checked = true;
    renderTotal();
    var quote = $('quote');
    if (quote && quote.scrollIntoView) quote.scrollIntoView();
  }

  function finish() {
    var blocked = validateThrough('review');
    if (blocked) {
      showStep(blocked.step, true);
      setError(blocked.message);
      return;
    }
    var message = validate('contact');
    if (message) {
      showStep('contact', true);
      setError(message);
      return;
    }
    setError('');
    showStep('review', true);
    var quote = currentQuote();
    var vehicle = vehicleInput();
    var result = $('wt-demo-result');
    if (!result) return;
    var lines = quote.lines.map(function (line) {
      return '<li><span>' + escapeHtml(line.label) + '</span><span class="wt-status">' + escapeHtml(statusLabel(line.confirmation)) + '</span></li>';
    }).join('');
    result.hidden = false;
    result.innerHTML = ''
      + '<h3>Demonstration only</h3>'
      + '<p>Nothing was sent, and no quote or appointment was created.</p>'
      + '<p>' + escapeHtml([vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' '))
      + ' · ZIP ' + escapeHtml(readField('wt-zip'))
      + ' · Registered in ' + escapeHtml(readField('wt-state')) + '</p>'
      + '<p>Total: ' + (quote.totalCents == null ? 'Not priced' : escapeHtml(String(quote.totalCents))) + '. No date was offered. No card was saved and no payment was collected.</p>'
      + '<ul class="wt-lines">' + lines + '</ul>';
    state.finished = true;
  }

  function onSubmit(event) {
    if (event) event.preventDefault();
    return false;
  }

  function bind() {
    var form = $('wt-quote');
    if (form) form.addEventListener('submit', onSubmit);
    document.querySelectorAll('[data-wt-next]').forEach(function (button) {
      button.addEventListener('click', next);
    });
    document.querySelectorAll('[data-wt-back]').forEach(function (button) {
      button.addEventListener('click', back);
    });
    document.querySelectorAll('[data-wt-tab]').forEach(function (button) {
      button.addEventListener('click', function () {
        go(button.getAttribute('data-wt-tab'));
      });
    });
    document.querySelectorAll('[data-wt-film]').forEach(function (button) {
      button.addEventListener('click', function () {
        selectFilm(button.getAttribute('data-wt-film'));
      });
    });
    var finishButton = $('wt-finish');
    if (finishButton) finishButton.addEventListener('click', finish);
    var zip = $('wt-zip');
    if (zip) zip.addEventListener('input', function () {
      zip.value = zip.value.replace(/\D/g, '').slice(0, 5);
      renderZipNote();
    });
    var make = $('wt-make');
    if (make) make.addEventListener('change', function () {
      fillModels();
      fillYears();
      renderVehicleNote();
      renderVehicleRecap();
    });
    var model = $('wt-model');
    if (model) model.addEventListener('change', function () {
      fillYears();
      renderVehicleNote();
      renderVehicleRecap();
    });
    var year = $('wt-year');
    if (year) year.addEventListener('change', function () {
      renderVehicleNote();
      renderVehicleRecap();
    });
    document.querySelectorAll('input[name="wt-film"], input[name="wt-glass"], input[name="wt-removal"], input[name="wt-payment"]').forEach(function (input) {
      input.addEventListener('change', function () {
        renderTotal();
        renderPaymentHelp();
      });
    });
  }

  function init() {
    fillStates();
    fillMakes();
    fillModels();
    fillYears();
    applyUrlSelection();
    bind();
    renderZipNote();
    renderVehicleNote();
    renderPaymentHelp();
    renderTotal();
    showStep('zip');
  }

  root.CD1WindowTintPreview = {
    init: init,
    quoteInput: quoteInput,
    currentQuote: currentQuote,
    showStep: showStep,
  };

  function boot() {
    if (state.booted) return;
    state.booted = true;
    init();
  }

  // The quote form is already in the document when this file is loaded at the
  // end of the page. jsdom can leave readyState at "loading" after parse, so
  // waiting only for DOMContentLoaded would skip the preview.
  if (document.getElementById('wt-quote')) boot();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
