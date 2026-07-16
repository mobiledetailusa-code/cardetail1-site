// Server-side booking price catalog — mirrors index.html PRICING / LENGTH_PRICING / RICH_ZIPS.

const PRICING = {
  cars: {
    tiers: {
      small: { label: 'Small Car', maint: 175, interior: 225, full: 285, refresh: 375, premium: 450 },
      suv2: { label: 'SUV 2-Row', maint: 215, interior: 250, full: 305, refresh: 425, premium: 550 },
      suv3: { label: 'SUV 3-Row', maint: 250, interior: 275, full: 315, refresh: 475, premium: 635 },
      truck: { label: 'Truck', maint: 250, interior: 275, full: 325, refresh: 465, premium: 615 },
    },
    addons: [
      { id: 'pethair', price: 95 }, { id: 'superint', price: 125 }, { id: 'odor', price: 90 },
      { id: 'mold', price: 149 }, { id: 'sanitize', price: 65 },
      { id: 'biohazard', price: 115 }, { id: 'engine', price: 45 }, { id: 'floormats', price: 20, qty: true },
      { id: 'rainx', price: 25 }, { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 },
      { id: 'claybar', price: 45 }, { id: 'headlight', price: 90 }, { id: 'babyseat', price: 20, qty: true },
      { id: 'stroller', price: 20, qty: true }, { id: 'trashcans', price: 25, qty: true },
    ],
  },
  boats: {
    tiers: {
      under20: { label: 'Under 20 ft', maint: 266, essential: 399, full: 599, premium: 933 },
      '20to25': { label: '20–25 ft', maint: 367, essential: 533, full: 800, premium: 1200 },
      '26to30': { label: '26–30 ft', maint: 466, essential: 666, full: 1000, premium: 1467 },
      over30: { label: '30+ ft', maint: 599, essential: 866, full: 1334, premium: 2001 },
    },
    addons: [
      { id: 'rainx', price: 25 }, { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 },
      { id: 'chrome', price: 85 }, { id: 'odor', price: 90 }, { id: 'mold', price: 149 },
      { id: 'sanitize', price: 65 }, { id: 'biohazard', price: 115 },
      { id: 'trashcans', price: 25, qty: true },
    ],
  },
  rvs: {
    tiers: {
      travel: {
        label: 'Travel Trailer',
        maint: 320, exterior: 466, interior: 460, premium: 1133, full: 1400,
        correction: 1248, correction_int: 1499,
      },
      fifthwheel: {
        label: 'Fifth Wheel',
        maint: 360, exterior: 599, interior: 576, premium: 1334, full: 1680,
        correction: 1560, correction_int: 1860,
      },
      classC: {
        label: 'Class C',
        maint: 380, exterior: 666, interior: 620, premium: 1534, full: 1860,
        correction: 1680, correction_int: 1980,
      },
      classA: {
        label: 'Class A',
        maint: 420, exterior: 866, interior: 760, premium: 1934, full: 2280,
        correction: 2080, correction_int: 2480,
      },
    },
    addons: [
      { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 }, { id: 'rainx', price: 25 },
      { id: 'biohazard', price: 115 }, { id: 'sanitize', price: 65 },
      { id: 'superint', price: 135 },
      { id: 'awning', price: 50, qty: true }, { id: 'roof', price: 50, qty: true },
      { id: 'capfront', price: 149 }, { id: 'pethair', price: 95 }, { id: 'odor', price: 90 },
      { id: 'trashcans', price: 25, qty: true },
    ],
  },
  powersports: {
    tiers: {
      motorcycle: { label: 'Motorcycle', wash: 119, essential: 186, full: 266, premium: 372 },
      atv: { label: 'ATV', wash: 119, essential: 186, full: 266, premium: 372 },
      utv: { label: 'UTV / Side-by-Side', wash: 146, essential: 226, full: 332, premium: 466 },
      jetski: { label: 'Jet Ski / PWC', wash: 119, essential: 186, full: 266, premium: 367 },
    },
    addons: [
      { id: 'polymer', price: 25 }, { id: 'wax1yr', price: 75 }, { id: 'rainx', price: 25 },
      { id: 'heavymud', price: 55 }, { id: 'seatdeep', price: 45 }, { id: 'storage', price: 35 },
      { id: 'wheeldet', price: 35 }, { id: 'waterspot', price: 35 }, { id: 'saltwash', price: 35 },
      { id: 'trimprot', price: 35 }, { id: 'lightdeg', price: 45 },
    ],
  },
  fleet: {
    tiers: {
      vehicle: { label: 'Cars / SUVs / Trucks Fleet', maint: 79, essential: 132, full: 212, premium: 306, custom: 0 },
      commercial: { label: 'Vans / Trucks / Buses', maint: 119, essential: 199, full: 319, premium: 0, custom: 0 },
      powersports: { label: 'Golf Carts / Powersports Fleet', maint: 60, essential: 92, full: 154, premium: 234, custom: 0 },
      marine_rv: { label: 'Boat / RV / Trailer Fleet', maint: 0, essential: 0, full: 0, premium: 0, custom: 0 },
    },
    addons: [
      { id: 'polymer', price: 25 }, { id: 'trashcans', price: 25 }, { id: 'disinfect', price: 20 },
      { id: 'biohazard', price: 115 }, { id: 'odor', price: 99 }, { id: 'heavymud', price: 65 },
    ],
  },
};

