/** Deterministic commercial segment classification — browser mirror of server logic. */
(function (global) {
  'use strict';

  var SEGMENTS = {
    SINGLE_VEHICLE_NEW: 'SINGLE_VEHICLE_NEW',
    MULTI_VEHICLE_HOUSEHOLD: 'MULTI_VEHICLE_HOUSEHOLD',
    PREMIUM_ENTHUSIAST_HOUSEHOLD: 'PREMIUM_ENTHUSIAST_HOUSEHOLD',
    SPECIALTY_ASSET_OWNER: 'SPECIALTY_ASSET_OWNER',
    RECURRING_MAINTENANCE_PROSPECT: 'RECURRING_MAINTENANCE_PROSPECT',
    COMMERCIAL_FLEET: 'COMMERCIAL_FLEET',
    RETURNING_CUSTOMER: 'RETURNING_CUSTOMER',
    MANUAL_REVIEW_OR_ALTERNATIVE_PATH: 'MANUAL_REVIEW_OR_ALTERNATIVE_PATH',
  };

  var ENTHUSIAST_MAKES = {
    ferrari: 1, lamborghini: 1, mclaren: 1, porsche: 1, 'aston martin': 1,
    bentley: 1, 'rolls-royce': 1, maserati: 1, lotus: 1,
  };

  var SPECIALTY = { boats: 1, boat: 1, rvs: 1, rv: 1, trailers: 1, powersports: 1, motorcycle: 1, atv: 1, utv: 1 };

  function normCat(c) { return String(c || '').trim().toLowerCase(); }

  function isEnthusiastVehicle(v) {
    if (!v) return false;
    var make = String(v.make || v.brand || '').trim().toLowerCase();
    return !!ENTHUSIAST_MAKES[make];
  }

  function classifySegment(input) {
    input = input || {};
    var vehicleCount = Math.max(0, Number(input.vehicleCount || input.personalVehicleCount || 0));
    var isCommercial = input.isCommercial === true || input.ownership === 'business' || vehicleCount >= 7;
    var completed = Math.max(0, Number(input.completedServices || 0));
    var categories = (input.assetCategories || input.categories || []).map(normCat);
    var maint = String(input.maintenanceFrequency || input.maintenanceInterest || '').toLowerCase();
    var hasSpecialty = categories.some(function (c) { return SPECIALTY[c]; });

    if (input.unsupportedZip || input.unsupportedService) {
      return { segment: SEGMENTS.MANUAL_REVIEW_OR_ALTERNATIVE_PATH, reasons: ['operational_alternative_path'] };
    }
    if (isCommercial) return { segment: SEGMENTS.COMMERCIAL_FLEET, reasons: ['commercial_or_fleet_scale'] };
    if (completed >= 1) return { segment: SEGMENTS.RETURNING_CUSTOMER, reasons: ['prior_completed_service'] };
    if (maint && maint !== 'none' && maint !== 'one-time') {
      return { segment: SEGMENTS.RECURRING_MAINTENANCE_PROSPECT, reasons: ['maintenance_interest'] };
    }
    var vehicles = Array.isArray(input.vehicles) ? input.vehicles : [];
    var enthusiastCount = vehicles.filter(isEnthusiastVehicle).length;
    if (vehicleCount >= 2 && enthusiastCount >= 2) {
      return { segment: SEGMENTS.PREMIUM_ENTHUSIAST_HOUSEHOLD, reasons: ['customer_provided_enthusiast_vehicles'] };
    }
    if (vehicleCount >= 2) return { segment: SEGMENTS.MULTI_VEHICLE_HOUSEHOLD, reasons: ['multi_vehicle_same_location'] };
    if (hasSpecialty) return { segment: SEGMENTS.SPECIALTY_ASSET_OWNER, reasons: ['specialty_asset'] };
    return { segment: SEGMENTS.SINGLE_VEHICLE_NEW, reasons: ['single_vehicle_no_history'] };
  }

  function vehicleCountBand(count) {
    var n = Math.max(0, Number(count) || 0);
    if (n <= 0) return '0';
    if (n === 1) return '1';
    if (n === 2) return '2';
    if (n <= 4) return '3-4';
    if (n <= 6) return '5-6';
    return '7+';
  }

  global.Cardetail1Segments = {
    SEGMENTS: SEGMENTS,
    classifySegment: classifySegment,
    vehicleCountBand: vehicleCountBand,
  };
})(typeof window !== 'undefined' ? window : globalThis);
