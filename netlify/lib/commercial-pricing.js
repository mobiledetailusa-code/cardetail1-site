'use strict';

/**
 * Commercial & specialty pricing engine (rate card v2). NOT ACTIVE.
 *
 * Final price = base service + eligible add-ons + configuration adjustments
 *               + the existing travel charge (travel-fee.js, unchanged).
 *
 * Nothing here is live:
 *  - ACTIVE_RATE_CARD is a draft with every amount null. quoteCommercial() returns no
 *    amount unless it is given a complete card marked approved (status, approver, date).
 *  - publicCommercialQuote() never returns an amount while COMMERCIAL_PUBLIC_PRICING_ENABLED
 *    is false, and it can only use ACTIVE_RATE_CARD.
 *  - COMMERCIAL_CHECKOUT_ENABLED is false. Both switches are code constants, not env vars or
 *    payment settings; turning either on is a reviewed code change after owner approval.
 *  - No Netlify function, booking path or payment code imports this module.
 *
 * Server authority:
 *  - The vehicle is re-resolved from assets/commercial-vehicle-catalog.js; client size class,
 *    tier, dimensions, prices, totals and miles are stripped and ignored.
 *  - Distance and the travel charge come from the service ZIP via travel-fee.js.
 *  - Commercial size classes (cv_*) never use passenger-car or pickup rates. The only Cars
 *    price the engine can use is the Cars van tier for a van the APPROVED channel policy calls
 *    comparable (vehicle-pricing-channel.js); the draft policy has no seat limit, so none is.
 *
 * Labor is never charged twice: Full Detail is one line (it replaces interior + exterior),
 * each add-on is only allowed on a base that includes its work (deep -> interior; roof and
 * undercarriage -> exterior), and each add-on is billed once.
 */

const CommercialCatalog = require('../../assets/commercial-vehicle-catalog');
const Channel = require('./vehicle-pricing-channel');
const Travel = require('./travel-fee');
const { PRICING } = require('./booking-price-catalog'); // read-only Cars van tiers for approved parity

const COMMERCIAL_CHECKOUT_ENABLED = false;
const COMMERCIAL_PUBLIC_PRICING_ENABLED = false;

const SERVICES = Object.freeze(['interior_cleaning', 'exterior_wash', 'full_detail']);
const PRICED_SERVICES = SERVICES;
const PRICED_ADDONS = Object.freeze(['deep_interior', 'roof_cleaning', 'undercarriage_wash']);
const ADDONS = Object.freeze([...PRICED_ADDONS, 'cargo_box_interior']);
/** Requested services the engine never prices: always a manual quote. */
const QUOTE_ONLY_SERVICES = Object.freeze(['sanitizing', 'upholstery_shampoo', 'windows']);
const INCLUDES = Object.freeze({ interior_cleaning: ['interior'], exterior_wash: ['exterior'], full_detail: ['interior', 'exterior'] });
const ADDON_NEEDS = Object.freeze({ deep_interior: 'interior', roof_cleaning: 'exterior', undercarriage_wash: 'exterior' });
const CARS_FIELD = Object.freeze({ interior_cleaning: 'interior', exterior_wash: 'wash', full_detail: 'full' });

/** Extra labor for configurations that take longer than the size class implies. */
const LABOR_ADJUSTMENTS = Object.freeze({
  extra_seat: 'Per seat above the size class included seats (interior work)',
  wheelchair_position: 'Per wheelchair position (securements, lift or ramp area)',
  super_high_roof: 'Super-high roof sides (exterior reach work)',
});

const INSTANT_CONDITIONS = Object.freeze(['normal', 'deep_interior']);
const MANUAL_CONDITIONS = Object.freeze(['heavy_contamination', 'biohazard', 'mold', 'heavy_grease_or_mud', 'unknown']);
/** Proposed (draft) instant-pricing limits; structural, no amounts. */
const MANUAL_ONLY_SIZE_CLASSES = Object.freeze(['cv_shuttle_large', 'cv_box_xl']);
const INSTANT_LIMITS = Object.freeze({ maxSeats: 30, maxWheelchairPositions: 4 });
/** Proposed commercial-only boundary for instant pricing (one-way road miles). */
const COMMERCIAL_AUTO_PRICING_MAX_MILES = 30;

/** Fields a client might send that must never influence a commercial price. */
const CLIENT_AUTHORITY_FIELDS = Object.freeze(['price', 'priceCents', 'total', 'totalCents', 'subtotalCents', 'sizeClass', 'tier', 'tierKey', 'miles', 'oneWayMiles', 'travelFee', 'travelCents', 'rateCard', 'lines']);

