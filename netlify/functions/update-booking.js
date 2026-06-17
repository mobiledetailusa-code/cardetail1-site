// netlify/functions/update-booking.js
// Admin-only: persist safe booking mutations to Netlify Blobs (cd1-bookings).
//
// Auth
//   Header:  x-admin-key: <ADMIN_DASH_PASSWORD>
//   503 — ADMIN_DASH_PASSWORD env var not configured
//   401 — key missing or wrong (timing-safe comparison)
//
// Input (POST JSON)
//   bookingId         — required string
//   updates           — required plain object, strict allowlist enforced
//   lastAction        — optional string (default: "admin_update_booking")
//   allowArchivedUpdate — optional boolean, required to mutate archived/test bookings
//
// Every successful write adds:
//   updatedAt, updatedByRole:"admin", updatedBy:"admin", lastAction
//
// Logging: bookingId + changed field NAMES only. Never logs values or secrets.
//
// Blocked fields (returns 400): payment, PII, price, tech assignment, flags.
// Unknown fields: returns 400.

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

// ── Status allowlists ────────────────────────────────────────────────────────

const ALLOWED_APPOINTMENT_STATUS = new Set([
  'pending_review', 'confirmed', 'canceled',
]);

const ALLOWED_JOB_STATUS = new Set([
  'not_started', 'en_route', 'in_progress', 'completed', 'closed', 'canceled',
]);

// Legacy values used by the existing admin UI — preserved for compatibility.
const ALLOWED_LEGACY_STATUS = new Set([
  'Pending Review', 'Reviewed', 'Contacted', 'Confirmed', 'Scheduled',
  'En Route', 'In Progress', 'Completed', 'Closed', 'Canceled', 'Problem',
]);

// ── Field allowlist (admin may write these fields only) ──────────────────────

const ALLOWED_FIELDS = new Set([
  // Appointment / job lifecycle
  'status', 'appointmentStatus', 'jobStatus',
  // Scheduling
  'confirmedDate', 'confirmedTime', 'confirmedTimeWindow',
  'preferredDate', 'preferredTime',
  // Admin workflow
  'adminReviewed', 'adminReviewedAt',
  'adminContacted', 'adminContactedAt',
  'adminNotes', 'customerNote',
  // Lifecycle timestamps
  'confirmedAt', 'startedAt', 'enRouteAt',
  'completedAt', 'closedAt', 'canceledAt',
  // Problem flags
  'hasProblem', 'lastProblem',
]);

// Explicitly blocked fields — produce a clear 400 instead of "unknown_field".
const BLOCKED_FIELDS = new Set([
  'paymentStatus', 'paymentIntentId',
  'amountAuthorizedCents', 'amountCapturedCents',
  'capturedAt', 'captureInitiatedAt',
  'stripeCustomerId', 'paymentMethodId',
  'firstName', 'lastName', 'email', 'phone', 'address', 'zipCode',
  'totalPrice', 'packagePrice', 'package', 'vehicle', 'addOns',
  'archived', 'isTest',
  'assignedTech', 'assignedTechName',
]);

// String note fields — length-capped before storage.
const NOTE_FIELDS = new Set(['adminNotes', 'customerNote', 'lastProblem']);
const NOTE_MAX = 1000;

// Boolean fields — must be actual booleans, not strings.
const BOOL_FIELDS = new Set(['adminReviewed', 'adminContacted', 'hasProblem']);

