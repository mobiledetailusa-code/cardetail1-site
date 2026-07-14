// Server-authoritative booking offer application — WELCOME10 / first_booking_welcome.

const { evaluateOffers, getOfferConfig, isEligiblePackage } = require('./revenue-offers');
const { listRawBookings, normalizePhone } = require('./ops-db');

const OFFER_VERSION = 'WELCOME10-v1';
const WELCOME_OFFER_ID = 'first_booking_welcome';
const WELCOME_PUBLIC_NAME = 'New Customer Welcome — 10%';

const CLIENT_OFFER_BLOCKED_FIELDS = [
  'discountAmount', 'discount_amount', 'offerDiscount', 'offer_discount',
  'eligibleSubtotal', 'eligible_subtotal', 'finalSubtotal', 'final_subtotal',
  'offerPercent', 'offer_percent', 'offerCapCents', 'offer_cap_cents',
  'approvedFinalAmount', 'offerApplied', 'redemption_status', 'redemptionStatus',
];

const COMPLETED_STATUSES = new Set([
  'completed', 'paid', 'captured', 'service_completed', 'closed_won',
]);

function dollarsToCents(v) {
  return Math.round((Number(v) || 0) * 100);
}

function centsToDollars(c) {
  return Math.round((Number(c) || 0)) / 100;
}

function primaryVehicle(booking) {
  const vehicles = Array.isArray(booking.vehicles) ? booking.vehicles : [];
  if (vehicles.length) return vehicles[0];
  return {
    cat: booking.vehicleCategory || booking.category,
    pkgId: booking.packageId || booking.pkgId,
    pkgName: booking.package,
    subtotal: booking.packagePrice || 0,
  };
}

function vehiclePackageId(v) {
  return String(v.pkgId || v.packageId || v.package_id || '').toLowerCase()
    || inferPackageIdFromName(v.pkgName || v.package);
}

function inferPackageIdFromName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('maint')) return 'maint';
  if (n.includes('custom')) return 'custom';
  return '';
}

function computeEligibleServiceSubtotalCents(booking) {
  const vehicles = Array.isArray(booking.vehicles) && booking.vehicles.length
    ? booking.vehicles
    : [{
      cat: booking.vehicleCategory || booking.category,
      pkgId: booking.packageId || booking.pkgId,
      pkgName: booking.package,
      subtotal: booking.packagePrice || 0,
      addonTotal: booking.addonTotal || 0,
      addons: booking.addons || [],
    }];

  let cents = 0;
  for (const v of vehicles) {
    const cat = String(v.cat || v.vehicleCategory || booking.vehicleCategory || '').toLowerCase();
    const pkgId = vehiclePackageId(v);
    if (!isEligiblePackage(pkgId, cat)) continue;
    if (pkgId === 'custom') continue;
    const base = Number(v.subtotal);
    if (Number.isFinite(base) && base > 0) {
      cents += dollarsToCents(base);
    } else {
      const pkg = Number(v.basePrice || v.packagePrice || 0);
      const addons = Number(v.addonTotal || 0);
      if (pkg > 0) cents += dollarsToCents(pkg + addons);
    }
  }
  return Math.max(0, cents);
}

function bookingIdentityKeys(booking) {
  const phone = normalizePhone(booking.phone || '');
  const email = String(booking.email || '').trim().toLowerCase();
  return { phone, email };
}

function countPriorCompletedServices(bookings, booking) {
  const { phone, email } = bookingIdentityKeys(booking);
  if (!phone && !email) return 0;
  let count = 0;
  for (const b of bookings) {
    if (!b || b.isDraft) continue;
    const st = String(b.status || b.jobStatus || b.service_status || '').toLowerCase();
    const pay = String(b.paymentStatus || b.payment_status || '').toLowerCase();
    const matchPhone = phone && normalizePhone(b.phone || '') === phone;
    const matchEmail = email && String(b.email || '').trim().toLowerCase() === email;
    if (!matchPhone && !matchEmail) continue;
    if (COMPLETED_STATUSES.has(st) || pay === 'paid' || pay === 'captured') count += 1;
  }
  return count;
}

