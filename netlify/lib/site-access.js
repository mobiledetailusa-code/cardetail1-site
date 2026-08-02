// Site access fields captured at booking Step 4 (water, power, location, access notes).
// Enum values remain yes | no | unsure (legacy-compatible). Labels are customer-facing.

const WATER_LABELS = {
  yes: 'Available — outdoor faucet or hose connection',
  no: 'Not available',
  unsure: 'Not sure',
};

const ELECTRIC_LABELS = {
  yes: 'Available — standard outlet nearby',
  no: 'Not available',
  unsure: 'Not sure',
};

const LOCATION_LABELS = {
  driveway: 'Driveway',
  street: 'Street parking',
  garage: 'Garage / parking deck',
  apartment: 'Apartment / condo',
  marina: 'Marina / dock',
  commercial: 'Commercial lot',
  other: 'Other',
};

const SITE_ACCESS_VALUES = Object.freeze(['yes', 'no', 'unsure']);

function normalizeSiteAccessValue(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  if (SITE_ACCESS_VALUES.includes(v)) return v;
  // Accept prior display aliases if ever stored — still normalize to yes/no/unsure
  if (v === 'available') return 'yes';
  if (v === 'unavailable') return 'no';
  if (v === 'unknown') return 'unsure';
  return '';
}

function formatSiteAccessLines(b) {
  const booking = b || {};
  const lines = [];
  const water = normalizeSiteAccessValue(booking.waterAvailable) || booking.waterAvailable;
  const electric = normalizeSiteAccessValue(booking.electricityAvailable) || booking.electricityAvailable;
  if (water) {
    lines.push(`Water: ${WATER_LABELS[water] || water}`);
  }
  if (electric) {
    lines.push(`Electricity: ${ELECTRIC_LABELS[electric] || electric}`);
  }
  if (booking.serviceLocation) {
    lines.push(`Service location: ${LOCATION_LABELS[booking.serviceLocation] || booking.serviceLocation}`);
  }
  if (booking.accessNotes) {
    lines.push(`Access notes: ${booking.accessNotes}`);
  }
  return lines;
}

function hasSiteAccessInfo(b) {
  const booking = b || {};
  return !!(booking.waterAvailable || booking.electricityAvailable || booking.serviceLocation || booking.accessNotes);
}

function techEquipmentHintsForSiteAccess(b) {
  const booking = b || {};
  const hints = [];
  const water = normalizeSiteAccessValue(booking.waterAvailable) || booking.waterAvailable;
  const electric = normalizeSiteAccessValue(booking.electricityAvailable) || booking.electricityAvailable;
  if (water === 'no') hints.push('Bring own water supply');
  if (electric === 'no') hints.push('No on-site power — plan generator/battery tools');
  if (booking.serviceLocation === 'marina') hints.push('Dock/marina access — confirm slip & shore power');
  if (booking.serviceLocation === 'apartment') hints.push('Apartment/condo — confirm garage or visitor parking');
  return hints;
}

/** Fields available to future Twilio / transactional message builders. */
function siteAccessForMessaging(b) {
  const booking = b || {};
  return {
    waterAvailable: normalizeSiteAccessValue(booking.waterAvailable) || booking.waterAvailable || '',
    electricityAvailable: normalizeSiteAccessValue(booking.electricityAvailable) || booking.electricityAvailable || '',
    waterLabel: WATER_LABELS[normalizeSiteAccessValue(booking.waterAvailable)] || '',
    electricityLabel: ELECTRIC_LABELS[normalizeSiteAccessValue(booking.electricityAvailable)] || '',
    serviceLocation: booking.serviceLocation || '',
    accessNotes: booking.accessNotes || '',
    lines: formatSiteAccessLines(booking),
  };
}

module.exports = {
  WATER_LABELS,
  ELECTRIC_LABELS,
  LOCATION_LABELS,
  SITE_ACCESS_VALUES,
  normalizeSiteAccessValue,
  formatSiteAccessLines,
  hasSiteAccessInfo,
  techEquipmentHintsForSiteAccess,
  siteAccessForMessaging,
};
