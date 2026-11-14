// Server-only booking_confirmed revenue event.
//
// Written from confirmBookingTransition after the booking blob is committed.
// This module does not change booking state, does not notify the customer,
// and does not call GA4, Google Ads, Stripe, or Twilio.
//
// The amount, when present, is the approved amount observed at the moment this
// event is first stored: the latest Quote.approvedCents, or the booking's own
// approvedFinalAmount when no quote row exists. It is not cash received and it
// is not revised if the quote changes later. The create-only blob write makes
// the record immutable.
//
// A Postgres outage does not invent $0 and does not fall back to the blob.
// The booking confirmation still stands. A pending key in the booking store
// lets a bounded recovery pass finish the event without a second confirm.
// Bookings confirmed before this marker existed have no pending key and are
// not scanned.

'use strict';

const crypto = require('crypto');

const SERVER_SESSION = 'server_confirm';
const EVENT_NAME = 'booking_confirmed';
const PENDING_PREFIX = 'confirm-analytics-pending:';
const RECOVERY_LIMIT = 20;

let revenueDeps = null;
let quoteReader = null;

function setAuthoritativeConfirmDeps(deps) {
  revenueDeps = deps && typeof deps.get === 'function' ? deps : null;
}

function resetAuthoritativeConfirmDeps() {
  revenueDeps = null;
}

function setConfirmationQuoteReader(reader) {
  quoteReader = typeof reader === 'function' ? reader : null;
}

function resetConfirmationQuoteReader() {
  quoteReader = null;
}

