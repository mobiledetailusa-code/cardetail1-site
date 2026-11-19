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
const CommercialCatalog = require('../../assets/commercial-vehicle-catalog');

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
  // Phase 2A: a catalog selection is re-resolved here. The stored category,
  // make, model and configuration come from the catalog, not from the browser.
  let catalog = null;
  if (raw.catalog !== undefined && raw.catalog !== null) {
    const sel = raw.catalog;
    if (typeof sel !== 'object' || Array.isArray(sel)) return { errors: ['catalog'], vehicle: null };
    const resolved = CommercialCatalog.resolveSelection({ ...sel, year: raw.year });
    if (!resolved.ok) return { errors: resolved.errors.map((f) => (f === 'year' ? 'year' : `catalog.${f}`)), vehicle: null };
    catalog = resolved.resolution;
  }
  const category = catalog ? catalog.inquiryCategory : cleanLine(raw.category, 40);
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
  if (catalog && catalog.make) {
    // Listed model: the catalog name wins over whatever the browser typed.
    vehicle.make = catalog.make;
    vehicle.model = catalog.model;
  }
  if (def.requireMakeModel) {
    if (!vehicle.make) errors.push('make');
    if (!vehicle.model) errors.push('model');
  }

  if (catalog) {
    const cfg = catalog.configuration;
    if (cfg.passengerCapacity !== undefined) vehicle.passengerCapacity = cfg.passengerCapacity;
    if (cfg.wheelchairPositions !== undefined) vehicle.wheelchairSpaces = cfg.wheelchairPositions;
    vehicle.catalog = {
      modelId: catalog.modelId,
      group: catalog.group,
      body: catalog.body,
      bodyLabel: catalog.bodyLabel,
      configuration: { ...cfg },
      yearStatus: catalog.yearStatus,
      // Server-derived; null means a person sizes it (manual quote).
      sizeClass: catalog.sizeClass,
      status: catalog.status,
      reviewReasons: catalog.reviewReasons.slice(),
    };
  }

  // Numeric details are kept only for categories where they apply. A catalog
  // selection already carries its own validated counts.
  for (const field of catalog ? [] : def.fields) {
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

function catalogConfigText(c) {
  const line = CommercialCatalog.describeResolution({ ...c, make: '', model: '' })[1] || '';
  return line.replace(/^Configuration: /, '');
}

function vehicleSummaryLines(v) {
  if (!v) return [];
  const lines = [`Category: ${v.categoryLabel}`];
  const name = [v.year, v.make, v.model].filter(Boolean).join(' ');
  if (name) lines.push(`Vehicle: ${name}`);
  if (v.passengerCapacity !== undefined) lines.push(`Passenger capacity: ${v.passengerCapacity}`);
  if (v.wheelchairSpaces !== undefined) lines.push(`Wheelchair spaces: ${v.wheelchairSpaces}`);
  if (v.lengthFt !== undefined) lines.push(`Approx. length: ${v.lengthFt} ft`);
  if (v.catalog) {
    lines.push(`Configuration: ${catalogConfigText(v.catalog)}`);
    lines.push(v.catalog.sizeClass ? `Size class: ${v.catalog.sizeClass}` : 'Size class: needs manual review');
  }
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
  // Stable per-form identifier sent again on retries; absent for the chat widget.
  const submissionId = typeof raw.submissionId === 'string' && SUBMISSION_ID_RE.test(raw.submissionId)
    ? raw.submissionId
    : '';
  if (raw.submissionId !== undefined && raw.submissionId !== null && raw.submissionId !== '' && !submissionId) {
    return { ok: false, error: 'invalid_fields', fields: ['submissionId'] };
  }
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
    // Updated after the email/SMS attempt; 'pending' if the function died in between.
    notification: { state: 'pending' },
    retentionExpiresAt: revenueStore.retentionExpiresAt('inquiries'),
  };
  if (structured && !record.message) record.message = vehicleSummaryLines(vehicle).join('\n');
  // Scoped to the phone number so one customer's identifier can never swallow
  // another customer's request.
  const dedupeKey = submissionId
    ? crypto.createHash('sha256').update(`${submissionId}|${phoneDigits(contact.phone)}`).digest('hex').slice(0, 40)
    : '';
  return { ok: true, record, dedupeKey };
}

const SUBMISSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const RECORD_PREFIX = 'rec/';
const CLAIM_PREFIX = 'sub/';
const MAX_TIME_MS = 9999999999999;

