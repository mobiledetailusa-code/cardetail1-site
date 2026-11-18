'use strict';

// Structured quote requests for vehicles the online booking does not price:
// cars missing from the catalog, and commercial / specialty vehicles.
//
// This module only validates, sanitizes and stores. It never prices, never
// creates a booking and never accepts price, tier or payment fields: the
// record is built from an allowlist, so anything else the browser sends is
// dropped.

const crypto = require('crypto');
const revenueStore = require('./revenue-store');

const nativeGetRevenueStore = revenueStore.getRevenueStore;

const VEHICLE_CATEGORIES = Object.freeze({
  car_suv: { label: 'Car / SUV / pickup (not listed)', fields: [], requireMakeModel: true },
  passenger_van: { label: 'Passenger van', fields: ['passengerCapacity', 'wheelchairSpaces'], requireCapacity: true },
  cargo_van: { label: 'Cargo / work van', fields: ['lengthFt'] },
  paratransit: { label: 'Wheelchair-accessible / paratransit van', fields: ['passengerCapacity', 'wheelchairSpaces', 'lengthFt'], requireCapacity: true },
  shuttle_bus: { label: 'Shuttle / minibus', fields: ['passengerCapacity', 'wheelchairSpaces', 'lengthFt'], requireCapacity: true },
  school_bus: { label: 'School bus', fields: ['passengerCapacity', 'wheelchairSpaces', 'lengthFt'], requireCapacity: true },
  motorcoach: { label: 'Motorcoach / tour bus', fields: ['passengerCapacity', 'wheelchairSpaces', 'lengthFt'], requireCapacity: true },
  limousine: { label: 'Limousine / party bus', fields: ['passengerCapacity', 'lengthFt'] },
  box_truck: { label: 'Box truck / straight truck', fields: ['lengthFt'] },
  other: { label: 'Other specialty vehicle', fields: ['passengerCapacity', 'wheelchairSpaces', 'lengthFt'] },
});

const SERVICES = Object.freeze({
  exterior_wash: 'Exterior wash',
  interior_cleaning: 'Interior cleaning',
  full_detail: 'Full detail (inside and out)',
  sanitizing: 'Sanitizing / disinfection',
  upholstery_shampoo: 'Seat and floor shampoo',
  windows: 'Windows',
});

const EXTRAS = Object.freeze({
  roof_cleaning: 'Roof cleaning',
  undercarriage_wash: 'Undercarriage wash',
});

