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
    return true;
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
    var deposit = global.ST.pkgId === 'ceramic_3yr' ? 250 : 150;
    if (note) {
      note.textContent = plan === 'deposit'
        ? ('Deposit $' + deposit + ' is charged now. The remaining balance is collected later and is not charged automatically.')
        : (plan === 'prepay_full' ? 'The full approved total is charged now. The booking is paid only after Stripe confirms the payment.' : '');
    }
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
        if (isCeramicPackage(vehicle.pkgId)) vehicle.ceramicWaterSupply = payload.ceramicWaterSupply;
      });
    }
    return payload;
  }

  function boot() {
    ensurePanel();
    wrap('renderAddons', hideIncompatibleCards);
    wrap('setBasePrice', function () {
      hideIncompatibleCards();
      syncPanel();
    });
    wrap('buildBookingPayload', function (payload) {
      attachPayload(payload);
    });
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
