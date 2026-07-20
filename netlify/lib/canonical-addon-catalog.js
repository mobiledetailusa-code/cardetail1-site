/**
 * Stage 2 — customer-facing add-on catalog serializer.
 *
 * Price authority is exclusively booking-price-catalog PRICING.
 * Display name/description metadata carries no prices and is never used
 * for quote or PaymentIntent amounts.
 */

const { PRICING } = require('./booking-price-catalog');
const { asArray } = require('./historical-adapter');

/** Display-only labels (no prices). Keys must exist in PRICING[*].addons. */
const ADDON_DISPLAY = {
  pethair: {
    name: 'Pet Hair Removal',
    description: 'Deep pet hair removal from seats, carpets, mats, and trunk.',
  },
  superint: {
    name: 'Super Interior Upgrade',
    description: 'Extra shampoo passes and hand-steam on panels, pockets, and cargo areas.',
  },
  odor: {
    name: 'Odor Treatment & Sanitize',
    description: 'Treatment for smoke, food, pet, and general interior odors.',
  },
  mold: {
    name: 'Mold Treatment',
    description: 'Targeted mold treatment for affected interior areas. Inspection required.',
  },
  sanitize: {
    name: 'Interior Sanitizing',
    description: 'High-touch interior wipe-down after cleaning.',
  },
  biohazard: {
    name: 'Biohazard Cleaning',
    description: 'Bodily fluids or severe contamination. Estimate confirmation required.',
  },
  engine: {
    name: 'Engine Bay Top Clean',
    description: 'Top-view cleaning of visible engine bay surfaces. Not mechanical service.',
  },
  floormats: {
    name: 'Floor Mat Deep Clean',
    description: 'Deep shampoo and scrub of rubber or fabric floor mats.',
  },
  rainx: {
    name: 'Rain-X Glass Treatment',
    description: 'Water-repellent Rain-X on windshield and front glass.',
  },
  polymer: {
    name: 'Polymer Paint Sealant',
    description: 'Hand-applied polymer sealant for paint protection and gloss.',
  },
  wax1yr: {
    name: '1-Year Carnauba Wax',
    description: 'Premium carnauba wax with enhanced gloss and protection.',
  },
  claybar: {
    name: 'Clay Bar Treatment',
    description: 'Removes embedded contaminants for smooth paint.',
  },
  headlight: {
    name: 'Headlight Restoration',
    description: 'Clean, polish, and seal foggy headlights (per pair).',
  },
  babyseat: {
    name: 'Baby / Car Seat Cleaning',
    description: 'Clean child car seat straps, padding, and buckle.',
  },
  stroller: {
    name: 'Baby Stroller Cleaning',
    description: 'Wash stroller fabric, frame, and wheels.',
  },
  trashcans: {
    name: 'Trash Can Cleaning',
    description: 'Residential trash can cleaning at the service location.',
  },
  chrome: {
    name: 'Chrome / Stainless Polish',
    description: 'Polish accessible chrome, rails, cleats, and brightwork.',
  },
  awning: {
    name: 'Awning Cleaning',
    description: 'RV awning fabric wash and clean. Cleaning only.',
  },
  roof: {
    name: 'Roof Surface Cleaning',
    description: 'Exterior RV/trailer roof wash and clean. Cleaning only.',
  },
  capfront: {
    name: 'Front Cap Deep Clean',
    description: 'RV front cap exterior wash for bugs, grime, and road film.',
  },
  heavymud: {
    name: 'Heavy Mud / Trail Buildup',
    description: 'Extra cleaning for heavy mud, clay, and trail grime.',
  },
  seatdeep: {
    name: 'Seat Deep Clean',
    description: 'Deep cleaning for seats and riding surfaces.',
  },
  storage: {
    name: 'Storage Compartment Clean',
    description: 'Clean accessible storage compartments and bins.',
  },
  wheeldet: {
    name: 'Wheel Detail',
    description: 'Detailed wheel and rim cleaning.',
  },
  waterspot: {
    name: 'Water Spot Removal',
    description: 'Treat light water spots on exterior surfaces.',
  },
  saltwash: {
    name: 'Salt / Corrosion Rinse',
    description: 'Extra rinse for salt and coastal residue.',
  },
  trimprot: {
    name: 'Trim Protectant',
    description: 'UV protectant on exterior plastics and trim.',
  },
  lightdeg: {
    name: 'Light Degrease',
    description: 'Light degreasing of high-use exterior areas.',
  },
  disinfect: {
    name: 'Disinfect Touch Points',
    description: 'Disinfect high-touch surfaces per fleet unit.',
  },
  // Stage 1 financial fixture — price from PRICING.cars only
  ozone: {
    name: 'Ozone Odor Treatment',
    description: 'Ozone treatment for stubborn interior odors.',
  },
};

