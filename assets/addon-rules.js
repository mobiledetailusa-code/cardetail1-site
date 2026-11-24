/* Car add-on rules for NEW bookings + "What's included" details on add-on cards.
 *
 * Shared by the booking pages (browser) and the server (submit-booking and the
 * price catalog), so what the customer can pick and what the server accepts
 * come from one table.
 *
 * Scope is deliberately narrow:
 *   - two car add-ons retired from new bookings (Engine Bay Detail $125,
 *     Mobile Water Supply $50); the $45 Engine Bay Top Clean is untouched;
 *   - car package blocks for Maintenance Detail and Super Interior placement;
 *   - Super Interior bundles pet hair, odor and floor mats for cars.
 * The existing exterior matrix in ceramic-booking.js is not changed, and other
 * vehicle categories keep their own rules.
 *
 * Historical bookings: nothing here rewrites stored bookings. The bundle only
 * prices bookings created at or after RULES_EFFECTIVE_AT; eligibility is
 * enforced only when a new booking is submitted.
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
   *   - Super Interior coverage for stored bookings without an includedWith mark.
   * Browser eligibility does not use it: it is live from the deploy. Lines sold
   * as covered carry includedWith: 'superint' and stay covered regardless.
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

  var SUPERINT_BUNDLE = {
    cars: ['pethair', 'odor', 'floormats'],
  };

  // What the card says when Super Interior covers it: the standard level only,
  // matching the Super Interior details. The included line is dropped from the
  // booking (never stored with a quantity), so it cannot be multiplied.
  var SUPERINT_INCLUDED_NOTES = {
    cars: {
      pethair: 'Included with Super Interior (moderate pet hair)',
      odor: 'Included with Super Interior (common odors)',
      floormats: 'Included with Super Interior (this vehicle’s own mats)',
    },
  };

  function includedNote(cat, id) {
    return (SUPERINT_INCLUDED_NOTES[str(cat)] || {})[str(id)] || 'Included with Super Interior';
  }

  var DETAILS = {
    cars: {
      superint: {
        items: [
          'Double shampoo for heavy stains: up to two total shampoo/extraction passes on upholstery and carpet where needed, as the material and its condition allow.',
          'Enhanced interior cleaning: extra time on heavily soiled carpets, seats and high-use surfaces.',
          'Additional attention to problem areas.',
          'Moderate pet hair removal.',
          'Targeted treatment for common interior odors.',
          'Extra cleaning of this vehicle’s own floor mats.',
        ],
        limits: 'Super Interior is an optional upgrade for interiors that need more intensive work. Stains and odors are reduced, not guaranteed to be removed, and it does not restore severely deteriorated interiors. Embedded pet hair, smoke, mold, biological contamination or deeply embedded odors may need inspection and a separate quote, which is only charged with your approval.',
      },
      pethair: {
        items: [],
        limits: 'With Super Interior, pet hair removal at the moderate level is included at no extra charge. Embedded or very heavy pet hair may need an estimate before work and is only charged with your approval.',
      },
      odor: {
        items: [],
        limits: 'With Super Interior, treatment of common odors is included at no extra charge. Odors embedded in materials are reduced rather than guaranteed to be eliminated; mold, urine or biohazard need inspection.',
      },
      floormats: {
        items: [],
        limits: 'Priced per mat. With Super Interior, cleaning of this vehicle’s own floor mats is included at no extra charge.',
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

  function bundledIds(cat) {
    return (SUPERINT_BUNDLE[str(cat)] || []).slice();
  }

  /** Ids priced at $0 because Super Interior is on the same vehicle. */
  function includedBySuperint(cat, selectedIds) {
    var ids = (selectedIds || []).map(str);
    return ids.indexOf('superint') >= 0 ? bundledIds(cat) : [];
  }

  /**
   * The bundle prices a new booking submission (opts.newBooking) and bookings
   * created at or after RULES_EFFECTIVE_AT. A booking with no creation time is
   * treated as stored history, so repricing an older booking never drops lines.
   */
  function bundleActiveFor(booking, opts) {
    if (opts && opts.newBooking === true) return true;
    return !createdBeforeActivation(booking && booking.createdAt);
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
      description: str(addon && addon.desc),
      items: d ? d.items.slice() : [],
      limits: d ? d.limits : '',
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
    SUPERINT_BUNDLE: SUPERINT_BUNDLE,
    SUPERINT_INCLUDED_NOTES: SUPERINT_INCLUDED_NOTES,
    includedNote: includedNote,
    DETAILS: DETAILS,
    isRetired: isRetired,
    isBlockedForPackage: isBlockedForPackage,
    isOfferable: isOfferable,
    bundledIds: bundledIds,
    includedBySuperint: includedBySuperint,
    bundleActiveFor: bundleActiveFor,
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
    '.cd1-addon-covered .addon-price{text-decoration:line-through;opacity:.6}',
    '.cd1-addon-included-note{grid-column:1/-1;font-size:11.5px;font-weight:600;margin-top:2px}',
    '.cd1-expect{margin:0 0 12px;padding:10px 12px;border:1px solid rgba(37,99,235,.25);border-radius:10px;background:rgba(37,99,235,.06);font-size:12.5px;line-height:1.5;text-align:left}',
    '.cd1-expect[hidden]{display:none}',
    '.cd1-expect button{margin-left:4px;padding:0;border:0;background:none;color:var(--blue,#2563eb);font:inherit;font-weight:600;text-decoration:underline;cursor:pointer}',
    '.cd1-notes-hint{margin:6px 0 0;font-size:12px;line-height:1.45;opacity:.85}',
    '.cd1-notes-hint[hidden]{display:none}',
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

  function catalogPrice(cat, id) {
    var row = catalogAddon(cat, id);
    return row ? Number(row.price) || 0 : 0;
  }

  // Super Interior covers the standard level of pet hair, odor and floor mats.
  // Those add-ons stay visible and selectable; a selected one stays on the
  // booking at $0 (one unit) while Super Interior is on, and returns to its
  // catalog price if Super Interior is removed. Nothing is removed for the
  // customer and nothing is charged twice. Mirrors computeAddonTotal.
  function applyBundle() {
    var st = state();
    if (!st) return false;
    var cat = str(st.cat);
    var covered = includedBySuperint(cat, selectedIds(st));
    var changed = false;
    (st.addons || []).forEach(function (a) {
      if (!a || bundledIds(cat).indexOf(a.id) < 0) return;
      if (covered.indexOf(a.id) >= 0) {
        if (a.price !== 0 || (a.qty && a.qty !== 1) || a.includedWith !== 'superint') changed = true;
        a.price = 0;
        if (a.qty) a.qty = 1;
        a.includedWith = 'superint';
        var qtyEl = document.getElementById('aq-' + a.id);
        if (qtyEl && a.qty) qtyEl.textContent = '1';
      } else if (a.includedWith === 'superint') {
        a.price = catalogPrice(cat, a.id);
        delete a.includedWith;
        changed = true;
      }
    });
    bundledIds(cat).forEach(function (id) {
      var card = document.querySelector('#addon-grid .addon[data-id="' + id + '"]');
      if (!card) return;
      var on = covered.indexOf(id) >= 0;
      card.classList.toggle('cd1-addon-covered', on);
      var note = card.querySelector('.cd1-addon-included-note');
      if (on && !note) {
        card.appendChild(el('div', 'cd1-addon-included-note', includedNote(cat, id) + ' — no extra charge'));
      } else if (!on && note) {
        note.remove();
      }
    });
    return changed;
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
  var EXPECT_TEXT = 'Results depend on your vehicle’s condition. Your package includes a complete interior clean; very deep or permanent stains, persistent odors and embedded pet hair may need a dedicated treatment. Nothing extra is added or charged without your approval.';

  function openSuperintDetails(from) {
    var addon = catalogAddon('cars', 'superint');
    if (addon) openDialog(from, addon, detailsFor('cars', addon));
  }

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
      box.appendChild(el('span', '', EXPECT_TEXT + ' '));
      var more = el('button', '', 'See Super Interior');
      more.type = 'button';
      more.setAttribute('aria-haspopup', 'dialog');
      more.addEventListener('click', function (e) { e.preventDefault(); openSuperintDetails(more); });
      box.appendChild(more);
      grid.parentNode.insertBefore(box, grid);
    }
    box.hidden = !show;
  }

  var NOTES_PATTERN = /stain|odou?r|smell|smok|pet|dog|cat hair|hair|vomit|urine|mold|mildew|spill/i;

  function updateNotesHint() {
    var notes = document.getElementById('f-notes');
    var st = state();
    if (!notes || !st) return;
    var hint = document.getElementById('cd1-notes-hint');
    if (!hint) {
      hint = el('p', 'cd1-notes-hint');
      hint.id = 'cd1-notes-hint';
      hint.setAttribute('aria-live', 'polite');
      hint.textContent = 'Mentioned stains, odors or pet hair? You can go back to the Package step to add Super Interior, Pet Hair Removal or Odor Treatment. Otherwise we’ll do the standard clean and ask before any extra work.';
      hint.hidden = true;
      notes.parentNode.insertBefore(hint, notes.nextSibling);
    }
    var ids = selectedIds(st);
    var relevant = str(st.cat) === 'cars' && !!EXPECT_PACKAGES[str(st.pkgId)]
      && ids.indexOf('superint') < 0 && ids.indexOf('pethair') < 0 && ids.indexOf('odor') < 0;
    hint.hidden = !(relevant && NOTES_PATTERN.test(notes.value || ''));
  }

  function afterRender() {
    var changed = applyEligibility();
    if (applyBundle() || changed) refreshTotals();
    renderExpectations();
  }

  // While Super Interior covers floor mats, one unit is all that is included.
  function coveredQtyBlocked(id, delta) {
    var st = state();
    if (!st || !(delta > 0)) return false;
    if (includedBySuperint(str(st.cat), selectedIds(st)).indexOf(str(id)) < 0) return false;
    return (st.addons || []).some(function (a) { return a && a.id === id; });
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
    wrap('toggleAddon', function (fn) {
      return function (card) {
        var result = fn.apply(this, arguments);
        try { if (applyBundle()) refreshTotals(); } catch (e) { /* display only */ }
        return result;
      };
    });
    wrap('addonQty', function (fn) {
      return function (id, delta) {
        if (coveredQtyBlocked(id, delta)) return undefined;
        var result = fn.apply(this, arguments);
        try { if (applyBundle()) refreshTotals(); } catch (e) { /* display only */ }
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