const LENGTH_PRICING = {
  boats: {
    min: 12, max: 60, defaultFt: 22, estimateOver: 36,
    packages: {
      maint: { perFt: 12, min: 199 },
      essential: { perFt: 21, min: 299 },
      full: { perFt: 30, min: 449 },
      premium: { perFt: 38, min: 699 },
    },
  },
  rvs: {
    min: 12, max: 45, defaultFt: 24, estimateOver: 40,
    packages: {
      maint: { perFt: 10, min: 279 },
      exterior: { perFt: 16, min: 399 },
      interior: { perFt: 24, min: 379 },
      premium: { perFt: 40, min: 899 },
      full: { perFt: 54, min: 1299 },
      correction: { perFt: 52, min: 1199 },
      correction_int: { perFt: 62, min: 1499 },
    },
  },
  fleet: {
    min: 10, max: 60, defaultFt: 24, estimateOver: 36,
    packages: {
      maint: { perFt: 13, min: 199 },
      essential: { perFt: 19, min: 332 },
      full: { perFt: 27, min: 599 },
      premium: { perFt: 35, min: 800 },
      custom: { perFt: 0, min: 0 },
    },
  },
};

const RICH_ZIPS = new Set([
  '07078', '07041', '07901', '07928', '07945', '07920', '07931', '07921',
  '07620', '07458', '07670', '07632', '07450', '07028', '07042', '07030',
  '07068', '07960', '07043', '07410', '07663', '07649', '07656', '07677',
  '10504', '10514', '10532', '10577', '10583', '10605', '10706', '10708',
  '11020', '11021', '11030', '11050', '11545', '11576', '11577', '11803',
  '11932', '11937', '11959', '11962', '11968', '11975',
  '10007', '10013', '10014', '10021', '10022', '10023', '10024', '10025', '10028',
  '06830', '06831', '06820', '06840', '06880', '06883', '06897', '06824',
]);

const PKG_ID_ALIASES = {
  'maintenance detail': 'maint',
  'interior detail': 'interior',
  'premium detail': 'full',
  'premium full detail': 'full',
  // Exterior Refresh & Protect (cars) — pkgId 'refresh'. Exact-name aliases are
  // required because inferPkgId's includes() fallback would otherwise match the
  // substring 'exterior' and mis-resolve this to the RV 'exterior' package.
  // NOTE: a bare 'exterior' alias is intentionally NOT added — 'exterior' is a
  // real RV package id and must not be globally remapped.
  'exterior refresh & protect': 'refresh',
  'exterior refresh and protect': 'refresh',
  'exterior refresh': 'refresh',
  'exterior detail': 'refresh',
  'exterior_refresh': 'refresh',
  'refresh': 'refresh',
  // Paint Correction / Enhancement stays on the premium/correction path — it is
  // NOT an alias for the cheaper 'refresh' package.
  'paint correction / enhancement': 'premium',
  'marine wash': 'maint',
  'essential marine': 'essential',
  'full marine detail': 'full',
  'premium marine': 'premium',
  'maintenance wash': 'maint',
  'exterior wash': 'exterior',
  'exterior wash & protect': 'exterior',
  'exterior wash and protect': 'exterior',
  'full rv detail': 'full',
  'premium complete detail': 'full',
  'premium exterior': 'premium',
  'premium exterior detail': 'premium',
  'one-step paint correction': 'correction',
  'one-step paint correction + interior': 'correction_int',
  'one-step paint correction and interior': 'correction_int',
  'wash & shine': 'wash',
  'essential detail': 'essential',
  'full detail': 'full',
  'fleet maintenance wash': 'maint',
  'fleet essential detail': 'essential',
  'fleet full detail': 'full',
  'fleet premium protection': 'premium',
  'custom fleet quote': 'custom',
};

