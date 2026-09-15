/**
 * Dual-write / read-fallback for BookingRecord in Prisma Postgres.
 *
 * Safety rules:
 * - Netlify Blobs remain authoritative for CAS / checkout.
 * - Mirror failures never throw to callers (fail-open).
 * - Drafts are never mirrored (checkout SetupIntent / draftSaveToken stay Blob-only).
 * - Disable with PRISMA_BOOKING_MIRROR=0 or missing DATABASE_URL.
 * - Disable Prisma read fallback with PRISMA_BOOKING_READ=0.
 */

const { tryGetPrisma, prismaConfigured } = require('./prisma');

function mirrorEnabled() {
  if (!prismaConfigured()) return false;
  if (process.env.PRISMA_BOOKING_MIRROR === '0' || process.env.PRISMA_BOOKING_MIRROR === 'false') {
    return false;
  }
  return true;
}

function readFallbackEnabled() {
  if (!mirrorEnabled()) return false;
  if (process.env.PRISMA_BOOKING_READ === '0' || process.env.PRISMA_BOOKING_READ === 'false') {
    return false;
  }
  return true;
}

function isDraftBooking(booking) {
  if (!booking || typeof booking !== 'object') return true;
  if (booking.isDraft === true) return true;
  if (String(booking.kind || '').toLowerCase() === 'draft') return true;
  return false;
}

function toMirrorRow(booking) {
  const id = String(booking?.id || booking?.bookingId || '').trim();
  if (!id) return null;
  return {
    id,
    bookingVersion: Math.max(0, Math.round(Number(booking.bookingVersion) || 0)),
    quoteVersion: Math.max(
      0,
      Math.round(Number(booking.quoteVersion != null
        ? booking.quoteVersion
        : booking.quote?.quoteVersion) || 0)
    ),
    schemaVersion: Math.max(1, Math.round(Number(booking.schemaVersion) || 1)),
    kind: String(booking.kind || 'booking'),
    jobStatus: booking.jobStatus != null ? String(booking.jobStatus) : null,
    paymentWorkflowStatus: booking.paymentWorkflowStatus != null
      ? String(booking.paymentWorkflowStatus)
      : null,
    paymentStatus: booking.paymentStatus != null ? String(booking.paymentStatus) : null,
    phone: booking.phone || booking.customerPhone || null,
    email: booking.email || null,
    preferredDate: booking.preferredDate || booking.confirmedDate || null,
    payload: booking,
  };
}

/**
 * Upsert submitted booking into Prisma. Never throws.
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function upsertBookingMirror(booking) {
  try {
    if (!mirrorEnabled()) return { ok: false, skipped: true, reason: 'mirror_disabled' };
    if (isDraftBooking(booking)) return { ok: false, skipped: true, reason: 'draft' };
    const row = toMirrorRow(booking);
    if (!row) return { ok: false, skipped: true, reason: 'missing_id' };
    const prisma = tryGetPrisma();
    if (!prisma) return { ok: false, skipped: true, reason: 'no_client' };

    await prisma.bookingRecord.upsert({
      where: { id: row.id },
      create: row,
      update: {
        bookingVersion: row.bookingVersion,
        quoteVersion: row.quoteVersion,
        schemaVersion: row.schemaVersion,
        kind: row.kind,
        jobStatus: row.jobStatus,
        paymentWorkflowStatus: row.paymentWorkflowStatus,
        paymentStatus: row.paymentStatus,
        phone: row.phone,
        email: row.email,
        preferredDate: row.preferredDate,
        payload: row.payload,
      },
    });
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn('[booking-prisma-mirror] upsert_failed', message);
    return { ok: false, error: message };
  }
}

/**
 * Fire-and-forget safe mirror (does not reject).
 */
function scheduleBookingMirror(booking) {
  Promise.resolve()
    .then(() => upsertBookingMirror(booking))
    .catch(() => {});
}

/**
 * Read booking payload from Prisma. Returns null on any miss/error.
 */
async function readBookingMirror(bookingId) {
  try {
    if (!readFallbackEnabled()) return null;
    const id = String(bookingId || '').trim();
    if (!id) return null;
    const prisma = tryGetPrisma();
    if (!prisma) return null;
    const row = await prisma.bookingRecord.findUnique({ where: { id } });
    if (!row || row.payload == null) return null;
    if (typeof row.payload === 'object') return row.payload;
    return null;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn('[booking-prisma-mirror] read_failed', message);
    return null;
  }
}

/**
 * Batch form of readBookingMirror — one indexed query instead of one round trip
 * per id. Returns an empty Map on any miss/error, same fail-open contract.
 *
 * @returns {Promise<Map<string, object>>} keyed by the id as stored
 */
async function readBookingMirrors(bookingIds) {
  const out = new Map();
  try {
    if (!readFallbackEnabled()) return out;
    const ids = [...new Set((bookingIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return out;
    const prisma = tryGetPrisma();
    if (!prisma) return out;
    const rows = await prisma.bookingRecord.findMany({ where: { id: { in: ids } } });
    for (const row of rows || []) {
      if (row && row.payload && typeof row.payload === 'object') out.set(row.id, row.payload);
    }
    return out;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn('[booking-prisma-mirror] batch_read_failed', message);
    return out;
  }
}

/**
 * Admin list path: one Postgres query instead of hydrating every cd1-bookings
 * blob. Fail-open to [] so callers keep the Blob list as authority.
 *
 * @returns {Promise<object[]>}
 */
async function listBookingMirrors() {
  const out = [];
  try {
    if (!readFallbackEnabled()) return out;
    const prisma = tryGetPrisma();
    if (!prisma) return out;
    const rows = await prisma.bookingRecord.findMany({
      where: { NOT: { kind: 'draft' } },
      orderBy: { updatedAt: 'desc' },
    });
    for (const row of rows || []) {
      const payload = row && row.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (isDraftBooking(payload)) continue;
      if (!payload.id && !payload.bookingId) payload.id = row.id;
      out.push(payload);
    }
    return out;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn('[booking-prisma-mirror] list_failed', message);
    return [];
  }
}

module.exports = {
  mirrorEnabled,
  readFallbackEnabled,
  isDraftBooking,
  toMirrorRow,
  upsertBookingMirror,
  scheduleBookingMirror,
  readBookingMirror,
  readBookingMirrors,
  listBookingMirrors,
};