const isTall = (cls) => cls.startsWith('cv_shuttle') || cls.startsWith('cv_box');
const isBox = (cls) => cls.startsWith('cv_box');
/** Roof price keys per class: tall vehicles and compact/midsize vans have one roof price. */
function roofKeysFor(cls) {
  if (isTall(cls) || cls === 'cv_van_compact' || cls === 'cv_van_midsize') return ['any'];
  return ['low', 'medium', 'standard', 'high'];
}

function nullAmount() { return { cents: null, minutes: null }; }

/**
 * The unapproved draft rate card. Amounts are integer cents and minutes once filled in.
 * Structural flags (which add-ons need tall access or a truck kit) are not amounts.
 */
function draftRateCard() {
  const sizeClasses = {};
  for (const cls of CommercialCatalog.SIZE_CLASSES) {
    const addOns = {
      deep_interior: { cents: null, minutes: null, perExtraSeatCents: null, perWheelchairPositionCents: null, minimumCents: null },
      roof_cleaning: { needsTallAccessEquipment: isTall(cls), byRoofHeight: Object.fromEntries(roofKeysFor(cls).map((k) => [k, nullAmount()])) },
      undercarriage_wash: { cents: null, minutes: null, needsTruckKit: isTall(cls) },
    };
    if (isBox(cls)) addOns.cargo_box_interior = { manualQuote: true };
    sizeClasses[cls] = {
      includedSeats: null,
      maxAutoMiles: Object.fromEntries(SERVICES.map((s) => [s, null])),
      services: Object.fromEntries(SERVICES.map((s) => [s, nullAmount()])),
      addOns,
    };
  }
  return {
    version: 2,
    status: 'draft',
    approvedBy: null,
    approvedAt: null,
    currency: 'USD',
    roundToCents: null,
    sizeClasses,
    configuration: {
      extraSeatCentsPerSeat: null, minutesPerExtraSeat: null,
      wheelchairPositionCents: null, minutesPerWheelchairPosition: null,
      superHighRoofCents: null, superHighRoofMinutes: null,
    },
    mobileWaterCents: null,
    safeguards: {
      // Lowest total for the services of any commercial job (before travel).
      minimumTicketCents: null,
      // Lowest revenue per estimated labor hour; floors totals for long jobs.
      minimumRevenuePerHourCents: null,
    },
    // Owner confirmations. While false, the matching add-ons are manual quotes.
    equipmentConfirmed: { roofPlatformForTallVehicles: false, undercarriageKitForTrucksAndBuses: false, mobileWaterApproved: false },
    // Cars-price parity for comparable vans: no seat limit until the owner approves one.
    channelPolicy: { comparableClasses: [...Channel.DRAFT_CHANNEL_POLICY.comparableClasses], comparableMaxSeats: null },
  };
}

const ACTIVE_RATE_CARD = deepFreeze(draftRateCard());

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const isCents = (v) => Number.isInteger(v) && v > 0 && v <= 10000000;
const isMinutes = (v) => Number.isInteger(v) && v > 0 && v <= 6000;
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 1000;

/**
 * Check a rate card. Returns { approved, complete, problems }.
 * approved requires version 2, status 'approved', an approver, a date and every amount filled.
 * A draft card is never approved, whatever amounts it carries.
 */