function titleFromId(id) {
  return String(id || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Add-on';
}

function displayFor(id) {
  const meta = ADDON_DISPLAY[id];
  if (meta) return { name: meta.name, description: meta.description || '' };
  return { name: titleFromId(id), description: '' };
}

/**
 * Serialize one PRICING category's add-ons for safe browser display.
 * priceCents always comes from booking-price-catalog.
 */
function serializeCategoryAddons(category) {
  const cat = String(category || '').trim() || 'cars';
  const rows = PRICING[cat]?.addons || [];
  return rows.map((def) => {
    const id = String(def.id || '').trim();
    const disp = displayFor(id);
    const priceDollars = Math.round(Number(def.price) || 0);
    return {
      id,
      name: disp.name,
      description: disp.description,
      priceCents: priceDollars * 100,
      categories: [cat],
      available: true,
      qtyAllowed: !!def.qty,
    };
  }).filter((a) => a.id);
}

/**
 * Full portal catalog: addonsByCategory + flat unique list (cars-first for legacy).
 * Flat `addons` uses authoritative cars prices when an id appears in multiple cats.
 */
function serializeCanonicalAddonCatalog() {
  const categories = Object.keys(PRICING);
  const addonsByCategory = {};
  const byId = new Map();

  for (const cat of categories) {
    const list = serializeCategoryAddons(cat);
    addonsByCategory[cat] = list;
    for (const row of list) {
      if (!byId.has(row.id)) {
        byId.set(row.id, { ...row, categories: [cat] });
      } else {
        const existing = byId.get(row.id);
        if (!existing.categories.includes(cat)) existing.categories.push(cat);
      }
    }
  }

  // Prefer cars entry for flat list price when present (matches booking default).
  const carsFirst = serializeCategoryAddons('cars');
  for (const row of carsFirst) {
    const existing = byId.get(row.id);
    if (existing) {
      existing.priceCents = row.priceCents;
      existing.name = row.name;
      existing.description = row.description;
    }
  }

  return {
    source: 'booking-price-catalog',
    addons: [...byId.values()],
    addonsByCategory,
  };
}

function bookingVehicleCategory(booking) {
  const v = (booking?.service && Array.isArray(booking.service.vehicles)
    ? booking.service.vehicles[0]
    : null)
    || (Array.isArray(booking?.vehicles) ? booking.vehicles[0] : null)
    || {};
  const raw = String(
    v.category || v.cat || booking?.vehicleCategory || booking?.cat || 'cars'
  ).toLowerCase().trim();
  if (raw === 'boat' || raw === 'boats') return 'boats';
  if (raw === 'rv' || raw === 'rvs' || raw === 'trailer' || raw === 'trailers') return 'rvs';
  if (raw === 'powersport' || raw === 'powersports') return 'powersports';
  if (raw === 'fleet') return 'fleet';
  if (PRICING[raw]) return raw;
  return 'cars';
}

function currentAddonIdsOnBooking(booking) {
  const v = (booking?.service && Array.isArray(booking.service.vehicles)
    ? booking.service.vehicles[0]
    : null)
    || (Array.isArray(booking?.vehicles) ? booking.vehicles[0] : null)
    || {};
  const fromIds = asArray(v.addOnIds).map((id) => String(id || '').trim()).filter(Boolean);
  if (fromIds.length) return fromIds;
  const fromObjs = asArray(v.addons || booking?.addons)
    .map((a) => String(a?.id || '').trim())
    .filter(Boolean);
  return fromObjs;
}

function parseAddonIdList(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(list.map((id) => String(id || '').trim()).filter(Boolean))];
}

