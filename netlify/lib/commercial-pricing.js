'use strict';

/**
 * Commercial & specialty pricing foundation (Phase 2A). NOT ACTIVE.
 *
 * The structure the owner fills in before commercial prices can go live:
 * size classes x services, extras, extra labor for unusual configurations,
 * and minimum profitability safeguards. Every amount is null: no commercial
 * price exists yet, and quoteCommercial() refuses to price until a complete
 * rate card is marked approved.
 *
 * Server authority:
 *  - The size class comes from assets/commercial-vehicle-catalog.js
 *    resolveSelection(), never from the request. Client-sent tier, size class,
 *    dimensions or prices are ignored.
 *  - Commercial size classes (cv_*) are separate from the cars / trucks tiers
 *    in booking-price-catalog.js, so no commercial vehicle can be priced with
 *    passenger-car or pickup rates, and cars pricing is untouched.
 *
 * Checkout: COMMERCIAL_CHECKOUT_ENABLED is a code constant (not an env var or
 * payment setting). Turning it on is a reviewed code change after the rate card
 * is approved.
 */

const CommercialCatalog = require('../../assets/commercial-vehicle-catalog');

const COMMERCIAL_CHECKOUT_ENABLED = false;

/** Services that will be priced per size class. Others stay quote-only. */
const PRICED_SERVICES = Object.freeze(['interior_cleaning', 'exterior_wash', 'full_detail']);
const PRICED_EXTRAS = Object.freeze(['roof_cleaning', 'undercarriage_wash']);

/** Extra labor for configurations that take longer than the size class implies. */
const LABOR_ADJUSTMENTS = Object.freeze({
  wheelchair_position: 'Per wheelchair position (securements, lift or ramp area)',
  super_high_roof: 'Super-high roof (ladder / reach work)',
  high_seat_count: 'Passenger seating above 15 seats',
});

function emptyServiceRow() {
  return { interior_cleaning: null, exterior_wash: null, full_detail: null, roof_cleaning: null, undercarriage_wash: null, estimatedMinutes: null };
}

/**
 * The unapproved draft rate card. Amounts are integer cents once filled in.
 * status must become 'approved' with approvedBy / approvedAt for any quote.
 */
function draftRateCard() {
  const sizeClasses = {};
  for (const key of CommercialCatalog.SIZE_CLASSES) sizeClasses[key] = emptyServiceRow();
  const labor = {};
  for (const key of Object.keys(LABOR_ADJUSTMENTS)) labor[key] = null;
  return {
    version: 1,
    status: 'draft',
    approvedBy: null,
    approvedAt: null,
    currency: 'USD',
    sizeClasses,
    labor,
    safeguards: {
      // Lowest total for any commercial job.
      minimumTicketCents: null,
      // Lowest revenue per estimated labor hour; floors totals for long jobs.
      minimumRevenuePerHourCents: null,
    },
  };
}

const ACTIVE_RATE_CARD = Object.freeze(draftRateCard());

const isCents = (v) => Number.isInteger(v) && v > 0 && v <= 10000000;

/**
 * Check a rate card. Returns { approved, complete, problems }.
 * approved requires status 'approved', an approver, a date and every amount filled.
 */
function validateRateCard(card) {
  const problems = [];
  if (!card || typeof card !== 'object') return { approved: false, complete: false, problems: ['missing_rate_card'] };
  for (const key of CommercialCatalog.SIZE_CLASSES) {
    const row = card.sizeClasses && card.sizeClasses[key];
    if (!row) { problems.push(`${key}:missing`); continue; }
    for (const f of [...PRICED_SERVICES, ...PRICED_EXTRAS]) if (!isCents(row[f])) problems.push(`${key}.${f}`);
    if (!(Number.isInteger(row.estimatedMinutes) && row.estimatedMinutes > 0)) problems.push(`${key}.estimatedMinutes`);
  }
  for (const key of Object.keys(LABOR_ADJUSTMENTS)) if (!isCents(card.labor && card.labor[key])) problems.push(`labor.${key}`);
  const s = card.safeguards || {};
  if (!isCents(s.minimumTicketCents)) problems.push('safeguards.minimumTicketCents');
  if (!isCents(s.minimumRevenuePerHourCents)) problems.push('safeguards.minimumRevenuePerHourCents');
  const complete = problems.length === 0;
  const approved = complete && card.status === 'approved' && !!card.approvedBy && !Number.isNaN(Date.parse(card.approvedAt || ''));
  if (complete && !approved) problems.push('not_approved');
  return { approved, complete, problems };
}