/** Newest-first key: an inverted, zero-padded timestamp sorts recent records first. */
function recordKeyFor(record) {
  const inverted = String(MAX_TIME_MS - Date.parse(record.createdAt)).padStart(13, '0');
  return `${RECORD_PREFIX}${inverted}_${record.id}`;
}

function inquiryBlobsAvailable() {
  if (revenueStore.getRevenueStore !== nativeGetRevenueStore) return true; // test double
  if (revenueStore.runningInNetlifyFunction()) return true;
  const siteID = String(process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '').trim();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  return Boolean(siteID && token);
}
// ── Storage + notification state machine ────────────────────────────────────
//
// Keys in the `revenue-inquiries` store:
//   rec/<inverted time>_<id>  the inquiry record (notification.state below)
//   sub/<hash>                dedupe claim: one per (submissionId, phone)
//   ntf/<id>                  notification claim: who may call email/SMS
//
// record.notification.state:
//   pending  stored, alert outcome not recorded yet
//   sent     at least one channel accepted (evidence written by the sender)
//   failed   both channels rejected
//   unknown  the sender stopped after calling providers; outcome cannot be known
//
// ntf/<id> phase:
//   claimed  taken, no provider called yet  → if stale, nothing was sent: safe to take over
//   sending  providers may have been called → if stale, never resend automatically
//   done     outcome copied here when the record update failed
//
// All claims are create-only (onlyIfNew) or compare-and-swap (onlyIfMatch), so
// concurrent retries cannot both send. Reads on the duplicate path are strong
// reads that distinguish "missing" from "storage error".

const NOTIFY_PREFIX = 'ntf/';
const NOTIFY_LEASE_MS = 2 * 60 * 1000;

let clock = () => Date.now();

class StorageReadError extends Error {}

/** Strong read: { found: false } when missing; throws StorageReadError on any storage or parse error. */
async function readStrict(store, key) {
  let res;
  try {
    res = await store.getWithMetadata(key, { type: 'text', consistency: 'strong' });
  } catch (e) {
    throw new StorageReadError(`read ${key}: ${e && e.message}`);
  }
  if (res === null || res === undefined || res.data === null || res.data === undefined) return { found: false };
  try {
    return { found: true, data: JSON.parse(res.data), etag: res.etag || null };
  } catch {
    throw new StorageReadError(`unreadable ${key}`);
  }
}

async function createOnly(store, key, value) {
  const r = await store.set(key, JSON.stringify(value), { onlyIfNew: true });
  return { created: !!(r && r.modified), etag: (r && r.etag) || null };
}

/** Compare-and-swap on a value previously read or written with an etag. */
async function swap(store, key, value, etag) {
  if (!etag) return false;
  const r = await store.set(key, JSON.stringify(value), { onlyIfMatch: etag });
  return !!(r && r.modified);
}

function ageMs(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? clock() - t : Infinity;
}

const result = (status, id, extra = {}) => ({ status, id: id || '', ...extra });

/** Call providers and record the outcome. Caller must own the ntf claim in phase 'sending'. */
async function sendAndRecord(store, record, recordKey, ntfKey, notify, extra) {
  const outcome = await notify(record);
  const notification = {
    state: outcome.delivered ? 'sent' : 'failed',
    email: outcome.email,
    sms: outcome.sms,
    at: new Date(clock()).toISOString(),
  };
  try {
    await revenueStore.blobSetJson(store, recordKey, { ...record, notification });
  } catch (e) {
    console.warn('[vehicle-inquiry] outcome not saved on record:', e && e.message);
    try {
      await store.set(ntfKey, JSON.stringify({ phase: 'done', at: notification.at, outcome: notification }));
    } catch (e2) {
      console.warn('[vehicle-inquiry] outcome not saved on claim:', e2 && e2.message);
    }
  }
  // This process has direct evidence of what the providers returned.
  return result(outcome.delivered ? 'sent' : 'saved_not_notified', record.id, extra);
}

/** Take the notification claim for a stored record and send once. */
async function notifyStored(store, record, recordKey, notify, extra = {}) {
  const ntfKey = `${NOTIFY_PREFIX}${record.id}`;
  let claim;
  try {
    claim = await createOnly(store, ntfKey, { phase: 'claimed', at: new Date(clock()).toISOString() });
  } catch (e) {
    // Nothing sent and nothing claimed: a retry (same submission id) recovers.
    console.warn('[vehicle-inquiry] notification claim failed:', e && e.message);
    return result('retry', record.id, extra);
  }
  if (!claim.created) return result('processing', record.id, extra);
  try {
    const moved = await swap(store, ntfKey, { phase: 'sending', at: new Date(clock()).toISOString() }, claim.etag);
    if (!moved) return result('processing', record.id, extra);
  } catch (e) {
    // Still 'claimed' and no provider called: becomes recoverable after the lease.
    console.warn('[vehicle-inquiry] notification claim not advanced:', e && e.message);
    return result('processing', record.id, extra);
  }
  return sendAndRecord(store, record, recordKey, ntfKey, notify, extra);
}

