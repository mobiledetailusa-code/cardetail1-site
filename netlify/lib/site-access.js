// Site access fields captured at booking Step 4 (water, power, location, access notes).

const WATER_LABELS = {
  yes: 'Yes, water spigot/hose access available',
  no: 'No water available',
  unsure: 'Not sure',
};

const ELECTRIC_LABELS = {
  yes: 'Yes, outlet available',
  no: 'No electricity available',
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

function formatSiteAccessLines(b) {
  const booking = b || {};
  const lines = [];
  if (booking.waterAvailable) {
    lines.push(`Water: ${WATER_LABELS[booking.waterAvailable] || booking.waterAvailable}`);
  }
  if (booking.electricityAvailable) {
    lines.push(`Electricity: ${ELECTRIC_LABELS[booking.electricityAvailable] || booking.electricityAvailable}`);
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
  if (booking.waterAvailable === 'no') hints.push('Bring own water supply');
  if (booking.electricityAvailable === 'no') hints.push('No on-site power — plan generator/battery tools');
  if (booking.serviceLocation === 'marina') hints.push('Dock/marina access — confirm slip & shore power');
  if (booking.serviceLocation === 'apartment') hints.push('Apartment/condo — confirm garage or visitor parking');
  return hints;
}

module.exports = {
  WATER_LABELS,
  ELECTRIC_LABELS,
  LOCATION_LABELS,
  formatSiteAccessLines,
  hasSiteAccessInfo,
  techEquipmentHintsForSiteAccess,
};