function unique(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).map(String)));
}

/**
 * Price a commercial request on the server.
 * request: { selection, services, extras } — selection is the raw client
 * selection and is re-resolved here; any tier / sizeClass / price on the request
 * is ignored.
 * Returns { ok: true, totalCents, lines, sizeClass } or { ok: false, reason, ... }.
 */
function quoteCommercial(request, { rateCard = ACTIVE_RATE_CARD } = {}) {
  const req = request && typeof request === 'object' ? request : {};
  const resolved = CommercialCatalog.resolveSelection(req.selection);
  if (!resolved.ok) return { ok: false, reason: 'invalid_vehicle', fields: resolved.errors };
  const r = resolved.resolution;
  if (!r.sizeClass) return { ok: false, reason: 'manual_quote', reviewReasons: r.reviewReasons };

  const services = unique(req.services);
  const extras = unique(req.extras);
  const unpriced = services.filter((s) => !PRICED_SERVICES.includes(s))
    .concat(extras.filter((e) => !PRICED_EXTRAS.includes(e)));
  if (!services.some((s) => PRICED_SERVICES.includes(s))) return { ok: false, reason: 'manual_quote', reviewReasons: ['no_priced_service'] };
  if (unpriced.length) return { ok: false, reason: 'manual_quote', reviewReasons: unpriced.map((s) => `quote_only:${s}`) };

  const check = validateRateCard(rateCard);
  if (!check.approved) return { ok: false, reason: 'pricing_not_approved', sizeClass: r.sizeClass, problems: check.problems };

  const row = rateCard.sizeClasses[r.sizeClass];
  const lines = [];
  // Full detail already covers interior and exterior: never bill them twice.
  const billed = services.includes('full_detail') ? ['full_detail'] : services.filter((s) => PRICED_SERVICES.includes(s));
  for (const s of billed) lines.push({ code: s, cents: row[s] });
  for (const e of extras) lines.push({ code: e, cents: row[e] });

  const cfg = r.configuration;
  if (cfg.wheelchairPositions > 0) {
    lines.push({ code: 'wheelchair_position', qty: cfg.wheelchairPositions, cents: rateCard.labor.wheelchair_position * cfg.wheelchairPositions });
  }
  if (cfg.roof === 'super_high') lines.push({ code: 'super_high_roof', cents: rateCard.labor.super_high_roof });
  if (cfg.passengerCapacity > 15) lines.push({ code: 'high_seat_count', cents: rateCard.labor.high_seat_count });

  const subtotal = lines.reduce((sum, l) => sum + l.cents, 0);
  const s = rateCard.safeguards;
  const laborFloor = Math.ceil((row.estimatedMinutes / 60) * s.minimumRevenuePerHourCents);
  const floor = Math.max(s.minimumTicketCents, laborFloor);
  const totalCents = Math.max(subtotal, floor);
  if (totalCents > subtotal) lines.push({ code: 'minimum_job_adjustment', cents: totalCents - subtotal });
  return { ok: true, sizeClass: r.sizeClass, lines, subtotalCents: subtotal, totalCents };
}

function commercialCheckoutEnabled() {
  return COMMERCIAL_CHECKOUT_ENABLED === true && validateRateCard(ACTIVE_RATE_CARD).approved;
}

/** What the admin sees on a stored request: size class and why it is not priced. */
function pricingStatusFor(resolution) {
  if (!resolution || !resolution.sizeClass) return { state: 'manual_quote' };
  return { state: validateRateCard(ACTIVE_RATE_CARD).approved ? 'priceable' : 'pricing_not_approved', sizeClass: resolution.sizeClass };
}

module.exports = {
  COMMERCIAL_CHECKOUT_ENABLED,
  PRICED_SERVICES,
  PRICED_EXTRAS,
  LABOR_ADJUSTMENTS,
  ACTIVE_RATE_CARD,
  draftRateCard,
  validateRateCard,
  quoteCommercial,
  commercialCheckoutEnabled,
  pricingStatusFor,
};