/** Decide what to do with an existing stored record (retry / duplicate / recovery). */
async function resumeStored(store, recEntry, recordKey, notify) {
  const record = recEntry.data;
  const extra = { duplicate: true };
  const state = record.notification && record.notification.state;
  if (state === 'sent') return result('sent', record.id, extra);
  if (state === 'failed') return result('saved_not_notified', record.id, extra);
  if (state === 'unknown') return result('saved_alert_unconfirmed', record.id, extra);

  const ntfKey = `${NOTIFY_PREFIX}${record.id}`;
  let ntf;
  try {
    ntf = await readStrict(store, ntfKey);
  } catch (e) {
    console.warn('[vehicle-inquiry]', e.message);
    return result('retry', record.id, extra);
  }
  // Interrupted before any notification attempt: nothing was sent, send now.
  if (!ntf.found) return notifyStored(store, record, recordKey, notify, extra);

  const c = ntf.data || {};
  if (c.phase === 'done' && c.outcome) {
    return result(c.outcome.state === 'sent' ? 'sent' : 'saved_not_notified', record.id, extra);
  }
  if (ageMs(c.at) < NOTIFY_LEASE_MS) return result('processing', record.id, extra);

  if (c.phase === 'claimed') {
    // Stale before any provider call: provably nothing was sent. Take over atomically.
    try {
      const took = await swap(store, ntfKey, { phase: 'sending', at: new Date(clock()).toISOString(), takeover: true }, ntf.etag);
      if (!took) return result('processing', record.id, extra);
    } catch (e) {
      console.warn('[vehicle-inquiry] claim takeover failed:', e && e.message);
      return result('retry', record.id, extra);
    }
    return sendAndRecord(store, record, recordKey, ntfKey, notify, extra);
  }

  // Stale in 'sending': a provider may already have accepted. Never resend
  // automatically; flag for the team instead.
  try {
    await swap(store, recordKey, {
      ...record,
      notification: { state: 'unknown', at: new Date(clock()).toISOString(), reason: 'sender_interrupted' },
    }, recEntry.etag);
  } catch (e) {
    console.warn('[vehicle-inquiry] could not flag unknown alert:', e && e.message);
  }
  return result('saved_alert_unconfirmed', record.id, extra);
}

/** A duplicate submission: follow the dedupe claim to the original request. */
async function resumeSubmission(store, claimKey, record, notify) {
  let sub;
  try {
    sub = await readStrict(store, claimKey);
  } catch (e) {
    console.warn('[vehicle-inquiry]', e.message);
    return result('retry', '');
  }
  // Released after a failed write between our create and this read: retry creates it.
  if (!sub.found) return result('retry', '');
  const prior = sub.data || {};

  let rec = { found: false };
  if (prior.recordKey) {
    try {
      rec = await readStrict(store, prior.recordKey);
    } catch (e) {
      console.warn('[vehicle-inquiry]', e.message);
      return result('retry', prior.id);
    }
  }
  if (rec.found) return resumeStored(store, rec, prior.recordKey, notify);

  // Claimed but no record: the first request is still writing, or it died
  // before storing (so it never notified). Only take over once it is stale.
  if (ageMs(prior.at || prior.createdAt) < NOTIFY_LEASE_MS) return result('processing', prior.id);
  const recordKey = recordKeyFor(record);
  try {
    const took = await swap(store, claimKey, {
      id: record.id, recordKey, createdAt: record.createdAt, at: new Date(clock()).toISOString(), takeoverOf: prior.id || '',
    }, sub.etag);
    if (!took) return result('processing', prior.id);
    const created = await createOnly(store, recordKey, record);
    if (!created.created) return result('retry', record.id);
  } catch (e) {
    console.warn('[vehicle-inquiry] orphaned claim recovery failed:', e && e.message);
    return result('retry', record.id);
  }
  return notifyStored(store, record, recordKey, notify, { recovered: true });
}

/** No usable storage: notify directly (pre-existing behavior); no dedupe is possible. */
async function notifyWithoutStorage(record, notify) {
  const outcome = await notify(record);
  return outcome.delivered ? result('sent', record.id, { stored: false }) : result('not_delivered', '');
}

