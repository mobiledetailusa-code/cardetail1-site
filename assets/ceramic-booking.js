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
    rainx: true,
    claybar: true
  };
  var ADDON_MINUTES = {
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
    if (INTERIOR_IDS[id]) {
      if (!isCeramicPackage(pkg)) return true;
      return !!(state && state.companionInterior);
    }
    if (isCeramicPackage(pkg) && !CERAMIC_ONLY[id] && !GLOBAL_IDS[id] && id !== 'engine') return false;
    return true;
  }

  function pageValue(name) {
    if (global[name] != null) return global[name];
    try { return (0, eval)(name); } catch (err) { return null; }
  }

  function interiorPrice() {
    var pricing = pageValue('PRICING');
    var state = pageValue('ST') || global.ST;
    var tier = pricing && pricing.cars && state && pricing.cars.tiers[state.tierKey];
    return tier && tier.interior ? Number(tier.interior) : 0;
  }

  function interiorCatalog() {
    var pricing = pageValue('PRICING');
    return (pricing && pricing.cars && pricing.cars.addons) || [];
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
    if (companionSelected()) minutes += 120;
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
    if (!global.ST) return;
    var cards = document.querySelectorAll('.addon[data-id]');
    cards.forEach(function (card) {
      var id = card.getAttribute('data-id');
      var show = addonVisible({ id: id }, global.ST);
      card.hidden = !show;
      card.style.display = show ? '' : 'none';
    });
    syncAddonPrices();
    renderCompanion();
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
    if (Array.isArray(payload.vehicles)) {
      payload.vehicles.forEach(function (vehicle) {
        if (!isCeramicPackage(vehicle.pkgId)) return;
        vehicle.ceramicWaterSupply = payload.ceramicWaterSupply;
        var selected = companionSelected();
        var already = Number(vehicle.companionInteriorPrice) || 0;
        vehicle.companionInterior = selected;
        if (selected && !already) {
          vehicle.companionInteriorPrice = interiorPrice();
          vehicle.subtotal = (Number(vehicle.subtotal) || 0) + interiorPrice();
        }
        if (!selected && already) {
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

  function renderCompanion() {
    var grid = document.getElementById('addon-grid');
    if (!grid || !global.ST) return;
    var existing = document.getElementById('complete-vehicle');
    var on = isCeramicPackage(global.ST.pkgId);
    if (!on) {
      if (global.ST.companionInterior) {
        global.ST.companionInterior = false;
        clearInteriorAddons();
      }
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement('section');
      existing.id = 'complete-vehicle';
      existing.className = 'fg full';
      grid.insertAdjacentElement('afterend', existing);
    }
    var price = interiorPrice();
    var checked = companionSelected();
    existing.innerHTML = [
      '<div class="fl">Complete your vehicle</div>',
      '<label class="addon' + (checked ? ' sel' : '') + '" style="display:flex;gap:10px;align-items:flex-start;margin:8px 0">',
      '<input type="checkbox" id="companion-interior"' + (checked ? ' checked' : '') + '>',
      '<span><strong>Add Complete Interior Detail</strong>',
      price ? ' <span class="addon-price">+$' + price + '</span>' : '',
      '<span class="bk-addr-hint" style="display:block">' + INTERIOR_DESCRIPTION + '</span></span></label>',
      '<div id="companion-addons"></div>',
      '<p id="companion-extended" class="bk-addr-hint"' + (checked ? '' : ' hidden') + '>This combined service may require an extended appointment. The duration is not shortened, and a late same-day start is not available.</p>'
    ].join('');
    var box = existing.querySelector('#companion-interior');
    if (box) {
      box.addEventListener('change', function () {
        global.ST.companionInterior = box.checked;
        if (!box.checked) clearInteriorAddons();
        renderCompanion();
        if (typeof global.updateTotal === 'function') global.updateTotal();
        paintCompanionTotal();
      });
    }
    renderCompanionAddons();
  }

  function renderCompanionAddons() {
    var host = document.getElementById('companion-addons');
    if (!host) return;
    host.innerHTML = '';
    if (!companionSelected()) return;
    var catalog = interiorCatalog();
    catalog.forEach(function (addon) {
      if (!INTERIOR_IDS[addon.id]) return;
      var selected = (global.ST.addons || []).some(function (row) { return row.id === addon.id; });
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'addon' + (selected ? ' sel' : '');
      card.setAttribute('data-id', addon.id);
      card.setAttribute('data-price', String(addon.price));
      var names = {
        pethair: 'Pet Hair Removal',
        odor: 'Odor Treatment & Sanitize',
        superint: 'Super Interior Upgrade',
        mold: 'Mold Treatment',
        sanitize: 'Interior Sanitizing',
        biohazard: 'Biohazard Cleaning',
        floormats: 'Floor Mat Deep Clean',
        babyseat: 'Baby / Car Seat Cleaning',
        stroller: 'Baby Stroller Cleaning'
      };
      var label = names[addon.id] || addon.name || addon.id;
      card.innerHTML = '<span class="addon-name">' + label + '</span> <span class="addon-price">+$' + addon.price + '</span>';
      card.addEventListener('click', function () {
        if (typeof global.toggleAddon === 'function') global.toggleAddon(card);
        renderCompanionAddons();
        paintCompanionTotal();
        injectCheckoutSummary();
      });
      host.appendChild(card);
    });
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
    if (companionSelected()) rows.push(moneyLine('Complete Interior Detail', interiorPrice()));
    groups.ceramic.forEach(function (addon) { rows.push(moneyLine(addon.name || addon.id, addon.price)); });
    groups.general.forEach(function (addon) { rows.push(moneyLine(addon.name || addon.id, addon.price)); });
    groups.interior.forEach(function (addon) { rows.push(moneyLine(addon.name || addon.id, addon.price)); });
    groups.water.forEach(function (addon) { rows.push(moneyLine(addon.name || 'Mobile Water Supply', addon.price)); });
    if (travel) rows.push(moneyLine('Travel', travel));
    rows.push(moneyLine('Approved final total', approved));
    rows.push(moneyLine('Amount due today', dueNow));
    rows.push(moneyLine('Remaining balance', balance));
    var extended = companionSelected()
      ? '<p class="bk-addr-hint">This combined service may require an extended appointment.</p>'
      : '';
    box.innerHTML = '<div class="fl">Appointment summary</div>' + rows.join('') + extended;
  }

  function boot() {
    ensurePanel();
    wrap('renderAddons', hideIncompatibleCards);
    wrap('setBasePrice', function () {
      hideIncompatibleCards();
      syncPanel();
    });
    wrap('updateTotal', paintCompanionTotal);
    wrap('buildCurrentVehicleItem', function (item) {
      if (!item || !isCeramicPackage(item.pkgId) || !companionSelected()) return;
      item.companionInterior = true;
      item.companionInteriorPrice = interiorPrice();
      item.subtotal = (Number(item.subtotal) || 0) + interiorPrice();
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
            message: 'This combined service may require an extended appointment. Choose the first opening of a full day. A late start is not available, and the duration is not shortened.'
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
        if (!selected && global.ST && isCeramicPackage(global.ST.pkgId)) {
          var ids = global.ST.addons.map(function (a) { return a.id; });
          if ((id === 'ceramic_windshield' && ids.indexOf('ceramic_glass_all') >= 0)
            || (id === 'ceramic_glass_all' && ids.indexOf('ceramic_windshield') >= 0)) {
            global.alert('Choose windshield coating or all exterior glass coating, not both.');
            return;
          }
        }
        return origToggle.apply(this, arguments);
      };
      global.toggleAddon._ceramicWrapped = true;
    }
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
    boot: boot
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