function validateRateCard(card) {
  const problems = [];
  if (!card || typeof card !== 'object') return { approved: false, complete: false, problems: ['missing_rate_card'] };
  if (card.version !== 2) problems.push('version');
  if (!isCents(card.roundToCents)) problems.push('roundToCents');
  for (const cls of CommercialCatalog.SIZE_CLASSES) {
    const row = card.sizeClasses && card.sizeClasses[cls];
    if (!row) { problems.push(`${cls}:missing`); continue; }
    if (!isCount(row.includedSeats)) problems.push(`${cls}.includedSeats`);
    for (const s of SERVICES) {
      const svc = row.services && row.services[s];
      if (!svc || !isCents(svc.cents)) problems.push(`${cls}.${s}`);
      if (!svc || !isMinutes(svc.minutes)) problems.push(`${cls}.${s}.minutes`);
      const lim = row.maxAutoMiles && row.maxAutoMiles[s];
      if (!(Number.isInteger(lim) && lim >= COMMERCIAL_AUTO_PRICING_MAX_MILES)) problems.push(`${cls}.maxAutoMiles.${s}`);
    }
    const a = row.addOns || {};
    const d = a.deep_interior || {};
    for (const k of ['cents', 'minimumCents']) if (!isCents(d[k])) problems.push(`${cls}.deep_interior.${k}`);
    for (const k of ['perExtraSeatCents', 'perWheelchairPositionCents']) if (!(Number.isInteger(d[k]) && d[k] >= 0)) problems.push(`${cls}.deep_interior.${k}`);
    if (!isMinutes(d.minutes)) problems.push(`${cls}.deep_interior.minutes`);
    const roofs = (a.roof_cleaning && a.roof_cleaning.byRoofHeight) || {};
    for (const k of roofKeysFor(cls)) if (!roofs[k] || !isCents(roofs[k].cents) || !isMinutes(roofs[k].minutes)) problems.push(`${cls}.roof_cleaning.${k}`);
    const u = a.undercarriage_wash || {};
    if (!isCents(u.cents) || !isMinutes(u.minutes)) problems.push(`${cls}.undercarriage_wash`);
  }
  const c = card.configuration || {};
  for (const k of ['extraSeatCentsPerSeat', 'wheelchairPositionCents', 'superHighRoofCents']) if (!isCents(c[k])) problems.push(`configuration.${k}`);
  for (const k of ['minutesPerExtraSeat', 'minutesPerWheelchairPosition', 'superHighRoofMinutes']) if (!isMinutes(c[k])) problems.push(`configuration.${k}`);
  if (!isCents(card.mobileWaterCents)) problems.push('mobileWaterCents');
  const s = card.safeguards || {};
  if (!isCents(s.minimumTicketCents)) problems.push('safeguards.minimumTicketCents');
  if (!isCents(s.minimumRevenuePerHourCents)) problems.push('safeguards.minimumRevenuePerHourCents');
  const p = card.channelPolicy || {};
  if (!Array.isArray(p.comparableClasses) || !Number.isInteger(p.comparableMaxSeats)) problems.push('channelPolicy');
  if (!card.equipmentConfirmed || typeof card.equipmentConfirmed !== 'object') problems.push('equipmentConfirmed');
  const complete = problems.length === 0;
  const approved = complete && card.status === 'approved' && !!card.approvedBy && !Number.isNaN(Date.parse(card.approvedAt || ''));
  if (complete && !approved) problems.push('not_approved');
  return { approved, complete, problems };
}

function unique(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).map(String)));
}
const ceilTo = (cents, step) => Math.ceil(cents / step) * step;

function channelPolicyFrom(card) {
  const p = card && card.channelPolicy;
  if (!p || !Number.isInteger(p.comparableMaxSeats)) return null;
  return { status: card.status, comparableClasses: p.comparableClasses, comparableMaxSeats: p.comparableMaxSeats };
}

/**
 * Price a commercial request on the server.
 * request: { selection, service, addOns, condition, water, runoffRestricted, zip }
 *   selection  raw client catalog selection (re-resolved here)
 *   service    'interior_cleaning' | 'exterior_wash' | 'full_detail'
 *   addOns     subset of ADDONS
 *   condition  'normal' (default) | 'deep_interior' | a manual condition
 *   water      'customer' (default) | 'mobile' | 'none'  (undercarriage only)
 *   zip        service ZIP; distance and travel charge come from travel-fee.js
 * Returns { ok: true, totalCents, lines, ... } only with an approved card, otherwise
 * { ok: false, reason: 'invalid_vehicle' | 'invalid_service' | 'invalid_addon' |
 *   'addon_needs_other_service' | 'zip_required' | 'outside_service_area' | 'manual_quote' |
 *   'pricing_not_approved', ... } with no amount.
 */
