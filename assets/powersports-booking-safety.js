/*!
 * Cardetail1 — deterministic Powersports booking classification state.
 *
 * Exact known-model metadata always wins. Unknown/free-form models require an
 * explicit customer choice. Unsupported classes never receive a numeric price.
 */
(function (root, factory) {
  var catalog = root && root.CD1PowersportsCatalog;
  if (typeof module === 'object' && module.exports) {
    catalog = require('./powersports-model-catalog');
    module.exports = factory(catalog);
  } else {
    root.CD1PowersportsBookingSafety = factory(catalog);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (catalog) {
  'use strict';

  if (!catalog) throw new Error('CD1PowersportsCatalog is required');

  function identity(make, model) {
    return String(make || '').trim().toLowerCase() + '\u0000' + String(model || '').trim().toLowerCase();
  }

  function clearResolvedState(st, options) {
    if (!st) return st;
    var opts = options || {};
    st.tierKey = '';
    st.tier = null;
    st.displayLabel = '';
    st.body = null;
    st.vehicleLabel = '';
    st.basePrice = 0;
    st.classNeedsConfirm = false;
    st._priceResolveFailed = false;
    st._powersportsResolutionStatus = '';
    if (!opts.keepManual) st._powersportsManualClass = '';
    return st;
  }

  /**
   * Called before the normal make/model/year completeness gate. This is what
   * prevents a partially edited Harley field from retaining the previous RZR
   * tier and price while the customer is still typing.
   */
  function resetForIdentityChange(st, make, model) {
    if (!st) return false;
    var next = identity(make, model);
    if (st._powersportsIdentity === next) return false;
    clearResolvedState(st);
    st._powersportsIdentity = next;
    return true;
  }

  function chooseManualClass(st, serviceClass) {
    var def = catalog.classDefinition(serviceClass);
    if (!st || !def) return false;
    clearResolvedState(st, { keepManual: true });
    st._powersportsManualClass = serviceClass;
    st._powersportsResolutionStatus = 'manual';
    return true;
  }

  function supportedResult(record, serviceClass, source) {
    var def = catalog.classDefinition(serviceClass);
    var priceTier = catalog.priceTierForServiceClass(serviceClass);
    if (!def || !priceTier) return null;
    return {
      status: 'bookable',
      source: source,
      record: record || null,
      serviceClass: serviceClass,
      physicalFamily: record ? record.physicalFamily : serviceClass,
      displaySubtype: record ? record.displaySubtype : def.description,
      configuration: record ? record.configuration : null,
      label: def.label,
      description: def.description,
      priceTier: priceTier,
    };
  }

  function classify(st, pricing, make, model) {
    var record = catalog.resolve(make, model);
    if (record) {
      if (record.publicStatus === 'route_boats') {
        return {
          status: 'route_boats',
          record: record,
          boatType: record.physicalFamily === 'pwc' ? 'jetski' : 'pontoon',
          label: record.physicalFamily === 'pwc' ? 'Jet Ski / PWC' : 'Pontoon boat',
          message: 'This vehicle is booked through Boats, not Powersports.',
        };
      }
      if (record.publicStatus === 'contact') {
        return {
          status: 'contact',
          record: record,
          label: record.displaySubtype,
          message: 'Online pricing is not available for this vehicle type. Contact Cardetail1 for a confirmed quote.',
        };
      }
      if (record.publicStatus === 'price_review') {
        return {
          status: 'price_review',
          record: record,
          serviceClass: record.serviceClass,
          label: catalog.classDefinition(record.serviceClass).label,
          message: 'This vehicle is classified correctly, but online Trike pricing is not yet approved. Contact Cardetail1 for a confirmed quote.',
        };
      }
      var exact = supportedResult(record, record.serviceClass, 'catalog');
      if (exact && pricing && pricing.tiers && pricing.tiers[exact.priceTier]) return exact;
      return { status: 'unavailable', record: record, message: 'This vehicle class is temporarily unavailable for online booking.' };
    }

    var manualClass = String((st && st._powersportsManualClass) || '');
    if (manualClass) {
      var manualDef = catalog.classDefinition(manualClass);
      if (manualDef && !manualDef.bookable) {
        return {
          status: 'price_review',
          record: null,
          serviceClass: manualClass,
          label: manualDef.label,
          message: manualDef.contactReason || 'Contact Cardetail1 for a confirmed quote.',
        };
      }
      var manual = supportedResult(null, manualClass, 'manual');
      if (manual && pricing && pricing.tiers && pricing.tiers[manual.priceTier]) return manual;
    }

    return {
      status: 'unknown',
      record: null,
      message: 'Select the physical vehicle type to continue. We will not guess from the make or model name.',
    };
  }

  function applyBookableState(st, pricing, result) {
    if (!st || !pricing || !result || result.status !== 'bookable') return false;
    var priceTier = pricing.tiers && pricing.tiers[result.priceTier];
    if (!priceTier) return false;
    st.tierKey = result.serviceClass;
    st.tier = Object.assign({}, priceTier, {
      label: result.label,
      desc: result.description,
      priceTierKey: result.priceTier,
    });
    st.displayLabel = result.label;
    st.classNeedsConfirm = false;
    st._powersportsResolutionStatus = 'bookable';
    return true;
  }

  function resolveAndApply(st, pricing, make, model) {
    var result = classify(st, pricing, make, model);
    if (result.status === 'bookable') {
      applyBookableState(st, pricing, result);
      return result;
    }
    clearResolvedState(st, { keepManual: result.status === 'unknown' || result.status === 'price_review' });
    st._powersportsResolutionStatus = result.status;
    st.classNeedsConfirm = result.status === 'unknown';
    if (result.serviceClass) st._powersportsManualClass = result.serviceClass;
    return result;
  }

  function resolvePriceTier(serviceClass) {
    return catalog.priceTierForServiceClass(serviceClass);
  }

  function fallbackTiers(pricing) {
    var out = {};
    catalog.fallbackOptions().forEach(function (option) {
      var priceTier = option.priceTier && pricing && pricing.tiers && pricing.tiers[option.priceTier];
      out[option.serviceClass] = Object.assign({}, priceTier || {}, {
        label: option.label,
        desc: option.description + (option.bookable ? '' : ' · Contact for pricing'),
        priceTierKey: option.priceTier || '',
        bookable: option.bookable,
      });
    });
    return out;
  }

  function setText(doc, id, value) {
    var el = doc && doc.getElementById ? doc.getElementById(id) : null;
    if (el) el.textContent = value;
    return el;
  }

  /** Browser-only presentation for a safe stop; harmless with a test document. */
  function presentResolution(st, result, make, model, year, doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !result) return result && result.status === 'bookable';
    var note = d.getElementById('g-custom-note');
    var chipWrap = d.getElementById('tier-chips-wrap');
    var chipNote = d.getElementById('tier-chips-note');
    var card = d.getElementById('vc');
    var next = d.getElementById('next3');
    var priceWrap = d.getElementById('vc-price-wrap');
    var price = d.getElementById('vc-price');

    if (result.status === 'bookable') {
      if (note) note.style.display = 'none';
      if (chipNote) chipNote.hidden = true;
      if (chipWrap) chipWrap.style.display = 'none';
      return true;
    }

    if (next) next.disabled = true;
    if (priceWrap) priceWrap.style.display = 'none';
    if (price) {
      price.style.display = 'none';
      price.textContent = '';
    }
    if (st) st.basePrice = 0;

    if (result.status === 'unknown') {
      if (card && card.classList) card.classList.remove('show');
      if (chipWrap) chipWrap.style.display = 'block';
      if (chipNote) {
        chipNote.textContent = result.message;
        chipNote.hidden = false;
      }
      if (note) {
        note.textContent = result.message;
        note.style.display = 'block';
      }
      return false;
    }

    var label = result.label || 'Vehicle type';
    var vehicleLabel = [year, make, model].filter(Boolean).join(' ').trim();
    if (st) st.vehicleLabel = vehicleLabel;
    setText(d, 'vc-name', vehicleLabel);
    setText(d, 'vc-badge', label);
    setText(d, 'vc-tier-lbl', result.message || 'Contact Cardetail1 to continue.');
    if (card && card.classList) card.classList.add('show');
    if (chipWrap) chipWrap.style.display = 'none';
    if (chipNote) chipNote.hidden = true;
    if (note) {
      note.textContent = (result.message || 'Contact Cardetail1 to continue.') +
        (result.status === 'route_boats' ? ' Choose Boats under Service Type to continue.' : ' Call or text 551-373-5668.');
      note.style.display = 'block';
    }
    return false;
  }

  return Object.freeze({
    identity: identity,
    clearResolvedState: clearResolvedState,
    resetForIdentityChange: resetForIdentityChange,
    chooseManualClass: chooseManualClass,
    classify: classify,
    applyBookableState: applyBookableState,
    resolveAndApply: resolveAndApply,
    resolvePriceTier: resolvePriceTier,
    fallbackTiers: fallbackTiers,
    presentResolution: presentResolution,
    publicServiceClassKeys: Object.freeze(Object.keys(catalog.serviceClasses).filter(function (key) {
      return catalog.isPublicBookableServiceClass(key);
    })),
  });
});
