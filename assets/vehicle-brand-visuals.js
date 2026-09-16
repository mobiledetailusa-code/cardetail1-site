/**
 * Exact make+model studio visual lookup for booking thumbnails.
 * Cars:    assets/generated/brand-model-visuals.generated.js (CD1_BRAND_MODEL_VISUALS)
 * Specialty: assets/generated/specialty-brand-model-visuals.generated.js (CD1_SPECIALTY_BRAND_MODEL_VISUALS)
 */
(function (root) {
  'use strict';

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function carCatalog() {
    return root.CD1_BRAND_MODEL_VISUALS || null;
  }

  function specialtyCatalog() {
    return root.CD1_SPECIALTY_BRAND_MODEL_VISUALS || null;
  }

  function matchInFlat(flat, prefix, md) {
    const direct = flat[prefix + md];
    if (direct) return direct;
    let best = '';
    let bestLen = 0;
    for (const key of Object.keys(flat)) {
      if (!key.startsWith(prefix)) continue;
      const modelPart = key.slice(prefix.length);
      if (md === modelPart || md.startsWith(modelPart + ' ') || modelPart.startsWith(md + ' ')) {
        if (modelPart.length > bestLen) {
          bestLen = modelPart.length;
          best = flat[key];
        }
      }
    }
    return best;
  }

  /**
   * Resolve a studio visual key from make + model (preferred) or a free-text label.
   * Returns '' when no exact catalog hit — callers should fall back to MODEL_MAP / tier.
   */
  function resolveBrandModelVisual(make, model, label) {
    const data = carCatalog();
    if (!data || !data.flat) return '';

    const mk = norm(make);
    const md = norm(model);
    if (mk && md) {
      const hit = matchInFlat(data.flat, mk + '|', md);
      if (hit) return hit;
    }

    const lbl = norm(label);
    if (!lbl) return '';
    const makes = data.byMake ? Object.keys(data.byMake) : [];
    for (const makeName of makes) {
      const mNorm = norm(makeName);
      const idx = lbl.indexOf(mNorm);
      if (idx < 0) continue;
      const after = lbl.slice(idx + mNorm.length).trim();
      const models = data.byMake[makeName] || {};
      const modelNames = Object.keys(models).sort((a, b) => b.length - a.length);
      for (const modelName of modelNames) {
        const mo = norm(modelName);
        if (after === mo || after.startsWith(mo + ' ') || after.startsWith(mo + '·') || after.startsWith(mo + '-')) {
          return models[modelName];
        }
      }
    }
    return '';
  }

  /**
   * Exact specialty make+model visual for powersports / boats / rvs.
   * @param {string} cat - 'powersports' | 'boats' | 'rvs'
   */
  function resolveSpecialtyVisual(cat, make, model, label) {
    const data = specialtyCatalog();
    if (!data || !data.flat) return '';
    const category = String(cat || '').toLowerCase();
    if (category !== 'powersports' && category !== 'boats' && category !== 'rvs') return '';

    const mk = norm(make);
    const md = norm(model);
    if (mk && md) {
      const hit = matchInFlat(data.flat, category + '|' + mk + '|', md);
      if (hit) return hit;
    }

    const lbl = norm(label);
    if (!lbl || !data.byCat || !data.byCat[category]) return '';
    const makes = Object.keys(data.byCat[category]);
    for (const makeName of makes) {
      const mNorm = norm(makeName);
      const idx = lbl.indexOf(mNorm);
      if (idx < 0) continue;
      const after = lbl.slice(idx + mNorm.length).trim();
      const models = data.byCat[category][makeName] || {};
      const modelNames = Object.keys(models).sort((a, b) => b.length - a.length);
      for (const modelName of modelNames) {
        const mo = norm(modelName);
        if (after === mo || after.startsWith(mo + ' ') || after.startsWith(mo + '·') || after.startsWith(mo + '-')) {
          return models[modelName];
        }
      }
    }
    return '';
  }

  const api = { resolveBrandModelVisual, resolveSpecialtyVisual, norm };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CD1_VehicleBrandVisuals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
