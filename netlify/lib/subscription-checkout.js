// Shared subscription checkout logic — pricing, validation, Stripe Price ID mapping.
// Amounts are always derived from customer-catalog.js; never trust client price fields.
//
// Optional Netlify env vars (recurring Price IDs created in Stripe Dashboard):
//   STRIPE_PRICE_SUB_MAINT      — Maintenance Detail monthly (10% off walk-in)
//   STRIPE_PRICE_SUB_INTERIOR   — Interior Detail monthly
//   STRIPE_PRICE_SUB_FULL       — Premium Detail monthly
//   STRIPE_PRICE_SUB_REFRESH    — Exterior Refresh & Protect monthly
//   STRIPE_PRICE_SUB_PREMIUM    — Signature Restoration monthly
//   STRIPE_PRICE_SUB_FLEET_2_<PACK>  — e.g. STRIPE_PRICE_SUB_FLEET_2_MAINT (PACK = MAINT|INTERIOR|FULL|REFRESH|PREMIUM)
//   STRIPE_PRICE_SUB_FLEET_3_<PACK>  — e.g. STRIPE_PRICE_SUB_FLEET_3_MAINT
// Full table: STRIPE-SUBSCRIPTION-PRICE-IDS.md
// When unset, Checkout uses dynamic price_data computed server-side.

const { sanitizeText } = require('./tech-security');
const { normalizePhone, phonesMatch } = require('./ops-db');
const {
  CAR_PACKAGES, FLEET_PLANS, subscriberPrice, fleetMonthlyPrice,
} = require('./customer-catalog');

const FORBIDDEN_CLIENT_PRICE_FIELDS = [
  'monthlyPrice', 'totalPrice', 'amountCents', 'price', 'unit_amount',
  'expectedMonthlyPrice', 'clientMonthlyPrice', 'monthly_price',
];

function rejectClientPriceFields(body) {
  for (const k of FORBIDDEN_CLIENT_PRICE_FIELDS) {
    if (body[k] != null && body[k] !== '') {
      return { ok: false, error: 'client_price_not_allowed', field: k };
    }
  }
  return { ok: true };
}

function verifyCustomer(body) {
  const email = sanitizeText(body.email, 200).toLowerCase();
  const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15);
  if (!email.includes('@')) return { ok: false, error: 'valid_email_required' };
  if (!phone || phone.length < 7) return { ok: false, error: 'phone_required' };
  return { ok: true, email, phone };
}

function findOwnedBooking(bookingId, email, phone, bookings) {
  if (!bookingId) return null;
  return (bookings || []).find(b =>
    b.id === bookingId &&
    !b.isDraft &&
    !b.archived &&
    b.jobStatus !== 'archived_test' &&
    String(b.email || '').toLowerCase() === email &&
    phonesMatch(phone, normalizePhone(b.phone || b.customerPhone || ''))
  ) || null;
}

function hasVerifiedBooking(email, phone, bookings) {
  return (bookings || []).some(bk =>
    !bk.isDraft && !bk.archived && bk.jobStatus !== 'archived_test' &&
    String(bk.email || '').toLowerCase() === email &&
    phonesMatch(phone, normalizePhone(bk.phone || bk.customerPhone || ''))
  );
}

function resolveMonthlyCents(packId, fleetId) {
  const pack = CAR_PACKAGES.find(p => p.id === packId);
  if (!pack) return null;
  let dollars = subscriberPrice(pack.basePrice);
  let fleet = null;
  if (fleetId) {
    fleet = FLEET_PLANS.find(f => f.id === fleetId);
    if (!fleet) return null;
    dollars = fleetMonthlyPrice(pack.basePrice, fleet);
  }
  const cents = Math.round(dollars * 100);
  if (cents < 500) return null;
  return { cents, dollars, pack, fleet };
}

function stripePriceEnvKey(packId, fleetId) {
  const pack = String(packId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (fleetId === 'fleet-2') return `STRIPE_PRICE_SUB_FLEET_2_${pack}`;
  if (fleetId === 'fleet-3') return `STRIPE_PRICE_SUB_FLEET_3_${pack}`;
  return `STRIPE_PRICE_SUB_${pack}`;
}

function resolveStripePriceId(packId, fleetId) {
  const key = stripePriceEnvKey(packId, fleetId);
  const id = process.env[key];
  return id && String(id).startsWith('price_') ? String(id) : null;
}

async function validateStripePriceAmount(priceId, expectedCents, secret, packId, fleetId) {
  const res = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const price = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: (price.error && price.error.message) || 'stripe_price_lookup_failed' };
  }
  if (price.unit_amount !== expectedCents) {
    return {
      ok: false,
      error: 'stripe_price_mismatch',
      message: `Env ${stripePriceEnvKey(packId, fleetId)} amount does not match catalog`,
      expectedCents,
      actualCents: price.unit_amount,
    };
  }
  return { ok: true, price };
}

function buildCheckoutLineItemParams(pricing, packId, fleetId, planLabel, stripePriceId) {
  if (stripePriceId) {
    return {
      'line_items[0][price]': stripePriceId,
      'line_items[0][quantity]': '1',
    };
  }
  return {
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': `Cardetail1 ${planLabel}`,
    'line_items[0][price_data][product_data][description]': 'Monthly maintenance subscription — max 1 detail per month per vehicle. 10% subscriber discount applied.',
    'line_items[0][price_data][unit_amount]': String(pricing.cents),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][quantity]': '1',
  };
}

module.exports = {
  FORBIDDEN_CLIENT_PRICE_FIELDS,
  rejectClientPriceFields,
  verifyCustomer,
  findOwnedBooking,
  hasVerifiedBooking,
  resolveMonthlyCents,
  stripePriceEnvKey,
  resolveStripePriceId,
  validateStripePriceAmount,
  buildCheckoutLineItemParams,
};
