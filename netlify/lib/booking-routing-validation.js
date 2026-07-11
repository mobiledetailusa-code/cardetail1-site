// Server-authoritative booking route validation — shared strategy logic.

const strategy = require('./universal-customer-strategy');
const { resolveTravelForZip } = require('./travel-fee');

function normalizeCategory(cat) {
  return String(cat || '').trim().toLowerCase();
}

function bookingContextFromPayload(booking) {
  const b = booking || {};
  const zip = String(b.zipCode || b.zip || '').replace(/\D/g, '').slice(0, 5);
  const travel = zip.length === 5 ? resolveTravelForZip(zip) : null;
  const vehicles = Array.isArray(b.vehicles) ? b.vehicles : [];
  const categories = [];
  if (b.vehicleCategory) categories.push(normalizeCategory(b.vehicleCategory));
  if (b.category) categories.push(normalizeCategory(b.category));
  let vehicleCount = vehicles.length || (b.vehicle ? 1 : 0);
  for (const v of vehicles) {
    if (v.cat) categories.push(normalizeCategory(v.cat));
    if (v.units) vehicleCount = Math.max(vehicleCount, Number(v.units) || 0);
    const m = String(v.vehicleLabel || '').match(/^(\d+)\s*unit fleet/i);
    if (m) vehicleCount = Math.max(vehicleCount, Number(m[1]) || 0);
  }
  if (!vehicleCount && b.units) vehicleCount = Math.max(vehicleCount, Number(b.units) || 0);
  if (!vehicleCount) vehicleCount = 1;
  const hasFleet = categories.some((c) => c === 'fleet');
  return {
    category: categories[0] || 'cars',
    assetCategories: categories,
    vehicleCount,
    vehicles,
    unsupportedZip: zip.length === 5 && !travel,
    isCommercial: hasFleet || b.isCommercial === true || b.ownership === 'business',
    source: 'server_booking',
  };
}

function validateBookingRouting(booking) {
  const ctx = bookingContextFromPayload(booking);
  const route = strategy.routeServiceIntent(ctx);
  if (route.route === 'fleet_quote' || route.code === 'fleet_quote_required') {
    return { ok: false, error: 'fleet_quote_required', route: route.route };
  }
  if (route.route === 'manual_review' || route.code === 'manual_review_required') {
    return { ok: false, error: 'manual_review_required', route: route.route };
  }
  if (!route.allowed || !route.routing.standardBookingAllowed) {
    return { ok: false, error: 'standard_booking_not_allowed', route: route.route };
  }
  return { ok: true, route: route.route, segment: route.segment };
}

module.exports = {
  bookingContextFromPayload,
  validateBookingRouting,
};
