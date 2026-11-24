/* Car add-on rules for NEW bookings + "What's included" details on add-on cards.
 *
 * Shared by the booking pages (browser) and the server (submit-booking and the
 * customer portal), so what the customer can pick and what the server accepts
 * come from one table.
 *
 * Scope is deliberately narrow:
 *   - two car add-ons retired from new bookings (Engine Bay Detail $125,
 *     Mobile Water Supply $50); the $45 Engine Bay Top Clean is untouched;
 *   - car package blocks for Maintenance Detail and Super Interior placement.
 * Every add-on stays an independent, separately priced service; pricing lives
 * in booking-price-catalog.js and is not changed here. The existing exterior
 * matrix in ceramic-booking.js is not changed, and other vehicle categories
 * keep their own rules.
 *
 * Historical bookings: nothing here rewrites stored bookings. Eligibility is
 * enforced only when a customer submits a new booking or adds to one.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1AddonRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /*
   * One activation instant for every rule that depends on a date:
   *   - Premium Full Detail paste wax (#420): older bookings keep spray sealant;
   *   - Maintenance Detail paste wax: older bookings keep their composition;
   * Browser eligibility and add-on pricing do not use it.
   *
   * NOT APPROVED. The owner sets effectiveAt to the planned production publish
   * time (America/New_York wall-clock time with its explicit UTC offset) and
   * flips approved to true in the release commit. The release then runs
   * scripts/check-package-rules-activation.mjs, which refuses to proceed unless
   * the activation is approved and within 15 minutes of the publish time.
   * CD1_PACKAGE_RULES_EFFECTIVE_AT may override it on the server and must also
   * carry an explicit offset.
   */
  var PACKAGE_RULES_ACTIVATION = {
    effectiveAt: '2026-12-01T00:00:00-05:00',
    timeZone: 'America/New_York',
    approved: false,
  };

  var OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

  function parseActivation(value) {
    var s = String(value == null ? '' : value).trim();
    if (!OFFSET_ISO.test(s)) return null;
    var ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }

  function resolveActivation() {
    var env = null;
    try {
      if (typeof process !== 'undefined' && process.env) env = process.env.CD1_PACKAGE_RULES_EFFECTIVE_AT || null;
    } catch (e) { env = null; }
    var fromEnv = env ? parseActivation(env) : null;
    if (fromEnv != null) return { ms: fromEnv, source: 'env', invalidEnv: false };
    return { ms: parseActivation(PACKAGE_RULES_ACTIVATION.effectiveAt), source: 'constant', invalidEnv: !!env };
  }

  var ACTIVATION = resolveActivation();
  var RULES_EFFECTIVE_AT = new Date(ACTIVATION.ms).toISOString();

  /** True when a booking created at `createdAt` predates activation (no time = older). */
  function createdBeforeActivation(createdAt) {
    var created = Date.parse(String(createdAt || ''));
    if (!Number.isFinite(created)) return true;
    return created < ACTIVATION.ms;
  }

  var RETIRED_FOR_NEW_BOOKINGS = {
    cars: {
      engine_bay: 'Engine Bay Detail is no longer offered on new bookings.',
      mobile_water: 'Mobile Water Supply is no longer sold as an add-on; we bring our own water and power.',
    },
  };

  // Retired lines that older pages may still send without the customer having
  // chosen them (ceramic payloads carry mobile_water). They are dropped from a
  // new booking instead of refusing it, matching the existing ceramic strip.
  var DROPPED_FROM_NEW_BOOKINGS = {
    cars: ['mobile_water'],
  };

  var PACKAGE_BLOCKED = {
    cars: {
      // Maintenance stays a maintenance service: no deep interior work, and the
      // paste wax it includes is not sold again as a wax add-on.
      maint: ['superint', 'biohazard', 'odor', 'sanitize', 'wax1yr'],
      wash: ['superint'],
      refresh: ['superint'],
      // Premium Full Detail includes hand-applied premium paste wax.
      full: ['wax1yr'],
    },
  };

  // Every add-on is an independent, separately priced service. Super Interior
  // is an intensive stain treatment only; it includes no other add-on.
  var DETAILS = {
    cars: {
      superint: {
        description: 'Double shampoo for heavy stains and enhanced extraction for heavily soiled interiors. Ideal for vehicles requiring extra attention, including those affected by stubborn stains, pet hair or lingering odors.',
        items: [
          'A second shampoo and extraction pass on heavily stained seats, carpets, and fabric surfaces.',
          'Additional extraction time on the areas that need more intensive treatment than the shampoo already included in your package.',
        ],
        limits: 'Deep or permanent stains may be lightened rather than fully removed. Results depend on the material and its condition.',
        note: 'Specialized Pet Hair Removal and Odor Treatment are available separately.',
      },
      pethair: {
        items: [],
        limits: 'Very heavy or deeply embedded buildup may need an estimate before work, which is only charged with your approval.',
      },
      odor: {
        items: [],
        limits: 'Odors embedded in materials may be reduced rather than eliminated. Mold, urine or biohazard need inspection first.',
      },
    },
  };

  function str(v) {
    return String(v == null ? '' : v).trim();
  }

  function list(map, cat) {
    return (map[str(cat)] || {});
  }

  function isRetired(cat, id) {
    return Object.prototype.hasOwnProperty.call(list(RETIRED_FOR_NEW_BOOKINGS, cat), str(id));
  }

  function isBlockedForPackage(cat, pkgId, id) {
    var blocked = list(PACKAGE_BLOCKED, cat)[str(pkgId)] || [];
    return blocked.indexOf(str(id)) >= 0;
  }

  function isOfferable(cat, pkgId, id) {
    return !isRetired(cat, id) && !isBlockedForPackage(cat, pkgId, id);
  }

  function vehicleAddonIds(vehicle) {
    var ids = [];
    (Array.isArray(vehicle && vehicle.addons) ? vehicle.addons : []).forEach(function (a) {
      var id = str(a && (a.id || a.addonId));
      if (id) ids.push(id);
    });
    (Array.isArray(vehicle && vehicle.addOnIds) ? vehicle.addOnIds : []).forEach(function (id) {
      if (str(id)) ids.push(str(id));
    });
    return ids;
  }

  function isDropped(cat, id) {
    return (DROPPED_FROM_NEW_BOOKINGS[str(cat)] || []).indexOf(str(id)) >= 0;
  }

  /** Server, NEW booking only: remove dropped lines (never charged). */
  function stripDroppedFromNewBooking(booking) {
    var vehicles = Array.isArray(booking && booking.vehicles) ? booking.vehicles : [];
    vehicles.forEach(function (v) {
      if (!v) return;
      var cat = str(v.cat || v.category || (booking && booking.vehicleCategory)).toLowerCase();
      if (Array.isArray(v.addons)) {
        v.addons = v.addons.filter(function (a) { return !isDropped(cat, a && (a.id || a.addonId)); });
      }
      if (Array.isArray(v.addOnIds)) {
        v.addOnIds = v.addOnIds.filter(function (id) { return !isDropped(cat, id); });
      }
    });
    return booking;
  }

  /** Server check for a NEW booking submission (after stripDroppedFromNewBooking). */
  function validateNewBookingAddons(booking) {
    var vehicles = Array.isArray(booking && booking.vehicles) && booking.vehicles.length
      ? booking.vehicles
      : [{
        cat: booking && (booking.vehicleCategory || booking.category),
        pkgId: booking && (booking.packageId || booking.pkgId),
        addons: booking && booking.addons,
      }];
    for (var i = 0; i < vehicles.length; i += 1) {
      var v = vehicles[i] || {};
      var cat = str(v.cat || v.category || (booking && booking.vehicleCategory)).toLowerCase();
      var pkgId = str(v.packageId || v.pkgId);
      var ids = vehicleAddonIds(v);
      for (var j = 0; j < ids.length; j += 1) {
        if (isDropped(cat, ids[j])) continue;
        if (!isOfferable(cat, pkgId, ids[j])) {
          return { ok: false, error: 'addon_not_available', addonId: ids[j], packageId: pkgId, category: cat };
        }
      }
    }
    return { ok: true };
  }

  /**
   * Customer-initiated change to an EXISTING booking: only the newly requested
   * add-ons are checked. Lines already on the booking are never re-validated
   * or repriced here.
   */
  function validateAddedAddons(cat, pkgId, addonIds) {
    var ids = (addonIds || []).map(str).filter(Boolean);
    for (var i = 0; i < ids.length; i += 1) {
      if (!isOfferable(str(cat).toLowerCase(), pkgId, ids[i])) {
        return { ok: false, error: 'addon_not_available', addonId: ids[i], packageId: str(pkgId) };
      }
    }
    return { ok: true };
  }

  /**
   * Customer-initiated package change: the new package must not be one that
   * blocks an add-on the vehicle already carries (e.g. Super Interior on
   * Maintenance). Retired add-ons already on the booking stay as contracted.
   */
  function validatePackageChange(cat, newPkgId, existingAddonIds) {
    var ids = (existingAddonIds || []).map(str).filter(Boolean);
    for (var i = 0; i < ids.length; i += 1) {
      if (isBlockedForPackage(str(cat).toLowerCase(), newPkgId, ids[i])) {
        return { ok: false, error: 'addon_incompatible_with_package', addonId: ids[i], packageId: str(newPkgId) };
      }
    }
    return { ok: true };
  }

  function detailsFor(cat, addon) {
    var d = list(DETAILS, cat)[str(addon && addon.id)];
    return {
      description: d && d.description ? d.description : str(addon && addon.desc),
      items: d ? d.items.slice() : [],
      limits: d ? d.limits : '',
      note: d && d.note ? d.note : '',
    };
  }

  var api = {
    RULES_EFFECTIVE_AT: RULES_EFFECTIVE_AT,
    PACKAGE_RULES_ACTIVATION: PACKAGE_RULES_ACTIVATION,
    ACTIVATION_SOURCE: ACTIVATION.source,
    ACTIVATION_INVALID_ENV: ACTIVATION.invalidEnv,
    parseActivation: parseActivation,
    createdBeforeActivation: createdBeforeActivation,
    RETIRED_FOR_NEW_BOOKINGS: RETIRED_FOR_NEW_BOOKINGS,
    PACKAGE_BLOCKED: PACKAGE_BLOCKED,
    DETAILS: DETAILS,
    isRetired: isRetired,
    isBlockedForPackage: isBlockedForPackage,
    isOfferable: isOfferable,
    DROPPED_FROM_NEW_BOOKINGS: DROPPED_FROM_NEW_BOOKINGS,
    stripDroppedFromNewBooking: stripDroppedFromNewBooking,
    validateNewBookingAddons: validateNewBookingAddons,
    validateAddedAddons: validateAddedAddons,
    validatePackageChange: validatePackageChange,
    vehicleAddonIds: vehicleAddonIds,
    detailsFor: detailsFor,
  };

  if (typeof window === 'undefined' || typeof document === 'undefined') return api;

  /* ── Browser: booking add-on grid ─────────────────────────────────────── */

  var STYLE = [
    '.cd1-addon-unavailable{display:none!important}',
    '.cd1-addon-more{grid-column:1/-1;justify-self:start;margin:4px 0 0;padding:2px 0;border:0;background:none;color:var(--blue,#2563eb);font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
    '.cd1-addon-more:focus-visible,.cd1-addon-dialog button:focus-visible{outline:2px solid #2563eb;outline-offset:2px;border-radius:4px}',
    '.cd1-addon-dialog{margin:auto;inset:0;border:0;padding:0;background:#fff;color:#0f172a;width:calc(100% - 32px);max-width:460px;max-height:min(85vh,640px);overflow-y:auto;-webkit-overflow-scrolling:touch;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.35);text-align:left;font-size:14px;line-height:1.55}',
    '.cd1-addon-dialog::backdrop{background:rgba(15,23,42,.55)}',
    '.cd1-addon-dialog[open]:not(:modal){position:fixed;inset:0;margin:auto;z-index:2147483000}',
    '.cd1-addon-dialog-inner{padding:18px 18px 16px}',
    '.cd1-addon-dialog-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;margin:0 0 8px}',
    '.cd1-addon-dialog h3{margin:0;font-size:17px;line-height:1.3}',
    '.cd1-addon-dialog .cd1-addon-dialog-price{font-weight:700;white-space:nowrap;margin:2px 0 0;color:#2563eb}',
    '.cd1-addon-dialog-close{flex-shrink:0;width:32px;height:32px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;color:#0f172a;font-size:18px;line-height:1;cursor:pointer}',
    '.cd1-addon-dialog p{margin:0 0 10px}',
    '.cd1-addon-dialog ul{margin:0 0 10px;padding-left:20px}',
    '.cd1-addon-dialog li{margin:0 0 6px}',
    '.cd1-addon-dialog .cd1-addon-limits{font-size:12.5px;color:#475569;border-top:1px solid #e2e8f0;padding-top:10px;margin:4px 0 0}',
    '.cd1-expect{margin:0 0 12px;padding:10px 12px;border:1px solid rgba(37,99,235,.25);border-radius:10px;background:rgba(37,99,235,.06);font-size:12.5px;line-height:1.5;text-align:left}',
    '.cd1-expect[hidden]{display:none}',
    '.cd1-expect button{margin-left:4px;padding:0;border:0;background:none;color:var(--blue,#2563eb);font:inherit;font-weight:600;text-decoration:underline;cursor:pointer}',
    '.cd1-notes-hint{margin:6px 0 0;font-size:12px;line-height:1.45;opacity:.85}',
    '.cd1-notes-hint[hidden]{display:none}',
    '.cd1-feature,.cd1-more{grid-column:1/-1;margin:0 0 12px;text-align:left}',
    '.cd1-feature-label{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.75;margin:0 0 6px}',
    '.cd1-feature-note{font-size:12px;opacity:.8;margin:6px 0 0}',
    '.cd1-more-toggle{display:flex;width:100%;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border:1px solid rgba(37,99,235,.3);border-radius:10px;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-align:left}',
    '.cd1-more-toggle:focus-visible{outline:2px solid #2563eb;outline-offset:2px}',
    '.cd1-more-toggle .cd1-more-count{font-weight:500;opacity:.75;font-size:12px}',
    '.cd1-more-panel{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin-top:10px}',
    '.cd1-more-panel[hidden]{display:none}',
    '.cd1-empty{display:none!important}',
  ].join('');

  function page(name) {
    try {
      // Page scripts declare these at top level; window[name] is the same binding.
      if (typeof window[name] !== 'undefined') return window[name];
    } catch (e) { /* ignore */ }
    return undefined;
  }

  function state() {
    var st = page('ST');
    try { if (!st && typeof ST !== 'undefined') st = ST; } catch (e) { /* ignore */ } // eslint-disable-line no-undef
    return st || null;
  }

  function pricing() {
    var p = page('PRICING');
    try { if (!p && typeof PRICING !== 'undefined') p = PRICING; } catch (e) { /* ignore */ } // eslint-disable-line no-undef
    return p || null;
  }

  function call(name) {
    var fn = page(name);
    if (typeof fn === 'function') {
      try { fn(); } catch (e) { /* display only */ }
    }
  }

  function refreshTotals() {
    call('recalcAddonTotal');
    call('updateTotal');
    call('updateAddonSummary');
    call('syncActiveConfigIntoEditingCartSlot');
    if (typeof page('renderVehicleCart') === 'function') call('renderVehicleCart');
    else call('syncBs2StickyBar');
  }

  function catalogAddon(cat, id) {
    var p = pricing();
    var rows = (p && p[cat] && p[cat].addons) || [];
    for (var i = 0; i < rows.length; i += 1) if (rows[i] && rows[i].id === id) return rows[i];
    return null;
  }

  function cards() {
    return Array.prototype.slice.call(document.querySelectorAll('#addon-grid .addon[data-id]'));
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function stop(e) {
    e.stopPropagation();
  }

  // One shared native <dialog>. showModal() puts it on the top layer, above the
  // booking modal, and gives Escape-to-close and focus containment for free. It
  // is never inside a card, so it cannot change card or grid layout.
  var dialog = null;
  var returnFocus = null;

  function closeDialog() {
    if (!dialog) return;
    var box = dialog.box;
    if (typeof box.close === 'function' && box.open) box.close();
    else box.removeAttribute('open');
  }

  function onDialogClosed() {
    if (returnFocus) {
      returnFocus.setAttribute('aria-expanded', 'false');
      try { returnFocus.focus(); } catch (e) { /* ignore */ }
    }
    returnFocus = null;
  }

  function ensureDialog() {
    if (dialog) return dialog;
    var box = el('dialog', 'cd1-addon-dialog');
    box.id = 'cd1-addon-dialog';
    box.setAttribute('aria-labelledby', 'cd1-addon-dialog-title');
    box.addEventListener('close', onDialogClosed);
    // A click on the dialog's own box outside its content (the backdrop) closes it.
    box.addEventListener('click', function (e) { if (e.target === box) closeDialog(); });
    var head = el('div', 'cd1-addon-dialog-head');
    var titles = el('div');
    var title = el('h3');
    title.id = 'cd1-addon-dialog-title';
    var price = el('div', 'cd1-addon-dialog-price');
    titles.appendChild(title);
    titles.appendChild(price);
    var close = el('button', 'cd1-addon-dialog-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close details');
    close.addEventListener('click', closeDialog);
    head.appendChild(titles);
    head.appendChild(close);
    var body = el('div', 'cd1-addon-dialog-body');
    var inner = el('div', 'cd1-addon-dialog-inner');
    inner.appendChild(head);
    inner.appendChild(body);
    box.appendChild(inner);
    document.body.appendChild(box);
    dialog = { box: box, title: title, price: price, body: body, close: close };
    return dialog;
  }

  function openDialog(btn, addon, info) {
    var d = ensureDialog();
    d.title.textContent = addon.name || 'Add-on';
    d.price.textContent = '+$' + addon.price + (addon.qty ? ' each' : '');
    d.body.textContent = '';
    if (info.description) d.body.appendChild(el('p', '', info.description));
    if (info.items.length) {
      var ul = el('ul');
      info.items.forEach(function (item) { ul.appendChild(el('li', '', item)); });
      d.body.appendChild(ul);
    }
    if (info.limits) d.body.appendChild(el('p', 'cd1-addon-limits', info.limits));
    if (info.note) d.body.appendChild(el('p', 'cd1-addon-note', info.note));
    returnFocus = btn;
    btn.setAttribute('aria-expanded', 'true');
    if (typeof d.box.showModal === 'function') {
      if (!d.box.open) d.box.showModal();
    } else {
      d.box.setAttribute('open', '');
    }
    d.close.focus();
  }

  function decorate(card, cat) {
    if (card.querySelector('.cd1-addon-more')) return;
    var addon = catalogAddon(cat, card.getAttribute('data-id'));
    if (!addon) return;
    var info = detailsFor(cat, addon);
    if (!info.description && !info.items.length) return;
    var btn = el('button', 'cd1-addon-more', "What's included");
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'cd1-addon-dialog');
    btn.setAttribute('aria-label', "What's included: " + (addon.name || 'add-on'));
    // The button never toggles the card's selection.
    ['click', 'keydown', 'keyup', 'mousedown', 'touchstart'].forEach(function (type) {
      btn.addEventListener(type, stop);
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      openDialog(btn, addon, detailsFor(cat, catalogAddon(cat, addon.id) || addon));
    });
    card.appendChild(btn);
  }

  function selectedIds(st) {
    return ((st && st.addons) || []).map(function (a) { return a && a.id; });
  }

  function applyEligibility() {
    var st = state();
    if (!st) return false;
    var cat = str(st.cat);
    var pkg = str(st.pkgId);
    cards().forEach(function (card) {
      var ok = isOfferable(cat, pkg, card.getAttribute('data-id'));
      card.classList.toggle('cd1-addon-unavailable', !ok);
      if (ok) decorate(card, cat);
    });
    var before = (st.addons || []).length;
    st.addons = (st.addons || []).filter(function (a) { return a && isOfferable(cat, pkg, a.id); });
    return st.addons.length !== before;
  }

  // Interior-capable car packages: say plainly what the package covers and that
  // extras are optional and only charged with approval. Never selects anything.
  var EXPECT_PACKAGES = { interior: true, full: true, premium: true };
  var EXPECT_TEXT = 'Deep or permanent stains, embedded pet hair, and persistent odors may require additional specialized treatments. Results depend on the condition of the materials. Nothing extra is added or charged without your approval.';

  function renderExpectations() {
    var grid = document.getElementById('addon-grid');
    var st = state();
    if (!grid || !st) return;
    var box = document.getElementById('cd1-expect');
    var show = str(st.cat) === 'cars' && !!EXPECT_PACKAGES[str(st.pkgId)] && isOfferable('cars', st.pkgId, 'superint');
    if (!box) {
      if (!show) return;
      box = el('p', 'cd1-expect');
      box.id = 'cd1-expect';
      box.appendChild(el('span', '', EXPECT_TEXT));
      grid.parentNode.insertBefore(box, grid);
    }
    box.hidden = !show;
  }

  // Free-text notes are the only condition input today. Each condition maps to
  // its own treatment; nothing is selected and the booking is never blocked.
  var NOTE_SUGGESTIONS = [
    { re: /stain|spill|soiled|dirty (carpet|seat)/i, id: 'superint', label: 'Super Interior (heavy stains)' },
    { re: /\bpets?\b|\bdogs?\b|\bcats?\b|\bfur\b|\bhair\b|shedding/i, id: 'pethair', label: 'Pet Hair Removal' },
    { re: /odou?r|smell|smok|musty/i, id: 'odor', label: 'Odor Treatment' },
    { re: /mold|mildew/i, id: 'mold', label: 'Mold Treatment' },
  ];
  var HAZARD_PATTERN = /vomit|urine|blood|feces|bodily|biohazard/i;

  function updateNotesHint() {
    var notes = document.getElementById('f-notes');
    var st = state();
    if (!notes || !st) return;
    var hint = document.getElementById('cd1-notes-hint');
    if (!hint) {
      hint = el('p', 'cd1-notes-hint');
      hint.id = 'cd1-notes-hint';
      hint.setAttribute('aria-live', 'polite');
      hint.hidden = true;
      notes.parentNode.insertBefore(hint, notes.nextSibling);
    }
    var text = notes.value || '';
    var cat = str(st.cat);
    var pkg = str(st.pkgId);
    var chosen = selectedIds(st);
    var picks = [];
    if (cat === 'cars' && EXPECT_PACKAGES[pkg]) {
      NOTE_SUGGESTIONS.forEach(function (s) {
        if (s.re.test(text) && chosen.indexOf(s.id) < 0 && isOfferable(cat, pkg, s.id)) picks.push(s.label);
      });
    }
    var hazard = cat === 'cars' && EXPECT_PACKAGES[pkg] && HAZARD_PATTERN.test(text);
    var parts = [];
    if (picks.length) parts.push('Optional treatments you can add in the Package step: ' + picks.join(', ') + '.');
    if (hazard) parts.push('Bodily fluids or other hazardous contamination need an inspection and their own cleaning protocol before booking.');
    if (parts.length) parts.push('Without them we\u2019ll do your package as booked and ask before any extra work.');
    hint.textContent = parts.join(' ');
    hint.hidden = !parts.length;
  }

  // Interior-capable car packages: Super Interior is shown first as a discreet
  // recommendation for heavily soiled interiors; the independent interior
  // add-ons move into a "View More Interior Add-ons" section. Cards are moved,
  // not copied, so selection, prices, handlers and eligibility stay intact.
  function interiorIds(cat) {
    var p = pricing();
    var rows = (p && p[cat] && p[cat].addons) || [];
    return rows.filter(function (a) { return a && a.scope === 'int' && a.id !== 'superint'; }).map(function (a) { return a.id; });
  }

  function isVisibleCard(c) {
    return !c.classList.contains('cd1-addon-unavailable') && c.style.display !== 'none' && !c.hidden;
  }

  function visibleAddons(container) {
    return Array.prototype.slice.call(container.querySelectorAll('.addon[data-id]')).filter(isVisibleCard);
  }

  function hideEmptyBlocks(grid) {
    Array.prototype.slice.call(grid.querySelectorAll('.addon-section-label, .addon-popular-label')).forEach(function (label) {
      var count = 0;
      var node = label.nextElementSibling;
      if (node && node.classList.contains('addon-grid-cols')) {
        count = visibleAddons(node).length;
        node.classList.toggle('cd1-empty', count === 0);
      } else {
        while (node && node.classList.contains('addon')) {
          if (isVisibleCard(node)) count += 1;
          node = node.nextElementSibling;
        }
      }
      label.classList.toggle('cd1-empty', count === 0);
    });
  }

  function arrangeInterior() {
    var grid = document.getElementById('addon-grid');
    var st = state();
    if (!grid || !st) return;
    var cat = str(st.cat);
    var pkg = str(st.pkgId);
    var feature = document.getElementById('cd1-feature');
    var more = document.getElementById('cd1-more');
    if (cat !== 'cars' || !EXPECT_PACKAGES[pkg] || !isOfferable(cat, pkg, 'superint')) return;
    var superCard = grid.querySelector('.addon[data-id="superint"]');
    if (!superCard) return;
    if (!feature) {
      feature = el('div', 'cd1-feature');
      feature.id = 'cd1-feature';
      feature.appendChild(el('p', 'cd1-feature-label', 'Recommended for heavily soiled interiors'));
      grid.insertBefore(feature, grid.firstChild);
    }
    feature.appendChild(superCard);
    if (!feature.querySelector('.cd1-feature-note')) {
      feature.appendChild(el('p', 'cd1-feature-note', 'Specialized Pet Hair Removal and Odor Treatment are available separately.'));
    } else {
      feature.appendChild(feature.querySelector('.cd1-feature-note'));
    }
    var ids = interiorIds(cat);
    var cardsToMove = ids.map(function (id) { return grid.querySelector('.addon[data-id="' + id + '"]'); })
      .filter(function (c) { return c && !c.classList.contains('cd1-addon-unavailable'); });
    if (!cardsToMove.length) return;
    if (!more) {
      more = el('div', 'cd1-more');
      more.id = 'cd1-more';
      var toggle = el('button', 'cd1-more-toggle');
      toggle.type = 'button';
      toggle.id = 'cd1-more-toggle';
      toggle.setAttribute('aria-controls', 'cd1-more-panel');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.appendChild(el('span', 'cd1-more-text', 'View More Interior Add-ons'));
      toggle.appendChild(el('span', 'cd1-more-count'));
      var panel = el('div', 'cd1-more-panel');
      panel.id = 'cd1-more-panel';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', 'More interior add-ons');
      panel.hidden = true;
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        var open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        panel.hidden = !open;
        toggle.querySelector('.cd1-more-text').textContent = open ? 'Hide Interior Add-ons' : 'View More Interior Add-ons';
      });
      more.appendChild(toggle);
      more.appendChild(panel);
      feature.parentNode.insertBefore(more, feature.nextSibling);
    }
    var panelEl = document.getElementById('cd1-more-panel');
    cardsToMove.forEach(function (c) { panelEl.appendChild(c); });
    var countEl = more.querySelector('.cd1-more-count');
    if (countEl) countEl.textContent = cardsToMove.length + ' options';
    // Never hide a choice the customer already made.
    var chosen = selectedIds(st);
    if (cardsToMove.some(function (c) { return chosen.indexOf(c.getAttribute('data-id')) >= 0; })) {
      var tg = document.getElementById('cd1-more-toggle');
      if (tg && tg.getAttribute('aria-expanded') !== 'true') tg.click();
    }
    hideEmptyBlocks(grid);
  }

  function afterRender() {
    if (applyEligibility()) refreshTotals();
    try { arrangeInterior(); } catch (e) { /* layout only */ }
    renderExpectations();
  }

  function wrap(name, wrapper) {
    var fn = page(name);
    if (typeof fn !== 'function' || fn._cd1AddonRules) return;
    var wrapped = wrapper(fn);
    wrapped._cd1AddonRules = true;
    if (fn._ceramicWrapped) wrapped._ceramicWrapped = true;
    window[name] = wrapped;
  }

  function boot() {
    if (!document.getElementById('cd1-addon-rules-style')) {
      var style = el('style');
      style.id = 'cd1-addon-rules-style';
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    wrap('renderAddons', function (fn) {
      return function () {
        var result = fn.apply(this, arguments);
        try { afterRender(); } catch (e) { /* display only */ }
        return result;
      };
    });
    if (document.getElementById('addon-grid') && cards().length) afterRender();
    document.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'f-notes') updateNotesHint();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return api;
});
