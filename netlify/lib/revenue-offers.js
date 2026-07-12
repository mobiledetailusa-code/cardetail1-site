// Configurable offer engine — all financial offers disabled by default.

function envBool(name, fallback = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function envIntAny(names, fallback) {
  for (const name of names) {
    const n = Number(process.env[name]);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return fallback;
}

function getOfferConfig() {
  return {
    firstBooking: {
      enabled: envBool('FIRST_BOOKING_OFFER_ENABLED', false),
      percent: envIntAny(['FIRST_BOOKING_OFFER_PERCENT', 'FIRST_BOOKING_PERCENT'], 10),
      capCents: envIntAny(['FIRST_BOOKING_OFFER_CAP_CENTS', 'FIRST_BOOKING_CAP_CENTS'], 4000),
      triggerSeconds: envIntAny(['FIRST_BOOKING_OFFER_TRIGGER_SECONDS'], 120),
      id: 'first_booking_welcome',
      publicCode: 'WELCOME10',
    },
    multiVehicle: {
      enabled: envBool('MULTI_VEHICLE_OFFER_ENABLED', false),
      creditCents: envInt('MULTI_VEHICLE_ADDITIONAL_CREDIT_CENTS', 2500),
      maxAdditional: envInt('MULTI_VEHICLE_MAX_ADDITIONAL_VEHICLES', 2),
      id: 'multi_vehicle_same_visit',
    },
    stackingEnabled: envBool('FIRST_BOOKING_OFFER_STACKING', envBool('OFFER_STACKING_ENABLED', false)),
  };
}

const EXCLUDED_CATEGORIES = new Set(['fleet', 'commercial']);
const EXCLUDED_PACKAGE_IDS = new Set(['maint', 'custom']);

function isEligiblePackage(pkgId, category) {
  const id = String(pkgId || '').toLowerCase();
  const cat = String(category || '').toLowerCase();
  if (EXCLUDED_CATEGORIES.has(cat)) return false;
  if (EXCLUDED_PACKAGE_IDS.has(id)) return false;
  return true;
}

function computeFirstBookingDiscount(subtotalCents, cfg, ctx) {
  if (!cfg.enabled) return null;
  if (ctx.priorCompletedServices > 0 || ctx.priorOfferRedeemed) return null;
  if (ctx.isCustomQuote) return null;
  if (!isEligiblePackage(ctx.packageId, ctx.category)) return null;
  const subtotal = Math.max(0, Number(subtotalCents) || 0);
  if (subtotal <= 0) return null;
  const raw = Math.round(subtotal * (cfg.percent / 100));
  const discount = Math.min(raw, cfg.capCents);
  if (discount <= 0) return null;
  return {
    offer_id: cfg.id,
    eligibility: true,
    eligibility_reason: 'new_household_eligible_package',
    eligible_subtotal: subtotal,
    discount_amount: discount,
    redemption_status: 'pending',
  };
}

function computeMultiVehicleCredit(cfg, ctx) {
  if (!cfg.enabled) return null;
  if (ctx.isCommercial || ctx.vehicleCount >= 7) return null;
  if (!ctx.sameLocationSameVisit) return null;
  const additional = Math.max(0, Math.min(Number(ctx.vehicleCount) - 1, cfg.maxAdditional));
  if (additional <= 0) return null;
  const discount = additional * cfg.creditCents;
  return {
    offer_id: cfg.id,
    eligibility: true,
    eligibility_reason: 'multi_vehicle_same_visit',
    eligible_subtotal: Number(ctx.eligibleSubtotalCents || 0),
    discount_amount: discount,
    redemption_status: 'pending',
  };
}

function evaluateOffers(ctx) {
  const config = getOfferConfig();
  const offers = [];
  const first = computeFirstBookingDiscount(ctx.eligibleSubtotalCents, config.firstBooking, ctx);
  if (first) offers.push(first);
  const multi = computeMultiVehicleCredit(config.multiVehicle, ctx);
  if (multi) offers.push(multi);
  if (!offers.length) return { selected: null, candidates: [] };
  if (offers.length === 1 || config.stackingEnabled) {
    const totalDiscount = offers.reduce((s, o) => s + o.discount_amount, 0);
    return {
      selected: config.stackingEnabled
        ? { ...offers[0], offer_id: 'stacked', discount_amount: totalDiscount, stacked: offers.map(o => o.offer_id) }
        : offers[0],
      candidates: offers,
    };
  }
  const best = offers.reduce((a, b) => (b.discount_amount > a.discount_amount ? b : a));
  return { selected: best, candidates: offers };
}

module.exports = {
  getOfferConfig,
  evaluateOffers,
  isEligiblePackage,
};
