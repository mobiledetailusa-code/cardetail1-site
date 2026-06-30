// Mile-based travel fee — flat per appointment location (not per vehicle).
// Base: Bergen County, NJ (076xx). Service radius up to 120 miles.

const TRAVEL_MAX_MILES = 120;

const TRAVEL_FEE_TIERS = [
  { maxMi: 30, fee: 0 },
  { maxMi: 50, fee: 15 },
  { maxMi: 65, fee: 25 },
  { maxMi: 85, fee: 35 },
  { maxMi: 100, fee: 40 },
  { maxMi: 120, fee: 55 }, // 101–120 mi same tier
];

const ZONE_DEFAULT_MILES = {
  nj_a: 12, nj_b: 38, nyc: 22, ny_s: 42, ct: 58,
  pa_e: 68, pa_p: 78, pa_ph: 98, pa_b: 72, extended: 90,
};

const ZIP3_EST_MILES = {
  '070': 12, '071': 18, '072': 14, '073': 16, '074': 10, '075': 8, '076': 6, '077': 20,
  '078': 32, '079': 36, '080': 48, '081': 52, '082': 55, '083': 58, '084': 62, '085': 65,
  '086': 68, '087': 72, '088': 75, '089': 78,
  '100': 22, '101': 24, '102': 25, '103': 28, '104': 26, '111': 26, '112': 30, '113': 34, '114': 36,
  '105': 35, '106': 38, '107': 42, '108': 44, '109': 48, '115': 40, '116': 38, '117': 46, '118': 50, '119': 54,
  '120': 88, '121': 92, '122': 95, '123': 98, '124': 102, '125': 108, '126': 112, '127': 118, '128': 122,
  '130': 125, '131': 128, '132': 132, '133': 135, '134': 138, '136': 140, '137': 142, '138': 145, '139': 148,
  '060': 55, '061': 58, '062': 62, '063': 65, '064': 68, '065': 72, '066': 58, '067': 60, '068': 52, '069': 48,
  '180': 65, '181': 68, '183': 75, '189': 70, '190': 95, '191': 98,
  '170': 110, '171': 115, '172': 118, '173': 122, '174': 126, '175': 130, '176': 135, '177': 138, '178': 142,
  '195': 120, '196': 125,
};

const ZIP_ZONE_PREFIXES = {
  nj_a: ['070', '071', '072', '073', '074', '075', '076', '077'],
  nj_b: ['078', '079', '080', '081', '082', '083', '084', '085', '086', '087', '088', '089'],
  nyc: ['100', '101', '102', '103', '104', '111', '112', '113', '114'],
  ny_s: ['105', '106', '107', '108', '109', '115', '116', '117', '118', '119', '120', '121', '122', '123'],
  ct: ['060', '061', '062', '063', '064', '065', '066', '067', '068', '069'],
  pa_e: ['180', '181'],
  pa_p: ['183'],
  pa_ph: ['190', '191'],
  pa_b: ['189'],
};

const ZIP_ZONE_LABELS = {
  nj_a: 'NJ — Bergen / Hudson / Essex',
  nj_b: 'NJ — Other Areas',
  nyc: 'New York City',
  ny_s: 'NY — Suburbs / Long Island',
  ct: 'Connecticut',
  pa_e: 'PA — Eastern / Lehigh Valley',
  pa_p: 'PA — Pocono / Stroudsburg',
  pa_ph: 'PA — Philadelphia Metro',
  pa_b: 'PA — Bucks County',
  extended: 'Extended Service Area',
};

function travelFeeFromMiles(mi) {
  if (mi == null || mi < 0 || mi > TRAVEL_MAX_MILES) return null;
  for (const t of TRAVEL_FEE_TIERS) {
    if (mi <= t.maxMi) return t.fee;
  }
  return 55;
}

function zoneKeyForZip3(p3) {
  for (const [key, prefixes] of Object.entries(ZIP_ZONE_PREFIXES)) {
    if (prefixes.includes(p3)) return key;
  }
  return null;
}

function estimateMilesForZip(zip, zoneKey) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (z.length < 5) return null;
  const p3 = z.slice(0, 3);
  if (ZIP3_EST_MILES[p3] != null) return Number(ZIP3_EST_MILES[p3]);
  const zk = zoneKey || zoneKeyForZip3(p3);
  if (zk && ZONE_DEFAULT_MILES[zk] != null) return ZONE_DEFAULT_MILES[zk];
  return null;
}

function resolveTravelForZip(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (z.length < 5) return null;
  const zoneKey = zoneKeyForZip3(z.slice(0, 3));
  const miles = estimateMilesForZip(z, zoneKey);
  if (miles == null || miles > TRAVEL_MAX_MILES) return null;
  const fee = travelFeeFromMiles(miles);
  if (fee == null) return null;
  const key = zoneKey || 'extended';
  return {
    miles,
    fee,
    zoneKey: key,
    zoneLabel: ZIP_ZONE_LABELS[key] || ZIP_ZONE_LABELS.extended,
    inRange: true,
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
  TRAVEL_FEE_TIERS,
  travelFeeFromMiles,
  estimateMilesForZip,
  resolveTravelForZip,
  normalizeTravelFields,
  applyServerTravelAndTotal,
};
