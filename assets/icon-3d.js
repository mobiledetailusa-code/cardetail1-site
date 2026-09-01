/* Shared 3D studio icons for packs, categories, size chips, and add-ons. */
(function (global) {
  const BASE = 'assets/icons/3d/';

  const FAMILY = {
    cars: { file: 'pack-cars-family.webp', alt: 'Sedans, SUVs, and trucks' },
    boats: { file: 'pack-boats-family.webp', alt: 'Boats, sailboats, and cruisers' },
    rvs: { file: 'pack-rvs-family.webp', alt: 'RVs and travel trailers' },
    powersports: { file: 'pack-powersports-family.webp', alt: 'Motorcycles, ATVs, and jet skis' },
    fleet: { file: 'pack-cars-family.webp', alt: 'Fleet vehicles' },
  };

  const PACK = {
    wash: { file: 'pack-wash.webp', alt: 'Exterior hand wash' },
    maint: { file: 'pack-maint.webp', alt: 'Maintenance wash' },
    maint_light: { file: 'pack-maint.webp', alt: 'Maintenance wash' },
    interior: { file: 'pack-interior.webp', alt: 'Interior detail' },
    full: { file: 'pack-full.webp', alt: 'Premium full detail' },
    full_basic: { file: 'pack-full.webp', alt: 'Full detail' },
    essential: { file: 'pack-full.webp', alt: 'Essential detail' },
    refresh: { file: 'pack-refresh.webp', alt: 'Exterior refresh and protect' },
    premium: { file: 'pack-premium.webp', alt: 'Signature interior and exterior restoration' },
    custom: { file: 'pack-full.webp', alt: 'Custom fleet package' },
  };

  const CAT = {
    cars: { file: 'cat-cars.webp', alt: 'Cars and trucks' },
    boats: { file: 'cat-boats.webp', alt: 'Boats' },
    rvs: { file: 'cat-rvs.webp', alt: 'RVs and trailers' },
    powersports: { file: 'cat-powersports.webp', alt: 'Powersports' },
    fleet: { file: 'cat-cars.webp', alt: 'Fleet vehicles' },
  };

  const TIER = {
    small: { file: 'tier-sedan.webp', alt: 'Sedan or compact' },
    sedan: { file: 'tier-sedan.webp', alt: 'Sedan' },
    suv2: { file: 'tier-suv.webp', alt: 'Two-row SUV' },
    suv3: { file: 'tier-suv3.webp', alt: 'Three-row SUV' },
    truck: { file: 'tier-truck.webp', alt: 'Pickup truck' },
  };

  const ADDON = {
    wax1yr: { file: 'addon-wax.webp', alt: 'Carnauba wax' },
    polymer: { file: 'addon-wax.webp', alt: 'Polymer sealant' },
    claybar: { file: 'addon-claybar.webp', alt: 'Clay bar treatment' },
    engine: { file: 'addon-engine.webp', alt: 'Engine bay detailing' },
    rainx: { file: 'addon-rainx.webp', alt: 'Rain-X glass treatment' },
    headlight: { file: 'addon-headlight.webp', alt: 'Headlight restoration' },
    pethair: { file: 'addon-pethair.webp', alt: 'Pet hair removal' },
  };

  function visual(entry) {
    if (!entry) return null;
    return { img: BASE + entry.file, alt: entry.alt };
  }

  global.icon3dPack = function (id, cat) {
    const family = FAMILY[cat || 'cars'];
    if (family) return visual(family);
    return visual(PACK[id] || FAMILY.cars);
  };
  global.icon3dCategory = function (cat) {
    return visual(CAT[cat] || null);
  };
  global.icon3dTier = function (key) {
    return visual(TIER[key] || null);
  };
  global.icon3dAddon = function (id) {
    return visual(ADDON[id] || null);
  };
})(typeof window !== 'undefined' ? window : globalThis);
