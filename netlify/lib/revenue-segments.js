// Deterministic commercial segment classification (server-side mirror of assets/customer-segments.js).

const SEGMENTS = Object.freeze({
  SINGLE_VEHICLE_NEW: 'SINGLE_VEHICLE_NEW',
  MULTI_VEHICLE_HOUSEHOLD: 'MULTI_VEHICLE_HOUSEHOLD',
  PREMIUM_ENTHUSIAST_HOUSEHOLD: 'PREMIUM_ENTHUSIAST_HOUSEHOLD',
  SPECIALTY_ASSET_OWNER: 'SPECIALTY_ASSET_OWNER',
  RECURRING_MAINTENANCE_PROSPECT: 'RECURRING_MAINTENANCE_PROSPECT',
  COMMERCIAL_FLEET: 'COMMERCIAL_FLEET',
  RETURNING_CUSTOMER: 'RETURNING_CUSTOMER',
  MANUAL_REVIEW_OR_ALTERNATIVE_PATH: 'MANUAL_REVIEW_OR_ALTERNATIVE_PATH',
});

const ENTHUSIAST_MAKES = new Set([
  'ferrari', 'lamborghini', 'mclaren', 'porsche', 'aston martin', 'bentley',
  'rolls-royce', 'maserati', 'lotus', 'bugatti', 'koenigsegg',
]);

const SPECIALTY_CATEGORIES = new Set(['boats', 'boat', 'rvs', 'rv', 'trailers', 'trailer', 'powersports', 'motorcycle', 'atv', 'utv']);

function normalizeCategory(cat) {
  return String(cat || '').trim().toLowerCase();
}

function isEnthusiastVehicle(vehicle) {
  if (!vehicle || typeof vehicle !== 'object') return false;
  const make = String(vehicle.make || vehicle.brand || '').trim().toLowerCase();
  if (ENTHUSIAST_MAKES.has(make)) return true;
  const tier = String(vehicle.tier || vehicle.sizeTier || '').toLowerCase();
  return tier === 'luxury' || tier === 'exotic';
}

function classifySegment(input) {
  const ctx = input || {};
  const vehicleCount = Math.max(0, Number(ctx.vehicleCount || ctx.personalVehicleCount || 0));
  const isCommercial = ctx.isCommercial === true || ctx.ownership === 'business' || vehicleCount >= 7;
  const completedServices = Math.max(0, Number(ctx.completedServices || 0));
  const unsupportedZip = ctx.unsupportedZip === true;
  const unsupportedService = ctx.unsupportedService === true;
  const categories = (ctx.assetCategories || ctx.categories || []).map(normalizeCategory);
  const maintenanceInterest = String(ctx.maintenanceFrequency || ctx.maintenanceInterest || '').toLowerCase();
  const hasSpecialty = categories.some(c => SPECIALTY_CATEGORIES.has(c));

  if (unsupportedZip || unsupportedService) {
    return { segment: SEGMENTS.MANUAL_REVIEW_OR_ALTERNATIVE_PATH, reasons: ['operational_alternative_path'] };
  }
  if (isCommercial) {
    return { segment: SEGMENTS.COMMERCIAL_FLEET, reasons: ['commercial_or_fleet_scale'] };
  }
  if (completedServices >= 1) {
    return { segment: SEGMENTS.RETURNING_CUSTOMER, reasons: ['prior_completed_service'] };
  }
  if (maintenanceInterest && maintenanceInterest !== 'none' && maintenanceInterest !== 'one-time') {
    return { segment: SEGMENTS.RECURRING_MAINTENANCE_PROSPECT, reasons: ['maintenance_interest'] };
  }
  if (hasSpecialty && vehicleCount <= 1) {
    return { segment: SEGMENTS.SPECIALTY_ASSET_OWNER, reasons: ['specialty_asset'] };
  }
  const vehicles = Array.isArray(ctx.vehicles) ? ctx.vehicles : [];
  const enthusiastCount = vehicles.filter(isEnthusiastVehicle).length;
  if (vehicleCount >= 2 && enthusiastCount >= 2) {
    return { segment: SEGMENTS.PREMIUM_ENTHUSIAST_HOUSEHOLD, reasons: ['customer_provided_enthusiast_vehicles'] };
  }
  if (vehicleCount >= 2) {
    return { segment: SEGMENTS.MULTI_VEHICLE_HOUSEHOLD, reasons: ['multi_vehicle_same_location'] };
  }
  if (hasSpecialty) {
    return { segment: SEGMENTS.SPECIALTY_ASSET_OWNER, reasons: ['specialty_asset'] };
  }
  return { segment: SEGMENTS.SINGLE_VEHICLE_NEW, reasons: ['single_vehicle_no_history'] };
}

function vehicleCountBand(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n === 2) return '2';
  if (n <= 4) return '3-4';
  if (n <= 6) return '5-6';
  return '7+';
}

module.exports = {
  SEGMENTS,
  classifySegment,
  vehicleCountBand,
  isEnthusiastVehicle,
};