/**
 * Narrow post-settlement carve-out for additive addon_request only.
 * Does not loosen canRequestChange / isInvoicePaid globally.
 */
function evaluatePostPayAdditiveAddonCarveOut(booking, body = {}) {
  const { isInvoicePaid } = require('./appointment-status-policy');
  const settled = Math.max(0, Math.round(Number(booking?.ledger?.settledCents) || 0));
  const postSettled = settled > 0 || isInvoicePaid(booking);
  if (!postSettled) {
    return { ok: false, reason: 'not_post_settlement' };
  }

  // Reject package / vehicle / remove fields in the same request.
  if (body.addOnIdsToRemove || body.addonIdsToRemove
    || (Array.isArray(body.removeAddonIds) && body.removeAddonIds.length)) {
    return { ok: false, error: 'settled_addon_remove_denied', statusCode: 409 };
  }
  if (body.newPackId || body.packageId || body.packageName) {
    return { ok: false, error: 'invoice_paid', statusCode: 409 };
  }
  if (body.category || body.vehicleCategory || body.tierKey || body.tier
    || body.make || body.model || body.year) {
    return { ok: false, error: 'invoice_paid', statusCode: 409 };
  }

  const addonIds = parseAddonIdList(body.addonIds || body.addOnIdsToAdd);
  if (!addonIds.length) {
    return { ok: false, error: 'validation_error', statusCode: 400, message: 'Please select at least one add-on.' };
  }

  const existing = new Set(currentAddonIdsOnBooking(booking));
  const genuinelyNew = addonIds.filter((id) => !existing.has(id));
  if (!genuinelyNew.length) {
    return {
      ok: false,
      error: 'duplicate_addon',
      statusCode: 200,
      noop: true,
      message: 'Selected add-on is already on this booking.',
    };
  }

  // Price from booking-price-catalog via canonical quote — ignore browser amounts.
  const { normalizeAggregate, ensureVehicleIds } = require('./booking-aggregate');
  const { applyServiceDelta, quoteService } = require('./canonical-quote');
  const { dollarsToCents } = require('./historical-adapter');

  const { ok, aggregate } = normalizeAggregate(booking);
  if (!ok) return { ok: false, error: 'invalid_aggregate', statusCode: 400 };

  const vehicles = ensureVehicleIds(aggregate.service?.vehicles || []);
  const vehicleId = vehicles[0]?.vehicleId;
  const applied = applyServiceDelta(aggregate.service, { vehicleId }, {
    addOnIdsToAdd: genuinelyNew,
    addOnIdsToRemove: [],
  });
  if (!applied.ok) {
    return { ok: false, error: applied.error || 'unknown_addon', statusCode: 400 };
  }
  if (applied.noop) {
    return {
      ok: false,
      error: 'duplicate_addon',
      statusCode: 200,
      noop: true,
      message: 'Selected add-on is already on this booking.',
    };
  }

  const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
  const quoted = quoteService(applied.service, {
    basedOnBookingVersion: aggregate.bookingVersion || 0,
    previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
    travelCents,
    bookingBase: aggregate,
  });
  if (!quoted.ok) {
    return { ok: false, error: quoted.error || 'invalid_pricing', statusCode: 400 };
  }

  const currentApproved = Math.max(
    0,
    Math.round(Number(aggregate.quote?.approvedCents ?? aggregate.ledger?.approvedCents) || 0)
  );
  const nextApproved = Math.max(0, Math.round(Number(quoted.quote.approvedCents) || 0));
  if (!(nextApproved > currentApproved)) {
    return { ok: false, error: 'invoice_paid', statusCode: 409 };
  }

  return {
    ok: true,
    addonIds: genuinelyNew,
    currentApprovedCents: currentApproved,
    proposedApprovedCents: nextApproved,
  };
}

module.exports = {
  ADDON_DISPLAY,
  serializeCanonicalAddonCatalog,
  serializeCategoryAddons,
  bookingVehicleCategory,
  currentAddonIdsOnBooking,
  parseAddonIdList,
  evaluatePostPayAdditiveAddonCarveOut,
};
