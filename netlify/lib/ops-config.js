// Platform operational settings — single blob `cd1-ops-settings` / key `platform`.
const { blobsStore } = require('./tech-security');

const SETTINGS_STORE = 'cd1-ops-settings';
const SETTINGS_KEY = 'platform';

const DEFAULT_SETTINGS = {
  // Auto-confirm: recommended OFF until rules mature (zone, card on file, fraud checks).
  autoConfirmAppointments: false,
  autoPostToAuctionOnConfirm: false,
  dispatchMode: 'manual', // manual | auction | auto_assign_lowest_bid
  bidMaxPercent: 62,
  bidMaxOverride: null,
  bidWindowMinutes: 60,
  bidWindowMinutesBoatRv: 90,
  requireCompoundExperience: true,
  minTechRatingToBid: 3.0,
  maintenancePlansEnabled: true,
  contractorAgreementVersion: 'v1',
  updatedAt: null,
};

const MAINTENANCE_PLAN_TEMPLATES = [
  { id: 'maint-monthly', name: 'Monthly Maintenance', intervalMonths: 1, suggestedPrice: 79 },
  { id: 'maint-bimonthly', name: 'Every 2 Months', intervalMonths: 2, suggestedPrice: 99 },
  { id: 'maint-quarterly', name: 'Quarterly', intervalMonths: 3, suggestedPrice: 119 },
  { id: 'maint-biannual', name: 'Every 6 Months', intervalMonths: 6, suggestedPrice: 149 },
  { id: 'maint-annual', name: 'Annual Detail', intervalMonths: 12, suggestedPrice: 199 },
];

// Pack catalog for technician equipment hints (aligned with index.html service names).
const SERVICE_PACKAGES = [
  {
    name: 'Maintenance Detail',
    aliases: ['maintenance detail', 'maintenance', 'maint detail', 'marine wash', 'fleet maintenance wash'],
    description: 'Exterior hand wash, wheels/tires, glass, door jambs, interior vacuum, dash wipe, leather conditioning, UV protectant.',
    equipment: [
      'Pressure washer or hose + foam cannon',
      'Microfiber wash mitts, drying towels, wheel brushes',
      'Shop vacuum + interior microfiber cloths',
      'Leather/plastic conditioner, tire dressing, UV protectant',
    ],
  },
  {
    name: 'Interior Detail',
    aliases: ['interior detail', 'interior', 'super interior'],
    description: 'Deep vacuum, carpet/seat shampoo, steam clean vents/panels, trim detail, interior glass, odor-neutral finish.',
    equipment: [
      'Shop vacuum with crevice tools',
      'Hot water extractor or carpet shampooer',
      'Steam cleaner for vents and panels',
      'Fabric/leather cleaners and microfiber towels',
    ],
  },
  {
    name: 'Premium Detail',
    aliases: ['premium detail', 'full detail', 'essential marine', 'full marine detail'],
    description: 'Maintenance-level exterior + clay bar, carpet/seat shampoo, steam clean, trunk detail, spray sealant, tire dressing.',
    equipment: [
      'Full exterior wash kit + clay bar and lubricant',
      'Extractor/steam cleaner for interior shampoo',
      'Spray sealant or polymer protection, tire dressing',
      'Microfiber towels for interior and exterior',
    ],
  },
  {
    name: 'Paint Correction',
    aliases: ['paint correction', 'compound', 'enhancement', 'premium marine', '1-step polish', 'swirl'],
    description: 'Machine polish, swirl/oxidation reduction, chemical decon, wheel detail, machine-applied sealant/wax.',
    equipment: [
      'DA or rotary polisher with cutting/finishing pads',
      'Compound + finishing polish, paint depth gauge recommended',
      'Iron decon and clay bar for prep',
      'Machine-applied wax or sealant, masking tape',
    ],
  },
  {
    name: 'Ceramic / Coating',
    aliases: ['ceramic', 'coating', 'ppf', 'sealant upgrade'],
    description: 'Prep wash, iron decon, paint prep, coating or sealant application per booking scope.',
    equipment: [
      'Prep wash + iron decon + clay bar',
      'IPA wipe-down towels and coating applicators',
      'IR lamp or heat gun optional for curing',
      'Nitrile gloves and dedicated microfiber for coating',
    ],
  },
];

function matchServicePackage(packageName) {
  const hay = String(packageName || '').toLowerCase().trim();
  if (!hay) return null;
  for (const pkg of SERVICE_PACKAGES) {
    if (pkg.name.toLowerCase() === hay) return pkg;
    if (pkg.aliases.some(a => hay.includes(a))) return pkg;
  }
  return null;
}

async function getOpsSettings() {
  const store = await blobsStore(SETTINGS_STORE);
  const raw = await store.get(SETTINGS_KEY, { type: 'json' }).catch(() => null);
  return { ...DEFAULT_SETTINGS, ...(raw || {}) };
}

async function saveOpsSettings(patches) {
  const store = await blobsStore(SETTINGS_STORE);
  const current = await getOpsSettings();
  const next = { ...current, ...patches, updatedAt: new Date().toISOString() };
  await store.setJSON(SETTINGS_KEY, next);
  return next;
}

function calcBidMax(customerTotal, settings) {
  if (settings.bidMaxOverride != null && settings.bidMaxOverride > 0) {
    return Math.round(Number(settings.bidMaxOverride) * 100) / 100;
  }
  const total = Number(customerTotal) || 0;
  const pct = Number(settings.bidMaxPercent) || 62;
  if (total <= 0) return null;
  return Math.round(total * pct) / 100;
}

function bidWindowForJob(booking, settings) {
  const hay = [
    booking.package, booking.service, booking.vehicle, booking.vehicleLabel,
  ].join(' ').toLowerCase();
  if (/boat|rv|motorhome|trailer|yacht|marine/.test(hay)) {
    return Number(settings.bidWindowMinutesBoatRv) || 90;
  }
  return Number(settings.bidWindowMinutes) || 60;
}

module.exports = {
  SETTINGS_STORE,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  MAINTENANCE_PLAN_TEMPLATES,
  SERVICE_PACKAGES,
  matchServicePackage,
  getOpsSettings,
  saveOpsSettings,
  calcBidMax,
  bidWindowForJob,
};