function normalizeZip(zip) {
  return String(zip || '').replace(/\D/g, '').slice(0, 5);
}

function getRichMultiplier(zip) {
  return RICH_ZIPS.has(normalizeZip(zip)) ? 1.05 : 1.0;
}

function applyRichPrice(base, zip) {
  return base ? Math.round(base * getRichMultiplier(zip)) : 0;
}

function getLengthPrice(cat, pkgId, ft) {
  const cfg = LENGTH_PRICING[cat];
  if (!cfg || !cfg.packages[pkgId]) return null;
  const rule = cfg.packages[pkgId];
  return Math.max(rule.min, Math.round(rule.perFt * Number(ft || cfg.defaultFt)));
}

function inferPkgId(vehicle, booking) {
  if (vehicle.pkgId) return vehicle.pkgId;
  const name = String(vehicle.pkgName || booking.package || '').trim().toLowerCase();
  if (PKG_ID_ALIASES[name]) return PKG_ID_ALIASES[name];
  const cat = vehicle.cat || booking.vehicleCategory;
  const pkgs = PRICING[cat];
  if (!pkgs) return null;
  if (name.includes('correction') && name.includes('interior')) return 'correction_int';
  if (name.includes('paint correction') || name.includes('one-step paint')) return 'correction';
  if (name.includes('premium complete')) return 'full';
  if (name.includes('wash & protect') || name.includes('wash and protect')) return 'exterior';
  for (const key of ['maint', 'interior', 'full', 'premium', 'essential', 'exterior', 'wash', 'custom', 'correction']) {
    if (name.includes(key.replace('_', ' '))) return key;
  }
  return null;
}

function resolveTierKey(vehicle) {
  if (vehicle.tierKey) return vehicle.tierKey;
  const cat = vehicle.cat;
  if (cat === 'boats' || cat === 'rvs') return 'length';
  if (cat === 'fleet') {
    const label = String(vehicle.vehicleLabel || '');
    if (/avg\s+\d+\s*ft/i.test(label) || (/unit fleet/i.test(label) && /\d+\s*ft/i.test(label))) {
      return 'marine_rv';
    }
  }
  const tiers = PRICING[cat]?.tiers;
  const tierLabel = String(vehicle.tierLabel || '').trim();
  if (tiers && tierLabel) {
    for (const [key, tier] of Object.entries(tiers)) {
      if (tier.label === tierLabel) return key;
    }
  }
  return null;
}

function parseLengthFt(vehicle, booking) {
  const raw = vehicle.lengthFt ?? booking?.lengthFt;
  if (raw != null && raw !== '') return Number(raw);
  const label = String(vehicle.vehicleLabel || '');
  const avg = label.match(/avg\s+(\d+)\s*ft/i);
  if (avg) return Number(avg[1]);
  const ft = label.match(/(\d+)\s*ft/i);
  return ft ? Number(ft[1]) : null;
}

function parseUnits(vehicle, booking) {
  const raw = vehicle.units ?? booking?.units;
  if (raw != null && raw !== '') return Math.max(1, Number(raw));
  const label = String(vehicle.vehicleLabel || '');
  const m = label.match(/^(\d+)\s*unit fleet/i);
  if (m) return Number(m[1]);
  return vehicle.cat === 'fleet' ? 2 : 1;
}

function computeAddonTotal(vehicle) {
  const cat = vehicle.cat;
  const catalog = PRICING[cat]?.addons || [];
  let total = 0;
  const normalized = [];
  for (const a of (vehicle.addons || [])) {
    const def = catalog.find((x) => x.id === a.id);
    if (!def) return { ok: false, error: 'invalid_pricing' };
    const qty = Math.max(1, Number(a.qty) || 1);
    total += def.price * qty;
    normalized.push({ id: a.id, name: a.name || def.name || a.id, price: def.price, qty });
  }
  return { ok: true, total, addons: normalized };
}