function analyticsEnabled() {
  if (revenueDeps) return true;
  // node --test must not touch the production revenue store, even if a local
  // shell exported NETLIFY=true.
  if (process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test'))) return false;
  return !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
}

function explicitDollars(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function fingerprintEvent({ event, sessionId, properties }) {
  const copy = { ...properties };
  delete copy.event_id;
  delete copy.timestamp;
  delete copy.anonymous_session_id;
  const stable = {};
  Object.keys(copy).sort().forEach((key) => { stable[key] = copy[key]; });
  return crypto.createHash('sha256').update(JSON.stringify({
    event,
    sessionId,
    properties: stable,
  })).digest('hex');
}

function reservationIsUsable(value, eventId) {
  return !!(
    value
    && value.version === 2
    && value.eventId === eventId
    && typeof value.fingerprint === 'string'
    && typeof value.storeKey === 'string'
    && value.storeKey.endsWith(`/${eventId}`)
    && value.record
    && typeof value.record === 'object'
  );
}

async function readQuote(bookingId) {
  if (quoteReader) return quoteReader(bookingId);
  const { prismaConfigured, tryGetPrisma } = require('./prisma');
  if (!prismaConfigured()) return { state: 'not_configured' };
  // Mirror disabled means quotes are not the active authority. The booking
  // record's approvedFinalAmount remains usable. An init or query failure is
  // different: the quote may exist and must not be replaced by a blob fallback.
  if (process.env.PRISMA_BOOKING_MIRROR === '0' || process.env.PRISMA_BOOKING_MIRROR === 'false') {
    return { state: 'not_configured' };
  }
  const prisma = tryGetPrisma();
  if (!prisma) return { state: 'unavailable' };
  try {
    const row = await prisma.quote.findFirst({
      where: { bookingId },
      orderBy: { quoteVersion: 'desc' },
      select: { approvedCents: true },
    });
    if (!row) return { state: 'ready', approvedCents: null };
    const cents = Number(row.approvedCents);
    if (!Number.isInteger(cents) || cents < 0) return { state: 'unavailable' };
    return { state: 'ready', approvedCents: cents };
  } catch (err) {
    console.warn('[revenue-confirm] quote_read_failed', String(err && err.message || err).slice(0, 120));
    return { state: 'unavailable' };
  }
}

async function resolveAmount(booking) {
  const stored = explicitDollars(
    booking.confirmationAnalytics && booking.confirmationAnalytics.storedApprovedDollars
  );
  let quote;
  try {
    quote = await readQuote(String(booking.id || booking.bookingId || ''));
  } catch (err) {
    console.warn('[revenue-confirm] quote_reader_threw', String(err && err.message || err).slice(0, 120));
    return { state: 'unavailable' };
  }
  if (!quote || quote.state === 'unavailable') return { state: 'unavailable' };
  if (quote.state === 'ready' && quote.approvedCents != null) {
    return {
      state: 'ready',
      estimatedValue: Math.round(Number(quote.approvedCents)) / 100,
    };
  }
  if (stored != null) return { state: 'ready', estimatedValue: stored };
  return { state: 'absent' };
}

function eventProperties(booking, eventId, amount) {
  const properties = {
    event_id: eventId,
    anonymous_session_id: SERVER_SESSION,
    timestamp: booking.confirmedAt || new Date().toISOString(),
    booking_reference: String(booking.id || booking.bookingId || ''),
    currency: 'USD',
    event_origin: SERVER_SESSION,
  };
  if (amount.state === 'ready') properties.estimated_value = amount.estimatedValue;
  if (amount.state === 'absent') properties.error_code = 'amount_unavailable';
  return properties;
}

async function persistEvent(eventId, properties) {
  const stores = revenueDeps || {
    get: (name) => require('./revenue-store').getRevenueStore(name),
    create: (store, key, value) => require('./revenue-store').blobCreateJson(store, key, value),
    read: (store, key) => require('./revenue-store').blobGetJsonStrict(store, key),
  };
  const idemStore = await stores.get('eventIdempotency');
  const idemKey = `evt:${eventId}`;
  const receivedAt = new Date().toISOString();
  const fingerprint = fingerprintEvent({
    event: EVENT_NAME,
    sessionId: SERVER_SESSION,
    properties,
  });
  const reservation = {
    version: 2,
    eventId,
    fingerprint,
    storeKey: `${receivedAt.slice(0, 10)}/${eventId}`,
    reservedAt: receivedAt,
    record: {
      event: EVENT_NAME,
      properties,
      receivedAt,
    },
  };
  const reservationWrite = await stores.create(idemStore, idemKey, reservation);
  let canonical = reservation;
  if (!reservationWrite.created) {
    canonical = await stores.read(idemStore, idemKey);
    if (!reservationIsUsable(canonical, eventId) || canonical.record.event !== EVENT_NAME) {
      throw new Error('idempotency_reservation_invalid');
    }
    const owner = canonical.record.properties && canonical.record.properties.booking_reference;
    const caller = properties.booking_reference;
    if (owner && caller && owner !== caller) {
      // The id already belongs to another booking. Finish that booking's
      // original projection if it is missing, and do not attach this caller.
      const eventStore = await stores.get('events');
      await stores.create(eventStore, canonical.storeKey, canonical.record);
      return { ok: false, retryable: false, reason: 'event_id_conflict' };
    }
    // Same confirmation. A later approved amount must not replace the record
    // captured by this reservation, and must not block its projection.
  }
  const eventStore = await stores.get('events');
  const eventWrite = await stores.create(eventStore, canonical.storeKey, canonical.record);
  return {
    ok: true,
    duplicate: !reservationWrite.created || !eventWrite.created,
    preservedOriginal: !reservationWrite.created && canonical.fingerprint !== fingerprint,
    storeKey: canonical.storeKey,
  };
}

async function bookingStore() {
  const { getStore } = require('./booking-repository');
  return getStore();
}

async function enqueuePending(booking) {
  try {
    const store = await bookingStore();
    const id = String(booking.id || booking.bookingId || '').trim();
    const eventId = String(booking.confirmationAnalytics.eventId || '').trim();
    if (!id || !eventId || typeof store.setJSON !== 'function') return;
    const key = `${PENDING_PREFIX}${id}`;
    const existing = typeof store.get === 'function'
      ? await store.get(key, { type: 'json' }).catch(() => null)
      : null;
    if (existing && existing.eventId) return;
    await store.setJSON(key, { bookingId: id, eventId }, { onlyIfNew: true });
  } catch (err) {
    console.warn('[revenue-confirm] pending_index_failed', String(err && err.message || err).slice(0, 120));
  }
}

async function deletePending(bookingId) {
  try {
    const store = await bookingStore();
    if (typeof store.delete !== 'function') return;
    await store.delete(`${PENDING_PREFIX}${bookingId}`);
  } catch (err) {
    console.warn('[revenue-confirm] pending_delete_failed', String(err && err.message || err).slice(0, 120));
  }
}

async function listPending(store, cap) {
  if (!store || typeof store.list !== 'function') return [];
  const take = (blobs) => {
    const out = [];
    for (const blob of blobs || []) {
      const key = blob && (blob.key || blob.blobKey || blob);
      if (key && String(key).startsWith(PENDING_PREFIX)) out.push(String(key));
      if (out.length >= cap) break;
    }
    return out;
  };
  try {
    const listed = await store.list({ prefix: PENDING_PREFIX, paginate: true });
    if (listed && typeof listed[Symbol.asyncIterator] === 'function') {
      const out = [];
      for await (const page of listed) {
        out.push(...take(page && page.blobs));
        if (out.length >= cap) return out.slice(0, cap);
      }
      return out;
    }
    if (listed && listed.blobs) return take(listed.blobs);
  } catch (err) {
    console.warn('[revenue-confirm] pending_list_failed', String(err && err.message || err).slice(0, 120));
  }
  try {
    const listing = await store.list({ prefix: PENDING_PREFIX });
    return take(listing && listing.blobs);
  } catch (err) {
    console.warn('[revenue-confirm] pending_list_failed', String(err && err.message || err).slice(0, 120));
    return [];
  }
}

/**
 * Finish confirmation events whose booking commit already succeeded.
 * Reads only the pending index written for the new marker. One pass is capped.
 * It does not confirm, cancel, or rewrite a booking.
 */
async function recoverPendingConfirmations({ limit = RECOVERY_LIMIT } = {}) {
  const cap = Math.min(Math.max(Math.round(Number(limit) || RECOVERY_LIMIT), 1), 25);
  const store = await bookingStore();
  const keys = await listPending(store, cap);
  let recovered = 0;
  let waiting = 0;
  let dropped = 0;
  for (const key of keys) {
    const pending = typeof store.get === 'function'
      ? await store.get(key, { type: 'json' }).catch(() => null)
      : null;
    const bookingId = pending && pending.bookingId;
    if (!bookingId) {
      if (typeof store.delete === 'function') await store.delete(key);
      dropped += 1;
      continue;
    }
    const { getBookingRecord } = require('./booking-repository');
    const rec = await getBookingRecord(bookingId);
    const marker = rec.booking && rec.booking.confirmationAnalytics;
    const eligible = rec.exists
      && marker
      && marker.required === true
      && marker.eventId === pending.eventId;
    if (!eligible) {
      if (typeof store.delete === 'function') await store.delete(key);
      dropped += 1;
      continue;
    }
    const result = await settleAuthoritativeConfirmation(rec.booking);
    if (result && result.ok) recovered += 1;
    else waiting += 1;
  }
  return { ok: true, recovered, waiting, dropped, scanned: keys.length };
}

/**
 * Record the confirmation event for a booking that this process confirmed.
 * Returns without throwing. A storage or quote failure leaves the booking
 * confirmation in place and is safe to retry.
 */
async function settleAuthoritativeConfirmation(booking) {
  try {
    const marker = booking && booking.confirmationAnalytics;
    if (!marker || marker.required !== true) {
      return { ok: true, skipped: true, reason: 'not_required' };
    }
    if (!analyticsEnabled()) {
      return { ok: true, skipped: true, reason: 'analytics_disabled' };
    }
    const eventId = String(marker.eventId || booking.confirmationEventId || '').trim();
    if (!eventId || eventId.length > 128) {
      return { ok: false, retryable: false, reason: 'invalid_event_id' };
    }
    await enqueuePending(booking);
    const amount = await resolveAmount(booking);
    if (amount.state === 'unavailable') {
      return { ok: false, retryable: true, reason: 'amount_authority_unavailable' };
    }
    const stored = await persistEvent(eventId, eventProperties(booking, eventId, amount));
    if (stored && stored.ok) await deletePending(booking.id || booking.bookingId);
    return stored;
  } catch (err) {
    console.warn('[revenue-confirm] emit_failed', String(err && err.message || err).slice(0, 120));
    return { ok: false, retryable: true, reason: 'storage_unavailable' };
  }
}

module.exports = {
  settleAuthoritativeConfirmation,
  recoverPendingConfirmations,
  setAuthoritativeConfirmDeps,
  resetAuthoritativeConfirmDeps,
  setConfirmationQuoteReader,
  resetConfirmationQuoteReader,
};