const RANGES = Object.freeze({
  passengerCapacity: { min: 1, max: 100, label: 'passenger capacity' },
  wheelchairSpaces: { min: 0, max: 20, label: 'wheelchair spaces' },
  lengthFt: { min: 10, max: 65, label: 'length' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// C0 controls except tab/newline, DEL, and Unicode line/bidi controls.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

function cleanLine(value, max) {
  return String(value == null ? '' : value)
    .replace(CONTROL_RE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseWholeNumber(value) {
  if (value === undefined || value === null || value === '') return { present: false };
  const s = String(value).trim();
  if (!/^\d{1,4}$/.test(s)) return { present: true, ok: false };
  return { present: true, ok: true, value: Number(s) };
}

/**
 * Contact fields shared by every inquiry.
 * strict: structured quote requests (10-15 digit phone, valid email or none).
 * Lenient mode keeps the chat widget's long-standing acceptance (7+ digits,
 * a malformed optional email is dropped instead of failing the request).
 */
function validateContact(raw, { strict = false } = {}) {
  const errors = [];
  const name = cleanLine(raw.name, 80);
  const phone = cleanLine(raw.phone, 30);
  const digits = phoneDigits(phone);
  let email = cleanLine(raw.email, 254).toLowerCase();

  if (!name) errors.push('name');
  const minDigits = strict ? 10 : 7;
  if (!phone || digits.length < minDigits || digits.length > 15) errors.push('phone');
  if (email && !EMAIL_RE.test(email)) {
    if (strict) errors.push('email');
    email = '';
  }
  return { errors, contact: { name, phone, email } };
}

function validateVehicle(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['vehicle'], vehicle: null };
  }
  const category = cleanLine(raw.category, 40);
  const def = Object.prototype.hasOwnProperty.call(VEHICLE_CATEGORIES, category)
    ? VEHICLE_CATEGORIES[category]
    : null;
  if (!def) return { errors: ['category'], vehicle: null };

  const vehicle = { category, categoryLabel: def.label };

  const yearRaw = raw.year === undefined || raw.year === null ? '' : String(raw.year).trim();
  if (yearRaw) {
    const maxYear = new Date().getUTCFullYear() + 2;
    if (!/^\d{4}$/.test(yearRaw) || Number(yearRaw) < 1950 || Number(yearRaw) > maxYear) errors.push('year');
    else vehicle.year = Number(yearRaw);
  }

  vehicle.make = cleanLine(raw.make, 40);
  vehicle.model = cleanLine(raw.model, 60);
  if (def.requireMakeModel) {
    if (!vehicle.make) errors.push('make');
    if (!vehicle.model) errors.push('model');
  }

  // Numeric details are kept only for categories where they apply.
  for (const field of def.fields) {
    const parsed = parseWholeNumber(raw[field]);
    const range = RANGES[field];
    if (!parsed.present) continue;
    if (!parsed.ok || parsed.value < range.min || parsed.value > range.max) errors.push(field);
    else vehicle[field] = parsed.value;
  }
  if (def.requireCapacity && vehicle.passengerCapacity === undefined && !errors.includes('passengerCapacity')) {
    errors.push('passengerCapacity');
  }
  if (vehicle.wheelchairSpaces !== undefined && vehicle.passengerCapacity !== undefined
      && vehicle.wheelchairSpaces > vehicle.passengerCapacity) {
    errors.push('wheelchairSpaces');
  }

  const pickList = (value, allowed, key) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > Object.keys(allowed).length) {
      errors.push(key);
      return [];
    }
    const out = [];
    for (const item of value) {
      const k = String(item);
      if (!Object.prototype.hasOwnProperty.call(allowed, k)) {
        errors.push(key);
        return [];
      }
      if (!out.includes(k)) out.push(k);
    }
    return out;
  };
  vehicle.services = pickList(raw.services, SERVICES, 'services');
  vehicle.extras = pickList(raw.extras, EXTRAS, 'extras');
  if (category !== 'car_suv' && !vehicle.services.length && !errors.includes('services')) errors.push('services');

  vehicle.notes = cleanText(raw.notes, 1000);
  return { errors, vehicle };
}

function vehicleSummaryLines(v) {
  if (!v) return [];
  const lines = [`Category: ${v.categoryLabel}`];
  const name = [v.year, v.make, v.model].filter(Boolean).join(' ');
  if (name) lines.push(`Vehicle: ${name}`);
  if (v.passengerCapacity !== undefined) lines.push(`Passenger capacity: ${v.passengerCapacity}`);
  if (v.wheelchairSpaces !== undefined) lines.push(`Wheelchair spaces: ${v.wheelchairSpaces}`);
  if (v.lengthFt !== undefined) lines.push(`Approx. length: ${v.lengthFt} ft`);
  if (v.services.length) lines.push(`Services: ${v.services.map((s) => SERVICES[s]).join(', ')}`);
  if (v.extras.length) lines.push(`Extras: ${v.extras.map((s) => EXTRAS[s]).join(', ')}`);
  if (v.notes) lines.push(`Notes: ${v.notes}`);
  return lines;
}

function generateInquiryId(now = Date.now()) {
  return `INQ-${now.toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * Validate a raw submit-inquiry payload into a storable record.
 * Returns { ok: true, record } or { ok: false, error, fields }.
 */
function buildInquiryRecord(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_payload', fields: [] };
  }
  const structured = raw.vehicle !== undefined && raw.vehicle !== null;
  const { errors: contactErrors, contact } = validateContact(raw, { strict: structured });
  let vehicle = null;
  let vehicleErrors = [];
  if (structured) ({ errors: vehicleErrors, vehicle } = validateVehicle(raw.vehicle));

  if (contactErrors.includes('name') || contactErrors.includes('phone')) {
    return { ok: false, error: 'Missing name or phone', fields: contactErrors };
  }
  const fields = [...contactErrors, ...vehicleErrors];
  if (fields.length) return { ok: false, error: 'invalid_fields', fields };

  const zip = phoneDigits(raw.zip).slice(0, 5);
  const clientRef = cleanLine(raw.id, 40);
  const record = {
    id: generateInquiryId(now),
    kind: structured ? 'vehicle_quote' : 'question',
    status: 'new',
    createdAt: new Date(now).toISOString(),
    source: cleanLine(raw.source, 80) || 'Chat widget',
    clientRef: /^INQ-[A-Z0-9-]{1,36}$/.test(clientRef) ? clientRef : '',
    name: contact.name,
    phone: contact.phone,
    email: contact.email,
    zip: zip.length === 5 ? zip : '',
    message: cleanText(raw.message, 2000),
    vehicle,
    retentionExpiresAt: revenueStore.retentionExpiresAt('inquiries'),
  };
  if (structured && !record.message) record.message = vehicleSummaryLines(vehicle).join('\n');
  return { ok: true, record };
}

function inquiryBlobsAvailable() {
  if (revenueStore.getRevenueStore !== nativeGetRevenueStore) return true; // test double
  if (revenueStore.runningInNetlifyFunction()) return true;
  const siteID = String(process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '').trim();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  return Boolean(siteID && token);
}
/** Create-only write; a storage failure is reported, never thrown. */
async function persistInquiry(record) {
  if (!inquiryBlobsAvailable()) return { stored: false, reason: 'storage_unavailable' };
  try {
    const store = await revenueStore.getRevenueStore('inquiries');
    const result = await revenueStore.blobCreateJson(store, record.id, record);
    if (!result.created) return { stored: false, reason: 'id_collision' };
    return { stored: true };
  } catch (e) {
    console.warn('[vehicle-inquiry] persist failed:', e && e.message);
    return { stored: false, reason: 'storage_error' };
  }
}

module.exports = {
  VEHICLE_CATEGORIES,
  SERVICES,
  EXTRAS,
  buildInquiryRecord,
  persistInquiry,
  vehicleSummaryLines,
  validateVehicle,
};
