/**
 * Public Ceramic Coating booking UI.
 * Display prices come from the page PRICING block, which is synced from the
 * server catalog. Checkout still rejects any total the server does not recompute.
 */
(function (global) {
  'use strict';

  var CERAMIC_PACKAGES = {
    ceramic_1yr: true,
    ceramic_3yr: true
  };
  var CERAMIC_ONLY = {
    ceramic_windshield: true,
    ceramic_glass_all: true,
    ceramic_wheels: true,
    ceramic_trim: true,
    ceramic_lights: true,
    ceramic_correction: true,
    ceramic_waterspot: true,
    ceramic_contamination: true
  };
  var GLOBAL_IDS = {
    engine_bay: true,
    undercarriage: true,
    mobile_water: true,
    heavymud: true
  };
  var GLOBAL_PACKAGES = {
    wash: true,
    refresh: true,
    full: true,
    premium: true,
    ceramic_1yr: true,
    ceramic_3yr: true
  };
  var INTERIOR_IDS = {
    pethair: true,
    odor: true,
    superint: true,
    mold: true,
    sanitize: true,
    biohazard: true,
    floormats: true,
    babyseat: true,
    stroller: true
  };
  var EXTERIOR_PROTECTION = {
    wax1yr: true,
    polymer: true,
    claybar: true
  };
  var GLASS_IDS = {
    rainx: true,
    ceramic_windshield: true,
    ceramic_glass_all: true
  };
  var WATER_REPELLENT = {
    id: 'rainx',
    name: 'Windshield Water-Repellent Treatment',
    description: 'Hydrophobic windshield treatment that improves water beading and visibility. This is not a ceramic coating.',
    minutes: 15
  };
  var INTERIOR_SERVICE_MINUTES = 120;
  var CATALOG_ERROR = 'Some options are unavailable because their prices could not be confirmed.';
  var addonCatalog = null;
  var addonCatalogSource = null;
  var unresolvedIds = [];
  var catalogBlocked = false;
  var EXTENDED_APPOINTMENT_MESSAGE = 'Extended appointment: this service requires multiple service days. All dates will be reserved before payment.';
  var ADDON_MINUTES = {
    rainx: 15,
    ceramic_windshield: 30,
    ceramic_glass_all: 60,
    ceramic_wheels: 60,
    ceramic_trim: 45,
    ceramic_lights: 20,
    ceramic_correction: 120,
    ceramic_waterspot: 60,
    ceramic_contamination: 60,
    engine_bay: 45,
    undercarriage: 45,
    pethair: 45,
    odor: 30,
    superint: 60,
    sanitize: 20,
    mold: 45,
    biohazard: 60,
    floormats: 15,
    babyseat: 20,
    stroller: 20
  };
  var INTERIOR_DESCRIPTION = 'Add a complete interior cleaning to the same appointment, including vacuuming, shampoo/extraction where appropriate, steam cleaning, surface cleaning, UV protection, door jambs and cargo area.';
  var BAND = {
    small: 'compact',
    suv2: 'crossover',
    suv3: 'large',
    truck: 'large',
    compact_van: 'large',
    midsize_van: 'large',
    full_size_van_passenger: 'oversized'
  };
  var SIZE_PRICE = {
    ceramic_waterspot: { compact: 125, crossover: 175, large: 225, oversized: 250 },
    ceramic_contamination: { compact: 100, crossover: 150, large: 200, oversized: 250 },
    undercarriage: { compact: 125, crossover: 150, large: 175, oversized: 225 }
  };

  function isCeramicPackage(id) {
    return !!CERAMIC_PACKAGES[id];
  }

  function bandFor(tierKey) {
    return BAND[tierKey] || null;
  }

  function displayPrice(addon, tierKey) {
    var table = SIZE_PRICE[addon.id];
    var band = bandFor(tierKey);
    if (table && band && table[band] != null) return table[band];
    return addon.price;
  }

  function addonVisible(addon, state) {
    if (!addon) return false;
    var id = addon.id;
    var pkg = state && state.pkgId;
    if (CERAMIC_ONLY[id]) return isCeramicPackage(pkg);
    if (GLOBAL_IDS[id]) return !!GLOBAL_PACKAGES[pkg];
    if (id === 'engine' && isCeramicPackage(pkg)) return false;
    if (isCeramicPackage(pkg) && EXTERIOR_PROTECTION[id]) return false;
    if (id === 'rainx') return true;
    if (INTERIOR_IDS[id]) {
      if (!isCeramicPackage(pkg)) return true;
      return !!(state && state.companionInterior);
    }
    if (isCeramicPackage(pkg) && !CERAMIC_ONLY[id] && !GLOBAL_IDS[id] && id !== 'engine') return false;
    return true;
  }

  function syncLiveState() {
    var lexical = null;
    try {
      if (typeof ST !== 'undefined' && ST) lexical = ST;
    } catch (err) { lexical = null; }
    if (lexical && global.ST !== lexical) global.ST = lexical;
    return global.ST || lexical;
  }

  function pageValue(name) {
    if (name === 'ST') return syncLiveState();
    if (name === 'PRICING') {
      var pricing = null;
      try {
        if (typeof PRICING !== 'undefined' && PRICING) pricing = PRICING;
      } catch (err) { pricing = null; }
      if (pricing && global.PRICING !== pricing) {
        try { global.PRICING = pricing; } catch (err2) { /* published catalog is optional */ }
      }
      return pricing || global.PRICING || null;
    }
    return global[name] == null ? null : global[name];
  }

  function interiorOffer() {
    var pricing = pageValue('PRICING');
    var state = syncLiveState();
    var tier = pricing && pricing.cars && state && pricing.cars.tiers[state.tierKey];
    var price = tier ? Number(tier.interior) : NaN;
    if (!(price > 0)) {
      noteUnresolved('interior');
      return null;
    }
    return {
      id: 'interior',
      name: 'Complete Interior Detail',
      price: price,
      minutes: INTERIOR_SERVICE_MINUTES,
      description: 'Deep interior cleaning added to the same vehicle and booking.'
    };
  }

  function interiorPrice() {
    var offer = interiorOffer();
    return offer ? offer.price : 0;
  }

  function canonicalAddons() {
    var pricing = pageValue('PRICING');
    var list = pricing && pricing.cars && pricing.cars.addons;
    if (!Array.isArray(list)) return addonCatalog;
    if (addonCatalog && addonCatalogSource === list) return addonCatalog;
    var map = Object.create(null);
    list.forEach(function (row) {
      if (!row || !row.id) return;
      var price = Number(row.price);
      var name = row.name ? String(row.name) : '';
      if (!(price > 0) || !name || name === row.id) return;
      map[row.id] = {
        id: row.id,
        name: name,
        description: String(row.desc || row.description || ''),
        price: price,
        minutes: ADDON_MINUTES[row.id] || 0
      };
    });
    if (map.rainx) {
      map.rainx = {
        id: 'rainx',
        name: WATER_REPELLENT.name,
        description: WATER_REPELLENT.description,
        price: map.rainx.price,
        minutes: WATER_REPELLENT.minutes,
        nonCeramic: true
      };
    }
    if (map.odor) map.odor.name = 'Odor Treatment';
    if (map.pethair) map.pethair.name = 'Pet Hair Removal';
    addonCatalog = map;
    addonCatalogSource = list;
    return map;
  }

  function offerPrice(row) {
    if (!row) return null;
    if (SIZE_PRICE[row.id]) {
      var sized = Number(displayPrice({ id: row.id, price: row.price }, syncLiveState() && syncLiveState().tierKey));
      if (sized > 0) return sized;
    }
    return row.price > 0 ? row.price : null;
  }

  function noteUnresolved(id) {
    if (!id || unresolvedIds.indexOf(id) >= 0) return;
    unresolvedIds.push(id);
    if (global.console && global.console.error) global.console.error('Unresolved ceramic add-on', id);
  }

  function resolveOffer(id) {
    var map = canonicalAddons();
    var row = map && map[id];
    if (!row) {
      noteUnresolved(id);
      return null;
    }
    var price = offerPrice(row);
    if (!(price > 0) || !row.name || row.name === id) {
      noteUnresolved(id);
      return null;
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      price: price,
      minutes: row.minutes || 0,
      nonCeramic: !!row.nonCeramic
    };
  }

  function companionSelected() {
    return !!(global.ST && global.ST.companionInterior && isCeramicPackage(global.ST.pkgId));
  }

  function companionDollars() {
    return companionSelected() ? interiorPrice() : 0;
  }

  function appointmentMinutes() {
    if (!global.ST || !isCeramicPackage(global.ST.pkgId)) return 0;
    var minutes = global.ST.pkgId === 'ceramic_3yr' ? 600 : 480;
    (global.ST.addons || []).forEach(function (addon) {
      var extra = ADDON_MINUTES[addon.id] || 0;
      var qty = Math.max(1, Number(addon.qty) || 1);
      minutes += extra * qty;
    });
    if (companionSelected()) minutes += INTERIOR_SERVICE_MINUTES;
    return minutes;
  }

  function depositCentsFor(totalDollars) {
    var cents = Math.round(Number(totalDollars) * 100);
    var percent = Math.round(cents * 25 / 100);
    var minimum = global.ST && global.ST.pkgId === 'ceramic_3yr' ? 25000 : 15000;
    return Math.max(percent, minimum);
  }

  function displayedServiceTotal() {
    if (!global.ST) return 0;
    var fee = typeof global.getTravelFeeAmount === 'function' ? global.getTravelFeeAmount() : 0;
    return (Number(global.ST.basePrice) || 0) + (Number(global.ST.addonTotal) || 0) + fee + companionDollars();
  }

  function questions() {
    return [
      ['repainted60', 'Has the vehicle been repainted within the last 60 days?'],
      ['clearCoatFailing', 'Is the clear coat peeling, oxidized, or failing?'],
      ['severeContamination', 'Is there cement, extensive overspray, severe sap, or extreme contamination?'],
      ['matteWrapPpf', 'Does the vehicle have matte paint, vinyl wrap, or paint-protection film?'],
      ['coveredCureArea', 'Will a covered, dry curing area be available?'],
      ['remainDry12h', 'Can the vehicle remain dry for at least 12 hours?']
    ];
  }

  function readAnswers() {
    var out = {};
    questions().forEach(function (row) {
      var el = document.querySelector('input[name="ceramic-' + row[0] + '"]:checked');
      out[row[0]] = el ? el.value : '';
    });
    return out;
  }

  function readWaterSupply() {
    var el = document.querySelector('input[name="ceramic-water"]:checked');
    return el ? el.value : '';
  }

  function readPlan() {
    var el = document.querySelector('input[name="ceramic-plan"]:checked');
    return el ? el.value : '';
  }

  function ensurePanel() {
    var host = document.getElementById('bs4');
    if (!host || document.getElementById('ceramic-panel')) return;
    var panel = document.createElement('div');
    panel.id = 'ceramic-panel';
    panel.hidden = true;
    panel.className = 'fg full';
    panel.innerHTML = [
      '<div class="fl">Ceramic Coating eligibility</div>',
      '<p class="bk-addr-hint">Normal cleaning of wheels, glass, or trim is not ceramic coating on those surfaces. Coating protects the existing finish and does not repair damaged paint.</p>',
      questions().map(function (row) {
        return '<fieldset class="ceramic-q"><legend>' + row[1] + '</legend>'
          + '<label><input type="radio" name="ceramic-' + row[0] + '" value="yes"> Yes</label> '
          + '<label><input type="radio" name="ceramic-' + row[0] + '" value="no"> No</label></fieldset>';
      }).join(''),
      '<div id="ceramic-warning" class="bk-addr-hint" hidden></div>',
      '<div id="ceramic-block" class="bk-addr-hint" hidden></div>',
      '<fieldset class="ceramic-q" id="ceramic-water-q"><legend>Undercarriage water</legend>',
      '<label><input type="radio" name="ceramic-water" value="customer"> I will provide a usable exterior water connection</label> ',
      '<label><input type="radio" name="ceramic-water" value="mobile"> Add Mobile Water Supply (+$50)</label></fieldset>',
      '<fieldset class="ceramic-q"><legend>Payment</legend>',
      '<label><input type="radio" name="ceramic-plan" value="prepay_full"> Prepay in Full</label> ',
      '<label id="ceramic-deposit-label"><input type="radio" name="ceramic-plan" value="deposit"> Reserve with Deposit</label>',
      '<p id="ceramic-pay-note" class="bk-addr-hint"></p></fieldset>'
    ].join('');
    host.appendChild(panel);
    panel.addEventListener('change', syncPanel);
  }

  function syncPanel() {
    var panel = document.getElementById('ceramic-panel');
    if (!panel || !global.ST) return;
    var on = isCeramicPackage(global.ST.pkgId);
    panel.hidden = !on;
    if (!on) return;
    var answers = readAnswers();
    var block = document.getElementById('ceramic-block');
    var warn = document.getElementById('ceramic-warning');
    var message = '';
    if (answers.repainted60 === 'yes' || answers.clearCoatFailing === 'yes' || answers.severeContamination === 'yes') {
      message = 'This vehicle is not eligible for instant Ceramic Coating. Book Paint Restoration instead. No ceramic quote will be created.';
    } else if (answers.matteWrapPpf === 'yes') {
      message = 'Matte paint, vinyl wrap, or PPF needs a compatible service. The gloss paint-coating package will not be used.';
    } else if (answers.remainDry12h === 'no') {
      message = 'Ceramic Coating needs the vehicle to stay dry for at least 12 hours.';
    }
    if (block) {
      block.hidden = !message;
      block.textContent = message;
    }
    if (warn) {
      var weather = answers.coveredCureArea === 'no';
      warn.hidden = !weather;
      warn.textContent = weather
        ? 'No covered curing space was confirmed. Scheduling is weather-dependent.'
        : '';
    }
    var note = document.getElementById('ceramic-pay-note');
    var plan = readPlan();
    var due = displayedServiceTotal();
    var deposit = (depositCentsFor(due) / 100).toFixed(2);
    if (note) {
      note.textContent = plan === 'deposit'
        ? ('Deposit $' + deposit + ' is charged now. That is 25% of the approved total, or the package minimum when that is higher. The remaining balance is collected later and is not charged automatically.')
        : (plan === 'prepay_full' ? 'The full approved total is charged now. The booking is paid only after Stripe confirms the payment.' : '');
    }
    renderCompanion();
    paintCompanionTotal();
  }

  function syncAddonPrices() {
    if (!global.ST || !global.document) return;
    var cards = document.querySelectorAll('.addon[data-id]');
    cards.forEach(function (card) {
      var id = card.getAttribute('data-id');
      if (!SIZE_PRICE[id]) return;
      var price = displayPrice({ id: id, price: Number(card.getAttribute('data-price')) }, global.ST.tierKey);
      card.setAttribute('data-price', String(price));
      var label = card.querySelector('.addon-price');
      if (label) label.textContent = '+$' + price;
    });
    if (Array.isArray(global.ST.addons)) {
      global.ST.addons.forEach(function (addon) {
        if (SIZE_PRICE[addon.id]) addon.price = displayPrice(addon, global.ST.tierKey);
      });
      if (typeof global.recalcAddonTotal === 'function') global.recalcAddonTotal();
    }
  }

  function hideIncompatibleCards() {
    syncLiveState();
    if (!global.ST) return;
    var ceramic = isCeramicPackage(global.ST.pkgId);
    var grid = document.getElementById('addon-grid');
    if (ceramic && grid) {
      grid.querySelectorAll('.addon').forEach(function (card) { card.remove(); });
      grid.hidden = true;
      grid.style.display = 'none';
    } else if (grid) {
      grid.hidden = false;
      grid.style.display = '';
      var cards = document.querySelectorAll('#addon-grid .addon[data-id]');
      cards.forEach(function (card) {
        var id = card.getAttribute('data-id');
        var show = addonVisible({ id: id }, global.ST);
        card.hidden = !show;
        card.style.display = show ? '' : 'none';
      });
    }
    syncAddonPrices();
    renderCeramicCheckout();
  }

  function wrap(name, after) {
    var fn = global[name];
    if (typeof fn !== 'function' || fn._ceramicWrapped) return;
    var wrapped = function () {
      var result = fn.apply(this, arguments);
      try { after(result); } catch (err) { /* display only */ }
      return result;
    };
    wrapped._ceramicWrapped = true;
    global[name] = wrapped;
  }

  function attachPayload(payload) {
    if (!payload || !global.ST || !isCeramicPackage(global.ST.pkgId)) return payload;
    payload.serviceFamily = 'ceramic_coating';
    payload.ceramicPaymentPlan = readPlan();
    payload.ceramicEligibility = readAnswers();
    payload.ceramicWaterSupply = readWaterSupply();
    sanitizeCeramicAddons();
    if (Array.isArray(payload.vehicles)) {
      payload.vehicles.forEach(function (vehicle) {
        if (!isCeramicPackage(vehicle.pkgId)) return;
        var glassSeen = false;
        vehicle.addons = (vehicle.addons || []).filter(function (addon) {
          if (!addon || EXTERIOR_PROTECTION[addon.id]) return false;
          if (!companionSelected() && INTERIOR_IDS[addon.id]) return false;
          if (GLASS_IDS[addon.id]) {
            if (glassSeen) return false;
            glassSeen = true;
          }
          var row = resolveOffer(addon.id);
          if (!row) return false;
          addon.name = row.name;
          addon.price = row.price;
          return true;
        });
        vehicle.ceramicWaterSupply = payload.ceramicWaterSupply;
        var selected = companionSelected();
        var interior = selected ? interiorOffer() : null;
        var already = Number(vehicle.companionInteriorPrice) || 0;
        vehicle.companionInterior = !!(selected && interior);
        if (selected && interior && !already) {
          vehicle.companionInteriorPrice = interior.price;
          vehicle.subtotal = (Number(vehicle.subtotal) || 0) + interior.price;
        }
        if (!(selected && interior) && already) {
          vehicle.subtotal = Math.max(0, (Number(vehicle.subtotal) || 0) - already);
          vehicle.companionInteriorPrice = 0;
          vehicle.addons = (vehicle.addons || []).filter(function (addon) { return !INTERIOR_IDS[addon.id]; });
        }
      });
      var fee = Number(payload.travelFeeAmount) || 0;
      var service = payload.vehicles.reduce(function (sum, vehicle) {
        return sum + (Number(vehicle.subtotal) || 0);
      }, 0);
      payload.totalPrice = service + fee;
      payload.total_price = payload.totalPrice;
    }
    return payload;
  }

  function clearInteriorAddons() {
    if (!global.ST || !Array.isArray(global.ST.addons)) return;
    global.ST.addons = global.ST.addons.filter(function (addon) { return !INTERIOR_IDS[addon.id]; });
    if (typeof global.recalcAddonTotal === 'function') global.recalcAddonTotal();
  }

  function catalogAddon(id) {
    return resolveOffer(id);
  }

  function addonPrice(id) {
    var row = resolveOffer(id);
    return row ? row.price : null;
  }

  function formatHours(mins) {
    var minutes = Math.max(0, Math.round(Number(mins) || 0));
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    if (!m) return h + (h === 1 ? ' hour' : ' hours');
    if (!h) return m + ' min';
    return h + ' hr ' + m + ' min';
  }

  function sanitizeCeramicAddons() {
    syncLiveState();
    if (!global.ST || !Array.isArray(global.ST.addons) || !isCeramicPackage(global.ST.pkgId)) return;
    var glass = null;
    var next = [];
    global.ST.addons.forEach(function (addon) {
      if (!addon || EXTERIOR_PROTECTION[addon.id]) return;
      if (!companionSelected() && INTERIOR_IDS[addon.id]) return;
      if (GLASS_IDS[addon.id]) {
        if (glass) return;
        glass = addon.id;
      }
      var row = resolveOffer(addon.id);
      if (!row) return;
      addon.name = row.name;
      addon.price = row.price;
      next.push(addon);
    });
    global.ST.addons = next;
    if (typeof global.recalcAddonTotal === 'function') global.recalcAddonTotal();
  }

  function announce(text) {
    var live = document.getElementById('ceramic-selection-status');
    if (!live) return;
    live.textContent = text;
    global.clearTimeout(announce._timer);
    announce._timer = global.setTimeout(function () {
      if (live.textContent === text) live.textContent = '';
    }, 2500);
  }

  function bindScrollGuard(card, input) {
    var drag = { moved: false, x: 0, y: 0 };
    card.addEventListener('pointerdown', function (e) {
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved = false;
    });
    card.addEventListener('pointermove', function (e) {
      if (Math.abs(e.clientY - drag.y) > 10 || Math.abs(e.clientX - drag.x) > 10) drag.moved = true;
    });
    input.addEventListener('click', function (e) {
      if (!drag.moved) return;
      e.preventDefault();
      drag.moved = false;
    });
  }

  function touchCard(opts) {
    var card = document.createElement('label');
    card.className = 'cd1-touch-card' + (opts.selected ? ' sel' : '');
    var input = document.createElement('input');
    input.type = opts.type || 'checkbox';
    input.name = opts.name || '';
    input.value = opts.value || opts.id;
    input.checked = !!opts.selected;
    input.setAttribute('data-id', opts.id);
    if (opts.id) card.setAttribute('data-id', opts.id);
    var copy = document.createElement('span');
    copy.className = 'cd1-touch-copy';
    var title = document.createElement('span');
    title.className = 'addon-name';
    title.textContent = opts.nameText;
    copy.appendChild(title);
    if (opts.meta) {
      var meta = document.createElement('span');
      meta.className = 'cd1-touch-meta';
      meta.textContent = opts.meta;
      copy.appendChild(meta);
    }
    if (opts.desc) {
      var desc = document.createElement('span');
      desc.className = 'cd1-touch-desc';
      desc.textContent = opts.desc;
      copy.appendChild(desc);
    }
    card.appendChild(input);
    card.appendChild(copy);
    bindScrollGuard(card, input);
    input.addEventListener('change', function () {
      opts.onChange(input.checked, input.value);
    });
    return card;
  }

  function hasAddon(id) {
    return (global.ST.addons || []).some(function (addon) { return addon.id === id; });
  }

  function writeAddon(id, on) {
    syncLiveState();
    var addons = (global.ST.addons || []).slice();
    addons = addons.filter(function (addon) { return addon.id !== id; });
    if (on) {
      var row = resolveOffer(id);
      if (!row) {
        global.ST.addons = addons;
        if (typeof global.recalcAddonTotal === 'function') global.recalcAddonTotal();
        return false;
      }
      addons.push({ id: row.id, name: row.name, price: row.price });
    }
    global.ST.addons = addons;
    if (typeof global.recalcAddonTotal === 'function') global.recalcAddonTotal();
    return true;
  }

  function applyGlass(value) {
    syncLiveState();
    var addons = (global.ST.addons || []).filter(function (addon) { return !GLASS_IDS[addon.id]; });
    var added = false;
    if (value && GLASS_IDS[value]) {
      var row = resolveOffer(value);
      if (row) {
        addons.push({ id: row.id, name: row.name, price: row.price });
        added = true;
      }
    }
    global.ST.addons = addons;
    if (typeof global.recalcAddonTotal === 'function') global.recalcAddonTotal();
    refreshTotals();
    renderCeramicCheckout();
    if (value && !added) announce(CATALOG_ERROR);
    else announce(value ? 'Added — total updated' : 'Removed — total updated');
  }

  function refreshTotals() {
    if (typeof global.updateTotal === 'function') global.updateTotal();
    paintCompanionTotal();
    injectCheckoutSummary();
    renderSticky();
  }

  function nextOpenIso(iso) {
    if (typeof global.bkIsoParts !== 'function' || typeof global.bkSlotsFor !== 'function') return null;
    var parts = global.bkIsoParts(iso);
    if (!parts) return null;
    var dt = new Date(parts.iso + 'T12:00:00');
    for (var i = 0; i < 21; i += 1) {
      dt.setDate(dt.getDate() + 1);
      var next = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      var slots = global.bkSlotsFor(next);
      if (slots && slots.length) return { iso: next, slots: slots };
    }
    return null;
  }

  function plannedDays() {
    if (!companionSelected() || typeof global.bkSlotsFor !== 'function') return null;
    var dateEl = document.getElementById('f-date');
    var timeEl = document.getElementById('f-time');
    var iso = dateEl && dateEl.value;
    var time = timeEl && timeEl.value;
    if (!iso || !time) return { pending: true, days: [] };
    var slots = global.bkSlotsFor(iso) || [];
    var idx = slots.indexOf(time);
    if (idx < 0) return { pending: true, days: [] };
    var needed = Math.ceil(appointmentMinutes() / 120);
    if (needed <= slots.length - idx) {
      return { multiDay: false, days: [{ date: iso, slots: slots.slice(idx, idx + needed) }] };
    }
    if (idx !== 0) return { blocked: true, days: [] };
    var days = [{ date: iso, slots: slots.slice() }];
    var remaining = needed - slots.length;
    var cursor = iso;
    while (remaining > 0) {
      var nxt = nextOpenIso(cursor);
      if (!nxt) return { blocked: true, days: days };
      var take = Math.min(remaining, nxt.slots.length);
      days.push({ date: nxt.iso, slots: nxt.slots.slice(0, take) });
      remaining -= take;
      cursor = nxt.iso;
    }
    return { multiDay: days.length > 1, days: days };
  }

  function extendedCopy() {
    var plan = plannedDays();
    if (!companionSelected()) return '';
    var minutes = appointmentMinutes();
    var text = EXTENDED_APPOINTMENT_MESSAGE + ' Estimated working time: ' + formatHours(minutes) + '.';
    if (plan && plan.multiDay && plan.days.length) {
      text += ' Reserved dates: ' + plan.days.map(function (day) { return day.date; }).join(', ') + '.';
    }
    return text;
  }

  function ensureStyles() {
    if (document.getElementById('cd1-ceramic-touch-css')) return;
    var style = document.createElement('style');
    style.id = 'cd1-ceramic-touch-css';
    style.textContent = [
      '.cd1-ceramic-checkout{max-width:100%;overflow-x:hidden}',
      '.cd1-ceramic-checkout h3{font-size:15px;margin:14px 0 8px}',
      '.cd1-touch-card{display:flex;align-items:flex-start;gap:12px;width:100%;max-width:100%;box-sizing:border-box;min-height:48px;padding:12px;margin:0 0 8px;border:1px solid #d5dbe3;border-radius:12px;background:#fff;cursor:pointer}',
      '.cd1-touch-card input{width:22px;height:22px;min-width:22px;margin-top:2px;flex:0 0 22px}',
      '.cd1-touch-card:has(input:checked),.cd1-touch-card.sel{border:2px solid #1d4ed8;background:#eff6ff}',
      '.cd1-touch-card:focus-within{outline:2px solid #1d4ed8;outline-offset:2px}',
      '.cd1-touch-copy{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.cd1-touch-meta{font-weight:700}',
      '.cd1-touch-desc,.cd1-support{font-size:13px;line-height:1.35}',
      '.cd1-disclose{min-height:48px;min-width:48px;padding:8px 12px;margin:0 0 8px;background:#fff;border:1px solid #d5dbe3;border-radius:10px}',
      '.cd1-ceramic-more{margin-top:8px}',
      '.cd1-ceramic-more summary{min-height:48px;display:flex;align-items:center;cursor:pointer}',
      '#ceramic-selection-status{min-height:1.2em;font-size:13px;color:#166534}',
      '.cd1-ceramic-sticky{display:none}',
      '@media(max-width:760px){',
      '.cd1-ceramic-sticky.is-on{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:1200;align-items:center;justify-content:space-between;gap:8px;max-width:100%;box-sizing:border-box;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid #d5dbe3}',
      '.booking-modal.cd1-sticky-pad{padding-bottom:calc(76px + env(safe-area-inset-bottom))}',
      '.cd1-ceramic-sticky button{min-height:48px;min-width:48px;padding:0 14px}',
      '.cd1-sticky-meta{font-size:14px;font-weight:700;min-width:0}',
      '}',
      '@media(max-width:430px){.cd1-ceramic-checkout,.cd1-touch-card,.cd1-ceramic-sticky{max-width:100%;overflow-x:hidden}}'
    ].join('');
    document.head.appendChild(style);
  }

  function appendResolvedCard(parent, id, opts) {
    var row = resolveOffer(id);
    if (!row) return;
    parent.appendChild(touchCard({
      type: opts.type || 'checkbox',
      name: opts.name || '',
      id: id,
      value: id,
      nameText: row.name,
      meta: '$' + row.price + (opts.metaSuffix || ''),
      desc: opts.desc == null ? row.description : opts.desc,
      selected: !!opts.selected,
      onChange: opts.onChange
    }));
  }

  function applyCatalogGate(host) {
    catalogBlocked = unresolvedIds.length > 0;
    if (catalogBlocked && host) {
      var error = document.createElement('p');
      error.id = 'ceramic-catalog-error';
      error.className = 'cd1-support';
      error.setAttribute('role', 'alert');
      error.textContent = CATALOG_ERROR;
      host.appendChild(error);
    }
    var next = document.getElementById('next3');
    var stickyBtn = document.getElementById('ceramic-sticky-continue');
    if (catalogBlocked) {
      if (next) next.disabled = true;
      if (stickyBtn) stickyBtn.disabled = true;
      return;
    }
    if (typeof global.syncContinueGate === 'function') global.syncContinueGate();
    if (stickyBtn) stickyBtn.disabled = false;
  }

  function renderCeramicCheckout() {
    ensureStyles();
    syncLiveState();
    unresolvedIds = [];
    var grid = document.getElementById('addon-grid');
    var existing = document.getElementById('ceramic-checkout');
    var on = !!(global.ST && isCeramicPackage(global.ST.pkgId));
    if (!on) {
      if (global.ST && global.ST.companionInterior) {
        global.ST.companionInterior = false;
        clearInteriorAddons();
      }
      if (existing) existing.remove();
      catalogBlocked = false;
      renderSticky();
      return;
    }
    sanitizeCeramicAddons();
    if (!grid) return;
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'ceramic-checkout';
      existing.className = 'cd1-ceramic-checkout';
      grid.insertAdjacentElement('afterend', existing);
    }
    var focus = document.activeElement && document.activeElement.value;
    existing.innerHTML = '';
    existing.appendChild(sectionTitle('Glass protection'));
    var glass = document.createElement('div');
    glass.id = 'ceramic-glass';
    var currentGlass = '';
    Object.keys(GLASS_IDS).forEach(function (id) { if (hasAddon(id)) currentGlass = id; });
    glass.appendChild(touchCard({
      type: 'radio', name: 'ceramic-glass', id: 'none', value: '', nameText: 'No additional glass protection',
      selected: !currentGlass,
      onChange: function () { applyGlass(''); }
    }));
    appendResolvedCard(glass, 'rainx', {
      type: 'radio', name: 'ceramic-glass', selected: currentGlass === 'rainx',
      onChange: function () { applyGlass('rainx'); }
    });
    ['ceramic_windshield', 'ceramic_glass_all'].forEach(function (id) {
      appendResolvedCard(glass, id, {
        type: 'radio', name: 'ceramic-glass', selected: currentGlass === id,
        onChange: function () { applyGlass(id); }
      });
    });
    existing.appendChild(glass);

    existing.appendChild(sectionTitle('Ceramic protection upgrades'));
    var upgrades = document.createElement('div');
    upgrades.id = 'ceramic-upgrades';
    ['ceramic_wheels', 'ceramic_trim', 'ceramic_lights'].forEach(function (id) {
      appendResolvedCard(upgrades, id, {
        selected: hasAddon(id),
        onChange: function (checked) {
          var ok = writeAddon(id, checked);
          refreshTotals();
          renderCeramicCheckout();
          announce(checked && ok ? 'Added — total updated' : (checked ? CATALOG_ERROR : 'Removed — total updated'));
        }
      });
    });
    existing.appendChild(upgrades);
    existing.appendChild(renderInteriorCard());
    existing.appendChild(renderMoreServices());
    var live = document.createElement('div');
    live.id = 'ceramic-selection-status';
    live.setAttribute('aria-live', 'polite');
    existing.appendChild(live);
    var extended = document.createElement('p');
    extended.id = 'companion-extended';
    extended.className = 'cd1-support';
    var copy = extendedCopy();
    extended.hidden = !copy;
    extended.textContent = copy;
    existing.appendChild(extended);
    applyCatalogGate(existing);
    if (focus) {
      var again = existing.querySelector('input[value="' + focus + '"]');
      if (again && again.focus) again.focus();
    }
    renderSticky();
  }

  function sectionTitle(text) {
    var h = document.createElement('h3');
    h.textContent = text;
    return h;
  }

  function renderInteriorCard() {
    var section = document.createElement('section');
    section.id = 'complete-vehicle';
    section.appendChild(sectionTitle('Complete your vehicle'));
    var offer = interiorOffer();
    var checked = companionSelected();
    if (offer) {
      section.appendChild(touchCard({
        type: 'checkbox', id: 'interior', value: 'interior', nameText: 'Add Complete Interior Detail',
        meta: '$' + offer.price + ' · approximately ' + formatHours(offer.minutes),
        desc: offer.description,
        selected: checked,
        onChange: function (on) {
          syncLiveState();
          global.ST.companionInterior = on;
          if (!on) clearInteriorAddons();
          refreshTotals();
          renderCeramicCheckout();
          announce(on ? 'Added — total updated' : 'Removed — total updated');
        }
      }));
    }
    var disclose = document.createElement('button');
    disclose.type = 'button';
    disclose.className = 'cd1-disclose';
    disclose.id = 'interior-inclusions-btn';
    disclose.textContent = "See what's included";
    disclose.setAttribute('aria-expanded', 'false');
    var list = document.createElement('ul');
    list.id = 'interior-inclusions';
    list.hidden = true;
    ['Vacuuming', 'Shampoo and extraction where appropriate', 'Steam cleaning', 'Surface cleaning', 'UV protection', 'Door jambs', 'Cargo area'].forEach(function (item) {
      var li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    });
    disclose.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      list.hidden = !list.hidden;
      disclose.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
    });
    section.appendChild(disclose);
    section.appendChild(list);
    var nested = document.createElement('div');
    nested.id = 'companion-addons';
    if (checked) {
      ['pethair', 'odor'].forEach(function (id) {
        appendResolvedCard(nested, id, {
          selected: hasAddon(id),
          onChange: function (on) {
            var ok = writeAddon(id, on);
            refreshTotals();
            announce(on && ok ? 'Added — total updated' : (on ? CATALOG_ERROR : 'Removed — total updated'));
          }
        });
      });
    }
    section.appendChild(nested);
    return section;
  }

  function renderMoreServices() {
    var details = document.createElement('details');
    details.id = 'ceramic-more';
    details.className = 'cd1-ceramic-more';
    var summary = document.createElement('summary');
    summary.textContent = 'More services';
    details.appendChild(summary);
    var ids = ['ceramic_correction', 'ceramic_waterspot', 'ceramic_contamination', 'undercarriage', 'engine_bay', 'heavymud'];
    if (hasAddon('undercarriage')) ids.push('mobile_water');
    ids.forEach(function (id) {
      appendResolvedCard(details, id, {
        selected: hasAddon(id),
        onChange: function (on) {
          var ok = writeAddon(id, on);
          if (id === 'undercarriage' && !on) writeAddon('mobile_water', false);
          refreshTotals();
          renderCeramicCheckout();
          announce(on && ok ? 'Added — total updated' : (on ? CATALOG_ERROR : 'Removed — total updated'));
        }
      });
    });
    return details;
  }

  function renderSticky() {
    ensureStyles();
    var bar = document.getElementById('ceramic-sticky');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ceramic-sticky';
      bar.className = 'cd1-ceramic-sticky';
      var meta = document.createElement('div');
      meta.className = 'cd1-sticky-meta';
      var totalEl = document.createElement('span');
      totalEl.id = 'ceramic-sticky-total';
      var durEl = document.createElement('span');
      durEl.id = 'ceramic-sticky-dur';
      meta.appendChild(totalEl);
      meta.appendChild(durEl);
      var continueBtn = document.createElement('button');
      continueBtn.type = 'button';
      continueBtn.id = 'ceramic-sticky-continue';
      continueBtn.textContent = 'Continue';
      bar.appendChild(meta);
      bar.appendChild(continueBtn);
      document.body.appendChild(bar);
      continueBtn.addEventListener('click', function () {
        var on = document.querySelector('.bsec.on');
        var btn = on && on.querySelector('.btn-n, .btn-sub');
        if (btn && !btn.disabled) btn.click();
      });
    }
    var modal = document.querySelector('.booking-modal-ov');
    var shell = document.querySelector('.booking-modal');
    var open = !!(modal && modal.classList.contains('open') && global.ST && global.ST.pkgId);
    bar.classList.toggle('is-on', open);
    bar.hidden = false;
    if (shell) shell.classList.toggle('cd1-sticky-pad', open);
    if (!open) return;
    var total = displayedServiceTotal();
    var totalEl = document.getElementById('ceramic-sticky-total');
    var durEl = document.getElementById('ceramic-sticky-dur');
    if (totalEl) totalEl.textContent = typeof global.bkMoney === 'function' ? global.bkMoney(total) : ('$' + total.toFixed(2));
    if (durEl) {
      var mins = isCeramicPackage(global.ST.pkgId) ? appointmentMinutes() : 0;
      durEl.textContent = mins ? ('· Approx. ' + formatHours(mins)) : '';
    }
  }

  function renderCompanion() {
    renderCeramicCheckout();
  }

  function paintCompanionTotal() {
    var extra = companionDollars();
    var el = document.getElementById('ah-total');
    if (!el || !global.ST || !isCeramicPackage(global.ST.pkgId)) return;
    var total = displayedServiceTotal();
    if (!(total > 0)) return;
    el.textContent = typeof global.bkMoney === 'function' ? global.bkMoney(total) : ('$' + total.toFixed(2));
    var est = document.getElementById('ah-total-est');
    if (est && extra > 0) {
      est.textContent = 'Includes Complete Interior Detail $' + extra.toFixed(2);
      est.style.display = 'block';
    }
  }

  function groupedAddons() {
    var ceramic = [];
    var interior = [];
    var general = [];
    var water = [];
    (global.ST && global.ST.addons || []).forEach(function (addon) {
      if (INTERIOR_IDS[addon.id]) interior.push(addon);
      else if (addon.id === 'mobile_water') water.push(addon);
      else if (CERAMIC_ONLY[addon.id]) ceramic.push(addon);
      else general.push(addon);
    });
    return { ceramic: ceramic, interior: interior, general: general, water: water };
  }

  function moneyLine(label, amount) {
    var dollars = Number(amount) || 0;
    return '<div><span>' + label + '</span><strong>$' + dollars.toFixed(2) + '</strong></div>';
  }

  function injectCheckoutSummary() {
    var host = document.getElementById('bs5');
    if (!host || !global.ST || !isCeramicPackage(global.ST.pkgId)) return;
    var box = document.getElementById('ceramic-checkout-lines');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ceramic-checkout-lines';
      box.className = 'fg full';
      host.insertBefore(box, host.firstChild);
    }
    var groups = groupedAddons();
    var pkgName = (global.ST.pkg && global.ST.pkg.name) || 'Ceramic Coating';
    var travel = typeof global.getTravelFeeAmount === 'function' ? global.getTravelFeeAmount() : 0;
    var approved = displayedServiceTotal();
    var plan = readPlan();
    var dueNow = plan === 'deposit' ? depositCentsFor(approved) / 100 : approved;
    var balance = Math.round((approved - dueNow) * 100) / 100;
    var rows = [moneyLine(pkgName, global.ST.basePrice || 0)];
    var interior = companionSelected() ? interiorOffer() : null;
    if (interior) rows.push(moneyLine(interior.name, interior.price));
    [groups.ceramic, groups.general, groups.interior, groups.water].forEach(function (list) {
      list.forEach(function (addon) {
        var row = resolveOffer(addon && addon.id);
        if (row) rows.push(moneyLine(row.name, row.price));
      });
    });
    if (travel) rows.push(moneyLine('Travel', travel));
    rows.push(moneyLine('Approved final total', approved));
    rows.push(moneyLine('Amount due today', dueNow));
    rows.push(moneyLine('Remaining balance', balance));
    var extended = extendedCopy()
      ? ('<p class="bk-addr-hint">' + extendedCopy() + '</p>')
      : '';
    box.innerHTML = '<div class="fl">Appointment summary</div>' + rows.join('') + extended;
  }

  function boot() {
    syncLiveState();
    ensurePanel();
    var origGate = global.syncContinueGate;
    if (typeof origGate === 'function' && !origGate._ceramicWrapped) {
      global.syncContinueGate = function () {
        var result = origGate.apply(this, arguments);
        if (catalogBlocked) {
          var next = document.getElementById('next3');
          if (next) next.disabled = true;
        }
        return result;
      };
      global.syncContinueGate._ceramicWrapped = true;
    }
    wrap('renderAddons', hideIncompatibleCards);
    wrap('setBasePrice', function () {
      hideIncompatibleCards();
      syncPanel();
    });
    wrap('updateTotal', paintCompanionTotal);
    wrap('buildCurrentVehicleItem', function (item) {
      if (!item || !isCeramicPackage(item.pkgId) || !companionSelected()) return;
      var interior = interiorOffer();
      if (!interior) return;
      item.companionInterior = true;
      item.companionInteriorPrice = interior.price;
      item.subtotal = (Number(item.subtotal) || 0) + interior.price;
    });
    wrap('buildBookingPayload', function (payload) {
      attachPayload(payload);
      injectCheckoutSummary();
    });
    if (global.Cardetail1BookingReview && typeof global.Cardetail1BookingReview.fillReviewSubmit === 'function'
      && !global.Cardetail1BookingReview.fillReviewSubmit._ceramicWrapped) {
      var origReview = global.Cardetail1BookingReview.fillReviewSubmit;
      global.Cardetail1BookingReview.fillReviewSubmit = function () {
        var result = origReview.apply(this, arguments);
        try { injectCheckoutSummary(); } catch (err) { /* display only */ }
        return result;
      };
      global.Cardetail1BookingReview.fillReviewSubmit._ceramicWrapped = true;
    }
    var origSchedule = global.bkValidateScheduleSelection;
    if (typeof origSchedule === 'function' && !origSchedule._ceramicWrapped) {
      global.bkValidateScheduleSelection = function () {
        var result = origSchedule.apply(this, arguments);
        if (!result || !result.ok || !companionSelected()) return result;
        var iso = document.getElementById('f-date') && document.getElementById('f-date').value;
        var time = document.getElementById('f-time') && document.getElementById('f-time').value;
        var slots = typeof global.bkSlotsFor === 'function' ? global.bkSlotsFor(iso) : [];
        var minutes = appointmentMinutes();
        var fit = slots.length * 120;
        if (slots.length && time && time !== slots[0] && minutes > Math.max(120, (slots.length - slots.indexOf(time)) * 120)) {
          return {
            ok: false,
            message: EXTENDED_APPOINTMENT_MESSAGE + ' A late start is not available, and the duration is not shortened.'
          };
        }
        if (minutes > fit) {
          var hint = document.getElementById('companion-extended');
          if (hint) hint.hidden = false;
        }
        return result;
      };
      global.bkValidateScheduleSelection._ceramicWrapped = true;
    }
    var origToggle = global.toggleAddon;
    if (typeof origToggle === 'function' && !origToggle._ceramicWrapped) {
      global.toggleAddon = function (card) {
        var id = card && card.dataset && card.dataset.id;
        var selected = global.ST && Array.isArray(global.ST.addons)
          ? global.ST.addons.some(function (a) { return a.id === id; })
          : false;
        if (!selected && global.ST && isCeramicPackage(global.ST.pkgId) && GLASS_IDS[id]) {
          global.ST.addons = global.ST.addons.filter(function (addon) { return !GLASS_IDS[addon.id] || addon.id === id; });
        }
        if (!selected && global.ST && isCeramicPackage(global.ST.pkgId) && EXTERIOR_PROTECTION[id]) return;
        var result = origToggle.apply(this, arguments);
        announce('Added — total updated');
        renderSticky();
        return result;
      };
      global.toggleAddon._ceramicWrapped = true;
    }
    var overlay = document.querySelector('.booking-modal-ov');
    if (overlay && typeof global.MutationObserver === 'function') {
      new MutationObserver(function () { renderSticky(); }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }
    ['f-date', 'f-time'].forEach(function (id) {
      var field = document.getElementById(id);
      if (field) field.addEventListener('change', function () { renderCeramicCheckout(); });
    });
    syncPanel();
  }

  global.CD1CeramicBooking = {
    isCeramicPackage: isCeramicPackage,
    bandFor: bandFor,
    displayPrice: displayPrice,
    addonVisible: addonVisible,
    readAnswers: readAnswers,
    readPlan: readPlan,
    readWaterSupply: readWaterSupply,
    renderCeramicCheckout: renderCeramicCheckout,
    appointmentMinutes: appointmentMinutes,
    waterRepellentName: WATER_REPELLENT.name,
    boot: boot
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