// Date and time fields — must be strings.
const DATE_FIELDS = new Set(['confirmedDate', 'preferredDate']);
const TIME_FIELDS = new Set(['confirmedTime', 'preferredTime', 'confirmedTimeWindow']);

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitize(value) {
  return (typeof value === 'string' ? value : String(value)).slice(0, NOTE_MAX);
}

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, error: 'method_not_allowed' });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const expectedKey = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!expectedKey) return json(503, { ok: false, error: 'missing_admin_password_config' });

  const hdrs = event.headers || {};
  const providedKey = ((hdrs['x-admin-key'] || hdrs['X-Admin-Key']) || '').trim();
  if (!providedKey) return json(401, { ok: false, error: 'unauthorized' });

  const ka = Buffer.from(providedKey);
  const kb = Buffer.from(expectedKey);
  const match = ka.length === kb.length && crypto.timingSafeEqual(ka, kb);
  if (!match) return json(401, { ok: false, error: 'unauthorized' });

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  // ── bookingId ─────────────────────────────────────────────────────────────
  const bookingId = typeof body.bookingId === 'string'
    ? body.bookingId.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')
    : '';
  if (!bookingId) return json(400, { ok: false, error: 'bookingId_required' });

  // ── updates object ────────────────────────────────────────────────────────
  const rawUpdates = body.updates;
  if (!rawUpdates || typeof rawUpdates !== 'object' || Array.isArray(rawUpdates)) {
    return json(400, { ok: false, error: 'updates_must_be_object' });
  }
  if (Object.keys(rawUpdates).length === 0) {
    return json(400, { ok: false, error: 'updates_empty' });
  }

  // ── Per-field validation ──────────────────────────────────────────────────
  const validated = {};
  for (const [key, value] of Object.entries(rawUpdates)) {
    if (BLOCKED_FIELDS.has(key)) {
      return json(400, { ok: false, error: 'field_not_allowed', field: key });
    }
    if (!ALLOWED_FIELDS.has(key)) {
      return json(400, { ok: false, error: 'unknown_field', field: key });
    }

    // Status enum checks
    if (key === 'appointmentStatus' && !ALLOWED_APPOINTMENT_STATUS.has(value)) {
      return json(400, { ok: false, error: 'invalid_appointmentStatus', received: value });
    }
    if (key === 'jobStatus' && !ALLOWED_JOB_STATUS.has(value)) {
      return json(400, { ok: false, error: 'invalid_jobStatus', received: value });
    }
    if (key === 'status' && !ALLOWED_LEGACY_STATUS.has(value)) {
      return json(400, { ok: false, error: 'invalid_status', received: value });
    }

    // Boolean validation
    if (BOOL_FIELDS.has(key) && typeof value !== 'boolean') {
      return json(400, { ok: false, error: 'field_must_be_boolean', field: key });
    }

    // Date/time must be strings
    if ((DATE_FIELDS.has(key) || TIME_FIELDS.has(key)) && typeof value !== 'string') {
      return json(400, { ok: false, error: 'field_must_be_string', field: key });
    }

    // Note sanitization
    validated[key] = NOTE_FIELDS.has(key) ? sanitize(value) : value;
  }

  // ── lastAction ────────────────────────────────────────────────────────────
  const lastAction = (typeof body.lastAction === 'string' && body.lastAction.trim())
    ? body.lastAction.trim().slice(0, 100)
    : 'admin_update_booking';

  // ── Blobs write ───────────────────────────────────────────────────────────
  try {
    const store   = await blobsStore('cd1-bookings');
    const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!booking) return json(404, { ok: false, error: 'booking_not_found' });

    // Archived / test protection — require explicit override.
    if ((booking.archived || booking.isTest) && !body.allowArchivedUpdate) {
      return json(403, {
        ok: false,
        error: 'booking_is_archived_or_test',
        hint: 'pass allowArchivedUpdate: true to override',
      });
    }

    const now = new Date().toISOString();
    const patched = {
      ...booking,
      ...validated,
      updatedAt:      now,
      updatedByRole:  'admin',
      updatedBy:      'admin',
      lastAction,
    };

    await store.setJSON(bookingId, patched);

    // Log field names only — never values, never notes, never secrets.
    console.log('[update-booking] ok', bookingId, 'admin', JSON.stringify(Object.keys(validated)), lastAction);

    return json(200, {
      ok: true,
      bookingId,
      updatedFields: Object.keys(validated),
      updatedAt: now,
      lastAction,
    });
  } catch (e) {
    console.error('[update-booking] error', bookingId, e.message);
    return json(500, { ok: false, error: 'update_failed' });
  }
};
