// netlify/functions/admin-incomplete-bookings.js
// Admin-only feed of INCOMPLETE bookings: drafts where the customer already
// engaged the card-on-file step (SetupIntent created / card saved) but never
// finalized the appointment. These are invisible to the normal booking feed
// (isVisibleSubmittedBooking excludes drafts), so without this surface a
// customer who saved a card but did not submit is silently lost to the admin.
//
// Read-only. Never mutates. Never exposes raw Stripe identifiers.
// Auth: admin session token (x-admin-key header), same as list-bookings.

const {
  verifyAdminKey,
  blobsStore,
  listAllBlobs,
  fetchBlobRecords,
} = require('../lib/tech-security');
const { isDraftRecord, isArchivedOrTest } = require('../lib/booking-visibility');

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, x-show-test',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

// A draft "counts" as an incomplete booking worth surfacing only once the
// customer reached the card-on-file step (they intended to book). Bare abandoned
// drafts with no card engagement are intentionally excluded as noise.
function hasCardEngagement(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.cardOnFileStatus === 'saved') return true;
  if (String(b.setupIntentId || '').trim()) return true;
  if (String(b.stripeCustomerId || '').trim()) return true;
  return false;
}

// Explicit allow-list projection — never forwards Stripe IDs, tokens, or
// payment-method references to the browser.
function projectIncomplete(b) {
  const vehicles = Array.isArray(b.vehicles) ? b.vehicles : [];
  return {
    id: b.id || b.bookingId || '',
    firstName: b.firstName || '',
    lastName: b.lastName || '',
    phone: b.phone || b.customerPhone || '',
    email: b.email || '',
    vehicle: b.vehicleLabel || b.vehicle || (vehicles[0] && (vehicles[0].vehicleLabel || vehicles[0].vehicle)) || '',
    vehicleCount: vehicles.length || (b.vehicle ? 1 : 0),
    package: b.package || (vehicles[0] && (vehicles[0].pkgName || vehicles[0].packageName)) || '',
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    zipCode: b.zipCode || b.zip || '',
    zone: b.zone || '',
    totalPrice: Number(b.totalPrice) || 0,
    paymentMethodPreference: b.paymentMethodPreference || b.paymentMethod || '',
    // 'saved'  → card on file but appointment never submitted (highest-priority follow-up)
    // 'pending'→ started card step, Stripe not yet confirmed
    cardOnFileStatus: b.cardOnFileStatus || 'pending',
    createdAt: b.createdAt || '',
    updatedAt: b.updatedAt || '',
  };
}

// Pure selection: draft + card-engaged + not archived/test, projected and
// ordered (card-saved first, then newest). No I/O — unit-testable.
function selectIncompleteBookings(records) {
  const rows = Array.isArray(records) ? records : [];
  const incomplete = rows
    .filter((b) => b && isDraftRecord(b) && !isArchivedOrTest(b) && hasCardEngagement(b))
    .map(projectIncomplete);

  // Card saved (submit never happened) first, then most recent.
  incomplete.sort((a, b) => {
    const aw = a.cardOnFileStatus === 'saved' ? 0 : 1;
    const bw = b.cardOnFileStatus === 'saved' ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return incomplete;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) {
    const status = auth.error === 'missing_admin_config' ? 503 : 401;
    return json(status, { ok: false, error: auth.error || 'unauthorized' });
  }

  try {
    const store = await blobsStore('cd1-bookings');
    const blobs = await listAllBlobs(store, 'cd1-bookings');
    const all = await fetchBlobRecords(store, blobs);

    const incomplete = selectIncompleteBookings(all);
    const savedCount = incomplete.filter((b) => b.cardOnFileStatus === 'saved').length;
    return json(200, {
      ok: true,
      count: incomplete.length,
      savedCount,
      incomplete,
    });
  } catch (e) {
    console.error('[admin-incomplete-bookings] list failed:', e && e.message ? e.message : e);
    return json(500, { ok: false, error: 'list_failed' });
  }
};

exports.__test = {
  hasCardEngagement,
  projectIncomplete,
  selectIncompleteBookings,
};