function hasPriorWelcomeRedemption(bookings, booking) {
  const { phone, email } = bookingIdentityKeys(booking);
  for (const b of bookings) {
    if (!b || b.isDraft) continue;
    const offer = b.offer || b.welcomeOffer || null;
    if (!offer) continue;
    const oid = String(offer.offer_id || offer.offerId || '').toLowerCase();
    if (oid !== WELCOME_OFFER_ID && oid !== 'welcome10') continue;
    const redeemed = String(offer.redemption_status || offer.redemptionStatus || '').toLowerCase();
    const matchPhone = phone && normalizePhone(b.phone || '') === phone;
    const matchEmail = email && String(b.email || '').trim().toLowerCase() === email;
    if (!matchPhone && !matchEmail) continue;
    if (redeemed === 'redeemed' || redeemed === 'applied') return true;
    if (!b.isDraft && Number(offer.discount_amount || offer.discountAmount || 0) > 0) {
      const st = String(b.status || '').toLowerCase();
      if (st && !['canceled', 'cancelled', 'draft'].includes(st)) return true;
    }
  }
  return false;
}

function isCustomQuoteBooking(booking) {
  const vehicles = Array.isArray(booking.vehicles) ? booking.vehicles : [];
  if (vehicles.some((v) => vehiclePackageId(v) === 'custom')) return true;
  const cat = String(booking.vehicleCategory || booking.category || '').toLowerCase();
  if (cat === 'fleet' || cat === 'commercial') return true;
  return String(booking.package || '').toLowerCase().includes('custom quote');
}

function stripClientOfferFields(booking) {
  for (const f of CLIENT_OFFER_BLOCKED_FIELDS) delete booking[f];
  if (booking.offer && typeof booking.offer === 'object') delete booking.offer;
  if (booking.welcomeOffer) delete booking.welcomeOffer;
}

async function buildOfferEvaluationContext(booking) {
  const bookings = await listRawBookings().catch(() => []);
  const eligibleSubtotalCents = computeEligibleServiceSubtotalCents(booking);
  const pv = primaryVehicle(booking);
  const vehicleCount = Array.isArray(booking.vehicles) && booking.vehicles.length
    ? booking.vehicles.length
    : 1;
  const priorCompletedServices = countPriorCompletedServices(bookings, booking);
  const priorRedeemed = hasPriorWelcomeRedemption(bookings, booking);

  return {
    eligibleSubtotalCents,
    vehicleCount,
    sameLocationSameVisit: vehicleCount > 1,
    priorCompletedServices: priorRedeemed ? Math.max(1, priorCompletedServices) : priorCompletedServices,
    priorOfferRedeemed: priorRedeemed,
    packageId: vehiclePackageId(pv),
    category: String(pv.cat || booking.vehicleCategory || '').toLowerCase(),
    isCommercial: ['fleet', 'commercial'].includes(String(booking.vehicleCategory || '').toLowerCase()),
    isCustomQuote: isCustomQuoteBooking(booking),
    alreadyDiscounted: false,
  };
}

function ineligibleResult(reason, ctx, cfg) {
  return {
    offer_id: WELCOME_OFFER_ID,
    offer_version: OFFER_VERSION,
    public_name: WELCOME_PUBLIC_NAME,
    eligibility_status: 'ineligible',
    eligibility_reason: reason,
    eligible_subtotal: ctx.eligibleSubtotalCents,
    discount_amount: 0,
    percent: cfg.firstBooking.percent,
    cap_cents: cfg.firstBooking.capCents,
    final_subtotal: ctx.eligibleSubtotalCents,
    redemption_status: 'not_applied',
    source_trigger: null,
    applied_at: null,
  };
}

