'use strict';

/**
 * Authoritative completed-service history for maintenance eligibility.
 * Prefers booking completion timestamps over empty booking.completedServiceHistory arrays.
 */

const COMPLETED_STATUS_RE = /^(completed|completed_paid|completed_pending_payment|completed_pending_admin_review|paid)$/i;

function isCompletedBookingStatus(booking) {
  if (!booking || typeof booking !== 'object') return false;
  const candidates = [
    booking.jobStatus,
    booking.status,
    booking.lifecycleStatus,
    booking.customerStatus,
    booking.opsStatus,
  ];
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (!s) continue;
    if (COMPLETED_STATUS_RE.test(s)) return true;
    if (/^completed/i.test(s) && !/cancel|reject|void/i.test(s)) return true;
  }
  if (booking.completedAt || booking.completedAtUtc) return true;
  return false;
}

function completionTimestamp(booking) {
  return booking.completedAtUtc
    || booking.completedAt
    || booking.paidAt
    || booking.paidAtUtc
    || null;
}

function bookingCustomerIds(booking) {
  return [
    booking.customerAccountId,
    booking.customerId,
    booking.accountId,
  ].map((x) => String(x || '').trim()).filter(Boolean);
}

function bookingVehicleIds(booking) {
  const ids = new Set();
  if (booking.vehicleId) ids.add(String(booking.vehicleId));
  const vehicles = Array.isArray(booking.vehicles)
    ? booking.vehicles
    : (Array.isArray(booking.service?.vehicles) ? booking.service.vehicles : []);
  for (const v of vehicles) {
    const id = v?.vehicleId || v?.id;
    if (id) ids.add(String(id));
  }
  return ids;
}

function packageIdOf(booking) {
  return booking.packageId
    || booking.packId
    || booking.selectedPackage
    || booking.service?.packageId
    || (Array.isArray(booking.service?.vehicles) && booking.service.vehicles[0]?.packageId)
    || null;
}

function normalizeRecord(rec) {
  if (!rec) return null;
  const completedAtUtc = rec.completedAtUtc || rec.completedAt;
  if (!completedAtUtc) return null;
  const status = String(rec.status || 'completed').toLowerCase();
  if (status !== 'completed') return null;
  return {
    completedAtUtc: new Date(completedAtUtc).toISOString(),
    vehicleId: rec.vehicleId || null,
    packageId: rec.packageId || rec.packId || null,
    bookingId: rec.bookingId || null,
    status: 'completed',
  };
}

/**
 * Immutable append onto booking.completedServiceHistory.
 */
function appendCompletedServiceRecord(booking, record) {
  const next = normalizeRecord(record);
  if (!next) return { completedServiceHistory: Array.isArray(booking?.completedServiceHistory) ? booking.completedServiceHistory : [] };
  const prev = Array.isArray(booking?.completedServiceHistory) ? booking.completedServiceHistory : [];
  if (next.bookingId && prev.some((p) => p && p.bookingId === next.bookingId)) {
    return { completedServiceHistory: prev };
  }
  return { completedServiceHistory: [...prev, next] };
}

/**
 * Shared repository query for completed-service history.
 */
async function getCompletedServiceHistory({
  siteId,
  customerId,
  vehicleId,
  beforeUtc,
  bookings,
} = {}) {
  void siteId;
  const beforeMs = beforeUtc ? new Date(beforeUtc).getTime() : Date.now();
  const customer = String(customerId || '').trim();
  const vehicle = String(vehicleId || '').trim();
  const out = [];
  const seen = new Set();

  let list = Array.isArray(bookings) ? bookings : null;
  if (!list) {
    try {
      const { listRawBookings } = require('../ops-db');
      list = await listRawBookings();
    } catch {
      try {
        const { listSubmittedBookings } = require('../booking-repository');
        list = await listSubmittedBookings();
      } catch {
        list = [];
      }
    }
  }

  for (const booking of list || []) {
    if (!booking || typeof booking !== 'object') continue;
    if (!isCompletedBookingStatus(booking)) continue;
    if (customer) {
      const ids = bookingCustomerIds(booking);
      if (!ids.includes(customer)) continue;
    }
    const completedAtUtc = completionTimestamp(booking);
    if (!completedAtUtc) continue;
    const completedMs = new Date(completedAtUtc).getTime();
    if (!Number.isFinite(completedMs) || completedMs > beforeMs) continue;

    const vehicleIds = bookingVehicleIds(booking);
    if (vehicle && vehicleIds.size && !vehicleIds.has(vehicle)) continue;

    const bookingId = String(booking.bookingId || booking.id || '').trim() || null;
    const rec = normalizeRecord({
      completedAtUtc,
      vehicleId: vehicle || [...vehicleIds][0] || booking.vehicleId || null,
      packageId: packageIdOf(booking),
      bookingId,
      status: 'completed',
    });
    if (!rec) continue;
    const key = rec.bookingId || `${rec.completedAtUtc}:${rec.vehicleId}:${rec.packageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }

  // Merge any explicit history arrays already on bookings (deduped).
  for (const booking of list || []) {
    const hist = Array.isArray(booking?.completedServiceHistory) ? booking.completedServiceHistory : [];
    for (const h of hist) {
      const rec = normalizeRecord(h);
      if (!rec) continue;
      if (customer && bookingCustomerIds(booking).length && !bookingCustomerIds(booking).includes(customer)) {
        // history embedded on another customer's booking — skip when customer scoped
        continue;
      }
      if (vehicle && rec.vehicleId && rec.vehicleId !== vehicle) continue;
      const ms = new Date(rec.completedAtUtc).getTime();
      if (!Number.isFinite(ms) || ms > beforeMs) continue;
      const key = rec.bookingId || `${rec.completedAtUtc}:${rec.vehicleId}:${rec.packageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rec);
    }
  }

  out.sort((a, b) => String(b.completedAtUtc).localeCompare(String(a.completedAtUtc)));
  return out;
}

module.exports = {
  COMPLETED_STATUS_RE,
  isCompletedBookingStatus,
  getCompletedServiceHistory,
  appendCompletedServiceRecord,
  normalizeRecord,
};
