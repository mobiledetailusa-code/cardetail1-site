'use strict';

/**
 * Structured add-on compatibility against package / vehicle / service-state rules.
 * Returns addon_not_compatible only when the add-on exists but is invalid for context.
 */

/** Legacy catalog rules used while PUBLIC_CONTENT_SOURCE=legacy (Owner Studio unpublished). */
const LEGACY_COMPAT_RULES = {
  // Engine bay detail is not offered on maintenance-wash package.
  engine: { incompatiblePackageIds: ['maint'] },
  // Child seat cleaning requires an interior-inclusive package.
  babyseat: { compatiblePackageIds: ['interior', 'full', 'refresh', 'premium'] },
  // RV awning cleaning is RV-only (category already scopes); block non-RV package ids if presented.
  awning: { allowedVehicleClasses: ['rvs'], incompatiblePackageIds: ['wash', 'maint'] },
};

function asIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x || '').trim()).filter(Boolean);
}

function evaluateAddonCompatibility(input = {}) {
  const addonId = String(input.addonId || '').trim();
  if (!addonId) {
    return { ok: false, error: 'addon_not_compatible', reason: 'missing_addon_id' };
  }

  const packageId = String(input.packageId || input.packId || '').trim();
  const vehicleClass = String(input.vehicleClass || input.category || '').trim();
  const serviceState = String(input.serviceState || '').trim();
  const catalogAddon = input.catalogAddon && typeof input.catalogAddon === 'object'
    ? input.catalogAddon
    : null;
  const legacy = LEGACY_COMPAT_RULES[addonId] || {};

  const compatiblePackageIds = asIdList(
    catalogAddon?.compatiblePackageIds ?? legacy.compatiblePackageIds
  );
  const incompatiblePackageIds = asIdList(
    catalogAddon?.incompatiblePackageIds ?? legacy.incompatiblePackageIds
  );
  const allowedVehicleClasses = asIdList(
    catalogAddon?.allowedVehicleClasses ?? legacy.allowedVehicleClasses
  );
  const requiredServiceStates = asIdList(
    catalogAddon?.requiredServiceStates ?? legacy.requiredServiceStates
  );
  const packageCompatibleAddOnIds = asIdList(input.packageCompatibleAddOnIds);

  if (compatiblePackageIds.length && packageId && !compatiblePackageIds.includes(packageId)) {
    return {
      ok: false,
      error: 'addon_not_compatible',
      reason: 'package_not_in_compatible_list',
      addonId,
      packageId,
    };
  }
  if (incompatiblePackageIds.length && packageId && incompatiblePackageIds.includes(packageId)) {
    return {
      ok: false,
      error: 'addon_not_compatible',
      reason: 'package_incompatible',
      addonId,
      packageId,
    };
  }
  if (allowedVehicleClasses.length && vehicleClass && !allowedVehicleClasses.includes(vehicleClass)) {
    return {
      ok: false,
      error: 'addon_not_compatible',
      reason: 'vehicle_class_not_allowed',
      addonId,
      vehicleClass,
    };
  }
  if (packageCompatibleAddOnIds.length && !packageCompatibleAddOnIds.includes(addonId)) {
    return {
      ok: false,
      error: 'addon_not_compatible',
      reason: 'addon_not_on_package_allowlist',
      addonId,
      packageId,
    };
  }
  if (requiredServiceStates.length && serviceState && !requiredServiceStates.includes(serviceState)) {
    return {
      ok: false,
      error: 'addon_not_compatible',
      reason: 'service_state_not_allowed',
      addonId,
      serviceState,
    };
  }

  return { ok: true, addonId };
}

module.exports = {
  LEGACY_COMPAT_RULES,
  evaluateAddonCompatibility,
};