function quoteCommercial(request, { rateCard = ACTIVE_RATE_CARD } = {}) {
  const req = request && typeof request === 'object' ? { ...request } : {};
  for (const f of CLIENT_AUTHORITY_FIELDS) delete req[f];
  const card = rateCard || ACTIVE_RATE_CARD;
  const manual = (reviewReasons, extra = {}) => ({ ok: false, reason: 'manual_quote', reviewReasons, ...extra });

  // 1. Vehicle: re-resolved and classified on the server.
  const c = Channel.classifyCommercialSelection(req.selection, { policy: channelPolicyFrom(card) });
  if (!c.ok) return { ok: false, reason: 'invalid_vehicle', fields: c.fields };
  if (c.category === Channel.CATEGORY.UNSUPPORTED) return manual(['unverified_configuration', ...(c.reviewReasons || [])]);
  const res = c.resolution;
  const cls = res.sizeClass;
  const cfg = res.configuration || {};

  // 2. One base service; add-ons only on a base that includes their work; each once.
  const service = String(req.service || '');
  if (QUOTE_ONLY_SERVICES.includes(service)) return manual([`quote_only:${service}`], { sizeClass: cls });
  if (!SERVICES.includes(service)) return { ok: false, reason: 'invalid_service' };
  const addOns = unique(req.addOns);
  for (const a of addOns) {
    if (!ADDONS.includes(a)) return { ok: false, reason: 'invalid_addon', addOn: a };
    if (a === 'cargo_box_interior' && !isBox(cls)) return { ok: false, reason: 'invalid_addon', addOn: a };
    if (ADDON_NEEDS[a] && !INCLUDES[service].includes(ADDON_NEEDS[a])) return { ok: false, reason: 'addon_needs_other_service', addOn: a };
  }

  // 3. Eligibility for an instant price.
  const reasons = [];
  if (MANUAL_ONLY_SIZE_CLASSES.includes(cls)) reasons.push('unsupported_vehicle_size');
  const condition = String(req.condition || 'normal');
  if (!INSTANT_CONDITIONS.includes(condition)) reasons.push(MANUAL_CONDITIONS.includes(condition) ? `condition_${condition}` : 'condition_unknown');
  if (condition === 'deep_interior' && !addOns.includes('deep_interior')) reasons.push('deep_condition_without_deep_addon');
  if ((cfg.passengerCapacity || 0) > INSTANT_LIMITS.maxSeats) reasons.push('seats_above_instant_range');
  if ((cfg.wheelchairPositions || 0) > INSTANT_LIMITS.maxWheelchairPositions) reasons.push('wheelchair_positions_above_instant_range');
  if (addOns.includes('cargo_box_interior')) reasons.push('cargo_box_interior_manual_quote');
  const row = card.sizeClasses && card.sizeClasses[cls];
  const eq = card.equipmentConfirmed || {};
  if (addOns.includes('roof_cleaning')) {
    if (cfg.roof === 'super_high') reasons.push('unsafe_roof_access');
    if (isTall(cls) && eq.roofPlatformForTallVehicles !== true) reasons.push('roof_access_equipment_not_confirmed');
  }
  const water = String(req.water || 'customer');
  if (addOns.includes('undercarriage_wash')) {
    if (isTall(cls) && eq.undercarriageKitForTrucksAndBuses !== true) reasons.push('undercarriage_access_not_supported');
    if (water === 'none') reasons.push('no_water_source');
    else if (water === 'mobile' && eq.mobileWaterApproved !== true) reasons.push('mobile_water_not_approved');
    else if (!['customer', 'mobile'].includes(water)) reasons.push('water_source_unknown');
    if (req.runoffRestricted === true) reasons.push('runoff_restricted_site');
  }

  // 4. Distance from the service ZIP (server-side) and the commercial boundary.
  if (!req.zip) return { ok: false, reason: 'zip_required' };
  const travel = Travel.resolveTravelForZip(req.zip);
  if (!travel) return { ok: false, reason: 'outside_service_area' };
  if (travel.miles > COMMERCIAL_AUTO_PRICING_MAX_MILES) {
    const lim = row && row.maxAutoMiles ? row.maxAutoMiles[service] : null;
    if (!(Number.isInteger(lim) && travel.miles <= lim)) reasons.push('beyond_auto_pricing_distance');
  }

  if (reasons.length) return manual(reasons, { sizeClass: cls, category: c.category });

  // 5. Amounts only from a complete, approved card.
  const check = validateRateCard(card);
  if (!check.approved) return { ok: false, reason: 'pricing_not_approved', sizeClass: cls, category: c.category, problemCount: check.problems.length, problems: check.problems.slice(0, 10) };

  // 6. Lines.
  const step = card.roundToCents;
  const conf = card.configuration;
  const lines = [];
  const carsTier = c.category === Channel.CATEGORY.COMPARABLE_VAN ? Channel.carsTierForComparable(c) : null;
  const parity = !!(carsTier && PRICING.cars.tiers[carsTier]);
  if (parity) lines.push({ code: service, cents: PRICING.cars.tiers[carsTier][CARS_FIELD[service]] * 100, source: `cars:${carsTier}` });
  else lines.push({ code: service, cents: row.services[service].cents, source: `commercial:${cls}` });
  let minutes = row.services[service].minutes;
  const extraSeats = isBox(cls) ? 0 : Math.max(0, (cfg.passengerCapacity || 0) - row.includedSeats);
  const wheelchairs = cfg.wheelchairPositions || 0;
  if (!parity && INCLUDES[service].includes('interior')) {
    if (extraSeats) {
      lines.push({ code: 'extra_seat', qty: extraSeats, cents: ceilTo(extraSeats * conf.extraSeatCentsPerSeat, step) });
      minutes += extraSeats * conf.minutesPerExtraSeat;
    }
    if (wheelchairs) {
      lines.push({ code: 'wheelchair_position', qty: wheelchairs, cents: ceilTo(wheelchairs * conf.wheelchairPositionCents, step) });
      minutes += wheelchairs * conf.minutesPerWheelchairPosition;
    }
  }
  if (INCLUDES[service].includes('exterior') && cfg.roof === 'super_high') {
    lines.push({ code: 'super_high_roof', cents: ceilTo(conf.superHighRoofCents, step) });
    minutes += conf.superHighRoofMinutes;
  }
  for (const a of addOns) {
    if (a === 'deep_interior') {
      const d = row.addOns.deep_interior;
      const raw = d.cents + extraSeats * d.perExtraSeatCents + wheelchairs * d.perWheelchairPositionCents;
      lines.push({ code: a, cents: Math.max(d.minimumCents, ceilTo(raw, step)) });
      minutes += d.minutes;
    } else if (a === 'roof_cleaning') {
      const byH = row.addOns.roof_cleaning.byRoofHeight;
      const r = byH.any || byH[cfg.roof || 'standard'];
      if (!r || !isCents(r.cents)) return manual(['roof_height_not_priced'], { sizeClass: cls });
      lines.push({ code: a, cents: r.cents });
      minutes += r.minutes;
    } else if (a === 'undercarriage_wash') {
      const u = row.addOns.undercarriage_wash;
      lines.push({ code: a, cents: u.cents });
      minutes += u.minutes;
      if (water === 'mobile') lines.push({ code: 'mobile_water', cents: card.mobileWaterCents });
    }
  }

  // 7. Minimum ticket and revenue per labor hour (services only, before travel).
  const subtotal = lines.reduce((sum, l) => sum + l.cents, 0);
  const s = card.safeguards;
  const floor = Math.max(s.minimumTicketCents, ceilTo(Math.ceil((minutes / 60) * s.minimumRevenuePerHourCents), step));
  if (subtotal < floor) lines.push({ code: 'minimum_job_adjustment', cents: floor - subtotal });
  const servicesCents = Math.max(subtotal, floor);

  // 8. Existing travel charge, unchanged.
  const travelCents = Math.round(travel.fee * 100);
  return {
    ok: true, sizeClass: cls, category: c.category, priceSource: parity ? 'cars_parity' : 'commercial_rate_card',
    lines, subtotalCents: subtotal, servicesCents, travelCents, totalCents: servicesCents + travelCents,
    miles: travel.miles, estimatedMinutes: minutes,
  };
}

