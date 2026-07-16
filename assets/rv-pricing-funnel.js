/**
 * RV pricing funnel — ZIP first, then type, then length, then estimates.
 * Travel fees mirror netlify/lib/travel-fee.js (server remains authoritative).
 */
(function () {
  'use strict';

  var TRAVEL_MAX_MILES = 120;
  var TRAVEL_FEE_TIERS = [
    { maxMi: 30, fee: 0 },
    { maxMi: 50, fee: 15 },
    { maxMi: 65, fee: 25 },
    { maxMi: 85, fee: 35 },
    { maxMi: 100, fee: 40 },
    { maxMi: 120, fee: 55 },
  ];
  var ZONE_DEFAULT_MILES = {
    nj_a: 12, nj_b: 38, nyc: 22, ny_s: 42, ct: 58,
    pa_e: 68, pa_p: 78, pa_ph: 98, pa_b: 72, extended: 90,
  };
  var ZIP3_EST_MILES = {
    '070': 12, '071': 18, '072': 14, '073': 16, '074': 10, '075': 8, '076': 6, '077': 20,
    '078': 32, '079': 36, '080': 48, '081': 52, '082': 55, '083': 58, '084': 62, '085': 65,
    '086': 68, '087': 72, '088': 75, '089': 78,
    '100': 22, '101': 24, '102': 25, '103': 28, '104': 26, '111': 26, '112': 30, '113': 34, '114': 36,
    '105': 35, '106': 38, '107': 42, '108': 44, '109': 48, '115': 40, '116': 38, '117': 46, '118': 50, '119': 54,
    '120': 88, '121': 92, '122': 95, '123': 98, '124': 102, '125': 108, '126': 112, '127': 118, '128': 122,
    '130': 125, '131': 128, '132': 132, '133': 135, '134': 138, '136': 140, '137': 142, '138': 145, '139': 148,
    '060': 55, '061': 58, '062': 62, '063': 65, '064': 68, '065': 72, '066': 58, '067': 60, '068': 52, '069': 48,
    '180': 65, '181': 68, '183': 75, '189': 70, '190': 95, '191': 98,
    '170': 110, '171': 115, '172': 118, '173': 122, '174': 126, '175': 130, '176': 135, '177': 138, '178': 142,
    '195': 120, '196': 125,
  };
  var ZIP_ZONE_PREFIXES = {
    nj_a: ['070', '071', '072', '073', '074', '075', '076', '077'],
    nj_b: ['078', '079', '080', '081', '082', '083', '084', '085', '086', '087', '088', '089'],
    nyc: ['100', '101', '102', '103', '104', '111', '112', '113', '114'],
    ny_s: ['105', '106', '107', '108', '109', '115', '116', '117', '118', '119', '120', '121', '122', '123'],
    ct: ['060', '061', '062', '063', '064', '065', '066', '067', '068', '069'],
    pa_e: ['180', '181'],
    pa_p: ['183'],
    pa_ph: ['190', '191'],
    pa_b: ['189'],
  };

  var RV_TYPES = {
    travel: { id: 'travel', label: 'Travel Trailer', multiplier: 1, minFt: 12, maxFt: 40, packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'] },
    fifthwheel: { id: 'fifthwheel', label: 'Fifth Wheel', multiplier: 1.1, minFt: 20, maxFt: 45, packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'] },
    classA: { id: 'classA', label: 'Class A Motorhome', multiplier: 1.15, minFt: 24, maxFt: 45, packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'] },
    classBC: { id: 'classBC', label: 'Class B / Class C Motorhome', multiplier: 1.1, minFt: 16, maxFt: 35, packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'] },
    airstream: { id: 'airstream', label: 'Airstream', multiplier: 1.08, minFt: 16, maxFt: 34, packages: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'], surfaceAware: true },
    specialty: { id: 'specialty', label: 'Cargo, Horse or Custom Trailer', multiplier: 1, minFt: 12, maxFt: 45, packagesExterior: ['maint', 'premium'], packagesLiving: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'] },
  };

  var PACKAGES = {
    maint: { id: 'maint', name: 'Maintenance Wash', perFt: 8.5, min: 129, badge: null, subtitle: 'Exterior maintenance with quick machine-applied protection.', exclusion: 'Roof excluded. Heavy black streaks, oxidation and severe water spots are not included.', inclusions: ['Exterior hand wash', 'Bug and light road-film removal', 'Wheels cleaned · tire shine', 'Quick machine-applied wax or sealant'] },
    maint_light: { id: 'maint_light', name: 'Maintenance Wash + Light Interior', perFt: 16, min: 229, badge: null, subtitle: 'Exterior maintenance plus a quick interior refresh.', exclusion: 'No shampoo, extraction, pet hair, odor treatment, appliance interiors, cabinet interiors, bed making, or roof cleaning.', inclusions: ['Exterior wash + quick protection', 'Vacuum accessible floors and seating', 'Driver cabin wipe-down', 'Kitchen and bathroom surfaces wiped'] },
    interior: { id: 'interior', name: 'Interior Detail', perFt: 21, min: 249, badge: null, subtitle: 'Complete interior cleaning from the driver cabin to the living area.', exclusion: 'Belongings must be removed. Heavy staining, pet hair and strong odors may need Super Interior.', inclusions: ['Full interior vacuum', 'Carpet and upholstery shampoo', 'Kitchen, bath and living surfaces', 'Cabinet interiors when emptied'] },
    full_basic: { id: 'full_basic', name: 'Full RV Detail', perFt: 27, min: 349, badge: 'MOST POPULAR', subtitle: 'Complete interior cleaning plus exterior wash and protection.', exclusion: 'Roof excluded. Does not include one-step machine polishing.', inclusions: ['Exterior wash + quick protection', 'Full interior vacuum and shampoo', 'Kitchen, bath and living detail', 'Final inspection inside and out'] },
    premium: { id: 'premium', name: 'Premium Exterior Detail', perFt: 33, min: 449, badge: null, subtitle: 'One-Step Machine Polish + Premium Protection', exclusion: 'Roof excluded. One-step polish is not multi-stage restoration.', inclusions: ['Exterior wash and decontamination', 'One-step machine polish', 'Premium wax or sealant', 'Wheels, glass and jambs'] },
    full: { id: 'full', name: 'Premium Complete RV Detail', perFt: 49.5, min: 699, badge: 'BEST FINISH', subtitle: 'One-Step Exterior Polish + Complete Interior Detail', exclusion: 'Roof excluded. Severe oxidation and multi-stage work need inspection.', inclusions: ['Full Premium Exterior Detail', 'Full Interior Detail', 'One-step machine polish', 'Final inspection inside and out'] },
  };

  var state = {
    step: 1,
    zip: '',
    travel: null,
    typeKey: '',
    living: null,
    lengthFt: 0,
  };

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US');
  }

  function zoneKeyForZip3(p3) {
    var keys = Object.keys(ZIP_ZONE_PREFIXES);
    for (var i = 0; i < keys.length; i++) {
      if (ZIP_ZONE_PREFIXES[keys[i]].indexOf(p3) >= 0) return keys[i];
    }
    return null;
  }

  function estimateMilesForZip(zip) {
    var z = String(zip || '').replace(/\D/g, '').slice(0, 5);
    if (z.length < 5) return null;
    var p3 = z.slice(0, 3);
    if (ZIP3_EST_MILES[p3] != null) return Number(ZIP3_EST_MILES[p3]);
    var zk = zoneKeyForZip3(p3);
    if (zk && ZONE_DEFAULT_MILES[zk] != null) return ZONE_DEFAULT_MILES[zk];
    return null;
  }

  function travelFeeFromMiles(mi) {
    if (mi == null || mi < 0 || mi > TRAVEL_MAX_MILES) return null;
    for (var i = 0; i < TRAVEL_FEE_TIERS.length; i++) {
      if (mi <= TRAVEL_FEE_TIERS[i].maxMi) return TRAVEL_FEE_TIERS[i].fee;
    }
    return 55;
  }

  function resolveTravel(zip) {
    var miles = estimateMilesForZip(zip);
    if (miles == null || miles > TRAVEL_MAX_MILES) return null;
    var fee = travelFeeFromMiles(miles);
    if (fee == null) return null;
    return { miles: miles, fee: fee, zip: String(zip).replace(/\D/g, '').slice(0, 5) };
  }

  function eligibleIds() {
    var t = RV_TYPES[state.typeKey];
    if (!t) return [];
    if (state.typeKey === 'specialty') {
      return (state.living === 'yes') ? t.packagesLiving.slice() : t.packagesExterior.slice();
    }
    return t.packages.slice();
  }

  function calcService(pkg, ft, mult) {
    return Math.max(pkg.min, Math.round(pkg.perFt * ft * mult));
  }

  function ensureDom() {
    if (document.getElementById('rv-funnel-backdrop')) return;
    var wrap = document.createElement('div');
    wrap.id = 'rv-funnel-backdrop';
    wrap.className = 'rv-funnel-backdrop';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'rv-funnel-title');
    wrap.innerHTML = ''
      + '<div class="rv-funnel" id="rv-funnel">'
      + '  <div class="rv-funnel-head">'
      + '    <div><h2 id="rv-funnel-title">Check Price &amp; Availability</h2>'
      + '    <p>Enter your ZIP code, RV type and exact length to see your estimated total.</p></div>'
      + '    <button type="button" class="rv-funnel-close" id="rv-funnel-close" aria-label="Close">×</button>'
      + '  </div>'
      + '  <div class="rv-funnel-steps" id="rv-funnel-steps"></div>'
      + '  <div class="rv-funnel-body">'
      + '    <div class="rv-funnel-panel" data-step="1">'
      + '      <label class="rv-funnel-label" for="rv-funnel-zip">Service ZIP code</label>'
      + '      <input class="rv-funnel-input" id="rv-funnel-zip" inputmode="numeric" maxlength="5" autocomplete="postal-code" placeholder="e.g. 07650">'
      + '      <p class="rv-funnel-msg" id="rv-funnel-zip-msg"></p>'
      + '      <div class="rv-funnel-actions"><button type="button" class="sp-btn sp-btn-primary" id="rv-funnel-zip-next">Continue</button></div>'
      + '    </div>'
      + '    <div class="rv-funnel-panel" data-step="2">'
      + '      <div class="rv-funnel-label">RV type</div>'
      + '      <div class="rv-type-grid" id="rv-type-grid"></div>'
      + '      <div class="rv-living" id="rv-living">'
      + '        <div class="rv-funnel-label">Does this trailer have finished living quarters?</div>'
      + '        <div class="rv-living-options">'
      + '          <button type="button" class="rv-type-card" data-living="yes"><strong>Yes — finished living quarters</strong><span>Kitchen, bath or sleeping area finished</span></button>'
      + '          <button type="button" class="rv-type-card" data-living="no"><strong>No — cargo / equipment / animal area</strong><span>Exterior packages only</span></button>'
      + '          <button type="button" class="rv-type-card" data-living="custom"><strong>Custom configuration</strong><span>We will confirm scope before service</span></button>'
      + '        </div>'
      + '      </div>'
      + '      <div class="rv-funnel-actions">'
      + '        <button type="button" class="sp-btn sp-btn-outline" data-funnel-back="1">Back</button>'
      + '        <button type="button" class="sp-btn sp-btn-primary" id="rv-funnel-type-next">Continue</button>'
      + '      </div>'
      + '    </div>'
      + '    <div class="rv-funnel-panel" data-step="3">'
      + '      <label class="rv-funnel-label" for="rv-funnel-length">Exact RV length (ft)</label>'
      + '      <div class="rv-length-row">'
      + '        <input type="range" id="rv-funnel-length" min="12" max="45" step="1" value="24">'
      + '        <input class="rv-length-num" id="rv-funnel-length-num" type="number" min="12" max="45" step="1" value="24" aria-label="RV length in feet">'
      + '      </div>'
      + '      <p class="rv-funnel-msg" id="rv-funnel-length-msg">Select the exact length. Lengths are not rounded up to 24 ft.</p>'
      + '      <div class="rv-funnel-actions">'
      + '        <button type="button" class="sp-btn sp-btn-outline" data-funnel-back="2">Back</button>'
      + '        <button type="button" class="sp-btn sp-btn-primary" id="rv-funnel-length-next">See estimates</button>'
      + '      </div>'
      + '    </div>'
      + '    <div class="rv-funnel-panel" data-step="4">'
      + '      <p class="rv-funnel-msg ok" id="rv-funnel-result-intro"></p>'
      + '      <div id="rv-funnel-results"></div>'
      + '      <div class="rv-funnel-actions">'
      + '        <button type="button" class="sp-btn sp-btn-outline" data-funnel-back="3">Back</button>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(wrap);

    var grid = document.getElementById('rv-type-grid');
    Object.keys(RV_TYPES).forEach(function (key) {
      var t = RV_TYPES[key];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rv-type-card';
      btn.setAttribute('data-type', key);
      btn.innerHTML = '<strong>' + t.label + '</strong><span>' + (t.surfaceAware ? 'Surface-aware detailing' : 'Exact-length pricing') + '</span>';
      grid.appendChild(btn);
    });
  }

  function setStep(n) {
    state.step = n;
    var panels = document.querySelectorAll('.rv-funnel-panel');
    for (var i = 0; i < panels.length; i++) {
      panels[i].classList.toggle('active', Number(panels[i].getAttribute('data-step')) === n);
    }
    var host = document.getElementById('rv-funnel-steps');
    var labels = ['ZIP', 'RV type', 'Length', 'Estimates'];
    host.innerHTML = labels.map(function (label, idx) {
      var step = idx + 1;
      var cls = 'rv-funnel-step-pill';
      if (step === n) cls += ' active';
      if (step < n) cls += ' done';
      return '<span class="' + cls + '">' + step + '. ' + label + '</span>';
    }).join('');
  }

  function openFunnel(preferredPkg) {
    ensureDom();
    state.preferredPkg = preferredPkg || '';
    document.getElementById('rv-funnel-backdrop').classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    setStep(state.zip && state.travel ? (state.typeKey ? (state.lengthFt ? 4 : 3) : 2) : 1);
    if (state.step === 4) renderResults();
    var zipInput = document.getElementById('rv-funnel-zip');
    if (zipInput && state.step === 1) zipInput.focus();
  }

  function closeFunnel() {
    var el = document.getElementById('rv-funnel-backdrop');
    if (el) el.classList.remove('open');
    document.documentElement.style.overflow = '';
  }

  function renderResults() {
    var t = RV_TYPES[state.typeKey];
    var mult = t ? t.multiplier : 1;
    var ids = eligibleIds();
    var travel = state.travel;
    var intro = document.getElementById('rv-funnel-result-intro');
    intro.textContent = 'Estimates for your ' + state.lengthFt + '-ft ' + (t ? t.label : 'RV')
      + ' at ZIP ' + travel.zip + '. Estimate — final scope confirmed before service.';
    var host = document.getElementById('rv-funnel-results');
    host.innerHTML = '';
    ids.forEach(function (id) {
      var pkg = PACKAGES[id];
      if (!pkg) return;
      var service = calcService(pkg, state.lengthFt, mult);
      var travelLine = travel.fee > 0
        ? ('Mobile service adjustment: ' + money(travel.fee))
        : 'Mobile service adjustment: Included';
      var total = service + travel.fee;
      var card = document.createElement('article');
      card.className = 'rv-result-card' + (pkg.badge === 'MOST POPULAR' ? ' pop' : '');
      var badge = pkg.badge
        ? ('<div class="rv-result-badge' + (pkg.badge === 'BEST FINISH' ? ' best' : '') + '">' + pkg.badge + '</div>')
        : '';
      card.innerHTML = badge
        + '<h3 class="rv-result-name">' + pkg.name + '</h3>'
        + '<p class="rv-result-sub">' + pkg.subtitle + '</p>'
        + '<p class="rv-result-breakdown">Service for your ' + t.label + ', ' + state.lengthFt + ' ft: ' + money(service) + '<br>' + travelLine + '</p>'
        + '<p class="rv-result-total">Estimated total for your ' + state.lengthFt + '-ft ' + t.label + ': ' + money(total) + '</p>'
        + '<p class="rv-result-rate">Base rate: $' + pkg.perFt + '/ft · Includes mobile service adjustment for ZIP ' + travel.zip.slice(0, 3) + 'XX.</p>'
        + '<ul class="sp-pkg-feats">' + pkg.inclusions.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>'
        + '<p class="sp-pkg-limit">' + pkg.exclusion + '</p>'
        + '<button type="button" class="sp-btn sp-btn-primary sp-btn-block" data-select-pkg="' + pkg.id + '">Select Package</button>';
      host.appendChild(card);
    });
  }

  function selectPackage(pkgId) {
    try {
      sessionStorage.setItem('cd1_rv_length', String(state.lengthFt));
      sessionStorage.setItem('cd1_rv_type', state.typeKey);
      sessionStorage.setItem('cd1_rv_living', String(state.living || ''));
      sessionStorage.setItem('cd1_zip', state.zip);
      localStorage.setItem('cd1_zip', state.zip);
      localStorage.setItem('cd1_rv_length', String(state.lengthFt));
    } catch (e0) {}

    var params = new URLSearchParams();
    params.set('book', 'rvs');
    params.set('pkg', pkgId);
    params.set('zip', state.zip);
    params.set('length', String(state.lengthFt));
    params.set('rvType', state.typeKey);
    if (state.living) params.set('living', state.living);

    if (window.openCategoryPackageBooking) {
      window.openCategoryPackageBooking({
        categoryId: 'rvs',
        packageId: pkgId,
        lengthFt: state.lengthFt,
        zip: state.zip,
        rvType: state.typeKey,
        living: state.living || '',
        sourcePath: location.pathname,
      });
      closeFunnel();
      return;
    }
    location.href = 'index.html?' + params.toString();
  }

  function onDocClick(ev) {
    var openBtn = ev.target.closest(
      '[data-rv-price-funnel], .rv-open-funnel, [data-booking-category="rvs"].package-booking-cta, a[data-booking-category="rvs"][data-booking-package], button[data-booking-category="rvs"][data-booking-package]'
    );
    if (openBtn) {
      if (openBtn.getAttribute('data-booking-multi') === '1' && !openBtn.hasAttribute('data-rv-price-funnel')) return;
      if (openBtn.hasAttribute('data-rv-price-funnel')
        || openBtn.classList.contains('rv-open-funnel')
        || openBtn.classList.contains('package-booking-cta')
        || openBtn.getAttribute('data-booking-package')) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        openFunnel(openBtn.getAttribute('data-booking-package') || '');
        return;
      }
    }
    if (ev.target.id === 'rv-funnel-close') closeFunnel();
    var back = ev.target.closest('[data-funnel-back]');
    if (back) setStep(Number(back.getAttribute('data-funnel-back')));
    var typeBtn = ev.target.closest('#rv-type-grid [data-type]');
    if (typeBtn) {
      state.typeKey = typeBtn.getAttribute('data-type');
      var cards = document.querySelectorAll('#rv-type-grid [data-type]');
      for (var i = 0; i < cards.length; i++) cards[i].classList.toggle('selected', cards[i] === typeBtn);
      var living = document.getElementById('rv-living');
      living.classList.toggle('show', state.typeKey === 'specialty');
      if (state.typeKey !== 'specialty') state.living = null;
    }
    var livingBtn = ev.target.closest('#rv-living [data-living]');
    if (livingBtn) {
      state.living = livingBtn.getAttribute('data-living');
      var lbs = document.querySelectorAll('#rv-living [data-living]');
      for (var j = 0; j < lbs.length; j++) lbs[j].classList.toggle('selected', lbs[j] === livingBtn);
    }
    var pick = ev.target.closest('[data-select-pkg]');
    if (pick) selectPackage(pick.getAttribute('data-select-pkg'));
  }

  function wireControls() {
    ensureDom();
    document.getElementById('rv-funnel-zip-next').onclick = function () {
      var zip = String(document.getElementById('rv-funnel-zip').value || '').replace(/\D/g, '').slice(0, 5);
      var msg = document.getElementById('rv-funnel-zip-msg');
      if (zip.length !== 5) {
        msg.className = 'rv-funnel-msg error';
        msg.textContent = 'Enter a valid 5-digit ZIP code.';
        return;
      }
      var travel = resolveTravel(zip);
      if (!travel) {
        msg.className = 'rv-funnel-msg error';
        msg.textContent = 'That ZIP is outside our online booking radius. Call / text 551-313-2956 for an extended-area quote.';
        state.travel = null;
        return;
      }
      state.zip = zip;
      state.travel = travel;
      msg.className = 'rv-funnel-msg ok';
      msg.textContent = travel.fee > 0
        ? ('Service area confirmed · about ' + travel.miles + ' mi · mobile adjustment ' + money(travel.fee))
        : ('Core service area · about ' + travel.miles + ' mi · mobile adjustment included');
      setStep(2);
    };

    document.getElementById('rv-funnel-type-next').onclick = function () {
      if (!state.typeKey) return;
      if (state.typeKey === 'specialty' && !state.living) return;
      var t = RV_TYPES[state.typeKey];
      var range = document.getElementById('rv-funnel-length');
      var num = document.getElementById('rv-funnel-length-num');
      range.min = String(t.minFt);
      range.max = String(t.maxFt);
      num.min = String(t.minFt);
      num.max = String(t.maxFt);
      var start = Math.min(Math.max(state.lengthFt || Math.max(t.minFt, 20), t.minFt), t.maxFt);
      range.value = String(start);
      num.value = String(start);
      state.lengthFt = start;
      setStep(3);
    };

    function syncLength(from) {
      var range = document.getElementById('rv-funnel-length');
      var num = document.getElementById('rv-funnel-length-num');
      var t = RV_TYPES[state.typeKey] || { minFt: 12, maxFt: 45 };
      var ft = Number(from === 'num' ? num.value : range.value);
      if (!(ft >= t.minFt && ft <= t.maxFt)) return;
      range.value = String(ft);
      num.value = String(ft);
      state.lengthFt = ft;
    }
    document.getElementById('rv-funnel-length').oninput = function () { syncLength('range'); };
    document.getElementById('rv-funnel-length-num').oninput = function () { syncLength('num'); };
    document.getElementById('rv-funnel-length-next').onclick = function () {
      if (!state.lengthFt) return;
      setStep(4);
      renderResults();
    };

    document.getElementById('rv-funnel-backdrop').addEventListener('click', function (ev) {
      if (ev.target.id === 'rv-funnel-backdrop') closeFunnel();
    });
  }

  function bind() {
    ensureDom();
    document.addEventListener('click', onDocClick, true);
    wireControls();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.CD1RvPricingFunnel = { open: openFunnel, close: closeFunnel };
})();
