// Garage Plan payload validation — phone, ZIP, and field normalization.

const { resolveTravelForZip } = require('./travel-fee');

function normalizeUsPhoneE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function normalizeZip(zip) {
  return String(zip || '').replace(/\D/g, '').slice(0, 5);
}

function validateGaragePlanInput(body) {
  const input = body || {};
  const vehicleCount = Math.max(0, Number(input.vehicleCount || input.personalVehicleCount || 0));
  const isCommercial = input.isCommercial === true
    || input.ownership === 'business'
    || String(input.ownership || '').toLowerCase() === 'commercial'
    || vehicleCount >= 7;

  if (isCommercial) {
    return {
      ok: false,
      error: 'fleet_quote_required',
      route: 'fleet_quote',
      vehicleCount,
    };
  }

  if (vehicleCount < 2) {
    return { ok: false, error: 'garage_plan_requires_two_vehicles', vehicleCount };
  }

  if (!input.transactionalConsent) {
    return { ok: false, error: 'transactional_consent_required' };
  }

  const name = String(input.name || '').trim().slice(0, 120);
  const email = String(input.email || '').trim().toLowerCase().slice(0, 120);
  const phoneRaw = String(input.phone || '').trim();
  const phoneE164 = normalizeUsPhoneE164(phoneRaw);
  const zip = normalizeZip(input.zip || input.serviceZip);

  if (!name) {
    return { ok: false, error: 'validation_error', field: 'name' };
  }
  if (!phoneE164) {
    return { ok: false, error: 'invalid_phone', field: 'phone' };
  }
  if (zip.length !== 5) {
    return { ok: false, error: 'invalid_zip', field: 'zip' };
  }

  const travel = resolveTravelForZip(zip);
  const manualReviewRequired = !travel;

  const categories = Array.isArray(input.vehicleCategories)
    ? input.vehicleCategories.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
    : Array.isArray(input.categories)
      ? input.categories.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      : [];

  return {
    ok: true,
    vehicleCount,
    name,
    email: email.includes('@') ? email : null,
    phone: phoneE164,
    phoneRaw,
    zip,
    manualReviewRequired,
    categories,
    sameLocationSameVisit: input.sameLocationSameVisit === true,
    sameServiceLocation: input.sameServiceLocation !== false,
    maintenanceFrequency: String(input.maintenanceFrequency || input.maintenanceInterest || 'one-time').trim(),
    marketingConsent: !!input.marketingConsent,
    smsConsent: !!input.smsConsent,
    emailConsent: !!input.emailConsent,
    source: String(input.source || 'garage_plan').trim().slice(0, 80),
    utm_campaign: input.utm_campaign || null,
    prefillBooking: input.prefillBooking === true,
    estimatedValue: Number(input.estimatedValue || 0),
    packageInterest: input.packageInterest || null,
    idempotencyKey: input.idempotencyKey || null,
  };
}

module.exports = {
  normalizeUsPhoneE164,
  normalizeZip,
  validateGaragePlanInput,
};