function computeVehicleBasePrice(vehicle, zip, booking) {
  const cat = vehicle.cat || booking?.vehicleCategory;
  const pkgId = inferPkgId(vehicle, booking);
  if (!cat || !pkgId || !PRICING[cat]) return { ok: false, error: 'invalid_pricing' };

  const tiers = PRICING[cat].tiers;
  const tierKey = resolveTierKey({ ...vehicle, cat });

  if (cat === 'boats' || cat === 'rvs') {
    const cfg = LENGTH_PRICING[cat];
    const ft = parseLengthFt(vehicle, booking) || cfg.defaultFt;
    const raw = getLengthPrice(cat, pkgId, ft);
    if (raw == null) return { ok: false, error: 'invalid_pricing' };
    // Client length path (tryGenericConfirm) does not apply rich multiplier.
    return { ok: true, basePrice: raw, cat, pkgId, tierKey: tierKey || 'length' };
  }

  if (cat === 'fleet') {
    const units = parseUnits(vehicle, booking);
    if (pkgId === 'custom') return { ok: true, basePrice: 0, cat, pkgId, tierKey };
    if (tierKey === 'marine_rv') {
      const ft = parseLengthFt(vehicle, booking) || LENGTH_PRICING.fleet.defaultFt;
      const unitPrice = getLengthPrice('fleet', pkgId, ft);
      if (unitPrice == null) return { ok: false, error: 'invalid_pricing' };
      return { ok: true, basePrice: unitPrice * units, cat, pkgId, tierKey };
    }
    const tier = tierKey ? tiers[tierKey] : null;
    if (!tier) return { ok: false, error: 'invalid_pricing' };
    const unitPrice = tier[pkgId];
    if (!unitPrice) return { ok: true, basePrice: 0, cat, pkgId, tierKey };
    return { ok: true, basePrice: unitPrice * units, cat, pkgId, tierKey };
  }

  const tier = tierKey ? tiers[tierKey] : null;
  if (!tier) return { ok: false, error: 'invalid_pricing' };
  const raw = tier[pkgId] ?? tier.wash ?? tier.maint ?? tier.exterior ?? 0;
  if (!raw) return { ok: false, error: 'invalid_pricing' };
  return { ok: true, basePrice: applyRichPrice(raw, zip), cat, pkgId, tierKey };
}

function vehiclesFromBooking(booking) {
  if (Array.isArray(booking.vehicles) && booking.vehicles.length) return booking.vehicles;
  const cat = booking.vehicleCategory;
  if (!cat) return [];
  return [{
    cat,
    pkgId: inferPkgId({ pkgName: booking.package }, booking),
    pkgName: booking.package,
    tierLabel: booking.vehicleTier,
    vehicleLabel: booking.vehicle || booking.vehicleLabel,
    lengthFt: booking.lengthFt,
    units: booking.units,
    addons: booking.addons || [],
  }];
}

function computeVehicleSubtotal(vehicle, zip, booking) {
  const base = computeVehicleBasePrice(vehicle, zip, booking);
  if (!base.ok) return base;
  const addons = computeAddonTotal({ ...vehicle, cat: base.cat });
  if (!addons.ok) return addons;
  const subtotal = base.basePrice + addons.total;
  return {
    ok: true,
    subtotal,
    basePrice: base.basePrice,
    addonTotal: addons.total,
    addons: addons.addons,
    cat: base.cat,
    pkgId: base.pkgId,
    tierKey: base.tierKey,
  };
}

function computeBookingServiceSubtotal(booking) {
  const zip = booking.zipCode || booking.zip || '';
  const vehicles = vehiclesFromBooking(booking);
  if (!vehicles.length) return { ok: false, error: 'invalid_pricing' };

  let serviceSubtotal = 0;
  const updatedVehicles = [];
  for (const v of vehicles) {
    const r = computeVehicleSubtotal(v, zip, booking);
    if (!r.ok) return r;
    serviceSubtotal += r.subtotal;
    updatedVehicles.push({
      ...v,
      cat: r.cat,
      pkgId: r.pkgId,
      tierKey: r.tierKey,
      basePrice: r.basePrice,
      addonTotal: r.addonTotal,
      addons: r.addons,
      subtotal: r.subtotal,
    });
  }
  return { ok: true, serviceSubtotal, vehicles: updatedVehicles };
}

function validateAndRecalculateBookingPricing(booking) {
  const result = computeBookingServiceSubtotal(booking);
  if (!result.ok) return result;
  return {
    ok: true,
    serviceSubtotal: result.serviceSubtotal,
    vehicles: result.vehicles,
    clientTotal: Number(booking.totalPrice) || 0,
  };
}

module.exports = {
  PRICING,
  LENGTH_PRICING,
  RICH_ZIPS,
  getRichMultiplier,
  applyRichPrice,
  getLengthPrice,
  computeAddonTotal,
  computeVehicleSubtotal,
  computeBookingServiceSubtotal,
  validateAndRecalculateBookingPricing,
  vehiclesFromBooking,
};
