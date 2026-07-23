/**
 * Saved-vehicle card display helpers (Stage 2B).
 * Usable from Node tests (CommonJS) and the browser (global CD1VehicleCard).
 * Never logs PII. Escapes all customer-controlled text when rendering HTML.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CD1VehicleCard = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CATEGORY_LABELS = {
    car: 'Car',
    suv: 'SUV',
    truck: 'Truck',
    van: 'Van',
    boat: 'Boat',
    rv: 'RV',
    motorcycle: 'Motorcycle',
    atv: 'ATV',
    other: 'Other',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cleanText(value) {
    if (value == null) return '';
    var text = String(value).trim();
    if (!text) return '';
    if (/^(undefined|null)$/i.test(text)) return '';
    return text;
  }

  function categoryLabel(category) {
    var raw = cleanText(category).toLowerCase();
    if (!raw) return '';
    if (CATEGORY_LABELS[raw]) return CATEGORY_LABELS[raw];
    // Reject long helper/description leakage; only short tokens are displayable.
    if (raw.length > 24 || /\s{2,}/.test(raw) || /select|choose|priced|package/i.test(raw)) {
      return '';
    }
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function vehicleIdentity(vehicle) {
    var v = vehicle || {};
    return [cleanText(v.year), cleanText(v.make), cleanText(v.model)]
      .filter(Boolean)
      .join(' ');
  }

  function vehicleTitle(vehicle) {
    var v = vehicle || {};
    var label = cleanText(v.label);
    var identity = vehicleIdentity(v);
    var category = categoryLabel(v.category);
    return label || identity || category || 'Vehicle';
  }

  function vehicleMetaLine(vehicle) {
    var v = vehicle || {};
    var parts = [];
    var cat = categoryLabel(v.category);
    var color = cleanText(v.color);
    // Never emit the static word "Color" — only the saved value.
    if (cat) parts.push(cat);
    if (color) parts.push(color);
    return parts.join(' · ');
  }

  /**
   * @param {object} vehicle
   * @param {{ escapeHtml?: function, includeActions?: boolean }=} opts
   */
  function renderSavedVehicleCardHtml(vehicle, opts) {
    var options = opts || {};
    var esc = typeof options.escapeHtml === 'function' ? options.escapeHtml : escapeHtml;
    var includeActions = options.includeActions !== false;
    var v = vehicle || {};
    var label = cleanText(v.label);
    var identity = vehicleIdentity(v);
    var title = vehicleTitle(v);
    var meta = vehicleMetaLine(v);
    var showIdentityBelow = !!(label && identity);
    var def = v.isDefault ? ' <span class="card-kicker">Default</span>' : '';
    var id = cleanText(v.id);

    var html = '<li class="saved-vehicle-card">' +
      '<div class="saved-vehicle-body">' +
      '<div class="saved-vehicle-title"><strong>' + esc(title) + '</strong>' + def + '</div>' +
      (showIdentityBelow
        ? '<div class="saved-vehicle-identity">' + esc(identity) + '</div>'
        : '') +
      (meta ? '<div class="sub saved-vehicle-meta">' + esc(meta) + '</div>' : '') +
      '</div>';

    if (includeActions && id) {
      html += '<div class="actions" style="margin-top:6px">' +
        '<button type="button" class="btn ghost" data-vehicle-edit="' + esc(id) + '">Edit</button>' +
        (!v.isDefault
          ? '<button type="button" class="btn ghost" data-vehicle-default="' + esc(id) + '">Make default</button>'
          : '') +
        '<button type="button" class="btn ghost" data-vehicle-archive="' + esc(id) + '">Remove</button>' +
        '</div>';
    }

    html += '</li>';
    return html;
  }

  return {
    CATEGORY_LABELS: CATEGORY_LABELS,
    escapeHtml: escapeHtml,
    cleanText: cleanText,
    categoryLabel: categoryLabel,
    vehicleIdentity: vehicleIdentity,
    vehicleTitle: vehicleTitle,
    vehicleMetaLine: vehicleMetaLine,
    renderSavedVehicleCardHtml: renderSavedVehicleCardHtml,
  };
}));
