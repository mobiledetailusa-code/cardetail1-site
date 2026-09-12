/* Shared 3D studio icons for packs, categories, and size chips. */
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

  /* Phase A: size chips / confirmation use photorealistic studio renders. */
  const STUDIO_BASE = 'assets/vehicles/studio/';
  const TIER = {
    small: { file: 'small-car.webp', alt: 'Small car', studio: true },
    sedan: { file: 'small-car.webp', alt: 'Sedan', studio: true },
    suv2: { file: 'suv-2row.webp', alt: 'Two-row SUV', studio: true },
    suv3: { file: 'suv-3row.webp', alt: 'Three-row SUV', studio: true },
    compact_van: { file: 'compact-van.webp', alt: 'Compact van', studio: true },
    midsize_van: { file: 'midsize-van.webp', alt: 'Midsize van', studio: true },
    full_size_van: { file: 'cargo-van.webp', alt: 'Full-size cargo van', studio: true },
    full_size_van_passenger: { file: 'passenger-van.webp', alt: 'Full-size passenger van', studio: true },
    truck: { file: 'truck.webp', alt: 'Pickup truck', studio: true },
    motorcycle: { file: 'motorcycle.webp', alt: 'Motorcycle', studio: true },
    atv: { file: 'atv.webp', alt: 'ATV', studio: true },
    utv: { file: 'utv.webp', alt: 'UTV side-by-side', studio: true },
    jetski: { file: 'jetski.webp', alt: 'Jet ski', studio: true },
  };

  function visual(entry) {
    if (!entry) return null;
    const base = entry.studio ? STUDIO_BASE : BASE;
    return { img: base + entry.file, alt: entry.alt };
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
})(typeof window !== 'undefined' ? window : globalThis);