function formatSelectedOffer(selected, ctx, sourceTrigger) {
  const cfg = getOfferConfig();
  const now = new Date().toISOString();
  return {
    offer_id: selected.offer_id,
    offer_version: OFFER_VERSION,
    public_name: WELCOME_PUBLIC_NAME,
    eligibility_status: 'eligible',
    eligibility_reason: selected.eligibility_reason,
    eligible_subtotal: selected.eligible_subtotal,
    discount_amount: selected.discount_amount,
    percent: cfg.firstBooking.percent,
    cap_cents: cfg.firstBooking.capCents,
    final_subtotal: Math.max(0, ctx.eligibleSubtotalCents - selected.discount_amount),
    redemption_status: 'pending',
    household_redemption_ref: null,
    source_trigger: sourceTrigger || 'server_auto',
    applied_at: now,
  };
}

async function evaluateBookingOfferPreview(booking, { sourceTrigger = null } = {}) {
  const cfg = getOfferConfig();
  const ctx = await buildOfferEvaluationContext(booking);

  if (!cfg.firstBooking.enabled) {
    return { ok: true, offer: ineligibleResult('offer_disabled', ctx, cfg), travelExcluded: true };
  }
  if (ctx.isCustomQuote) {
    return { ok: true, offer: ineligibleResult('custom_quote_excluded', ctx, cfg) };
  }
  if (ctx.isCommercial) {
    return { ok: true, offer: ineligibleResult('fleet_excluded', ctx, cfg) };
  }
  if (ctx.priorOfferRedeemed) {
    return { ok: true, offer: ineligibleResult('prior_redemption', ctx, cfg) };
  }
  if (ctx.eligibleSubtotalCents <= 0) {
    return { ok: true, offer: ineligibleResult('no_eligible_subtotal', ctx, cfg) };
  }

  const result = evaluateOffers(ctx);
  if (!result.selected || result.selected.offer_id !== WELCOME_OFFER_ID) {
    const reason = ctx.priorCompletedServices > 0 ? 'returning_customer' : 'not_eligible';
    return { ok: true, offer: ineligibleResult(reason, ctx, cfg) };
  }

  return {
    ok: true,
    offer: formatSelectedOffer(result.selected, ctx, sourceTrigger),
    eligibleSubtotalCents: ctx.eligibleSubtotalCents,
  };
}

/**
 * Apply server offer after travel/pricing validation.
 * @param {object} booking — mutated in place
 * @param {object} opts — { serviceSubtotal, travelFee, sourceTrigger }
 */
async function applyServerOffersToBooking(booking, opts = {}) {
  stripClientOfferFields(booking);
  const preview = await evaluateBookingOfferPreview(booking, {
    sourceTrigger: booking.welcomeOfferSource || opts.sourceTrigger || null,
  });
  const offer = preview.offer;
  booking.offer = offer;
  booking.welcomeOffer = offer;

  const travel = Number(opts.travelFee ?? booking.travelFeeAmount ?? booking.zoneSurcharge ?? 0);
  const serviceSubtotal = Number.isFinite(opts.serviceSubtotal)
    ? opts.serviceSubtotal
    : centsToDollars(offer.eligible_subtotal || computeEligibleServiceSubtotalCents(booking));

  booking.serviceSubtotal = serviceSubtotal;
  booking.travelFeeAmount = travel;
  booking.zoneSurcharge = travel;

  const discountDollars = offer.eligibility_status === 'eligible'
    ? centsToDollars(offer.discount_amount)
    : 0;

  booking.discountAmount = discountDollars;
  booking.approvedDiscount = discountDollars;
  const preDiscountTotal = Math.round((serviceSubtotal + travel) * 100) / 100;
  booking.preDiscountTotal = preDiscountTotal;
  booking.totalPrice = Math.max(0, Math.round((preDiscountTotal - discountDollars) * 100) / 100);
  booking.approvedFinalAmount = booking.totalPrice;
  booking.finalAmount = booking.totalPrice;

  return { offer, discountDollars, preDiscountTotal, totalPrice: booking.totalPrice };
}

module.exports = {
  OFFER_VERSION,
  WELCOME_OFFER_ID,
  WELCOME_PUBLIC_NAME,
  CLIENT_OFFER_BLOCKED_FIELDS,
  computeEligibleServiceSubtotalCents,
  evaluateBookingOfferPreview,
  applyServerOffersToBooking,
  stripClientOfferFields,
  buildOfferEvaluationContext,
};
