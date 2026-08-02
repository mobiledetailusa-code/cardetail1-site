/*!
 * Cardetail1 — canonical multi-vehicle booking line-item projection.
 *
 * One projection feeds Review & Submit, the confirmation-success screen and the
 * transactional confirmation email, so a booking itemizes identically wherever
 * it is shown (and matches the Admin / My Garage per-vehicle cards).
 *
 * This module NEVER prices anything. It reads the authoritative per-vehicle
 * amounts already produced by the pricing layer (canonical-quote server-side,
 * the vehicle cart client-side) and only normalizes and formats them.
 *
 * UMD: usable as a browser global (window.Cardetail1LineItems) and as a
 * CommonJS module from Netlify Functions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Cardetail1LineItems = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(value) {
    if (value === '' || value === null || value === undefined) return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function money(value) {
    return '$' + (Number(value) || 0).toFixed(2);
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * True when the label already states this length, so we never render the
   * duplicated "22 ft · 22 ft" seen in production. Digit boundaries keep
   * "222S" from matching a 22 ft boat.
   */
  function labelStatesLength(label, len) {
    if (!len) return false;
    var re = new RegExp('(^|[^0-9.])' + len + "\\s*(ft\\b|ft\\.|feet\\b|')", 'i');
    return re.test(String(label || ''));
  }

  function vehicleLabel(vehicle) {
    var v = vehicle || {};
    var explicit = String(v.vehicleLabel || v.label || '').trim();
    var built = [v.year, v.make || v.vehicleMake, v.model || v.vehicleModel]
      .filter(Boolean).join(' ').trim();
    var label = explicit || built || 'Vehicle';
    var len = num(v.lengthFt != null ? v.lengthFt : v.vehicleLengthFt);
    if (len && len > 0 && !labelStatesLength(label, len)) {
      label += ' — ' + len + ' ft';
    }
    return label;
  }

  function normalizeAddons(list) {
    return (Array.isArray(list) ? list : []).reduce(function (out, a) {
      if (!a || typeof a !== 'object') return out;
      var qty = num(a.qty);
      qty = qty && qty > 0 ? qty : 1;
      var price = num(a.price != null ? a.price : a.amount);
      var lineTotal = num(a.lineTotal);
      if (lineTotal === null) lineTotal = price === null ? null : price * qty;
      out.push({
        id: a.id || '',
        name: String(a.name || a.id || 'Add-on'),
        qty: qty,
        price: price,
        lineTotal: lineTotal,
      });
      return out;
    }, []);
  }

  /**
   * Normalize one booking vehicle into a stable, self-consistent line item.
   * Authoritative amounts win; derivation is only a fallback for legacy rows.
   */
  function normalizeVehicle(vehicle, index) {
    var v = vehicle || {};
    var addons = normalizeAddons(v.addons);

    var packagePrice = num(v.basePrice);
    if (packagePrice === null) packagePrice = num(v.packagePrice);

    var addonTotal = num(v.addonTotal);
    if (addonTotal === null) {
      addonTotal = addons.reduce(function (s, a) { return s + (a.lineTotal || 0); }, 0);
    }

    var subtotal = num(v.subtotal);
    if (subtotal === null) subtotal = (packagePrice || 0) + (addonTotal || 0);

    return {
      key: String(v.vehicleId || v.id || ('vehicle-' + index)),
      index: index,
      label: vehicleLabel(v),
      packageName: String(v.pkgName || v.packageName || v.package || 'Package'),
      packagePrice: packagePrice,
      addons: addons,
      addonTotal: addonTotal,
      subtotal: subtotal,
    };
  }

  /** Legacy single-vehicle payloads (no vehicles[]) still itemize. */
  function legacyVehicleFrom(booking) {
    var b = booking || {};
    var hasAny = b.vehicle || b.vehicleLabel || b.package || b.packagePrice != null;
    if (!hasAny) return null;
    return {
      vehicleLabel: b.vehicleLabel || b.vehicle || '',
      lengthFt: b.lengthFt,
      pkgName: b.package || '',
      basePrice: b.packagePrice,
      addons: b.addons,
      addonTotal: b.addonTotal,
    };
  }

  /**
   * Project a booking (or a raw vehicles array) into ordered line items.
   * Order is the authoritative array order and is never re-sorted, so Review,
   * confirmation, email, Admin and My Garage all agree.
   */
  function projectBooking(booking) {
    var source = Array.isArray(booking) ? booking : (booking && booking.vehicles);
    var list = Array.isArray(source) ? source.filter(function (v) { return v && typeof v === 'object'; }) : [];
    if (!list.length && !Array.isArray(booking)) {
      var legacy = legacyVehicleFrom(booking);
      if (legacy) list = [legacy];
    }
    var items = list.map(normalizeVehicle);
    var itemsSubtotal = items.reduce(function (s, i) { return s + (i.subtotal || 0); }, 0);
    return { items: items, itemsSubtotal: itemsSubtotal, vehicleCount: items.length };
  }

  function addonLabel(a) {
    return a.name + (a.qty > 1 ? ' × ' + a.qty : '');
  }

  /**
   * Booking-modal markup for Review & Submit / confirmation-success.
   * Uses the existing .or/.ol/.ov row primitives so it inherits the light-theme
   * overrides, plus .bkli-* hooks from assets/booking-summary.css.
   */
  function renderSummaryHtml(items, options) {
    var opts = options || {};
    var list = Array.isArray(items) ? items : [];
    if (!list.length) {
      return '<div class="or"><span class="ol">Service</span><span class="ov">—</span></div>';
    }
    var multi = list.length > 1;
    return list.map(function (item, idx) {
      var rows = '';
      rows += '<div class="or"><span class="ol">' + esc(item.packageName) + '</span>' +
        '<span class="ov">' + (item.packagePrice === null ? 'Estimate' : esc(money(item.packagePrice))) + '</span></div>';
      if (item.addons.length) {
        rows += item.addons.map(function (a) {
          return '<div class="or"><span class="ol">+ ' + esc(addonLabel(a)) + '</span>' +
            '<span class="ov">' + (a.lineTotal === null ? '—' : '+' + esc(money(a.lineTotal))) + '</span></div>';
        }).join('');
      } else {
        rows += '<div class="or"><span class="ol">Add-ons</span><span class="ov bkli-none">None</span></div>';
      }
      if (multi || opts.alwaysShowSubtotal) {
        rows += '<div class="or bkli-subtotal"><span class="ol">Vehicle subtotal</span>' +
          '<span class="ov">' + esc(money(item.subtotal)) + '</span></div>';
      }
      return '<section class="bkli-vehicle" aria-label="' + esc('Vehicle ' + (idx + 1) + ' of ' + list.length) + '">' +
        '<h4 class="bkli-vehicle-title">' +
        (multi ? '<span class="bkli-vehicle-index">' + (idx + 1) + '</span>' : '') +
        '<span class="bkli-vehicle-name">' + esc(item.label) + '</span>' +
        '</h4>' + rows +
        '</section>';
    }).join('');
  }

  /** Plain-text itemization for the transactional email and admin text. */
  function summaryTextLines(items) {
    var list = Array.isArray(items) ? items : [];
    var lines = [];
    list.forEach(function (item, idx) {
      if (idx > 0) lines.push('');
      lines.push(item.label);
      lines.push('  ' + item.packageName + ': ' + (item.packagePrice === null ? 'Estimate' : money(item.packagePrice)));
      item.addons.forEach(function (a) {
        lines.push('  ' + addonLabel(a) + ': ' + (a.lineTotal === null ? '—' : money(a.lineTotal)));
      });
      lines.push('  Vehicle subtotal: ' + money(item.subtotal));
    });
    return lines;
  }

  /** Table-free, client-safe HTML itemization for the transactional email. */
  function summaryEmailHtml(items) {
    var list = Array.isArray(items) ? items : [];
    if (!list.length) return '';
    return list.map(function (item) {
      var rows = '<li>' + esc(item.packageName) + ': ' +
        esc(item.packagePrice === null ? 'Estimate' : money(item.packagePrice)) + '</li>';
      rows += item.addons.map(function (a) {
        return '<li>' + esc(addonLabel(a)) + ': ' + esc(a.lineTotal === null ? '—' : money(a.lineTotal)) + '</li>';
      }).join('');
      return '<div style="margin:0 0 14px">' +
        '<p style="margin:0 0 4px"><strong>' + esc(item.label) + '</strong></p>' +
        '<ul style="margin:0 0 4px;padding-left:20px">' + rows + '</ul>' +
        '<p style="margin:0">Vehicle subtotal: <strong>' + esc(money(item.subtotal)) + '</strong></p>' +
        '</div>';
    }).join('');
  }

  return {
    num: num,
    money: money,
    esc: esc,
    labelStatesLength: labelStatesLength,
    vehicleLabel: vehicleLabel,
    normalizeAddons: normalizeAddons,
    normalizeVehicle: normalizeVehicle,
    projectBooking: projectBooking,
    renderSummaryHtml: renderSummaryHtml,
    summaryTextLines: summaryTextLines,
    summaryEmailHtml: summaryEmailHtml,
  };
}));