/**
 * Store an inquiry (deduplicated) and alert the team at most once.
 * notify(record) → { delivered, email, sms } must not throw.
 * Returns { status, id, duplicate?, stored? } where status is one of:
 *   sent | saved_not_notified | saved_alert_unconfirmed | processing | retry | not_delivered
 */
async function processInquiry(record, { dedupeKey = '', notify }) {
  if (!inquiryBlobsAvailable()) return notifyWithoutStorage(record, notify);
  let store;
  try {
    store = await revenueStore.getRevenueStore('inquiries');
  } catch (e) {
    console.warn('[vehicle-inquiry] store unavailable:', e && e.message);
    return notifyWithoutStorage(record, notify);
  }
  const recordKey = recordKeyFor(record);
  let claimKey = '';
  if (dedupeKey) {
    claimKey = `${CLAIM_PREFIX}${dedupeKey}`;
    let claim;
    try {
      claim = await createOnly(store, claimKey, {
        id: record.id, recordKey, createdAt: record.createdAt, at: new Date(clock()).toISOString(),
      });
    } catch (e) {
      console.warn('[vehicle-inquiry] dedupe claim failed:', e && e.message);
      return notifyWithoutStorage(record, notify);
    }
    if (!claim.created) return resumeSubmission(store, claimKey, record, notify);
  }
  try {
    const created = await createOnly(store, recordKey, record);
    if (!created.created) throw new Error('record_key_collision');
  } catch (e) {
    console.warn('[vehicle-inquiry] record write failed:', e && e.message);
    // Release the claim so a retry stores the request instead of finding an orphan.
    if (claimKey) {
      try { await store.delete(claimKey); } catch { /* becomes an orphan; recovered after the lease */ }
    }
    return notifyWithoutStorage(record, notify);
  }
  return notifyStored(store, record, recordKey, notify);
}

/** Admin view of one stored record. */
function adminInquiryView(rec) {
  const v = rec.vehicle || null;
  const n = rec.notification || { state: 'unknown' };
  // A request left 'pending' past the lease was never confirmed as alerted.
  const state = n.state === 'pending' && ageMs(rec.createdAt) >= NOTIFY_LEASE_MS ? 'unknown' : (n.state || 'unknown');
  return {
    id: rec.id,
    createdAt: rec.createdAt,
    status: rec.status || 'new',
    kind: rec.kind,
    source: rec.source || '',
    contact: { name: rec.name || '', phone: rec.phone || '', email: rec.email || '', zip: rec.zip || '' },
    vehicle: v && {
      category: v.category,
      categoryLabel: v.categoryLabel,
      year: v.year ?? null,
      make: v.make || '',
      model: v.model || '',
      passengerCapacity: v.passengerCapacity ?? null,
      wheelchairSpaces: v.wheelchairSpaces ?? null,
      lengthFt: v.lengthFt ?? null,
      notes: v.notes || '',
      catalog: v.catalog ? {
        modelId: v.catalog.modelId,
        configuration: catalogConfigText(v.catalog),
        sizeClass: v.catalog.sizeClass || null,
        status: v.catalog.status,
        reviewReasons: v.catalog.reviewReasons || [],
        yearStatus: v.catalog.yearStatus,
      } : null,
    },
    services: v ? v.services.map((s) => SERVICES[s] || s) : [],
    extras: v ? v.extras.map((s) => EXTRAS[s] || s) : [],
    message: rec.message || '',
    notification: { ...n, state },
  };
}

/**
 * Newest stored inquiries for the admin view. Read-only.
 * Keys sort newest-first (recordKeyFor), so the first page is the latest.
 */
async function listInquiries({ limit = 100 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const store = await revenueStore.getRevenueStore('inquiries');
  const keys = (await revenueStore.blobListKeys(store, { prefix: RECORD_PREFIX, limit: 2000 })).sort();
  const page = keys.slice(0, cap);
  const rows = await Promise.all(page.map((k) => revenueStore.blobGetJson(store, k)));
  return {
    inquiries: rows.filter(Boolean).map(adminInquiryView),
    total: keys.length,
    truncated: keys.length > cap,
  };
}

module.exports = {
  VEHICLE_CATEGORIES,
  SERVICES,
  EXTRAS,
  NOTIFY_LEASE_MS,
  buildInquiryRecord,
  processInquiry,
  listInquiries,
  recordKeyFor,
  vehicleSummaryLines,
  validateVehicle,
  __test: { setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); } },
};
