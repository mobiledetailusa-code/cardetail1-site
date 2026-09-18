/*!
 * Cardetail1 — Seasonal Driveway Cleanup (appointment-once convenience add-on).
 *
 * Prices live in booking-price-catalog / page PRICING. This module owns IDs,
 * parent/child rules, appointment-once normalization, and compact booking UI.
 *
 * UMD: browser booking pages and Netlify quote authority share the same rules.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1SeasonalDriveway = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PARENT_ID = 'seasonal_driveway_cleanup';

  var CHILD_IDS = Object.freeze([
    'walkway_steps',
    'porch_entry',
    'small_patio',
    'heavy_wet_leaf',
    'bag_place_property',
    'pressure_surface_wash',
  ]);

  var FAMILY_IDS = Object.freeze([PARENT_ID].concat(CHILD_IDS));
  var FAMILY_SET = {};
  FAMILY_IDS.forEach(function (id) { FAMILY_SET[id] = true; });

  var CHILD_SET = {};
  CHILD_IDS.forEach(function (id) { CHILD_SET[id] = true; });

  var ELIGIBLE_CATEGORIES = Object.freeze(['cars', 'rvs', 'powersports']);
  var ELIGIBLE_SET = { cars: true, rvs: true, powersports: true };

  var DISPLAY = Object.freeze({
    seasonal_driveway_cleanup: Object.freeze({
      name: 'Seasonal Driveway Cleanup',
      description: 'Add a quick seasonal cleanup while we\'re already on-site. Loose leaves and light debris are cleared from your driveway using professional blowing equipment. Available only with an eligible detailing appointment.',
    }),
    walkway_steps: Object.freeze({
      name: 'Front Walkway + Steps',
      description: 'Blower cleanup of the front walkway and entry steps.',
    }),
    porch_entry: Object.freeze({
      name: 'Porch / Entry Area',
      description: 'Blower cleanup of the immediate porch or entry hard-surface area.',
    }),
    small_patio: Object.freeze({
      name: 'Small Patio',
      description: 'Blower cleanup of one small residential patio adjacent to the entrance.',
    }),
    heavy_wet_leaf: Object.freeze({
      name: 'Heavy / Wet Leaf Buildup',
      description: 'Extra time for unusually heavy, wet, or matted leaf accumulation.',
    }),
    bag_place_property: Object.freeze({
      name: 'Bag & Place On Property',
      description: 'Leaves are bagged and placed at a customer-designated location on the property. Off-property disposal is not included.',
    }),
    pressure_surface_wash: Object.freeze({
      name: 'Pressure Surface Wash',
      description: 'Optional water-based surface cleaning. Weather permitting.',
    }),
  });

  var CHILD_GROUPS = Object.freeze([
    Object.freeze({
      label: 'Additional Areas',
      ids: Object.freeze(['walkway_steps', 'porch_entry', 'small_patio']),
    }),
    Object.freeze({
      label: 'Condition',
      ids: Object.freeze(['heavy_wet_leaf']),
    }),
    Object.freeze({
      label: 'Leaf Handling',
      ids: Object.freeze(['bag_place_property']),
    }),
    Object.freeze({
      label: 'Optional Surface Cleaning',
      ids: Object.freeze(['pressure_surface_wash']),
    }),
  ]);

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function vehicleCategory(vehicle) {
    return String((vehicle && (vehicle.cat || vehicle.category)) || '').trim().toLowerCase();
  }

  function isEligibleCategory(cat) {
    return !!ELIGIBLE_SET[String(cat || '').trim().toLowerCase()];
  }

  function isFamilyId(id) {
    return !!FAMILY_SET[String(id || '').trim()];
  }

  function isParentId(id) {
    return String(id || '').trim() === PARENT_ID;
  }

  function isChildId(id) {
    return !!CHILD_SET[String(id || '').trim()];
  }

  function displayFor(id) {
    return DISPLAY[String(id || '').trim()] || { name: String(id || 'Add-on'), description: '' };
  }

  function addonIdsFromVehicle(vehicle) {
    var fromIds = asArray(vehicle && vehicle.addOnIds)
      .map(function (id) { return String(id || '').trim(); })
      .filter(Boolean);
    if (fromIds.length) return fromIds;
    return asArray(vehicle && vehicle.addons)
      .map(function (a) { return String((a && (a.id || a.addonId)) || '').trim(); })
      .filter(Boolean);
  }

  function uniqueIds(ids) {
    var seen = {};
    var out = [];
    asArray(ids).forEach(function (raw) {
      var id = String(raw || '').trim();
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  function collectFamilyIds(vehicles) {
    var collected = [];
    asArray(vehicles).forEach(function (v) {
      addonIdsFromVehicle(v).forEach(function (id) {
        if (isFamilyId(id)) collected.push(id);
      });
    });
    return uniqueIds(collected);
  }

  function orderedFamily(ids) {
    var set = {};
    uniqueIds(ids).forEach(function (id) { set[id] = true; });
    return FAMILY_IDS.filter(function (id) { return set[id]; });
  }

  function primaryEligibleIndex(vehicles) {
    for (var i = 0; i < asArray(vehicles).length; i += 1) {
      if (isEligibleCategory(vehicleCategory(vehicles[i]))) return i;
    }
    return -1;
  }

  function withVehicleAddonIds(vehicle, ids) {
    var prev = {};
    asArray(vehicle && vehicle.addons).forEach(function (a) {
      if (a && a.id) prev[a.id] = a;
    });
    var nextIds = uniqueIds(ids);
    var addons = nextIds.map(function (id) {
      return prev[id] || { id: id };
    });
    return Object.assign({}, vehicle, {
      addOnIds: nextIds,
      addons: addons,
    });
  }

  /**
   * Collapse driveway-family IDs onto the first eligible vehicle.
   * Orphan children → addon_parent_required.
   * Family present with no eligible vehicle → addon_ineligible_category.
   */
  function normalizeAppointmentAddons(vehicles) {
    var list = asArray(vehicles).slice();
    var family = collectFamilyIds(list);
    if (!family.length) {
      return { ok: true, vehicles: list, familyIds: [] };
    }

    var hasParent = family.indexOf(PARENT_ID) >= 0;
    var children = family.filter(isChildId);
    if (children.length && !hasParent) {
      return { ok: false, error: 'addon_parent_required', familyIds: family };
    }

    var kept = orderedFamily(hasParent ? family : []);
    var primaryIdx = primaryEligibleIndex(list);
    if (kept.length && primaryIdx < 0) {
      return { ok: false, error: 'addon_ineligible_category', familyIds: kept };
    }

    var next = list.map(function (vehicle, index) {
      var others = addonIdsFromVehicle(vehicle).filter(function (id) { return !isFamilyId(id); });
      if (index === primaryIdx) others = others.concat(kept);
      return withVehicleAddonIds(vehicle, others);
    });
    return { ok: true, vehicles: next, familyIds: kept, primaryIndex: primaryIdx };
  }

  /**
   * After a vehicle add/replace/remove, keep one appointment-level family set.
   * Does not restore a family the operator already removed via add-on mutation.
   */
  function rehomeAppointmentFamily(previousVehicles, nextVehicles) {
    var previousFamily = collectFamilyIds(previousVehicles);
    if (!previousFamily.length) {
      return normalizeAppointmentAddons(nextVehicles);
    }
    var nextList = asArray(nextVehicles).slice();
    if (!nextList.length) return { ok: true, vehicles: nextList, familyIds: [] };

    var currentFamily = collectFamilyIds(nextList);
    var merged = orderedFamily(currentFamily.length ? currentFamily : previousFamily);
    var placed = placeFamilyOnPrimary(nextList, merged);
    if (!placed.ok) return placed;
    return normalizeAppointmentAddons(placed.vehicles);
  }

  function stripFamilyFromVehicles(list) {
    return asArray(list).map(function (vehicle) {
      return withVehicleAddonIds(
        vehicle,
        addonIdsFromVehicle(vehicle).filter(function (id) { return !isFamilyId(id); })
      );
    });
  }

  function placeFamilyOnPrimary(list, familyIds) {
    var kept = orderedFamily(familyIds);
    var next = stripFamilyFromVehicles(list);
    if (!kept.length || !next.length) {
      return { ok: true, vehicles: next, familyIds: kept };
    }
    var primaryIdx = primaryEligibleIndex(next);
    if (primaryIdx < 0) {
      return { ok: false, error: 'addon_ineligible_category', familyIds: kept };
    }
    next[primaryIdx] = withVehicleAddonIds(
      next[primaryIdx],
      addonIdsFromVehicle(next[primaryIdx]).concat(kept)
    );
    return { ok: true, vehicles: next, familyIds: kept, primaryIndex: primaryIdx };
  }

  function applyFamilyDelta(vehicles, delta) {
    var list = asArray(vehicles).slice();
    var toAdd = uniqueIds(delta && delta.addOnIdsToAdd).filter(isFamilyId);
    var toRemove = uniqueIds(delta && delta.addOnIdsToRemove).filter(isFamilyId);
    var removingParent = toRemove.indexOf(PARENT_ID) >= 0;
    var addingChildren = toAdd.filter(isChildId);

    if (removingParent) {
      return { ok: true, vehicles: stripFamilyFromVehicles(list), familyIds: [] };
    }

    var after = collectFamilyIds(list);
    toAdd.forEach(function (id) { after.push(id); });
    after = uniqueIds(after).filter(function (id) { return toRemove.indexOf(id) < 0; });
    after = orderedFamily(after);

    if (addingChildren.length && after.indexOf(PARENT_ID) < 0) {
      return { ok: false, error: 'addon_parent_required' };
    }
    return placeFamilyOnPrimary(list, after);
  }

  function catalogPrice(id, pricing, category) {
    var catKey = isEligibleCategory(category) ? category : 'cars';
    var rows = ((pricing && pricing[catKey]) || (pricing && pricing.cars) || {}).addons || [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === id) return Number(rows[i].price) || 0;
    }
    return 0;
  }

  function selectedIds(st) {
    if (!st) return [];
    if (!Array.isArray(st.seasonalAddonIds)) {
      st.seasonalAddonIds = collectFamilyIds(asArray(st.vehicles).concat([{ addons: st.addons, addOnIds: st.addOnIds }]));
    }
    return uniqueIds(st.seasonalAddonIds).filter(isFamilyId);
  }

  function setSelectedIds(st, ids) {
    var next = orderedFamily(ids);
    if (next.indexOf(PARENT_ID) < 0) next = [];
    st.seasonalAddonIds = next;
    return next;
  }

  function selectedTotal(st, pricing, category) {
    var cat = category || (st && st.cat) || 'cars';
    return selectedIds(st).reduce(function (sum, id) {
      return sum + catalogPrice(id, pricing, cat);
    }, 0);
  }

  function currentVehicleIsPrimary(st) {
    var vehicles = asArray(st && st.vehicles);
    var editIdx = (st && Number.isInteger(st._editingVehicleIndex)) ? st._editingVehicleIndex : -1;
    if (!vehicles.length) return isEligibleCategory(st && st.cat);
    if (editIdx >= 0 && editIdx < vehicles.length) {
      return primaryEligibleIndex(vehicles) === editIdx;
    }
    var prospective = vehicles.concat([{ cat: st && st.cat }]);
    return primaryEligibleIndex(prospective) === vehicles.length;
  }

  function currentVehicleSeasonalTotal(st, pricing) {
    if (!currentVehicleIsPrimary(st)) return 0;
    if (!isEligibleCategory(st && st.cat)) return 0;
    return selectedTotal(st, pricing, st && st.cat);
  }

  function selectedAddonObjects(st, pricing, category) {
    var cat = category || (st && st.cat) || 'cars';
    return selectedIds(st).map(function (id) {
      var meta = displayFor(id);
      return {
        id: id,
        name: meta.name,
        desc: meta.description,
        price: catalogPrice(id, pricing, cat),
        qty: 1,
      };
    });
  }

  function decorateVehicleItem(item, st, pricing) {
    var next = Object.assign({}, item);
    var nonFamily = asArray(next.addons).filter(function (a) { return a && !isFamilyId(a.id); });
    var attach = currentVehicleIsPrimary(st) && isEligibleCategory(next.cat || (st && st.cat));
    next.addons = attach
      ? nonFamily.concat(selectedAddonObjects(st, pricing, next.cat || (st && st.cat)))
      : nonFamily;
    var addonTotal = next.addons.reduce(function (s, a) {
      return s + (Number(a.price) || 0) * (Number(a.qty) || 1);
    }, 0);
    next.addonTotal = addonTotal;
    next.subtotal = (Number(next.basePrice) || 0) + addonTotal;
    return next;
  }

  function syncSeasonalOntoCart(st, pricing) {
    var vehicles = asArray(st && st.vehicles);
    if (!vehicles.length) return;
    var family = selectedIds(st);
    var primaryIdx = primaryEligibleIndex(vehicles);
    st.vehicles = vehicles.map(function (vehicle, index) {
      var others = asArray(vehicle.addons).filter(function (a) { return a && !isFamilyId(a.id); });
      var addons = (index === primaryIdx && family.length)
        ? others.concat(selectedAddonObjects(st, pricing, vehicle.cat))
        : others;
      var addonTotal = addons.reduce(function (s, a) {
        return s + (Number(a.price) || 0) * (Number(a.qty) || 1);
      }, 0);
      return Object.assign({}, vehicle, {
        addons: addons,
        addonTotal: addonTotal,
        subtotal: (Number(vehicle.basePrice) || 0) + addonTotal,
      });
    });
  }

  function splitAppointmentAddons(addons) {
    var family = [];
    var rest = [];
    asArray(addons).forEach(function (a) {
      if (a && isFamilyId(a.id)) family.push(a);
      else rest.push(a);
    });
    return { family: family, rest: rest };
  }

  function toggle(id, st, pricing) {
    var target = String(id || '').trim();
    if (!isFamilyId(target)) return selectedIds(st);
    var current = selectedIds(st);
    var has = current.indexOf(target) >= 0;
    if (isParentId(target)) {
      if (has) return setSelectedIds(st, []);
      return setSelectedIds(st, [PARENT_ID]);
    }
    if (current.indexOf(PARENT_ID) < 0) return current;
    if (has) {
      return setSelectedIds(st, current.filter(function (x) { return x !== target; }));
    }
    return setSelectedIds(st, current.concat([target]));
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function catalogRow(pricing, category, id) {
    var rows = ((pricing && pricing[category]) || {}).addons || [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === id) return rows[i];
    }
    return null;
  }

  function cardHtml(row, selected) {
    if (!row) return '';
    var meta = displayFor(row.id);
    var name = row.name || meta.name;
    var desc = row.desc || meta.description;
    var sel = selected ? ' sel' : '';
    return '<div class="addon' + sel + '" data-price="' + esc(row.price) + '" data-id="' + esc(row.id) +
      '" data-unit="0" onclick="event.stopPropagation();CD1SeasonalDriveway.onCardClick(\'' +
      esc(row.id) + '\')"><div class="addon-check">✓</div><div class="addon-name">' + esc(name) +
      '</div><div class="addon-desc">' + esc(desc) + '</div><div class="addon-price">+$' +
      esc(row.price) + '</div></div>';
  }

  function blockHtml(st, pricing) {
    var cat = st && st.cat;
    if (!isEligibleCategory(cat)) return '';
    var parentRow = catalogRow(pricing, cat, PARENT_ID);
    if (!parentRow) return '';
    var selected = selectedIds(st);
    var parentOn = selected.indexOf(PARENT_ID) >= 0;
    var html = '<div class="onsite-conv" id="onsite-conv">' +
      '<div class="onsite-conv-h">On-Site Convenience</div>' +
      '<p class="onsite-conv-note">Available only with an eligible detailing appointment. Debris haul-away or off-property disposal is not included.</p>' +
      cardHtml(parentRow, parentOn) +
      '<div class="onsite-conv-children' + (parentOn ? ' open' : '') + '" id="onsite-conv-children">';
    CHILD_GROUPS.forEach(function (group) {
      html += '<div class="onsite-conv-sub">' + esc(group.label) + '</div>';
      group.ids.forEach(function (id) {
        html += cardHtml(catalogRow(pricing, cat, id), selected.indexOf(id) >= 0);
      });
    });
    html += '</div></div>';
    return html;
  }

  function mountAddonGrid(st, pricing) {
    var grid = typeof document !== 'undefined' ? document.getElementById('addon-grid') : null;
    if (!grid) return;
    var existing = grid.querySelector('#onsite-conv');
    if (existing) existing.remove();
    var html = blockHtml(st, pricing);
    if (!html) return;
    grid.insertAdjacentHTML('afterbegin', html);
  }

  function onCardClick(id) {
    var st = (typeof window !== 'undefined' && window.ST) || (typeof ST !== 'undefined' ? ST : null);
    var pricing = (typeof window !== 'undefined' && window.PRICING) || (typeof PRICING !== 'undefined' ? PRICING : null);
    if (!st || !pricing) return;
    toggle(id, st, pricing);
    syncSeasonalOntoCart(st, pricing);
    if (typeof recalcAddonTotal === 'function') recalcAddonTotal();
    if (typeof updateTotal === 'function') updateTotal();
    if (typeof updateAddonSummary === 'function') updateAddonSummary();
    if (typeof renderVehicleCart === 'function') renderVehicleCart();
    mountAddonGrid(st, pricing);
  }

  return {
    PARENT_ID: PARENT_ID,
    CHILD_IDS: CHILD_IDS,
    FAMILY_IDS: FAMILY_IDS,
    ELIGIBLE_CATEGORIES: ELIGIBLE_CATEGORIES,
    DISPLAY: DISPLAY,
    CHILD_GROUPS: CHILD_GROUPS,
    isFamilyId: isFamilyId,
    isParentId: isParentId,
    isChildId: isChildId,
    isEligibleCategory: isEligibleCategory,
    displayFor: displayFor,
    addonIdsFromVehicle: addonIdsFromVehicle,
    collectFamilyIds: collectFamilyIds,
    normalizeAppointmentAddons: normalizeAppointmentAddons,
    rehomeAppointmentFamily: rehomeAppointmentFamily,
    applyFamilyDelta: applyFamilyDelta,
    selectedIds: selectedIds,
    setSelectedIds: setSelectedIds,
    selectedTotal: selectedTotal,
    currentVehicleIsPrimary: currentVehicleIsPrimary,
    currentVehicleSeasonalTotal: currentVehicleSeasonalTotal,
    decorateVehicleItem: decorateVehicleItem,
    syncSeasonalOntoCart: syncSeasonalOntoCart,
    splitAppointmentAddons: splitAppointmentAddons,
    toggle: toggle,
    blockHtml: blockHtml,
    mountAddonGrid: mountAddonGrid,
    onCardClick: onCardClick,
  };
});