/**
 * The only entry point a public endpoint may use later. It always uses ACTIVE_RATE_CARD
 * and, while COMMERCIAL_PUBLIC_PRICING_ENABLED is false, never returns an amount: only
 * whether the request would be priced or needs a manual quote.
 */
function publicCommercialQuote(request) {
  const r = quoteCommercial(request);
  if (COMMERCIAL_PUBLIC_PRICING_ENABLED === true && r.ok) return r;
  const out = { ok: false, reason: r.ok ? 'commercial_pricing_not_public' : r.reason };
  if (r.reviewReasons) out.reviewReasons = r.reviewReasons;
  if (r.sizeClass) out.sizeClass = r.sizeClass;
  return out;
}

function commercialCheckoutEnabled() {
  return COMMERCIAL_CHECKOUT_ENABLED === true && COMMERCIAL_PUBLIC_PRICING_ENABLED === true && validateRateCard(ACTIVE_RATE_CARD).approved;
}

/** What the admin sees on a stored request: size class and why it is not priced. */
function pricingStatusFor(resolution) {
  if (!resolution || !resolution.sizeClass) return { state: 'manual_quote' };
  return { state: validateRateCard(ACTIVE_RATE_CARD).approved ? 'priceable' : 'pricing_not_approved', sizeClass: resolution.sizeClass };
}

module.exports = {
  COMMERCIAL_CHECKOUT_ENABLED,
  COMMERCIAL_PUBLIC_PRICING_ENABLED,
  COMMERCIAL_AUTO_PRICING_MAX_MILES,
  SERVICES,
  PRICED_SERVICES,
  PRICED_ADDONS,
  ADDONS,
  QUOTE_ONLY_SERVICES,
  LABOR_ADJUSTMENTS,
  MANUAL_ONLY_SIZE_CLASSES,
  INSTANT_LIMITS,
  CLIENT_AUTHORITY_FIELDS,
  ACTIVE_RATE_CARD,
  draftRateCard,
  validateRateCard,
  quoteCommercial,
  publicCommercialQuote,
  commercialCheckoutEnabled,
  pricingStatusFor,
};
