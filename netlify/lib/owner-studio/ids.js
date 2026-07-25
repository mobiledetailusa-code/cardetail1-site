'use strict';

const SITE_ID = 'detailing-zone';
const SCHEMA_VERSION = 1;

const STABLE_ID_RE = /^(pkg|vc|addon|prev|arev|rel|rev|media|nav|page|faq|gal)_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SITE_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

const PACKAGE_ID_MAP = {
  cars: {
    maint: 'pkg_maintenance_detail',
    interior: 'pkg_interior_detail',
    full: 'pkg_full_detail',
    refresh: 'pkg_paint_refresh',
    premium: 'pkg_premium_detail',
  },
};

const VEHICLE_CLASS_ID_MAP = {
  cars: {
    small: 'vc_sedan',
    suv2: 'vc_suv_2row',
    suv3: 'vc_suv_3row',
    truck: 'vc_truck',
  },
};

const ADDON_ID_MAP = {
  pethair: 'addon_pet_hair',
  superint: 'addon_super_interior',
  floormats: 'addon_floor_mats',
  wax1yr: 'addon_wax_1yr',
  claybar: 'addon_clay_bar',
  babyseat: 'addon_baby_seat',
  heavymud: 'addon_heavy_mud',
  seatdeep: 'addon_seat_deep',
  wheeldet: 'addon_wheel_detail',
  waterspot: 'addon_water_spot',
  saltwash: 'addon_salt_wash',
  trimprot: 'addon_trim_protectant',
  lightdeg: 'addon_light_degrease',
  capfront: 'addon_cap_front',
};

function assertSiteId(siteId) {
  const id = String(siteId || '').trim();
  if (!SITE_ID_RE.test(id)) {
    const err = new Error('invalid_site_id');
    err.code = 'invalid_site_id';
    throw err;
  }
  return id;
}

function isStableId(id) {
  return STABLE_ID_RE.test(String(id || ''));
}

function slugifyLegacy(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'unknown';
}

function packageIdFor(category, legacyKey) {
  const cat = String(category || '').trim() || 'cars';
  const key = String(legacyKey || '').trim();
  if (PACKAGE_ID_MAP[cat] && PACKAGE_ID_MAP[cat][key]) return PACKAGE_ID_MAP[cat][key];
  return `pkg_${slugifyLegacy(cat)}_${slugifyLegacy(key)}`;
}

function vehicleClassIdFor(category, legacyKey) {
  const cat = String(category || '').trim() || 'cars';
  const key = String(legacyKey || '').trim();
  if (VEHICLE_CLASS_ID_MAP[cat] && VEHICLE_CLASS_ID_MAP[cat][key]) {
    return VEHICLE_CLASS_ID_MAP[cat][key];
  }
  return `vc_${slugifyLegacy(cat)}_${slugifyLegacy(key)}`;
}

function addOnIdFor(legacyKey) {
  const key = String(legacyKey || '').trim();
  if (ADDON_ID_MAP[key]) return ADDON_ID_MAP[key];
  return `addon_${slugifyLegacy(key)}`;
}

function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}${rand}`;
}

module.exports = {
  SITE_ID,
  SCHEMA_VERSION,
  STABLE_ID_RE,
  SITE_ID_RE,
  PACKAGE_ID_MAP,
  VEHICLE_CLASS_ID_MAP,
  ADDON_ID_MAP,
  assertSiteId,
  isStableId,
  packageIdFor,
  vehicleClassIdFor,
  addOnIdFor,
  newId,
  slugifyLegacy,
};
