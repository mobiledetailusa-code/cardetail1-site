// Distance-based travel fee — flat per appointment location (not per vehicle).
// Base: Hackensack, Bergen County NJ (07601).
//
// Distance comes from real ZIP centroid coordinates, not from a ZIP-prefix lookup
// table. The previous model assumed a higher ZIP3 prefix meant a longer drive
// (070 → 089), which is geographically false: USPS assigns prefixes by sorting
// facility, not by distance. That assumption put Edison NJ at 75 miles when it is
// 43, and Vineland NJ at 58 when it is 148 — overcharging the closest dense
// markets while quoting loss-making jobs at the far edge.
//
// Fee model: free inside FREE_RADIUS_MI, then a flat rate per road mile beyond it,
// rounded to the nearest $5 so quotes stay legible. Linear beyond the free radius
// means no cliff edge — two neighbours never differ by $15 because a boundary runs
// between them.

const COORDS = require('./data/service-area-zip-coords');

/** Straight-line miles under-state a drive; this is the usual planar correction. */
const ROAD_FACTOR = 1.25;

/** Road miles. Beyond this the location is out of the service area. */
const TRAVEL_MAX_MILES = 120;

/** No travel fee at or inside this road distance. */
const FREE_RADIUS_MI = 50;

/** Dollars per road mile beyond the free radius. */
const RATE_PER_MILE = 1.0;

/** Fees round to this increment so a quote never reads $17.43. */
const FEE_ROUNDING = 5;

const EARTH_RADIUS_MI = 3958.8;

let coordIndex = null;

/** Parsed lazily: the packed table costs nothing until a ZIP is actually priced. */
function zipCoordIndex() {
  if (coordIndex) return coordIndex;
  const index = new Map();
  for (const entry of String(COORDS.packed || '').split(';')) {
    if (!entry) continue;
    const colon = entry.indexOf(':');
    if (colon < 0) continue;
    const zip = entry.slice(0, colon);
    const comma = entry.indexOf(',', colon);
    if (comma < 0) continue;
    const lat = Number(entry.slice(colon + 1, comma));
    const lon = Number(entry.slice(comma + 1));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    index.set(zip, { lat, lon });
  }
  coordIndex = index;
  return index;
}

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMiles(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

function normalizeZip(zip) {
  const z = String(zip == null ? '' : zip).replace(/\D/g, '').slice(0, 5);
  return z.length === 5 ? z : null;
}

/**
 * Estimated road miles from base, or null when the ZIP is unknown.
 * Unknown is deliberately null rather than a guessed default: quoting a distance
 * we cannot compute is how the previous model went wrong.
 */
function estimateMilesForZip(zip) {
  const z = normalizeZip(zip);
  if (!z) return null;
  const point = zipCoordIndex().get(z);
  if (!point) return null;
  const straight = haversineMiles(COORDS.base, point);
  return Math.round(straight * ROAD_FACTOR);
}

/**
 * Fee for a road distance. Free inside the radius, linear beyond it, null when
 * the distance is outside the service area entirely.
 */
function travelFeeFromMiles(mi) {
  const miles = Number(mi);
  if (!Number.isFinite(miles) || miles < 0 || miles > TRAVEL_MAX_MILES) return null;
  if (miles <= FREE_RADIUS_MI) return 0;
  const billable = (miles - FREE_RADIUS_MI) * RATE_PER_MILE;
  return Math.round(billable / FEE_ROUNDING) * FEE_ROUNDING;
}

/** Human-readable band, for display only — never an input to the fee. */
function zoneLabelForMiles(miles) {
  if (miles <= FREE_RADIUS_MI) return 'Included — no travel fee';
  if (miles <= 75) return 'Extended area';
  if (miles <= 100) return 'Long distance';
  return 'Maximum range';
}

function resolveTravelForZip(zip) {
  const z = normalizeZip(zip);
  if (!z) return null;
  const miles = estimateMilesForZip(z);
  if (miles == null || miles > TRAVEL_MAX_MILES) return null;
  const fee = travelFeeFromMiles(miles);
  if (fee == null) return null;
  return {
    miles,
    fee,
    zoneKey: fee === 0 ? 'included' : 'extended',
    zoneLabel: zoneLabelForMiles(miles),
    inRange: true,
    freeRadiusMi: FREE_RADIUS_MI,
    ratePerMile: RATE_PER_MILE,
  };
}

function normalizeTravelFields(booking) {
  const resolved = resolveTravelForZip(booking.zipCode || booking.zip || '');
  if (resolved) {
    return {
      travelFeeMiles: resolved.miles,
      travelFeeAmount: resolved.fee,
      zoneSurcharge: resolved.fee,
      zoneKey: resolved.zoneKey,
      zoneLabel: resolved.zoneLabel,
    };
  }
  return { travelFeeMiles: null, travelFeeAmount: 0, zoneSurcharge: 0 };
}

const { validateAndRecalculateBookingPricing } = require('./booking-price-catalog');

/** Server-side only — rejects out-of-area ZIPs; never trusts client miles/fees or subtotals. */
function applyServerTravelAndTotal(booking, opts = {}) {
  const resolved = resolveTravelForZip(booking.zipCode || booking.zip || '');
  if (!resolved) {
    return { ok: false, error: 'out_of_service_area' };
  }

  const pricing = validateAndRecalculateBookingPricing(booking);
  if (!pricing.ok) {
    return { ok: false, error: pricing.error || 'invalid_pricing' };
  }

  booking.travelFeeMiles = resolved.miles;
  booking.travelFeeAmount = resolved.fee;
  booking.zoneSurcharge = resolved.fee;
  if (!booking.zone) booking.zone = resolved.zoneLabel;

  if (pricing.vehicles.length) booking.vehicles = pricing.vehicles;

  const serverTotal = Math.round((pricing.serviceSubtotal + resolved.fee) * 100) / 100;
  const clientTotal = Number(booking.totalPrice) || 0;

  if (!opts.skipMismatchCheck && clientTotal > 0 && Math.abs(clientTotal - serverTotal) > 1) {
    return { ok: false, error: 'price_mismatch', serverTotal, clientTotal };
  }

  booking.totalPrice = serverTotal;
  return { ok: true, serviceSubtotal: pricing.serviceSubtotal, serverTotal };
}

module.exports = {
  TRAVEL_MAX_MILES,
  FREE_RADIUS_MI,
  RATE_PER_MILE,
  ROAD_FACTOR,
  travelFeeFromMiles,
  estimateMilesForZip,
  resolveTravelForZip,
  normalizeTravelFields,
  applyServerTravelAndTotal,
  zipCoordIndex,
};
